/**
 * 账单服务 —— 账单的读写 + 金额规约的唯一落地点。
 *
 * 三条铁律（docs/01 §5.2、docs/03 §8）：
 *  ① `actual_amount` / `account_delta` / `to_account_delta` **一律后端计算**，拒绝前端传入；
 *  ② 任何查询都显式带 `ledger_id`，跨账本一律 404；
 *  ③ 金额字段在 API 层一律十进制字符串（docs/04 §1.2），库内一律整数「分」。
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accounts,
  attachments,
  categories,
  ledgerMembers,
  periodClosures,
  tags,
  transactionSettlements,
  transactionTags,
  transactions,
  users,
} from '../../db/schema.js';
import {
  DIRECTION_STAGE_LABEL,
  DEFAULT_DIRECTION,
  LIMITS,
  RECORD_TYPES_WITH_CATEGORY,
  type RecordType,
  type TxDirection,
} from '../../config/constants.js';
import { HttpError, type FieldIssue } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import {
  isOriginPhase,
  validateSettlements,
  syncSettlements,
  type SettleLink,
} from './settlements.js';
import { formatCents, nowIso, parseAmountToCents, today } from '../../utils/money.js';
import { escapeLike, keywordCondition } from '../../utils/tx-filter.js';
import { writeAudit } from '../../utils/audit.js';
import { calculateAmounts, type AmountResult } from './amounts.js';

/* ================================================================== *
 * 类型
 * ================================================================== */

export interface TxInput {
  recordType: RecordType;
  /** 不传则取该类型的「产生」阶段默认值（docs/13 §5） */
  direction?: TxDirection;
  accountId: string;
  toAccountId?: string | null;
  categoryId?: string | null;
  name?: string | null;
  amount: string | number;
  fee?: string | number;
  discount?: string | number;
  merchant?: string | null;
  counterparty?: string | null;
  tags?: string[] | null;
  note?: string | null;
  txDate: string;
  txTime?: string | null;
  adjustmentReason?: string | null;
  /**
   * 退款（docs/15 审查增补）：本笔是某笔支出的**冲减项**。
   * 走『同类型、反方向』表达，而不是记成收入 —— 记收入会虚增收入与分类统计。
   */
  isRefund?: boolean;
  clientRequestId?: string | null;
  templateId?: string | null;
  /**
   * 周期规则来源（docs/05 §11）。周期账单生成的每笔账都要记下「它来自哪条规则」，
   * 否则「这条规则已生成了哪些」根本查不出来（也就没法做「已生成列表」与人工核对）。
   * 幂等靠 `clientRequestId`（唯一索引），这一列只负责**溯源**。
   */
  recurringRuleId?: string | null;
  /**
   * 结清关联（docs/12 §六 D9）：本笔结算 / 核销冲抵了哪些「产生」笔、各冲抵多少。
   * 只有 receivable·收回/坏账核销、payable·还款/债务免除 允许传；
   * 留空合法（记账时不该被强迫先想清楚「还的是哪一笔」），未归属部分由
   * 「未结清」视图单列，保证「逐笔之和 + 未归属 = 台账余额」恒等。
   */
  settles?: Array<{ transactionId: string; amount: string | number }> | null;
}

type Row = typeof transactions.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

/* ================================================================== *
 * 归一化与校验
 * ================================================================== */

function normalizeText(
  v: string | null | undefined,
  field: string,
  maxLen: number,
): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === '') return null;
  if (t.length > maxLen) {
    throw HttpError.validation([{ field, message: `最多 ${maxLen} 字（当前 ${t.length}）` }]);
  }
  return t;
}

/**
 * 导出：导入链路要复用同一套时间归一化，避免「一个地方接受 23:28、
 * 另一个地方只接受 23:28:00」这种格式口径不一。
 */
export function normalizeTime(v: string | null | undefined, field = 'txTime'): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) {
    throw HttpError.validation([{ field, message: '时间格式应为 HH:mm 或 HH:mm:ss' }]);
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) {
    throw HttpError.validation([{ field, message: '时间取值越界' }]);
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function assertDate(v: string, field = 'txDate'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '')) {
    throw HttpError.validation([{ field, message: '日期格式应为 YYYY-MM-DD' }]);
  }
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw HttpError.validation([{ field, message: '日期取值越界' }]);
  }
  return v;
}

function centsOf(v: string | number | undefined, field: string): number {
  if (v === undefined || v === null || v === '') return 0;
  try {
    const c = parseAmountToCents(v);
    if (c < 0) throw HttpError.validation([{ field, message: '不能为负' }]);
    return c;
  } catch {
    throw HttpError.validation([{ field, message: '金额必须是最多 2 位小数的十进制字符串' }]);
  }
}

/** 账本内的账户，否则 404（跨账本不泄露存在性） */
function requireAccount(ctx: AppCtx, ledgerId: string, accountId: string): AccountRow {
  const row = ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('账户不存在');
  return row;
}

/** 期间关闭校验（docs/03 §8.2 / §12.1） */
export function assertPeriodOpen(ctx: AppCtx, ledgerId: string, txDate: string): void {
  const [y, m] = txDate.split('-').map(Number) as [number, number];
  const closed = ctx.db
    .select({ id: periodClosures.id })
    .from(periodClosures)
    .where(
      and(
        eq(periodClosures.ledgerId, ledgerId),
        eq(periodClosures.year, y),
        eq(periodClosures.month, m),
      ),
    )
    .get();
  if (closed) {
    throw HttpError.periodClosed(`该期间 ${txDate.slice(0, 7)} 已结账，无法记入该日期`);
  }
}

/**
 * 解析「本笔要动的第二个账户」（docs/12 §7.1：该字段不再承担阶段判别职责）。
 *   transfer    → 必填，转入方；
 *   receivable  → 自动解析账本内唯一的债权虚拟账户；
 *   payable     → 自动解析唯一的债务虚拟账户；
 *   其余类型    → null。
 */
function resolveSecondAccount(
  ctx: AppCtx,
  ledgerId: string,
  recordType: RecordType,
  mainAccount: AccountRow,
  toAccountId: string | null | undefined,
): AccountRow | null {
  if (recordType === 'transfer') {
    if (!toAccountId) {
      throw HttpError.validation([{ field: 'toAccountId', message: '转账必须选择转入账户' }]);
    }
    const to = requireAccount(ctx, ledgerId, toAccountId);
    const issues: FieldIssue[] = [];
    if (to.id === mainAccount.id) {
      issues.push({ field: 'toAccountId', message: '转入账户不能与转出账户相同' });
    }
    if (to.type === 'fee') {
      issues.push({ field: 'toAccountId', message: '不能转入手续费账户' });
    }
    if (to.archivedAt) {
      issues.push({ field: 'toAccountId', message: '该账户已归档，请换一个' });
    }
    if (issues.length) throw HttpError.validation(issues);
    return to;
  }

  if (recordType === 'receivable' || recordType === 'payable') {
    const wanted = recordType === 'receivable' ? 'receivable' : 'payable';
    const virtual = ctx.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.ledgerId, ledgerId),
          eq(accounts.type, wanted),
          isNull(accounts.archivedAt),
        ),
      )
      .get();
    if (!virtual) {
      throw HttpError.business(`账本缺少「${wanted === 'receivable' ? '债权' : '债务'}」虚拟账户`);
    }
    return virtual;
  }

  return null;
}

/** 分类校验：必须 level=2、record_type 匹配、未停用 */
function resolveCategory(
  ctx: AppCtx,
  ledgerId: string,
  recordType: RecordType,
  categoryId: string | null | undefined,
  { required = true }: { required?: boolean } = {},
): { id: string; parentId: string | null } | null {
  const needsCategory = RECORD_TYPES_WITH_CATEGORY.includes(recordType);
  if (!needsCategory) return null;
  // 不强制的阶段（核销）：留空就当没有分类；给了仍然逐项校验，不静默吞掉坏值
  if (!categoryId) {
    if (!required) return null;
    throw HttpError.validation([{ field: 'categoryId', message: '请选择分类' }]);
  }
  const row = ctx.db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.validation([{ field: 'categoryId', message: '分类不存在' }]);
  if (row.level !== 2) {
    throw HttpError.validation([{ field: 'categoryId', message: '只能选择子类别' }]);
  }
  if (row.recordType !== recordType) {
    throw HttpError.validation([{ field: 'categoryId', message: '分类与记录类型不匹配' }]);
  }
  if (row.archivedAt) {
    throw HttpError.validation([{ field: 'categoryId', message: '该分类已停用，请换一个' }]);
  }
  return { id: row.id, parentId: row.parentId };
}

function assertTagsInLedger(ctx: AppCtx, ledgerId: string, tagIds: string[]): string[] {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return [];
  if (unique.length > 20) {
    throw HttpError.validation([{ field: 'tags', message: '单笔最多 20 个标签' }]);
  }
  const rows = ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), inArray(tags.id, unique)))
    .all();
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((t) => !found.has(t));
  if (missing.length) {
    throw HttpError.validation([{ field: 'tags', message: `标签不存在：${missing.join('、')}` }]);
  }
  return unique;
}

/* ================================================================== *
 * 核心：把输入算成一条可直接落库的账单
 * ================================================================== */

export interface ComputedTx {
  recordType: RecordType;
  direction: TxDirection;
  account: AccountRow;
  toAccount: AccountRow | null;
  category: { id: string; parentId: string | null } | null;
  name: string | null;
  amount: number;
  fee: number;
  discount: number;
  merchant: string | null;
  counterparty: string | null;
  note: string | null;
  tagIds: string[];
  txDate: string;
  txTime: string | null;
  occurredAt: string;
  adjustmentReason: string | null;
  templateId: string | null;
  /** 已归一化为「分」的结清关联 */
  settles: SettleLink[];
  amounts: AmountResult;
}

export interface ComputeOptions {
  checkPeriod?: boolean;
  /** 编辑一笔结算笔时，把它自己已有的 link 排除后再算「未结清余额」 */
  excludeSettleTxId?: string | null;
}

export function computeTransaction(
  ctx: AppCtx,
  ledgerId: string,
  input: TxInput,
  { checkPeriod = true, excludeSettleTxId = null }: ComputeOptions = {},
): ComputedTx {
  const recordType = input.recordType;
  const direction = input.direction ?? DEFAULT_DIRECTION[recordType];
  const account = requireAccount(ctx, ledgerId, input.accountId);

  const issues: FieldIssue[] = [];
  if (account.archivedAt) {
    issues.push({ field: 'accountId', message: '该账户已归档，请换一个' });
  }
  if (account.type === 'fee') {
    issues.push({ field: 'accountId', message: '不能直接对「手续费/财务费用」账户记账' });
  }
  if (issues.length) throw HttpError.validation(issues);

  const toAccount = resolveSecondAccount(ctx, ledgerId, recordType, account, input.toAccountId);
  /**
   * 分类：`write_off`（核销）**不要求**。
   *
   * 财务理由：核销是纯台账冲销，不动现金、不进损益（`docs/03 §1.3` 新增行），
   * 世界上并不存在「坏账核销费用」这个科目 —— 强行要求用户挑一个支出分类，
   * 只会让他以为核销产生了费用，进而把净结余算高（这正是 `docs/12 §六` 要修的
   * 那类口径错）。给了也接受（不丢用户已经选的东西），只是不再强制。
   */
  const category = resolveCategory(
    ctx,
    ledgerId,
    recordType,
    input.categoryId,
    { required: direction !== 'write_off' },
  );
  const txDate = assertDate(input.txDate);
  if (checkPeriod) assertPeriodOpen(ctx, ledgerId, txDate);

  const isRefund = input.isRefund === true || input.adjustmentReason === 'refund';
  if (isRefund) assertRefundable(input, recordType, direction);

  const amounts = calculateAmounts({
    recordType,
    direction,
    amount: centsOf(input.amount, 'amount'),
    fee: centsOf(input.fee, 'fee'),
    discount: centsOf(input.discount, 'discount'),
    contra: isRefund,
  });

  // 结清关联的六道闸门（存在 / 阶段 / 类型一致 / 未结清余额 / 合计 ≤ 本笔）
  const settles = validateSettlements(ctx, ledgerId, {
    recordType,
    direction,
    // 台账口径一律用 `amount`（`docs/03 §1.3`：债权/债务台账 Δ = A，与 F/D 无关），
    // 所以这里不能用 actualAmount —— 归还手续费时不按手续费去冲债。
    amountCents: centsOf(input.amount, 'amount'),
    settles: input.settles,
    excludeSettleTxId,
  });

  const txTime = normalizeTime(input.txTime);
  return {
    recordType,
    direction,
    account,
    toAccount,
    category,
    name: normalizeText(input.name, 'name', LIMITS.NAME_MAX_LEN),
    amount: centsOf(input.amount, 'amount'),
    fee: centsOf(input.fee, 'fee'),
    discount: centsOf(input.discount, 'discount'),
    merchant: normalizeText(input.merchant, 'merchant', LIMITS.MERCHANT_MAX_LEN),
    counterparty: normalizeText(input.counterparty, 'counterparty', LIMITS.COUNTERPARTY_MAX_LEN),
    note: normalizeText(input.note, 'note', LIMITS.NOTE_MAX_LEN),
    tagIds: assertTagsInLedger(ctx, ledgerId, input.tags ?? []),
    txDate,
    txTime,
    // occurred_at = tx_date + tx_time（docs/02 §5.1）；无时间则取当日 00:00:00
    occurredAt: `${txDate}T${txTime ?? '00:00:00'}`,
    /**
     * `adjustmentReason` 原本只给 `adjustment` 用。现在它同时承担
     * **冲减项（contra）的阶段标记**：`reversal` = 红字冲销、`refund` = 退款。
     *
     * 为什么不新增一列：这是 `direction` 承担「阶段」职责的同一套思路
     * （`docs/12 §7.1`），而 `direction` 受 `ck_direction_by_type` 钉死、
     * 改它要重建 `transactions` 表（子表是 ON DELETE CASCADE，风险不成比例）。
     * `adjustmentReason` 是已有的 TEXT 列，语义可扩展且零迁移成本。
     */
    adjustmentReason:
      recordType === 'adjustment'
        ? normalizeText(input.adjustmentReason, 'adjustmentReason', 40)
        : isRefund
          ? 'refund'
          : null,
    templateId: input.templateId ?? null,
    settles,
    amounts,
  };
}

/**
 * 退款的四条闸（`docs/15` 审查增补，方案 A）。
 *
 * 退款为什么**不能**记成收入：
 *   支出 210、退款 210，真实净支出是 0。
 *   若记成 income +210 → 净结余碰巧也是 0（这正是它最迷惑的地方），
 *   但「收入」虚增 210、「该分类支出」仍是 210 ——
 *   收入统计、分类占比、预算执行**三处同时失真**。
 *
 * 正确表达是「支出的冲减项」：同 `record_type`、同分类、反现金流方向，
 * 统计侧按「Σ正常 − Σ冲减」汇总。于是：
 *   · **部分退款**：金额填退回来那部分，天然支持；
 *   · **跨月退款**：按 `txDate` 归期，落在哪个月就冲减哪个月，**无需回滚原月**；
 *   · **退款后统计**：自动回落到净额，不需要任何补偿动作。
 */
function assertRefundable(input: TxInput, recordType: RecordType, direction: TxDirection): void {
  const issues: FieldIssue[] = [];
  if (recordType !== 'expense' && recordType !== 'income') {
    issues.push({ field: 'isRefund', message: '退款只对支出与收入有意义' });
  }
  if (direction === 'write_off' || direction === 'none') {
    issues.push({ field: 'isRefund', message: '退款不能用于核销 / 登记阶段' });
  }
  // 退款是「原分录的负数」，不该再带手续费或折扣 —— 带了会分不清退的是哪一部分
  if (Number(input.fee ?? 0) > 0) issues.push({ field: 'fee', message: '退款不填手续费' });
  if (Number(input.discount ?? 0) > 0) issues.push({ field: 'discount', message: '退款不填折扣' });
  // 分类必须填：退款要冲减**原分类**的统计，不填就冲减不到任何一类
  if (!input.categoryId) {
    issues.push({ field: 'categoryId', message: '退款必须选分类（用于冲减该分类的统计）' });
  }
  if (issues.length) throw HttpError.validation(issues);
}

/** 纯计算（供 POST /transactions/preview） */
export function previewAmounts(input: TxInput): AmountResult & { recordType: RecordType; direction: TxDirection } {
  const direction = input.direction ?? DEFAULT_DIRECTION[input.recordType];
  const isRefund = input.isRefund === true || input.adjustmentReason === 'refund';
  if (isRefund) assertRefundable(input, input.recordType, direction);
  const r = calculateAmounts({
    recordType: input.recordType,
    direction,
    amount: centsOf(input.amount, 'amount'),
    fee: centsOf(input.fee, 'fee'),
    discount: centsOf(input.discount, 'discount'),
    contra: isRefund,
  });
  return { ...r, recordType: input.recordType, direction };
}

/* ================================================================== *
 * 创建
 * ================================================================== */

export interface CreateResult {
  row: Row;
  reused: boolean;
}

export function createTransaction(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: TxInput,
): CreateResult {
  // 幂等（docs/02 §5.1）：命中直接返回原记录，不重复创建
  if (input.clientRequestId) {
    const existed = ctx.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.clientRequestId, input.clientRequestId),
          eq(transactions.ledgerId, ledgerId),
        ),
      )
      .get();
    if (existed) return { row: existed, reused: true };
  }

  const c = computeTransaction(ctx, ledgerId, input);
  const at = nowIso();
  const id = newId(ID_PREFIX.transaction);

  const row = ctx.db.transaction((tx) => {
    tx.insert(transactions)
      .values({
        id,
        ledgerId,
        recordType: c.recordType,
        direction: c.direction,
        accountId: c.account.id,
        toAccountId: c.toAccount?.id ?? null,
        categoryId: c.category?.id ?? null,
        parentCategoryId: c.category?.parentId ?? null,
        amount: c.amount,
        fee: c.fee,
        discount: c.discount,
        actualAmount: c.amounts.actualAmount,
        accountDelta: c.amounts.accountDelta,
        toAccountDelta: c.amounts.toAccountDelta,
        name: c.name,
        merchant: c.merchant,
        counterparty: c.counterparty,
        note: c.note,
        txDate: c.txDate,
        txTime: c.txTime,
        occurredAt: c.occurredAt,
        templateId: c.templateId,
        recurringRuleId: input.recurringRuleId ?? null,
        adjustmentReason: c.adjustmentReason,
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: at,
        updatedAt: at,
        clientRequestId: input.clientRequestId ?? null,
      })
      .run();

    if (c.tagIds.length) {
      tx.insert(transactionTags)
        .values(c.tagIds.map((tagId) => ({ transactionId: id, tagId })))
        .run();
    }

    // 结清关联（docs/12 §六 D9）
    syncSettlements(ctx, ledgerId, id, c.settles, actorId);

    writeAudit(ctx.db, {
      ledgerId,
      actorId,
      action: 'create',
      entityType: 'transaction',
      entityId: id,
      summary: `记一笔 ${c.recordType} ¥${formatCents(c.amounts.actualAmount)}`,
      after: { recordType: c.recordType, direction: c.direction, amount: c.amount },
    });

    return ctx.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  });

  return { row, reused: false };
}

/* ================================================================== *
 * 读取
 * ================================================================== */

function tagMapFor(ctx: AppCtx, txIds: string[]): Map<string, Array<{ id: string; name: string; color: string }>> {
  const map = new Map<string, Array<{ id: string; name: string; color: string }>>();
  if (txIds.length === 0) return map;
  const rows = ctx.db
    .select({
      txId: transactionTags.transactionId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(transactionTags)
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(inArray(transactionTags.transactionId, txIds))
    .orderBy(asc(tags.sortOrder), asc(tags.name))
    .all();
  for (const r of rows) {
    const list = map.get(r.txId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.txId, list);
  }
  return map;
}

interface PayloadCtx {
  ledgerId: string;
  accountMap: Map<string, AccountRow>;
  categoryMap: Map<string, { id: string; name: string; parentId: string | null; parentName: string | null }>;
  userMap: Map<string, { id: string; nickname: string; status: string }>;
  memberSet: Set<string>;
  tagMap: Map<string, Array<{ id: string; name: string; color: string }>>;
  /** 本笔「产生」账单已被结清掉多少（docs/12 §六 D9） */
  settledMap: Map<string, number>;
  /** 本笔「结算 / 核销」账单冲抵了哪些产生笔 */
  settlementMap: Map<string, Array<{ transactionId: string; amount: number }>>;
}

function buildPayloadCtx(ctx: AppCtx, ledgerId: string, rows: Row[]): PayloadCtx {
  // 结清关联：一次拉全账本，视图层按需取用（列表页只关心「产生」那半边）
  const linkRows = ctx.db
    .select({
      settleTxId: transactionSettlements.settleTxId,
      originalTxId: transactionSettlements.originalTxId,
      amount: transactionSettlements.amount,
    })
    .from(transactionSettlements)
    .innerJoin(transactions, eq(transactions.id, transactionSettlements.settleTxId))
    .where(and(eq(transactionSettlements.ledgerId, ledgerId), isNull(transactions.deletedAt)))
    .all();
  const settledMap = new Map<string, number>();
  const settlementMap = new Map<string, Array<{ transactionId: string; amount: number }>>();
  for (const l of linkRows) {
    settledMap.set(l.originalTxId, (settledMap.get(l.originalTxId) ?? 0) + l.amount);
    const list = settlementMap.get(l.settleTxId) ?? [];
    list.push({ transactionId: l.originalTxId, amount: l.amount });
    settlementMap.set(l.settleTxId, list);
  }

  const accountRows = ctx.db.select().from(accounts).where(eq(accounts.ledgerId, ledgerId)).all();
  const categoryRows = ctx.db
    .select()
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .all();
  const userIds = [...new Set(rows.map((r) => r.createdBy))];
  const userRows = userIds.length
    ? ctx.db.select().from(users).where(inArray(users.id, userIds)).all()
    : [];
  const memberRows = ctx.db
    .select({ userId: ledgerMembers.userId })
    .from(ledgerMembers)
    .where(eq(ledgerMembers.ledgerId, ledgerId))
    .all();

  return {
    ledgerId,
    accountMap: new Map(accountRows.map((a) => [a.id, a])),
    categoryMap: new Map(
      categoryRows.map((c) => [
        c.id,
        {
          id: c.id,
          name: c.name,
          parentId: c.parentId,
          parentName: c.parentId
            ? (categoryRows.find((p) => p.id === c.parentId)?.name ?? null)
            : null,
        },
      ]),
    ),
    userMap: new Map(userRows.map((u) => [u.id, { id: u.id, nickname: u.nickname, status: u.status }])),
    memberSet: new Set(memberRows.map((m) => m.userId)),
    tagMap: tagMapFor(ctx, rows.map((r) => r.id)),
    settledMap,
    settlementMap,
  };
}

/** 单条账单 → API 形状（docs/04 §8.1，金额一律十进制字符串） */
export function toPayload(ctx: AppCtx, row: Row, pc: PayloadCtx, attachmentsCount = 0) {
  const account = pc.accountMap.get(row.accountId) ?? null;
  const toAccount = row.toAccountId ? (pc.accountMap.get(row.toAccountId) ?? null) : null;
  const cat = row.categoryId ? (pc.categoryMap.get(row.categoryId) ?? null) : null;
  const creator = pc.userMap.get(row.createdBy) ?? null;
  const brief = (a: AccountRow | null) =>
    a ? { id: a.id, name: a.name, type: a.type, kind: a.kind, icon: a.icon } : null;

  return {
    id: row.id,
    recordType: row.recordType,
    direction: row.direction,
    /** 人类可读阶段名（应收：借出/收回；应付：登记欠款/还款） */
    stageLabel:
      DIRECTION_STAGE_LABEL[row.recordType as RecordType]?.[row.direction as TxDirection] ?? null,
    /**
     * 债权 / 债务的结清信息（docs/12 §六 D9）。
     *  · 「产生」笔（借出 / 登记欠款）：`settled` 已结清、`outstanding` 还差多少；
     *  · 「结算 / 核销」笔：`settlements` 列出它冲抵了哪些产生笔。
     * 其它类型两者都为空，省得前端到处判空。
     */
    settled: isOriginPhase(row.recordType, row.direction)
      ? formatCents(pc.settledMap.get(row.id) ?? 0)
      : null,
    outstanding: isOriginPhase(row.recordType, row.direction)
      ? formatCents(row.amount - (pc.settledMap.get(row.id) ?? 0))
      : null,
    settlements: (pc.settlementMap.get(row.id) ?? []).map((l) => ({
      transactionId: l.transactionId,
      amount: formatCents(l.amount),
    })),
    account: brief(account),
    toAccount: brief(toAccount),
    category: cat
      ? {
          id: cat.id,
          name: cat.name,
          parent: cat.parentId ? { id: cat.parentId, name: cat.parentName } : null,
        }
      : null,
    name: row.name,
    amount: formatCents(row.amount),
    fee: formatCents(row.fee),
    discount: formatCents(row.discount),
    actualAmount: formatCents(row.actualAmount),
    accountDelta: formatCents(row.accountDelta),
    /** 对主账户的带符号金额（转移对主账户永远是负） */
    signedAmount: formatCents(row.accountDelta),
    toAccountDelta: row.toAccountDelta === null ? null : formatCents(row.toAccountDelta),
    merchant: row.merchant,
    counterparty: row.counterparty,
    tags: pc.tagMap.get(row.id) ?? [],
    note: row.note,
    txDate: row.txDate,
    txTime: row.txTime,
    occurredAt: row.occurredAt,
    adjustmentReason: row.adjustmentReason,
    createdBy: creator
      ? { id: creator.id, nickname: creator.nickname, isActive: creator.status === 'active' && pc.memberSet.has(creator.id) }
      : null,
    attachments: [] as unknown[],
    attachmentCount: attachmentsCount,
    source: row.templateId ? { templateId: row.templateId } : null,
    installmentPlanId: row.installmentPlanId ?? null,
    installmentIndex: row.installmentIndex ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function findTransactionRow(ctx: AppCtx, ledgerId: string, id: string): Row {
  const row = ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('账单不存在');
  return row;
}

export function getTransaction(ctx: AppCtx, ledgerId: string, id: string) {
  const row = findTransactionRow(ctx, ledgerId, id);
  const pc = buildPayloadCtx(ctx, ledgerId, [row]);
  const attCount = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(attachments)
    .where(eq(attachments.transactionId, id))
    .get();
  return toPayload(ctx, row, pc, Number(attCount?.c ?? 0));
}

export interface ListQuery {
  recordType?: string;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  parentCategoryId?: string;
  merchant?: string;
  counterparty?: string;
  tagIds?: string;
  tagMatchMode?: 'any' | 'all';
  /**
   * 附加费用筛选（前端「附加」一栏）：`discount` = 有折扣，`fee` = 有手续费。
   *
   * 语义是「这笔账带不带这类附加项」，判据为对应列 **> 0**，
   * 而不是看 actualAmount 的构成 —— 后者是派生值，`amount + fee − discount`
   * 在 fee 与 discount 恰好相等时也会相等，无法反推「有没有」。
   */
  extras?: string;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: string;
  maxAmount?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  includeDeleted?: boolean;
}

const SORTABLE = new Set(['occurredAt', 'amount', 'createdAt', 'updatedAt']);

export function listTransactions(ctx: AppCtx, ledgerId: string, q: ListQuery) {
  const page = Math.max(1, Number(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 20)));

  const conds = [eq(transactions.ledgerId, ledgerId)];
  if (q.includeDeleted) conds.push(isNotNull(transactions.deletedAt));
  else conds.push(isNull(transactions.deletedAt));

  if (q.recordType) {
    const types = q.recordType.split(',').map((s) => s.trim()).filter(Boolean);
    if (types.length) conds.push(inArray(transactions.recordType, types));
  }
  if (q.accountId) conds.push(eq(transactions.accountId, q.accountId));
  if (q.toAccountId) conds.push(eq(transactions.toAccountId, q.toAccountId));
  if (q.categoryId) {
    conds.push(
      or(
        eq(transactions.categoryId, q.categoryId),
        eq(transactions.parentCategoryId, q.categoryId),
      )!,
    );
  }
  if (q.parentCategoryId) conds.push(eq(transactions.parentCategoryId, q.parentCategoryId));
  if (q.merchant) conds.push(eq(transactions.merchant, q.merchant));
  if (q.counterparty) conds.push(eq(transactions.counterparty, q.counterparty));
  if (q.dateFrom) conds.push(gte(transactions.txDate, q.dateFrom));
  if (q.dateTo) conds.push(lte(transactions.txDate, q.dateTo));
  if (q.minAmount) conds.push(gte(transactions.actualAmount, Number(q.minAmount)));
  if (q.maxAmount) conds.push(lte(transactions.actualAmount, Number(q.maxAmount)));
  if (q.keyword) {
    /**
     * ⚠️ 走 `keywordCondition` 这个**全站唯一出口**，与统计页口径逐字一致
     * （含 `%` / `_` 的转义）。原先这里是手写的一份 `LIKE`：
     * 卡片按一种口径、列表按另一种，用户会发现「卡片说 12 笔、列表只有 7 笔」。
     */
    const kwCond = keywordCondition(q.keyword);
    if (kwCond) conds.push(kwCond);
  }
  if (q.tagIds) {
    const ids = q.tagIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) {
      const mode = q.tagMatchMode === 'all' ? 'all' : 'any';
      if (mode === 'any') {
        conds.push(
          sql`${transactions.id} IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN (${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `,
          )}))`,
        );
      } else {
        for (const tid of ids) {
          conds.push(
            sql`${transactions.id} IN (SELECT transaction_id FROM transaction_tags WHERE tag_id = ${tid})`,
          );
        }
      }
    }
  }

  /**
   * 附加费用：「折扣」与「手续费」两个子项，多选之间取**或**。
   *
   * 与 `.types`（`IN` = 或）、`.tags`（默认 any）保持同一套多选语义 ——
   * 若这里改成「与」，用户勾上两项会得到「同时既有折扣又有手续费」，
   * 与页面上其它多选项的直觉相反。
   *
   * 条件加进同一个 `conds`，于是列表、`meta.summary`（汇总条）、
   * `meta.byDate`（日期头小计）**自动同源** —— 三者共用下面那个 `where`。
   * 这就是「与现有查询逻辑正确联动」的全部含义：不要另算一份。
   */
  if (q.extras) {
    const extras = q.extras.split(',').map((s) => s.trim());
    const wantFee = extras.includes('fee');
    const wantDiscount = extras.includes('discount');
    if (wantFee && wantDiscount) {
      conds.push(or(gt(transactions.fee, 0), gt(transactions.discount, 0))!);
    } else if (wantFee) {
      conds.push(gt(transactions.fee, 0));
    } else if (wantDiscount) {
      conds.push(gt(transactions.discount, 0));
    }
  }

  const where = and(...conds);
  const totalRow = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(where)
    .get();
  const total = Number(totalRow?.c ?? 0);

  // 排序：主键 + occurredAt 兜底（docs/13 §9.2）
  const raw = (q.sort ?? '-occurredAt').trim();
  const desc0 = raw.startsWith('-');
  const key = raw.replace(/^-/, '');
  const col = SORTABLE.has(key) ? key : 'occurredAt';
  const dir = desc0 ? desc : asc;
  const colRef =
    col === 'amount'
      ? transactions.amount
      : col === 'createdAt'
        ? transactions.createdAt
        : col === 'updatedAt'
          ? transactions.updatedAt
          : transactions.occurredAt;

  const rows = ctx.db
    .select()
    .from(transactions)
    .where(where)
    .orderBy(dir(colRef), desc(transactions.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  // 汇总（docs/03 §1.5 口径：只算收入与支出的 actual，其它类型不入净结余）
  const sumRows = ctx.db
    .select({
      recordType: transactions.recordType,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(where)
    .groupBy(transactions.recordType)
    .all();
  const pick = (t: string) => Number(sumRows.find((r) => r.recordType === t)?.total ?? 0);
  const totalExpense = pick('expense');
  const totalIncome = pick('income');

  /**
   * 按日小计（docs/13 §9.2 的日期分组头）。
   *
   * 刻意**不复用** `GET /transactions/daily-totals`：那个接口是无筛选的全量口径，
   * 一旦列表带了类型/账户/分类筛选，日期头就会显示与列表对不上的合计 ——
   * 「列表 12 笔、合计 8000」这种自相矛盾比没有小计更糟。
   * 这里用同一个 `where` 聚合，保证小计与列表**同源**。
   *
   * 只回当前页出现过的日期：一次聚合覆盖全量筛选集，但响应体按页裁剪，
   * 十年账本也不会因为翻两页就拖着几千个日期回来。
   */
  const dayRows = ctx.db
    .select({
      txDate: transactions.txDate,
      recordType: transactions.recordType,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(where)
    .groupBy(transactions.txDate, transactions.recordType)
    .all();

  const pageDates = new Set(rows.map((r) => r.txDate));
  const dayAcc = new Map<string, { expense: number; income: number; count: number }>();
  for (const r of dayRows) {
    if (!pageDates.has(r.txDate)) continue;
    const cell = dayAcc.get(r.txDate) ?? { expense: 0, income: 0, count: 0 };
    const cents = Number(r.total ?? 0);
    if (r.recordType === 'expense') cell.expense += cents;
    else if (r.recordType === 'income') cell.income += cents;
    cell.count += Number(r.cnt ?? 0);
    dayAcc.set(r.txDate, cell);
  }
  const byDate: Record<string, {
    date: string;
    totalExpense: string;
    totalIncome: string;
    net: string;
    count: number;
  }> = {};
  for (const [date, cell] of dayAcc) {
    byDate[date] = {
      date,
      totalExpense: formatCents(cell.expense),
      totalIncome: formatCents(cell.income),
      net: formatCents(cell.income - cell.expense),
      count: cell.count,
    };
  }

  const pc = buildPayloadCtx(ctx, ledgerId, rows);
  return {
    data: rows.map((r) => toPayload(ctx, r, pc)),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary: {
        totalExpense: formatCents(totalExpense),
        totalIncome: formatCents(totalIncome),
        netBalance: formatCents(totalIncome - totalExpense),
      },
      byDate,
      byType: sumRows.map((r) => ({
        recordType: r.recordType,
        total: formatCents(Number(r.total ?? 0)),
        count: Number(r.cnt ?? 0),
      })),
    },
  };
}

/* ================================================================== *
 * 更新 / 删除 / 恢复
 * ================================================================== */

export function updateTransaction(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  input: Partial<TxInput> & { expectedUpdatedAt?: string | null },
): Row {
  const before = findTransactionRow(ctx, ledgerId, id);
  if (before.deletedAt) throw HttpError.business('账单已在回收站，请先恢复再编辑');

  // 乐观锁（docs/03 §8.4）
  if (input.expectedUpdatedAt && input.expectedUpdatedAt !== before.updatedAt) {
    throw HttpError.conflict('该账单已被他人修改，请查看最新内容');
  }

  // 期间关闭 / 账户锁定（docs/03 §3.3、§12.2）
  const [by, bm] = before.txDate.split('-').map(Number) as [number, number];
  const closed = ctx.db
    .select({ id: periodClosures.id })
    .from(periodClosures)
    .where(
      and(
        eq(periodClosures.ledgerId, ledgerId),
        eq(periodClosures.year, by),
        eq(periodClosures.month, bm),
      ),
    )
    .get();
  if (closed) throw HttpError.periodClosed('该账单所在期间已结账，只能通过反向调整修正');

  const merged: TxInput = {
    recordType: (input.recordType ?? before.recordType) as RecordType,
    direction: (input.direction ?? before.direction) as TxDirection,
    accountId: input.accountId ?? before.accountId,
    toAccountId: input.toAccountId !== undefined ? input.toAccountId : before.toAccountId,
    categoryId: input.categoryId !== undefined ? input.categoryId : before.categoryId,
    name: input.name !== undefined ? input.name : before.name,
    amount: input.amount ?? formatCents(before.amount),
    fee: input.fee ?? formatCents(before.fee),
    discount: input.discount ?? formatCents(before.discount),
    merchant: input.merchant !== undefined ? input.merchant : before.merchant,
    counterparty: input.counterparty !== undefined ? input.counterparty : before.counterparty,
    tags: input.tags ?? undefined,
    note: input.note !== undefined ? input.note : before.note,
    txDate: input.txDate ?? before.txDate,
    txTime: input.txTime !== undefined ? input.txTime : before.txTime,
    adjustmentReason:
      input.adjustmentReason !== undefined ? input.adjustmentReason : before.adjustmentReason,
    settles: input.settles,
  };

  // `excludeSettleTxId`：编辑一笔结算笔时，它自己已有的 link 要先从「未结清余额」里
  // 扣掉，否则「把 300 改成 500」会因为自己那 300 占用而被误判为超额。
  const c = computeTransaction(ctx, ledgerId, merged, { excludeSettleTxId: id });
  const at = nowIso();
  const tagIds =
    input.tags === undefined
      ? ctx.db
          .select({ tagId: transactionTags.tagId })
          .from(transactionTags)
          .where(eq(transactionTags.transactionId, id))
          .all()
          .map((r) => r.tagId)
      : assertTagsInLedger(ctx, ledgerId, input.tags ?? []);

  return ctx.db.transaction((tx) => {
    tx.update(transactions)
      .set({
        recordType: c.recordType,
        direction: c.direction,
        accountId: c.account.id,
        toAccountId: c.toAccount?.id ?? null,
        categoryId: c.category?.id ?? null,
        parentCategoryId: c.category?.parentId ?? null,
        amount: c.amount,
        fee: c.fee,
        discount: c.discount,
        actualAmount: c.amounts.actualAmount,
        accountDelta: c.amounts.accountDelta,
        toAccountDelta: c.amounts.toAccountDelta,
        name: c.name,
        merchant: c.merchant,
        counterparty: c.counterparty,
        note: c.note,
        txDate: c.txDate,
        txTime: c.txTime,
        occurredAt: c.occurredAt,
        adjustmentReason: c.adjustmentReason,
        updatedBy: actorId,
        updatedAt: at,
      })
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
      .run();

    tx.delete(transactionTags).where(eq(transactionTags.transactionId, id)).run();
    if (tagIds.length) {
      tx.insert(transactionTags)
        .values(tagIds.map((tagId) => ({ transactionId: id, tagId })))
        .run();
    }

    // 结清关联整笔重写：编辑页的语义是「改这一笔结清冲抵了谁」，不是增量追加。
    // 不传 `settles` 时**保持原样**（编辑一笔普通支出不该顺手清掉别人的关联）。
    if (input.settles !== undefined) syncSettlements(ctx, ledgerId, id, c.settles, actorId);

    writeAudit(ctx.db, {
      ledgerId,
      actorId,
      action: 'update',
      entityType: 'transaction',
      entityId: id,
      summary: `修改账单 ¥${formatCents(before.amount)} → ¥${formatCents(c.amount)}`,
      before: { amount: before.amount, accountDelta: before.accountDelta },
      after: { amount: c.amount, accountDelta: c.amounts.accountDelta },
    });

    return ctx.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
  });
}

export function softDeleteTransaction(ctx: AppCtx, actorId: string, ledgerId: string, id: string): void {
  const row = findTransactionRow(ctx, ledgerId, id);
  if (row.deletedAt) throw HttpError.business('该账单已在回收站');
  // 已结账期间同样禁止删除（docs/03 §12.2：结账后只能反向调整）
  assertPeriodOpen(ctx, ledgerId, row.txDate);
  const at = nowIso();
  ctx.db
    .update(transactions)
    .set({ deletedAt: at, updatedBy: actorId, updatedAt: at })
    .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
    .run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'transaction',
    entityId: id,
    summary: `删除账单 ¥${formatCents(row.amount)}（回收站保留 30 天）`,
  });
}

export function restoreTransaction(ctx: AppCtx, actorId: string, ledgerId: string, id: string): Row {
  const row = findTransactionRow(ctx, ledgerId, id);
  if (!row.deletedAt) throw HttpError.business('该账单不在回收站');
  assertPeriodOpen(ctx, ledgerId, row.txDate);
  const at = nowIso();
  ctx.db
    .update(transactions)
    .set({ deletedAt: null, updatedBy: actorId, updatedAt: at })
    .where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId)))
    .run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'transaction',
    entityId: id,
    summary: '从回收站恢复账单',
  });
  return ctx.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}

/* ================================================================== *
 * 辅助端点
 * ================================================================== */

/**
 * 表单初始态（docs/13 §5 与 §14.2 的新增端点）。
 * 「最近使用的账户」记的是**该用户**在该账本的最近一笔，协作场景下两人各有常用账户。
 */
export function newDefaults(ctx: AppCtx, ledgerId: string, userId: string) {
  const last = ctx.db
    .select({ accountId: transactions.accountId, createdAt: transactions.createdAt })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.createdBy, userId),
        isNull(transactions.deletedAt),
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(1)
    .get();

  let accountId: string | null = null;
  let lastUsedAt: string | null = null;
  if (last) {
    const alive = ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, last.accountId),
          eq(accounts.ledgerId, ledgerId),
          isNull(accounts.archivedAt),
        ),
      )
      .get();
    if (alive) {
      accountId = alive.id;
      lastUsedAt = last.createdAt;
    }
  }

  if (!accountId) {
    // 兜底顺序（docs/13 §5）：第一个未归档的非虚拟资产账户 → 第一个未归档非虚拟账户
    const candidates = ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ledgerId, ledgerId), isNull(accounts.archivedAt)))
      .orderBy(asc(accounts.sortOrder), asc(accounts.createdAt))
      .all()
      .filter((a) => a.kind !== 'virtual');
    accountId = (candidates.find((a) => a.kind === 'asset') ?? candidates[0])?.id ?? null;
  }

  return {
    recordType: 'expense' as RecordType,
    direction: DEFAULT_DIRECTION.expense,
    accountId,
    lastUsedAt,
    txDate: today(),
    txTime: null,
    hasAccounts: ctx.db
      .select({ c: sql<number>`count(*)` })
      .from(accounts)
      .where(and(eq(accounts.ledgerId, ledgerId), isNull(accounts.archivedAt), ne(accounts.kind, 'virtual')))
      .get()!.c > 0,
  };
}

/** 商家 / 对象历史补全（docs/07 Stage 8，按使用频次排序） */
export function suggestValues(
  ctx: AppCtx,
  ledgerId: string,
  field: 'merchant' | 'counterparty' | 'name',
  keyword?: string,
  limit = 20,
) {
  const col =
    field === 'merchant'
      ? transactions.merchant
      : field === 'counterparty'
        ? transactions.counterparty
        : transactions.name;
  const key = sql<string>`${col}`;
  const rows = ctx.db
    .select({ value: key, count: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        isNotNull(col),
        keyword ? sql`${col} LIKE ${`%${escapeLike(keyword)}%`} ESCAPE '\\'` : sql`1 = 1`,
      ),
    )
    .groupBy(key)
    .orderBy(desc(sql`count(*)`))
    .limit(Math.min(50, Math.max(1, limit)))
    .all();
  return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
}

/** 供列表页「按日分组」使用：区间内每日支出/收入小计（docs/13 §9.2） */
export function dailyTotals(ctx: AppCtx, ledgerId: string, from: string, to: string) {
  return ctx.db
    .select({
      txDate: transactions.txDate,
      recordType: transactions.recordType,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, from),
        lte(transactions.txDate, to),
      ),
    )
    .groupBy(transactions.txDate, transactions.recordType)
    .all()
    .map((r) => ({
      txDate: r.txDate,
      recordType: r.recordType,
      total: formatCents(Number(r.total ?? 0)),
      count: Number(r.cnt ?? 0),
    }));
}

/* ================================================================== *
 * 回收站 / 批量 / 复制（docs/04 §8.4–8.6）
 * ================================================================== */

/** 覆盖某账单的标签集合（用于批量「替换」模式与复制） */
export function syncTags(ctx: AppCtx, ledgerId: string, txId: string, tagIds: string[]): void {
  const clean = assertTagsInLedger(ctx, ledgerId, tagIds);
  ctx.db.transaction((tx) => {
    tx.delete(transactionTags).where(eq(transactionTags.transactionId, txId)).run();
    if (clean.length) {
      tx.insert(transactionTags)
        .values(clean.map((tagId) => ({ transactionId: txId, tagId })))
        .run();
    }
  });
}

/** 批量追加标签（不覆盖已有） */
export function batchTag(ctx: AppCtx, ledgerId: string, ids: string[], tagIds: string[]): void {
  const clean = assertTagsInLedger(ctx, ledgerId, tagIds);
  if (!clean.length) return;
  for (const txId of ids) {
    const row = findTransactionRow(ctx, ledgerId, txId);
    const existing = ctx.db
      .select({ tagId: transactionTags.tagId })
      .from(transactionTags)
      .where(eq(transactionTags.transactionId, row.id))
      .all()
      .map((r) => r.tagId);
    const merged = [...new Set([...existing, ...clean])];
    syncTags(ctx, ledgerId, row.id, merged);
  }
}

/** 永久删除：仅允许已软删除、且无附件的账单（docs/04 §8.4） */
export function permanentDelete(ctx: AppCtx, actorId: string, ledgerId: string, id: string): void {
  const row = findTransactionRow(ctx, ledgerId, id);
  if (!row.deletedAt) throw HttpError.business('仅回收站中的账单可永久删除');
  const att = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(attachments)
    .where(eq(attachments.transactionId, id))
    .get();
  if (Number(att?.c ?? 0) > 0) throw HttpError.business('该账单还有附件，请先删除附件');

  const ageDays = (Date.now() - new Date(row.deletedAt).getTime()) / 86_400_000;
  if (ageDays > LIMITS.TRASH_RETENTION_DAYS) {
    throw HttpError.business('该账单已超回收站保留期，将由系统自动清理');
  }

  ctx.db.transaction((tx) => {
    tx.delete(transactionTags).where(eq(transactionTags.transactionId, id)).run();
    tx.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.ledgerId, ledgerId))).run();
    writeAudit(ctx.db, {
      ledgerId,
      actorId,
      action: 'delete',
      entityType: 'transaction',
      entityId: id,
      summary: `永久删除账单 ¥${formatCents(row.amount)}`,
    });
  });
}

/** 清空回收站（仅 owner/admin） */
export function emptyTrash(ctx: AppCtx, actorId: string, ledgerId: string): number {
  const rows = ctx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.ledgerId, ledgerId), isNotNull(transactions.deletedAt)))
    .all();
  let n = 0;
  for (const r of rows) {
    try {
      permanentDelete(ctx, actorId, ledgerId, r.id);
      n += 1;
    } catch {
      /* 有附件的跳过，不阻断整批清理 */
    }
  }
  return n;
}

/**
 * 复制上一笔（docs/13 §十一）：
 * 字段全带，但**金额清空**、**日期改为今天** —— 金额是变化量最大的字段，
 * 带出来极易误提交（复制最常见用途是「再买一次同样的东西，但价格不同」）。
 */
export function duplicateTransaction(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  override: { amount?: string | number; txDate?: string; txTime?: string | null } = {},
): Row {
  const src = findTransactionRow(ctx, ledgerId, id);
  const tagIds = ctx.db
    .select({ tagId: transactionTags.tagId })
    .from(transactionTags)
    .where(eq(transactionTags.transactionId, id))
    .all()
    .map((r) => r.tagId);

  const input: TxInput = {
    recordType: src.recordType as RecordType,
    direction: src.direction as TxDirection,
    accountId: src.accountId,
    toAccountId: src.toAccountId,
    categoryId: src.categoryId,
    name: src.name,
    amount: override.amount ?? formatCents(src.amount),
    fee: formatCents(src.fee),
    discount: formatCents(src.discount),
    merchant: src.merchant,
    counterparty: src.counterparty,
    note: src.note,
    tags: tagIds,
    txDate: override.txDate ?? today(),
    txTime: override.txTime === undefined ? src.txTime : override.txTime,
    adjustmentReason: src.adjustmentReason,
  };
  const { row } = createTransaction(ctx, actorId, ledgerId, input);
  return row;
}

