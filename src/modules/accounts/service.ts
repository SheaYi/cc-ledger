/**
 * 账户与账户分组（docs/04 §五、docs/02 §四）。
 *
 * 要点：
 *   · 账户余额不可直接编辑 —— 只能由账单 / 对账调整单 / 软删除产生变化（docs/03 §2.3）；
 *   · 有账单引用的账户或分组只能归档，不能物理删除；
 *   · 3 个系统虚拟账户（债权/债务/手续费）受保护，不可删除、不可归档。
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { accountGroups, accounts, transactions } from '../../db/schema.js';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_META,
  type AccountKind,
  type AccountType,
} from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, parseAmountToCents, today } from '../../utils/money.js';
import { keywordCondition } from '../../utils/tx-filter.js';
import { writeAudit } from '../../utils/audit.js';
import { openDebts } from '../debts/service.js';
import { assertAccountNotInActivePlan } from '../installment/service.js';
import {
  BALANCE_MAX_DATE,
  composeBalance,
  ledgerDeltas,
  type BalanceDelta,
} from './balance.js';

const SYSTEM_TYPES: readonly string[] = ['receivable', 'payable', 'fee'];
const MAX_SORT = 100000;

/** 系统虚拟账户：账本预置，受保护 */
export function isSystemAccount(a: { isDefault: boolean; kind: string; type: string }): boolean {
  return a.isDefault && a.kind === 'virtual' && SYSTEM_TYPES.includes(a.type);
}

export interface GroupRow {
  id: string;
  name: string;
  kind: string;
  icon: string | null;
  sortOrder: number;
  isDefault: boolean;
  archivedAt: string | null;
}

function groupPayload(g: GroupRow, accountCount: number, totalBalance: number) {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    icon: g.icon,
    sortOrder: g.sortOrder,
    isDefault: g.isDefault,
    archivedAt: g.archivedAt,
    accountCount,
    totalBalance: formatCents(totalBalance),
  };
}

/* =====================================================================
 * 账户分组
 *
 * 分组是账本的「结构」，不是科目表：用户可自由增删改。约束只有两条：
 *   · 分组下还有账户时不能删除 —— 账户必须归属于某个分组（group_id NOT NULL）；
 *   · 账户已经归档、但历史账单仍引用它的分组，只能「停用」不能物理删除。
 * 停用即释放名字（idx_ag_ledger_name 是部分唯一索引），可随时恢复。
 * ===================================================================== */

export function listGroups(ctx: AppCtx, ledgerId: string, opts: { includeArchived?: boolean } = {}) {
  const where = [eq(accountGroups.ledgerId, ledgerId)];
  if (!opts.includeArchived) where.push(isNull(accountGroups.archivedAt));

  const groups = ctx.db
    .select({
      id: accountGroups.id,
      name: accountGroups.name,
      kind: accountGroups.kind,
      icon: accountGroups.icon,
      sortOrder: accountGroups.sortOrder,
      isDefault: accountGroups.isDefault,
      archivedAt: accountGroups.archivedAt,
    })
    .from(accountGroups)
    .where(and(...where))
    .orderBy(asc(accountGroups.sortOrder), asc(accountGroups.name))
    .all();

  const accs = ctx.db
    .select({
      id: accounts.id,
      groupId: accounts.groupId,
      openingBalance: accounts.openingBalance,
    })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), isNull(accounts.archivedAt)))
    .all();

  const deltas = ledgerDeltas(ctx, ledgerId, BALANCE_MAX_DATE);
  const byGroup = new Map<string, { count: number; total: number }>();
  for (const a of accs) {
    const bucket = byGroup.get(a.groupId) ?? { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += a.openingBalance + (deltas.get(a.id)?.delta ?? 0);
    byGroup.set(a.groupId, bucket);
  }

  return groups.map((g) => {
    const b = byGroup.get(g.id) ?? { count: 0, total: 0 };
    return groupPayload(g, b.count, b.total);
  });
}

/** 同名校验：只与「未停用」的分组比较（停用后名字可被新分组复用） */
function assertGroupNameFree(ctx: AppCtx, ledgerId: string, name: string, excludeId?: string) {
  const dup = ctx.db
    .select({ id: accountGroups.id })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.ledgerId, ledgerId),
        eq(accountGroups.name, name),
        isNull(accountGroups.archivedAt),
        excludeId ? sql`${accountGroups.id} <> ${excludeId}` : undefined,
      ),
    )
    .get();
  if (dup) throw HttpError.duplicate('同名账户分组已存在');
}

export function createGroup(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: { name: string; kind: AccountKind; icon?: string | null },
) {
  assertGroupNameFree(ctx, ledgerId, input.name);

  const maxRow = ctx.db
    .select({ m: sql<number>`coalesce(max(${accountGroups.sortOrder}), 0)` })
    .from(accountGroups)
    .where(eq(accountGroups.ledgerId, ledgerId))
    .get();

  const id = newId(ID_PREFIX.accountGroup);
  ctx.db
    .insert(accountGroups)
    .values({
      id,
      ledgerId,
      name: input.name,
      kind: input.kind,
      icon: input.icon ?? null,
      sortOrder: Number(maxRow?.m ?? 0) + 1,
      isDefault: false,
      createdAt: nowIso(),
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'account_group',
    entityId: id,
    summary: `创建账户分组「${input.name}」`,
  });
  return listGroups(ctx, ledgerId).find((g) => g.id === id)!;
}

function requireGroup(ctx: AppCtx, ledgerId: string, groupId: string): GroupRow {
  const g = ctx.db
    .select({
      id: accountGroups.id,
      name: accountGroups.name,
      kind: accountGroups.kind,
      icon: accountGroups.icon,
      sortOrder: accountGroups.sortOrder,
      isDefault: accountGroups.isDefault,
      archivedAt: accountGroups.archivedAt,
    })
    .from(accountGroups)
    .where(and(eq(accountGroups.id, groupId), eq(accountGroups.ledgerId, ledgerId)))
    .get();
  if (!g) throw HttpError.notFound('账户分组不存在');
  return g;
}

export function updateGroup(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  groupId: string,
  input: { name?: string; kind?: AccountKind; icon?: string | null },
) {
  const g = requireGroup(ctx, ledgerId, groupId);

  if (input.name && input.name !== g.name) {
    assertGroupNameFree(ctx, ledgerId, input.name, groupId);
  }

  ctx.db
    .update(accountGroups)
    .set({
      name: input.name ?? g.name,
      kind: input.kind ?? g.kind,
      icon: input.icon === undefined ? g.icon : input.icon,
    })
    .where(eq(accountGroups.id, groupId))
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'account_group',
    entityId: groupId,
    summary: `更新账户分组「${input.name ?? g.name}」`,
    before: g,
    after: input,
  });
  return requireGroup(ctx, ledgerId, groupId);
}

/**
 * 删除分组。
 *   有活跃账户        → 400（账户必须归属分组，先移出或归档）
 *   仅有已归档账户    → 停用（历史账单的分组归属需要保留）
 *   完全没有账户      → 物理删除（不留幽灵行，名字即刻可用）
 */
export function deleteGroup(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  groupId: string,
): { mode: 'removed' | 'archived'; accountCount: number } {
  const g = requireGroup(ctx, ledgerId, groupId);

  const active = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(accounts)
    .where(and(eq(accounts.groupId, groupId), isNull(accounts.archivedAt)))
    .get();
  const total = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(accounts)
    .where(eq(accounts.groupId, groupId))
    .get();

  const activeCount = Number(active?.c ?? 0);
  const totalCount = Number(total?.c ?? 0);

  if (activeCount > 0) {
    throw HttpError.business(
      `该分组下还有 ${activeCount} 个账户，请先移出或归档账户再删除分组`,
    );
  }

  const mode: 'removed' | 'archived' = totalCount === 0 ? 'removed' : 'archived';
  if (mode === 'removed') {
    ctx.db.delete(accountGroups).where(eq(accountGroups.id, groupId)).run();
  } else {
    ctx.db
      .update(accountGroups)
      .set({ archivedAt: nowIso() })
      .where(eq(accountGroups.id, groupId))
      .run();
  }

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'account_group',
    entityId: groupId,
    summary:
      mode === 'removed'
        ? `删除账户分组「${g.name}」`
        : `停用账户分组「${g.name}」（保留 ${totalCount} 个已归档账户的归属）`,
    before: g,
  });
  return { mode, accountCount: totalCount };
}

/** 恢复停用分组。若同名活跃分组已存在则拒绝（避免歧义），提示先改名。 */
export function restoreGroup(ctx: AppCtx, actorId: string, ledgerId: string, groupId: string) {
  const g = requireGroup(ctx, ledgerId, groupId);
  if (!g.archivedAt) {
    const b = ctx.db
      .select({ c: sql<number>`count(*)` })
      .from(accounts)
      .where(and(eq(accounts.groupId, groupId), isNull(accounts.archivedAt)))
      .get();
    return groupPayload(g, Number(b?.c ?? 0), 0);
  }

  const conflict = ctx.db
    .select({ id: accountGroups.id })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.ledgerId, ledgerId),
        eq(accountGroups.name, g.name),
        isNull(accountGroups.archivedAt),
      ),
    )
    .get();
  if (conflict) throw HttpError.duplicate(`已存在同名分组「${g.name}」，无法恢复；请先删除或改名同名分组`);

  ctx.db.update(accountGroups).set({ archivedAt: null }).where(eq(accountGroups.id, groupId)).run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'account_group',
    entityId: groupId,
    summary: `恢复账户分组「${g.name}」`,
  });
  return listGroups(ctx, ledgerId).find((x) => x.id === groupId)!;
}

export function reorderGroups(ctx: AppCtx, ledgerId: string, ids: string[]): void {
  const all = ctx.db
    .select({ id: accountGroups.id })
    .from(accountGroups)
    .where(eq(accountGroups.ledgerId, ledgerId))
    .all();
  const owned = new Set(all.map((r) => r.id));
  if (ids.some((id) => !owned.has(id))) throw HttpError.notFound('账户分组不存在');

  ctx.db.transaction((tx) => {
    ids.slice(0, MAX_SORT).forEach((id, index) => {
      tx.update(accountGroups).set({ sortOrder: index + 1 }).where(eq(accountGroups.id, id)).run();
    });
  });
}

/* =====================================================================
 * 账户
 * ===================================================================== */

export interface AccountRow {
  id: string;
  ledgerId: string;
  groupId: string;
  name: string;
  type: string;
  kind: string;
  openingBalance: number;
  openingDate: string;
  creditLimit: number | null;
  billingDay: number | null;
  dueDay: number | null;
  includeInTotal: boolean;
  icon: string | null;
  note: string | null;
  sortOrder: number;
  isDefault: boolean;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
  lockedBeforeDate: string | null;
  archivedAt: string | null;
}

const ACCOUNT_COLUMNS = {
  id: accounts.id,
  ledgerId: accounts.ledgerId,
  groupId: accounts.groupId,
  name: accounts.name,
  type: accounts.type,
  kind: accounts.kind,
  openingBalance: accounts.openingBalance,
  openingDate: accounts.openingDate,
  creditLimit: accounts.creditLimit,
  billingDay: accounts.billingDay,
  dueDay: accounts.dueDay,
  includeInTotal: accounts.includeInTotal,
  icon: accounts.icon,
  note: accounts.note,
  sortOrder: accounts.sortOrder,
  isDefault: accounts.isDefault,
  lastReconciledAt: accounts.lastReconciledAt,
  lastReconciledBalance: accounts.lastReconciledBalance,
  lockedBeforeDate: accounts.lockedBeforeDate,
  archivedAt: accounts.archivedAt,
} as const;

export function accountPayload(
  a: AccountRow,
  extra: { groupName?: string | null; delta?: BalanceDelta; asOf?: string } = {},
) {
  const delta = extra.delta ?? { delta: 0, inflow: 0, outflow: 0 };
  const asOf = extra.asOf ?? BALANCE_MAX_DATE;
  const composed = composeBalance(a.id, a.openingBalance, delta, asOf);
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    kind: a.kind,
    groupId: a.groupId,
    groupName: extra.groupName ?? null,
    openingBalance: formatCents(a.openingBalance),
    openingDate: a.openingDate,
    inflow: formatCents(composed.inflow),
    outflow: formatCents(composed.outflow),
    balance: formatCents(composed.balance),
    balanceAsOf: asOf === BALANCE_MAX_DATE ? nowIso() : asOf,
    creditLimit: a.creditLimit === null ? null : formatCents(a.creditLimit),
    billingDay: a.billingDay,
    dueDay: a.dueDay,
    includeInTotal: a.includeInTotal,
    icon: a.icon,
    note: a.note,
    sortOrder: a.sortOrder,
    isDefault: a.isDefault,
    isSystem: isSystemAccount(a),
    archivedAt: a.archivedAt,
    lastReconciledAt: a.lastReconciledAt,
    lastReconciledBalance:
      a.lastReconciledBalance === null ? null : formatCents(a.lastReconciledBalance),
    lockedBeforeDate: a.lockedBeforeDate,
    unreconciledDiff:
      a.lastReconciledBalance === null
        ? null
        : formatCents(composed.balance - a.lastReconciledBalance),
  };
}

export function findAccount(ctx: AppCtx, ledgerId: string, accountId: string): AccountRow {
  const row = ctx.db
    .select(ACCOUNT_COLUMNS)
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('账户不存在');
  return row as AccountRow;
}

export function listAccounts(
  ctx: AppCtx,
  ledgerId: string,
  filter: { groupId?: string; kind?: string; includeArchived?: boolean } = {},
) {
  const conditions = [eq(accounts.ledgerId, ledgerId)];
  if (filter.groupId) conditions.push(eq(accounts.groupId, filter.groupId));
  if (filter.kind) conditions.push(eq(accounts.kind, filter.kind));
  if (!filter.includeArchived) conditions.push(isNull(accounts.archivedAt));

  const rows = ctx.db
    .select(ACCOUNT_COLUMNS)
    .from(accounts)
    .where(and(...conditions))
    .orderBy(asc(accounts.sortOrder), asc(accounts.name))
    .all() as AccountRow[];

  const groups = ctx.db
    .select({ id: accountGroups.id, name: accountGroups.name })
    .from(accountGroups)
    .where(eq(accountGroups.ledgerId, ledgerId))
    .all();
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));

  const deltas = ledgerDeltas(ctx, ledgerId, BALANCE_MAX_DATE);
  return rows.map((a) =>
    accountPayload(a, { groupName: groupNames.get(a.groupId) ?? null, delta: deltas.get(a.id) }),
  );
}

/** 各账户余额（整数分）汇总。净资产 = 资产 − 负债，虚拟账户不计入。 */
export function totals(
  ctx: AppCtx,
  ledgerId: string,
  /** 余额截止日；不传则取「当下」（全量），用于净资产月末快照按日期定格 */
  asOf: string = BALANCE_MAX_DATE,
): { assetTotal: number; liabilityTotal: number; netWorth: number } {
  const rows = ctx.db
    .select(ACCOUNT_COLUMNS)
    .from(accounts)
    .where(
      and(
        eq(accounts.ledgerId, ledgerId),
        isNull(accounts.archivedAt),
        eq(accounts.includeInTotal, true),
      ),
    )
    .all() as AccountRow[];

  const deltas = ledgerDeltas(ctx, ledgerId, asOf);
  let assetTotal = 0;
  let liabilityTotal = 0;
  for (const a of rows) {
    if (a.kind === 'virtual') continue;
    /**
     * ⚠️ 账户在某日期**尚未开户**（`opening_date > asOf`）时，该时点余额必须为 0。
     * 期初余额是「开户日那一刻的存量」，不能倒挂到开户之前 —— 否则一个 2026 年才
     * 开户、期初余额 5 万的账户，会被算进 2025 年末的净资产快照，画出一条
     * 「2025 年明明没有账目、却凭空出现 5 万」的曲线。
     * 不传 asOf（当下全量）时 `asOf = BALANCE_MAX_DATE`，恒 ≥ 任何开户日，行为不变。
     */
    if (asOf < a.openingDate) continue;
    const balance = a.openingBalance + (deltas.get(a.id)?.delta ?? 0);
    if (a.kind === 'liability') liabilityTotal += balance;
    else assetTotal += balance;
  }
  return { assetTotal, liabilityTotal, netWorth: assetTotal - liabilityTotal };
}

/** 净资产 = Σ(资产账户余额) − Σ(负债账户余额)，仅计 include_in_total */
export function netWorth(ctx: AppCtx, ledgerId: string): number {
  return totals(ctx, ledgerId).netWorth;
}

/**
 * 区间收支（对齐 docs/03 §1.5 净结余口径）：
 *   净结余 = Σ income.actual − Σ expense.actual
 * 转账 / 应收 / 应付 / 余额调整一律不计入；手续费已内含在 actual 中，不重复扣减。
 */
/**
 * 冲减项（红字冲销 / 退款）的判定式。
 *
 * ⚠️ 统计口径必须**减去**冲减项，否则退款会被算成又一笔支出：
 * 支出 210 后退款 210，真实净支出是 0，而 `SUM(actual_amount)` 会得 420。
 * 这是「退款记成收入」之外的第二个坑 —— 用冲减表达虽不虚增收入，
 * 但若不显式相减，支出侧照样翻倍。
 */
const CONTRA_CASE = sql<number>`case when ${transactions.adjustmentReason} in ('reversal','refund') then 1 else 0 end`;

export function periodFlow(
  ctx: AppCtx,
  ledgerId: string,
  from: string,
  to: string,
  /**
   * 关键字（可选）：命中 `name / merchant / counterparty / note` 任一即算。
   *
   * 不传 = 不过滤，行为与加这个参数之前**完全一致** ——
   * 概览页等既有调用方一律不传，所以口径没有被改动，
   * 只是多了一条统计页需要的筛选路径。
   */
  keyword?: string,
) {
  /** 空值必须返回 undefined，不能退化成「不加条件」之外的任何东西 */
  const kwCond = keywordCondition(keyword);
  const rows = ctx.db
    .select({
      recordType: transactions.recordType,
      contra: CONTRA_CASE,
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
        ...(kwCond ? [kwCond] : []),
      ),
    )
    .groupBy(transactions.recordType, CONTRA_CASE)
    .all();

  /** 某类型的净额 = Σ正常 − Σ冲减 */
  const netOf = (type: string) => {
    let normal = 0;
    let contra = 0;
    for (const r of rows) {
      if (r.recordType !== type) continue;
      const v = Number(r.total ?? 0);
      if (Number(r.contra) === 1) contra += v;
      else normal += v;
    }
    return normal - contra;
  };
  const income = netOf('income');
  const expense = netOf('expense');
  const txCount = rows.reduce((n, r) => n + Number(r.cnt ?? 0), 0);

  return {
    dateFrom: from,
    dateTo: to,
    income,
    expense,
    net: income - expense,
    txCount,
    /** 便于前端展示"本月共 N 笔"的明细分布 */
    /**
     * ⚠️ 按类型**合并**后再输出。
     * 分组键多了 `contra` 一列，同一类型可能出两行；直接 map 出去会让
     * 「支出」在 `byType` 里出现两次，消费方（前端「本月共 N 笔」的明细分布）
     * 就会画成两条。这里统一按净额与合计笔数合并。
     */
    byType: [...new Set(rows.map((r) => r.recordType))].map((t) => ({
      recordType: t,
      total: netOf(t),
      count: rows.filter((r) => r.recordType === t).reduce((n, r) => n + Number(r.cnt ?? 0), 0),
    })),
  };
}

export interface CreateAccountInput {
  groupId: string;
  name: string;
  type: AccountType;
  openingBalance?: string | number;
  openingDate?: string;
  creditLimit?: string | number | null;
  billingDay?: number | null;
  dueDay?: number | null;
  includeInTotal?: boolean;
  icon?: string | null;
  note?: string | null;
}

export function createAccount(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: CreateAccountInput,
) {
  requireGroup(ctx, ledgerId, input.groupId);

  const dup = ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), eq(accounts.name, input.name)))
    .get();
  if (dup) throw HttpError.duplicate('同名账户已存在');

  const meta = ACCOUNT_TYPE_META[input.type];
  const isCredit = input.type === 'credit_card';

  const maxRow = ctx.db
    .select({ m: sql<number>`coalesce(max(${accounts.sortOrder}), 0)` })
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .get();

  const at = nowIso();
  const id = newId(ID_PREFIX.account);
  ctx.db
    .insert(accounts)
    .values({
      id,
      ledgerId,
      groupId: input.groupId,
      name: input.name,
      type: input.type,
      kind: meta.kind,
      openingBalance: input.openingBalance === undefined ? 0 : parseAmountToCents(input.openingBalance),
      openingDate: input.openingDate ?? today(),
      creditLimit:
        isCredit && input.creditLimit !== undefined && input.creditLimit !== null
          ? parseAmountToCents(input.creditLimit)
          : null,
      billingDay: isCredit ? (input.billingDay ?? null) : null,
      dueDay: isCredit ? (input.dueDay ?? null) : null,
      includeInTotal: input.includeInTotal ?? true,
      icon: input.icon ?? null,
      note: input.note ?? null,
      sortOrder: Number(maxRow?.m ?? 0) + 1,
      isDefault: false,
      createdBy: actorId,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'account',
    entityId: id,
    summary: `创建账户「${input.name}」`,
  });
  return accountPayload(findAccount(ctx, ledgerId, id));
}

export interface UpdateAccountInput {
  name?: string;
  groupId?: string;
  icon?: string | null;
  note?: string | null;
  includeInTotal?: boolean;
  creditLimit?: string | number | null;
  billingDay?: number | null;
  dueDay?: number | null;
}

/**
 * 更新账户。
 * 注意：openingBalance / openingDate 不在此处修改 —— 余额变动必须走账单或对账
 * （docs/03 §2.3），期初的修正由「余额重算 + 对账调整单」完成。
 */
export function updateAccount(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  accountId: string,
  input: UpdateAccountInput,
) {
  const current = findAccount(ctx, ledgerId, accountId);
  if (input.groupId && input.groupId !== current.groupId) {
    requireGroup(ctx, ledgerId, input.groupId);
  }
  if (input.name && input.name !== current.name) {
    const dup = ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.ledgerId, ledgerId),
          eq(accounts.name, input.name),
          sql`${accounts.id} <> ${accountId}`,
        ),
      )
      .get();
    if (dup) throw HttpError.duplicate('同名账户已存在');
  }

  const isCredit = current.type === 'credit_card';
  const patch: Record<string, unknown> = { updatedAt: nowIso() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.groupId !== undefined) patch.groupId = input.groupId;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.note !== undefined) patch.note = input.note;
  if (input.includeInTotal !== undefined) patch.includeInTotal = input.includeInTotal;
  if (isCredit) {
    if (input.creditLimit !== undefined) {
      patch.creditLimit =
        input.creditLimit === null ? null : parseAmountToCents(input.creditLimit);
    }
    if (input.billingDay !== undefined) patch.billingDay = input.billingDay;
    if (input.dueDay !== undefined) patch.dueDay = input.dueDay;
  }

  ctx.db.update(accounts).set(patch).where(eq(accounts.id, accountId)).run();

  const fresh = findAccount(ctx, ledgerId, accountId);
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'account',
    entityId: accountId,
    summary: `更新账户「${fresh.name}」`,
    before: { name: current.name, groupId: current.groupId, note: current.note },
    after: input,
  });
  return accountPayload(fresh);
}

/** 软删除（归档）。有账单引用时禁止物理删除；系统虚拟账户受保护 */
export function archiveAccount(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  accountId: string,
): { archived: true; txCount: number } {
  const acc = findAccount(ctx, ledgerId, accountId);
  if (isSystemAccount(acc)) throw HttpError.business('系统虚拟账户不可归档');

  /**
   * 进行中的分期里用到这个账户 → 拒绝归档（`docs/05 §12.8`）。
   *
   * 不是「礼貌性提醒」：分期是**未来会持续生成转账**的计划，
   * 而每期还款前都会跑一遍 validate —— 账户一旦归档，那条规则就永远 400，
   * 而用户只在服务端日志里看得到。宁可在归档这一步拦住。
   */
  assertAccountNotInActivePlan(ctx, ledgerId, accountId);

  /**
   * 有**未收回的应收** → 拒绝归档（`docs/05 §2.5`）。
   *
   * 「未收回」的判定直接复用 `debts` 模块的 `openDebts()`：它已经算好了
   * 每一笔的 `outstanding = amount − Σ已结算`，且**含核销**。
   * 这里只取「主账户是本账户、且 outstanding > 0」的那些。
   *
   * ⚠️ 为什么要拦：结清应收时钱要回到**某个账户**。本账户被归档后，
   * 结算路径上会要求账户可用 → 那一笔就永远停在「未结清」，
   * 而债权台账的金额还在 —— 台账与逐笔明细从此对不上（`docs/03 §1.3` 的恒等式破）。
   *
   * 反过来，**历史已结清的应收不拦**：归档账户仍参与余额计算（§2.4），
   * 历史统计完全保留（§2.3），不归档也毫无必要。
   */
  const openRecv = openDebts(ctx, ledgerId, { status: 'open' }).items.filter(
    (i) => i.recordType === 'receivable' && i.account?.id === accountId && Number(i.outstanding) > 0,
  );
  if (openRecv.length) {
    throw HttpError.business(
      `该账户有 ${openRecv.length} 笔未收回的应收款项，收回或核销后才能归档`,
    );
  }

  const used = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        sql`(${transactions.accountId} = ${accountId} OR ${transactions.toAccountId} = ${accountId})`,
      ),
    )
    .get();
  const txCount = Number(used?.c ?? 0);

  ctx.db
    .update(accounts)
    .set({ archivedAt: nowIso(), updatedAt: nowIso() })
    .where(eq(accounts.id, accountId))
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'account',
    entityId: accountId,
    summary: `归档账户「${acc.name}」${txCount > 0 ? `（含 ${txCount} 笔历史账单，保留痕迹）` : ''}`,
    before: acc,
  });
  return { archived: true, txCount };
}

export function reorderAccounts(ctx: AppCtx, ledgerId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const owned = ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), inArray(accounts.id, ids)))
    .all();
  if (owned.length !== new Set(ids).size) throw HttpError.notFound('账户不存在');

  ctx.db.transaction((tx) => {
    ids.slice(0, MAX_SORT).forEach((id, index) => {
      tx.update(accounts).set({ sortOrder: index + 1 }).where(eq(accounts.id, id)).run();
    });
  });
}

/** 账户余额重算（docs/04 §5.3） */
export function balanceView(ctx: AppCtx, ledgerId: string, accountId: string, asOf?: string) {
  const acc = findAccount(ctx, ledgerId, accountId);
  const date = asOf ?? BALANCE_MAX_DATE;
  const delta = ledgerDeltas(ctx, ledgerId, date).get(accountId) ?? {
    delta: 0,
    inflow: 0,
    outflow: 0,
  };
  const composed = composeBalance(accountId, acc.openingBalance, delta, date);
  return {
    accountId,
    accountName: acc.name,
    asOf: date === BALANCE_MAX_DATE ? today() : date,
    openingBalance: formatCents(composed.openingBalance),
    inflow: formatCents(composed.inflow),
    outflow: formatCents(composed.outflow),
    balance: formatCents(composed.balance),
  };
}

/** 校验账户类型合法 */
export function assertAccountType(type: string): asserts type is AccountType {
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
    throw HttpError.validation([{ field: 'type', message: '账户类型不合法' }]);
  }
}
