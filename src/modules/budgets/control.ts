/**
 * 预算执行控制 / 预警中心 / 调整动作（docs/16 §5 §6 §8）。
 *
 * 与 service.ts 的分工：service.ts 只负责「已用 U 的账务口径」，
 * 这里负责它之外的额度构成、承诺占用、预警判定与写操作留痕。
 * 任何金额都复用 formatCents / toCents，不自己拼元分。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accounts as accountsTable,
  budgetChanges,
  budgetReservations,
  budgetSnapshots,
  budgetTransfers,
  budgets,
  categories,
  ledgerMembers,
  tags,
  transactions,
  users,
} from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, today as todayStr } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { getPrefs, DEFAULT_ALERT_TIERS, recordChange, periodRange, type BudgetPrefsDto } from './advanced.js';
import { budgetProgress, type BudgetProgressDto, type SpentDim } from './service.js';

const cents = (v: string | number) => (typeof v === 'number' ? Math.trunc(v) : Math.round(Number(v) * 100));

/**
 * 归档快照：budgetId → 归档当时的 B / U（分）。
 *
 * 归档期回看必须用它锁定历史事实，否则用户之后改了预算额或补记了上月账单，
 * 执行率、差异额、年度趋势都会跟着今天的编辑悄悄变样（docs/16 §8）。
 */
export function snapshotAmounts(ctx: AppCtx, ledgerId: string, periodKey: string) {
  const rows = ctx.db
    .select({ budgetId: budgetSnapshots.budgetId, amount: budgetSnapshots.amount, actual: budgetSnapshots.actual })
    .from(budgetSnapshots)
    .where(and(eq(budgetSnapshots.ledgerId, ledgerId), eq(budgetSnapshots.periodKey, periodKey)))
    .all();
  const map = new Map<string, { budget: number; actual: number }>();
  for (const r of rows) {
    if (r.budgetId) map.set(r.budgetId, { budget: r.amount, actual: r.actual });
  }
  return map;
}

/* ===================================================================== *
 * 五元组：预算额 B / 已用 U / 承诺占用 C / 预留 R / 可用额度 A
 * ===================================================================== */

export interface ControlRowDto {
  budgetId: string;
  label: string;
  budgetKind: string;
  /** B：基础额 + 净调拨 + 追加削减 + 结转 */
  budgetAmount: string;
  baseAmount: string;
  transferNet: string;
  adjustmentNet: string;
  /** U / C / R / A（元字符串） */
  used: string;
  committed: string;
  reserved: string;
  available: string;
  usedRatio: string | null;
  over: boolean;
  /** 承诺/预留逐条明细，供抽屉查看 */
  reservations: {
    id: string;
    kind: string;
    status: string;
    amount: string;
    expectedOn: string | null;
    source: string;
    note: string | null;
  }[];
}

export interface ControlDto {
  year: number;
  month: number;
  /** 该账期是否已归档：归档后 B/U 锁定为快照值，前端应显示为只读 */
  archived: boolean;
  dimension: { key: string; id: string | null };
  totals: {
    budgetAmount: string;
    used: string;
    committed: string;
    reserved: string;
    available: string;
    usedRatio: string | null;
  };
  rows: ControlRowDto[];
}

/** 汇总一条预算的净调拨（转入 − 转出） */
function transferNetOf(ctx: AppCtx, ledgerId: string, categoryId: string | null, year: number, month: number): number {
  if (!categoryId) return 0;
  const rows = ctx.db
    .select({ from: budgetTransfers.fromCategoryId, to: budgetTransfers.toCategoryId, amount: budgetTransfers.amount })
    .from(budgetTransfers)
    .where(and(eq(budgetTransfers.ledgerId, ledgerId), eq(budgetTransfers.year, year), eq(budgetTransfers.month, month)))
    .all();
  return rows.reduce((a, t) => a + (t.to === categoryId ? t.amount : 0) - (t.from === categoryId ? t.amount : 0), 0);
}

/** 汇总通过 /budgets/:id/adjust 写入的追加削减净额 */
function adjustmentNetOf(ctx: AppCtx, ledgerId: string, budgetId: string): number {
  const rows = ctx.db
    .select({ afterJson: budgetChanges.afterJson })
    .from(budgetChanges)
    .where(and(eq(budgetChanges.ledgerId, ledgerId), eq(budgetChanges.budgetId, budgetId), eq(budgetChanges.action, 'adjust')))
    .all();
  let net = 0;
  for (const r of rows) {
    try {
      const v = r.afterJson ? (JSON.parse(r.afterJson) as { delta?: number }) : null;
      if (v && Number.isFinite(v.delta)) net += Number(v.delta);
    } catch {
      /* 坏 JSON 不让整页失败 */
    }
  }
  return net;
}

/**
 * 额度控制视图。
 *
 * ⚠️ 「可用额度」不是「剩余」：还要扣掉**尚未落成账单的确定支出义务**（C）
 * 与**专项池预提/手工预留**（R）。用户真正能自由花的是 A = B − U − C − R。
 * 承诺兑现（生成账单/还款）后应调用 releaseReservation，避免 C 与 U 双计。
 */
export function budgetControl(
  ctx: AppCtx,
  ledgerId: string,
  year: number,
  month: number,
  dimension: { key: string; id: string | null } = { key: 'ledger', id: null },
): ControlDto {
  const dim: SpentDim = {};
  if (dimension.id) {
    if (dimension.key === 'account') dim.accountId = dimension.id;
    else if (dimension.key === 'member') dim.memberId = dimension.id;
    else if (dimension.key === 'tag') dim.tagId = dimension.id;
  }
  const p = periodRange('monthly', year, month);
  /** 归档期仍要能回看：带 includeArchived，并用快照锁定 B/U */
  const rows = budgetProgress(ctx, ledgerId, year, month, dim, { includeArchived: true });
  const snap = snapshotAmounts(ctx, ledgerId, p.key);
  const from = p.start!;
  const to = p.end!;
  const today = todayStr();

  /** 承诺占用只算「预计兑现日落在剩余账期且未释放」的；没填日期的按仍占用处理 */
  const resRows = ctx.db
    .select()
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.ledgerId, ledgerId),
        eq(budgetReservations.status, 'held'),
        sql`(${budgetReservations.expectedOn} is null or (${budgetReservations.expectedOn} >= ${today} and ${budgetReservations.expectedOn} <= ${to}))`,
      ),
    )
    .all();

  const outRows: ControlRowDto[] = rows.map((r) => {
    const base = cents(r.amount);
    const tn = transferNetOf(ctx, ledgerId, r.categoryId, year, month);
    const an = adjustmentNetOf(ctx, ledgerId, r.id);
    const hist = snap.get(r.id);
    /** 已归档行：B/U 取快照，不再叠加今天的调拨/追加，也不重算账单 */
    const B = hist ? hist.budget : base + tn + an;
    const U = hist ? hist.actual : cents(r.spentAmount);
    /** 维度切换时 C/R 是账本级的，不重复挂到每一行；只在总预算行汇总 */
    const mine = resRows.filter((x) => x.budgetId === r.id || (!x.budgetId && r.categoryId === null));
    const C = mine.filter((x) => x.kind === 'committed').reduce((a, x) => a + x.amount, 0);
    const R = mine.filter((x) => x.kind === 'reserved').reduce((a, x) => a + x.amount, 0);
    return {
      budgetId: r.id,
      label: r.categoryName ?? r.projectLabel ?? '总预算',
      budgetKind: r.budgetKind,
      budgetAmount: formatCents(B),
      baseAmount: formatCents(base),
      transferNet: formatCents(tn),
      adjustmentNet: formatCents(an),
      used: formatCents(U),
      committed: formatCents(C),
      reserved: formatCents(R),
      available: formatCents(B - U - C - R),
      usedRatio: B > 0 ? ((U / B) * 100).toFixed(1) : null,
      over: r.budgetKind === 'expense' && B > 0 && U > B,
      reservations: mine.map((x) => ({
        id: x.id,
        kind: x.kind,
        status: x.status,
        amount: formatCents(x.amount),
        expectedOn: x.expectedOn,
        source: x.source,
        note: x.note,
      })),
    };
  });

  /** 总额用「总预算那一行」或逐行求和，避免把分类预算与总预算重复相加 */
  const totalRow = outRows.find((r) => r.budgetKind === 'expense' && rows.find((p) => p.id === r.budgetId)?.categoryId === null);
  const sum = (key: 'budgetAmount' | 'used' | 'committed' | 'reserved' | 'available') =>
    totalRow ? cents(totalRow[key]) : outRows.reduce((a, r) => a + cents(r[key]), 0);
  const B = sum('budgetAmount');
  const U = sum('used');
  return {
    year,
    month,
    archived: snap.size > 0,
    dimension,
    totals: {
      budgetAmount: formatCents(B),
      used: formatCents(U),
      committed: formatCents(sum('committed')),
      reserved: formatCents(sum('reserved')),
      available: formatCents(sum('available')),
      usedRatio: B > 0 ? ((U / B) * 100).toFixed(1) : null,
    },
    rows: outRows,
  };
}

/* ===================================================================== *
 * 承诺占用 / 预留
 * ===================================================================== */

export interface ReservationDto {
  id: string;
  budgetId: string | null;
  categoryId: string | null;
  kind: string;
  status: string;
  amount: string;
  expectedOn: string | null;
  source: string;
  note: string | null;
  createdAt: string;
}

export function listReservations(ctx: AppCtx, ledgerId: string, year: number, month: number): ReservationDto[] {
  const p = periodRange('monthly', year, month);
  const map = (r: typeof budgetReservations.$inferSelect): ReservationDto => ({
    id: r.id,
    budgetId: r.budgetId,
    categoryId: r.categoryId,
    kind: r.kind,
    status: r.status,
    amount: formatCents(r.amount),
    expectedOn: r.expectedOn,
    source: r.source,
    note: r.note,
    createdAt: r.createdAt,
  });
  const rows = ctx.db
    .select()
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.ledgerId, ledgerId),
        sql`(${budgetReservations.expectedOn} is null or (${budgetReservations.expectedOn} >= ${p.start} and ${budgetReservations.expectedOn} <= ${p.end}))`,
      ),
    )
    .orderBy(desc(budgetReservations.createdAt))
    .all();
  return rows.map(map);
}

export function createReservation(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: { kind: string; amount: string | number; budgetId?: string | null; categoryId?: string | null; expectedOn?: string | null; note?: string | null },
): ReservationDto {
  const amount = cents(input.amount);
  if (amount <= 0) throw HttpError.validation([{ field: 'amount', message: '占用金额必须大于 0' }]);
  if (!['committed', 'reserved'].includes(input.kind)) {
    throw HttpError.validation([{ field: 'kind', message: '类型只支持 committed / reserved' }]);
  }
  if (input.expectedOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedOn)) {
    throw HttpError.validation([{ field: 'expectedOn', message: '日期格式应为 YYYY-MM-DD' }]);
  }
  const id = newId(ID_PREFIX.budget);
  const at = nowIso();
  ctx.db.insert(budgetReservations).values({
    id,
    ledgerId,
    budgetId: input.budgetId ?? null,
    categoryId: input.categoryId ?? null,
    kind: input.kind,
    status: 'held',
    amount,
    expectedOn: input.expectedOn ?? null,
    source: 'manual',
    note: input.note?.trim() || null,
    createdBy: actorId,
    createdAt: at,
  }).run();
  recordChange(ctx, ledgerId, actorId, {
    budgetId: input.budgetId ?? null,
    action: 'reservation_add',
    after: { kind: input.kind, amount },
    note: input.note ?? null,
  });
  return {
    id, budgetId: input.budgetId ?? null, categoryId: input.categoryId ?? null,
    kind: input.kind, status: 'held', amount: formatCents(amount),
    expectedOn: input.expectedOn ?? null, source: 'manual', note: input.note?.trim() || null, createdAt: at,
  };
}

export function releaseReservation(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const row = ctx.db.select().from(budgetReservations)
    .where(and(eq(budgetReservations.ledgerId, ledgerId), eq(budgetReservations.id, id))).get();
  if (!row) throw HttpError.notFound('占用记录不存在');
  if (row.status === 'released') return { id };
  ctx.db.update(budgetReservations)
    .set({ status: 'released', releasedAt: nowIso() })
    .where(eq(budgetReservations.id, id)).run();
  recordChange(ctx, ledgerId, actorId, {
    budgetId: row.budgetId, action: 'reservation_release',
    before: { amount: row.amount, kind: row.kind }, note: null,
  });
  return { id };
}

/* ===================================================================== *
 * 预警中心（docs/16 §6）
 * ===================================================================== */

export interface AlertRuleDto extends BudgetPrefsDto {
  /** 每档对应的行为说明，前端直接展示 */
  descriptions: { tier: number; label: string; behavior: string }[];
}

export function getAlertRules(ctx: AppCtx, ledgerId: string): AlertRuleDto {
  const prefs = getPrefs(ctx, ledgerId);
  const tiers = prefs.alertTiers.length ? prefs.alertTiers : [...DEFAULT_ALERT_TIERS];
  const labels = ['提示', '警告', '严重'];
  const behaviors = ['进度条转琥珀 + 气泡卡片（可静音）', '卡片置顶，按渠道提醒（去重）', '危险徽标 + 强提醒，执行超支后策略'];
  return {
    ...prefs,
    descriptions: tiers.map((t, i) => ({
      tier: t,
      label: labels[i] ?? `第 ${i + 1} 档`,
      behavior: behaviors[i] ?? '按渠道提醒',
    })),
  };
}

export interface AlertItem {
  budgetId: string;
  label: string;
  kind: 'threshold' | 'time_progress' | 'large_expense' | 'depletion' | 'overspend';
  level: 'info' | 'warning' | 'danger';
  tier: number | null;
  message: string;
  suppressed: boolean;
}

/**
 * 当期预警清单（**只读**，不写去重记录）。
 *
 * 与 `computeAlerts()` 的分工：computeAlerts 负责「首次提醒」的写库去重与打扰控制，
 * 那个端点前端只在进页面时调一次；这里给的是**当前事实**，可以随局部刷新反复调用，
 * 用来画预警中心列表。把两者混在一起会导致「每次刷新都把提醒标记成已读」。
 */
export function alertCenter(ctx: AppCtx, ledgerId: string, year: number, month: number): {
  items: AlertItem[];
  suppressed: boolean;
  channels: string[];
  overspendPolicy: string;
} {
  const prefs = getPrefs(ctx, ledgerId);
  const tiers = prefs.alertTiers.length ? prefs.alertTiers : [...DEFAULT_ALERT_TIERS];
  const rows = budgetProgress(ctx, ledgerId, year, month);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const suppressed = prefs.dndEnabled && !!prefs.dndFrom && !!prefs.dndTo && hhmm >= prefs.dndFrom && hhmm < prefs.dndTo;
  const items: AlertItem[] = [];

  for (const r of rows) {
    if (r.alertEnabled === false) continue;
    const used = Number(r.usedRatio);
    const isTarget = r.budgetKind !== 'expense';
    const label = r.categoryName ?? r.projectLabel ?? '总预算';

    // ① 80/90/100 分级（目标类不参与：超额达成是好消息）
    if (!isTarget) {
      for (let i = tiers.length - 1; i >= 0; i--) {
        const tier = tiers[i];
        if (tier === undefined || used < tier) continue;
        items.push({
          budgetId: r.id, label, kind: 'threshold',
          level: i === 0 ? 'info' : i === 1 ? 'warning' : 'danger',
          tier,
          message: `${label}已用 ${used.toFixed(1)}%，越过 ${tier}% ${['提示', '警告', '严重'][i] ?? ''}档`,
          suppressed,
        });
        break;
      }
    }

    // ② 超支事实
    if (r.over) {
      items.push({
        budgetId: r.id, label, kind: 'overspend', level: 'danger', tier: 100,
        message: `${label}已超支 ${formatCents(Math.abs(cents(r.remainingAmount)))}`,
        suppressed,
      });
    }

    // ③ 时间进度预警：执行率跑赢时间进度 10pp（目标类反过来判「达成落后」）
    if (prefs.timeProgressAlert && !isTarget && Number(r.usedRatio) - r.timeProgress > 10) {
      items.push({
        budgetId: r.id, label, kind: 'time_progress', level: 'warning', tier: null,
        message: `${label}：时间才过 ${r.timeProgress}%，已用 ${r.usedRatio}%，花钱偏快`,
        suppressed,
      });
    }

    // ④ 耗尽预测
    if (r.projectedSpent !== null && Number(r.projectedOver ?? 0) > 0) {
      items.push({
        budgetId: r.id, label, kind: 'depletion', level: 'warning', tier: null,
        message: `${label}按当前速度期末约 ${r.projectedSpent}，预计超出 ${r.projectedOver}`,
        suppressed,
      });
    }
  }

  // ⑤ 大额消费：本期已入账的最大单笔（提示级，说明口径）
  const p = periodRange('monthly', year, month);
  const big = ctx.db
    .select({ name: transactions.name, actualAmount: transactions.actualAmount, categoryId: transactions.categoryId })
    .from(transactions)
    .where(and(
      eq(transactions.ledgerId, ledgerId),
      isNull(transactions.deletedAt),
      eq(transactions.recordType, 'expense'),
      sql`coalesce(${transactions.budgetExcluded}, '') = ''`,
      sql`${transactions.adjustmentReason} is null or ${transactions.adjustmentReason} not in ('refund','reversal')`,
      sql`${transactions.txDate} >= ${p.start}`,
      sql`${transactions.txDate} <= ${p.end}`,
    ))
    .orderBy(sql`${transactions.actualAmount} desc`)
    .limit(1).get();
  const threshold = prefs.largeExpenseCents;
  if (big && (threshold === null ? true : big.actualAmount >= threshold)) {
    const names = new Map(ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all().map((c) => [c.id, c.name]));
    items.push({
      budgetId: '', label: '大额消费', kind: 'large_expense', level: 'info', tier: null,
      message: `本期最大单笔 ${formatCents(big.actualAmount)}${big.name ? ` · ${big.name}` : ''}${big.categoryId ? ` · ${names.get(big.categoryId) ?? ''}` : ''}`,
      suppressed,
    });
  }

  return { items, suppressed, channels: prefs.channels, overspendPolicy: prefs.overspendPolicy };
}

/**
 * 记账预检扩展（docs/16 §6.2）：返回超支后行为策略与出口，不拦路。
 * 纯读，不写库，供记账页高频调用。
 */
export function precheckPolicy(ctx: AppCtx, ledgerId: string, year: number, month: number) {
  const prefs = getPrefs(ctx, ledgerId);
  const rows = budgetProgress(ctx, ledgerId, year, month);
  const cats = rows.filter((r) => r.categoryId !== null && r.budgetKind === 'expense');
  return {
    policy: prefs.overspendPolicy,
    largeExpenseThreshold: prefs.largeExpenseCents === null ? null : formatCents(prefs.largeExpenseCents),
    /** 可接收调拨的分类（有剩余额度），供「建议调拨」出口 */
    transferSources: cats
      .filter((r) => Number(r.remainingAmount) > 0)
      .map((r) => ({ categoryId: r.categoryId!, label: r.categoryName ?? '未分类', available: r.remainingAmount })),
    options: ['继续并标记超支', '改分类', '取消', '从其他分类调拨'],
  };
}

/* ===================================================================== *
 * 调整动作：追加削减 / 调整原因 / 周期重置归档
 * ===================================================================== */

/** 追加（delta>0）/ 削减（delta<0）；必须填原因，全部留痕 */
export function adjustBudget(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  budgetId: string,
  input: { delta: string | number; reason: string },
) {
  const delta = cents(input.delta);
  const reason = input.reason?.trim() ?? '';
  if (!Number.isFinite(delta) || delta === 0) {
    throw HttpError.validation([{ field: 'delta', message: '调整额不能为 0' }]);
  }
  if (!reason) {
    throw HttpError.validation([{ field: 'reason', message: '请填写调整原因（会记入变更留痕）' }]);
  }
  const row = ctx.db.select().from(budgets)
    .where(and(eq(budgets.ledgerId, ledgerId), eq(budgets.id, budgetId))).get();
  if (!row) throw HttpError.notFound('预算不存在');
  const next = row.amount + delta;
  if (next <= 0) {
    throw HttpError.validation([{ field: 'delta', message: `削减后预算不可为负（当前 ${formatCents(row.amount)}）` }]);
  }
  ctx.db.update(budgets).set({ amount: next }).where(eq(budgets.id, budgetId)).run();
  recordChange(ctx, ledgerId, actorId, {
    budgetId, action: 'adjust',
    before: { amount: row.amount }, after: { amount: next, delta }, note: reason,
  });
  writeAudit(ctx.db, {
    ledgerId, actorId, action: 'update', entityType: 'budget', entityId: budgetId,
    summary: `${delta > 0 ? '追加' : '削减'}预算 ${formatCents(Math.abs(delta))}（${reason}）`,
    before: { amount: row.amount }, after: { amount: next },
  });
  return { id: budgetId, amount: formatCents(next), delta: formatCents(delta), reason };
}

/** 归档预览（破坏性操作的二次确认内容由前端 confirmDialog 承担） */
export function archivePreview(ctx: AppCtx, ledgerId: string, year: number, month: number) {
  const rows = budgetProgress(ctx, ledgerId, year, month).filter((r) => !r.archivedAt);
  return {
    period: periodRange('monthly', year, month).key,
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      label: r.categoryName ?? r.projectLabel ?? '总预算',
      amount: r.amount,
      actual: r.spentAmount,
      variance: formatCents(cents(r.spentAmount) - cents(r.amount)),
    })),
  };
}

/**
 * 周期重置归档：写快照 + 标记 archived_at，**不删除历史**。
 *
 * 快照存的是「当时的」预算额与实际；下个月改预算、补记账单都不会改写它，
 * 年度趋势才不会随今天的编辑悄悄变样（docs/16 §8）。
 */
export function archivePeriod(ctx: AppCtx, actorId: string, ledgerId: string, year: number, month: number) {
  const p = periodRange('monthly', year, month);
  const rows = budgetProgress(ctx, ledgerId, year, month).filter((r) => !r.archivedAt);
  if (!rows.length) throw HttpError.business('该账期没有可归档的预算');
  const at = nowIso();
  let written = 0;
  ctx.db.transaction((tx) => {
    for (const r of rows) {
      const B = cents(r.amount);
      const U = cents(r.spentAmount);
      const delta = U - B;
      tx.insert(budgetSnapshots).values({
        id: newId(ID_PREFIX.budget),
        ledgerId,
        periodKey: p.key,
        budgetId: r.id,
        scopeName: r.categoryName ?? r.projectLabel ?? '总预算',
        budgetKind: r.budgetKind,
        amount: B,
        actual: U,
        variance: delta,
        varianceRatioBp: B === 0 ? null : Math.round((delta / B) * 10000),
        periodDays: r.periodDays,
        archivedAt: at,
      }).onConflictDoNothing().run();
      tx.update(budgets).set({ archivedAt: at }).where(eq(budgets.id, r.id)).run();
      written += 1;
    }
  });
  recordChange(ctx, ledgerId, actorId, {
    action: 'archive_period', after: { period: p.key, count: written }, note: null,
  });
  writeAudit(ctx.db, {
    ledgerId, actorId, action: 'update', entityType: 'budget', entityId: 'archive',
    summary: `归档 ${p.key} 共 ${written} 条预算（写快照，不删除）`,
  });
  return { period: p.key, archived: written, archivedAt: at };
}

/** 已归档周期列表（复盘中可回看历史） */
export function listArchivedPeriods(ctx: AppCtx, ledgerId: string) {
  const rows = ctx.db
    .select({ periodKey: budgetSnapshots.periodKey, n: sql<number>`count(*)`, at: sql<string>`max(${budgetSnapshots.archivedAt})` })
    .from(budgetSnapshots)
    .where(eq(budgetSnapshots.ledgerId, ledgerId))
    .groupBy(budgetSnapshots.periodKey)
    .orderBy(desc(budgetSnapshots.periodKey))
    .all();
  return rows.map((r) => ({ period: r.periodKey, count: Number(r.n), archivedAt: r.at }));
}

export function archivedSnapshot(ctx: AppCtx, ledgerId: string, period: string) {
  const rows = ctx.db.select().from(budgetSnapshots)
    .where(and(eq(budgetSnapshots.ledgerId, ledgerId), eq(budgetSnapshots.periodKey, period)))
    .all();
  return rows.map((r) => ({
    label: r.scopeName ?? '总预算',
    budgetKind: r.budgetKind,
    amount: formatCents(r.amount),
    actual: formatCents(r.actual),
    variance: formatCents(r.variance),
    varianceRatio: r.varianceRatioBp === null ? null : (r.varianceRatioBp / 100).toFixed(2),
    periodDays: r.periodDays,
  }));
}

/* ===================================================================== *
 * 编制方法辅助：信封法 / 弹性预算预览
 * ===================================================================== */

/** 信封法：从总额按分类分配，返回预览（不落库），前端确认后逐条 createBudget */
export function envelopePlan(
  ctx: AppCtx,
  ledgerId: string,
  input: { total: string | number; allocations: { categoryId: string; amount: string | number }[] },
) {
  const total = cents(input.total);
  if (total <= 0) throw HttpError.validation([{ field: 'total', message: '总预算必须大于 0' }]);
  const cats = new Map(ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all().map((c) => [c.id, c.name]));
  const items = input.allocations.map((a) => ({
    categoryId: a.categoryId,
    categoryName: cats.get(a.categoryId) ?? '（分类不存在）',
    amount: cents(a.amount),
  }));
  const allocated = items.reduce((s, x) => s + x.amount, 0);
  return {
    total: formatCents(total),
    allocated: formatCents(allocated),
    unallocated: formatCents(total - allocated),
    overAllocated: allocated > total ? formatCents(allocated - total) : null,
    items: items.map((x) => ({ ...x, amount: formatCents(x.amount) })),
  };
}

/** 弹性预算预览：有效额度 = 固定基数 + 本期收入 × 浮动比例 */
export function elasticPreview(ctx: AppCtx, ledgerId: string, year: number, month: number, base: number, ratioBp: number) {
  const p = periodRange('monthly', year, month);
  const row = ctx.db
    .select({ s: sql<number>`coalesce(sum(case when ${transactions.adjustmentReason} in ('refund','reversal') then -${transactions.actualAmount} else ${transactions.actualAmount} end), 0)` })
    .from(transactions)
    .where(and(
      eq(transactions.ledgerId, ledgerId),
      isNull(transactions.deletedAt),
      eq(transactions.recordType, 'income'),
      sql`${transactions.txDate} >= ${p.start}`,
      sql`${transactions.txDate} <= ${p.end}`,
    )).get();
  const income = Number(row?.s ?? 0);
  const variable = Math.round((income * ratioBp) / 10000);
  return {
    fixedBase: formatCents(base),
    incomeToDate: formatCents(income),
    ratioPercent: (ratioBp / 100).toFixed(2),
    variable: formatCents(variable),
    effectiveAmount: formatCents(base + variable),
    /** 本期收入未结算完，额度会随收入增长 —— 必须说清是「当前有效值」 */
    note: '按本期已入账收入实时计算；收入继续入账时有效额度会同步上浮',
  };
}

/**
 * 维度下拉选项（账户 / 成员 / 标签）。
 *
 * ⚠️ 三个都必须带 ledgerId 约束：早期版本直接 `select().from(users)`，
 * 会把**别的账本甚至别的租户的成员昵称**列进本账本的下拉框 —— 数据不报错、
 * 数字也不受影响，但这是越权泄漏，而且 UI 上看不出来（只是多了几个人名）。
 */
export function dimensionOptions(ctx: AppCtx, ledgerId: string) {
  const accounts = ctx.db
    .select({ id: accountsTable.id, label: accountsTable.name })
    .from(accountsTable)
    .where(and(eq(accountsTable.ledgerId, ledgerId), isNull(accountsTable.archivedAt)))
    .all();
  const members = ctx.db
    .select({
      id: users.id,
      label: sql<string>`coalesce(${ledgerMembers.nicknameOverride}, ${users.nickname})`,
    })
    .from(ledgerMembers)
    .innerJoin(users, eq(ledgerMembers.userId, users.id))
    .where(eq(ledgerMembers.ledgerId, ledgerId))
    .all();
  const tagRows = ctx.db
    .select({ id: tags.id, label: tags.name })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), isNull(tags.archivedAt)))
    .all();
  return { accounts, members, tags: tagRows };
}
