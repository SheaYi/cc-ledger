/**
 * 统计模块进阶能力（`docs/15` 的 S-05~S-17，以及跨模块 X-05/X-06/X-07 的统计侧）。
 *
 * ## 为什么与 `service.ts` 分开
 *
 * `service.ts` 是「本月花了多少、分类占比多少」这类**基础口径**，它的稳定
 * 比它的丰富更重要 —— 概览页、报表页、前端卡片都在消费它。
 * 本文件放的是**变化频繁的分析型能力**：结论式洞察、自定义报表、订阅识别、
 * 现金流三分类。把它们混进 `service.ts` 会让「改一句洞察文案」这种需求
 * 去动一个全站依赖的文件。
 *
 * ## 三条贯穿全文件的口径纪律
 *
 * 1. **金额一律取 `actual_amount`**（已内含手续费/折扣），不用 `amount`。
 * 2. **只有 `expense` / `income` 进收支口径**；转账/应收/应付/余额调整
 *    一律不计（X-04）。这是 `periodFlow()` 已经保证的，这里不再自己写聚合。
 * 3. **跨期比较必须给日均口径**。2 月 28 天、3 月 31 天，直接比总额会把
 *    「天数差异」读成「消费变化」—— 这是本文档点名的行业通病。
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accounts,
  categories,
  ledgerMembers,
  netWorthSnapshots,
  reimbursements,
  recurringDetections,
  savedReports,
  statEvents,
  statsPolicyVersions,
  transactionTags,
  transactions,
  users as users2,
} from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { ID_PREFIX, newId } from '../../utils/id.js';
import { formatCents, nowIso, parseAmountToCents, today as todayStr } from '../../utils/money.js';
import { keywordCondition, type TxFilters } from '../../utils/tx-filter.js';
import { balanceView, periodFlow, totals } from '../accounts/service.js';
import { budgetProgress } from '../budgets/service.js';
import { actualSpan } from './service.js';

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;

function monthRange(y: number, m: number): { from: string; to: string } {
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}` };
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / DAY) + 1;
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 上周/上月/去年的「等长或对齐」区间。周按 7 天，月/年按自然边界。 */
function previousRange(from: string, to: string): { from: string; to: string } {
  const days = daysBetween(from, to);
  return { from: shiftDate(from, -days), to: shiftDate(from, -1) };
}

function lastYearRange(from: string, to: string): { from: string; to: string } {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  f.setFullYear(f.getFullYear() - 1);
  t.setFullYear(t.getFullYear() - 1);
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: fmt(f), to: fmt(t) };
}

/** 变化率。分母为 0 时返回 null（数学上无意义，返回 0 等于谎称「没变」）。 */
function rate(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

/* ------------------------------------------------------------------ *
 * 记账口径：软删与内部流向
 * ------------------------------------------------------------------ */

/** 未软删 + 属于该账本 */
const aliveTx = (ledgerId: string) =>
  and(eq(transactions.ledgerId, ledgerId), isNull(transactions.deletedAt));

/**
 * X-04：只有 expense / income 是「收支」。
 * transfer / receivable / payable / adjustment 都是**资产形态变化**，
 * 计入收支会让「本月支出」虚增一倍（内部转账从 A 到 B，两边都不是消费）。
 */
const isFlow = () => inArray(transactions.recordType, ['expense', 'income']);

/* ------------------------------------------------------------------ *
 * S-05 预算执行视图（预实对比）
 * ------------------------------------------------------------------ */

export interface ExecutionRow {
  id: string;
  name: string;
  scope: string;
  budgetAmount: string;
  spentAmount: string;
  remainingAmount: string;
  usedRatio: number;
  periodDays: number;
  elapsedDays: number;
  /** 按当前速度到期末会花多少（null = 已过天数太少，不预测） */
  projectedAmount: string | null;
  status: 'safe' | 'watch' | 'over';
}

export function budgetExecution(
  ctx: AppCtx,
  ledgerId: string,
  year: number,
  month: number,
): { period: string; rows: ExecutionRow[]; totalBudget: string; totalSpent: string } {
  const rows = budgetProgress(ctx, ledgerId, year, month);
  const out: ExecutionRow[] = rows.map((r) => {
    const budget = parseAmountToCents(r.amount);
    const spent = parseAmountToCents(r.spentAmount);
    // ⚠️ `usedRatio` 在 `BudgetProgressDto` 里是**字符串**（全站金额/比率出口只有
    // `money()` 一个，前端直接渲染）。这里要做档位判断，必须先转回数字 ——
    // 直接拿字符串比 100 会得到 `"9" >= 100` 这种荒谬结果而不报错。
    const used = Number(r.usedRatio);
    return {
      id: r.id,
      name: r.categoryName ?? r.projectLabel ?? '未分类',
      scope: r.scope ?? 'category',
      budgetAmount: r.amount,
      spentAmount: r.spentAmount,
      remainingAmount: formatCents(budget - spent),
      usedRatio: used,
      periodDays: r.periodDays ?? 0,
      elapsedDays: r.elapsedDays ?? 0,
      projectedAmount: r.projectedSpent,
      status: used >= 100 ? 'over' : used >= 80 ? 'watch' : 'safe',
    };
  });
  const totalBudget = rows.reduce((s, r) => s + parseAmountToCents(r.amount), 0);
  const totalSpent = rows.reduce((s, r) => s + parseAmountToCents(r.spentAmount), 0);
  return {
    period: `${year}-${pad(month)}`,
    rows: out,
    totalBudget: formatCents(totalBudget),
    totalSpent: formatCents(totalSpent),
  };
}

/* ------------------------------------------------------------------ *
 * S-06 图表下钻
 * ------------------------------------------------------------------ */

export interface DrilldownQuery {
  from?: string;
  to?: string;
  categoryId?: string;
  accountId?: string;
  tagId?: string;
  recordType?: 'expense' | 'income';
  minAmount?: string;
  maxAmount?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

/**
 * 图 → 分类 → 明细 → 单笔 的终点。
 *
 * 下钻结果必须带上**合计栏**：用户点进「餐饮 1200」是要确认这个数对不对，
 * 如果明细加起来和图上对不上，第一反应是软件算错了 —— 而多数情况下
 * 差异来自筛选条件（如软删的账单没算进来），合计栏能让这件事可见。
 */
export function drilldown(ctx: AppCtx, ledgerId: string, q: DrilldownQuery) {
  const to = q.to ?? todayStr();
  const from = q.from ?? `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-01`;
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);

  const conds = [
    aliveTx(ledgerId)!,
    gte(transactions.txDate, from),
    lte(transactions.txDate, to),
  ];
  if (q.categoryId) {
    // 一级分类要带上它的二级子分类（子分类的 parentCategoryId 指向一级）
    conds.push(
      or(
        eq(transactions.categoryId, q.categoryId),
        eq(transactions.parentCategoryId, q.categoryId),
      )!,
    );
  }
  if (q.accountId) {
    conds.push(
      or(
        eq(transactions.accountId, q.accountId),
        eq(transactions.toAccountId, q.accountId),
      )!,
    );
  }
  if (q.recordType) conds.push(eq(transactions.recordType, q.recordType));
  if (q.minAmount !== undefined) {
    conds.push(gte(transactions.actualAmount, parseAmountToCents(q.minAmount)));
  }
  if (q.maxAmount !== undefined) {
    conds.push(lte(transactions.actualAmount, parseAmountToCents(q.maxAmount)));
  }
  if (q.keyword) {
    const kw = `%${q.keyword}%`;
    conds.push(
      or(
        sql`${transactions.name} like ${kw}`,
        sql`${transactions.merchant} like ${kw}`,
        sql`${transactions.note} like ${kw}`,
      )!,
    );
  }
  if (q.tagId) {
    conds.push(
      sql`exists (select 1 from transaction_tags tt where tt.transaction_id = ${transactions.id} and tt.tag_id = ${q.tagId})`,
    );
  }

  const where = and(...conds)!;

  const summed = ctx.db
    .select({
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(where)
    .get();

  const rows = ctx.db
    .select({
      id: transactions.id,
      txDate: transactions.txDate,
      recordType: transactions.recordType,
      amount: transactions.actualAmount,
      name: transactions.name,
      merchant: transactions.merchant,
      note: transactions.note,
      accountId: transactions.accountId,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(where)
    .orderBy(desc(transactions.txDate), desc(transactions.occurredAt))
    .limit(limit)
    .offset(offset)
    .all();

  const catIds = [...new Set(rows.map((r) => r.categoryId).filter((x): x is string => !!x))];
  const catNames = new Map<string, string>();
  if (catIds.length) {
    for (const c of ctx.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(inArray(categories.id, catIds))
      .all()) {
      catNames.set(c.id, c.name);
    }
  }
  const accIds = [...new Set(rows.map((r) => r.accountId))];
  const accNames = new Map<string, string>();
  if (accIds.length) {
    for (const a of ctx.db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(inArray(accounts.id, accIds))
      .all()) {
      accNames.set(a.id, a.name);
    }
  }

  return {
    filters: { from, to, ...q },
    totalAmount: formatCents(Number(summed?.total ?? 0)),
    totalCount: Number(summed?.cnt ?? 0),
    page: { limit, offset },
    rows: rows.map((r) => ({
      id: r.id,
      txDate: r.txDate,
      recordType: r.recordType,
      amount: formatCents(r.amount),
      name: r.name,
      merchant: r.merchant,
      note: r.note,
      accountName: accNames.get(r.accountId) ?? null,
      categoryName: r.categoryId ? (catNames.get(r.categoryId) ?? null) : null,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * S-07 多周期报表（月报 / 周报 / 年报）
 * ------------------------------------------------------------------ */

export type ReportPeriod = 'week' | 'month' | 'year';

/** 解析报表区间。anchor 是区间内的任意一天（默认今天）。 */
export function periodOf(
  kind: ReportPeriod,
  anchor?: string,
): { from: string; to: string; label: string; days: number } {
  const base = anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : todayStr();
  const d = new Date(`${base}T00:00:00`);
  if (kind === 'week') {
    // 周一为一周之始（与国内日历习惯一致）
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const f = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
    const t = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
    return { from: f, to: t, label: `${f} 起一周`, days: 7 };
  }
  if (kind === 'year') {
    const y = d.getFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} 年度`, days: daysBetween(`${y}-01-01`, `${y}-12-31`) };
  }
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const r = monthRange(y, m);
  return { ...r, label: `${y} 年 ${m} 月`, days: daysBetween(r.from, r.to) };
}

export function periodReport(ctx: AppCtx, ledgerId: string, kind: ReportPeriod, anchor?: string) {
  const p = periodOf(kind, anchor);
  const flow = periodFlow(ctx, ledgerId, p.from, p.to);
  const cats = byCategoryIn(ctx, ledgerId, p.from, p.to);
  const daily = dailySeries(ctx, ledgerId, p.from, p.to);
  return {
    period: { kind, label: p.label, from: p.from, to: p.to, days: p.days },
    totals: {
      income: formatCents(flow.income),
      expense: formatCents(flow.expense),
      net: formatCents(flow.net),
      dailyExpense: formatCents(Math.round(flow.expense / p.days)),
    },
    categories: cats.slice(0, 12),
    daily,
  };
}

function byCategoryIn(ctx: AppCtx, ledgerId: string, from: string, to: string, keyword?: string) {
  const kwCond = keywordCondition(keyword);
  const rows = ctx.db
    .select({
      categoryId: transactions.categoryId,
      /**
       * 分类维度同样要**减去冲减项**：退款冲的是「原分类」，
       * 不相减的话「餐饮」会同时计进 210 的支出和 210 的退款，合计变 420。
       */
      total: sql<number>`coalesce(sum(case when ${transactions.adjustmentReason} in ('reversal','refund') then -${transactions.actualAmount} else ${transactions.actualAmount} end), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        aliveTx(ledgerId)!,
        eq(transactions.recordType, 'expense'),
        gte(transactions.txDate, from),
        lte(transactions.txDate, to),
        ...(kwCond ? [kwCond] : []),
      ),
    )
    .groupBy(transactions.categoryId)
    .orderBy(desc(sql`sum(${transactions.actualAmount})`))
    .all();
  const ids = [...new Set(rows.map((r) => r.categoryId).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const c of ctx.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(inArray(categories.id, ids))
      .all()) {
      names.set(c.id, c.name);
    }
  }
  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  return rows.map((r) => ({
    categoryId: r.categoryId,
    categoryName: r.categoryId ? (names.get(r.categoryId) ?? null) : '未分类',
    amount: formatCents(Number(r.total)),
    count: Number(r.cnt),
    ratio: total > 0 ? Math.round((Number(r.total) / total) * 1000) / 10 : 0,
  }));
}

function dailySeries(ctx: AppCtx, ledgerId: string, from: string, to: string) {
  const rows = ctx.db
    .select({
      d: transactions.txDate,
      expense: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'expense' then ${transactions.actualAmount} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'income' then ${transactions.actualAmount} else 0 end), 0)`,
    })
    .from(transactions)
    .where(
      and(aliveTx(ledgerId)!, isFlow(), gte(transactions.txDate, from), lte(transactions.txDate, to)),
    )
    .groupBy(transactions.txDate)
    .orderBy(asc(transactions.txDate))
    .all();
  return rows.map((r) => ({
    date: r.d,
    expense: formatCents(Number(r.expense)),
    income: formatCents(Number(r.income)),
  }));
}

/* ------------------------------------------------------------------ *
 * S-08 环比（日均校准）
 * ------------------------------------------------------------------ */

/**
 * 环比对比。
 *
 * 同时给**总额**与**日均**两个口径，并在天数差异 ≥ 3 天时显式提示。
 * 只给总额是最常见的报表错误：2 月 28 天、3 月 31 天，
 * 三月「多花了 10%」可能纯粹是多了 3 天。
 */
export function comparison(
  ctx: AppCtx,
  ledgerId: string,
  from: string,
  to: string,
  keyword?: string,
  /** 账户 / 分类 / 类型 三维筛选（可选），与上期口径一致 */
  filters?: TxFilters,
  /**
   * 「所有」模式：本期 = 全部账单。
   *
   * ⚠️ 空区间不能直接喂给 `previousRange()` —— `new Date('T00:00:00')` 是
   * Invalid Date，算出来的「上期」是 `NaN-NaN-NaN`，既查不到数据也不报错，
   * 环比就永远显示「—」而没人知道为什么。所以先解析成账目的实际首末笔跨度。
   */
  all?: boolean,
) {
  /** 「所有」模式退化成实际数据跨度，好让「上一个等长区间」有意义 */
  const f = all ? actualSpan(ctx, ledgerId).from : from;
  const t = all ? actualSpan(ctx, ledgerId).to : to;
  const cur = periodFlow(ctx, ledgerId, all ? '' : f, all ? '' : t, keyword, filters);
  const prevR = previousRange(f, t);
  const prev = periodFlow(ctx, ledgerId, prevR.from, prevR.to, keyword, filters);
  const curDays = daysBetween(f, t);
  const prevDays = daysBetween(prevR.from, prevR.to);

  const curDailyExp = Math.round(cur.expense / curDays);
  const prevDailyExp = Math.round(prev.expense / prevDays);

  return {
    current: { from: f, to: t, days: curDays, ...centsOf(cur) },
    previous: { ...prevR, days: prevDays, ...centsOf(prev) },
    expense: {
      amountChangeRate: rate(cur.expense, prev.expense),
      dailyChangeRate: rate(curDailyExp, prevDailyExp),
      dailyExpense: formatCents(curDailyExp),
      previousDailyExpense: formatCents(prevDailyExp),
    },
    income: {
      amountChangeRate: rate(cur.income, prev.income),
      dailyChangeRate: rate(Math.round(cur.income / curDays), Math.round(prev.income / prevDays)),
    },
    /**
     * 天数校准提示。刻意只在差异明显时才给 ——
     * 每天都提示等于没提示。
     */
    daysCalibration:
      Math.abs(curDays - prevDays) >= 3
        ? {
            curDays,
            prevDays,
            message: `本期 ${curDays} 天、上期 ${prevDays} 天，建议以日均口径比较`,
          }
        : null,
  };
}

function centsOf(f: { income: number; expense: number; net: number }) {
  return {
    income: formatCents(f.income),
    expense: formatCents(f.expense),
    net: formatCents(f.net),
  };
}

/* ------------------------------------------------------------------ *
 * S-09 净资产（Monarch 式仪表盘）
 * ------------------------------------------------------------------ */

/**
 * 净资产序列。
 *
 * ⚠️ **历史月份一律读快照，只有当月实时计算。**
 * 这不是性能优化，是正确性要求：不存快照的话，
 * 用户改了一笔去年的账，「去年 12 月净资产」会跟着变 ——
 * 而「去年末我有多少钱」是一个**历史事实**，不该被今天的操作改写。
 */
export function netWorthSeries(ctx: AppCtx, ledgerId: string, months = 12) {
  const now = new Date();
  const snaps = ctx.db
    .select()
    .from(netWorthSnapshots)
    .where(eq(netWorthSnapshots.ledgerId, ledgerId))
    .orderBy(desc(netWorthSnapshots.snapshotDate))
    .limit(months)
    .all();
  const map = new Map(snaps.map((s) => [s.snapshotDate, s]));

  const out: Array<{
    date: string;
    label: string;
    assetTotal: string;
    liabilityTotal: string;
    netWorth: string;
    source: 'snapshot' | 'live';
    changeRate: number | null;
  }> = [];

  let prevNet: number | null = null;
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const r = monthRange(y, m);
    const isCurrent = i === 0;
    const snap = map.get(r.to);
    let asset = 0;
    let liability = 0;
    let net = 0;
    let source: 'snapshot' | 'live' = 'live';
    if (snap) {
      asset = snap.assetTotal;
      liability = snap.liabilityTotal;
      net = snap.netWorth;
      source = 'snapshot';
    } else if (isCurrent) {
      const t = totals(ctx, ledgerId);
      asset = t.assetTotal;
      liability = t.liabilityTotal;
      net = t.netWorth;
    } else {
      // 没有快照的历史月份诚实留空，绝不用今天的余额倒推
      out.push({
        date: r.to,
        label: `${y}-${pad(m)}`,
        assetTotal: formatCents(0),
        liabilityTotal: formatCents(0),
        netWorth: formatCents(0),
        source: 'snapshot',
        changeRate: null,
      });
      continue;
    }
    out.push({
      date: r.to,
      label: `${y}-${pad(m)}`,
      assetTotal: formatCents(asset),
      liabilityTotal: formatCents(liability),
      netWorth: formatCents(net),
      source,
      changeRate: prevNet === null ? null : rate(net, prevNet),
    });
    prevNet = net;
  }

  /**
   * 去掉开头连续「资产与负债都为 0」的月份。
   * 这些月份账本在该时点尚未产生任何净值，画出来是一条贴着 0 基准的平线 ——
   * 既像「没数据却凭空有曲线」误导用户，又白白挤占横坐标（曲线显得过密）。
   * 末尾的当月实时点（即便为 0）始终保留，这样「只有当月有数」时仍走空态而不是一条孤线。
   * 注意：只裁首部，不裁中部/尾部，避免把「某几个月恰好净值为 0」的真实历史抹掉。
   */
  while (out.length > 1) {
    const head = out[0]!;
    if (Number(head.assetTotal) !== 0 || Number(head.liabilityTotal) !== 0) break;
    out.shift();
  }

  return out;
}

/** 写一条月末快照。重复调用是幂等的（唯一索引 + upsert 语义）。 */
export function captureNetWorthSnapshot(
  ctx: AppCtx,
  ledgerId: string,
  snapshotDate: string,
  policyVersion: string = DEFAULT_POLICY_VERSION,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    throw HttpError.validation([{ field: 'snapshotDate', message: '日期格式应为 YYYY-MM-DD' }]);
  }
  // ⚠️ 必须按 snapshotDate 定格，不能取「当下」余额：
  // 拍的是「某月末」的历史事实，用今天的余额倒推会污染历史口径。
  const t = totals(ctx, ledgerId, snapshotDate);
  const cnt = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), isNull(accounts.archivedAt)))
    .get();
  const existing = ctx.db
    .select({ id: netWorthSnapshots.id })
    .from(netWorthSnapshots)
    .where(
      and(
        eq(netWorthSnapshots.ledgerId, ledgerId),
        eq(netWorthSnapshots.snapshotDate, snapshotDate),
      ),
    )
    .get();
  const at = nowIso();
  if (existing) {
    ctx.db
      .update(netWorthSnapshots)
      .set({
        assetTotal: t.assetTotal,
        liabilityTotal: t.liabilityTotal,
        netWorth: t.netWorth,
        accountCount: Number(cnt?.c ?? 0),
        policyVersion,
        createdAt: at,
      })
      .where(eq(netWorthSnapshots.id, existing.id))
      .run();
    return { id: existing.id, snapshotDate, netWorth: formatCents(t.netWorth), updated: true };
  }
  const id = newId(ID_PREFIX.netWorthSnapshot);
  ctx.db
    .insert(netWorthSnapshots)
    .values({
      id,
      ledgerId,
      snapshotDate,
      assetTotal: t.assetTotal,
      liabilityTotal: t.liabilityTotal,
      netWorth: t.netWorth,
      accountCount: Number(cnt?.c ?? 0),
      policyVersion,
      createdAt: at,
    })
    .run();
  return { id, snapshotDate, netWorth: formatCents(t.netWorth), updated: false };
}

/**
 * 补拍历史净资产快照：为最近 `months` 个**已结束**的月份（不含当月）补快照。
 * 该月已有快照则跳过（幂等）。
 *
 * 用途：用户第一次打开报表、历史月份为空时，一键补齐最近 12 个月窗，
 * 让面积图立刻有「趋势」可看；之后由定时任务每月末自动续拍。
 * 只覆盖图表展示的 12 个月窗，避免无谓的远年回填。
 */
export function backfillNetWorthSnapshots(
  ctx: AppCtx,
  ledgerId: string,
  months = 12,
): { created: number; skipped: number } {
  const now = new Date();
  let created = 0;
  let skipped = 0;
  for (let i = months - 1; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const r = monthRange(d.getFullYear(), d.getMonth() + 1); // r.to = 该月末
    const existing = ctx.db
      .select({ id: netWorthSnapshots.id })
      .from(netWorthSnapshots)
      .where(
        and(
          eq(netWorthSnapshots.ledgerId, ledgerId),
          eq(netWorthSnapshots.snapshotDate, r.to),
        ),
      )
      .get();
    if (existing) {
      skipped++;
      continue;
    }
    captureNetWorthSnapshot(
      ctx,
      ledgerId,
      r.to,
      currentPolicy(ctx, ledgerId) || DEFAULT_POLICY_VERSION,
    );
    created++;
  }
  return { created, skipped };
}

/* ------------------------------------------------------------------ *
 * S-11 同比 + 事件标注
 * ------------------------------------------------------------------ */

export function yearOverYear(
  ctx: AppCtx,
  ledgerId: string,
  year: number,
  month: number,
  keyword?: string,
  /** 账户 / 分类 / 类型 三维筛选（可选），与去年同期口径一致 */
  filters?: TxFilters,
) {
  const r = monthRange(year, month);
  const ly = lastYearRange(r.from, r.to);
  const cur = periodFlow(ctx, ledgerId, r.from, r.to, keyword, filters);
  const prev = periodFlow(ctx, ledgerId, ly.from, ly.to, keyword, filters);
  const curDays = daysBetween(r.from, r.to);
  const prevDays = daysBetween(ly.from, ly.to);
  const cats = byCategoryIn(ctx, ledgerId, r.from, r.to, keyword);
  const prevCats = byCategoryIn(ctx, ledgerId, ly.from, ly.to, keyword);
  const prevMap = new Map(prevCats.map((c) => [c.categoryId ?? '', parseAmountToCents(c.amount)]));

  return {
    current: { from: r.from, to: r.to, days: curDays, ...centsOf(cur) },
    lastYear: { from: ly.from, to: ly.to, days: prevDays, ...centsOf(prev) },
    expense: {
      amountChangeRate: rate(cur.expense, prev.expense),
      dailyChangeRate: rate(Math.round(cur.expense / curDays), Math.round(prev.expense / prevDays)),
    },
    /** 每个分类的同比 —— 用户真正想问的是「哪个分类涨了」 */
    categories: cats.slice(0, 10).map((c) => {
      const before = prevMap.get(c.categoryId ?? '') ?? 0;
      return { ...c, lastYearAmount: formatCents(before), changeRate: rate(parseAmountToCents(c.amount), before) };
    }),
    /** 同期事件标注：让「涨 60% 是因为装修」这种解释有出处 */
    events: listEvents(ctx, ledgerId, r.from, r.to),
  };
}

export function listEvents(ctx: AppCtx, ledgerId: string, from?: string, to?: string) {
  const conds = [eq(statEvents.ledgerId, ledgerId)];
  if (from) conds.push(gte(statEvents.eventDate, from));
  if (to) conds.push(lte(statEvents.eventDate, to));
  return ctx.db
    .select()
    .from(statEvents)
    .where(and(...conds))
    .orderBy(asc(statEvents.eventDate))
    .all()
    .map((e) => ({
      id: e.id,
      eventDate: e.eventDate,
      title: e.title,
      note: e.note,
      expectedAmount: e.expectedAmount === null ? null : formatCents(e.expectedAmount),
      tagId: e.tagId,
    }));
}

export function createEvent(
  ctx: AppCtx,
  ledgerId: string,
  userId: string,
  input: { eventDate: string; title: string; note?: string | null; expectedAmount?: string | number | null; tagId?: string | null },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate)) {
    throw HttpError.validation([{ field: 'eventDate', message: '日期格式应为 YYYY-MM-DD' }]);
  }
  const title = (input.title ?? '').trim();
  if (!title) throw HttpError.validation([{ field: 'title', message: '事件标题不能为空' }]);
  const id = newId(ID_PREFIX.statEvent);
  const at = nowIso();
  ctx.db
    .insert(statEvents)
    .values({
      id,
      ledgerId,
      eventDate: input.eventDate,
      title,
      note: input.note ?? null,
      expectedAmount:
        input.expectedAmount === undefined || input.expectedAmount === null
          ? null
          : parseAmountToCents(input.expectedAmount),
      tagId: input.tagId ?? null,
      createdBy: userId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return { id, eventDate: input.eventDate, title };
}

export function deleteEvent(ctx: AppCtx, ledgerId: string, id: string) {
  const row = ctx.db
    .select({ id: statEvents.id })
    .from(statEvents)
    .where(and(eq(statEvents.id, id), eq(statEvents.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('事件不存在');
  ctx.db.delete(statEvents).where(eq(statEvents.id, id)).run();
  return { id, deleted: true };
}

/* ------------------------------------------------------------------ *
 * S-12 自定义报表
 * ------------------------------------------------------------------ */

export interface ReportConfig {
  groupBy: Array<'category' | 'account' | 'tag' | 'month' | 'day'>;
  metrics: Array<'expense' | 'income' | 'net' | 'count'>;
  range?: { from?: string; to?: string };
  recordType?: 'expense' | 'income';
  filters?: { categoryIds?: string[]; accountIds?: string[]; tagIds?: string[] };
}

/** 内置预设。钱迹的教训是「配一次十分钟」，所以默认必须给能直接用的。 */
export const BUILTIN_REPORTS: Array<{ name: string; config: ReportConfig }> = [
  {
    name: '月度分类支出',
    config: { groupBy: ['category'], metrics: ['expense', 'count'], recordType: 'expense' },
  },
  {
    name: '账户收支对照',
    config: { groupBy: ['account'], metrics: ['expense', 'income', 'net'] },
  },
  {
    name: '月度趋势',
    config: { groupBy: ['month'], metrics: ['expense', 'income', 'net'] },
  },
];

export function listReports(ctx: AppCtx, ledgerId: string) {
  return ctx.db
    .select()
    .from(savedReports)
    .where(eq(savedReports.ledgerId, ledgerId))
    .orderBy(asc(savedReports.sortOrder), asc(savedReports.createdAt))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      config: safeJson<ReportConfig>(r.configJson, { groupBy: [], metrics: [] }),
      isBuiltin: r.isBuiltin,
      sortOrder: r.sortOrder,
    }));
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function createReport(
  ctx: AppCtx,
  ledgerId: string,
  userId: string,
  input: { name: string; config: ReportConfig; sortOrder?: number },
) {
  const name = (input.name ?? '').trim();
  if (!name) throw HttpError.validation([{ field: 'name', message: '报表名称不能为空' }]);
  validateConfig(input.config);
  const id = newId(ID_PREFIX.savedReport);
  const at = nowIso();
  ctx.db
    .insert(savedReports)
    .values({
      id,
      ledgerId,
      name,
      configJson: JSON.stringify(input.config),
      isBuiltin: false,
      sortOrder: input.sortOrder ?? 0,
      createdBy: userId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return { id, name };
}

function validateConfig(c: ReportConfig | undefined): void {
  if (!c || !Array.isArray(c.groupBy) || c.groupBy.length === 0) {
    throw HttpError.validation([{ field: 'config.groupBy', message: '至少要选一个分组维度' }]);
  }
  if (!Array.isArray(c.metrics) || c.metrics.length === 0) {
    throw HttpError.validation([{ field: 'config.metrics', message: '至少要选一个指标' }]);
  }
}

export function updateReport(
  ctx: AppCtx,
  ledgerId: string,
  id: string,
  input: { name?: string; config?: ReportConfig; sortOrder?: number },
) {
  const row = ctx.db
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.id, id), eq(savedReports.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('报表不存在');
  if (row.isBuiltin) throw HttpError.business('内置预设不能修改，请复制后另存');
  if (input.config) validateConfig(input.config);
  ctx.db
    .update(savedReports)
    .set({
      name: input.name?.trim() || row.name,
      configJson: input.config ? JSON.stringify(input.config) : row.configJson,
      sortOrder: input.sortOrder ?? row.sortOrder,
      updatedAt: nowIso(),
    })
    .where(eq(savedReports.id, id))
    .run();
  return { id, updated: true };
}

export function deleteReport(ctx: AppCtx, ledgerId: string, id: string) {
  const row = ctx.db
    .select({ id: savedReports.id, isBuiltin: savedReports.isBuiltin })
    .from(savedReports)
    .where(and(eq(savedReports.id, id), eq(savedReports.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('报表不存在');
  if (row.isBuiltin) throw HttpError.business('内置预设不能删除');
  ctx.db.delete(savedReports).where(eq(savedReports.id, id)).run();
  return { id, deleted: true };
}

/** 执行报表配置。只支持单维度分组 —— 多维度交叉会让结果行数爆炸且难读。 */
export function runReport(ctx: AppCtx, ledgerId: string, config: ReportConfig) {
  validateConfig(config);
  const r = config.range ?? {};
  const to = r.to ?? todayStr();
  const from = r.from ?? `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-01`;
  const dim = config.groupBy[0]!;

  const conds = [aliveTx(ledgerId)!, gte(transactions.txDate, from), lte(transactions.txDate, to)];
  if (config.recordType) conds.push(eq(transactions.recordType, config.recordType));
  else conds.push(isFlow());
  if (config.filters?.categoryIds?.length) {
    conds.push(inArray(transactions.categoryId, config.filters.categoryIds));
  }
  if (config.filters?.accountIds?.length) {
    conds.push(inArray(transactions.accountId, config.filters.accountIds));
  }
  if (config.filters?.tagIds?.length) {
    for (const t of config.filters.tagIds) {
      conds.push(
        sql`exists (select 1 from transaction_tags tt where tt.transaction_id = ${transactions.id} and tt.tag_id = ${t})`,
      );
    }
  }

  const groupExpr =
    dim === 'category'
      ? sql`coalesce(${transactions.categoryId}, '__none__')`
      : dim === 'account'
        ? sql`${transactions.accountId}`
        : dim === 'month'
          ? sql`substr(${transactions.txDate}, 1, 7)`
          : dim === 'day'
            ? sql`${transactions.txDate}`
            : sql`${transactions.txDate}`;

  const rows = ctx.db
    .select({
      k: groupExpr,
      expense: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'expense' then ${transactions.actualAmount} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'income' then ${transactions.actualAmount} else 0 end), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...conds))
    .groupBy(groupExpr)
    .orderBy(desc(sql`sum(${transactions.actualAmount})`))
    .all();

  const nameOf = nameResolver(ctx, dim, rows.map((x) => String(x.k)));

  return {
    from,
    to,
    dimension: dim,
    rows: rows.map((x) => {
      const key = String(x.k);
      const net = Number(x.income) - Number(x.expense);
      const out: Record<string, unknown> = { key, label: nameOf(key) };
      if (config.metrics.includes('expense')) out.expense = formatCents(Number(x.expense));
      if (config.metrics.includes('income')) out.income = formatCents(Number(x.income));
      if (config.metrics.includes('net')) out.net = formatCents(net);
      if (config.metrics.includes('count')) out.count = Number(x.cnt);
      return out;
    }),
  };
}

function nameResolver(ctx: AppCtx, dim: string, keys: string[]): (k: string) => string {
  if (dim === 'category') {
    const m = new Map<string, string>();
    const ids = keys.filter((k) => k !== '__none__');
    if (ids.length) {
      for (const c of ctx.db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(inArray(categories.id, ids))
        .all()) {
        m.set(c.id, c.name);
      }
    }
    return (k) => (k === '__none__' ? '未分类' : (m.get(k) ?? k));
  }
  if (dim === 'account') {
    const m = new Map<string, string>();
    for (const a of ctx.db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(inArray(accounts.id, keys))
      .all()) {
      m.set(a.id, a.name);
    }
    return (k) => m.get(k) ?? k;
  }
  return (k) => k;
}

/* ------------------------------------------------------------------ *
 * S-13 报表导出（CSV）
 * ------------------------------------------------------------------ */

/**
 * 导出为 CSV 字符串。
 *
 * 两个刻意的选择：
 * ① 带 UTF-8 BOM —— Excel 默认按本地编码打开，没有 BOM 中文全是乱码，
 *    而「导出打不开」是最差的一种体验；
 * ② 字段用 RFC 4180 转义（双引号翻倍），备注里的逗号/换行不能把列冲掉。
 */
export function exportCsv(ctx: AppCtx, ledgerId: string, q: DrilldownQuery): string {
  const res = drilldown(ctx, ledgerId, { ...q, limit: 500, offset: 0 });
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ['日期', '类型', '金额', '名称', '商户', '账户', '分类', '备注'];
  const lines = [head.map(cell).join(',')];
  for (const r of res.rows) {
    lines.push(
      [
        r.txDate,
        r.recordType === 'expense' ? '支出' : r.recordType === 'income' ? '收入' : r.recordType,
        r.amount,
        r.name,
        r.merchant,
        r.accountName,
        r.categoryName,
        r.note,
      ]
        .map(cell)
        .join(','),
    );
  }
  lines.push([cell('合计'), cell(''), cell(res.totalAmount), cell(`${res.totalCount} 笔`)].join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * S-14 日历热力图
 * ------------------------------------------------------------------ */

/**
 * 单日支出强度。
 *
 * 分级用**当月日支出的分位数**而不是固定金额阈值 ——
 * 月花 3000 的人和月花 30000 的人看到的「红」应该是不同的红，
 * 固定阈值会让前者全年一片绿、后者全年一片红，等于没有信息。
 */
export function heatmap(ctx: AppCtx, ledgerId: string, year: number, month?: number) {
  const from = `${year}-${pad(month ?? 1)}-01`;
  const to = month
    ? `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`
    : `${year}-12-31`;
  const rows = ctx.db
    .select({
      d: transactions.txDate,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        aliveTx(ledgerId)!,
        eq(transactions.recordType, 'expense'),
        gte(transactions.txDate, from),
        lte(transactions.txDate, to),
      ),
    )
    .groupBy(transactions.txDate)
    .all();
  const vals = rows.map((r) => Number(r.total)).sort((a, b) => a - b);
  const q = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))]! : 0);
  const t1 = q(0.33);
  const t2 = q(0.66);
  const t3 = q(0.9);
  const level = (v: number) => (v === 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
  return {
    year,
    month: month ?? null,
    thresholds: [t1, t2, t3].map((v) => formatCents(v)),
    days: rows.map((r) => ({
      date: r.d,
      amount: formatCents(Number(r.total)),
      count: Number(r.cnt),
      level: level(Number(r.total)),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * S-15 结论式报表（含量价差异归因）
 * ------------------------------------------------------------------ */

/**
 * 自动生成文字结论。
 *
 * 「图表多结论少」是国内记账 App 的通病。这里刻意只输出**可行动**的结论：
 * 每条都带 `severity` 与 `action`，避免变成又一张图表的数据罗列。
 */
export function insights(ctx: AppCtx, ledgerId: string, from?: string, to?: string) {
  const t = to ?? todayStr();
  const f = from ?? `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-01`;
  const prev = previousRange(f, t);
  const out: Array<{ id: string; severity: 'info' | 'warn' | 'alert'; text: string; action: string }> = [];

  const curCats = byCategoryIn(ctx, ledgerId, f, t);
  const prevCats = byCategoryIn(ctx, ledgerId, prev.from, prev.to);
  const prevMap = new Map(prevCats.map((c) => [c.categoryId ?? '', c]));

  /* --- 涨幅最大的分类，并做量价拆分 --- */
  let top: { name: string; delta: number; qtyEffect: number; priceEffect: number; rate: number } | null = null;
  for (const c of curCats) {
    const before = prevMap.get(c.categoryId ?? '');
    const beforeAmt = before ? parseAmountToCents(before.amount) : 0;
    const delta = parseAmountToCents(c.amount) - beforeAmt;
    if (beforeAmt <= 0 || delta <= 0) continue;
    const r = rate(parseAmountToCents(c.amount), beforeAmt);
    if (r === null) continue;
    // 量价拆分：Δ = (n1−n0)·p0 + n1·(p1−p0)
    const n0 = before?.count ?? 0;
    const n1 = c.count;
    const p0 = n0 > 0 ? beforeAmt / n0 : 0;
    const p1 = n1 > 0 ? parseAmountToCents(c.amount) / n1 : 0;
    const qtyEffect = Math.round((n1 - n0) * p0);
    const priceEffect = Math.round(n1 * (p1 - p0));
    if (!top || r > top.rate) {
      top = { name: c.categoryName ?? '未分类', delta, qtyEffect, priceEffect, rate: r };
    }
  }
  if (top !== null && top.rate >= 20) {
    const driver =
      Math.abs(top.qtyEffect) >= Math.abs(top.priceEffect)
        ? `次数多了 ${formatCents(Math.abs(top.qtyEffect))}`
        : `单次均价涨了 ${formatCents(Math.abs(top.priceEffect))}`;
    out.push({
      id: 'category-surge',
      severity: top.rate >= 50 ? 'alert' : 'warn',
      text: `「${top.name}」比上期多 ${formatCents(top.delta)}（+${top.rate}%），主因是${driver}。`,
      action: 'drilldown',
    });
  }

  /* --- 异常大额单笔 --- */
  const all = ctx.db
    .select({ t: transactions.actualAmount, n: transactions.name, d: transactions.txDate })
    .from(transactions)
    .where(
      and(
        aliveTx(ledgerId)!,
        eq(transactions.recordType, 'expense'),
        gte(transactions.txDate, f),
        lte(transactions.txDate, t),
      ),
    )
    .orderBy(desc(transactions.actualAmount))
    .limit(50)
    .all();
  if (all.length >= 5) {
    const median = all[Math.floor(all.length / 2)]!.t;
    const big = all[0]!;
    if (median > 0 && big.t >= median * 8) {
      out.push({
        id: 'outlier',
        severity: 'info',
        text: `单笔最大支出 ${formatCents(big.t)}（${big.d} ${big.n ?? ''}），是本期中位数的 ${Math.round(big.t / median)} 倍。`,
        action: 'drilldown',
      });
    }
  }

  /* --- 连续零支出天数 --- */
  const days = dailySeries(ctx, ledgerId, f, t);
  const active = new Set(days.filter((d) => parseAmountToCents(d.expense) > 0).map((d) => d.date));
  const total = daysBetween(f, t);
  let idle = 0;
  for (let i = 0; i < total; i++) {
    const d = shiftDate(f, i);
    if (d > t) break;
    if (!active.has(d)) idle++;
  }
  if (total >= 7 && idle === 0) {
    out.push({ id: 'no-idle', severity: 'info', text: '本期每天都有支出记录，记账连续性很好。', action: 'none' });
  }

  if (!out.length) {
    out.push({ id: 'calm', severity: 'info', text: '本期支出结构平稳，没有明显异常。', action: 'none' });
  }
  return { from: f, to: t, insights: out };
}

/* ------------------------------------------------------------------ *
 * S-16 / R-12 / X-07 订阅与重复扣费识别
 * ------------------------------------------------------------------ */

/**
 * 识别周期性扣款。
 *
 * 指纹 = `merchant|金额(分)|周期类型`。金额必须**完全一致**才算同一订阅 ——
 * 视频会员连续 3 个月都是 25.00，而「本月打车 3 次 25 元」不会次次同额。
 * 这条约束是准确率的关键：放宽到「金额相近」会立刻引入大量误报。
 */
export function detectSubscriptions(ctx: AppCtx, ledgerId: string, months = 12) {
  const to = todayStr();
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const rows = ctx.db
    .select({
      merchant: transactions.merchant,
      name: transactions.name,
      amount: transactions.actualAmount,
      dates: sql<string>`group_concat(${transactions.txDate})`,
      cnt: sql<number>`count(*)`,
      lastTxId: transactions.id,
    })
    .from(transactions)
    .where(
      and(
        aliveTx(ledgerId)!,
        eq(transactions.recordType, 'expense'),
        sql`coalesce(${transactions.merchant}, ${transactions.name}) is not null`,
        gte(transactions.txDate, from),
        lte(transactions.txDate, to),
      ),
    )
    .groupBy(sql`coalesce(${transactions.merchant}, ${transactions.name})`, transactions.actualAmount)
    .all();

  const confirmed = new Map(
    ctx.db
      .select()
      .from(recurringDetections)
      .where(eq(recurringDetections.ledgerId, ledgerId))
      .all()
      .map((r) => [r.fingerprint, r]),
  );

  const out: Array<{
    fingerprint: string;
    merchant: string;
    amount: string;
    occurrenceCount: number;
    periodType: string;
    firstSeen: string;
    lastSeen: string;
    /** 平均间隔天数与抖动，用于判断「够不够规律」 */
    avgIntervalDays: number;
    jitterDays: number;
    annualCost: string;
    status: string;
    userLabel: string | null;
  }> = [];

  for (const r of rows) {
    const n = Number(r.cnt);
    if (n < 2) continue;
    const dates = String(r.dates ?? '')
      .split(',')
      .filter(Boolean)
      .sort();
    if (dates.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1]!, dates[i]!));
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const jitter = Math.max(...gaps.map((g) => Math.abs(g - avg)));
    // 抖动超过 7 天就谈不上「固定周期」
    if (jitter > 7) continue;
    const periodType = avg <= 10 ? 'weekly' : avg <= 45 ? 'monthly' : avg <= 120 ? 'quarterly' : 'yearly';
    const merchant = r.merchant ?? r.name ?? '(未命名)';
    const fp = `${merchant}|${r.amount}|${periodType}`;
    const known = confirmed.get(fp);
    const perYear = periodType === 'weekly' ? 52 : periodType === 'monthly' ? 12 : periodType === 'quarterly' ? 4 : 1;
    out.push({
      fingerprint: fp,
      merchant,
      amount: formatCents(r.amount),
      occurrenceCount: n,
      periodType,
      firstSeen: dates[0]!,
      lastSeen: dates[dates.length - 1]!,
      avgIntervalDays: Math.round(avg * 10) / 10,
      jitterDays: Math.round(jitter),
      annualCost: formatCents(r.amount * perYear),
      status: known?.status ?? 'candidate',
      userLabel: known?.userLabel ?? null,
    });
  }
  out.sort((a, b) => parseAmountToCents(b.annualCost) - parseAmountToCents(a.annualCost));
  return out;
}

export function confirmSubscription(
  ctx: AppCtx,
  ledgerId: string,
  input: {
    fingerprint: string;
    merchant: string;
    periodType: string;
    amount: string | number;
    firstSeen: string;
    lastSeen: string;
    occurrenceCount: number;
    userLabel?: string | null;
  },
) {
  return upsertDetection(ctx, ledgerId, input, 'confirmed');
}

/** 用户忽略后必须记下来 —— 否则每次刷新都弹同一个提醒，那不是提醒，是骚扰。 */
export function ignoreSubscription(ctx: AppCtx, ledgerId: string, input: Parameters<typeof confirmSubscription>[2]) {
  return upsertDetection(ctx, ledgerId, input, 'ignored');
}

function upsertDetection(
  ctx: AppCtx,
  ledgerId: string,
  input: Parameters<typeof confirmSubscription>[2],
  status: 'confirmed' | 'ignored',
) {
  const existing = ctx.db
    .select({ id: recurringDetections.id })
    .from(recurringDetections)
    .where(
      and(
        eq(recurringDetections.ledgerId, ledgerId),
        eq(recurringDetections.fingerprint, input.fingerprint),
      ),
    )
    .get();
  const at = nowIso();
  if (existing) {
    ctx.db
      .update(recurringDetections)
      .set({ status, userLabel: input.userLabel ?? null, updatedAt: at })
      .where(eq(recurringDetections.id, existing.id))
      .run();
    return { id: existing.id, status };
  }
  const id = newId(ID_PREFIX.recurringDetection);
  ctx.db
    .insert(recurringDetections)
    .values({
      id,
      ledgerId,
      fingerprint: input.fingerprint,
      merchant: input.merchant,
      periodType: input.periodType,
      amount: parseAmountToCents(input.amount),
      firstSeen: input.firstSeen,
      lastSeen: input.lastSeen,
      occurrenceCount: input.occurrenceCount,
      status,
      userLabel: input.userLabel ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return { id, status };
}

/* ------------------------------------------------------------------ *
 * S-17 现金流三分类
 * ------------------------------------------------------------------ */

/**
 * 经营 / 投资 / 筹资三分类现金流。
 *
 * 未归类（`cash_flow is null`）按**经营**处理，但**必须披露覆盖率** ——
 * 静默假定会让现金流表看起来完整，而实际有一部分是猜的。
 * 这是本项目一贯的态度：宁可显示「覆盖率 62%」，也不要一张假装完整的表。
 */
export function cashFlowStatement(ctx: AppCtx, ledgerId: string, from: string, to: string) {
  const rows = ctx.db
    .select({
      cf: categories.cashFlow,
      recordType: transactions.recordType,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(aliveTx(ledgerId)!, isFlow(), gte(transactions.txDate, from), lte(transactions.txDate, to)),
    )
    .groupBy(categories.cashFlow, transactions.recordType)
    .all();

  const bucket = (cf: string | null) => (cf === 'investing' || cf === 'financing' ? cf : 'operating');
  const acc = {
    operating: { inflow: 0, outflow: 0 },
    investing: { inflow: 0, outflow: 0 },
    financing: { inflow: 0, outflow: 0 },
  };
  let classified = 0;
  let total = 0;
  for (const r of rows) {
    const b = bucket(r.cf);
    const amt = Number(r.total);
    total += amt;
    if (r.cf) classified += amt;
    if (r.recordType === 'income') acc[b].inflow += amt;
    else acc[b].outflow += amt;
  }
  const line = (k: keyof typeof acc) => ({
    section: k,
    inflow: formatCents(acc[k].inflow),
    outflow: formatCents(acc[k].outflow),
    net: formatCents(acc[k].inflow - acc[k].outflow),
  });
  return {
    from,
    to,
    sections: [line('operating'), line('investing'), line('financing')],
    netCashFlow: formatCents(
      acc.operating.inflow - acc.operating.outflow +
        acc.investing.inflow - acc.investing.outflow +
        acc.financing.inflow - acc.financing.outflow,
    ),
    /**
     * 归类覆盖率。低于 80% 时前端应提示「部分分类未设置现金流属性」，
     * 而不是让用户以为这张表已经完整。
     */
    coverageRate: total > 0 ? Math.round((classified / total) * 1000) / 10 : 100,
  };
}

/* ------------------------------------------------------------------ *
 * X-05 口径版本化
 * ------------------------------------------------------------------ */

export const DEFAULT_POLICY_VERSION = 'v1';

export function currentPolicy(ctx: AppCtx, ledgerId: string): string {
  const row = ctx.db
    .select({ version: statsPolicyVersions.version })
    .from(statsPolicyVersions)
    .where(eq(statsPolicyVersions.ledgerId, ledgerId))
    .orderBy(desc(statsPolicyVersions.effectiveFrom))
    .limit(1)
    .get();
  return row?.version ?? DEFAULT_POLICY_VERSION;
}

export function listPolicyVersions(ctx: AppCtx, ledgerId: string) {
  return ctx.db
    .select()
    .from(statsPolicyVersions)
    .where(eq(statsPolicyVersions.ledgerId, ledgerId))
    .orderBy(desc(statsPolicyVersions.effectiveFrom))
    .all()
    .map((r) => ({
      version: r.version,
      effectiveFrom: r.effectiveFrom,
      changes: safeJson<unknown[]>(r.changesJson, []),
      note: r.note,
      createdAt: r.createdAt,
    }));
}

/**
 * 新增口径版本。
 *
 * ⚠️ **历史不回溯重算**（X-05 的核心）：新口径只对 `effectiveFrom` 之后的数据生效。
 * 用户在 3 月看到的「2 月支出 3000」，不该因为 4 月改了口径变成 3200，
 * 那会让所有历史报表失去可信度。
 */
export function createPolicyVersion(
  ctx: AppCtx,
  ledgerId: string,
  userId: string,
  input: { version: string; effectiveFrom: string; changes: unknown[]; note?: string | null },
) {
  const v = (input.version ?? '').trim();
  if (!v) throw HttpError.validation([{ field: 'version', message: '口径版本号不能为空' }]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    throw HttpError.validation([{ field: 'effectiveFrom', message: '日期格式应为 YYYY-MM-DD' }]);
  }
  const dup = ctx.db
    .select({ version: statsPolicyVersions.version })
    .from(statsPolicyVersions)
    .where(
      and(
        eq(statsPolicyVersions.ledgerId, ledgerId),
        eq(statsPolicyVersions.version, v),
      ),
    )
    .get();
  if (dup) throw HttpError.duplicate('该口径版本已存在');
  ctx.db
    .insert(statsPolicyVersions)
    .values({
      version: v,
      ledgerId,
      effectiveFrom: input.effectiveFrom,
      changesJson: JSON.stringify(input.changes ?? []),
      note: input.note ?? null,
      createdBy: userId,
      createdAt: nowIso(),
    })
    .run();
  return { version: v, effectiveFrom: input.effectiveFrom };
}

/* ------------------------------------------------------------------ *
 * X-06 报销冲减
 * ------------------------------------------------------------------ */

/**
 * 报销冲减原分类支出（不计收入）。
 *
 * 先垫付 500（记入「差旅」支出），后公司报销 500 到账 ——
 * 这笔钱**从未是收入**，它是资产（应收报销款）的收回。
 * 若记成收入：本月支出仍是 500、收入多 500，净结余看起来一样，
 * 但分类支出虚高，预算与分类统计全错。
 */
export function createReimbursement(
  ctx: AppCtx,
  ledgerId: string,
  userId: string,
  input: {
    originTxId: string;
    receivedTxId: string;
    amount: string | number;
    claimDate: string;
    receivedDate: string;
    orgName?: string | null;
    note?: string | null;
  },
) {
  const origin = ctx.db
    .select({ id: transactions.id, recordType: transactions.recordType, actualAmount: transactions.actualAmount })
    .from(transactions)
    .where(and(eq(transactions.id, input.originTxId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!origin) throw HttpError.notFound('原始支出不存在');
  if (origin.recordType !== 'expense') {
    throw HttpError.business('报销只能冲减支出类账单');
  }
  const received = ctx.db
    .select({ id: transactions.id, recordType: transactions.recordType })
    .from(transactions)
    .where(and(eq(transactions.id, input.receivedTxId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!received) throw HttpError.notFound('报销到账记录不存在，请先记一笔收款');
  if (received.recordType !== 'income') {
    throw HttpError.business('报销到账必须是一笔收入账单（钱真的进来了）');
  }

  const cents = parseAmountToCents(input.amount);
  if (cents <= 0) throw HttpError.validation([{ field: 'amount', message: '报销金额必须大于 0' }]);
  if (cents > origin.actualAmount) {
    throw HttpError.business('报销金额不能超过原始支出');
  }
  const dup = ctx.db
    .select({ id: reimbursements.id })
    .from(reimbursements)
    .where(
      and(
        eq(reimbursements.originTxId, input.originTxId),
        eq(reimbursements.status, 'confirmed'),
      ),
    )
    .get();
  if (dup) throw HttpError.duplicate('这笔支出已经登记过报销');

  const id = newId(ID_PREFIX.reimbursement);
  const at = nowIso();
  ctx.db
    .insert(reimbursements)
    .values({
      id,
      ledgerId,
      originTxId: input.originTxId,
      receivedTxId: input.receivedTxId,
      amount: cents,
      claimDate: input.claimDate,
      receivedDate: input.receivedDate,
      orgName: input.orgName ?? null,
      note: input.note ?? null,
      status: 'confirmed',
      createdBy: userId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return { id, amount: formatCents(cents) };
}

export function listReimbursements(ctx: AppCtx, ledgerId: string, from?: string, to?: string) {
  const conds = [eq(reimbursements.ledgerId, ledgerId)];
  if (from) conds.push(gte(reimbursements.receivedDate, from));
  if (to) conds.push(lte(reimbursements.receivedDate, to));
  return ctx.db
    .select()
    .from(reimbursements)
    .where(and(...conds))
    .orderBy(desc(reimbursements.receivedDate))
    .all()
    .map((r) => ({
      id: r.id,
      originTxId: r.originTxId,
      receivedTxId: r.receivedTxId,
      amount: formatCents(r.amount),
      claimDate: r.claimDate,
      receivedDate: r.receivedDate,
      orgName: r.orgName,
      status: r.status,
    }));
}

export function voidReimbursement(ctx: AppCtx, ledgerId: string, id: string) {
  const row = ctx.db
    .select({ id: reimbursements.id, status: reimbursements.status })
    .from(reimbursements)
    .where(and(eq(reimbursements.id, id), eq(reimbursements.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('报销记录不存在');
  if (row.status === 'void') throw HttpError.business('该报销已作废');
  ctx.db
    .update(reimbursements)
    .set({ status: 'void', updatedAt: nowIso() })
    .where(eq(reimbursements.id, id))
    .run();
  return { id, status: 'void' };
}

/**
 * 各分类在期间内被报销冲减的金额。
 * 报表侧要用它把「已报销垫付」从支出里扣掉，否则差旅分类永远虚高。
 */
export function reimbursedByCategory(ctx: AppCtx, ledgerId: string, from: string, to: string) {
  const rows = ctx.db
    .select({
      categoryId: transactions.categoryId,
      total: sql<number>`coalesce(sum(${reimbursements.amount}), 0)`,
    })
    .from(reimbursements)
    .innerJoin(transactions, eq(reimbursements.originTxId, transactions.id))
    .where(
      and(
        eq(reimbursements.ledgerId, ledgerId),
        eq(reimbursements.status, 'confirmed'),
        gte(reimbursements.receivedDate, from),
        lte(reimbursements.receivedDate, to),
      ),
    )
    .groupBy(transactions.categoryId)
    .all();
  return new Map(rows.map((r) => [r.categoryId ?? '__none__', Number(r.total)]));
}

/** 带报销冲减的分类支出（X-06 的消费出口） */
export function categoryExpenseNetOfReimbursement(
  ctx: AppCtx,
  ledgerId: string,
  from: string,
  to: string,
) {
  const gross = byCategoryIn(ctx, ledgerId, from, to);
  const reb = reimbursedByCategory(ctx, ledgerId, from, to);
  return gross.map((c) => {
    const cut = reb.get(c.categoryId ?? '__none__') ?? 0;
    return {
      ...c,
      reimbursed: formatCents(cut),
      netAmount: formatCents(Math.max(0, parseAmountToCents(c.amount) - cut)),
    };
  });
}

/* ==================================================================== *
 * 报表页（docs/15 + 主流记账 App 对标）新增的三个聚合维度
 *
 * 这三个不是「锦上添花」：它们回答的是三类**只有分组才能回答**的问题，
 * 而这三问在流水列表里都无解（列表是按时间排的，不是按人/星期/账户）。
 *
 * ① 成员消费 —— 「家里谁在花」。`transactions.created_by` 是记录人，
 *    不是「消费的人」，这一点必须在返回里说清楚（见 memberLabel 的注释）：
 *    把它当「谁花的」会得出错误结论，而界面上看不出来。
 * ② 星期分布 —— 「我哪天花钱多」。用于发现「周末报复性消费」这类模式，
 *    它只能靠按星期分桶看出来。
 * ③ 账户期初/期末 —— 「这张卡这个月进出多少、剩多少」。
 *    期初/期末必须用**同一个余额函数**算，否则会与账户页对不上。
 * ==================================================================== */

/**
 * 成员维度的收支。
 *
 * ⚠️ 口径声明（必须在界面上同步给用户）：`created_by` 是**记录人**，
 *    不是「消费的人」。单人是唯一记录人时两者重合，多人账本里它表示
 *    「谁记的这笔」。所以字段名用 `memberId` / `memberName`，
 *    但返回里额外给 `isRecorder: true` 让前端能标注清楚。
 *
 * 没有 `created_by`（历史数据、导入数据）的账单归入「未署名」而不是丢弃 ——
 * 丢弃会让「总额比列表加起来少一块」，那是用户一眼能发现的错。
 */
export function byMember(
  ctx: AppCtx,
  ledgerId: string,
  from: string,
  to: string,
  keyword?: string,
) {
  const kwCond = keywordCondition(keyword);
  const rows = ctx.db
    .select({
      userId: transactions.createdBy,
      expense: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'expense' then ${transactions.actualAmount} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'income' then ${transactions.actualAmount} else 0 end), 0)`,
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
    .groupBy(transactions.createdBy)
    .all();

  const ids = rows.map((r) => r.userId).filter((x): x is string => Boolean(x));
  const users = ids.length
    ? ctx.db
        .select({ id: users2.id, nickname: users2.nickname })
        .from(users2)
        .where(inArray(users2.id, ids))
        .all()
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.nickname]));
  /**
   * 昵称覆盖（`ledger_members.nickname_override`）：同一个人在不同账本里
   * 可能有不同称呼（家庭账本里叫「妈妈」）。统计页要显示**这个账本里**的称呼。
   */
  const overrides = ids.length
    ? ctx.db
        .select({ userId: ledgerMembers.userId, nick: ledgerMembers.nicknameOverride })
        .from(ledgerMembers)
        .where(and(eq(ledgerMembers.ledgerId, ledgerId), inArray(ledgerMembers.userId, ids)))
        .all()
    : [];
  const overrideById = new Map(
    overrides.filter((o) => o.nick).map((o) => [o.userId, o.nick as string]),
  );

  return rows
    .map((r) => ({
      memberId: r.userId ?? '__none__',
      memberName: r.userId
        ? (overrideById.get(r.userId) ?? nameById.get(r.userId) ?? '未知成员')
        : '未署名',
      expense: formatCents(Number(r.expense ?? 0)),
      income: formatCents(Number(r.income ?? 0)),
      net: formatCents(Number(r.income ?? 0) - Number(r.expense ?? 0)),
      count: Number(r.cnt ?? 0),
      /** 这个数字是「记录人」口径，不是消费人口径 —— 前端必须标注 */
      isRecorder: true,
    }))
    .sort((a, b) => Number(b.expense) - Number(a.expense));
}

/**
 * 星期分布（0=周日 … 6=周六，与 JS `getDay()` 一致）。
 *
 * ⚠️ 用 `strftime('%w', tx_date)` 而不是在 JS 里 `new Date(...).getDay()`：
 *    后者要先把 'YYYY-MM-DD' 解析成 Date，而不同时区下
 *    `new Date('2026-10-16')` 会被当成 **UTC 零点** —— 在 UTC+8 上
 *    `getDay()` 会返回错误的星期（差一天）。SQLite 的 strftime 直接对
 *    **日期字符串**取模，没有时区这一步，所以是正确的做法。
 *
 * 七个桶**全部返回**（含 0 支出日）：只返回有数据的星期会让柱状图
 * 少几根柱子，而「周二没花钱」正是这张图要给出的信息。
 *
 * ⚠️ 日期条件必须**只在非空时添加**：账期选「所有」时 `normalizeRange()` 返回
 * 空区间 `{from:'',to:''}`，若照写 `gte(tx_date,'') AND lte(tx_date,'')`，
 * `lte(tx_date,'')` 匹配不到任何行 —— 结果是**七个桶全是 0** 且不报错，
 * 看起来像「这周没花钱」而不是「统计坏了」。与 `service.ts` 的 `dateConds()` 同口径。
 *
 * 跨周 / 跨月 / 首末日边界：区间是闭区间（字符串比较 `>= from AND <= to`），
 * 首尾两天都计入；星期由 `strftime` 直接对**日期字符串**取模，
 * 不经过 Date 解析，因此跨周跨月都不会串位。
 */
export function weekdaySpending(
  ctx: AppCtx,
  ledgerId: string,
  from: string,
  to: string,
  keyword?: string,
) {
  const kwCond = keywordCondition(keyword);
  const rangeConds = [
    ...(from ? [gte(transactions.txDate, from)] : []),
    ...(to ? [lte(transactions.txDate, to)] : []),
  ];
  const rows = ctx.db
    .select({
      wd: sql<number>`cast(strftime('%w', ${transactions.txDate}) as integer)`,
      expense: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'expense' then ${transactions.actualAmount} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'income' then ${transactions.actualAmount} else 0 end), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        ...rangeConds,
        ...(kwCond ? [kwCond] : []),
      ),
    )
    .groupBy(sql`strftime('%w', ${transactions.txDate})`)
    .all();

  const by = new Map(rows.map((r) => [r.wd, r]));
  return [0, 1, 2, 3, 4, 5, 6].map((w) => {
    const r = by.get(w);
    return {
      weekday: w,
      label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][w],
      expense: formatCents(Number(r?.expense ?? 0)),
      income: formatCents(Number(r?.income ?? 0)),
      count: Number(r?.cnt ?? 0),
    };
  });
}

/**
 * 账户的期初 / 期末 / 本期结余。
 *
 * ## 为什么必须用 balance.ts 的同一个函数
 *
 * 「期末 − 期初」必须等于「本期流水净额」，否则用户会发现
 * 「账户页余额 1000，报表页说期末 980」。两个数字来自两套算法时
 * 这种事一定会发生，而且没有任何报错。
 *
 * 所以这里**不自己写**求和，而是调 `balanceOf()` 取两个时点的余额，
 * 让「报表页的期末」与「账户页的余额」在字面上就是同一个数字。
 *
 * ## 期初的定义
 *
 * 期初 = **区间开始前一天的收盘余额**（即 `from - 1 天` 的余额）。
 * 不是「本月 1 号 00:00」：那天本身有流水的话，取零点会把当天的账算漏。
 * 边界是 `≤`（`docs/14`），所以 `from-1` 就是「区间之前全部」。
 */
export function accountsBalance(ctx: AppCtx, ledgerId: string, from: string, to: string) {
  const accs = ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), isNull(accounts.archivedAt)))
    .all();

  // 期初 = from 的前一天收盘
  const dayBefore = shiftDays(from, -1);

  return accs
    .filter((a) => a.kind !== 'virtual')
    .map((a) => {
      const opening = parseAmountToCents(balanceView(ctx, ledgerId, a.id, dayBefore).balance);
      const closing = parseAmountToCents(balanceView(ctx, ledgerId, a.id, to).balance);
      return {
        accountId: a.id,
        name: a.name,
        type: a.type,
        kind: a.kind,
        opening: formatCents(opening),
        closing: formatCents(closing),
        net: formatCents(closing - opening),
        /** 涨跌方向：'up' | 'down' | 'flat'，前端不必再判断一次符号 */
        trend: closing > opening ? 'up' : closing < opening ? 'down' : 'flat',
      };
    })
    .sort((a, b) => Math.abs(Number(b.closing)) - Math.abs(Number(a.closing)));
}

/** 把 YYYY-MM-DD 平移 n 天（负数=往前）。用 UTC 构造再取日期串，避免本地时区偏移。 */
function shiftDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * DAY;
  return new Date(t).toISOString().slice(0, 10);
}
