/**
 * 账单金额计算 —— 全系统唯一的金额口径。
 *
 * 权威依据：`docs/03 §1.1–1.4`（公式与账户影响矩阵）+ `docs/03 §13.1`（13 个必测用例）。
 * 前端在 `public/assets/lib/amounts.js` 有一份**同构实现**（同名同参同返回）用于零延迟预览，
 * 最终口径一律以后端为准（docs/13 §6.2 的「双算机制」）。
 *
 * 三条不变量：
 *  ① `amount` 恒为正，方向一律由 `recordType + direction` 决定（docs/03 §8.2）；
 *  ② `actualAmount` / `accountDelta` / `toAccountDelta` 一律由本函数计算，前端不可传入；
 *  ③ `direction`（传进来的）与 `accountDelta`（算出来的）符号必须一致 —— 双源交叉校验。
 *
 * 关于手续费账户（docs/03 §1.4 的表述修订，见 docs/12 §五 D6）：
 *   转账的主账户 Δ = −(A + F)，即手续费已内含在转出额里；同时系统再把 −F 记到
 *   「手续费/财务费用」虚拟账户上（`feeAccountDelta`），该账户 kind=virtual、
 *   不参与净资产计算，因此**净资产净减少 F**，与 docs/03 §1.4 的结论一致。
 */
import {
  DIRECTION_BY_RECORD_TYPE,
  LIMITS,
  RECORD_TYPE_LABEL,
  type RecordType,
  type TxDirection,
} from '../../config/constants.js';
import { AppError } from '../../utils/errors.js';
import { formatCents } from '../../utils/money.js';

export interface AmountInput {
  recordType: RecordType;
  direction: TxDirection;
  /** 名义金额（分），必须 > 0 */
  amount: number;
  /** 手续费（分），≥ 0 */
  fee: number;
  /** 折扣（分），≥ 0 */
  discount: number;
  /** 冲减项（红字冲销 / 退款）：跳过「direction 与 Δ 同号」校验，改判「Δ 非零」 */
  contra?: boolean;
}

/** 需要落到「第三个账户」的 Δ。目前全系统只有费用账户一种。 */
export interface ExtraDelta {
  role: 'fee';
  accountType: 'fee';
  delta: number;
}

export interface AmountResult {
  /** 实际值（分）——docs/03 §1.2 */
  actualAmount: number;
  /** 主账户 Δ（分），可正可负 */
  accountDelta: number;
  /** 第二个账户 Δ（转账转入方 / 应收应付的债权债务账户），无则 null */
  toAccountDelta: number | null;
  /** 手续费虚拟账户 Δ（分），0 表示本笔不涉及 */
  feeAccountDelta: number;
  /** 与 04 §8.7 的响应同构：需要额外落账的 Δ 列表 */
  extraDeltas: ExtraDelta[];
  /** 人类可读的口径说明（04 §8.7 的 explanation） */
  explanation: string;
  /** 表单预览文案（docs/13 §6.3），逐条与 03 §1.2 对齐 */
  previewLines: string[];
}

/* ------------------------------------------------------------------ *
 * 手续费 / 折扣的适用性矩阵
 *
 * 以 `docs/03 §1.2` 的公式为准（`transfer` 与「应收·产生」「应付·产生」的公式里
 * 没有 D，`adjustment` 两个都没有），与 `docs/13 §4.3` 的表单显隐矩阵一致。
 * ⚠️ `docs/03 §8.1` 的 `discount` 行对这几种类型也标了「○ 选填」，
 *    与 §1.2 的公式矛盾 —— 已登记为 docs/12 §五 D7，此处取 §1.2。
 * ------------------------------------------------------------------ */
/**
 * 导出给导入链路复用（`imports/service.ts`）。
 *
 * ⚠️ 手续费/折扣只对**部分记录类型**适用，导入必须按同一份矩阵判定 ——
 * 若这里另写一份，两处的适用性会各自漂移，
 * 表现是「某些行能导、某些行报莫名其妙的错」。
 */
export const FEE_APPLICABLE: Record<RecordType, readonly TxDirection[]> = {
  expense: ['decrease'],
  income: ['increase'],
  transfer: ['decrease'],
  adjustment: [],
  receivable: ['decrease'], // 仅「借出（产生）」含当场手续费
  payable: ['decrease'], // 仅「还款（结算）」含手续费
};

export const DISCOUNT_APPLICABLE: Record<RecordType, readonly TxDirection[]> = {
  expense: ['decrease'],
  income: ['increase'],
  transfer: [],
  adjustment: [],
  receivable: ['increase'], // 仅「收回（结算）」可折价
  payable: ['decrease'],
};

/** 各场景「第二个账户」的科目名，用于预览文案 */
const SECOND_ACCOUNT_LABEL: Partial<Record<RecordType, string>> = {
  transfer: '转入账户',
  receivable: '债权',
  payable: '债务',
};

function fail(field: string, message: string): never {
  throw new AppError('VALIDATION_ERROR', '请求参数校验失败', [{ field, message }]);
}

function assertIntInRange(value: number, field: string, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value)) fail(field, `${label}必须是整数分`);
  if (value < min || value > max) {
    fail(field, `${label}需在 ${formatCents(min)} ~ ${formatCents(max)} 之间`);
  }
}

/**
 * 计算一笔账单的全部金额 —— 纯函数，无副作用、不查库。
 *
 * @throws AppError VALIDATION_ERROR 当类型/方向组合非法、金额越界、
 *         或该阶段不适用手续费/折扣时。
 */
export function calculateAmounts(input: AmountInput): AmountResult {
  const { recordType, direction, fee, discount, contra = false } = input;
  const amount = input.amount;

  // ---- 1) 类型与方向的合法性（与 DDL 的 ck_direction_by_type 同源） ----
  const allowed = DIRECTION_BY_RECORD_TYPE[recordType];
  if (!allowed) fail('recordType', '记录类型不合法');
  if (!allowed.includes(direction)) {
    const label = RECORD_TYPE_LABEL[recordType];
    fail('direction', `${label}不支持「${direction}」方向`);
  }

  // ---- 2) 金额区间（docs/13 §13.3 场景 3） ----
  assertIntInRange(amount, 'amount', 1, LIMITS.AMOUNT_MAX_CENTS, '金额');
  assertIntInRange(fee, 'fee', 0, LIMITS.AMOUNT_MAX_CENTS, '手续费');
  assertIntInRange(discount, 'discount', 0, LIMITS.AMOUNT_MAX_CENTS, '折扣');

  // ---- 3) 该阶段是否适用 F / D ----
  if (fee > 0 && !FEE_APPLICABLE[recordType].includes(direction)) {
    fail('fee', '该类型/阶段不支持手续费');
  }
  if (discount > 0 && !DISCOUNT_APPLICABLE[recordType].includes(direction)) {
    fail('discount', '该类型/阶段不支持折扣');
  }

  // ---- 4) 公式（docs/03 §1.2 实际值 + §1.3 账户影响矩阵） ----
  let actualAmount: number;
  let accountDelta: number;
  let toAccountDelta: number | null = null;
  let feeAccountDelta = 0;
  const lines: string[] = [];
  const money = formatCents;

  switch (recordType) {
    case 'expense': {
      actualAmount = amount + fee - discount;
      accountDelta = -actualAmount;
      lines.push(`账户将减少 ¥${money(actualAmount)}`);
      if (fee > 0 || discount > 0) {
        lines.push(`¥${money(amount)} + ¥${money(fee)} − ¥${money(discount)}`);
      }
      break;
    }
    case 'income': {
      actualAmount = amount - fee + discount;
      accountDelta = actualAmount;
      lines.push(`账户将增加 ¥${money(actualAmount)}`);
      if (fee > 0 || discount > 0) {
        lines.push(`¥${money(amount)} − ¥${money(fee)} + ¥${money(discount)}`);
      }
      break;
    }
    case 'transfer': {
      actualAmount = amount;
      accountDelta = -(amount + fee);
      toAccountDelta = amount;
      feeAccountDelta = fee > 0 ? -fee : 0;
      lines.push(`转出账户 −¥${money(amount + fee)}`);
      lines.push(`转入账户 +¥${money(amount)}`);
      if (fee > 0) lines.push(`净资产 −¥${money(fee)}`);
      break;
    }
    case 'adjustment': {
      actualAmount = amount;
      accountDelta = direction === 'increase' ? amount : -amount;
      lines.push(
        `账户将${direction === 'increase' ? '增加' : '减少'} ¥${money(amount)}（对账调整）`,
      );
      break;
    }
    case 'receivable': {
      if (direction === 'decrease') {
        // 产生（借出）
        actualAmount = amount + fee;
        accountDelta = -(amount + fee);
        toAccountDelta = amount;
        lines.push(`账户将减少 ¥${money(amount + fee)}`);
        lines.push(`债权 +¥${money(amount)}`);
      } else if (direction === 'write_off') {
        // 终态（坏账核销）：纯台账冲销，现金与净资产都不动
        actualAmount = amount;
        accountDelta = 0;
        toAccountDelta = -amount;
        lines.push('账户余额不变（钱在借出时就已离开，核销只是不再预期收回）');
        lines.push(`债权 −¥${money(amount)}`);
      } else {
        // 结算（收回）
        actualAmount = amount - discount;
        accountDelta = amount - discount;
        toAccountDelta = -amount;
        lines.push(`账户将增加 ¥${money(amount - discount)}`);
        lines.push(`债权 −¥${money(amount)}`);
      }
      break;
    }
    case 'payable': {
      if (direction === 'none') {
        // 产生（登记欠款）
        actualAmount = amount;
        accountDelta = 0;
        toAccountDelta = amount;
        lines.push('账户余额不变');
        lines.push(`债务 +¥${money(amount)}`);
      } else if (direction === 'write_off') {
        // 终态（债务免除）：同上，纯台账冲销
        actualAmount = amount;
        accountDelta = 0;
        toAccountDelta = -amount;
        lines.push('账户余额不变');
        lines.push(`债务 −¥${money(amount)}`);
      } else {
        // 结算（还款）
        actualAmount = amount + fee - discount;
        accountDelta = -actualAmount;
        toAccountDelta = -amount;
        lines.push(`账户将减少 ¥${money(actualAmount)}`);
        lines.push(`债务 −¥${money(amount)}`);
      }
      break;
    }
  }

  /**
   * ---- 4.5) 冲减项：现金流方向整体取反 ----
   *
   * 退款 / 红字冲销在账务上是「原分录的负数」：分类、账户、日期都与原笔同，
   * 只有金额方向相反。所以取反放在公式**之后**统一做 ——
   * 这样 1.2 的公式表不必为『退款』再写六行，也保证 actual 仍恒 ≥ 0。
   */
  if (contra) {
    accountDelta = -accountDelta;
    if (toAccountDelta !== null) toAccountDelta = -toAccountDelta;
    feeAccountDelta = -feeAccountDelta;
  }

  // ---- 5) 实际值不得为负（docs/03 §8.2 的 `A + F − D ≥ 0`，此处泛化到全部场景） ----
  if (actualAmount < 0) {
    const hint =
      recordType === 'income'
        ? `手续费不能超过金额 + 折扣（当前最多 ¥${money(amount + discount)}）`
        : `折扣不能超过金额 + 手续费（当前最多 ¥${money(amount + fee)}）`;
    fail(discount > 0 ? 'discount' : 'fee', hint);
  }

  // ---- 6) 双源交叉校验：direction 是传进来的，accountDelta 是算出来的 ----
  if (!isDirectionConsistent(recordType, direction, accountDelta, actualAmount, { contra })) {
    fail('direction', `${RECORD_TYPE_LABEL[recordType]}的「${direction}」与实际账户变动方向不一致`);
  }

  return {
    actualAmount: zero(actualAmount),
    accountDelta: zero(accountDelta),
    toAccountDelta: toAccountDelta === null ? null : zero(toAccountDelta),
    feeAccountDelta: zero(feeAccountDelta),
    extraDeltas:
      feeAccountDelta !== 0 ? [{ role: 'fee', accountType: 'fee', delta: zero(feeAccountDelta) }] : [],
    explanation: explain(recordType, direction, { amount, fee, discount }, actualAmount, accountDelta),
    previewLines: lines,
  };
}

/** 消除 `-0`：JS 里 `-(0)` 是 `-0`，写库/断言/序列化都容易被它咬到 */
function zero(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * 方向一致性判定 —— 双源交叉校验的核心。
 *
 * 三个「主账户不动」的场景（`accountDelta === 0`）：
 *  · `payable` 的「产生」阶段（登记欠款，只记台账）；
 *  · `write_off` 核销（纯台账冲销，现金与净资产都不动）；
 *  · 实际值为 0 的账单（`docs/13 §13.6`：折扣恰好等于 `A + F`）——账户确实不动，
 *    此时零值合法，不能按符号判成「方向不符」。
 */
export function isDirectionConsistent(
  recordType: RecordType,
  direction: TxDirection,
  accountDelta: number,
  actualAmount: number,
  /**
   * 红字冲销笔（`adjustment_reason = 'contra'`）。
   *
   * ⚠️ 它是**唯一**一类「`direction` 与 `accountDelta` 符号相反」的合法账单：
   * 冲销要撤掉一笔支出，所以 `record_type` 仍是 `expense`（统计口径要跟着冲减），
   * 而 `direction` 受 `ck_direction_by_type` 约束只能是 `decrease` ——
   * 但它的现金流方向是**反向**的（`accountDelta > 0`）。
   *
   * 这不是「放松校验」，而是把校验换成正确的那一句：
   * 冲销笔必须与被冲销笔**金额相等、符号相反**，而不是「符号与 direction 一致」。
   * 若不做这个区分，用户去**划线更正一笔冲销笔**时
   * `calculateAmounts()` 会直接抛「方向与实际账户变动不一致」——
   * 表现是「冲销之后想改它，改不了」。
   */
  opts: { contra?: boolean } = {},
): boolean {
  if (opts.contra) {
    // 冲销笔：账户必须真的动了（否则等于没冲销），符号任意
    return accountDelta !== 0 && actualAmount >= 0;
  }
  if (accountDelta === 0) {
    const mainAccountUntouched =
      (recordType === 'payable' && direction === 'none') || direction === 'write_off';
    return mainAccountUntouched || actualAmount === 0;
  }
  switch (direction) {
    case 'increase':
      return accountDelta > 0;
    case 'decrease':
      return accountDelta < 0;
    case 'none':
    case 'write_off':
      // 核销的主账户恒为 0，走到这一分支说明公式被改坏了
      return false;
  }
}

function explain(
  recordType: RecordType,
  direction: TxDirection,
  v: { amount: number; fee: number; discount: number },
  actualAmount: number,
  accountDelta: number,
): string {
  const money = formatCents;
  const label = RECORD_TYPE_LABEL[recordType];
  const deltaText =
    accountDelta === 0
      ? '账户余额不变'
      : `账户${accountDelta > 0 ? '增加' : '减少'} ${money(Math.abs(accountDelta))}`;

  const formulas: Record<string, string> = {
    'expense:decrease': `${money(v.amount)} + ${money(v.fee)} − ${money(v.discount)}`,
    'income:increase': `${money(v.amount)} − ${money(v.fee)} + ${money(v.discount)}`,
    'transfer:decrease': `${money(v.amount)}（手续费 ${money(v.fee)} 由转出方承担）`,
    'receivable:decrease': `${money(v.amount)} + ${money(v.fee)}`,
    'receivable:increase': `${money(v.amount)} − ${money(v.discount)}`,
    'receivable:write_off': `${money(v.amount)}（坏账核销，不动现金）`,
    'payable:none': `${money(v.amount)}（仅登记债务，不动账户余额）`,
    'payable:decrease': `${money(v.amount)} + ${money(v.fee)} − ${money(v.discount)}`,
    'payable:write_off': `${money(v.amount)}（债务免除，不动账户余额）`,
    'adjustment:increase': `${money(v.amount)}（对账调增）`,
    'adjustment:decrease': `${money(v.amount)}（对账调减）`,
  };
  const f = formulas[`${recordType}:${direction}`] ?? money(v.amount);
  return `${label}：实际值 = ${f} = ${money(actualAmount)}，${deltaText}`;
}
