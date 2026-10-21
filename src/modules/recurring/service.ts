/**
 * 周期账单规则（`docs/05 §11` + `docs/04 §十`）。
 *
 * ## 三条核心纪律
 *
 * ① **幂等靠 `client_request_id`，不靠 last_generated_date**。
 *    生成的每笔账都写 `client_request_id = 'rec:{ruleId}:{dueDate}'`，而该列上有
 *    **唯一索引**（`idx_tx_client_req`）—— 容器重启、任务重跑、手工点两次「立即生成」，
 *    数据库层面都不会产生第二笔。`last_generated_date` 只是游标，不是幂等保证。
 *
 * ② **生成走 transactions 的 createTransaction，不自己插库**。
 *    金额计算、账户守恒、分类归属、手续费/折扣适用性这些规约全在那条路径上；
 *    在这里另写一套 INSERT 意味着周期账单会绕过它们（第一版差点就这么干）。
 *
 * ③ **一期的金额是快照**。规则改了金额，只影响**之后**的期 —— 已经生成的账是独立事实，
 *    不会被追改（否则用户改一次房租金额，历史八笔房租全变了）。
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { accounts, categories, recurringRules, tags, transactions } from '../../db/schema.js';
import { DEFAULT_DIRECTION, LIMITS, type RecordType } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, today as todayStr } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { createTransaction } from '../transactions/service.js';
import {
  dueDatesUntil,
  fmtDay,
  nextDueDate,
  parseDay,
  upcomingDueDates,
  type Frequency,
  type RuleSchedule,
} from './schedule.js';

export type RuleStatus = 'active' | 'paused';

export interface RuleDto {
  id: string;
  name: string;
  recordType: RecordType;
  accountId: string;
  accountName: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  merchant: string | null;
  counterparty: string | null;
  frequency: Frequency;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  dayOfMonth: number | null;
  weekDay: number | null;
  month: number | null;
  maxMonthEnd: boolean;
  amount: string;
  fee: string;
  discount: string;
  title: string | null;
  note: string | null;
  tagIds: string[];
  generateAheadDays: number;
  autoCreate: boolean;
  lastGeneratedDate: string | null;
  skippedDates: string[];
  status: RuleStatus;
  createdAt: string;
  /** 下一期的应生成日（不含已跳过）—— 前端列表直接显示「下次 11-01」 */
  nextDueDate: string | null;
  /** 引用失效提示（账户被删、分类被停用…）：**标注而不拒绝**，与模板模块同一口径 */
  warnings: { field: string; level: 'warn' | 'error'; message: string }[];
}

const COLUMNS = {
  id: recurringRules.id,
  /**
   * ⚠️ `ledgerId` 必须在选集里：`generateForRule` 要用它去 `createTransaction`，
   * 漏掉的后果是 `row.ledgerId === undefined` → `requireAccount(undefined, …)` 恒查不到 →
   * 每一次生成都报「账户不存在」。而列表/预览都不读这个字段，所以漏了也看不出来
   * （踩过：规则建得出来、预览也对，只有 run-now 全军覆没）。
   */
  ledgerId: recurringRules.ledgerId,
  name: recurringRules.name,
  recordType: recurringRules.recordType,
  accountId: recurringRules.accountId,
  toAccountId: recurringRules.toAccountId,
  categoryId: recurringRules.categoryId,
  merchant: recurringRules.merchant,
  counterparty: recurringRules.counterparty,
  frequency: recurringRules.frequency,
  intervalCount: recurringRules.intervalCount,
  startDate: recurringRules.startDate,
  endDate: recurringRules.endDate,
  dayOfMonth: recurringRules.dayOfMonth,
  weekDay: recurringRules.weekDay,
  month: recurringRules.month,
  maxMonthEnd: recurringRules.maxMonthEnd,
  amount: recurringRules.amount,
  fee: recurringRules.fee,
  discount: recurringRules.discount,
  title: recurringRules.title,
  note: recurringRules.note,
  tagIdsJson: recurringRules.tagIdsJson,
  generateAheadDays: recurringRules.generateAheadDays,
  autoCreate: recurringRules.autoCreate,
  lastGeneratedDate: recurringRules.lastGeneratedDate,
  skippedDates: recurringRules.skippedDates,
  status: recurringRules.status,
  archivedAt: recurringRules.archivedAt,
  createdAt: recurringRules.createdAt,
} as const;

type Row = typeof recurringRules.$inferSelect;

function parseTagIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function parseSkipped(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Row → 调度器可用的日期参数 */
function toSchedule(r: Row): RuleSchedule {
  return {
    frequency: r.frequency as Frequency,
    intervalCount: r.intervalCount,
    startDate: r.startDate,
    endDate: r.endDate,
    dayOfMonth: r.dayOfMonth,
    weekDay: r.weekDay,
    month: r.month,
    maxMonthEnd: r.maxMonthEnd,
  };
}

interface Refs {
  accountName: Map<string, string>;
  accountArchived: Set<string>;
  /** 虚拟账户（债权/债务/手续费）—— 周期账单**不能**用它们做主账户 */
  accountVirtual: Set<string>;
  categoryName: Map<string, string>;
  categoryArchived: Set<string>;
  /** 分类属于哪个 record_type —— 用来挡住「收入规则配了支出分类」
   *  （漏这条的后果和漏「分类必填」一模一样：规则建得出来、每天生成必失败） */
  categoryRecordType: Map<string, string>;
  tagAlive: Set<string>;
}

function loadRefs(ctx: AppCtx, ledgerId: string): Refs {
  const accs = ctx.db
    .select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt, kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
  const cats = ctx.db
    .select({
      id: categories.id,
      name: categories.name,
      archivedAt: categories.archivedAt,
      recordType: categories.recordType,
    })
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .all();
  const tgs = ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), isNull(tags.archivedAt)))
    .all();
  return {
    accountName: new Map(accs.map((a) => [a.id, a.name])),
    accountArchived: new Set(accs.filter((a) => a.archivedAt).map((a) => a.id)),
    accountVirtual: new Set(accs.filter((a) => a.kind === 'virtual').map((a) => a.id)),
    categoryName: new Map(cats.map((c) => [c.id, c.name])),
    categoryArchived: new Set(cats.filter((c) => c.archivedAt).map((c) => c.id)),
    categoryRecordType: new Map(cats.map((c) => [c.id, c.recordType])),
    tagAlive: new Set(tgs.map((t) => t.id)),
  };
}

function toDto(r: Row, refs: Refs, today = todayStr()): RuleDto {
  const warnings: RuleDto['warnings'] = [];
  if (!refs.accountName.has(r.accountId)) {
    warnings.push({ field: 'accountId', level: 'error', message: '规则引用的账户已删除，请重新选择' });
  } else if (refs.accountArchived.has(r.accountId)) {
    warnings.push({ field: 'accountId', level: 'warn', message: '账户已停用，生成时会被拒绝' });
  }
  if (r.categoryId) {
    if (!refs.categoryName.has(r.categoryId)) {
      warnings.push({ field: 'categoryId', level: 'error', message: '规则引用的分类已删除' });
    } else if (refs.categoryArchived.has(r.categoryId)) {
      warnings.push({ field: 'categoryId', level: 'warn', message: '分类已停用' });
    }
  }
  if (r.toAccountId && !refs.accountName.has(r.toAccountId)) {
    warnings.push({ field: 'toAccountId', level: 'error', message: '转入账户已删除' });
  }

  const skipped = parseSkipped(r.skippedDates);
  const sched = toSchedule(r);
  const t = today;
  // 游标：已生成到哪 + 提前天数。「下次」要显示尚未生成的那些，所以用
  // `lastGeneratedDate ?? (startDate 前一天)` 起算，再把已跳过的过滤掉。
  const cursor = r.lastGeneratedDate ?? fmtDay(addDaysLocal(parseDay(r.startDate), -1));
  /**
   * 下一期：**尚未过期**的第一期（跳过已过去的与被跳过的）。
   * ⚠️ 判据是**严格小于**今天 —— 今天到期的期就是今天要出的那期，不能一起滤掉
   * （曾经写成 next <= t，结果「每月今天」这种规则永远显示无下一期，也永远生成不了）。
   * 早期版本直接把游标后的第一期拿来显示，于是 startDate 设成一个月前的规则
   * 会显示「下次 9 月 14 日」—— 一个已经过去的日子。
   */
  let next = nextDueDate(sched, cursor);
  let guard = 0;
  while (next && (next < t || skipped.includes(next)) && guard++ < 500) {
    next = nextDueDate(sched, next);
  }
  // 暂停的规则也照样显示「下次」—— 恢复后还要用它

  return {
    id: r.id,
    name: r.name,
    recordType: r.recordType as RecordType,
    accountId: r.accountId,
    accountName: refs.accountName.get(r.accountId) ?? null,
    toAccountId: r.toAccountId,
    toAccountName: r.toAccountId ? refs.accountName.get(r.toAccountId) ?? null : null,
    categoryId: r.categoryId,
    categoryName: r.categoryId ? refs.categoryName.get(r.categoryId) ?? null : null,
    merchant: r.merchant,
    counterparty: r.counterparty,
    frequency: r.frequency as Frequency,
    intervalCount: r.intervalCount,
    startDate: r.startDate,
    endDate: r.endDate,
    dayOfMonth: r.dayOfMonth,
    weekDay: r.weekDay,
    month: r.month,
    maxMonthEnd: r.maxMonthEnd,
    amount: formatCents(r.amount),
    fee: formatCents(r.fee),
    discount: formatCents(r.discount),
    title: r.title,
    note: r.note,
    tagIds: parseTagIds(r.tagIdsJson),
    generateAheadDays: r.generateAheadDays,
    autoCreate: r.autoCreate,
    lastGeneratedDate: r.lastGeneratedDate,
    skippedDates: skipped,
    status: r.status as RuleStatus,
    createdAt: r.createdAt,
    nextDueDate: next,
    warnings,
  };
}

function addDaysLocal(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

export function listRules(ctx: AppCtx, ledgerId: string, includeArchived = false): RuleDto[] {
  const conditions = [eq(recurringRules.ledgerId, ledgerId)];
  if (!includeArchived) conditions.push(isNull(recurringRules.archivedAt));
  const rows = ctx.db
    .select(COLUMNS)
    .from(recurringRules)
    .where(and(...conditions))
    // 活跃在前；同类按创建时间（新规则在上）。末项 id 是为了确定性。
    .orderBy(desc(sql`coalesce(${recurringRules.status}, 'active')`), desc(recurringRules.createdAt), asc(recurringRules.id))
    .all() as Row[];
  const refs = loadRefs(ctx, ledgerId);
  return rows.map((r) => toDto(r, refs));
}

function requireRow(ctx: AppCtx, ledgerId: string, id: string): Row {
  const row = ctx.db
    .select(COLUMNS)
    .from(recurringRules)
    .where(and(eq(recurringRules.id, id), eq(recurringRules.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('周期规则不存在');
  return row as Row;
}

export function getRule(ctx: AppCtx, ledgerId: string, id: string): RuleDto {
  return toDto(requireRow(ctx, ledgerId, id), loadRefs(ctx, ledgerId));
}

/* ------------------------------------------------------------------ *
 * 写入校验（严：生成时会绕过人工校验，所以这里必须拦干净）
 * ------------------------------------------------------------------ */

interface RuleInput {
  name: string;
  recordType: RecordType;
  accountId: string;
  toAccountId?: string | null;
  categoryId?: string | null;
  merchant?: string | null;
  counterparty?: string | null;
  frequency: Frequency;
  intervalCount?: number;
  startDate: string;
  endDate?: string | null;
  dayOfMonth?: number | null;
  weekDay?: number | null;
  month?: number | null;
  maxMonthEnd?: boolean;
  amount: number;
  fee?: number;
  discount?: number;
  title?: string | null;
  note?: string | null;
  tagIds?: string[];
  generateAheadDays?: number;
  autoCreate?: boolean;
}

function validateInput(ctx: AppCtx, ledgerId: string, input: RuleInput) {
  const issues: { field: string; message: string }[] = [];
  const refs = loadRefs(ctx, ledgerId);

  if (!refs.accountName.has(input.accountId)) {
    issues.push({ field: 'accountId', message: '账户不存在' });
  } else if (refs.accountArchived.has(input.accountId)) {
    issues.push({ field: 'accountId', message: '账户已停用，不能用于自动生成' });
  } else if (refs.accountVirtual.has(input.accountId)) {
    // 虚拟账户（债权/债务/手续费）是台账口径，不是「钱在哪」，自动生成会算错账
    issues.push({ field: 'accountId', message: '周期账单不能用虚拟账户（债权/债务/手续费）' });
  }
  if (input.toAccountId) {
    if (!refs.accountName.has(input.toAccountId)) {
      issues.push({ field: 'toAccountId', message: '转入账户不存在' });
    } else if (input.toAccountId === input.accountId) {
      issues.push({ field: 'toAccountId', message: '转入账户不能与转出账户相同' });
    } else if (refs.accountVirtual.has(input.toAccountId) || refs.accountArchived.has(input.toAccountId)) {
      issues.push({ field: 'toAccountId', message: '转入账户不可用（虚拟或已停用）' });
    }
  }
  if (input.recordType === 'transfer' && !input.toAccountId) {
    issues.push({ field: 'toAccountId', message: '转账规则必须指定转入账户' });
  }
  // ⚠️ 分类**必填**，不是可选：createTransaction 对账单强制要求分类
  // （缺了直接 400「请选择分类」）。早先这里允许 null，于是「建得出来、每天生成必失败」——
  // 规则能保存、一到生成就天天报错，用户只在服务端日志里看得到。
  // 前端表单同样不给「不选分类」这个选项，两边必须一起改。
  if (!input.categoryId) {
    issues.push({ field: 'categoryId', message: '周期账单必须指定分类' });
  } else if (!refs.categoryName.has(input.categoryId)) {
    issues.push({ field: 'categoryId', message: '分类不存在' });
  } else if (refs.categoryArchived.has(input.categoryId)) {
    issues.push({ field: 'categoryId', message: '分类已停用' });
  } else if (refs.categoryRecordType.get(input.categoryId) !== input.recordType) {
    issues.push({
      field: 'categoryId',
      message: '分类与记录类型不匹配（createTransaction 会拒绝，规则会天天生成失败）',
    });
  }
  if (input.tagIds?.length) {
    const alive = input.tagIds.filter((id) => refs.tagAlive.has(id));
    if (alive.length !== input.tagIds.length) {
      issues.push({ field: 'tagIds', message: '包含已删除或已停用的标签' });
    }
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    issues.push({ field: 'amount', message: '金额必须大于 0' });
  }
  if (input.amount > LIMITS.AMOUNT_MAX_CENTS) {
    issues.push({ field: 'amount', message: '单笔金额超出上限' });
  }
  if (input.endDate && input.endDate < input.startDate) {
    issues.push({ field: 'endDate', message: '结束日期不能早于开始日期' });
  }
  // 频率专属参数：给了不该给的直接报错，别默默忽略（默默忽略会让人以为设了）
  if (input.frequency === 'monthly' && !input.dayOfMonth) {
    issues.push({ field: 'dayOfMonth', message: '月度规则需要指定「每月第几天」' });
  }
  if (input.frequency === 'weekly' && input.weekDay === null) {
    issues.push({ field: 'weekDay', message: '周度规则需要指定「星期几」' });
  }
  if (input.frequency === 'yearly' && !input.month) {
    issues.push({ field: 'month', message: '年度规则需要指定「几月」' });
  }

  if (issues.length) throw HttpError.validation(issues);

  // **生成不到就是废规则**：建之前先算一期，算不出来直接报错，
  // 而不是建一条永远不生成任何账的规则（用户会以为「设了但没生效」）。
  const sched: RuleSchedule = {
    frequency: input.frequency,
    intervalCount: input.intervalCount ?? 1,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
    weekDay: input.weekDay ?? null,
    month: input.month ?? null,
    maxMonthEnd: input.maxMonthEnd ?? true,
  };
  const probe = nextDueDate(sched, fmtDay(addDaysLocal(parseDay(input.startDate), -1)));
  if (!probe) {
    throw HttpError.validation([
      { field: 'frequency', message: '按这组频率与起始日期算不出一期账单，请检查配置' },
    ]);
  }
  return sched;
}

export function createRule(ctx: AppCtx, actorId: string, ledgerId: string, input: RuleInput): RuleDto {
  const dup = ctx.db
    .select({ id: recurringRules.id })
    .from(recurringRules)
    .where(and(eq(recurringRules.ledgerId, ledgerId), eq(recurringRules.name, input.name)))
    .get();
  if (dup) throw HttpError.duplicate('同名周期规则已存在');

  validateInput(ctx, ledgerId, input);
  const id = newId(ID_PREFIX.recurringRule);
  ctx.db
    .insert(recurringRules)
    .values({
      id,
      ledgerId,
      name: input.name,
      recordType: input.recordType,
      accountId: input.accountId,
      toAccountId: input.toAccountId ?? null,
      categoryId: input.categoryId ?? null,
      merchant: input.merchant ?? null,
      counterparty: input.counterparty ?? null,
      frequency: input.frequency,
      intervalCount: Math.max(1, Math.trunc(input.intervalCount ?? 1)),
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      weekDay: input.weekDay ?? null,
      month: input.month ?? null,
      maxMonthEnd: input.maxMonthEnd ?? true,
      amount: input.amount,
      fee: Math.max(0, input.fee ?? 0),
      discount: Math.max(0, input.discount ?? 0),
      title: input.title ?? null,
      note: input.note ?? null,
      tagIdsJson: JSON.stringify(input.tagIds ?? []),
      generateAheadDays: Math.max(0, Math.min(30, input.generateAheadDays ?? 1)),
      autoCreate: input.autoCreate ?? true,
      status: 'active',
      createdBy: actorId,
      createdAt: nowIso(),
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'recurring_rule',
    entityId: id,
    summary: `新建周期规则 ${input.name}`,
    after: { name: input.name, frequency: input.frequency, amount: input.amount },
  });
  return getRule(ctx, ledgerId, id);
}

export function updateRule(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  patch: Partial<RuleInput> & { status?: RuleStatus },
): RuleDto {
  const before = requireRow(ctx, ledgerId, id);
  if (patch.name) {
    const dup = ctx.db
      .select({ id: recurringRules.id })
      .from(recurringRules)
      .where(
        and(
          eq(recurringRules.ledgerId, ledgerId),
          eq(recurringRules.name, patch.name),
          sql`${recurringRules.id} <> ${id}`,
        ),
      )
      .get();
    if (dup) throw HttpError.duplicate('同名周期规则已存在');
  }

  // 合并后整体重校验（纪律 ②：规则必须「生成得到」，不能存半成品）
  const merged: RuleInput = {
    name: patch.name ?? before.name,
    recordType: (patch.recordType ?? before.recordType) as RecordType,
    accountId: patch.accountId ?? before.accountId,
    toAccountId: patch.toAccountId === undefined ? before.toAccountId : patch.toAccountId,
    categoryId: patch.categoryId === undefined ? before.categoryId : patch.categoryId,
    merchant: patch.merchant === undefined ? before.merchant : patch.merchant,
    counterparty: patch.counterparty === undefined ? before.counterparty : patch.counterparty,
    frequency: (patch.frequency ?? before.frequency) as Frequency,
    intervalCount: patch.intervalCount ?? before.intervalCount,
    startDate: patch.startDate ?? before.startDate,
    endDate: patch.endDate === undefined ? before.endDate : patch.endDate,
    dayOfMonth: patch.dayOfMonth === undefined ? before.dayOfMonth : patch.dayOfMonth,
    weekDay: patch.weekDay === undefined ? before.weekDay : patch.weekDay,
    month: patch.month === undefined ? before.month : patch.month,
    maxMonthEnd: patch.maxMonthEnd ?? before.maxMonthEnd,
    amount: patch.amount ?? before.amount,
    fee: patch.fee ?? before.fee,
    discount: patch.discount ?? before.discount,
    title: patch.title === undefined ? before.title : patch.title,
    note: patch.note === undefined ? before.note : patch.note,
    tagIds: patch.tagIds ?? parseTagIds(before.tagIdsJson),
    generateAheadDays: patch.generateAheadDays ?? before.generateAheadDays,
    autoCreate: patch.autoCreate ?? before.autoCreate,
  };
  validateInput(ctx, ledgerId, merged);

  const set: Partial<typeof recurringRules.$inferInsert> = {};
  for (const k of [
    'name', 'recordType', 'accountId', 'toAccountId', 'categoryId', 'merchant', 'counterparty',
    'frequency', 'intervalCount', 'startDate', 'endDate', 'dayOfMonth', 'weekDay', 'month',
    'maxMonthEnd', 'amount', 'fee', 'discount', 'title', 'note', 'generateAheadDays', 'autoCreate',
  ] as const) {
    const v = patch[k as keyof RuleInput];
    if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  }
  if (patch.tagIds !== undefined) set.tagIdsJson = JSON.stringify(patch.tagIds);
  if (patch.status !== undefined) set.status = patch.status;

  ctx.db.update(recurringRules).set(set).where(eq(recurringRules.id, id)).run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'recurring_rule',
    entityId: id,
    summary: `修改周期规则 ${merged.name}`,
    before: { name: before.name, amount: before.amount },
    after: set,
  });
  return getRule(ctx, ledgerId, id);
}

/** 软删：已生成的账单不受影响（它们是独立事实，不靠规则存在） */
export function deleteRule(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const before = requireRow(ctx, ledgerId, id);
  ctx.db.update(recurringRules).set({ archivedAt: nowIso() }).where(eq(recurringRules.id, id)).run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'recurring_rule',
    entityId: id,
    summary: `删除周期规则 ${before.name}`,
    before: { name: before.name },
  });
  return { id };
}

export function setPaused(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  paused: boolean,
): RuleDto {
  requireRow(ctx, ledgerId, id);
  const row = ctx.db
    .update(recurringRules)
    .set({ status: paused ? 'paused' : 'active' })
    .where(eq(recurringRules.id, id))
    .run();
  void row;
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'recurring_rule',
    entityId: id,
    summary: paused ? '暂停周期规则' : '恢复周期规则',
  });
  return getRule(ctx, ledgerId, id);
}

/** 跳过单期（`docs/05 §11.3`）：某期不生成，例如春节那期 */
export function skipDate(ctx: AppCtx, ledgerId: string, id: string, dueDate: string): RuleDto {
  const row = requireRow(ctx, ledgerId, id);
  const skipped = parseSkipped(row.skippedDates);
  if (!skipped.includes(dueDate)) skipped.push(dueDate);
  skipped.sort();
  ctx.db
    .update(recurringRules)
    .set({ skippedDates: JSON.stringify(skipped) })
    .where(eq(recurringRules.id, id))
    .run();
  // 跳过的期若已越过游标，把游标一并推过去，否则每次生成都会再遇到它
  if (row.lastGeneratedDate && dueDate <= row.lastGeneratedDate) {
    ctx.db
      .update(recurringRules)
      .set({ lastGeneratedDate: dueDate })
      .where(eq(recurringRules.id, id))
      .run();
  }
  return getRule(ctx, ledgerId, id);
}

export function unskipDate(ctx: AppCtx, ledgerId: string, id: string, dueDate: string): RuleDto {
  const row = requireRow(ctx, ledgerId, id);
  const skipped = parseSkipped(row.skippedDates).filter((d) => d !== dueDate);
  ctx.db
    .update(recurringRules)
    .set({ skippedDates: JSON.stringify(skipped) })
    .where(eq(recurringRules.id, id))
    .run();
  return getRule(ctx, ledgerId, id);
}

/* ------------------------------------------------------------------ *
 * 预览
 * ------------------------------------------------------------------ */

export function previewRule(ctx: AppCtx, ledgerId: string, id: string, count = 5) {
  const row = requireRow(ctx, ledgerId, id);
  const sched = toSchedule(row);
  const skipped = new Set(parseSkipped(row.skippedDates));
  const cursor = row.lastGeneratedDate ?? fmtDay(addDaysLocal(parseDay(row.startDate), -1));
  const today = todayStr();
  // 只列**还没到期**的期：已经过去的（但没生成）不该出现在「预览未来 5 期」里
  const raw = upcomingDueDates(sched, cursor, Math.max(count * 3, count + 10), null)
    .filter((d) => d >= today && !skipped.has(d))
    .slice(0, Math.max(1, Math.min(count, 24)));
  return raw.map((dueDate, i) => ({
    seq: i + 1,
    dueDate,
    amount: formatCents(row.amount),
    // status 只有 pending：已生成的期由幂等排除掉了，这里列的必然是待生成
    status: 'pending' as const,
  }));
}

/* ------------------------------------------------------------------ *
 * 生成（幂等：靠 client_request_id 的唯一索引）
 * ------------------------------------------------------------------ */

/** 幂等键：同一规则 + 同一应生成日 → 永远同一串 */
function idemKey(ruleId: string, dueDate: string): string {
  return `rec:${ruleId}:${dueDate}`;
}

export interface GenerateOutcome {
  ruleId: string;
  ruleName: string;
  dueDate: string;
  created: boolean;
  transactionId: string | null;
  error?: string;
}

/**
 * 为一条规则生成区间内所有应到期的账。
 * @param untilDate 含该日；调度器传「今日 + 提前天数」
 */
export function generateForRule(
  ctx: AppCtx,
  actorId: string,
  row: Row,
  untilDate: string,
  /** 只处理这几期（不给则处理区间内全部）。「立即生成一期」用它来守住「一期」语义。 */
  onlyDates?: readonly string[],
): GenerateOutcome[] {
  const sched = toSchedule(row);
  const skipped = new Set(parseSkipped(row.skippedDates));
  const cursor = row.lastGeneratedDate ?? fmtDay(addDaysLocal(parseDay(row.startDate), -1));
  const all = dueDatesUntil(sched, cursor, untilDate);
  const dueDates = onlyDates ? all.filter((d) => onlyDates.includes(d)) : all;
  const out: GenerateOutcome[] = [];
  let advancedTo = row.lastGeneratedDate;

  for (const dueDate of dueDates) {
    if (skipped.has(dueDate)) {
      advancedTo = dueDate;
      out.push({ ruleId: row.id, ruleName: row.name, dueDate, created: false, transactionId: null });
      continue;
    }
    try {
      const res = createTransaction(ctx, actorId, row.ledgerId, {
        recordType: row.recordType as RecordType,
        direction: DEFAULT_DIRECTION[row.recordType as RecordType],
        accountId: row.accountId,
        toAccountId: row.toAccountId,
        categoryId: row.categoryId,
        name: row.title,
        merchant: row.merchant,
        counterparty: row.counterparty,
        note: row.note,
        tags: parseTagIds(row.tagIdsJson),
        // ⚠️ createTransaction 的 amount 语义是**元**（内部会 parseAmountToCents），
        // 而规则表里存的是**分**。直接传 row.amount 等于把 450000 分当成 450000 元
        // 再乘 100 = 4500 万元（第一版真踩了，账单金额大了一万倍）。
        amount: formatCents(row.amount),
        fee: formatCents(row.fee),
        discount: formatCents(row.discount),
        txDate: dueDate,
        // 幂等的唯一来源
        clientRequestId: idemKey(row.id, dueDate),
        // 溯源：让「已生成列表」查得出来
        recurringRuleId: row.id,
      });
      advancedTo = dueDate;
      out.push({
        ruleId: row.id,
        ruleName: row.name,
        dueDate,
        // reused=true 表示这一期之前已经生成过 —— 不是错误
        created: !res.reused,
        transactionId: res.row.id,
      });
    } catch (err) {
      // 单期失败不许中断整条规则（后面还有期），也不许推进游标
      out.push({
        ruleId: row.id,
        ruleName: row.name,
        dueDate,
        created: false,
        transactionId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (advancedTo && advancedTo !== row.lastGeneratedDate) {
    ctx.db
      .update(recurringRules)
      .set({ lastGeneratedDate: advancedTo })
      .where(eq(recurringRules.id, row.id))
      .run();
  }
  return out;
}

/**
 * 全账本扫描（调度器每日 00:05 调用，`docs/05 §11.4`）。
 *
 * 提前天数的作用就是「把 `today + ahead` 之前该出的账先出了」——
 * 例如房租每月 1 号、提前 1 天，那么 1 号的账会在当月最后一天凌晨就生成，
 * 用户一进应用就能看到它躺在列表里，而不是等到 1 号早上才凭空出现。
 */
export function generateDue(ctx: AppCtx, opts: { today?: string; ledgerId?: string } = {}) {
  const day = opts.today ?? todayStr();
  const conditions = [eq(recurringRules.status, 'active'), isNull(recurringRules.archivedAt)];
  if (opts.ledgerId) conditions.push(eq(recurringRules.ledgerId, opts.ledgerId));
  const rows = ctx.db
    .select(COLUMNS)
    .from(recurringRules)
    .where(and(...conditions))
    .all() as Row[];

  const summary: { rules: number; created: number; reused: number; failed: number } = {
    rules: rows.length,
    created: 0,
    reused: 0,
    failed: 0,
  };
  const details: GenerateOutcome[] = [];

  for (const row of rows) {
    if (!row.autoCreate) continue;
    // 到期日 = 今天 + 提前天数
    const until = fmtDay(addDaysLocal(parseDay(day), row.generateAheadDays));
    const out = generateForRule(ctx, row.createdBy, row, until);
    for (const o of out) {
      details.push(o);
      if (o.error) summary.failed += 1;
      else if (o.created) summary.created += 1;
      else summary.reused += 1;
    }
  }
  return { today: day, summary, details };
}

/** 「立即生成一期」：跳过提前天数，直接出下一期 */
export function runNow(ctx: AppCtx, actorId: string, ledgerId: string, id: string) {
  const row = requireRow(ctx, ledgerId, id);
  // 暂停 = 不再出账（docs/05 §11.3「临时停用」），手动触发的「立即生成」也一样：
  // 否则暂停只挡住定时任务，用户点一下就绕过去了，暂停形同虚设。
  if (row.status === 'paused') {
    throw HttpError.validation([{ field: 'status', message: '规则已暂停，先恢复再生成' }]);
  }
  const sched = toSchedule(row);
  const skipped = new Set(parseSkipped(row.skippedDates));
  const cursor = row.lastGeneratedDate ?? fmtDay(addDaysLocal(parseDay(row.startDate), -1));
  /**
   * 「立即生成一期」出的是**下一期**，而下一期不能是已经过去的日子
   * （startDate 设成一个月前的规则，游标后面紧跟着的就是过去那一期）。
   * 判据与 toDto 的 nextDueDate 一致：严格小于今天才算过期，**今天到期的算下一期**。
   */
  const t = todayStr();
  let next = nextDueDate(sched, cursor);
  let guard = 0;
  while (next && (next < t || skipped.has(next)) && guard++ < 500) next = nextDueDate(sched, next);
  if (!next) throw HttpError.validation([{ field: 'frequency', message: '这条规则已经没有下一期了' }]);
  /**
   * ⚠️ 只出 next 这一期 —— 不把 cursor 到 next 之间的过期期一起补上。
   * 「补账」是**调度器**的职责（它按「今天 + 提前天数」扫）；
   * 手动点一下就补一堆历史账，会让用户以为一次点了几十笔（第一版真如此：
   * startDate 设成一个月前时，点一次「立即生成」直接补出 2 笔）。
   */
  const out = generateForRule(ctx, actorId, row, next, [next]);
  const hit = out.find((o) => o.dueDate === next);
  if (!hit) throw HttpError.validation([{ field: 'frequency', message: '生成失败' }]);
  if (hit.error) throw HttpError.validation([{ field: 'amount', message: hit.error }]);
  return { dueDate: hit.dueDate, transactionId: hit.transactionId, reused: !hit.created };
}

/** 已生成的账单列表（`docs/05 §11.3`） */
export function generatedOf(ctx: AppCtx, ledgerId: string, id: string, limit = 50) {
  requireRow(ctx, ledgerId, id);
  return ctx.db
    .select({
      id: transactions.id,
      txDate: transactions.txDate,
      amount: transactions.amount,
      recordType: transactions.recordType,
      deletedAt: transactions.deletedAt,
      merchant: transactions.merchant,
      title: transactions.name,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.recurringRuleId, id),
        // 账单软删列是 deleted_at（不是 archived_at）
      ),
    )
    .orderBy(desc(transactions.txDate))
    .limit(Math.max(1, Math.min(limit, 200)))
    .all()
    .map((r) => ({
      id: r.id,
      txDate: r.txDate,
      amount: formatCents(r.amount),
      recordType: r.recordType,
      merchant: r.merchant,
      title: r.title,
      deleted: !!r.deletedAt,
    }));
}