/**
 * 分期的金额拆分（`docs/05 §12.4` / `§12.5`）。
 *
 * ## 为什么要单独成文件并单独测
 *
 * 分期最容易出的两个错是**尾差残留**与**手续费漏收/多收**，而它们都不报错 ——
 * 12 期每期少还 1 分，钱包就是错的，且没有任何异常能发现。所以这里的每一条
 * 都是**恒等式**，必须能被单独验证：
 *
 * 1. `Σ principal === totalAmount`（最后一期吃掉尾差）
 * 2. `Σ fee === totalFee`（除 `manual_last` 外）
 * 3. `Σ totalDue === totalAmount + totalFee`（**产品核心**：还完 N 期，负债账户归零）
 *
 * 第 3 条是分期存在的理由。破坏了它，用户的信用卡就会残留一笔钱或提前归零。
 */

export type FeeHandling = 'first_period' | 'per_period' | 'manual_last';
export type FeeMode = 'once' | 'per_period';

export interface SplitInput {
  /** 分期总额（本金），整数分 */
  totalAmount: number;
  /** 手续费总额（`feeMode='once'` 时） */
  totalFee: number;
  /** `feeMode='per_period'` 时的每期手续费 */
  perPeriodFee?: number;
  feeMode: FeeMode;
  feeHandling: FeeHandling;
  /** 期数 */
  count: number;
}

export interface PeriodSplit {
  /** 第 n 期（1 起） */
  seq: number;
  principal: number;
  fee: number;
  totalDue: number;
}

/**
 * 本金按期拆分，**最后一期吃掉尾差**。
 * 例：1000000 分（10000 元）分 3 期 → 333333 / 333333 / 333334。
 */
export function splitPrincipal(totalCents: number, count: number): number[] {
  if (count <= 0) throw new Error('期数必须为正');
  if (totalCents < 0) throw new Error('总额不能为负');
  const base = Math.floor(totalCents / count);
  const out = new Array(count).fill(base);
  // 尾差全给最后一期：前 n-1 期保持整除，最后一期把差额吃掉
  out[count - 1] = totalCents - base * (count - 1);
  return out;
}

/**
 * 手续费按期分配（`docs/05 §12.4` 的三种方式）。
 *
 * · `first_period` 首期多还 —— 信用卡最终归零，是**默认值**；
 * · `per_period`    按期分摊 —— 适合银行实际这么收的情况；
 * · `manual_last`   不自动带（分 0）—— 用户自行补记，理由写在 `docs/05 §12.4`。
 */
export function splitFee(input: {
  totalFee: number;
  perPeriodFee?: number;
  feeMode: FeeMode;
  feeHandling: FeeHandling;
  count: number;
}): number[] {
  const { feeMode, feeHandling, count } = input;
  const totalFee = Math.max(0, Math.trunc(input.totalFee));
  const perPeriodFee = Math.max(0, Math.trunc(input.perPeriodFee ?? 0));

  if (feeHandling === 'manual_last') return new Array(count).fill(0);

  // 每期收：总额就是「每期 × 期数」，它才是权威值
  if (feeMode === 'per_period') {
    const sum = perPeriodFee * count;
    if (feeHandling === 'first_period') {
      const out = new Array(count).fill(0);
      out[0] = sum;
      return out;
    }
    return splitPrincipal(sum, count);
  }

  // 一次性
  if (feeHandling === 'first_period') {
    const out = new Array(count).fill(0);
    out[0] = totalFee;
    return out;
  }
  return splitPrincipal(totalFee, count);
}

/** 一次算完本息两组的每期拆分 */
export function splitPeriods(input: SplitInput): PeriodSplit[] {
  const principals = splitPrincipal(input.totalAmount, input.count);
  const fees = splitFee({
    totalFee: input.totalFee,
    perPeriodFee: input.perPeriodFee,
    feeMode: input.feeMode,
    feeHandling: input.feeHandling,
    count: input.count,
  });
  return principals.map((principal, i) => ({
    seq: i + 1,
    principal,
    fee: fees[i] ?? 0,
    totalDue: principal + (fees[i] ?? 0),
  }));
}

/** 计划总额（本金 + 手续费） */
export function grandTotalOf(totalAmount: number, totalFee: number): number {
  return Math.max(0, Math.trunc(totalAmount)) + Math.max(0, Math.trunc(totalFee));
}