/**
 * 账户余额计算 —— 全系统唯一的余额口径（docs/03 §2.1）。
 *
 *   balance(account, T) = opening_balance
 *                       + Σ account_delta    (opening_date ≤ tx_date ≤ T)
 *                       + Σ to_account_delta (opening_date ≤ tx_date ≤ T)
 *                       + Σ 派生费用账户 Δ    (仅 kind='fee' 的账户，见下)
 *
 * 硬性前提：
 *   · 期初余额与期初日期是一组不可分割的语义；
 *   · 早于期初日期的流水不参与余额（但仍可用于历史统计）；
 *   · 软删除的账单必须排除。
 *
 * ── 边界口径：`≤`（2026-10-14 决策，完整论证见 docs/14-期初余额口径决策.md） ──
 *
 * 上一版是 `opening_date < tx_date`（**严格小于**），导致**建账当天的账不计入余额**
 * —— 界面上是「我明明记了一笔，余额却没动」，而账单列表里那笔账明明在。
 * 分期模块（首期往往就是今天）把它顶了出来。
 *
 * 改成 `≤` 不是「顺手改一行」，依据三条：
 *   · **会计口径**：期初余额是「期初日**开始时刻**（00:00）的存量」，建账日本身的
 *     流水属于建账当期。而 `docs/03 §2.2` 的提示语「期初日期应为你**开始在这个
 *     账户记账的日期**」一直是这么写的 —— 是公式向提示语靠拢，不是反过来。
 *     旧口径把 `opening_date` 当成了「截止日」，等于断言「该账户建账当天零流水」，
 *     与「用户今天开始记这个账户」的产品语义冲突。
 *   · **《企业所得税法实施条例》第九条**：权责发生制，属于当期的收入和费用
 *     不论款项是否收付均计入当期 —— 期间归属由义务发生时点决定。
 *   · **年度边界**：期初日 = 1 月 1 日时严格小于会让元旦凭证永远进不了账
 *     （实测有 14 个这样的账户）。
 *
 * ⚠️ **改此项前必读 `docs/14` 的迁移审计四步。** 真正的风险不是公式本身，而是
 * **重复计账**：`docs/03 §2.3` 禁止直接编辑余额，用户察觉余额不对时唯一的补偿
 * 手段就是把期初余额填大 —— 切成 `≤` 后这批账户会双计。因此**禁止系统自动调平**
 * （无法区分「漏计」与「已补偿」），只能提示用户去核对银行实际余额。
 *
 * 对账记录 `reconciliation_records.system_balance` 存的是**快照**，不会自动重算，
 * 界面上须标注口径变更时间（`docs/14` 步骤 3）。若启用「期间关闭」，本口径变更
 * **必须早于锁账上线**，否则已锁账期间被重算 = 更严重的会计期间事故。
 *
 * 对虚拟账户（`opening_date = LEDGER_EPOCH = 1970-01-01`）**无任何影响** ——
 * 1970 年至今不会有账单，`>` 与 `≥` 结果相同。实测 1195 个虚拟账户全部零影响。
 *
 * ⚠️ 只有**资产负债表侧**走这份公式。利润表（本月收入 / 支出）不受影响：
 * `periodFlow()` 直接聚合 `sum(transactions.actual_amount)`，不过余额公式、
 * 也不按 `opening_date` 过滤（`accounts/service.ts:509`）。
 *
 * 余额不可直接编辑（docs/03 §2.3），任何变动只能来自：记账 / 对账调整单 / 软删除回滚。
 *
 * ── 手续费账户的 Δ 为什么是「派生」的（docs/12 §五 D6） ──
 * `transactions` 只有两个 Δ 列（account_delta / to_account_delta），而转账场景有三个
 * 受影响账户（转出方 −(A+F)、转入方 +A、费用账户 −F）。docs/04 §8.7 的预览响应里
 * `feeAccountDelta` 与另两个 Δ 并列出现在**同一条记录**上，说明费用账户的 Δ 属于
 * 「由这一行派生」而非「另开一行」。因此这里用一条派生分支补上，代价为零：
 *   · 转账时 `account_delta = −(A+F)` 已内含手续费，净资产净减 F；
 *   · 费用账户是 kind='virtual'，不进净资产，只作为**手续费累计台账**存在。
 */
import type { AppCtx } from '../../context.js';

/** 未指定日期时的"当下"上界 */
export const BALANCE_MAX_DATE = '9999-12-31';

export interface BalanceDelta {
  /** ΣΔ，可正可负 */
  delta: number;
  /** 余额增加侧合计（正数） */
  inflow: number;
  /** 余额减少侧合计（正数，取绝对值） */
  outflow: number;
}

const EMPTY: BalanceDelta = { delta: 0, inflow: 0, outflow: 0 };

interface DeltaRow {
  acc: string;
  delta: number | null;
  inflow: number | null;
  outflow: number | null;
}

/**
 * 一次性算出某账本下所有账户的 Δ 汇总。
 * 用 UNION ALL 把「主账户侧」「目标账户侧」「费用账户派生侧」拉平成同一列，
 * 再按账户聚合，避免逐账户查询造成 N+1。
 */
export function ledgerDeltas(
  ctx: AppCtx,
  ledgerId: string,
  asOf: string = BALANCE_MAX_DATE,
): Map<string, BalanceDelta> {
  const rows = ctx.dbHandle.raw
    .prepare(
      `SELECT r.acc AS acc,
              SUM(r.d)                                AS delta,
              SUM(CASE WHEN r.d > 0 THEN r.d ELSE 0 END)  AS inflow,
              SUM(CASE WHEN r.d < 0 THEN -r.d ELSE 0 END) AS outflow
         FROM (
           SELECT t.account_id AS acc, t.account_delta AS d
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.ledger_id = @ledger
              AND t.deleted_at IS NULL
              AND t.tx_date >= a.opening_date
              AND t.tx_date <= @asOf
           UNION ALL
           SELECT t.to_account_id AS acc, COALESCE(t.to_account_delta, 0) AS d
             FROM transactions t
             JOIN accounts a ON a.id = t.to_account_id
            WHERE t.ledger_id = @ledger
              AND t.deleted_at IS NULL
              AND t.to_account_id IS NOT NULL
              AND t.tx_date >= a.opening_date
              AND t.tx_date <= @asOf
           UNION ALL
           -- 派生：转账手续费 → 费用虚拟账户 −F（docs/03 §1.4 / docs/12 D6）
           SELECT a.id AS acc, -t.fee AS d
             FROM transactions t
             JOIN accounts a ON a.ledger_id = t.ledger_id AND a.type = 'fee'
            WHERE t.ledger_id = @ledger
              AND t.deleted_at IS NULL
              AND t.record_type = 'transfer'
              AND t.fee > 0
              AND t.tx_date >= a.opening_date
              AND t.tx_date <= @asOf
         ) r
        GROUP BY r.acc`,
    )
    .all({ ledger: ledgerId, asOf }) as DeltaRow[];

  const map = new Map<string, BalanceDelta>();
  for (const row of rows) {
    map.set(row.acc, {
      delta: Number(row.delta ?? 0),
      inflow: Number(row.inflow ?? 0),
      outflow: Number(row.outflow ?? 0),
    });
  }
  return map;
}

/** 单账户 Δ 汇总 */
export function accountDelta(
  ctx: AppCtx,
  ledgerId: string,
  accountId: string,
  asOf: string = BALANCE_MAX_DATE,
): BalanceDelta {
  return ledgerDeltas(ctx, ledgerId, asOf).get(accountId) ?? EMPTY;
}

export interface AccountBalance {
  accountId: string;
  asOf: string;
  openingBalance: number;
  inflow: number;
  outflow: number;
  balance: number;
}

/** 余额 = 期初 + Δ（docs/03 §2.1） */
export function composeBalance(
  accountId: string,
  openingBalance: number,
  delta: BalanceDelta,
  asOf: string,
): AccountBalance {
  return {
    accountId,
    asOf,
    openingBalance,
    inflow: delta.inflow,
    outflow: delta.outflow,
    balance: openingBalance + delta.delta,
  };
}
