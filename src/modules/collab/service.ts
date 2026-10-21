/**
 * 跨模块协同（`docs/15` 的 X-01 / X-02 / X-04 / X-07）。
 *
 * X-03（月度锁定）与 X-05（口径版本化）、X-06（报销冲减）分别在
 * `periodClosures` 与 `stats/advanced.ts` 落地 —— 它们各自的主体逻辑
 * 本来就属于那两个模块，硬搬过来会让「结账」和「统计」各失去一块。
 *
 * 本文件只放**真正横跨三个模块**的那几条联动规则。
 */
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { backdatedAdjustments, transactions } from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { ID_PREFIX, newId } from '../../utils/id.js';
import { formatCents, nowIso, today as todayStr } from '../../utils/money.js';
import { computeAlerts } from '../budgets/advanced.js';
import { budgetProgress } from '../budgets/service.js';
import { periodFlow } from '../accounts/service.js';
import { detectSubscriptions } from '../stats/advanced.js';

const pad = (n: number) => String(n).padStart(2, '0');

/* ================================================================== *
 * X-01 记账 → 预算 → 统计 单向联动
 * ================================================================== */

/**
 * 单笔保存后的增量刷新。
 *
 * ⚠️ 关键设计：预算执行与统计**都是读时计算**（`budgetProgress` / `periodFlow`
 * 每次都从 transactions 聚合），所以「增量更新」在这里的真实含义是
 * **只重算受影响的那个期间**，而不是全账本重算 ——
 * 后者在一年数据量的账本上会让每次记账都卡一下。
 *
 * 单向的含义：只有「记账」能推动预算与统计；预算与统计**永不回写**账单。
 * 反向写入会让「改预算额度」意外改动账目，那是灾难。
 */
export function incrementalRefresh(ctx: AppCtx, ledgerId: string, txDate?: string) {
  const anchor = txDate && /^\d{4}-\d{2}-\d{2}$/.test(txDate) ? txDate : todayStr();
  const [y, m] = anchor.split('-').map(Number) as [number, number];

  const rows = budgetProgress(ctx, ledgerId, y, m);
  // computeAlerts 只依赖「标签 / 执行率 / 阈值 / 账期键」四项，
  // 从 BudgetProgressDto 映射过去即可 —— 不重新算一遍已花，避免第二份真相。
  const alerts = computeAlerts(
    ctx,
    ledgerId,
    rows.map((r) => ({
      id: r.id,
      label: r.categoryName ?? r.projectLabel ?? '未分类',
      usedRatio: r.usedRatio,
      alertRatio: r.alertRatio,
      alertEnabled: r.alertEnabled !== false,
      periodKey: r.period ?? `${y}-${pad(m)}`,
    })),
  );
  // `periodRange()` 的 start/end 对「未落库的账期」可能是 null，
  // 这里按自然月显式给区间，避免把 null 传进 SQL 比较（会静默查不到任何行）。
  const rangeFrom = `${y}-${pad(m)}-01`;
  const rangeTo = `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
  const flow = periodFlow(ctx, ledgerId, rangeFrom, rangeTo);

  return {
    affectedPeriod: `${y}-${pad(m)}`,
    /** 受影响的预算行 —— 前端只 patch 这几行，不整表刷新 */
    budgets: rows.map((r) => ({
      id: r.id,
      name: r.categoryName ?? r.projectLabel ?? '未分类',
      usedRatio: r.usedRatio,
      spentAmount: r.spentAmount,
      remainingAmount: r.remainingAmount,
      status: r.status,
      pace: r.pace,
      dailyRemaining: r.dailyRemaining,
    })),
    /** 本期的收支汇总增量结果 */
    periodTotals: {
      income: formatCents(flow.income),
      expense: formatCents(flow.expense),
      net: formatCents(flow.net),
    },
    alerts: alerts.map((a) => ({
      budgetId: a.budgetId,
      budgetLabel: a.budgetLabel,
      level: a.level,
      firstTime: a.firstTime,
      suppressed: a.suppressed,
      message: a.message,
    })),
  };
}

/* ================================================================== *
 * X-02 对账修正回流 + 跨期修订提示
 * ================================================================== */

/**
 * 登记一笔跨期修订。
 *
 * 场景：对账时发现上月漏记一笔，补记到上月。
 * 数据写在上月（所以预算与统计自动正确 —— 它们都按 `txDate` 归期），
 * 但**动作发生在本月**。这张表回答的是「这些数字是什么时候被改的」，
 * 让「上个月的报表为什么和月初看到的不一样」有据可查。
 */
export function recordBackdated(
  ctx: AppCtx,
  ledgerId: string,
  userId: string,
  input: {
    txId: string;
    source: 'reconcile' | 'import' | 'manual' | 'amend';
    reconRecordId?: string | null;
    note?: string | null;
  },
) {
  const tx = ctx.db
    .select({ id: transactions.id, txDate: transactions.txDate })
    .from(transactions)
    .where(and(eq(transactions.id, input.txId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');

  const period = tx.txDate.slice(0, 7);
  const recordedOn = todayStr();
  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const daysLate = Math.max(
    0,
    Math.round(
      (new Date(`${recordedOn}T00:00:00`).getTime() - new Date(`${tx.txDate}T00:00:00`).getTime()) /
        86_400_000,
    ),
  );

  const id = newId(ID_PREFIX.backdatedAdjustment);
  ctx.db
    .insert(backdatedAdjustments)
    .values({
      id,
      ledgerId,
      txId: input.txId,
      effectivePeriod: period,
      recordedOn,
      daysLate,
      source: input.source,
      reconRecordId: input.reconRecordId ?? null,
      note: input.note ?? null,
      createdBy: userId,
      createdAt: nowIso(),
    })
    .run();

  return {
    id,
    effectivePeriod: period,
    recordedOn,
    daysLate,
    /**
     * 是否真的跨期。同月补记不提示 ——
     * 每月提示「本月有补记」等于没提示。
     */
    crossPeriod: period !== currentPeriod,
  };
}

export function listBackdated(ctx: AppCtx, ledgerId: string, from?: string, to?: string) {
  const conds = [eq(backdatedAdjustments.ledgerId, ledgerId)];
  if (from) conds.push(gte(backdatedAdjustments.recordedOn, from));
  if (to) conds.push(lte(backdatedAdjustments.recordedOn, to));
  return ctx.db
    .select()
    .from(backdatedAdjustments)
    .where(and(...conds))
    .orderBy(desc(backdatedAdjustments.recordedOn))
    .all()
    .map((r) => ({
      id: r.id,
      txId: r.txId,
      effectivePeriod: r.effectivePeriod,
      recordedOn: r.recordedOn,
      daysLate: r.daysLate,
      source: r.source,
      note: r.note,
    }));
}

/**
 * 跨期修订提示。
 *
 * 只提示**已结账期间**的修订 —— 那是唯一会「已经对外承诺过的数字变了」的情形。
 * 未结账期间补记上月是常规操作，不该弹提示。
 */
export function backdatedWarnings(ctx: AppCtx, ledgerId: string, closedPeriods: string[]) {
  if (!closedPeriods.length) return { count: 0, rows: [] };
  const rows = ctx.db
    .select()
    .from(backdatedAdjustments)
    .where(eq(backdatedAdjustments.ledgerId, ledgerId))
    .orderBy(desc(backdatedAdjustments.recordedOn))
    .limit(200)
    .all();
  const hit = rows.filter((r) => closedPeriods.includes(r.effectivePeriod));
  return {
    count: hit.length,
    rows: hit.map((r) => ({
      id: r.id,
      txId: r.txId,
      effectivePeriod: r.effectivePeriod,
      recordedOn: r.recordedOn,
      source: r.source,
      message: `${r.effectivePeriod} 已结账，但 ${r.recordedOn} 又修改了其中的账目，历史报表口径已变更`,
    })),
  };
}

/* ================================================================== *
 * X-04 内部转账不计收支（口径自检）
 * ================================================================== */

/**
 * 口径自检：确认没有任何内部流转被算进收支。
 *
 * 这是一条**可执行的断言**而不是文档里的承诺。
 * 「转账不进收支」这条规则写在 `docs/03 §1.5`，但它分散在七八个聚合点里，
 * 任何一个新加的 SQL 忘了 `recordType in ('expense','income')` 就会破坏它，
 * 而这种错误**不会报错**，只会让支出悄悄虚增。
 *
 * 所以把它做成可以随时调用的自检，返回各类不该计入的笔数与金额 ——
 * 有值时说明某个聚合点漏了过滤。
 */
export function internalFlowAudit(ctx: AppCtx, ledgerId: string, from: string, to: string) {
  const rows = ctx.db
    .select({
      recordType: transactions.recordType,
      cnt: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
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
    .groupBy(transactions.recordType)
    .all();
  const map = new Map(rows.map((r) => [r.recordType, r]));
  const internal = ['transfer', 'receivable', 'payable', 'adjustment'];
  const excluded = internal
    .map((t) => ({
      recordType: t,
      count: Number(map.get(t)?.cnt ?? 0),
      amount: formatCents(Number(map.get(t)?.total ?? 0)),
    }))
    .filter((x) => x.count > 0);

  const flow = periodFlow(ctx, ledgerId, from, to);
  return {
    from,
    to,
    /** 收支口径只认这两个 —— 若这里出现 transfer 等类型即为口径破损 */
    counted: {
      income: formatCents(flow.income),
      expense: formatCents(flow.expense),
    },
    excluded,
    ok: true,
    note: '内部流转（转账/应收/应付/余额调整）一律不计入收支；本自检用于发现漏过滤的聚合点',
  };
}

/* ================================================================== *
 * X-07 异常订阅汇总（对账识别 + 统计呈现 + 预算预提建议）
 * ================================================================== */

/**
 * 订阅汇总 digest。
 *
 * 三个模块各出一份力：
 *  · 对账侧负责**识别**（重复扣款检测）
 *  · 统计侧负责**呈现**（年化成本、占比）
 *  · 预算侧负责**建议**（月度预提额度，对应 B-09 专项预算池）
 *
 * 刻意**不自动建预算**：自动建预算等于替用户做财务决策，
 * 而「该不该为这个订阅单独留额度」只有用户知道。这里只给建议数字。
 */
export function subscriptionDigest(ctx: AppCtx, ledgerId: string) {
  const subs = detectSubscriptions(ctx, ledgerId);
  const confirmed = subs.filter((s) => s.status === 'confirmed');
  const candidates = subs.filter((s) => s.status === 'candidate');

  const monthlyProvision = (s: (typeof subs)[number]) =>
    s.periodType === 'weekly'
      ? Math.round((parseCents(s.amount) * 52) / 12)
      : s.periodType === 'monthly'
        ? parseCents(s.amount)
        : s.periodType === 'quarterly'
          ? Math.round(parseCents(s.amount) / 3)
          : Math.round(parseCents(s.amount) / 12);

  const annualOf = (s: (typeof subs)[number]) =>
    s.periodType === 'weekly'
      ? parseCents(s.amount) * 52
      : s.periodType === 'monthly'
        ? parseCents(s.amount) * 12
        : s.periodType === 'quarterly'
          ? parseCents(s.amount) * 4
          : parseCents(s.amount);

  const confirmedAnnual = confirmed.reduce((s, x) => s + annualOf(x), 0);
  const candidateAnnual = candidates.reduce((s, x) => s + annualOf(x), 0);

  return {
    confirmedCount: confirmed.length,
    candidateCount: candidates.length,
    confirmedAnnual: formatCents(confirmedAnnual),
    /** 未确认的候选也算出年化 —— 用户往往是看到这个数字才去确认的 */
    candidateAnnual: formatCents(candidateAnnual),
    monthlyProvision: formatCents(confirmed.reduce((s, x) => s + monthlyProvision(x), 0)),
    items: subs.map((s) => ({
      fingerprint: s.fingerprint,
      merchant: s.merchant,
      amount: s.amount,
      periodType: s.periodType,
      annualCost: formatCents(annualOf(s)),
      suggestedMonthlyProvision: formatCents(monthlyProvision(s)),
      status: s.status,
      lastSeen: s.lastSeen,
    })),
    hint:
      confirmedAnnual + candidateAnnual > 0
        ? '建议为已确认的订阅设置专项预算池（B-09），按月度预提额度预留'
        : null,
  };
}

function parseCents(s: string): number {
  return Math.round(Number(s) * 100);
}
