/**
 * 预算管理（`docs/05 §十六` / `docs/04 §十四`）。
 *
 * ## 预警档位为什么是这四档
 *
 * 文档给的是「健康 <70% / 注意 70~90% / 警告 >90% / 超支」。落到 API 上合并成
 * 三档 `alertLevel`（`normal` / `warning` / `danger`）加一个布尔 `over`：
 * 「超支」不是一个独立档位，而是 `usedRatio > 100` 的**事实** —— 用户最需要的
 * 是「超了没有」这个是非判断，而不是又一档颜色。若把它做成第四档，
 * 前端就会出现「danger 和 over 同时为真但不知道听谁的」。
 *
 * ## 「已花」的口径
 *
 * 预算只对**支出**有意义，所以 `spentAmount` = 区间内 `record_type='expense'` 的
 * `actual_amount` 之和（含手续费/折扣，即用户实际掏的钱）。
 * 收入不冲减预算 —— 「用收入抵扣预算」是另一种产品（预算余额结转），
 * `rollover` 已经承担了「上月余额结转」这个诉求。
 *
 * ## 总预算与分类预算的关系
 *
 * `categoryId = null` 的那条是**账本级总预算**，与分类预算**并行存在、不做加总校验**。
 * 理由：总预算是「这个月我打算花多少」的总额约束，分类预算是分解。
 * 如果强制 `Σ分类预算 ≤ 总预算`，用户在只设了「餐饮 3000」时会因为
 * 「3000 > 15000？不，3000 ≤ 15000 通过」而困惑于另一种场景：
 * 只设总预算 15000 却没设任何分类时，无法校验。总预算是**独立的目标值**。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  budgets,
  budgetTransfers,
  categories,
  transactions,
  transactionTags,
  users,
} from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { periodRange } from './advanced.js';

export interface BudgetDto {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  periodType: string;
  year: number;
  month: number | null;
  /** 稳定账期标识：`2026-10` 或 `2026-10-12..2026-10-18`（预警去重与结转都用它） */
  period: string;
  /** 人类可读账期名。自然月是「2026 年 10 月」，周预算是「10-12 起一周」 */
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** 本期总天数（28/29/30/31 或 7）。节奏与预测都基于它 */
  periodDays: number;
  amount: string;
  rollover: boolean;
  alertRatio: number;
  /** B-05：关掉后这条预算不产生预警 */
  alertEnabled: boolean;
  /** B-12 定位维度：category | tag | project */
  scope: string;
  scopeId: string | null;
  projectLabel: string | null;
  /** B-13 可见性 */
  visibility: string;
  ownerId: string | null;
  createdAt: string;
}

export interface BudgetProgressDto extends BudgetDto {
  spentAmount: string;
  remainingAmount: string;
  usedRatio: string;
  /** 是否已超支（布尔事实，优先于档位） */
  over: boolean;
  alertLevel: 'normal' | 'warning' | 'danger';
  status: 'healthy' | 'watch' | 'warning' | 'over';

  /* ---------- 节奏（B-03 时间进度 / B-10 期末预测） ---------- */

  /**
   * 时间进度（0-100）。**本月已经过去多少**。
   *
   * 为什么必须与 `usedRatio` 并列看：单看执行率会骗人。
   * 28 天的月份在 14 号就过去一半，若已用 50%，看起来「刚好按节奏」；
   * 而 31 天的月份在 14 号只过去 45%，同样 50% 就是「略微超前」。
   * 两个数字放在一起才有判断依据。
   *
   * 口径：已过天数 ÷ 本期总天数。**不是**「今天几号 ÷ 31」。
   */
  timeProgress: number;
  timeProgressRatio: string;

  /**
   * 节奏判定 —— 这是本页**唯一**需要用户做决策的字段：
   * · `behind`  花钱快于时间，按这个速度期末会超
   * · `on_track` 按节奏
   * · `ahead`   花钱慢于时间，期末大概率有结余
   *
   * 阈值 ±10 个百分点（见 `PACE_TOLERANCE_PP`）。
   */
  pace: 'ahead' | 'on_track' | 'behind';

  /**
   * 剩余天数里**每天还能花多少** —— 比「还剩多少钱」可行动得多。
   * `null` = 已超支（谈「每天还能花」没有意义）。
   */
  dailyRemaining: string | null;
  /** 若不调整消费，按当前速度每天会花多少（与上一项对比即知超不超） */
  dailyBurn: string;
  /**
   * 预测可信度：`null` = **已过天数不足，不做预测**。
   *
   * 用前 1 天的消费外推整月是统计上的胡来：任何一天的随机性（今天正好买了台
   * 家电）都会被放大 30 倍。所以未过 3 天时不给预测，页面显示「数据不足，
   * 过了 3 天开始预测」。
   */
  projectedSpent: string | null;
  projectedOver: string | null;
  projectedRatio: string | null;

  /** 本期总天数（28/29/30/31），供前端说明「为什么这个月不一样长」 */
  periodDays: number;
  /** 已过天数 */
  elapsedDays: number;
  remainingDays: number;

  /**
   * 零基分配视角（B-02）。挂在**每一行**上（内容相同），
   * 这样前端不需要第二个端点、也不需要额外一次请求就能画分配条。
   */
  allocation: {
    total: string | null;
    allocated: string;
    unallocated: string | null;
    overAllocated: string | null;
    allocationRatio: string | null;
    message: string | null;
  };
}

/** 请求体里的金额 → 分（API 层收「元」字符串，表内存分，与全站口径一致） */
function toCents(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function periodLabel(year: number, month: number | null): string {
  return month === null ? String(year) : `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * 账期校验（B-07 多周期）。
 *
 * ⚠️ **周预算与自定义账期的校验必须在这里，而不能只在路由层**。
 * 路由 schema 已经放宽了 `periodType` 的枚举，但这个函数原本还写着
 * 「只支持 monthly / yearly」—— 结果是「接口文档说支持周预算、
 * 路由也接受了，实际一建就 400」。这正是项目记忆里那条
 * 「规则层校验必须逐条对齐生成路径」的同类：新增能力时忘了改下游校验。
 *
 * 校验规则：
 * · monthly / yearly：沿用既有语义（yearly 不带月份）
 * · weekly / custom：**必须有起止日**，且 end ≥ start；
 *   month 仍然必填（它决定这条预算归到哪个月，见 schema.ts 里
 *   「按起始月归期」的说明）
 */
function validatePeriod(
  periodType: string,
  year: number,
  month: number | null,
  periodStart?: string | null,
  periodEnd?: string | null,
): void {
  if (periodType === 'monthly') {
    if (month === null || month < 1 || month > 12) {
      throw HttpError.validation([{ field: 'month', message: '月度预算必须指定 1-12 的月份' }]);
    }
    return;
  }
  if (periodType === 'yearly') {
    if (month !== null) {
      throw HttpError.validation([{ field: 'month', message: '年度预算不应带月份' }]);
    }
    return;
  }
  if (periodType === 'weekly' || periodType === 'custom') {
    if (month === null || month < 1 || month > 12) {
      throw HttpError.validation([
        { field: 'month', message: '周/自定义账期仍需指定归属月份（1-12）' },
      ]);
    }
    if (!periodStart || !periodEnd) {
      throw HttpError.validation([
        { field: 'periodStart', message: `${periodType === 'weekly' ? '周' : '自定义账期'}预算必须给出账期起止日` },
      ]);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      throw HttpError.validation([{ field: 'periodStart', message: '日期格式应为 YYYY-MM-DD' }]);
    }
    if (periodEnd < periodStart) {
      throw HttpError.validation([{ field: 'periodEnd', message: '账期结束日不能早于开始日' }]);
    }
    return;
  }
  throw HttpError.validation([
    { field: 'periodType', message: '预算周期只支持 monthly / yearly / weekly / custom' },
  ]);
}

/** 该期间内的支出合计（分），口径见文件头 */
/**
 * 账本级已花。
 *
 * ⚠️ 参数是**起止日**而不是年月 —— 周预算的「已花」必须是那 7 天的，
 * 按自然月算会让每周 120 的预算显示成「本月已花 480」，看起来像严重超支。
 * 这是「口径用错但数字仍然合理」的那一类：不会有任何报错，
 * 只会让用户以为自己在超支。
 */
function spentInPeriod(ctx: AppCtx, ledgerId: string, from: string, to: string): number {
  const row = ctx.db
    .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        sql`${transactions.deletedAt} is null`,
        eq(transactions.recordType, 'expense'),
        sql`${transactions.txDate} >= ${from}`,
        sql`${transactions.txDate} <= ${to}`,
      ),
    )
    .get();
  return Number(row?.s ?? 0);
}

/** 分类在该期间的支出（含其子分类 —— 子分类的账单 parentCategoryId 指向一级） */
/** 分类在该期间的支出（含其子分类 —— 子分类的账单 parentCategoryId 指向一级）。起止日由调用方给。 */
function spentByCategory(ctx: AppCtx, ledgerId: string, categoryId: string, from: string, to: string): number {
  const row = ctx.db
    .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        sql`${transactions.deletedAt} is null`,
        eq(transactions.recordType, 'expense'),
        // 一级分类的账单 categoryId 本身就是它；子分类的账单 parentCategoryId 是一级
        sql`(${transactions.categoryId} = ${categoryId} or ${transactions.parentCategoryId} = ${categoryId})`,
        sql`${transactions.txDate} >= ${from}`,
        sql`${transactions.txDate} <= ${to}`,
      ),
    )
    .get();
  return Number(row?.s ?? 0);
}

function toDto(row: typeof budgets.$inferSelect, name: string | null): BudgetDto {
  /**
   * 账期一律经 `periodRange()` 解析（从 advanced.ts 导入）。
   * 早期版本在这里自己拼 `${year}-${month}`，结果周预算的 period 显示成
   * 「2026-10」而不是「10-12 起一周」—— 用户看着像自然月，
   * 而它的天数是 7。**口径分散在两处就一定会有一处错**。
   */
  const p = periodRange(row.periodType, row.year, row.month, row.periodStart, row.periodEnd);
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: name,
    periodType: row.periodType,
    year: row.year,
    month: row.month,
    period: p.key,
    periodLabel: row.periodLabel ?? p.label,
    periodStart: p.start,
    periodEnd: p.end,
    periodDays: p.days,
    scope: row.scope ?? 'category',
    scopeId: row.scopeId,
    projectLabel: row.projectLabel,
    visibility: row.visibility ?? 'ledger',
    ownerId: row.ownerId,
    alertEnabled: row.alertEnabled ?? true,
    amount: formatCents(row.amount),
    rollover: row.rollover,
    alertRatio: row.alertRatio,
    createdAt: row.createdAt,
  };
}

function levelOf(usedRatio: number, alertRatio: number): BudgetProgressDto['alertLevel'] {
  if (usedRatio > 100) return 'danger';
  // 预警线由每条预算自己配（默认 80）：到线 → warning；到线 +10pt → danger
  if (usedRatio >= alertRatio + 10) return 'danger';
  if (usedRatio >= alertRatio) return 'warning';
  return 'normal';
}

/**
 * 按**实际起止日**算「截至今天已过多少天」。
 *
 * 三个情形：
 * · 整个区间在过去 → 全部已过（totaldays）
 * · 整个区间在未来 → 0
 * · 跨越今天 → 今天 − 起点 + 1（**含今天**：今天已经过去大半天，
 *   而且用户看到「还剩 0 天」比「还剩 1 天」更符合直觉）
 */
function elapsedDaysOfRange(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const s = new Date(`${start}T00:00:00`).getTime();
  const e = new Date(`${end}T00:00:00`).getTime();
  const total = Math.round((e - s) / 86_400_000) + 1;
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (t0 < s) return 0;
  if (t0 > e) return total;
  return Math.round((t0 - s) / 86_400_000) + 1;
}

const STATUS_LABEL: Record<BudgetProgressDto['alertLevel'], BudgetProgressDto['status']> = {
  normal: 'healthy',
  warning: 'warning',
  danger: 'over',
};

  /**
   * 节奏判定阈值（百分点）。预算用掉率 − 时间进度 超过它才算「超前」。
   *
   * 为什么是 10 而不是 0：预算与消费天生不对齐（房租在月初、工资在月末），
   * 严格执行率等于时间进度会在月初天天报「超前」，那是**噪音不是信号**。
   * 10 个百分点足够滤掉这种日常抖动，又能抓住「月中已经花掉大半」这种真实问题。
   */
  const PACE_TOLERANCE_PP = 10;
  /** 预测至少需要经过这么多天 */
  const MIN_DAYS_FOR_PREDICTION = 3;

  function withProgress(dto: BudgetDto, spent: number): BudgetProgressDto {
    const budgetCents = Math.round(Number(dto.amount) * 100);
    const remaining = budgetCents - spent;
    const usedRatio = budgetCents > 0 ? (spent / budgetCents) * 100 : 0;
    const alertLevel = levelOf(usedRatio, dto.alertRatio);
    const over = usedRatio > 100;

    /* ---------- 节奏：本期多长、过了多少 ---------- */
    /**
     * ⚠️ 天数必须取自**这条预算自己的账期**，不是自然月。
     * 周预算是 7 天：按自然月算会让「时间进度」在第 1 天就显示 3%，
     * 每天可花也会被算成 1/30 而不是 1/7 —— 数字看着合理（都是正数），
     * 但结论完全错。这是「口径用错但不会报错」的那一类 bug。
     */
    const periodDays = dto.periodDays;
    const elapsedDays = elapsedDaysOfRange(dto.periodStart, dto.periodEnd);
    const remainingDays = Math.max(0, periodDays - elapsedDays);
    const timeProgress = periodDays > 0 ? (elapsedDays / periodDays) * 100 : 100;

    /* ---------- 预测：已过天数不足就不预测 ---------- */
    const canPredict = elapsedDays >= MIN_DAYS_FOR_PREDICTION;
    const projected = canPredict ? Math.round((spent / elapsedDays) * periodDays) : null;
    const projectedOver = projected === null ? null : projected - budgetCents;

    /* ---------- 每天可花多少 ---------- */
    const dailyRemaining = remaining > 0 && remainingDays > 0 ? Math.floor(remaining / remainingDays) : null;
    const dailyBurn = elapsedDays > 0 ? Math.floor(spent / elapsedDays) : 0;

    /**
     * 节奏判定。**只在能预测时给结论** —— 前 3 天的数据不足以判断速度，
     * 报一个「on_track」会让用户以为系统确认了，实际什么都没说。
     */
    const pace: BudgetProgressDto['pace'] =
      remaining <= 0 ? 'behind' : canPredict ? (usedRatio - timeProgress > PACE_TOLERANCE_PP ? 'behind' : usedRatio - timeProgress < -PACE_TOLERANCE_PP ? 'ahead' : 'on_track') : 'on_track';

    return {
      ...dto,
      spentAmount: formatCents(spent),
      remainingAmount: formatCents(remaining),
      usedRatio: usedRatio.toFixed(1),
      over,
      alertLevel,
      status: over ? 'over' : STATUS_LABEL[alertLevel],
      timeProgress: Math.round(timeProgress),
      timeProgressRatio: timeProgress.toFixed(1),
      pace,
      projectedSpent: projected === null ? null : formatCents(projected),
      projectedOver: projectedOver === null ? null : formatCents(projectedOver),
      projectedRatio: projected === null || budgetCents === 0 ? null : ((projected / budgetCents) * 100).toFixed(1),
      dailyRemaining: dailyRemaining === null ? null : formatCents(dailyRemaining),
      dailyBurn: formatCents(dailyBurn),
      periodDays,
      elapsedDays,
      remainingDays,
      // 占位：`withAllocation` 会统一覆盖。单独调 `withProgress` 时给一个「无总额」的安全默认。
      allocation: {
        total: null,
        allocated: formatCents(0),
        unallocated: null,
        overAllocated: null,
        allocationRatio: null,
        message: null,
      },
    };
  }

export function listBudgets(ctx: AppCtx, ledgerId: string, year: number, month?: number): BudgetDto[] {
  const conds = [eq(budgets.ledgerId, ledgerId), eq(budgets.year, year)];
  if (month !== undefined) conds.push(eq(budgets.month, month));
  const rows = ctx.db
    .select()
    .from(budgets)
    .where(and(...conds))
    // 总预算（categoryId 为 null）在前：它是这一页最该先看到的数字
    .orderBy(sql`case when ${budgets.categoryId} is null then 0 else 1 end`, sql`${budgets.amount} desc`)
    .all();
  const cats = ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all();
  const names = new Map(cats.map((c) => [c.id, c.name]));
  return rows.map((r) => toDto(r, r.categoryId ? (names.get(r.categoryId) ?? null) : null));
}

export function budgetProgress(ctx: AppCtx, ledgerId: string, year: number, month?: number): BudgetProgressDto[] {
  const dtos = listBudgets(ctx, ledgerId, year, month);
  const rows = dtos.map((d) => {
    // 已花一律用这条预算自己的账期区间（toDto 已经解析好 start/end）
    const from = d.periodStart!;
    const to = d.periodEnd!;
    const spent =
      d.scope === 'tag'
        ? spentByTag(ctx, ledgerId, d.scopeId, from, to)
        : d.categoryId === null
          ? spentInPeriod(ctx, ledgerId, from, to)
          : spentByCategory(ctx, ledgerId, d.categoryId, from, to);
    return withProgress(d, spent);
  });
  return withAllocation(ctx, rows);
}

/** 标签下的支出（标签在交易上，是多对多 —— 取数路径与分类不同） */
function spentByTag(ctx: AppCtx, ledgerId: string, tagId: string | null, from: string, to: string): number {
  if (!tagId) return 0;
  const row = ctx.db
    .select({ s: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactionTags)
    .innerJoin(transactions, eq(transactionTags.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        sql`${transactions.deletedAt} is null`,
        eq(transactions.recordType, 'expense'),
        eq(transactionTags.tagId, tagId),
        sql`${transactions.txDate} >= ${from}`,
        sql`${transactions.txDate} <= ${to}`,
      ),
    )
    .get();
  return Number(row?.s ?? 0);
}

/* ------------------------------------------------------------------ *
 * 零基分配视图（B-02）
 * ------------------------------------------------------------------ */

export interface BudgetAllocationDto {
  /** 账本级总预算（`categoryId === null` 那条）。没设则为 null。 */
  total: string | null;
  /** 已分配到各分类的合计 */
  allocated: string;
  /** 未分配余额 = 总预算 − 已分配。没设总预算时为 null。 */
  unallocated: string | null;
  /** Σ分类预算 是否超过总额。超过时为超出的金额。 */
  overAllocated: string | null;
  /** 分配率（%） */
  allocationRatio: string | null;
  /**
   * 「钱从哪来」—— 只设了部分分类时的诚实提示。
   * 零基预算（YNAB）的核心是「每块钱都有归属」，所以「还没分配」是一条**要显示的信息**，
   * 不是可以忽略的中间态。
   */
  message: string | null;
}

/**
 * 给进度结果补上「分配」视角。
 *
 * ## 为什么 Σ分类 ≤ 总额 是**提示**而不是**硬校验**
 *
 * 需求（B-02）写的是「Σ分类 ≤ 总额，未分配余额**显式提示**」——
 * 注意后半句是提示，不是拒绝。所以实现是：
 *  · 创建/修改分类预算时**允许** Σ > 总额（否则用户无法「先设总额再慢慢加分类」）；
 *  · 但一旦超出，这一页会**明确写出超了多少**，并说明该怎么处理。
 *
 * 早期实现曾完全不做这个校验（理由是「总额与分类并行更自由」），
 * 那会让「分配」这件事在界面上完全不可见 —— 于是它就不存在。
 */
function withAllocation(ctx: AppCtx, rows: BudgetProgressDto[]): BudgetProgressDto[] {
  void ctx;
  const totalRow = rows.find((r) => r.categoryId === null) ?? null;
  const catRows = rows.filter((r) => r.categoryId !== null);

  const totalCents = totalRow ? Math.round(Number(totalRow.amount) * 100) : null;
  const allocatedCents = catRows.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);

  let message: string | null = null;
  if (totalCents === null) {
    if (catRows.length) {
      message = `已给 ${catRows.length} 个分类设了预算，但没有设总额，无法计算未分配余额`;
    }
  } else if (allocatedCents > totalCents) {
    message = `分类预算合计超出总额 ${formatCents(allocatedCents - totalCents)}`;
  } else if (allocatedCents === totalCents) {
    message = catRows.length ? '已全额分配' : null;
  }

  const alloc: BudgetAllocationDto = {
    total: totalRow ? totalRow.amount : null,
    allocated: formatCents(allocatedCents),
    unallocated: totalCents === null ? null : formatCents(totalCents - allocatedCents),
    overAllocated: totalCents === null || allocatedCents <= totalCents ? null : formatCents(allocatedCents - totalCents),
    allocationRatio: totalCents === null || totalCents === 0 ? null : ((allocatedCents / totalCents) * 100).toFixed(1),
    message,
  };

  // 挂在每个分类行上，前端读第一行即可（避免额外的端点与一次请求）
  for (const r of rows) r.allocation = alloc;
  return rows;
}

export interface BudgetInput {
  categoryId?: string | null;
  periodType?: string;
  year: number;
  month?: number | null;
  amount: string | number;
  rollover?: boolean;
  alertRatio?: number;
  /* --- B-07 多周期 --- */
  periodStart?: string | null;
  periodEnd?: string | null;
  periodLabel?: string | null;
  /* --- B-12 定位维度 --- */
  scope?: string;
  scopeId?: string | null;
  projectLabel?: string | null;
  /* --- B-05 / B-13 --- */
  alertEnabled?: boolean;
  visibility?: string;
}

function assertInput(ctx: AppCtx, ledgerId: string, input: BudgetInput) {
  const periodType = input.periodType ?? 'monthly';
  validatePeriod(periodType, input.year, input.month ?? null, input.periodStart, input.periodEnd);

  const amount = toCents(input.amount);
  if (amount <= 0) {
    // 文档 §16.4：预算为 0 或负数 → 参数校验拒绝
    throw HttpError.validation([{ field: 'amount', message: '预算金额必须大于 0' }]);
  }

  if (input.categoryId) {
    const cat = ctx.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ledgerId, ledgerId), eq(categories.id, input.categoryId)))
      .get();
    if (!cat) throw HttpError.validation([{ field: 'categoryId', message: '分类不存在' }]);
  }

  const alertRatio = input.alertRatio ?? 80;
  if (alertRatio < 1 || alertRatio > 100) {
    throw HttpError.validation([{ field: 'alertRatio', message: '预警阈值需在 1-100 之间' }]);
  }
  return {
    periodType,
    amount,
    alertRatio,
    month: input.month ?? null,
    /** 周/自定义账期：判重要额外比起止日（见 createBudget 里的说明） */
    needsPeriodRange: periodType === 'weekly' || periodType === 'custom',
  };
}

export function createBudget(ctx: AppCtx, actorId: string, ledgerId: string, input: BudgetInput): BudgetDto {
  const v = assertInput(ctx, ledgerId, input);

  /**
   * 唯一索引 `idx_budget_unique` 是 `(ledger_id, category_id, period_type, year, month)`。
   * ⚠️ 但 SQLite 的 UNIQUE 索引里 **NULL 与 NULL 不算重复**（NULL ≠ NULL），
   * 所以「总预算」（category_id IS NULL）**不会被数据库挡住**，
   * 可以在同一个期间被插入无数条。这里必须自己查一次。
   * 若走等值比较 `eq(budgets.categoryId, null)`，SQL 生成的是 `= NULL`，
   * 恒不成立 → 永远查不到已有总预算 → 重复插入同样挡不住。
   */
  /**
   * 判重维度 = (scope, scope_id, period_type, year, month)。
   *
   * ⚠️ 周/自定义账期必须**额外**比 period_start/end：同一个月里可以有
   * 4 条周预算（每周一条），它们 year/month 完全相同。
   * 只比年月的话，第二条周预算会被判成重复 —— 而用户正是要「每周一条」。
   *
   * ⚠️ scope 为 null 时（新列可空的存量数据）按 'category' 处理，
   * 否则 `scope = null` 查不到那批历史预算，判重会失效。
   */
  const scope = input.scope ?? 'category';
  const scopeId = scope === 'category' ? (input.categoryId ?? null) : (input.scopeId ?? null);
  const dup = ctx.db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.ledgerId, ledgerId),
        eq(budgets.periodType, v.periodType),
        eq(budgets.year, input.year),
        // `month` 可空（年度预算）：SQL 的 `= NULL` 恒不成立，必须走 is null 分支
        v.month === null ? isNull(budgets.month) : eq(budgets.month, v.month),
        // scope 可能是 NULL（新增列的存量行），两种情况都要覆盖
        sql`coalesce(${budgets.scope}, 'category') = ${scope}`,
        scopeId === null ? isNull(budgets.scopeId) : eq(budgets.scopeId, scopeId),
        // 周/自定义账期还要比起止日，否则同月第二条周预算被误判为重复
        v.needsPeriodRange
          ? and(
              input.periodStart ? eq(budgets.periodStart, input.periodStart) : isNull(budgets.periodStart),
              input.periodEnd ? eq(budgets.periodEnd, input.periodEnd) : isNull(budgets.periodEnd),
            )
          : undefined,
      ),
    )
    .get();
  if (dup) throw HttpError.duplicate('该期间已经设过这条预算了');

  const id = newId(ID_PREFIX.budget);
  const at = nowIso();
  ctx.db
    .insert(budgets)
    .values({
      id,
      ledgerId,
      categoryId: input.categoryId ?? null,
      periodType: v.periodType,
      year: input.year,
      month: v.month,
      amount: v.amount,
      rollover: input.rollover ?? false,
      alertRatio: v.alertRatio,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      periodLabel: input.periodLabel ?? null,
      alertEnabled: input.alertEnabled ?? true,
      scope,
      scopeId,
      projectLabel: input.projectLabel ?? null,
      visibility: input.visibility ?? 'ledger',
      ownerId: input.visibility === 'private' ? actorId : null,
      createdBy: actorId,
      createdAt: at,
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'budget',
    entityId: id,
    summary: `新建预算 ${periodLabel(input.year, v.month)} ${formatCents(v.amount)}`,
    after: { categoryId: input.categoryId ?? null, amount: v.amount, alertRatio: v.alertRatio, rollover: input.rollover ?? false },
  });

  return listBudgets(ctx, ledgerId, input.year, v.month ?? undefined).find((b) => b.id === id)!;
}

export function updateBudget(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  patch: Partial<BudgetInput>,
): BudgetDto {
  const before = ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.ledgerId, ledgerId), eq(budgets.id, id)))
    .get();
  if (!before) throw HttpError.notFound('预算不存在');

  const merged: BudgetInput = {
    categoryId: patch.categoryId !== undefined ? patch.categoryId : before.categoryId,
    periodType: patch.periodType ?? before.periodType,
    year: patch.year ?? before.year,
    month: patch.month !== undefined ? patch.month : before.month,
    amount: patch.amount ?? formatCents(before.amount),
    rollover: patch.rollover ?? before.rollover,
    alertRatio: patch.alertRatio ?? before.alertRatio,
  };
  const v = assertInput(ctx, ledgerId, merged);

  ctx.db
    .update(budgets)
    .set({
      categoryId: merged.categoryId ?? null,
      periodType: v.periodType,
      year: merged.year,
      month: v.month,
      amount: v.amount,
      rollover: merged.rollover ?? false,
      alertRatio: v.alertRatio,
    })
    .where(eq(budgets.id, id))
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'budget',
    entityId: id,
    summary: `更新预算 ${periodLabel(merged.year, v.month)}`,
    before: { amount: before.amount, alertRatio: before.alertRatio },
    after: { amount: v.amount, alertRatio: v.alertRatio },
  });

  return listBudgets(ctx, ledgerId, merged.year, v.month ?? undefined).find((b) => b.id === id)!;
}

export function deleteBudget(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const row = ctx.db
    .select()
    .from(budgets)
    .where(and(eq(budgets.ledgerId, ledgerId), eq(budgets.id, id)))
    .get();
  if (!row) throw HttpError.notFound('预算不存在');
  ctx.db.delete(budgets).where(eq(budgets.id, id)).run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'budget',
    entityId: id,
    summary: `删除预算 ${periodLabel(row.year, row.month)}`,
    before: row,
  });
  return { id };
}

/**
 * 从上月复制（`docs/05 §16.2`）。
 *
 * 「复制」= 把上月的**金额与预警线**搬过来，**不覆盖**本月已存在的同类预算。
 * 若用户已经手动调过本月某条预算，用复制把它冲掉是不可逆的意外。
 * 返回值因此是 `{ created, skipped }` 两个计数，前端要如实告知「建了 N 条、跳过 M 条」。
 */
export function copyFromPrevious(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: { fromYear: number; fromMonth: number; toYear: number; toMonth: number },
) {
  const src = ctx.db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.ledgerId, ledgerId),
        eq(budgets.year, input.fromYear),
        eq(budgets.month, input.fromMonth),
      ),
    )
    .all();
  if (!src.length) throw HttpError.business('上月没有预算可复制');

  const existing = new Set(
    ctx.db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.ledgerId, ledgerId),
          eq(budgets.year, input.toYear),
          eq(budgets.month, input.toMonth),
        ),
      )
      .all()
      .map((b) => b.categoryId ?? '__total__'),
  );

  let created = 0;
  let skipped = 0;
  const at = nowIso();
  for (const s of src) {
    const key = s.categoryId ?? '__total__';
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    ctx.db
      .insert(budgets)
      .values({
        id: newId(ID_PREFIX.budget),
        ledgerId,
        categoryId: s.categoryId,
        periodType: 'monthly',
        year: input.toYear,
        month: input.toMonth,
        amount: s.amount,
        rollover: s.rollover,
        alertRatio: s.alertRatio,
        createdBy: actorId,
        createdAt: at,
      })
      .run();
    created += 1;
  }

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'budget',
    entityId: 'copy',
    summary: `从 ${input.fromYear}-${input.fromMonth} 复制预算到 ${input.toYear}-${input.toMonth}（新建 ${created}、跳过 ${skipped}）`,
  });

  return { created, skipped, budgets: listBudgets(ctx, ledgerId, input.toYear, input.toMonth) };
}

/* ------------------------------------------------------------------ *
 * 调拨（B-06，对标 YNAB 的 move money）
 * ------------------------------------------------------------------ */

export interface TransferDto {
  id: string;
  year: number;
  month: number;
  period: string;
  fromCategoryId: string;
  fromCategoryName: string | null;
  toCategoryId: string;
  toCategoryName: string | null;
  amount: string;
  note: string | null;
  createdBy: { id: string; nickname: string } | null;
  createdAt: string;
}

export function listTransfers(ctx: AppCtx, ledgerId: string, year: number, month?: number): TransferDto[] {
  const conds = [eq(budgetTransfers.ledgerId, ledgerId), eq(budgetTransfers.year, year)];
  if (month !== undefined) conds.push(eq(budgetTransfers.month, month));
  const rows = ctx.db
    .select()
    .from(budgetTransfers)
    .where(and(...conds))
    .orderBy(desc(budgetTransfers.createdAt))
    .all();

  const cats = ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all();
  const names = new Map(cats.map((c) => [c.id, c.name]));
  const people = ctx.db.select({ id: users.id, nickname: users.nickname }).from(users).all();
  const nick = new Map(people.map((p) => [p.id, p.nickname]));

  return rows.map((t) => ({
    id: t.id,
    year: t.year,
    month: t.month,
    period: periodLabel(t.year, t.month),
    fromCategoryId: t.fromCategoryId,
    fromCategoryName: names.get(t.fromCategoryId) ?? null,
    toCategoryId: t.toCategoryId,
    toCategoryName: names.get(t.toCategoryId) ?? null,
    amount: formatCents(t.amount),
    note: t.note,
    createdBy: { id: t.createdBy, nickname: nick.get(t.createdBy) ?? '—' },
    createdAt: t.createdAt,
  }));
}

/**
 * 调拨：把额度从 A 分类挪到 B 分类。
 *
 * ## 三条必须同时成立的不变量
 *
 *  ① **双边原子**：两条预算的改动 + 调拨记录必须在**同一个事务**里。
 *     少改一条就是「钱凭空消失或凭空多出」，而且不会有任何报错。
 *  ② **不产生账单**：调拨改的是「计划」，账户余额一分不动。
 *     所以这里绝不碰 `transactions`。
 *  ③ **来源必须有足够额度**：从餐饮划 500 而餐饮只设了 300 → 拒绝。
 *     允许「划成负数」会让预算失去意义（负预算意味着「必须超支」，
 *     那是另一个产品概念「储蓄目标」，不是这里要解决的「调剂」）。
 */
export function transfer(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: {
    year: number;
    month: number;
    fromCategoryId: string;
    toCategoryId: string;
    amount: string | number;
    note?: string | null;
  },
): TransferDto {
  const amount = toCents(input.amount);
  if (amount <= 0) {
    throw HttpError.validation([{ field: 'amount', message: '调拨金额必须大于 0' }]);
  }
  if (input.fromCategoryId === input.toCategoryId) {
    throw HttpError.validation([{ field: 'toCategoryId', message: '来源与目标分类不能相同' }]);
  }
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    throw HttpError.validation([{ field: 'month', message: '月份需在 1-12 之间' }]);
  }

  for (const [field, id] of [
    ['fromCategoryId', input.fromCategoryId],
    ['toCategoryId', input.toCategoryId],
  ] as const) {
    const cat = ctx.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ledgerId, ledgerId), eq(categories.id, id)))
      .get();
    if (!cat) throw HttpError.validation([{ field, message: '分类不存在' }]);
  }

  const findBudget = (categoryId: string) =>
    ctx.db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.ledgerId, ledgerId),
          eq(budgets.categoryId, categoryId),
          eq(budgets.year, input.year),
          eq(budgets.month, input.month),
        ),
      )
      .get();

  const from = findBudget(input.fromCategoryId);
  const to = findBudget(input.toCategoryId);

  /**
   * 目标没有预算就**自动建一条 0 起调**。
   * YNAB 的行为：新信封调入时如果不存在就先建。拒绝的话用户必须先去建，
   * 多一步且容易在「A 超了想挪给 B」时卡住 —— 而那正是调拨的主要场景。
   */
  if (!from) {
    throw HttpError.validation([{ field: 'fromCategoryId', message: '来源分类在该期间没有预算，无法从中划出额度' }]);
  }
  if (from.amount < amount) {
    throw HttpError.validation([
      {
        field: 'amount',
        message: `来源分类预算只有 ${formatCents(from.amount)}，无法划出 ${formatCents(amount)}`,
      },
    ]);
  }

  const at = nowIso();
  const id = newId(ID_PREFIX.budgetTransfer);

  ctx.db.transaction((tx) => {
    tx.update(budgets)
      .set({ amount: from.amount - amount })
      .where(eq(budgets.id, from.id))
      .run();

    if (to) {
      tx.update(budgets).set({ amount: to.amount + amount }).where(eq(budgets.id, to.id)).run();
    } else {
      tx.insert(budgets)
        .values({
          id: newId(ID_PREFIX.budget),
          ledgerId,
          categoryId: input.toCategoryId,
          periodType: 'monthly',
          year: input.year,
          month: input.month,
          amount,
          rollover: false,
          alertRatio: 80,
          createdBy: actorId,
          createdAt: at,
        })
        .run();
    }

    tx.insert(budgetTransfers)
      .values({
        id,
        ledgerId,
        year: input.year,
        month: input.month,
        fromCategoryId: input.fromCategoryId,
        toCategoryId: input.toCategoryId,
        amount,
        note: input.note?.trim() || null,
        createdBy: actorId,
        createdAt: at,
      })
      .run();
  });

  const cats = ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all();
  const names = new Map(cats.map((c) => [c.id, c.name]));

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'budget',
    entityId: id,
    summary: `调拨 ${periodLabel(input.year, input.month)}：${names.get(input.fromCategoryId) ?? '?'} → ${names.get(input.toCategoryId) ?? '?'} ${formatCents(amount)}`,
    after: { from: input.fromCategoryId, to: input.toCategoryId, amount },
  });

  return {
    id,
    year: input.year,
    month: input.month,
    period: periodLabel(input.year, input.month),
    fromCategoryId: input.fromCategoryId,
    fromCategoryName: names.get(input.fromCategoryId) ?? null,
    toCategoryId: input.toCategoryId,
    toCategoryName: names.get(input.toCategoryId) ?? null,
    amount: formatCents(amount),
    note: input.note?.trim() || null,
    createdBy: { id: actorId, nickname: '—' },
    createdAt: at,
  };
}

/**
 * 撤销一次调拨：把额度原路还回去，并删掉那条记录。
 *
 * 为什么要能撤销：调拨本身是一个**手滑成本很高**的操作
 * （在「餐饮」和「零食」两个下拉之间选错，界面上看不出区别）。
 * 只提供「反向再调拨一次」会让历史出现两条互相抵消的记录，
 * 而「这个月调拨过几次」是用户真的会问的问题。撤销让记录保持干净。
 */
export function revokeTransfer(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const t = ctx.db
    .select()
    .from(budgetTransfers)
    .where(and(eq(budgetTransfers.ledgerId, ledgerId), eq(budgetTransfers.id, id)))
    .get();
  if (!t) throw HttpError.notFound('调拨记录不存在');

  ctx.db.transaction((tx) => {
    const from = tx
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.ledgerId, ledgerId),
          eq(budgets.categoryId, t.fromCategoryId),
          eq(budgets.year, t.year),
          eq(budgets.month, t.month),
        ),
      )
      .get();
    const to = tx
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.ledgerId, ledgerId),
          eq(budgets.categoryId, t.toCategoryId),
          eq(budgets.year, t.year),
          eq(budgets.month, t.month),
        ),
      )
      .get();

    if (from) {
      tx.update(budgets).set({ amount: from.amount + t.amount }).where(eq(budgets.id, from.id)).run();
    }
    // 目标预算可能在这之后被删了；那就不还 —— 记录里留痕即可，不能凭空建一条预算
    if (to) {
      tx.update(budgets)
        .set({ amount: Math.max(0, to.amount - t.amount) })
        .where(eq(budgets.id, to.id))
        .run();
    }
    tx.delete(budgetTransfers).where(eq(budgetTransfers.id, id)).run();
  });

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'budget',
    entityId: id,
    summary: `撤销调拨 ${periodLabel(t.year, t.month)} ${formatCents(t.amount)}`,
    before: { from: t.fromCategoryId, to: t.toCategoryId, amount: t.amount },
  });

  return { id };
}

/** 本月的预算进度（供概览/首页直接消费，`docs/04` 的 `/stats/budget-progress`） */
export function currentBudgetProgress(ctx: AppCtx, ledgerId: string) {
  const now = new Date();
  return budgetProgress(ctx, ledgerId, now.getFullYear(), now.getMonth() + 1);
}
