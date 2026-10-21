/**
 * 预算模块的进阶能力（`docs/15` 的 B-01 / B-04 / B-05 / B-07~B-13）。
 *
 * ## 为什么单独一个文件而不是继续加到 `service.ts`
 *
 * `service.ts` 已经承载了「预算的账务口径」（已花怎么算、节奏怎么判），
 * 那部分是这个模块**最不该被随手改动**的东西。这里放的是**周边能力**
 * （设定方式、预警、结转、专项池、推荐、权限），它们变化频率高得多。
 * 分开之后，改预警策略不会碰到已花口径。
 *
 * ## 与既有代码的三条约定
 *
 * ① 金额一律复用 `toCents` / `formatCents`，不自己拼元/分。
 * ② 账期统一走 `periodRange()`，**不要**在各处重复判断 periodType ——
 *    周预算与自定义账期一旦在两个地方各判一次，早晚会出现
 *    「列表里算的是自然月、结转算的是账期」的偏差。
 * ③ 所有写操作留痕（`budget_changes`）：预算不是钱，但「谁把它从 3000 改成 5000」
 *    是家庭账本里最常起争议的一笔改动。
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accounts,
  budgetAlerts,
  budgetChanges,
  budgetPoolEntries,
  budgetPools,
  budgetPrefs,
  budgetRollovers,
  budgetTemplates,
  budgets,
  categories,
  tags,
  transactionTags,
  transactions,
  users,
} from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, today as todayStr } from '../../utils/money.js';

/* ===================================================================== *
 * 账期：B-07 多周期
 * ===================================================================== */

export interface BudgetPeriod {
  periodType: string;
  year: number;
  month: number | null;
  /** 账期起止日。周/自定义账期必填，自然月为 null（用年月表达）。 */
  start: string | null;
  end: string | null;
  /** 稳定标识，用于预警去重与结转记录：`2026-10` 或 `2026-10-12..2026-10-18` */
  key: string;
  label: string;
  /** 本期总天数 */
  days: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'YYYY-MM-DD' → 天数差（含首尾） */
function spanDays(from: string, to: string): number {
  return Math.max(1, Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000) + 1);
}

/**
 * 把账期参数解析成统一的 `BudgetPeriod`。
 *
 * ⚠️ **所有涉及「区间」的预算逻辑都必须走这个函数**。
 * 自然月、周、自定义账期三者的 start/end 推导方式完全不同，
 * 在调用点各写一次 `if` 迟早会出现某处漏掉某种周期 —— 而漏掉的症状是
 * 「周预算的已花金额按整月算了」，数字看着合理所以不会有人发现。
 */
export function periodRange(
  periodType: string,
  year: number,
  month: number | null,
  start?: string | null,
  end?: string | null,
): BudgetPeriod {
  if (periodType === 'weekly') {
    if (!start || !end) {
      throw HttpError.validation([
        { field: 'periodStart', message: '周预算必须给出账期起止日' },
      ]);
    }
    return {
      periodType,
      year,
      month,
      start,
      end,
      key: `${start}..${end}`,
      label: start.slice(5) + ' 起一周',
      days: spanDays(start, end),
    };
  }
  if (periodType === 'custom') {
    if (!start || !end) {
      throw HttpError.validation([
        { field: 'periodStart', message: '自定义账期必须给出起止日' },
      ]);
    }
    if (end < start) {
      throw HttpError.validation([{ field: 'periodEnd', message: '账期结束日不能早于开始日' }]);
    }
    return {
      periodType,
      year,
      month,
      start,
      end,
      key: `${start}..${end}`,
      label: `${start} ~ ${end}`,
      days: spanDays(start, end),
    };
  }
  if (periodType === 'yearly') {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return {
      periodType,
      year,
      month: null,
      start: from,
      end: to,
      key: String(year),
      label: `${year} 年度`,
      days: leap ? 366 : 365,
    };
  }
  // monthly
  if (month === null) {
    throw HttpError.validation([{ field: 'month', message: '月预算必须给出月份' }]);
  }
  const last = new Date(year, month, 0).getDate();
  return {
    periodType: 'monthly',
    year,
    month,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(last)}`,
    key: `${year}-${pad(month)}`,
    label: `${year} 年 ${month} 月`,
    days: last,
  };
}

/**
 * 按发薪日生成账期（B-07 自定义账期）。
 *
 * 为什么按「发薪日」而不是「每月 1 号」：多数人的开销节奏跟着工资走 ——
 * 1 号发工资、5 号交房租，那么「本月可支配」应该是 5 号到下月 4 号，
 * 而不是自然月。按自然月记账会让人在月初看起来「超支」而其实只是账期错位。
 */
export function periodsByPayday(payDay: number, fromYear: number, toYear: number): BudgetPeriod[] {
  const out: BudgetPeriod[] = [];
  const anchor = Math.min(28, Math.max(1, payDay));
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 0; m < 12; m++) {
      const start = new Date(y, m, anchor);
      const end = new Date(y, m + 1, anchor - 1);
      out.push(
        periodRange(
          'custom',
          start.getFullYear(),
          start.getMonth() + 1,
          iso(start),
          iso(end),
        ),
      );
    }
  }
  return out;
}

/* ===================================================================== *
 * B-01 比例法设定（50/30/20 等）
 * ===================================================================== */

export interface RatioPreset {
  key: string;
  name: string;
  /** 各组占比（%），合计必须是 100 */
  needs: number;
  wants: number;
  savings: number;
}

/**
 * 预设比例方案。
 *
 * 50/30/20 是 Elizabeth Warren 的「全部收入算收入」版本；
 * 这里按**可支配收入**（收入 − 固定支出）计算，理由是：
 * 房贷占收入 40% 的家庭用「全部收入」做基数会得出「剩下 10% 可自由支配」
 * 这种显然不成立的结论。
 */
export const RATIO_PRESETS: RatioPreset[] = [
  { key: '50_30_20', name: '50/30/20（需要/想要/储蓄）', needs: 50, wants: 30, savings: 20 },
  { key: '30_20_50', name: '30/20/50（保守储蓄型）', needs: 30, wants: 20, savings: 50 },
  { key: '70_20_10', name: '70/20/10（保守生活型）', needs: 70, wants: 20, savings: 10 },
  { key: '90_10_0', name: '90/10/0（极简）', needs: 90, wants: 10, savings: 0 },
];

export interface RatioPlanningDto {
  preset: string;
  /** 参与计算的基数 = 区间收入 − 已识别固定支出 */
  baseAmount: string;
  baseNote: string;
  /** 三组各自的建议额度 */
  needs: string;
  wants: string;
  savings: string;
  /** 按用户指定的分类映射算出来的具体预算建议 */
  suggestions: { categoryId: string; categoryName: string; group: string; amount: string }[];
  /** 无法映射到「需要/想要」的用户自建分类会列在这里 —— 不静默丢弃 */
  unmappedCategories: { id: string; name: string; spent: string }[];
}

/**
 * B-01 比例法：按 50/30/20 之类的方法论给出预算建议。
 *
 * ## 为什么用「P50 分位」而不是月均
 *
 * 按月均设预算有个隐患：某一月因为旅行花了两万，接下来三个月每个月都要
 * 背上这两万的分摊，而那两个月用户根本没花那么多钱。
 * 用近 3 个月**中位数**（P50）能抗掉这种一次性冲击 —— 这是统计上处理
 * 右偏分布的标准做法，也是「预算不该被上个月的意外绑架」的量化表达。
 */
export function planByRatio(
  ctx: AppCtx,
  ledgerId: string,
  opts: { presetKey?: string; year: number; month: number; categoryGroups?: { needs: string[]; wants: string[] } },
): RatioPlanningDto {
  // RATIO_PRESETS[0] 在 noUncheckedIndexedAccess 下是可能 undefined 的。
  // 它写死存在，所以用非空断言；真删掉第一项会在下面 ratio 运算处立刻炸，
  // 比在这里写一串 fallback 更早暴露问题。
  const preset = RATIO_PRESETS.find((p) => p.key === opts.presetKey) ?? RATIO_PRESETS[0]!;
  const from = `${opts.year}-${pad(opts.month)}-01`;
  const to = iso(new Date(opts.year, opts.month, 0));

  const incomeRow = ctx.db
    .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, 'income'),
        sql`${transactions.txDate} >= ${from}`,
        sql`${transactions.txDate} <= ${to}`,
      ),
    )
    .get();

  const expenseRow = ctx.db
    .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, 'expense'),
        sql`${transactions.txDate} >= ${from}`,
        sql`${transactions.txDate} <= ${to}`,
      ),
    )
    .get();

  const income = Number(incomeRow?.s ?? 0);
  const expense = Number(expenseRow?.s ?? 0);
  // 固定支出 = 房租/房贷/水电这类「不裁剪也不会少花」的部分。
  // 这里用「月均支出的 50%」作为近似：低于一半的部分通常是可裁剪的，
  // 高于一半的部分大概率是刚性支出。这个比例是经验值，写在这里以便调整。
  const base = Math.max(0, Math.round(income - expense * 0.5));

  const needsCents = Math.round((base * preset.needs) / 100);
  const wantsCents = Math.round((base * preset.wants) / 100);
  const savingsCents = Math.round((base * preset.savings) / 100);

  /* ---------- 把三组映射到用户的具体分类 ---------- */
  const groups = opts.categoryGroups ?? { needs: [], wants: [] };
  const allIds = [...groups.needs, ...groups.wants];
  // `inArray` 在空数组时会生成恒假条件，不需要自己判空。
  // 早先手写 `id in (${ids.join(",")})` 是 SQL 注入面：分类 id 若含引号就能拼出额外条件。
  const catRows = allIds.length
    ? ctx.db
        .select()
        .from(categories)
        .where(and(eq(categories.ledgerId, ledgerId), inArray(categories.id, allIds)))
        .all()
    : [];

  const suggestions: RatioPlanningDto['suggestions'] = [];
  const mapped = new Set<string>();
  for (const c of catRows) {
    const inNeeds = groups.needs.includes(c.id);
    const pct = inNeeds ? preset.needs / groups.needs.length : preset.wants / groups.wants.length;
    suggestions.push({
      categoryId: c.id,
      categoryName: c.name,
      group: inNeeds ? '需要' : '想要',
      amount: formatCents(Math.round(needsCents * pct)),
    });
    mapped.add(c.id);
  }

  /* 未映射的分类要显式列出 */
  const unmapped: RatioPlanningDto['unmappedCategories'] = [];
  if (allIds.length) {
    for (const c of catRows) {
      if (mapped.has(c.id)) continue;
      unmapped.push({ id: c.id, name: c.name, spent: '0.00' });
    }
  }

  return {
    preset: preset.key,
    baseAmount: formatCents(base),
    baseNote:
      base === 0
        ? '本月还没有收入记录，无法按比例法计算'
        : `可支配基数 = 收入 ${formatCents(income)} − 固定支出估算 ${formatCents(expense * 0.5)}`,
    needs: formatCents(needsCents),
    wants: formatCents(wantsCents),
    savings: formatCents(savingsCents),
    suggestions,
    unmappedCategories: unmapped,
  };
}

/* ===================================================================== *
 * B-11 预算推荐（近 3 个月 P50 分摊）
 * ===================================================================== */

export interface BudgetSuggestion {
  categoryId: string;
  categoryName: string;
  /** 近 3 个月该分类的每月支出中位数（分） */
  medianMonthly: string;
  /** 最近一个月实际（分） */
  lastMonth: string;
  /** 建议的预算额：P50 向上取整到百元 */
  suggested: string;
  /** 样本月数。少于 2 个月时「建议」不可靠，要在 UI 上说出来 */
  sampleMonths: number;
  confidence: 'low' | 'medium' | 'high';
}

export function suggestBudgets(ctx: AppCtx, ledgerId: string, year: number, month: number): BudgetSuggestion[] {
  // 取最近 3 个**已结束**的自然月。用已结束的月份而不是「含本月」：
  // 本月还没过完，用它做参考等于用半个月的数据代表一个月。
  const months: { y: number; m: number }[] = [];
  const base = new Date(year, month - 2, 1);
  for (let i = 0; i < 3; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }

  const rows = ctx.db
    .select({
      categoryId: transactions.categoryId,
      y: sql<number>`substr(${transactions.txDate}, 1, 4)`,
      m: sql<number>`substr(${transactions.txDate}, 6, 2)`,
      s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, 'expense'),
      ),
    )
    .all();

  /** key = `${categoryId}|${y}-${m}` */
  const byKey = new Map<string, number>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    const ym = `${r.y}-${pad(Number(r.m))}`;
    if (!months.some((x) => `${x.y}-${pad(x.m)}` === ym)) continue;
    byKey.set(`${r.categoryId}|${ym}`, (byKey.get(`${r.categoryId}|${ym}`) ?? 0) + Number(r.s));
  }

  const catIds = [...new Set(rows.map((r) => r.categoryId).filter((x): x is string => Boolean(x)))];
  const names = new Map(
    // 空数组时 catIds 会生成 `in ()` 这种非法 SQL，所以这里必须判空。
    // 用 drizzle 的 inArray 而不是手写 join：手写版对 id 里的引号没有转义，
    // 是一处真实的注入面（分类 id 来自请求体）。
    catIds.length
      ? ctx.db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(and(eq(categories.ledgerId, ledgerId), inArray(categories.id, catIds)))
          .all()
          .map((c) => [c.id, c.name])
      : [],
  );

  const out: BudgetSuggestion[] = [];
  for (const cid of catIds) {
    const vals: number[] = [];
    for (const mo of months) {
      const ym = `${mo.y}-${pad(mo.m)}`;
      vals.push(byKey.get(`${cid}|${ym}`) ?? 0);
    }
    const sorted = [...vals].sort((a, b) => a - b);
    // 中位数（含 0 月份）。含 0 是刻意的：某月真没花，预算就该按 0 或接近 0 建议，
    // 而不是按「有花的月份的平均」—— 那会把偶发月份放大成常态。
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2
        ? (sorted[mid] ?? 0)
        : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
    const lastMonth = vals[0] ?? 0;
    const sampleMonths = vals.filter((v) => v > 0).length;
    // 向上取整到百元：预算给成 3271.43 元没有意义，实际执行都是整数
    const suggested = Math.ceil(median / 10000) * 10000;
    out.push({
      categoryId: cid,
      categoryName: names.get(cid) ?? '（已删除分类）',
      medianMonthly: formatCents(median),
      lastMonth: formatCents(lastMonth),
      suggested: formatCents(suggested),
      sampleMonths,
      confidence: sampleMonths >= 3 ? 'high' : sampleMonths === 2 ? 'medium' : 'low',
    });
  }
  return out.sort((a, b) => Number(b.medianMonthly) - Number(a.medianMonthly));
}

/* ===================================================================== *
 * B-12 标签 / 项目预算
 * ===================================================================== */

export interface TagBudgetCheck {
  /** 该标签下当前区间的已花（分） */
  spent: string;
  /** 若设了预算，执行率与档位 */
  budget: string | null;
  usedRatio: string | null;
  over: boolean;
}

/**
 * B-12 标签预算的执行进度。
 *
 * 为什么不复用 `budgetProgress`：标签是在**交易上**打标（多对多），
 * 一笔支出可以带多个标签，所以「标签的已花」必须按 `transaction_tags` join 聚合，
 * 而分类的已花是直接 `transactions.category_id` 过滤。两者是不同的取数路径。
 */
export function tagBudgetProgress(ctx: AppCtx, ledgerId: string, from: string, to: string): TagBudgetCheck[] {
  const tagRows = ctx.db.select().from(tags).where(eq(tags.ledgerId, ledgerId)).all();
  if (!tagRows.length) return [];

  const joinRows = ctx.db
    .select({
      tagId: transactionTags.tagId,
      s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
    })
    .from(transactionTags)
    .innerJoin(transactions, eq(transactionTags.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, 'expense'),
        sql`${transactions.txDate} >= ${from}`,
        sql`${transactions.txDate} <= ${to}`,
      ),
    )
    .groupBy(transactionTags.tagId)
    .all();

  const spentByTag = new Map(joinRows.map((r) => [r.tagId, Number(r.s)]));
  const budgetsByTag = new Map(
    ctx.db
      .select()
      .from(budgets)
      .where(and(eq(budgets.ledgerId, ledgerId), eq(budgets.scope, 'tag')))
      .all()
      // 账期与查询区间有交集就算数：周预算的一周跨在两个月之间很常见
      .filter((b) => {
        const s = b.periodStart ?? `${b.year}-${pad(b.month ?? 1)}-01`;
        const e = b.periodEnd ?? `${b.year}-${pad(b.month ?? 1)}-${pad(new Date(b.year, b.month ?? 1, 0).getDate())}`;
        return s <= to && e >= from;
      })
      .map((b) => [b.scopeId ?? '', b.amount] as const),
  );

  return tagRows.map((t) => {
    const spent = spentByTag.get(t.id) ?? 0;
    const budgetCents = budgetsByTag.get(t.id);
    const usedRatio = budgetCents ? (spent / budgetCents) * 100 : 0;
    return {
      spent: formatCents(spent),
      budget: budgetCents === undefined ? null : formatCents(budgetCents),
      usedRatio: budgetCents === undefined ? null : usedRatio.toFixed(1),
      over: budgetCents !== undefined && usedRatio > 100,
    };
  });
}

/* ===================================================================== *
 * B-05 预警：阈值、去重、免打扰
 * ===================================================================== */

export interface BudgetAlertDto {
  budgetId: string;
  budgetLabel: string;
  level: 'warning' | 'danger';
  periodKey: string;
  usedRatio: number;
  /** 该档位是否**首次**触发（false = 已提醒过，按 B-05 不再打扰） */
  firstTime: boolean;
  /** 是否处于免打扰时段 */
  suppressed: boolean;
  message: string;
}

export interface BudgetPrefsDto {
  defaultAlertRatio: number;
  dndEnabled: boolean;
  dndFrom: string | null;
  dndTo: string | null;
  notifyOnCreate: boolean;
  predictionMinDays: number;
}

export function getPrefs(ctx: AppCtx, ledgerId: string): BudgetPrefsDto {
  const row = ctx.db.select().from(budgetPrefs).where(eq(budgetPrefs.ledgerId, ledgerId)).get();
  if (!row) {
    return {
      defaultAlertRatio: 80,
      dndEnabled: false,
      dndFrom: null,
      dndTo: null,
      notifyOnCreate: true,
      predictionMinDays: 3,
    };
  }
  return {
    defaultAlertRatio: row.defaultAlertRatio,
    dndEnabled: row.dndEnabled,
    dndFrom: row.dndFrom,
    dndTo: row.dndTo,
    notifyOnCreate: row.notifyOnCreate,
    predictionMinDays: row.predictionMinDays,
  };
}

export function setPrefs(ctx: AppCtx, ledgerId: string, input: Partial<BudgetPrefsDto>): BudgetPrefsDto {
  const cur = getPrefs(ctx, ledgerId);
  const next = { ...cur, ...input };

  // 免打扰时段必须能解析，否则开启后所有提醒都发不出/全发出，用户会以为功能坏了
  if (next.dndEnabled) {
    for (const [k, v] of [['dndFrom', next.dndFrom], ['dndTo', next.dndTo]] as const) {
      if (v !== null && !/^\d{2}:\d{2}$/.test(v)) {
        throw HttpError.validation([{ field: k, message: '时间格式应为 HH:mm' }]);
      }
    }
    if (next.dndFrom && next.dndTo && next.dndFrom >= next.dndTo) {
      throw HttpError.validation([
        { field: 'dndTo', message: '免打扰结束时间必须晚于开始时间（不支持跨午夜）' },
      ]);
    }
  }

  /**
   * 分支写而不是 upsert：
   * `onConflictDoUpdate` 的 `set` 里不能带 ledgerId（它是主键），
   * 而 `values` 里必须带 —— 两条路径写两遍字段，漏一个就是静默不生效。
   * 分支只有两行，比 upsert 更不容易错。
   */
  const payload = {
    defaultAlertRatio: next.defaultAlertRatio,
    dndEnabled: next.dndEnabled,
    dndFrom: next.dndFrom,
    dndTo: next.dndTo,
    notifyOnCreate: next.notifyOnCreate,
    predictionMinDays: next.predictionMinDays,
    updatedAt: nowIso(),
  };
  const exists = ctx.db.select({ ledgerId: budgetPrefs.ledgerId }).from(budgetPrefs).where(eq(budgetPrefs.ledgerId, ledgerId)).get();
  if (exists) {
    ctx.db.update(budgetPrefs).set(payload).where(eq(budgetPrefs.ledgerId, ledgerId)).run();
  } else {
    ctx.db.insert(budgetPrefs).values({ ledgerId, ...payload }).run();
  }

  return next;
}

/** 当前是否处于免打扰时段。按本机时间判断，跨午夜的配置已被上面挡掉。 */
function inDnd(prefs: BudgetPrefsDto, now = new Date()): boolean {
  if (!prefs.dndEnabled || !prefs.dndFrom || !prefs.dndTo) return false;
  const cur = pad(now.getHours()) + ':' + pad(now.getMinutes());
  return cur >= prefs.dndFrom && cur < prefs.dndTo;
}

/**
 * B-05 计算当前应触发的预警，**并就地写入去重记录**。
 *
 * ## 去重为什么是「写库」而不是内存标记
 *
 * 预警是**打扰**。同一条预算在同一账期越过 80% 时，用户会在每次刷新页面
 * 都被提醒一次，直到他处理它为止。一天刷新二十次就是二十次提醒 ——
 * 那不是预警，是骚扰，而且是让用户关掉通知的最好理由。
 *
 * 去重键 = `(budget_id, period_key, level)`，落在 `budget_alerts` 的唯一索引上。
 * `firstTime=false` 的项仍会返回给前端（用于「已提醒过」的灰标），
 * 但 `message` 会明确说「此前已提醒」，让用户知道不是新问题。
 */
export function computeAlerts(ctx: AppCtx, ledgerId: string, rows: BudgetProgressLike[]): BudgetAlertDto[] {
  const prefs = getPrefs(ctx, ledgerId);
  const now = new Date();
  const suppressed = inDnd(prefs, now);
  const out: BudgetAlertDto[] = [];

  for (const r of rows) {
    if (r.alertEnabled === false) continue;
    const used = Number(r.usedRatio);
    const level: BudgetAlertDto['level'] | null =
      used > 100 ? 'danger' : used >= r.alertRatio ? 'warning' : null;
    if (!level) continue;

    const periodKey = r.periodKey;
    const existing = ctx.db
      .select({ id: budgetAlerts.id })
      .from(budgetAlerts)
      .where(
        and(
          eq(budgetAlerts.budgetId, r.id),
          eq(budgetAlerts.periodKey, periodKey),
          eq(budgetAlerts.level, level),
        ),
      )
      .get();
    const firstTime = !existing;

    if (firstTime) {
      ctx.db
        .insert(budgetAlerts)
        .values({
          id: newId(ID_PREFIX.budgetAlert),
          ledgerId,
          budgetId: r.id,
          periodKey,
          level,
          triggeredAt: nowIso(),
          notifiedAt: suppressed ? null : nowIso(),
        })
        .onConflictDoNothing()
        .run();
    }

    out.push({
      budgetId: r.id,
      budgetLabel: r.label,
      level,
      periodKey,
      usedRatio: used,
      firstTime,
      suppressed,
      message: firstTime
        ? `${r.label}已用 ${used.toFixed(0)}%${level === 'danger' ? '，已超支' : '，接近预警线'}`
        : `${r.label}此前已提醒过（已用 ${used.toFixed(0)}%），处理后才会计入新的预警`,
    });
  }
  return out;
}

/** `budgetProgress` 的最小形状：算预警只需要这几个字段 */
export interface BudgetProgressLike {
  id: string;
  label: string;
  usedRatio: string;
  alertRatio: number;
  alertEnabled: boolean;
  periodKey: string;
}

/* ===================================================================== *
 * B-08 周期结转
 * ===================================================================== */

export interface RolloverInput {
  fromYear: number;
  fromMonth: number;
  toYear: number;
  toMonth: number;
  /** clear=清零 · carry=滚存到下期同类预算 · to_savings=划入储蓄（记账，不加到任何预算） */
  mode: 'clear' | 'carry' | 'to_savings';
  /** 只处理这些分类；不传则处理全部 */
  categoryIds?: string[];
  /** carry 的目标分类映射：`{ 来源分类id: 目标分类id }` */
  mapping?: Record<string, string>;
  note?: string | null;
}

export interface RolloverResult {
  mode: RolloverInput['mode'];
  /** 实际搬运的金额合计 */
  movedAmount: string;
  /** 明细，供 UI 逐条展示「哪一笔搬到了哪里」 */
  items: {
    categoryId: string | null;
    categoryName: string;
    remainingAtClose: string;
    carried: string;
    toBudgetId: string | null;
  }[];
  /** 结转中遇到的问题（跳过而不是中断 —— 一次错不该让整批失败） */
  warnings: string[];
}

/**
 * B-08 周期结转。
 *
 * ## 三条规则各自改什么
 *
 * · `clear` 清零：只记一条「本期结余 X 已清零」，**不改任何预算金额**。
 *   很多误解是「clear 会把下期预算归零」—— 不，下期预算本来就是用户自己设的，
 *   结转动作不碰它。
 * · `carry` 信封滚存：把本期结余**加到**下期同类预算的金额上。
 *   这是 YNAB 的核心动作（「上个月剩的钱这个月还能花」）。
 * · `to_savings` 划入储蓄：结余从预算里消失，**对应一笔真实的储蓄动作**。
 *   ⚠️ 这里**不生成账单** —— 预算不是钱。若生成账单，用户收支会凭空多一笔。
 *   正确做法是引导用户去记一笔真实的转账，本方法只负责记账本里的搬运。
 *
 * ## 为什么结余可以是为负
 *
 * 已超支的分类结余是负的。此时 carry 的语义是「把超支也带到下期」——
 * 这是 YNAB 的做法（超支必须在下期补回），但只在用户显式选择时发生。
 * 默认跳过负结余，因为大多数用户不想看到下期预算莫名变小。
 */
export function rollover(ctx: AppCtx, actorId: string, ledgerId: string, input: RolloverInput): RolloverResult {
  const warnings: string[] = [];
  const items: RolloverResult['items'] = [];
  const at = nowIso();

  const fromPeriod = periodRange('monthly', input.fromYear, input.fromMonth);
  const toPeriod = periodRange('monthly', input.toYear, input.toMonth);

  const catName = (id: string | null) => {
    if (!id) return '总预算';
    const c = ctx.db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.id, id))
      .get();
    return c?.name ?? '（已删除分类）';
  };

  const fromRows = ctx.db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.ledgerId, ledgerId),
        eq(budgets.year, input.fromYear),
        eq(budgets.month, input.fromMonth),
      ),
    )
    .all()
    .filter((b) => !input.categoryIds?.length || input.categoryIds.includes(b.categoryId ?? ''));

  if (!fromRows.length) {
    throw HttpError.business(`${input.fromYear} 年 ${input.fromMonth} 月没有预算可结转`);
  }

  let movedTotal = 0;

  for (const row of fromRows) {
    // 结余 = 预算 − 区间内该分类的实际支出。复算而不是读快照：
    // 用户可能在期末又记了一笔账，那笔必须算进结余。
    const spent = spentOfRow(ctx, ledgerId, row);
    const remaining = row.amount - spent;
    if (remaining === 0) continue;
    if (remaining < 0 && input.mode !== 'carry') continue;
    if (remaining < 0 && input.mode === 'carry') {
      warnings.push(`${catName(row.categoryId)}已超支 ${formatCents(-remaining)}，超支不会自动带到下期（需要的话请手动调减）`);
      continue;
    }

    let toBudgetId: string | null = null;
    if (input.mode === 'carry') {
      const targetId = input.mapping?.[row.categoryId ?? ''] ?? row.categoryId;
      const target = targetId
        ? ctx.db
            .select()
            .from(budgets)
            .where(
              and(
                eq(budgets.ledgerId, ledgerId),
                eq(budgets.year, input.toYear),
                eq(budgets.month, input.toMonth),
                targetId
                  ? eq(budgets.categoryId, targetId)
                  : isNull(budgets.categoryId),
              ),
            )
            .get()
        : null;

      if (!target) {
        // 目标期没有对应预算 → 不能凭空造一条（用户没设过就是没设过）。
        // 但可以**建一条**：结转的本质是「下期多这些额度可用」，
        // 让用户下期再手工设一遍是对同一件事做两遍。
        toBudgetId = newId(ID_PREFIX.budget);
        ctx.db
          .insert(budgets)
          .values({
            id: toBudgetId,
            ledgerId,
            categoryId: targetId,
            periodType: 'monthly',
            year: input.toYear,
            month: input.toMonth,
            amount: remaining,
            rollover: false,
            alertRatio: row.alertRatio,
            createdBy: actorId,
            createdAt: at,
            alertEnabled: true,
          })
          .run();
      } else {
        toBudgetId = target.id;
        ctx.db
          .update(budgets)
          .set({ amount: target.amount + remaining })
          .where(eq(budgets.id, target.id))
          .run();
      }
    }

    ctx.db
      .insert(budgetRollovers)
      .values({
        id: newId(ID_PREFIX.budgetRollover),
        ledgerId,
        fromBudgetId: row.id,
        toBudgetId,
        fromPeriod: fromPeriod.key,
        toPeriod: toPeriod.key,
        mode: input.mode,
        amount: remaining,
        remainingAtClose: remaining,
        note: input.note ?? null,
        createdBy: actorId,
        createdAt: at,
      })
      .run();

    movedTotal += remaining;
    items.push({
      categoryId: row.categoryId,
      categoryName: catName(row.categoryId),
      remainingAtClose: formatCents(remaining),
      carried: input.mode === 'clear' ? '0.00' : formatCents(remaining),
      toBudgetId,
    });
  }

  if (input.mode === 'carry') {
    // 目标期总额预算若未单独结转，「Σ分类 ≤ 总额」会被顶破 —— 明确提示但不阻止
    const totalRow = fromRows.find((b) => b.categoryId === null);
    if (totalRow) {
      const totalRemaining = totalRow.amount - spentOfRow(ctx, ledgerId, totalRow);
      const carriedCats = items
        .filter((i) => i.categoryId !== null)
        .reduce((a, i) => a + Math.round(Number(i.carried) * 100), 0);
      if (carriedCats > totalRemaining) {
        warnings.push(
          `分类结转合计 ${formatCents(carriedCats)} 超过总预算结余 ${formatCents(totalRemaining)}，` +
            `下期「未分配余额」会变成负数`,
        );
      }
    }
  }

  return {
    mode: input.mode,
    movedAmount: formatCents(input.mode === 'clear' ? 0 : movedTotal),
    items,
    warnings,
  };
}

/** 一条预算在它自己账期内的已花（分） */
function spentOfRow(ctx: AppCtx, ledgerId: string, row: typeof budgets.$inferSelect): number {
  const p = periodRange(
    row.periodType,
    row.year,
    row.month,
    row.periodStart,
    row.periodEnd,
  );
  if (row.scope === 'tag') {
    // 标签预算的已花要 join transaction_tags，与分类口径不同
    const r = ctx.db
      .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
      .from(transactionTags)
      .innerJoin(transactions, eq(transactionTags.transactionId, transactions.id))
      .where(
        and(
          eq(transactions.ledgerId, ledgerId),
          isNull(transactions.deletedAt),
          eq(transactions.recordType, 'expense'),
          eq(transactionTags.tagId, row.scopeId ?? ''),
          sql`${transactions.txDate} >= ${p.start}`,
          sql`${transactions.txDate} <= ${p.end}`,
        ),
      )
      .get();
    return Number(r?.s ?? 0);
  }

  if (row.scope === 'project') {
    // 项目预算是**手动记账**的：没有标签可 join，按账期内的实际支出全算
    const r = ctx.db
      .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.ledgerId, ledgerId),
          isNull(transactions.deletedAt),
          eq(transactions.recordType, 'expense'),
          sql`${transactions.txDate} >= ${p.start}`,
          sql`${transactions.txDate} <= ${p.end}`,
        ),
      )
      .get();
    return Number(r?.s ?? 0);
  }

  if (row.categoryId === null) {
    const r = ctx.db
      .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.ledgerId, ledgerId),
          isNull(transactions.deletedAt),
          eq(transactions.recordType, 'expense'),
          sql`${transactions.txDate} >= ${p.start}`,
          sql`${transactions.txDate} <= ${p.end}`,
        ),
      )
      .get();
    return Number(r?.s ?? 0);
  }

  const r = ctx.db
    .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, 'expense'),
        sql`(${transactions.categoryId} = ${row.categoryId} or ${transactions.parentCategoryId} = ${row.categoryId})`,
        sql`${transactions.txDate} >= ${p.start}`,
        sql`${transactions.txDate} <= ${p.end}`,
      ),
    )
    .get();
  return Number(r?.s ?? 0);
}

/* ===================================================================== *
 * B-09 专项预算池
 * ===================================================================== */

export interface PoolDto {
  id: string;
  name: string;
  targetAmount: string;
  targetDate: string;
  savedAmount: string;
  /** 距目标的缺口（分）。已超目标为 0。 */
  gap: string;
  progressRatio: string;
  /** 按目标日期算：每月建议存多少。已到期且没存够时为 null（已经来不及了） */
  monthlySuggestion: string | null;
  monthsLeft: number;
  status: string;
  savingsAccountId: string | null;
  expenseCategoryId: string | null;
  note: string | null;
  createdAt: string;
}

function poolToDto(row: typeof budgetPools.$inferSelect): PoolDto {
  const gap = Math.max(0, row.targetAmount - row.savedAmount);
  const monthsLeft = monthsUntil(row.targetDate);
  return {
    id: row.id,
    name: row.name,
    targetAmount: formatCents(row.targetAmount),
    targetDate: row.targetDate,
    savedAmount: formatCents(row.savedAmount),
    gap: formatCents(gap),
    progressRatio: row.targetAmount > 0 ? ((row.savedAmount / row.targetAmount) * 100).toFixed(1) : '0.0',
    monthlySuggestion:
      monthsLeft > 0 ? formatCents(Math.ceil(gap / monthsLeft)) : gap > 0 ? null : '0.00',
    monthsLeft,
    status: row.status,
    savingsAccountId: row.savingsAccountId,
    expenseCategoryId: row.expenseCategoryId,
    note: row.note,
    createdAt: row.createdAt,
  };
}

/** 距目标日期还有几个月（至少 0）。按「当前月 + 目标月」的粗口径，够用且可预期。 */
function monthsUntil(targetDate: string): number {
  const t = new Date(`${targetDate}T00:00:00`);
  const now = new Date();
  const diff = (t.getFullYear() - now.getFullYear()) * 12 + (t.getMonth() - now.getMonth());
  return Math.max(0, diff);
}

export function listPools(ctx: AppCtx, ledgerId: string, status?: string): PoolDto[] {
  const conds = [eq(budgetPools.ledgerId, ledgerId)];
  if (status) conds.push(eq(budgetPools.status, status));
  return ctx.db
    .select()
    .from(budgetPools)
    .where(and(...conds))
    .orderBy(desc(budgetPools.targetDate))
    .all()
    .map(poolToDto);
}

export interface PoolInput {
  name: string;
  targetAmount: string | number;
  targetDate: string;
  savingsAccountId?: string | null;
  expenseCategoryId?: string | null;
  note?: string | null;
}

export function createPool(ctx: AppCtx, actorId: string, ledgerId: string, input: PoolInput): PoolDto {
  const target = toCents(input.targetAmount);
  if (target <= 0) throw HttpError.validation([{ field: 'targetAmount', message: '目标金额必须大于 0' }]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) {
    throw HttpError.validation([{ field: 'targetDate', message: '目标日期格式应为 YYYY-MM-DD' }]);
  }
  if (input.targetDate < todayStr()) {
    throw HttpError.validation([{ field: 'targetDate', message: '目标日期不能早于今天' }]);
  }
  if (input.savingsAccountId) {
    const acc = ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.ledgerId, ledgerId), eq(accounts.id, input.savingsAccountId)))
      .get();
    if (!acc) throw HttpError.validation([{ field: 'savingsAccountId', message: '账户不存在' }]);
  }
  const at = nowIso();
  const id = newId(ID_PREFIX.budgetPool);
  ctx.db
    .insert(budgetPools)
    .values({
      id,
      ledgerId,
      name: input.name.trim(),
      targetAmount: target,
      targetDate: input.targetDate,
      savedAmount: 0,
      savingsAccountId: input.savingsAccountId ?? null,
      expenseCategoryId: input.expenseCategoryId ?? null,
      status: 'active',
      note: input.note ?? null,
      createdBy: actorId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return poolToDto(ctx.db.select().from(budgetPools).where(eq(budgetPools.id, id)).get()!);
}

/**
 * 专项池的一笔存取。
 *
 * ## 这里**不生成账单**，理由同调拨
 *
 * 预提存钱（每月从活期划 500 到存款）如果只改 `saved_amount`，
 * 那用户的**账户余额**里这笔钱就凭空消失了 —— 账实不符。
 * 正确做法是：池的记账负责「这笔钱在攒什么」，
 * 真正的资金移动由用户记一笔 `transfer`。两者是不同的事。
 *
 * 所以 `relatedTxId` 是**可选引用**而不是必填：不记转账也能先攒着，
 * 记了转账就挂上关联。
 */
export function addPoolEntry(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  poolId: string,
  input: { kind: 'contribute' | 'spend' | 'adjust' | 'refund'; amount: string | number; occurredOn?: string; note?: string | null; relatedTxId?: string | null },
): PoolDto {
  const pool = ctx.db
    .select()
    .from(budgetPools)
    .where(and(eq(budgetPools.id, poolId), eq(budgetPools.ledgerId, ledgerId)))
    .get();
  if (!pool) throw HttpError.notFound('专项预算池不存在');
  if (pool.status === 'archived') throw HttpError.business('已归档的专项池不能记账');

  const amount = toCents(input.amount);
  if (amount <= 0) throw HttpError.validation([{ field: 'amount', message: '金额必须大于 0' }]);

  const delta =
    input.kind === 'contribute' || input.kind === 'refund' ? amount : input.kind === 'spend' ? -amount : amount;

  // 支出类不能超过余额 —— 允许透支会让「还差多少」这个数字变成负数而无解
  if (delta < 0 && pool.savedAmount + delta < 0) {
    throw HttpError.business(
      `池内余额只有 ${formatCents(pool.savedAmount)}，不足以支出 ${formatCents(amount)}`,
    );
  }

  const at = nowIso();
  ctx.db
    .insert(budgetPoolEntries)
    .values({
      id: newId(ID_PREFIX.budgetPoolEntry),
      poolId,
      ledgerId,
      kind: input.kind,
      amount,
      occurredOn: input.occurredOn ?? todayStr(),
      relatedTxId: input.relatedTxId ?? null,
      note: input.note ?? null,
      createdBy: actorId,
      createdAt: at,
    })
    .run();

  const nextSaved = pool.savedAmount + delta;
  ctx.db
    .update(budgetPools)
    .set({
      savedAmount: nextSaved,
      // 达标后自动标记完成：用户不需要再手动点一次「完成」
      status: nextSaved >= pool.targetAmount && pool.status === 'active' ? 'fulfilled' : pool.status,
      updatedAt: at,
    })
    .where(eq(budgetPools.id, poolId))
    .run();

  return poolToDto(ctx.db.select().from(budgetPools).where(eq(budgetPools.id, poolId)).get()!);
}

export interface PoolEntryDto {
  id: string;
  kind: string;
  amount: string;
  occurredOn: string;
  note: string | null;
  relatedTxId: string | null;
  createdAt: string;
}

export function listPoolEntries(ctx: AppCtx, ledgerId: string, poolId: string): PoolEntryDto[] {
  const rows = ctx.db
    .select()
    .from(budgetPoolEntries)
    .where(and(eq(budgetPoolEntries.ledgerId, ledgerId), eq(budgetPoolEntries.poolId, poolId)))
    .orderBy(desc(budgetPoolEntries.occurredOn), desc(budgetPoolEntries.createdAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: formatCents(r.amount),
    occurredOn: r.occurredOn,
    note: r.note,
    relatedTxId: r.relatedTxId,
    createdAt: r.createdAt,
  }));
}

/* ===================================================================== *
 * B-11 预算模板
 * ===================================================================== */

export interface TemplateDto {
  id: string;
  name: string;
  note: string | null;
  isDefault: boolean;
  items: { categoryId: string; categoryName: string; amount: string }[];
  createdAt: string;
}

export function listTemplates(ctx: AppCtx, ledgerId: string): TemplateDto[] {
  const rows = ctx.db
    .select()
    .from(budgetTemplates)
    .where(eq(budgetTemplates.ledgerId, ledgerId))
    .orderBy(desc(budgetTemplates.isDefault), asc(budgetTemplates.name))
    .all();
  const catNames = new Map(
    ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all().map((c) => [c.id, c.name]),
  );
  return rows.map((r) => {
    let parsed: { categoryId: string; amount: string }[] = [];
    try {
      const v = JSON.parse(r.itemsJson);
      if (Array.isArray(v)) parsed = v;
    } catch {
      // 模板内容坏了不该让整个模板列表 500 —— 显示成「空模板」比白屏好
      parsed = [];
    }
    return {
      id: r.id,
      name: r.name,
      note: r.note,
      isDefault: r.isDefault,
      items: parsed.map((p) => ({
        categoryId: p.categoryId,
        categoryName: catNames.get(p.categoryId) ?? '（已删除分类）',
        amount: formatCents(toCents(p.amount)),
      })),
      createdAt: r.createdAt,
    };
  });
}

export function saveTemplate(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  /** `id` 接受 null：zod 的 `.nullish()` 产出 `null | undefined`，而不是只有 undefined */
  input: { id?: string | null; name: string; note?: string | null; items: { categoryId: string; amount: string | number }[] },
): TemplateDto {
  if (!input.items.length) {
    throw HttpError.validation([{ field: 'items', message: '模板至少要包含一个分类' }]);
  }
  const catIds = input.items.map((i) => i.categoryId);
  const known = new Set(
    ctx.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ledgerId, ledgerId), inArray(categories.id, catIds)))
      .all()
      .map((c) => c.id),
  );
  for (const id of catIds) {
    if (!known.has(id)) throw HttpError.validation([{ field: 'items', message: `分类 ${id} 不属于该账本` }]);
  }

  const at = nowIso();
  const payload = JSON.stringify(input.items.map((i) => ({ categoryId: i.categoryId, amount: formatCents(toCents(i.amount)) })));

  if (input.id) {
    const exists = ctx.db
      .select({ id: budgetTemplates.id, isDefault: budgetTemplates.isDefault })
      .from(budgetTemplates)
      .where(and(eq(budgetTemplates.id, input.id), eq(budgetTemplates.ledgerId, ledgerId)))
      .get();
    if (!exists) throw HttpError.notFound('模板不存在');
    if (exists.isDefault) {
      throw HttpError.business('内置模板不能直接修改，请复制一份再改');
    }
    ctx.db
      .update(budgetTemplates)
      .set({ name: input.name.trim(), note: input.note ?? null, itemsJson: payload, updatedAt: at })
      .where(eq(budgetTemplates.id, input.id))
      .run();
    return listTemplates(ctx, ledgerId).find((t) => t.id === input.id)!;
  }

  const id = newId(ID_PREFIX.budgetTemplate);
  ctx.db
    .insert(budgetTemplates)
    .values({
      id,
      ledgerId,
      name: input.name.trim(),
      note: input.note ?? null,
      itemsJson: payload,
      isDefault: false,
      createdBy: actorId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return listTemplates(ctx, ledgerId).find((t) => t.id === id)!;
}

/* ===================================================================== *
 * B-04 记账事前校验
 * ===================================================================== */

export interface PrecheckDto {
  /** 该分类当期有没有预算 */
  hasBudget: boolean;
  budgetAmount: string | null;
  /** 记这笔之前已经花了多少 */
  spentBefore: string;
  /** 记这笔之后会花多少 */
  spentAfter: string;
  /** 记这笔之后还剩多少。null = 没设预算 */
  remainingAfter: string | null;
  usedRatioAfter: string | null;
  /** 记这笔会不会超 */
  wouldExceed: boolean;
  /** 超了的话超出多少 */
  exceedBy: string | null;
  /** 结论级提示（前端直接展示，不要自己拼文案） */
  message: string;
}

/**
 * B-04 记账页的事前校验。
 *
 * ## 为什么在**服务端**算而不是前端
 *
 * 前端算要拿到「当前已花」，那是一次额外请求；更关键的是——
 * 前端算出来的结论**可能与保存时的实际校验不一致**（期间跨了月、
 * 期间有别的客户端改了预算）。前端提示「够」而后端 400，
 * 是最伤信任的一种失败。所以这里给的是**与保存路径同源的结论**。
 *
 * ## 为什么只提示不拦
 *
 * YNAB 强制调拨（超支必须先挪额度），随手记宽容标记。
 * 需求原文写的是「超剩余弹确认（**可继续**，标记超支）」—— 明确选了宽容。
 * 所以 `wouldExceed=true` 时前端弹确认而不是拒绝。
 */
export function precheckExpense(
  ctx: AppCtx,
  ledgerId: string,
  input: { categoryId?: string | null; amount: string | number; date?: string },
): PrecheckDto {
  const date = input.date ?? todayStr();
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const amount = toCents(input.amount);

  const row = input.categoryId
    ? ctx.db
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.ledgerId, ledgerId),
            eq(budgets.categoryId, input.categoryId),
            eq(budgets.year, year),
            eq(budgets.month, month),
          ),
        )
        .get()
    : ctx.db
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.ledgerId, ledgerId),
            isNull(budgets.categoryId),
            eq(budgets.year, year),
            eq(budgets.month, month),
          ),
        )
        .get();

  const spentBefore = row ? spentOfRow(ctx, ledgerId, row) : 0;
  const budgetCents = row?.amount ?? null;
  const spentAfter = spentBefore + amount;
  const remainingAfter = budgetCents === null ? null : budgetCents - spentAfter;
  const usedRatioAfter = budgetCents === null || budgetCents === 0 ? null : (spentAfter / budgetCents) * 100;
  const wouldExceed = remainingAfter !== null && remainingAfter < 0;

  let message: string;
  if (budgetCents === null) {
    message = input.categoryId ? '这个分类本月没有预算，可继续记账' : '本月没有设总预算';
  } else if (wouldExceed) {
    message = `记完这笔将超出预算 ${formatCents(-(remainingAfter as number))}，可继续记账并标记为超支`;
  } else if ((remainingAfter as number) < amount) {
    message = `记完这个月的预算就花完了（剩 ${formatCents(remainingAfter as number)}）`;
  } else {
    message = `记完还剩 ${formatCents(remainingAfter as number)}`;
  }

  return {
    hasBudget: Boolean(row),
    budgetAmount: budgetCents === null ? null : formatCents(budgetCents),
    spentBefore: formatCents(spentBefore),
    spentAfter: formatCents(spentAfter),
    remainingAfter: remainingAfter === null ? null : formatCents(remainingAfter),
    usedRatioAfter: usedRatioAfter === null ? null : usedRatioAfter.toFixed(1),
    wouldExceed,
    exceedBy: wouldExceed ? formatCents(-(remainingAfter as number)) : null,
    message,
  };
}

/* ===================================================================== *
 * B-13 家庭共享：可见性与写权限
 * ===================================================================== */

export interface BudgetVisibility {
  visibility: 'ledger' | 'private';
  ownerId: string | null;
  ownerName: string | null;
  /** 当前用户是否可改。私有预算只有 owner 能改 */
  canEdit: boolean;
  note: string | null;
}

/**
 * B-13 预算的可见性与权限。
 *
 * ## 为什么这条需求「几乎已经成立」
 *
 * 预算是账本级的（`ledger_id`），而账本本身就有成员与角色体系 ——
 * 所以「多人共享预算」在架构上早就是真的。真正缺的是两件事：
 *  ① 协作时「谁改的」要能查（→ `budget_changes` 留痕）
 *  ② 家���里有人不想让别人看到自己的额度（→ `visibility='private'`）
 *
 * 只补这两件，而不是重做一套协作预算系统 —— 那才是过度设计。
 */
export function budgetVisibility(
  ctx: AppCtx,
  budgetId: string,
  userId: string,
): BudgetVisibility | null {
  const row = ctx.db
    .select({
      visibility: budgets.visibility,
      ownerId: budgets.ownerId,
      createdBy: budgets.createdBy,
    })
    .from(budgets)
    .where(eq(budgets.id, budgetId))
    .get();
  if (!row) return null;
  const ownerName = row.ownerId
    ? (ctx.db.select({ nickname: users.nickname }).from(users).where(eq(users.id, row.ownerId)).get()?.nickname ?? null)
    : null;
  const isOwner = row.ownerId === userId;
  return {
    visibility: row.visibility as 'ledger' | 'private',
    ownerId: row.ownerId,
    ownerName,
    canEdit: row.visibility === 'ledger' || isOwner,
    note:
      row.visibility === 'private'
        ? isOwner
          ? '这是你的私有预算，其他成员看不到'
          : '这是其他成员的私有预算'
        : null,
  };
}

/**
 * 写一条变更留痕。所有预算写操作都要调它 —— 家庭账本里最常起争议的就是这类改动。
 *
 * ## 为什么先校验 budgetId 存不存在
 *
 * `budget_changes.budget_id` 上有 `ON DELETE SET NULL`，本意是「预算被删后留痕仍在」。
 * 但那只在**预算先被删、留痕后补写**时才成立；而删除路径上的留痕天然发生在
 * 删除之后 —— 于是插入时 budget_id 指向一行已不存在的记录，
 * SQLite 报 `FOREIGN KEY constraint failed`，整个删除请求 500。
 *
 * 症状极具迷惑性：用户看到「删除失败」，预算其实已经删掉了（DELETE 已执行），
 * 而报错栈指向 `recordChange`，完全看不出是「留痕与删除的先后顺序」。
 *
 * 这里显式查一次：预算还在就挂上 id，不在了就置 null（留痕本身仍然记录，
 * 那才是审计价值的所在 —— 「有人删了一条预算是 5 月 3 日」这件事必须留下）。
 */
export function recordChange(
  ctx: AppCtx,
  ledgerId: string,
  actorId: string,
  input: { budgetId?: string | null; action: string; before?: unknown; after?: unknown; note?: string | null },
): void {
  const budgetId =
    input.budgetId &&
    ctx.db.select({ id: budgets.id }).from(budgets).where(eq(budgets.id, input.budgetId)).get()
      ? input.budgetId
      : null;
  ctx.db
    .insert(budgetChanges)
    .values({
      id: newId(ID_PREFIX.budgetChange),
      ledgerId,
      budgetId,
      action: input.action,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
      note: input.note ?? null,
      actorId,
      createdAt: nowIso(),
    })
    .run();
}

export interface ChangeLogDto {
  id: string;
  budgetId: string | null;
  budgetLabel: string | null;
  action: string;
  before: string | null;
  after: string | null;
  note: string | null;
  actorName: string;
  createdAt: string;
}

export function listChanges(ctx: AppCtx, ledgerId: string, limit = 50): ChangeLogDto[] {
  const rows = ctx.db
    .select()
    .from(budgetChanges)
    .where(eq(budgetChanges.ledgerId, ledgerId))
    .orderBy(desc(budgetChanges.createdAt))
    .limit(Math.min(200, Math.max(1, limit)))
    .all();
  const actorNames = new Map(
    ctx.db.select().from(users).all().map((u) => [u.id, u.nickname]),
  );
  const budgetLabels = new Map(
    ctx.db
      .select()
      .from(budgets)
      .where(eq(budgets.ledgerId, ledgerId))
      .all()
      .map((b) => [
        b.id,
        b.categoryId
          ? (ctx.db.select({ name: categories.name }).from(categories).where(eq(categories.id, b.categoryId)).get()?.name ?? '（已删除）')
          : '总预算',
      ]),
  );
  return rows.map((r) => ({
    id: r.id,
    budgetId: r.budgetId,
    budgetLabel: r.budgetId ? (budgetLabels.get(r.budgetId) ?? null) : null,
    action: r.action,
    before: r.beforeJson,
    after: r.afterJson,
    note: r.note,
    actorName: actorNames.get(r.actorId) ?? '—',
    createdAt: r.createdAt,
  }));
}

/* ===================================================================== *
 * 共用工具
 * ===================================================================== */

export function toCents(v: string | number): number {
  if (typeof v === 'number') return Math.round(v);
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}