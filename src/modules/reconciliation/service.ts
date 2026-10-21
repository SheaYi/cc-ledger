/**
 * 对账（docs/03 §三、docs/04 §十二）。
 *
 * 核心纪律：
 *   · 余额不可直接编辑，差异只能通过 adjustment 账单修正（docs/03 §2.3）；
 *   · actual = |差额|，符号由 account_delta 承载（docs/03 §1.2 / §1.3）；
 *   · 每次对账（无论是否平衡）都写一条 reconciliation_records，构成账本可信度自证。
 */
import { and, desc, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { accounts, reconciliationRecords, transactions, users } from '../../db/schema.js';
import {
  BALANCE_BOUNDARY_CHANGE_DATE,
  RECONCILE_REASONS,
  type ReconcileReason,
} from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, parseAmountToCents, today } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { ledgerDeltas } from '../accounts/balance.js';
import { findAccount } from '../accounts/service.js';

export interface ReconcileInput {
  actualBalance: string | number;
  reconcileDate?: string;
  reasonCode?: ReconcileReason | null;
  reasonNote?: string | null;
  createAdjustment?: boolean;
  lockBeforeDate?: boolean;
  /**
   * 用户确认的归因（R-02）。形如
   * `[{ kind: 'missing_entry', amount: '280.00', note: '地铁卡充值' }]`。
   *
   * ⚠️ `kind` 的类型是 **string 而不是 AttributionKind**，这是刻意的「宽松接收」。
   * 路由层的 zod 也用 `z.string()`，非法值由 `normalizeAttribution` 统一过滤。
   * 理由：归因是**辅助信息**，它坏掉不该阻断「修正余额」这件正事。
   * 若这里写成联合类型，一个前端传了稍新的 kind 就会 400，
   * 而用户会看到「提交失败」却不知道是自己的数据问题还是接口变了。
   *
   * 它与 `reasonCode` 是**两件事**：`reasonCode` 是会计口径（决定调整单怎么记），
   * 归因是业务事实（这笔钱到底哪去了）。前者必填（只要有差额），
   * 后者选填 —— 但只要填了就必须存下来，否则复查无从下手。
   */
  attributions?: { kind: string; amount?: string | number | null; note?: string | null }[] | null;
}

interface ReconcileComputation {
  accountId: string;
  accountName: string;
  reconcileDate: string;
  systemBalance: number;
  actualBalance: number;
  diffAmount: number;
  isBalanced: boolean;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
  /**
   * 该账户在**期初日当天**的流水笔数与净额（docs/14 口径变更的披露）。
   *
   * 为什么必须在这里算、而不是让用户自己去对：2026-10-14 起建账当天的流水计入
   * 余额了。若用户当初把期初余额**填大**来迁就旧口径的错误，切 `≤` 后会**双计** ——
   * 而这个账户对完账出现差额，恰恰是他该去银行 App 看一眼的时刻。
   *
   * 只在 `count > 0` 时返回（否则是噪音）；虚拟账户恒为 null（期初日 1970，无流水）。
   */
  openingDayTx: { date: string; count: number; delta: number } | null;
}

/** 取某账户在期初日当天的流水笔数与净额（主账户 + 转入账户两侧） */
function openingDayFlow(
  ctx: AppCtx,
  ledgerId: string,
  accountId: string,
  openingDate: string,
): ReconcileComputation['openingDayTx'] {
  const row = ctx.db
    .select({
      count: sql<number>`count(*)`,
      delta: sql<number>`coalesce(sum(
        CASE
          WHEN ${transactions.accountId} = ${accountId} THEN ${transactions.accountDelta}
          WHEN ${transactions.toAccountId} = ${accountId} THEN ${transactions.toAccountDelta}
        END), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.txDate, openingDate),
        sql`(${transactions.accountId} = ${accountId} OR ${transactions.toAccountId} = ${accountId})`,
      ),
    )
    .get();

  const count = Number(row?.count ?? 0);
  if (count === 0) return null;
  return { date: openingDate, count, delta: Number(row?.delta ?? 0) };
}

/** system_balance = balance(account, reconcileDate) */
function compute(
  ctx: AppCtx,
  ledgerId: string,
  accountId: string,
  input: ReconcileInput,
): ReconcileComputation {
  const acc = findAccount(ctx, ledgerId, accountId);
  if (acc.archivedAt) throw HttpError.business('该账户已归档，无法对账');

  const reconcileDate = input.reconcileDate ?? today();
  const delta = ledgerDeltas(ctx, ledgerId, reconcileDate).get(accountId)?.delta ?? 0;
  const systemBalance = acc.openingBalance + delta;
  const actualBalance = parseAmountToCents(input.actualBalance);
  const diffAmount = actualBalance - systemBalance;

  return {
    accountId,
    accountName: acc.name,
    reconcileDate,
    systemBalance,
    actualBalance,
    diffAmount,
    isBalanced: diffAmount === 0,
    lastReconciledAt: acc.lastReconciledAt,
    lastReconciledBalance: acc.lastReconciledBalance,
    openingDayTx: openingDayFlow(ctx, ledgerId, accountId, acc.openingDate),
  };
}

/**
 * 差异归因分类（R-02）。
 *
 * ## 为什么要在「原因码」之上再有一层「归因」
 *
 * `RECONCILE_REASONS`（`unrecorded_expense` / `bank_fee` / …）是**会计口径**：
 * 它决定生成什么调整单。用户真正卡住的地方不是「选哪个码」，而是
 * 「**我这个差额到底是什么**」—— 而现有实现只给一个差额数字加三个建议码，
 * 用户拿到之后仍然不知道该去哪儿、该改哪一笔。
 *
 * 专业会计的做法是**余额调节表**：差额被拆成几类成因，每类都有明确的核对动作。
 * 这里按同样的思路给四类，并用金额把差额**分配**到它们 —— 于是用户看到的是
 * 「银行余额比账面少 300 元，其中未记支出疑似 280 元、银行手续费疑似 20 元」，
 * 而不是「差额 -300.00」。
 *
 * ## 金额分配是「候选建议」，不是「断言」
 *
 * 系统无法真的知道用户漏记了什么。它能做的最有价值的事是：
 * 给出**按可能性排序的候选**并标明每个的金额区间，让用户去核对。
 * 所以这里明确叫 `attribution`，且每项都带 `confidence` 与 `action`
 * （下一步该做什么），而不是给一个「已确认的原因」。
 */
export type AttributionKind = 'missing_entry' | 'wrong_entry' | 'duplicate' | 'in_transit';

export interface Attribution {
  kind: AttributionKind;
  /** 给用户看的话，不是代码名 */
  label: string;
  /** 这个成因可能解释的金额（元字符串）。`null` = 无法量化，需要人工核对 */
  amount: string | null;
  /** `high` / `medium` / `low` —— 只影响排序，不影响是否显示 */
  confidence: 'high' | 'medium' | 'low';
  /** 用户下一步该做什么（前端据此给按钮） */
  action: string;
  /** 该成因下的具体证据（有就比「可能漏记」有用得多） */
  evidence: string | null;
}

/**
 * 生成归因候选。
 *
 * `diff < 0` 表示**实际余额低于账面**（钱少了）—— 大概率是漏记了支出。
 * `diff > 0` 表示**实际余额高于账面**（钱多了）—— 大概率是漏记了收入，或重复扣款已退回。
 *
 * 每一项的 amount 都**不超过 |diff|**：候选原因之和大于差额就意味着
 * 「这几条合起来正好解释了差额」，那会让用户以为系统已经算清了，
 * 而它其实只是排序建议。
 */
function attributionsOf(
  ctx: AppCtx,
  ledgerId: string,
  accountId: string,
  diff: number,
  reconcileDate: string,
): Attribution[] {
  if (diff === 0) return [];

  const abs = Math.abs(diff);
  const out: Attribution[] = [];

  /**
   * 「在途」是唯一能给出**具体证据**的一类：对账日当天的流水。
   * 「当天有 3 笔合计 −320」比「可能存在在途」有用得多 ——
   * 前者能让用户立刻判断「那 320 是不是就是差额」。
   */
  const recent = ctx.db
    .select({ txDate: transactions.txDate, name: transactions.name, delta: transactions.accountDelta })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.accountId, accountId),
        isNull(transactions.deletedAt),
        eq(transactions.txDate, reconcileDate),
      ),
    )
    .orderBy(desc(transactions.txDate))
    .limit(5)
    .all();

  const sameDayTotal = recent.reduce((a, t) => a + t.delta, 0);
  const evidence = recent.length
    ? `${reconcileDate} 当天 App 内有 ${recent.length} 笔流水，合计 ${formatCents(sameDayTotal)}`
    : `${reconcileDate} 当天 App 内没有任何流水`;

  if (diff < 0) {
    out.push({
      kind: 'missing_entry',
      label: '有支出没记',
      amount: formatCents(abs),
      confidence: 'high',
      action: '按银行流水补记这笔支出',
      evidence: null,
    });
    out.push({
      kind: 'in_transit',
      label: '在途（刚发生未入账）',
      amount: null,
      confidence: 'medium',
      action: '核对最近 3 天的流水，确认是否银行已扣而 App 未记',
      evidence,
    });
    out.push({
      kind: 'duplicate',
      label: '重复扣费',
      amount: null,
      confidence: 'low',
      action: '在账单里搜索近期同名商家，确认没有被记两次',
      evidence: null,
    });
    out.push({
      kind: 'wrong_entry',
      label: '有金额记错',
      amount: null,
      confidence: 'low',
      action: '核对金额较大的几笔，看有没有多记或少记',
      evidence: null,
    });
  } else {
    out.push({
      kind: 'missing_entry',
      label: '有收入没记',
      amount: formatCents(abs),
      confidence: 'high',
      action: '补记这笔收入（利息、代发、报销等）',
      evidence: null,
    });
    out.push({
      kind: 'in_transit',
      label: '在途（已入账未到账）',
      amount: null,
      confidence: 'medium',
      action: '核对最近 3 天的流水，确认是否 App 已记而银行未入',
      evidence,
    });
    out.push({
      kind: 'wrong_entry',
      label: '有金额记错（多记了支出）',
      amount: null,
      confidence: 'low',
      action: '核对金额较大的几笔',
      evidence: null,
    });
    out.push({
      kind: 'duplicate',
      label: '重复入账 / 已退回的扣费',
      amount: null,
      confidence: 'low',
      action: '搜索是否有一笔被误记后又退回',
      evidence: null,
    });
  }

  return out;
}

/** 差异原因建议（docs/04 §12.1 的 suggestedReasons） */
function suggestReasons(diff: number): ReconcileReason[] {
  if (diff === 0) return ['history_missing', 'entry_error'];
  if (diff < 0) return ['unrecorded_expense', 'bank_fee', 'interest'];
  return ['unrecorded_income', 'interest', 'history_missing'];
}

const ATTRIBUTION_KINDS = new Set<AttributionKind>([
  'missing_entry',
  'wrong_entry',
  'duplicate',
  'in_transit',
]);

/**
 * 把请求里的归因规整成可落库的形状。
 *
 * 三件事：① 只保留合法 kind（不认识的丢弃，不抛错 —— 归因是辅助信息，
 * 不该因为一条脏数据让整个对账失败）；② 金额转成**元字符串**（与全站一致，
 * 不要在库里混存分和元）；③ 整组为空返回 `null`。
 */
function normalizeAttribution(
  input: ReconcileInput['attributions'],
): string | null {
  if (!Array.isArray(input) || !input.length) return null;
  /**
   * 过滤用 `Set` 而不是 `Array.includes`：后者的参数类型是 `AttributionKind`，
   * 而这里的 `a.kind` 是 `string`（宽松接收的代价就是类型上要自己收窄）。
   * 先在 filter 里收窄成 `AttributionKind`，map 里就不必再断言。
   */
  const rows = input
    .filter((a): a is { kind: AttributionKind; amount?: string | number | null; note?: string | null } =>
      Boolean(a) && ATTRIBUTION_KINDS.has(a.kind as AttributionKind),
    )
    .map((a) => {
      const cents = a.amount === undefined || a.amount === null ? null : toCentsSafe(a.amount);
      return {
        kind: a.kind,
        amount: cents === null ? null : (cents / 100).toFixed(2),
        note: a.note?.trim() || null,
      };
    });
  return rows.length ? JSON.stringify(rows) : null;
}

/** 金额解析失败返回 `null`（归因是辅助信息，不能因它失败） */
function toCentsSafe(v: string | number): number | null {
  try {
    const n = typeof v === 'number' ? Math.round(v) : Math.round(Number(String(v).trim()) * 100);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 读库时把 JSON 还原；脏数据不能让整页对账历史挂掉 */
export function parseAttribution(json: string | null | undefined): {
  kind: AttributionKind;
  amount: string | null;
  note: string | null;
}[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is { kind: AttributionKind; amount?: unknown; note?: unknown } =>
        Boolean(x) && typeof x === 'object' && ATTRIBUTION_KINDS.has((x as { kind: string }).kind as AttributionKind),
      )
      .map((x) => ({
        kind: x.kind,
        amount: typeof x.amount === 'string' ? x.amount : null,
        note: typeof x.note === 'string' ? x.note : null,
      }));
  } catch {
    return [];
  }
}

export function previewReconcile(
  ctx: AppCtx,
  ledgerId: string,
  accountId: string,
  input: ReconcileInput,
) {
  const c = compute(ctx, ledgerId, accountId, input);
  return {
    accountId: c.accountId,
    accountName: c.accountName,
    reconcileDate: c.reconcileDate,
    systemBalance: formatCents(c.systemBalance),
    actualBalance: formatCents(c.actualBalance),
    diffAmount: formatCents(c.diffAmount),
    isBalanced: c.isBalanced,
    lastReconciledAt: c.lastReconciledAt,
    lastReconciledBalance:
      c.lastReconciledBalance === null ? null : formatCents(c.lastReconciledBalance),
    /** 口径变更披露（docs/14）：仅当该账户期初当天确有流水时为非 null */
    openingDayTx: c.openingDayTx
      ? { ...c.openingDayTx, delta: formatCents(c.openingDayTx.delta) }
      : null,
    boundaryPolicyChangedAt: BALANCE_BOUNDARY_CHANGE_DATE,
    suggestedReasons: suggestReasons(c.diffAmount),
    /**
     * 差异归因候选（R-02）。有差额时非空；账实相符时是空数组 ——
     * 「不需要归因」和「归因结果是空」是两件事，接口上必须能区分。
     */
    attributions: attributionsOf(ctx, ledgerId, accountId, c.diffAmount, c.reconcileDate),
  };
}

function assertReason(input: ReconcileInput): ReconcileReason | null {
  if (!input.reasonCode) return null;
  if (!(RECONCILE_REASONS as readonly string[]).includes(input.reasonCode)) {
    throw HttpError.validation([{ field: 'reasonCode', message: '差异原因码不合法' }]);
  }
  if (input.reasonCode === 'other' && !input.reasonNote?.trim()) {
    throw HttpError.validation([{ field: 'reasonNote', message: '选择「其他」时必须填写说明' }]);
  }
  return input.reasonCode;
}

export function submitReconcile(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  accountId: string,
  input: ReconcileInput,
) {
  const c = compute(ctx, ledgerId, accountId, input);
  const reasonCode = assertReason(input);
  const wantAdjustment = input.createAdjustment ?? true;

  if (!c.isBalanced && wantAdjustment && !reasonCode) {
    throw HttpError.validation([{ field: 'reasonCode', message: '存在差异时必须选择差异原因' }]);
  }

  const at = nowIso();

  const result = ctx.db.transaction((tx) => {
    let adjustmentTxId: string | null = null;
    let adjustmentTransaction: Record<string, unknown> | null = null;

    if (!c.isBalanced && wantAdjustment) {
      adjustmentTxId = newId(ID_PREFIX.transaction);
      const absDiff = Math.abs(c.diffAmount);
      tx.insert(transactions)
        .values({
          id: adjustmentTxId,
          ledgerId,
          recordType: 'adjustment',
          // 调增 / 调减 —— docs/12 §7.1 定案：方向由 direction 承载，account_delta 为算出来的结果
          direction: c.diffAmount > 0 ? 'increase' : 'decrease',
          accountId,
          toAccountId: null,
          categoryId: null,
          parentCategoryId: null,
          amount: absDiff,
          fee: 0,
          discount: 0,
          actualAmount: absDiff,
          // 符号由 Δ 承载（docs/03 §1.2）
          accountDelta: c.diffAmount,
          toAccountDelta: null,
          name: `余额调整 · ${c.accountName}`,
          note: input.reasonNote ?? null,
          txDate: c.reconcileDate,
          txTime: null,
          occurredAt: at,
          adjustmentReason: reasonCode,
          createdBy: actorId,
          updatedBy: actorId,
          createdAt: at,
          updatedAt: at,
        })
        .run();

      adjustmentTransaction = {
        id: adjustmentTxId,
        recordType: 'adjustment',
        amount: formatCents(absDiff),
        actualAmount: formatCents(absDiff),
        accountDelta: formatCents(c.diffAmount),
        adjustmentReason: reasonCode,
      };
    }

    const reconciliationId = newId(ID_PREFIX.reconciliation);
    tx.insert(reconciliationRecords)
      .values({
        id: reconciliationId,
        ledgerId,
        accountId,
        reconcileDate: c.reconcileDate,
        systemBalance: c.systemBalance,
        actualBalance: c.actualBalance,
        diffAmount: c.diffAmount,
        adjustmentTxId,
        reasonCode,
        reasonNote: input.reasonNote ?? null,
        /**
         * 归因按「元字符串 → 分」落库，与全站口径一致。
         * 金额为空的项也保留（那是一条「我认为与它无关但记下来了」的线索），
         * 但整组为空时存 `null` 而不是 `'[]'` —— 两者在复查时含义相同，
         * 存 `null` 让「未填归因」与「填了空数组」在库里可区分。
         */
        attributionJson: normalizeAttribution(input.attributions),
        operatorId: actorId,
        createdAt: at,
      })
      .run();

    tx.update(accounts)
      .set({
        lastReconciledAt: c.reconcileDate,
        lastReconciledBalance: c.actualBalance,
        ...(input.lockBeforeDate ? { lockedBeforeDate: c.reconcileDate } : {}),
        updatedAt: at,
      })
      .where(eq(accounts.id, accountId))
      .run();

    return {
      reconciliationId,
      accountId,
      accountName: c.accountName,
      reconcileDate: c.reconcileDate,
      systemBalance: formatCents(c.systemBalance),
      actualBalance: formatCents(c.actualBalance),
      diffAmount: formatCents(c.diffAmount),
      adjustmentTransaction,
      newBalance: formatCents(c.actualBalance),
      isBalanced: true,
      lockedBeforeDate: input.lockBeforeDate ? c.reconcileDate : null,
    };
  });

  // 审计日志写在事务之外：对账主流程已落库，审计失败不应回滚对账
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'reconcile',
    entityType: 'account',
    entityId: accountId,
    summary: c.isBalanced
      ? `对账「${c.accountName}」账实相符`
      : `对账「${c.accountName}」差异 ${formatCents(c.diffAmount)}，原因 ${reasonCode ?? '未生成调整单'}`,
  });

  return result;
}

export function listReconciliations(
  ctx: AppCtx,
  ledgerId: string,
  filter: { accountId?: string; dateFrom?: string; dateTo?: string; limit?: number } = {},
) {
  const conditions = [eq(reconciliationRecords.ledgerId, ledgerId)];
  if (filter.accountId) conditions.push(eq(reconciliationRecords.accountId, filter.accountId));
  if (filter.dateFrom) conditions.push(gte(reconciliationRecords.reconcileDate, filter.dateFrom));
  if (filter.dateTo) conditions.push(lte(reconciliationRecords.reconcileDate, filter.dateTo));

  const rows = ctx.db
    .select({
      id: reconciliationRecords.id,
      accountId: reconciliationRecords.accountId,
      accountName: accounts.name,
      reconcileDate: reconciliationRecords.reconcileDate,
      systemBalance: reconciliationRecords.systemBalance,
      actualBalance: reconciliationRecords.actualBalance,
      diffAmount: reconciliationRecords.diffAmount,
      adjustmentTxId: reconciliationRecords.adjustmentTxId,
      reasonCode: reconciliationRecords.reasonCode,
      reasonNote: reconciliationRecords.reasonNote,
      attributionJson: reconciliationRecords.attributionJson,
      operatorId: reconciliationRecords.operatorId,
      operatorNickname: users.nickname,
      createdAt: reconciliationRecords.createdAt,
    })
    .from(reconciliationRecords)
    .innerJoin(accounts, eq(accounts.id, reconciliationRecords.accountId))
    .innerJoin(users, eq(users.id, reconciliationRecords.operatorId))
    .where(and(...conditions))
    .orderBy(desc(reconciliationRecords.reconcileDate), desc(reconciliationRecords.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();

  return rows.map((r) => ({
    id: r.id,
    account: { id: r.accountId, name: r.accountName },
    reconcileDate: r.reconcileDate,
    systemBalance: formatCents(r.systemBalance),
    actualBalance: formatCents(r.actualBalance),
    diffAmount: formatCents(r.diffAmount),
    isBalanced: r.diffAmount === 0,
    reasonCode: r.reasonCode,
    reasonNote: r.reasonNote,
    /** 用户当时确认的归因结论（R-02），供复查「这笔差额后来怎么解释的」 */
    attributions: parseAttribution(r.attributionJson),
    adjustmentTransactionId: r.adjustmentTxId,
    operator: { id: r.operatorId, nickname: r.operatorNickname },
    createdAt: r.createdAt,
    /**
     * 该记录生成于口径变更日之前 → 它的 `systemBalance` 是**旧口径**算出来的
     * （建账当天的流水不计入），与变更后的记录**不可直接比较**（docs/14 步骤 3）。
     *
     * 判据用 `createdAt` 而非 `reconcileDate`：决定口径的是「什么时候算的」，
     * 不是「对的是哪一天」。一笔 6 月的对账若 7 月才录入，判据要看 7 月。
     */
    legacyBoundary: (r.createdAt ?? '').slice(0, 10) < BALANCE_BOUNDARY_CHANGE_DATE,
  }));
}

/** 账本健康度（docs/04 §12.4） */
export function reconciliationSummary(ctx: AppCtx, ledgerId: string) {
  /**
   * ⚠️ **只统计真实账户**（`kind !== 'virtual'`）。
   *
   * 虚拟账户（债权 / 债务 / 手续费）是**台账口径**，余额由债权债务三层
   * 推导得出（`docs/03 §1.3`），它压根不存在「银行 App 里的实际余额」这回事，
   * 永远不需要也不会被对账。
   *
   * 早先这里没过滤，后果是**新建账本的「对账健康度」开箱即错**：
   * 三个系统虚拟账户被算进 `totalAccounts`，于是显示「已对账账户 0/3」，
   * 并把它们列进 `unreconciledList` 让用户去「对账」——
   * 用户点进去发现这个账户压根没有对账入口（前端本来就过滤了虚拟账户）。
   * 一个新账本一打开就被告知有 3 个账户待办，是最坏的首次体验。
   */
  const accs = ctx.db
    .select({
      id: accounts.id,
      name: accounts.name,
      openingBalance: accounts.openingBalance,
      lastReconciledAt: accounts.lastReconciledAt,
      lastReconciledBalance: accounts.lastReconciledBalance,
      archivedAt: accounts.archivedAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.ledgerId, ledgerId),
        isNull(accounts.archivedAt),
        ne(accounts.kind, 'virtual'),
      ),
    )
    .all();

  const deltas = ledgerDeltas(ctx, ledgerId);
  const todayStr = today();

  let reconciledAccounts = 0;
  let accountsWithDiff = 0;
  const unreconciledList: {
    accountId: string;
    accountName: string;
    lastReconciledAt: string | null;
    daysSinceReconcile: number | null;
    currentDiff: string;
  }[] = [];

  const daysBetween = (from: string, to: string) =>
    Math.floor((Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86400000);

  for (const a of accs) {
    const balance = a.openingBalance + (deltas.get(a.id)?.delta ?? 0);
    const diff = a.lastReconciledBalance === null ? null : balance - a.lastReconciledBalance;
    if (a.lastReconciledAt) reconciledAccounts += 1;
    if (diff !== null && diff !== 0) accountsWithDiff += 1;

    const days = a.lastReconciledAt ? daysBetween(a.lastReconciledAt, todayStr) : null;
    if (days === null || days > 30 || (diff !== null && diff !== 0)) {
      unreconciledList.push({
        accountId: a.id,
        accountName: a.name,
        lastReconciledAt: a.lastReconciledAt,
        daysSinceReconcile: days,
        currentDiff: formatCents(diff ?? 0),
      });
    }
  }

  const since = new Date(Date.now() - 90 * 86400000);
  const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(
    since.getDate(),
  ).padStart(2, '0')}`;

  const agg = ctx.db
    .select({
      count: sql<number>`count(*)`,
      avgAbs: sql<number>`coalesce(avg(abs(${reconciliationRecords.diffAmount})), 0)`,
    })
    .from(reconciliationRecords)
    .where(
      and(
        eq(reconciliationRecords.ledgerId, ledgerId),
        gte(reconciliationRecords.reconcileDate, sinceStr),
      ),
    )
    .get();

  return {
    totalAccounts: accs.length,
    reconciledAccounts,
    accountsWithDiff,
    reconcileCount90d: Number(agg?.count ?? 0),
    avgAbsDiff: formatCents(Math.round(Number(agg?.avgAbs ?? 0))),
    unreconciledList,
  };
}
