/**
 * 预算差异分析与复盘（docs/16 §7）。
 *
 * 口径纪律：
 *  ① 差异额 Δ = U − B；差异率 δ = Δ / |B| × 100%；**B=0 或对比期为 0 → null**
 *     （03 §10.4 除零约定），前端显示「—」，不能显示 ∞ 或 0%。
 *  ② 有利/不利按预算类型反转：支出类超支=不利；收入/储蓄类超收超存=有利。
 *  ③ 环比/同比用**等长区间**，不用「至今」（长度随今天几号漂移）。
 *  ④ 归因必须是可解释的启发式，每条都能点开看到依据，不做黑盒结论。
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { budgetSnapshots, budgets, categories, transactions, budgets as budgetsTable } from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { formatCents, nowIso } from '../../utils/money.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { writeAudit } from '../../utils/audit.js';
import { periodRange, recordChange } from './advanced.js';
import { snapshotAmounts } from './control.js';
import { budgetProgress, type BudgetProgressDto } from './service.js';

const cents = (v: string | number) => (typeof v === 'number' ? Math.trunc(v) : Math.round(Number(v) * 100));
const pct = (num: number, den: number): string | null => (den === 0 ? null : ((num / den) * 100).toFixed(1));
const ratioStr = (num: number, den: number): string | null => (den === 0 ? null : ((num / Math.abs(den)) * 100).toFixed(1));

export interface ReviewRow {
  budgetId: string;
  label: string;
  budgetKind: string;
  budget: string;
  actual: string;
  /** Δ = U − B（支出类正=超支；目标类正=超额达成） */
  variance: string;
  /** δ = Δ / |B| × 100，B=0 → null */
  varianceRatio: string | null;
  favorable: boolean | null;
  directionLabel: string;
  usedRatio: string | null;
  timeProgress: number;
  accuracy: string | null;
  over: boolean;
  /** 差异归因（最多 3 条，每条都带依据文案） */
  attributions: { kind: string; text: string }[];
}

export interface ReviewDto {
  period: string;
  periodLabel: string;
  rows: ReviewRow[];
  summary: {
    budget: string;
    actual: string;
    variance: string;
    varianceRatio: string | null;
    accuracy: string | null;
    favorableCount: number;
    unfavorableCount: number;
  };
  rankings: {
    overspend: { label: string; variance: string; varianceRatio: string | null }[];
    surplus: { label: string; variance: string; varianceRatio: string | null }[];
  };
  /** 环比 / 同比（等长区间，除零 → null） */
  comparison: {
    mom: CompareDto;
    yoy: CompareDto;
  };
}

export interface CompareDto {
  label: string;
  period: string;
  currentActual: string;
  previousActual: string | null;
  change: string | null;
  changeRatio: string | null;
  note: string | null;
}

/** 一个自然月的实际支出净额（不依赖是否设过预算，供环比同比/年度趋势） */
function actualOfPeriod(ctx: AppCtx, ledgerId: string, year: number, month: number): number {
  const p = periodRange('monthly', year, month);
  const row = ctx.db
    .select({
      s: sql<number>`coalesce(sum(case when ${transactions.adjustmentReason} in ('refund','reversal') then -${transactions.actualAmount} else ${transactions.actualAmount} end), 0)`,
    })
    .from(transactions)
    .where(and(
      eq(transactions.ledgerId, ledgerId),
      isNull(transactions.deletedAt),
      eq(transactions.recordType, 'expense'),
      sql`coalesce(${transactions.budgetExcluded}, '') = ''`,
      sql`${transactions.txDate} >= ${p.start}`,
      sql`${transactions.txDate} <= ${p.end}`,
    ))
    .get();
  return Number(row?.s ?? 0);
}

/**
 * 该月设过的预算额合计（总预算优先，避免总+分类重复相加）。
 * 不按 archived_at 过滤：同一账期可能只归档了一部分，漏掉归档行会让总额凭空少一块。
 */
function budgetOfPeriod(ctx: AppCtx, ledgerId: string, year: number, month: number): number {
  const rows = ctx.db.select({ categoryId: budgets.categoryId, amount: budgets.amount })
    .from(budgets)
    .where(and(eq(budgets.ledgerId, ledgerId), eq(budgets.year, year), eq(budgets.month, month)))
    .all();
  const total = rows.find((r) => r.categoryId === null);
  if (total) return total.amount;
  return rows.reduce((a, r) => a + r.amount, 0);
}

const prevMonth = (y: number, m: number) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });

/** 差异归因：单笔大额 / 量价拆解 / 一次性事件 / 节奏因素 */
function attribute(
  ctx: AppCtx,
  ledgerId: string,
  row: BudgetProgressDto,
  from: string,
  to: string,
  varianceCents: number,
): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const catId = row.categoryId;

  // ① 单笔大额：本期该分类最大 3 笔占比
  const conds = [
    eq(transactions.ledgerId, ledgerId),
    isNull(transactions.deletedAt),
    eq(transactions.recordType, 'expense'),
    sql`coalesce(${transactions.budgetExcluded}, '') = ''`,
    sql`${transactions.adjustmentReason} is null or ${transactions.adjustmentReason} not in ('refund','reversal')`,
    sql`${transactions.txDate} >= ${from}`,
    sql`${transactions.txDate} <= ${to}`,
  ];
  if (catId) conds.push(sql`(${transactions.categoryId} = ${catId} or ${transactions.parentCategoryId} = ${catId})`);
  const top = ctx.db
    .select({ a: transactions.actualAmount, name: transactions.name })
    .from(transactions).where(and(...conds))
    .orderBy(sql`${transactions.actualAmount} desc`).limit(3).all();
  const actual = cents(row.spentAmount);
  const topSum = top.reduce((a, t) => a + t.a, 0);
  const biggest = top[0];
  if (biggest && actual > 0 && topSum / actual >= 0.5) {
    out.push({
      kind: 'large_single',
      text: `${top.length} 笔大额占 ${Math.round((topSum / actual) * 100)}%，最大一笔 ${formatCents(biggest.a)}${biggest.name ? `（${biggest.name}）` : ''}`,
    });
  }

  // ② 量价拆解：与上一等长区间比笔数与客单价
  const pm = prevMonth(row.year, row.month ?? 1);
  const pp = periodRange('monthly', pm.y, pm.m);
  const countOf = (f: string, t: string) => {
    const c = [
      eq(transactions.ledgerId, ledgerId), isNull(transactions.deletedAt), eq(transactions.recordType, 'expense'),
      sql`${transactions.txDate} >= ${f}`, sql`${transactions.txDate} <= ${t}`,
    ];
    if (catId) c.push(sql`(${transactions.categoryId} = ${catId} or ${transactions.parentCategoryId} = ${catId})`);
    const r = ctx.db.select({ n: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${transactions.actualAmount}),0)` })
      .from(transactions).where(and(...c)).get();
    return { n: Number(r?.n ?? 0), s: Number(r?.s ?? 0) };
  };
  const cur = countOf(from, to);
  const pre = countOf(pp.start!, pp.end!);
  if (cur.n > 0 && pre.n > 0 && (cur.n !== pre.n || Math.abs(cur.s / cur.n - pre.s / pre.n) > 100)) {
    const dn = cur.n - pre.n;
    const price = Math.round(cur.s / cur.n - pre.s / pre.n);
    out.push({
      kind: 'volume_price',
      text: `笔数 ${dn >= 0 ? '+' : ''}${dn}、客单价 ${price >= 0 ? '+' : ''}${formatCents(price)}（对比 ${pp.key}）`,
    });
  }

  // ③ 一次性事件：本期含退款/冲减、跨月补记、分期首期
  const special = ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(
      eq(transactions.ledgerId, ledgerId), isNull(transactions.deletedAt),
      sql`${transactions.txDate} >= ${from}`, sql`${transactions.txDate} <= ${to}`,
      sql`(${transactions.adjustmentReason} in ('refund','reversal') or ${transactions.installmentPlanId} is not null or ${transactions.createdAt} > ${to})`,
    )).get();
  if (Number(special?.n ?? 0) > 0) {
    out.push({
      kind: 'one_off',
      text: `本期含 ${special!.n} 笔一次性事项（退款/冲减、分期首期或跨月补记）；分期按 03 §7.7 不分摊`,
    });
  }

  // ④ 节奏因素
  if (Number(row.usedRatio) - row.timeProgress > 10) {
    out.push({
      kind: 'pace',
      text: `时间才过 ${row.timeProgress}%，已用 ${row.usedRatio}%，执行快于时间进度`,
    });
  }

  // ⑤ 无具体归因时给一条诚实的结论，不留空数组让用户以为没算
  if (!out.length) {
    out.push({
      kind: 'structure',
      text: varianceCents > 0
        ? '无单笔大额或量价突变，差异来自多笔日常消费的累积'
        : '支出低于计划，未见异常单笔',
    });
  }
  return out.slice(0, 3);
}

/** 主入口：预算 vs 实际对照表 + 差异 + 归因 + 排行 + 准确率 */
export function budgetReview(ctx: AppCtx, ledgerId: string, year: number, month: number): ReviewDto {
  const p = periodRange('monthly', year, month);
  /** 归档期也要有对照表：includeArchived + 快照锁定 B/U，而不是返回空数组 */
  const rows = budgetProgress(ctx, ledgerId, year, month, {}, { includeArchived: true });
  const snap = snapshotAmounts(ctx, ledgerId, p.key);
  const catNames = new Map(ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all().map((c) => [c.id, c.name]));

  const outRows: ReviewRow[] = rows.map((r) => {
    const hist = snap.get(r.id);
    const B = hist ? hist.budget : cents(r.amount);
    const U = hist ? hist.actual : cents(r.spentAmount);
    const D = U - B;
    const isTarget = r.budgetKind !== 'expense';
    /** 有利/不利：支出类 Δ≤0 有利；目标类 Δ≥0 有利 */
    const favorable = B === 0 ? null : isTarget ? D >= 0 : D <= 0;
    const accuracy = B === 0 ? null : (Math.max(0, 1 - Math.abs(D) / B) * 100).toFixed(1);
    return {
      budgetId: r.id,
      label: r.categoryName ?? r.projectLabel ?? catNames.get(r.categoryId ?? '') ?? '总预算',
      budgetKind: r.budgetKind,
      budget: formatCents(B),
      actual: formatCents(U),
      variance: formatCents(D),
      varianceRatio: ratioStr(D, B),
      favorable,
      directionLabel: favorable === null ? '无预算' : favorable ? '有利' : '不利',
      usedRatio: B === 0 ? null : ((U / B) * 100).toFixed(1),
      timeProgress: r.timeProgress,
      accuracy,
      over: !isTarget && B > 0 && U > B,
      attributions: attribute(ctx, ledgerId, r, p.start!, p.end!, D),
    };
  });

  // 超支置顶 → 按 |Δ| 降序（budgetProgress 已按 over 排过，这里再稳一次）
  outRows.sort((a, b) => {
    if (a.over !== b.over) return a.over ? -1 : 1;
    return Math.abs(cents(b.variance)) - Math.abs(cents(a.variance));
  });

  const totalRow = outRows.find((r) => r.budgetKind === 'expense' && rows.find((p0) => p0.id === r.budgetId)?.categoryId === null);
  const B = totalRow ? cents(totalRow.budget) : outRows.reduce((a, r) => a + cents(r.budget), 0);
  const U = totalRow ? cents(totalRow.actual) : outRows.reduce((a, r) => a + cents(r.actual), 0);
  const D = U - B;

  /** 排行只对支出类有意义（收入/储蓄的「超」是好消息，混进来会误导） */
  const expenseRows = outRows.filter((r) => r.budgetKind === 'expense');
  const byVar = [...expenseRows].sort((a, b) => cents(b.variance) - cents(a.variance));
  const rank = (list: ReviewRow[]) => list.slice(0, 5).map((r) => ({
    label: r.label, variance: r.variance, varianceRatio: r.varianceRatio,
  }));

  const cur = actualOfPeriod(ctx, ledgerId, year, month);
  const pm = prevMonth(year, month);
  const buildCompare = (label: string, py: number, pmo: number): CompareDto => {
    const prev = actualOfPeriod(ctx, ledgerId, py, pmo);
    const chg = cur - prev;
    return {
      label,
      period: periodRange('monthly', py, pmo).key,
      currentActual: formatCents(cur),
      previousActual: prev === 0 ? null : formatCents(prev),
      change: prev === 0 ? null : formatCents(chg),
      changeRatio: pct(chg, prev),
      // 对比期为 0 → 「—」而非 ∞（03 §10.4）
      note: prev === 0 ? '对比期无支出，变动率不计算（显示「—」）' : null,
    };
  };

  return {
    period: p.key,
    periodLabel: p.label,
    rows: outRows,
    summary: {
      budget: formatCents(B),
      actual: formatCents(U),
      variance: formatCents(D),
      varianceRatio: ratioStr(D, B),
      accuracy: B === 0 ? null : (Math.max(0, 1 - Math.abs(D) / B) * 100).toFixed(1),
      favorableCount: outRows.filter((r) => r.favorable === true).length,
      unfavorableCount: outRows.filter((r) => r.favorable === false).length,
    },
    rankings: {
      overspend: rank(byVar.filter((r) => cents(r.variance) > 0)),
      surplus: rank(byVar.filter((r) => cents(r.variance) < 0).reverse()),
    },
    comparison: {
      mom: buildCompare('环比（上一自然月）', pm.y, pm.m),
      yoy: buildCompare('同比（去年同月）', year - 1, month),
    },
  };
}

/**
 * 年度趋势：12 个月的 B / U / δ（缺数据的月份留空，不补 0）。
 *
 * ⚠️ 已归档月份必须读 **快照**，不能重算：归档是「当时的历史事实」，
 * 之后用户改了预算额、补记了上月账单，趋势图都不该跟着变形（docs/16 §8）。
 * 早期版本一边把归档行从 budgetOfPeriod 里过滤掉、一边仍按 hasBudget 画点，
 * 结果是归档月出现「有预算线但金额是 0」的幽灵柱 —— 不报错、看着像数据缺失。
 */
export function annualTrend(ctx: AppCtx, ledgerId: string, year: number) {
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  /** 快照里没存 categoryId，用 budgetId 反查哪些是「总预算」行 */
  const totalIds = new Set(
    ctx.db.select({ id: budgets.id }).from(budgets)
      .where(and(eq(budgets.ledgerId, ledgerId), isNull(budgets.categoryId)))
      .all().map((r) => r.id),
  );
  const snaps = ctx.db.select().from(budgetSnapshots)
    .where(eq(budgetSnapshots.ledgerId, ledgerId)).all();
  const byPeriod = new Map<string, typeof snaps>();
  for (const s of snaps) {
    const list = byPeriod.get(s.periodKey) ?? [];
    list.push(s);
    byPeriod.set(s.periodKey, list);
  }

  return months.map((m) => {
    const period = periodRange('monthly', year, m).key;
    const snap = byPeriod.get(period);
    if (snap?.length) {
      /** 与实时口径一致：存在总预算行时只认它，避免总+分类重复相加 */
      const total = snap.find((s) => !!s.budgetId && totalIds.has(s.budgetId));
      const use = total ? [total] : snap;
      const B = use.reduce((a, s) => a + s.amount, 0);
      const U = use.reduce((a, s) => a + s.actual, 0);
      return {
        month: m, period, archived: true,
        budget: formatCents(B),
        actual: U === 0 ? null : formatCents(U),
        variance: formatCents(U - B),
        varianceRatio: ratioStr(U - B, B),
      };
    }
    const U = actualOfPeriod(ctx, ledgerId, year, m);
    const B = budgetOfPeriod(ctx, ledgerId, year, m);
    const hasBudget = ctx.db.select({ id: budgetsTable.id }).from(budgetsTable)
      .where(and(eq(budgetsTable.ledgerId, ledgerId), eq(budgetsTable.year, year), eq(budgetsTable.month, m)))
      .get();
    return {
      month: m, period, archived: false,
      budget: hasBudget ? formatCents(B) : null,
      actual: U === 0 ? null : formatCents(U),
      variance: hasBudget ? formatCents(U - B) : null,
      varianceRatio: hasBudget ? ratioStr(U - B, B) : null,
    };
  });
}

export interface NextSuggestion {
  categoryId: string | null;
  /** 专项项目 / 标签预算靠 scope 区分：总预算和它们的 categoryId 都是 null */
  scope: string;
  scopeId: string | null;
  projectLabel: string | null;
  label: string;
  budgetKind: string;
  currentAmount: string;
  suggestedAmount: string;
  changeRatio: string | null;
  reason: string;
}

/**
 * 下期调额建议：近 3 期实际 P50 为基准，叠加本期差异收敛。
 * 建议额 = clamp(P50 × (1 + 0.5 × δ/100), 原额 × 0.5, 原额 × 2)
 */
export function nextSuggestions(ctx: AppCtx, ledgerId: string, year: number, month: number): {
  period: string;
  nextPeriod: string;
  items: NextSuggestion[];
  note: string;
} {
  /** 归档期也要能出下期建议，否则「复盘 → 生成下月预算」在归档后整条链路断掉 */
  const rows = budgetProgress(ctx, ledgerId, year, month, {}, { includeArchived: true });
  const snap = snapshotAmounts(ctx, ledgerId, periodRange('monthly', year, month).key);
  const nm = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const nextKey = periodRange('monthly', nm.y, nm.m).key;
  const catNames = new Map(ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all().map((c) => [c.id, c.name]));

  const items: NextSuggestion[] = rows.map((r) => {
    const hist = snap.get(r.id);
    const B = hist ? hist.budget : cents(r.amount);
    const U = hist ? hist.actual : cents(r.spentAmount);
    const delta = B === 0 ? 0 : (U - B) / Math.abs(B);
    const isTarget = r.budgetKind !== 'expense';

    // 近 3 期（含本期）该口径的实际，取中位数
    const samples: number[] = [];
    for (let k = 2; k >= 0; k--) {
      let y = year;
      let m = month - k;
      while (m <= 0) { m += 12; y -= 1; }
      const v = k === 0 ? U : actualOfPeriod(ctx, ledgerId, y, m);
      if (v > 0) samples.push(v);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? U;

    /** 目标类方向反转：超收超存不该被「收敛」下去 */
    const adjust = isTarget ? -delta * 0.5 : delta * 0.5;
    const raw = Math.round(median * (1 + adjust));
    const lo = Math.round(B * 0.5);
    const hi = Math.round(B * 2);
    const suggested = B === 0 ? raw : Math.min(hi, Math.max(lo, raw));
    const change = B === 0 ? null : ((suggested - B) / B) * 100;

    let reason: string;
    if (samples.length < 2) reason = '历史样本不足 2 期，按本期实际给出保守建议';
    else if (isTarget && delta > 0.1) reason = `达成率 ${r.usedRatio}%，超额完成，建议适度上调目标`;
    else if (!isTarget && delta > 0.1) reason = `本期超支 ${formatCents(U - B)}，按近 3 期中位数上调`;
    else if (!isTarget && delta < -0.1) reason = `本期有结余，按近 3 期中位数下调，释放额度`;
    else reason = '执行接近计划，按近 3 期中位数微调（单次调整幅度限制在原额 ±50% 内）';

    return {
      categoryId: r.categoryId,
      scope: r.scope,
      scopeId: r.scopeId,
      projectLabel: r.projectLabel,
      label: r.categoryName ?? r.projectLabel ?? catNames.get(r.categoryId ?? '') ?? '总预算',
      budgetKind: r.budgetKind,
      currentAmount: formatCents(B),
      suggestedAmount: formatCents(suggested),
      changeRatio: change === null ? null : change.toFixed(1),
      reason,
    };
  });

  return {
    period: periodRange('monthly', year, month).key,
    nextPeriod: nextKey,
    items,
    note: '近 3 期实际支出的 P50 中位数为基准（一次大额不会污染后面几个月），叠加本期差异收敛；单次调整限制在原额 0.5~2 倍',
  };
}

/** 一键生成下月预算：预览确认后批量写入，已存在的行跳过且不覆盖 */
export function generateNextBudgets(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: {
    year: number;
    month: number;
    items: {
      categoryId: string | null;
      amount: string | number;
      budgetKind?: string;
      scope?: string;
      scopeId?: string | null;
      projectLabel?: string | null;
    }[];
  },
) {
  const nm = input.month === 12 ? { y: input.year + 1, m: 1 } : { y: input.year, m: input.month + 1 };
  /**
   * 判重键必须带上 scope：总预算与专项项目预算的 categoryId 都是 null，
   * 只用 categoryId + kind 会把「总预算」和「装修」判成同一条，项目预算永远被跳过。
   */
  const keyOf = (scope: string | null | undefined, scopeId: string | null | undefined, categoryId: string | null, kind: string) =>
    `coalesce:${scope ?? 'category'}|${scopeId ?? categoryId ?? '__total__'}|${kind}`;
  const existing = new Set(
    ctx.db.select({ categoryId: budgets.categoryId, budgetKind: budgets.budgetKind, scope: budgets.scope, scopeId: budgets.scopeId }).from(budgets)
      .where(and(eq(budgets.ledgerId, ledgerId), eq(budgets.year, nm.y), eq(budgets.month, nm.m)))
      .all().map((r) => keyOf(r.scope, r.scopeId, r.categoryId, r.budgetKind ?? 'expense')),
  );
  let created = 0;
  let skipped = 0;
  const at = nowIso();
  ctx.db.transaction((tx) => {
    for (const item of input.items) {
      const kind = item.budgetKind ?? 'expense';
      const scope = item.scope ?? 'category';
      const key = keyOf(scope, item.scopeId, item.categoryId ?? null, kind);
      const amount = cents(item.amount);
      if (amount <= 0 || existing.has(key)) { skipped += 1; continue; }
      tx.insert(budgets).values({
        id: newId(ID_PREFIX.budget),
        ledgerId,
        categoryId: item.categoryId ?? null,
        scope,
        scopeId: item.scopeId ?? null,
        projectLabel: item.projectLabel ?? null,
        periodType: 'monthly',
        year: nm.y,
        month: nm.m,
        amount,
        rollover: false,
        alertRatio: 80,
        budgetKind: kind,
        budgetMethod: 'historical',
        createdBy: actorId,
        createdAt: at,
      }).run();
      existing.add(key);
      created += 1;
    }
  });
  recordChange(ctx, ledgerId, actorId, {
    action: 'generate_next', after: { period: periodRange('monthly', nm.y, nm.m).key, created, skipped }, note: null,
  });
  writeAudit(ctx.db, {
    ledgerId, actorId, action: 'create', entityType: 'budget', entityId: 'generate-next',
    summary: `一键生成 ${periodRange('monthly', nm.y, nm.m).key} 预算（新建 ${created}、跳过 ${skipped}）`,
  });
  return { period: periodRange('monthly', nm.y, nm.m).key, created, skipped };
}

/** 方法说明（前端折叠区直接展示，避免把规则藏在代码里） */
export const METHOD_DOCS = [
  { key: 'zero_base', name: '零基预算', desc: '每块钱都要有归属；总额 − 已分配 = 未分配余额，显式提示而非拒绝超额分配' },
  { key: 'envelope', name: '信封法', desc: '先把总额装进各分类信封，未装完的留在「未分配」；中途可调拨' },
  { key: 'ratio', name: '比例模板', desc: '50/30/20 等；基数 = 收入 − 固定支出，不是全部收入' },
  { key: 'historical', name: '历史智能推荐', desc: '近 3 个月 P50 中位数，不是月均 —— 一次旅行不污染后面三个月' },
  { key: 'elastic', name: '弹性预算', desc: '有效额度 = 固定基数 + 本期收入 × 浮动比例，随收入入账实时上浮' },
];

/** 周期归属细则（前端折叠区） */
export const PERIOD_RULES = [
  { key: 'tx_date', name: '按消费日期归属', desc: '一律 tx_date；跨月补记、跨月退款落在各自所属账期，不回滚原月' },
  { key: 'installment', name: '分期与预付', desc: '默认一次性全额占用消费确认月（03 §7.7 不做费用分摊）；可选「按还款期分摊」仅改预算展示口径，不改账务' },
  { key: 'excluded', name: '报销与转账', desc: '转账、应收、应付、余额调整、报销/代垫标记均不占预算；退款按冲减项相减，绝不记成收入' },
  { key: 'period', name: '周期', desc: '月 / 周 / 年 / 自定义账期统一按实际起止日统计；账期天数取该区间本身，不按自然月' },
];
