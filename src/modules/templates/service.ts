/**
 * 模板（`docs/05 §十` + `docs/04 §九`）。
 *
 * 一句话：**模板固化「这笔账长什么样」，不固化「这笔账多少钱、什么时候」。**
 *
 * ## 字段契约（`docs/05 §10.2`）
 *
 * | 固化 | recordType / direction / accountId(转账户) / categoryId / 商家 / 对象 / 标签 / 名称 / 手续费 / 折扣 / 备注 |
 * | **不固化** | 金额（只给 `defaultAmount` 建议值）、日期与时间（每次记当下） |
 *
 * `payload_json` 内部一律用**整数分**（与全项目金额规约一致），API 层转十进制字符串。
 *
 * ## 两条设计纪律
 *
 * ① **写入严、读取宽**。创建/更新模板时强校验引用（账户/分类必须存在、分类必须与
 *    `record_type` 匹配）—— 脏数据在录入那一刻就该被拦住；但**读取时一律宽容**：
 *    分类被停用、账户被归档、标签被删，都只在前端标注 warning 而**不拒绝预填**
 *    （`docs/05 §10.6` 明写「模板引用的分类被停用时，模板标注『分类已停用』并仍可用」）。
 *
 * ② **预置模板按「账户分组」而非具体账户**（`seed.ts` 写的是 `accountGroupKey`）。
 *    预置时新账本还没有具体账户，钱包这种分组里以后可能有 3 张卡；使用模板时
 *    取分组内第一个未归档账户，取不到就给 warning 并留空 —— 绝不静默记到别的账上。
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accountGroups,
  accounts,
  categories,
  tags,
  templates,
  transactions,
} from '../../db/schema.js';
import {
  DEFAULT_DIRECTION,
  DIRECTION_BY_RECORD_TYPE,
  LIMITS,
  RECORD_TYPES,
  type RecordType,
  type TxDirection,
} from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, parseAmountToCents } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';

/* ------------------------------------------------------------------ *
 * payload 的规范形态
 * ------------------------------------------------------------------ */

export interface TemplatePayload {
  recordType: RecordType;
  direction: TxDirection | null;
  accountId: string | null;
  /** 仅预置模板使用：按分组解析出实际账户（见纪律 ②） */
  accountGroupKey: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string | null;
  counterparty: string | null;
  name: string | null;
  note: string | null;
  tagIds: string[];
  /** 分 */
  fee: number;
  /** 分 */
  discount: number;
  /** 建议金额（分）。不是固化值 —— 提交前用户一定会改 */
  defaultAmount: number;
}

/** 前端预填提示：一处结构、一条渲染，模板面板逐条显示 */
export interface TemplateWarning {
  field: 'accountId' | 'categoryId' | 'tags' | 'direction';
  level: 'warn' | 'error';
  message: string;
}

export interface TemplateDto {
  id: string;
  name: string;
  icon: string | null;
  pinned: boolean;
  isDefault: boolean;
  useCount: number;
  lastUsedAt: string | null;
  /** 已解析成「可直接喂给记账表单」的形态：金额转元字符串、补上 direction */
  payload: Record<string, unknown>;
  /** 宽容读取的产物：引用失效时在这里说明，而不是拒绝预填 */
  warnings: TemplateWarning[];
  createdAt: string;
}

const COLUMNS = {
  id: templates.id,
  name: templates.name,
  icon: templates.icon,
  sortOrder: templates.sortOrder,
  payloadJson: templates.payloadJson,
  useCount: templates.useCount,
  lastUsedAt: templates.lastUsedAt,
  pinned: templates.pinned,
  isDefault: templates.isDefault,
  archivedAt: templates.archivedAt,
  createdAt: templates.createdAt,
} as const;

type Row = {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  payloadJson: string;
  useCount: number;
  lastUsedAt: string | null;
  /** drizzle 的 `mode: 'boolean'` 已经转成 boolean，别再当 0/1 比 */
  pinned: boolean | null;
  isDefault: boolean | null;
  archivedAt: string | null;
  createdAt: string;
};

function readPayload(json: string): TemplatePayload {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    /* payload 坏了不致命：按「全空模板」处理，用户仍能新建一笔 */
  }
  const rt = (typeof raw.recordType === 'string' ? raw.recordType : 'expense') as RecordType;
  const recordType = (RECORD_TYPES as readonly string[]).includes(rt) ? rt : 'expense';
  const allowed = DIRECTION_BY_RECORD_TYPE[recordType] ?? ['none'];
  const dir = typeof raw.direction === 'string' ? (raw.direction as TxDirection) : null;
  return {
    recordType,
    direction: dir && allowed.includes(dir) ? dir : DEFAULT_DIRECTION[recordType],
    accountId: typeof raw.accountId === 'string' ? raw.accountId : null,
    accountGroupKey: typeof raw.accountGroupKey === 'string' ? raw.accountGroupKey : null,
    toAccountId: typeof raw.toAccountId === 'string' ? raw.toAccountId : null,
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : null,
    merchant: typeof raw.merchant === 'string' ? raw.merchant : null,
    counterparty: typeof raw.counterparty === 'string' ? raw.counterparty : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    note: typeof raw.note === 'string' ? raw.note : null,
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter((t): t is string => typeof t === 'string') : [],
    fee: Number.isFinite(Number(raw.fee)) ? Math.max(0, Math.trunc(Number(raw.fee))) : 0,
    discount: Number.isFinite(Number(raw.discount)) ? Math.max(0, Math.trunc(Number(raw.discount))) : 0,
    defaultAmount: Number.isFinite(Number(raw.defaultAmount))
      ? Math.max(0, Math.trunc(Number(raw.defaultAmount)))
      : 0,
  };
}

/* ------------------------------------------------------------------ *
 * 引用解析（纪律 ②）
 * ------------------------------------------------------------------ */

interface LedgerRefs {
  /** 分组 key 后缀 → 该分组第一个未归档账户 id（预置模板的 key 是 `grp_cash` 这类后缀） */
  accountByGroupKey: Map<string, string>;
  accountName: Map<string, string>;
  accountArchived: Set<string>;
  categoryName: Map<string, string>;
  categoryArchived: Set<string>;
  categoryRecordType: Map<string, string>;
  tagAlive: Set<string>;
}

function ledgerRefs(ctx: AppCtx, ledgerId: string): LedgerRefs {
  const accRows = ctx.db
    .select({
      id: accounts.id,
      name: accounts.name,
      archivedAt: accounts.archivedAt,
      groupId: accounts.groupId,
    })
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
  const groupRows = ctx.db
    .select({ id: accountGroups.id, name: accountGroups.name })
    .from(accountGroups)
    .where(eq(accountGroups.ledgerId, ledgerId))
    .all();

  // 分组 key 有两种形态：预置用复合 id `ldg_x#grp_cash`，用户自建用随机 id。
  // 两种都要能按「后缀」匹配上 —— 预置模板是按 DEFAULT_ACCOUNT_GROUPS 的 key 写的。
  const groupById = new Map(groupRows.map((g) => [g.id, g]));
  const groupBySuffix = new Map<string, string>();
  for (const g of groupRows) {
    const suffix = g.id.includes('#') ? g.id.slice(g.id.indexOf('#') + 1) : g.name;
    groupBySuffix.set(suffix, g.id);
  }

  const accountByGroupKey = new Map<string, string>();
  const accountName = new Map<string, string>();
  const accountArchived = new Set<string>();
  // 账户排序：优先分组内 sortOrder 不可得时用 name 稳定序（无 ORDER BY 的行序会变）
  const accSorted = [...accRows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const a of accSorted) {
    accountName.set(a.id, a.name);
    if (a.archivedAt) {
      accountArchived.add(a.id);
      continue;
    }
    if (!a.groupId) continue;
    const resolved = a.groupId.includes('#') ? a.groupId : (groupById.has(a.groupId) ? a.groupId : null);
    const groupId = resolved ?? a.groupId;
    const suffix = groupId.includes('#') ? groupId.slice(groupId.indexOf('#') + 1) : (groupById.get(groupId)?.name ?? groupId);
    const key = groupBySuffix.has(suffix) ? suffix : groupId;
    if (!accountByGroupKey.has(key)) accountByGroupKey.set(key, a.id);
    if (!accountByGroupKey.has(groupId)) accountByGroupKey.set(groupId, a.id);
  }

  const catRows = ctx.db
    .select({
      id: categories.id,
      name: categories.name,
      recordType: categories.recordType,
      archivedAt: categories.archivedAt,
    })
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .all();
  const categoryName = new Map<string, string>();
  const categoryArchived = new Set<string>();
  const categoryRecordType = new Map<string, string>();
  for (const c of catRows) {
    categoryName.set(c.id, c.name);
    categoryRecordType.set(c.id, c.recordType);
    if (c.archivedAt) categoryArchived.add(c.id);
  }

  const tagRows = ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), isNull(tags.archivedAt)))
    .all();

  return {
    accountByGroupKey,
    accountName,
    accountArchived,
    categoryName,
    categoryArchived,
    categoryRecordType,
    tagAlive: new Set(tagRows.map((t) => t.id)),
  };
}

/** 把 payload 解析成 DTO：补 direction、解账户、算 warnings、金额转元字符串 */
function toDto(row: Row, refs: LedgerRefs): TemplateDto {
  const p = readPayload(row.payloadJson);
  const warnings: TemplateWarning[] = [];

  // 账户：优先具体 id，其次按分组解析（纪律 ②）
  let accountId = p.accountId;
  if (!accountId && p.accountGroupKey) {
    accountId = refs.accountByGroupKey.get(p.accountGroupKey) ?? null;
  }
  if (accountId) {
    if (!refs.accountName.has(accountId)) {
      warnings.push({ field: 'accountId', level: 'error', message: '模板引用的账户已删除，请重新选择' });
      accountId = null;
    } else if (refs.accountArchived.has(accountId)) {
      warnings.push({ field: 'accountId', level: 'warn', message: '模板引用的账户已停用，仍可记账' });
    }
  } else if (p.accountId || p.accountGroupKey) {
    warnings.push({ field: 'accountId', level: 'error', message: '模板未指定账户（分组内没有可用账户）' });
  }

  // 分类：停用只是标注，跨类型也只是标注 —— 都**不阻断**预填（纪律 ①）
  let categoryId = p.categoryId;
  let categoryName: string | null = null;
  if (categoryId) {
    categoryName = refs.categoryName.get(categoryId) ?? null;
    if (!categoryName) {
      warnings.push({ field: 'categoryId', level: 'error', message: '模板引用的分类已删除，请重新选择' });
      categoryId = null;
    } else if (refs.categoryArchived.has(categoryId)) {
      warnings.push({ field: 'categoryId', level: 'warn', message: `分类「${categoryName}」已停用` });
    } else if (refs.categoryRecordType.get(categoryId) !== p.recordType) {
      warnings.push({
        field: 'categoryId',
        level: 'warn',
        message: `分类「${categoryName}」不属于${p.recordType === 'expense' ? '支出' : '该类型'}，提交时会要求重选`,
      });
    }
  }

  const tagIds = p.tagIds.filter((id) => refs.tagAlive.has(id));
  if (tagIds.length !== p.tagIds.length) {
    warnings.push({ field: 'tags', level: 'warn', message: '部分标签已删除，预填时已略过' });
  }

  // 转账缺目标账户等于模板不完整 —— 明确告诉用户，别让它静默失败在提交时
  if (p.recordType === 'transfer' && !p.toAccountId) {
    warnings.push({ field: 'direction', level: 'warn', message: '转账模板未指定转入账户' });
  }

  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    pinned: row.pinned === true,
    isDefault: row.isDefault === true,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    warnings,
    createdAt: row.createdAt,
    payload: {
      recordType: p.recordType,
      direction: p.direction,
      accountId,
      accountName: accountId ? refs.accountName.get(accountId) ?? null : null,
      toAccountId: p.toAccountId,
      categoryId,
      categoryName,
      merchant: p.merchant,
      counterparty: p.counterparty,
      name: p.name,
      note: p.note,
      tagIds,
      // API 层一律十进制字符串（前端不需要再解析）
      fee: formatCents(p.fee),
      discount: formatCents(p.discount),
      defaultAmount: formatCents(p.defaultAmount),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 列表与读取
 * ------------------------------------------------------------------ */

/**
 * 排序：`pinned DESC, use_count DESC, last_used_at DESC, sort_order, id`
 * 末两项纯粹为**确定性** —— 无 ORDER BY 时 SQLite 行序会变，
 * 而并列的模板每次刷排行序可能不同（真踩过：列表页同天数并列时行序翻来覆去）。
 */
export function listTemplates(ctx: AppCtx, ledgerId: string, includeArchived = false): TemplateDto[] {
  const conditions = [eq(templates.ledgerId, ledgerId)];
  if (!includeArchived) conditions.push(isNull(templates.archivedAt));
  const rows = ctx.db
    .select(COLUMNS)
    .from(templates)
    .where(and(...conditions))
    .orderBy(
      desc(sql`coalesce(${templates.pinned}, 0)`),
      desc(templates.useCount),
      desc(templates.lastUsedAt),
      asc(templates.sortOrder),
      asc(templates.id),
    )
    .all() as Row[];
  const refs = ledgerRefs(ctx, ledgerId);
  return rows.map((r) => toDto(r, refs));
}

function requireRow(ctx: AppCtx, ledgerId: string, id: string): Row {
  const row = ctx.db
    .select(COLUMNS)
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('模板不存在');
  return row as Row;
}

export function getTemplate(ctx: AppCtx, ledgerId: string, id: string): TemplateDto {
  return toDto(requireRow(ctx, ledgerId, id), ledgerRefs(ctx, ledgerId));
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 写入前的引用校验（纪律 ①：脏数据在这一刻拦住） */
function validateRefs(
  ctx: AppCtx,
  ledgerId: string,
  p: TemplatePayload,
): TemplatePayload {
  const refs = ledgerRefs(ctx, ledgerId);

  let accountId = p.accountId;
  if (!accountId && p.accountGroupKey) accountId = refs.accountByGroupKey.get(p.accountGroupKey) ?? null;
  if (accountId && !refs.accountName.has(accountId)) {
    throw HttpError.validation([{ field: 'accountId', message: '账户不存在' }]);
  }
  if (accountId && refs.accountArchived.has(accountId)) {
    throw HttpError.validation([{ field: 'accountId', message: '账户已停用，不能用于模板' }]);
  }

  let categoryId = p.categoryId;
  if (categoryId) {
    if (!refs.categoryName.has(categoryId)) {
      throw HttpError.validation([{ field: 'categoryId', message: '分类不存在' }]);
    }
    if (refs.categoryArchived.has(categoryId)) {
      throw HttpError.validation([{ field: 'categoryId', message: '分类已停用' }]);
    }
    if (refs.categoryRecordType.get(categoryId) !== p.recordType) {
      throw HttpError.validation([{ field: 'categoryId', message: '分类与记录类型不匹配' }]);
    }
  } else if (p.recordType === 'transfer' && !p.toAccountId) {
    // 转账模板必须给目标账户 —— 缺了它这个模板永远提交失败，不如在创建时就拦下
    throw HttpError.validation([{ field: 'toAccountId', message: '转账模板必须指定转入账户' }]);
  }

  if (p.toAccountId && !refs.accountName.has(p.toAccountId)) {
    throw HttpError.validation([{ field: 'toAccountId', message: '转入账户不存在' }]);
  }

  if (p.tagIds.length) {
    const alive = p.tagIds.filter((id) => refs.tagAlive.has(id));
    if (alive.length !== p.tagIds.length) {
      throw HttpError.validation([{ field: 'tagIds', message: '包含已删除或已停用的标签' }]);
    }
  }

  // 落库时把解析出的具体账户写回 —— 分组解析的结果不该在下次读取时变来变去
  return { ...p, accountId };
}

function normalizePayload(input: Partial<TemplatePayload> | Record<string, unknown>): TemplatePayload {
  const merged = { ...input } as Record<string, unknown>;
  const rt = (typeof merged.recordType === 'string' ? merged.recordType : 'expense') as RecordType;
  const recordType = (RECORD_TYPES as readonly string[]).includes(rt) ? rt : 'expense';
  const allowed = DIRECTION_BY_RECORD_TYPE[recordType] ?? ['none'];
  const dir = typeof merged.direction === 'string' ? (merged.direction as TxDirection) : null;
  const toCents = (v: unknown) => {
    if (v === null || v === undefined || v === '') return 0;
    const c = typeof v === 'number' ? Math.trunc(v) : parseAmountToCents(v as string);
    return Number.isFinite(c) ? Math.max(0, c!) : 0;
  };
  return {
    recordType,
    direction: dir && allowed.includes(dir) ? dir : DEFAULT_DIRECTION[recordType],
    accountId: typeof merged.accountId === 'string' ? merged.accountId : null,
    accountGroupKey: typeof merged.accountGroupKey === 'string' ? merged.accountGroupKey : null,
    toAccountId: typeof merged.toAccountId === 'string' ? merged.toAccountId : null,
    categoryId: typeof merged.categoryId === 'string' ? merged.categoryId : null,
    merchant: typeof merged.merchant === 'string' ? merged.merchant : null,
    counterparty: typeof merged.counterparty === 'string' ? merged.counterparty : null,
    name: typeof merged.name === 'string' ? merged.name : null,
    note: typeof merged.note === 'string' ? merged.note : null,
    tagIds: Array.isArray(merged.tagIds)
      ? (merged.tagIds as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    fee: toCents(merged.fee),
    discount: toCents(merged.discount),
    defaultAmount: toCents(merged.defaultAmount),
  };
}

export function createTemplate(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: { name: string; icon?: string | null; payload: Record<string, unknown> } & Record<string, unknown>,
): TemplateDto {
  const dup = ctx.db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.ledgerId, ledgerId), eq(templates.name, input.name)))
    .get();
  if (dup) throw HttpError.duplicate('同名模板已存在');

  const payload = validateRefs(ctx, ledgerId, normalizePayload(input.payload));
  const maxRow = ctx.db
    .select({ m: sql<number>`coalesce(max(${templates.sortOrder}), 0)` })
    .from(templates)
    .where(eq(templates.ledgerId, ledgerId))
    .get() as { m: number } | undefined;

  const id = newId(ID_PREFIX.template);
  const at = nowIso();
  ctx.db
    .insert(templates)
    .values({
      id,
      ledgerId,
      name: input.name,
      icon: input.icon ?? null,
      sortOrder: Number(maxRow?.m ?? 0) + 1,
      payloadJson: JSON.stringify(payload),
      useCount: 0,
      pinned: false,
      isDefault: false,
      createdBy: actorId,
      createdAt: at,
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'template',
    entityId: id,
    summary: `新建模板 ${input.name}`,
    after: { name: input.name, payload },
  });
  return getTemplate(ctx, ledgerId, id);
}

export function updateTemplate(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  input: { name?: string; icon?: string | null; pinned?: boolean; payload?: Record<string, unknown> },
): TemplateDto {
  const before = requireRow(ctx, ledgerId, id);

  const dupName = input.name
    ? ctx.db
        .select({ id: templates.id })
        .from(templates)
        .where(
          and(eq(templates.ledgerId, ledgerId), eq(templates.name, input.name), sql`${templates.id} <> ${id}`),
        )
        .get()
    : undefined;
  if (dupName) throw HttpError.duplicate('同名模板已存在');

  const patch: Partial<typeof templates.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.pinned !== undefined) patch.pinned = input.pinned;
  if (input.payload !== undefined) {
    patch.payloadJson = JSON.stringify(validateRefs(ctx, ledgerId, normalizePayload(input.payload)));
  }

  ctx.db.update(templates).set(patch).where(eq(templates.id, id)).run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'template',
    entityId: id,
    summary: `修改模板 ${input.name ?? before.name}`,
    before: { name: before.name },
    after: patch,
  });
  return getTemplate(ctx, ledgerId, id);
}

/** 软删除（与账单一致，走 `archived_at`）—— 模板被账单 payload 引用过，硬删会留悬空引用 */
export function deleteTemplate(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const before = requireRow(ctx, ledgerId, id);
  ctx.db.update(templates).set({ archivedAt: nowIso() }).where(eq(templates.id, id)).run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'template',
    entityId: id,
    summary: `删除模板 ${before.name}`,
    before: { name: before.name },
  });
  return { id };
}

export function reorderTemplates(ctx: AppCtx, ledgerId: string, ids: string[]): TemplateDto[] {
  ctx.db.transaction((tx) => {
    ids.forEach((id, i) => {
      tx.update(templates)
        .set({ sortOrder: i + 1 })
        .where(and(eq(templates.id, id), eq(templates.ledgerId, ledgerId)))
        .run();
    });
  });
  return listTemplates(ctx, ledgerId);
}

/**
 * 使用模板：`use_count += 1`、刷新 `last_used_at`，并返回**预填用的 payload**。
 * 计数只在这里加 —— 模板的 useCount 不像标签那样从关联表实时统计
 * （账单只存 `template_id` 一个引用，没有「用了哪些模板」的多对多痕迹可查）。
 */
export function useTemplate(ctx: AppCtx, ledgerId: string, id: string): TemplateDto {
  requireRow(ctx, ledgerId, id);
  const at = nowIso();
  ctx.db
    .update(templates)
    .set({ useCount: sql`coalesce(${templates.useCount}, 0) + 1`, lastUsedAt: at })
    .where(eq(templates.id, id))
    .run();
  return getTemplate(ctx, ledgerId, id);
}

/**
 * 存为模板（`docs/04 §9` 的 `POST /transactions/:id/save-as-template`）。
 * 从一笔已存在的账单取全部可固化字段，**刻意不带金额**：
 * 金额是最容易变的字段，带过来极易误提交（同「复制」清空金额的道理）。
 */
export function saveAsTemplate(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  txId: string,
  name: string,
  icon?: string | null,
): TemplateDto {
  const txRow = ctx.db
    .select({
      id: transactions.id,
      recordType: transactions.recordType,
      direction: transactions.direction,
      accountId: transactions.accountId,
      toAccountId: transactions.toAccountId,
      categoryId: transactions.categoryId,
      merchant: transactions.merchant,
      counterparty: transactions.counterparty,
      name: transactions.name,
      note: transactions.note,
      fee: transactions.fee,
      discount: transactions.discount,
      amount: transactions.amount,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!txRow || txRow.deletedAt) throw HttpError.notFound('账单不存在');
  if (txRow.name && LIMITS.NAME_MAX_LEN && name.length > LIMITS.NAME_MAX_LEN) {
    throw HttpError.validation([{ field: 'name', message: `模板名最多 ${LIMITS.NAME_MAX_LEN} 字` }]);
  }

  const tagRows = ctx.dbHandle.raw
    .prepare(
      `SELECT tag_id AS tid FROM transaction_tags WHERE transaction_id = ?`,
    )
    .all(txRow.id) as { tid: string }[];

  return createTemplate(ctx, actorId, ledgerId, {
    name,
    icon: icon ?? null,
    payload: {
      recordType: txRow.recordType,
      direction: txRow.direction,
      accountId: txRow.accountId,
      toAccountId: txRow.toAccountId,
      categoryId: txRow.categoryId,
      merchant: txRow.merchant,
      counterparty: txRow.counterparty,
      name: txRow.name,
      note: txRow.note,
      tagIds: tagRows.map((t) => t.tid),
      fee: txRow.fee,
      discount: txRow.discount,
      // 建议金额：把这次的金额带出来当参考，但不固化（提交前用户一定会改）
      defaultAmount: txRow.amount,
    },
  });
}

/** 供 tests / 其它模块复用：读出未解析的 payload（分单位） */
export function rawPayloadOf(ctx: AppCtx, ledgerId: string, id: string): TemplatePayload {
  return readPayload(requireRow(ctx, ledgerId, id).payloadJson);
}

/** 供校验用：确保 id 属于账本且未归档（模板不存在时抛 404） */
export function assertTemplateInLedger(ctx: AppCtx, ledgerId: string, id: string): void {
  const row = ctx.db
    .select({ id: templates.id })
    .from(templates)
    .where(
      and(
        eq(templates.id, id),
        eq(templates.ledgerId, ledgerId),
        isNull(templates.archivedAt),
      ),
    )
    .get();
  if (!row) throw HttpError.notFound('模板不存在');
}

/** 批量取（记账页 `?template=` 预填用，避免多一次往返） */
export function getTemplates(ctx: AppCtx, ledgerId: string, ids: string[]): TemplateDto[] {
  if (!ids.length) return [];
  const rows = ctx.db
    .select(COLUMNS)
    .from(templates)
    .where(
      and(
        inArray(templates.id, ids),
        eq(templates.ledgerId, ledgerId),
        isNull(templates.archivedAt),
      ),
    )
    .all() as Row[];
  const refs = ledgerRefs(ctx, ledgerId);
  return rows.map((r) => toDto(r, refs));
}