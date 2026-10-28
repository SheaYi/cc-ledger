/**
 * 统计与报表（`docs/04 §十三`，Stage 12）。
 *
 * ## 口径全部来自一处
 *
 * 本模块**不重新发明**任何汇总口径，而是复用 `accounts/service.ts` 的
 * `totals()` 与 `periodFlow()`：
 *   · 金额一律取 `actual_amount`（已内含手续费/折扣）；
 *   · 净结余只认 `income − expense`，转账/应收/应付/余额调整**一律不计入**
 *     （`docs/03 §1.5`）；
 *   · 净资产只计 `include_in_total` 且**排除 `kind='virtual'`** 的虚拟台账账户。
 * 这三条是「借贷必平 / 账可被证明」原则在前端的落地，任何一处自己写 SQL 聚合
 * 都会在某次口径调整后与概览页对不上，而用户对不上的第一反应就是「这软件算错了」。
 *
 * ## 环比 / 同比的分母为 0 时返回 `null` 而不是 0
 *
 * `expenseChangeRate` 的分母是「上期支出」。上期为 0 时，百分比在数学上无意义
 * （除零）。返回 `0` 会谎称「没变」，返回 `null` 才诚实 —— 前端据此显示「—」。
 */
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { accounts, categories, transactionTags, transactions, tags } from '../../db/schema.js';
import { formatCents, today as todayStr } from '../../utils/money.js';
import { keywordCondition, txFilterConds, type TxFilters } from '../../utils/tx-filter.js';
import { periodFlow, totals } from '../accounts/service.js';
import { openDebts } from '../debts/service.js';

const pad = (n: number) => String(n).padStart(2, '0');

function monthRange(y: number, m: number): { from: string; to: string } {
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}` };
}

export interface StatsRange {
  from: string;
  to: string;
}

/** 默认区间 = 本月 1 号 → 今天（与 `accounts/summary` 一致） */
export function defaultRange(): StatsRange {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return { from: `${y}-${pad(m)}-01`, to: todayStr() };
}

function normalizeRange(from?: string, to?: string): StatsRange {
  const d = defaultRange();
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : d.from;
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : d.to;
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

/** 上一个等长区间（用于环比）。长度按自然日差。 */
function previousRange(from: string, to: string): StatsRange {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
  const pf = new Date(f);
  pf.setDate(pf.getDate() - days);
  const pt = new Date(f);
  pt.setDate(pt.getDate() - 1);
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: iso(pf), to: iso(pt) };
}

/**
 * 上一年的**同一段**（同比）。
 *
 * ⚠️ 跨闰年时要按「日序」平移，而不是简单 `setFullYear(-1)`：
 * 2024-02-29 减一年是 2023-02-29（**不存在**），JS 会把它滚到 3-01，
 * 于是那一天的账单被平白挤到区间末尾。所以先记下年内日序，再在目标年重建。
 */
function lastYearMonth(from: string, to: string): StatsRange {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  const dayOfYear = (d: Date) =>
    Math.round((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000);
  const build = (d: Date) => {
    const target = new Date(d.getFullYear() - 1, 0, 1);
    target.setDate(dayOfYear(d));
    return target;
  };
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const yf = build(f);
  const yt = build(t);
  // 目标年短于原年（2-29 落到非闰年）时，to 可能被退到 2-28 —— 这正是我们想要的
  return { from: iso(yf), to: iso(yt) };
}

/** 区间内的自然日天数（含首尾）。做日均口径时用它做分母。 */
export function daysInRange(from: string, to: string): number {
  const f = new Date(`${from}T00:00:00`).getTime();
  const t = new Date(`${to}T00:00:00`).getTime();
  return Math.max(1, Math.round((t - f) / 86_400_000) + 1);
}

/**
 * 变化率。分母为 0 时返回 `null` 而不是 `0`。
 *
 * `null` 的含义是「上期没有可比基数」，前端显示「—」。
 * 返回 `0` 会谎称「没变」，那是**比错更糟的错**：用户会以为两个人都没花钱。
 */
function rate(cur: number, prev: number): string | null {
  if (prev === 0) return null;
  return (((cur - prev) / Math.abs(prev)) * 100).toFixed(1);
}

/**
 * 日均口径的变化率 —— 这是「月比月」唯一可比的口径。
 *
 * ## 为什么必须日均
 *
 * 直接比总额时，2 月（28 天）与 3 月（31 天）之间的差异里，
 * 有 **3 天是日历造成的**，不是消费行为变化。一个每月消费完全相同的人，
 * 3 月的总额会比 2 月高 10.7%，页面却显示「支出上涨 10.7%」。
 * FRD 把这一条列为对标分析里的差异化点（`15` §5），而它同时是一个**口径错误**。
 *
 * 日均 = 总额 ÷ 该期自然日天数。日均口径下，一个消费习惯不变的人，
 * 无论在 28 天还是 31 天的月份，日均都相同。
 *
 * ⚠️ 但**总额口径不能删**：「这个月总共花了多少」是用户真正要回答的问题。
 * 两种口径都给，前端默认展示日均（可比），并保留总额供查阅。
 */
function dailyRate(curTotal: number, curDays: number, prevTotal: number, prevDays: number): string | null {
  const cur = curTotal / curDays;
  const prev = prevTotal / prevDays;
  return rate(cur, prev);
}


/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

/**
 * 账期汇总（KPI 概览卡的全部数字）。
 *
 * `keyword` 可选：命中 `name / merchant / counterparty / note` 任一即计入。
 * 三个区间（本期 / 上期 / 去年同期）**用同一个关键字** ——
 * 对比的两侧口径必须一致，否则「本期按关键字、上期不按」算出来的环比是假的。
 *
 * ⚠️ 余额类字段（`totalAssets` / `netAssets` 等）来自 `totals()`，
 * 那是**账户余额快照**而非流水，按定义不受关键字影响 —— 账户里有多少钱
 * 与「本月搜不搜得到某个关键词」无关。
 */
export function summary(
  ctx: AppCtx,
  ledgerId: string,
  from?: string,
  to?: string,
  keyword?: string,
  /** 账户 / 分类 / 类型 三维筛选（可选）。来自统计页「来源 / 类型 / 分类」下拉。 */
  filters?: TxFilters,
) {
  const range = normalizeRange(from, to);
  const flow = periodFlow(ctx, ledgerId, range.from, range.to, keyword, filters);
  const t = totals(ctx, ledgerId);

  const prev = previousRange(range.from, range.to);
  const prevFlow = periodFlow(ctx, ledgerId, prev.from, prev.to, keyword, filters);
  const ly = lastYearMonth(range.from, range.to);
  const lyFlow = periodFlow(ctx, ledgerId, ly.from, ly.to, keyword, filters);

  const kwCond = keywordCondition(keyword);
  /** 只含账户 / 分类（不含类型）：`biggest()` 自带 recordType 参数，避免与之冲突 */
  const acConds = txFilterConds({
    accountId: filters?.accountId,
    parentCategoryId: filters?.parentCategoryId,
    categoryId: filters?.categoryId,
  });

  /**
   * 个人账本「本期录入汇总」四指标（需求 ②）。
   *
   * 口径与 `biggest()` 完全一致（ledgerId + 未删 + 日期区间 + 关键字），
   * 只是把「取最大单笔」换成按 `amount / discount / fee / actualAmount` 做 sum。
   * 这四项**不区分收支类型**（receivable / payable 也计入「录入」），
   * 因为需求是「所有录入金额的总额」，不是「收支净额」。
   *
   * 关系恒等式：净额 = 录入总额 + 手续费 − 折扣，前端卡片里会显式写出，
   * 避免「扣减折扣与手续费」措辞带来的方向歧义（手续费对支出是加项）。
   */
  const entryAgg = ctx.db
    .select({
      recorded: sql`coalesce(sum(${transactions.amount}), 0)`,
      discount: sql`coalesce(sum(${transactions.discount}), 0)`,
      fee: sql`coalesce(sum(${transactions.fee}), 0)`,
      actual: sql`coalesce(sum(${transactions.actualAmount}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, range.from),
        lte(transactions.txDate, range.to),
        ...(kwCond ? [kwCond] : []),
        ...txFilterConds(filters),
      ),
    )
    .get();

  // 金额最大的单笔支出 / 收入（用于「最大单笔」提示）
  const biggest = (recordType: 'expense' | 'income') => {
    const row = ctx.db
      .select({
        id: transactions.id,
        name: transactions.name,
        actualAmount: transactions.actualAmount,
        txDate: transactions.txDate,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.ledgerId, ledgerId),
          isNull(transactions.deletedAt),
          eq(transactions.recordType, recordType),
          gte(transactions.txDate, range.from),
          lte(transactions.txDate, range.to),
          ...(kwCond ? [kwCond] : []),
          ...acConds,
        ),
      )
      .orderBy(sql`${transactions.actualAmount} desc`)
      .limit(1)
      .get();
    return row
      ? { id: row.id, name: row.name, amount: formatCents(row.actualAmount), txDate: row.txDate }
      : null;
  };

  const byType = Object.fromEntries(flow.byType.map((r) => [r.recordType, r]));

  const curDays = daysInRange(range.from, range.to);
  const momDays = daysInRange(prev.from, prev.to);
  const yoyDays = daysInRange(ly.from, ly.to);

  return {
    dateRange: { from: range.from, to: range.to },

    /**
     * 个人账本「本期录入汇总」四指标（元字符串）。
     * totalRecorded = Σ amount（录入总额）
     * totalDiscount  = Σ discount（折扣合计）
     * totalFee       = Σ fee（手续费合计）
     * netAmount      = Σ actualAmount（净额 = 录入总额 + 手续费 − 折扣）
     */
    totalRecorded: formatCents(Number(entryAgg?.recorded ?? 0)),
    totalDiscount: formatCents(Number(entryAgg?.discount ?? 0)),
    totalFee: formatCents(Number(entryAgg?.fee ?? 0)),
    netAmount: formatCents(Number(entryAgg?.actual ?? 0)),

    totalExpense: formatCents(flow.expense),
    totalIncome: formatCents(flow.income),
    netBalance: formatCents(flow.net),
    totalAssets: formatCents(t.assetTotal),
    totalLiabilities: formatCents(t.liabilityTotal),
    netAssets: formatCents(t.netWorth),
    expenseCount: byType.expense?.count ?? 0,
    incomeCount: byType.income?.count ?? 0,

    /**
     * 日均口径。`dailyExpense` 是「平均每天花了多少」，
     * 它才是**跨月可比**的那个数（见 `dailyRate` 的注释）。
     */
    periodDays: curDays,
    dailyExpense: formatCents(Math.round(flow.expense / curDays)),
    dailyIncome: formatCents(Math.round(flow.income / curDays)),

    compare: {
      /** mom = 环比（上一个等长区间）· yoy = 同比（去年同期） */
      mom: {
        previousPeriod: prev,
        previousDays: momDays,
        expenseChangeRate: rate(flow.expense, prevFlow.expense),
        incomeChangeRate: rate(flow.income, prevFlow.income),
        netBalanceChangeRate: rate(flow.net, prevFlow.net),
        /** 日均口径：剔除天数差异后的可比变化 */
        expenseDailyChangeRate: dailyRate(flow.expense, curDays, prevFlow.expense, momDays),
        incomeDailyChangeRate: dailyRate(flow.income, curDays, prevFlow.income, momDays),
        netDailyChangeRate: dailyRate(flow.net, curDays, prevFlow.net, momDays),
      },
      yoy: {
        previousPeriod: ly,
        previousDays: yoyDays,
        expenseChangeRate: rate(flow.expense, lyFlow.expense),
        incomeChangeRate: rate(flow.income, lyFlow.income),
        netBalanceChangeRate: rate(flow.net, lyFlow.net),
        expenseDailyChangeRate: dailyRate(flow.expense, curDays, lyFlow.expense, yoyDays),
        incomeDailyChangeRate: dailyRate(flow.income, curDays, lyFlow.income, yoyDays),
        netDailyChangeRate: dailyRate(flow.net, curDays, lyFlow.net, yoyDays),
      },
    },
    largestExpense: biggest('expense'),
    largestIncome: biggest('income'),
  };
}

/* ------------------------------------------------------------------ *
 * 趋势
 * ------------------------------------------------------------------ */

export type Granularity = 'day' | 'week' | 'month' | 'year';

interface Bucket {
  key: string;
  label: string;
  from: string;
  to: string;
}

function bucketsOf(granularity: Granularity, from: string, to: string): Bucket[] {
  const out: Bucket[] = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const iso = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;

  if (granularity === 'day') {
    while (d <= end) {
      out.push({ key: iso(d), label: `${d.getMonth() + 1}/${d.getDate()}`, from: iso(d), to: iso(d) });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }
  if (granularity === 'week') {
    // ISO 周：以「周一」为一周之始（与 §12「每周还款日」的直觉一致）
    while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
    while (d <= end) {
      const wEnd = new Date(d);
      wEnd.setDate(wEnd.getDate() + 6);
      out.push({
        key: iso(d),
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        from: iso(d),
        to: iso(wEnd < end ? wEnd : end),
      });
      d.setDate(d.getDate() + 7);
    }
    return out;
  }
  if (granularity === 'month') {
    let y = d.getFullYear();
    let m = d.getMonth() + 1;
    const lastY = end.getFullYear();
    const lastM = end.getMonth() + 1;
    while (y < lastY || (y === lastY && m <= lastM)) {
      const { from: mf, to: mt } = monthRange(y, m);
      out.push({ key: `${y}-${pad(m)}`, label: `${m}月`, from: mf, to: mt });
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  let y = d.getFullYear();
  while (y <= end.getFullYear()) {
    out.push({ key: String(y), label: `${y}`, from: `${y}-01-01`, to: `${y}-12-31` });
    y += 1;
  }
  return out;
}

export function trend(
  ctx: AppCtx,
  ledgerId: string,
  granularity: Granularity,
  from?: string,
  to?: string,
  keyword?: string,
  /** 账户 / 分类 / 类型 三维筛选（可选） */
  filters?: TxFilters,
) {
  const range = normalizeRange(from, to);
  const g: Granularity = ['day', 'week', 'month', 'year'].includes(granularity) ? granularity : 'day';
  const buckets = bucketsOf(g, range.from, range.to);
  const kwCond = keywordCondition(keyword);

  const rows = ctx.db
    .select({
      date: transactions.txDate,
      expense: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'expense' then ${transactions.actualAmount} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'income' then ${transactions.actualAmount} else 0 end), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, range.from),
        lte(transactions.txDate, range.to),
        ...(kwCond ? [kwCond] : []),
        ...txFilterConds(filters),
      ),
    )
    .all();

  const incomeByDate = new Map<string, number>();
  const expenseByDate = new Map<string, number>();
  const countByDate = new Map<string, number>();
  for (const r of rows) {
    incomeByDate.set(r.date, Number(r.income ?? 0));
    expenseByDate.set(r.date, Number(r.expense ?? 0));
    countByDate.set(r.date, Number(r.cnt ?? 0));
  }

  const sumRange = (m: Map<string, number>, a: string, b: string) => {
    let n = 0;
    for (const [k, v] of m) if (k >= a && k <= b) n += v;
    return n;
  };

  return buckets.map((b) => {
    const income = sumRange(incomeByDate, b.from, b.to);
    const expense = sumRange(expenseByDate, b.from, b.to);
    const count = sumRange(countByDate, b.from, b.to);
    return {
      period: b.key,
      label: b.label,
      expense: formatCents(expense),
      income: formatCents(income),
      net: formatCents(income - expense),
      count,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 多维聚合
 * ------------------------------------------------------------------ */

/**
 * 按分类聚合。
 *
 * 关键口径：**只统计 `expense` / `income`**，转账与调整不进分类维度
 * （它们没有「花在哪」这层语义）。`level=1` 返回一级 + `children` 明细，
 * `level=2` 直接返回扁平二级列表 —— 前端两种视图都能用。
 */
export function byCategory(
  ctx: AppCtx,
  ledgerId: string,
  recordType: string,
  from?: string,
  to?: string,
  level: 1 | 2 = 1,
  keyword?: string,
  /** 账户 / 分类 筛选（可选；类型由上面的 `recordType` 显式决定，这里不重复接） */
  filters?: Pick<TxFilters, 'accountId' | 'parentCategoryId' | 'categoryId'>,
) {
  const range = normalizeRange(from, to);
  const rt = recordType === 'income' ? 'income' : 'expense';
  const kwCond = keywordCondition(keyword);

  const rows = ctx.db
    .select({
      categoryId: transactions.categoryId,
      parentId: transactions.parentCategoryId,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, rt),
        gte(transactions.txDate, range.from),
        lte(transactions.txDate, range.to),
        ...(kwCond ? [kwCond] : []),
        ...txFilterConds(filters),
      ),
    )
    .groupBy(transactions.categoryId, transactions.parentCategoryId)
    .all();

  const cats = ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all();
  const byId = new Map(cats.map((c) => [c.id, c]));

  const grand = rows.reduce((a, r) => a + Number(r.total ?? 0), 0) || 1;

  interface Leaf {
    categoryId: string;
    name: string;
    icon: string | null;
    amount: number;
    count: number;
  }
  const leafByParent = new Map<string, Leaf[]>();
  const orphan: Leaf[] = [];

  for (const r of rows) {
    const child = r.categoryId ? byId.get(r.categoryId) : undefined;
    const amount = Number(r.total ?? 0);
    const count = Number(r.cnt ?? 0);
    const leaf: Leaf = {
      categoryId: r.categoryId ?? '',
      name: child?.name ?? '未分类',
      icon: child?.icon ?? null,
      amount,
      count,
    };
    if (r.parentId) {
      if (!leafByParent.has(r.parentId)) leafByParent.set(r.parentId, []);
      leafByParent.get(r.parentId)!.push(leaf);
    } else orphan.push(leaf);
  }

  const ratio = (n: number) => ((n / grand) * 100).toFixed(1);

  if (level === 2) {
    return [...orphan, ...[...leafByParent.values()].flat()]
      .sort((a, b) => b.amount - a.amount)
      .map((l) => ({
        categoryId: l.categoryId || null,
        name: l.name,
        icon: l.icon,
        amount: formatCents(l.amount),
        ratio: ratio(l.amount),
        count: l.count,
      }));
  }

  const out = [...leafByParent.entries()].map(([parentId, children]) => {
    const parent = byId.get(parentId);
    const amount = children.reduce((a, c) => a + c.amount, 0);
    const count = children.reduce((a, c) => a + c.count, 0);
    return {
      categoryId: parentId,
      name: parent?.name ?? '未分类',
      icon: parent?.icon ?? null,
      amount: formatCents(amount),
      ratio: ratio(amount),
      count,
      children: children
        .sort((a, b) => b.amount - a.amount)
        .map((c) => ({
          categoryId: c.categoryId || null,
          name: c.name,
          amount: formatCents(c.amount),
          count: c.count,
        })),
    };
  });

  // 「未分类」单独提出来，不挂在任何一级下面
  if (orphan.length) {
    const amount = orphan.reduce((a, c) => a + c.amount, 0);
    const count = orphan.reduce((a, c) => a + c.count, 0);
    out.push({
      categoryId: '',
      name: '未分类',
      icon: null,
      amount: formatCents(amount),
      ratio: ratio(amount),
      count,
      children: orphan.map((c) => ({
        categoryId: c.categoryId || null,
        name: c.name,
        amount: formatCents(c.amount),
        count: c.count,
      })),
    });
  }

  return out.sort((a, b) => Number(b.amount) - Number(a.amount));
}

/** 按账户聚合（收入来自该账户、支出记在该账户） */
export function byAccount(
  ctx: AppCtx,
  ledgerId: string,
  from?: string,
  to?: string,
  keyword?: string,
  /** 账户 / 分类 / 类型 三维筛选（可选） */
  filters?: TxFilters,
) {
  const range = normalizeRange(from, to);
  const kwCond = keywordCondition(keyword);
  const rows = ctx.db
    .select({
      accountId: transactions.accountId,
      expense: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'expense' then ${transactions.actualAmount} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.recordType} = 'income' then ${transactions.actualAmount} else 0 end), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, range.from),
        lte(transactions.txDate, range.to),
        ...(kwCond ? [kwCond] : []),
        ...txFilterConds(filters),
      ),
    )
    .groupBy(transactions.accountId)
    .all();

  const accs = ctx.db
    .select({ id: accounts.id, name: accounts.name, kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
  const byId = new Map(accs.map((a) => [a.id, a]));

  return rows
    .map((r) => ({
      accountId: r.accountId,
      name: byId.get(r.accountId)?.name ?? '已删除账户',
      kind: byId.get(r.accountId)?.kind ?? 'asset',
      expense: formatCents(Number(r.expense ?? 0)),
      income: formatCents(Number(r.income ?? 0)),
      net: formatCents(Number(r.income ?? 0) - Number(r.expense ?? 0)),
      count: Number(r.cnt ?? 0),
    }))
    .sort((a, b) => Math.abs(Number(b.net)) - Math.abs(Number(a.net)));
}

function byTextField(
  ctx: AppCtx,
  ledgerId: string,
  column: typeof transactions.merchant | typeof transactions.counterparty,
  from?: string,
  to?: string,
  limit = 20,
  keyword?: string,
) {
  const range = normalizeRange(from, to);
  const kwCond = keywordCondition(keyword);
  const rows = ctx.db
    .select({
      key: column,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        sql`${column} is not null and trim(${column}) <> ''`,
        gte(transactions.txDate, range.from),
        lte(transactions.txDate, range.to),
        ...(kwCond ? [kwCond] : []),
      ),
    )
    .groupBy(column)
    .orderBy(sql`sum(${transactions.actualAmount}) desc`)
    .limit(Math.min(100, Math.max(1, limit)))
    .all();

  return rows.map((r) => ({
    name: r.key as string,
    amount: formatCents(Number(r.total ?? 0)),
    count: Number(r.cnt ?? 0),
  }));
}

export const byMerchant = (
  ctx: AppCtx,
  ledgerId: string,
  from?: string,
  to?: string,
  limit?: number,
  keyword?: string,
) => byTextField(ctx, ledgerId, transactions.merchant, from, to, limit, keyword);

export const byCounterparty = (
  ctx: AppCtx,
  ledgerId: string,
  from?: string,
  to?: string,
  limit?: number,
  keyword?: string,
) => byTextField(ctx, ledgerId, transactions.counterparty, from, to, limit, keyword);

/** 按标签聚合（多对多：一笔多标签时金额会在各标签上重复出现，故不提供占比） */
export function byTag(
  ctx: AppCtx,
  ledgerId: string,
  from?: string,
  to?: string,
  keyword?: string,
) {
  const range = normalizeRange(from, to);
  const kwCond = keywordCondition(keyword);
  const rows = ctx.db
    .select({
      tagId: tags.id,
      name: tags.name,
      color: tags.color,
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactionTags)
    .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, range.from),
        lte(transactions.txDate, range.to),
        ...(kwCond ? [kwCond] : []),
      ),
    )
    .groupBy(tags.id)
    .orderBy(sql`sum(${transactions.actualAmount}) desc`)
    .all();

  return rows.map((r) => ({
    tagId: r.tagId,
    name: r.name,
    color: r.color,
    amount: formatCents(Number(r.total ?? 0)),
    count: Number(r.cnt ?? 0),
  }));
}

/* ------------------------------------------------------------------ *
 * 未结清债权债务
 * ------------------------------------------------------------------ */

/**
 * ⚠️ 这里**不自己算**台账余额，直接取 `debts/service.ts` 的 `openDebts().summary`。
 *
 * 理由：台账口径是「所有产生/结算/核销的净额」，其中**允许存在未归属的冲销**
 * （`docs/03 §1.3` 的恒等式是 `Σ逐笔未结清 + 未归属冲销 = 台账余额`）。
 * 若统计页自己去 join transactions 逐笔加总，就会漏掉未归属那一块，
 * 于是「概览上的待收」与「往来页的待收」永远差一块 —— 而用户对不上的第一反应
 * 就是「这软件算错了」。**口径只能有一份**，`debts` 那份是权威。
 */
export function outstanding(ctx: AppCtx, ledgerId: string) {
  const { summary } = openDebts(ctx, ledgerId);
  return {
    receivable: {
      amount: summary.totalReceivable,
      openCount: summary.openReceivable,
      unallocated: summary.unallocatedReceivable,
    },
    payable: {
      amount: summary.totalPayable,
      openCount: summary.openPayable,
      unallocated: summary.unallocatedPayable,
    },
    netPosition: summary.netPosition,
  };
}

export const outstandingReceivables = (ctx: AppCtx, ledgerId: string) => outstanding(ctx, ledgerId).receivable;
export const outstandingPayables = (ctx: AppCtx, ledgerId: string) => outstanding(ctx, ledgerId).payable;
