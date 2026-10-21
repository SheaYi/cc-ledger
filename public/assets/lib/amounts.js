/**
 * 账单金额计算 —— 前端侧的**同构实现**。
 *
 * 与 `src/modules/transactions/amounts.ts` 同名、同参、同返回、同报错语义，
 * 逐行对读可发现漂移。存在的唯一理由是 `docs/13 §6.2` 的**双算机制**：
 *   即时预览由本文件零延迟算出；失焦 / 停顿 400ms / 提交前各调一次
 *   `POST /transactions/preview` 校正；两者数字不一致 → 以后端为准并上报。
 * 因此本文件的任何改动都应当与 .ts 同步 —— 不一致率 > 0 就是公式回归的信号。
 *
 * 权威依据：`docs/03 §1.1–1.4`（公式 + 账户影响矩阵）+ `docs/03 §13.1`（13 个必测用例）。
 *
 * 三条不变量（与 .ts 完全一致）：
 *  ① `amount` 恒为正，方向由 `recordType + direction` 决定；
 *  ② `actualAmount` / `accountDelta` / `toAccountDelta` 只由本函数产出，表单不得传入；
 *  ③ `direction`（传进来的）与 `accountDelta`（算出来的）符号必须一致 —— 双源交叉校验。
 */

/* ------------------------------------------------------------------ *
 * 常量（与 src/config/constants.ts 对位）
 * ------------------------------------------------------------------ */

export const RECORD_TYPES = [
  'expense',
  'income',
  'transfer',
  'receivable',
  'payable',
  'adjustment',
];

export const RECORD_TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  receivable: '应收款项',
  payable: '应付款项',
  adjustment: '余额调整',
};

export const TX_DIRECTIONS = ['increase', 'decrease', 'none', 'write_off'];

/** 每种记录类型的合法 direction —— 与 DDL 的 ck_direction_by_type 一一对应 */
export const DIRECTION_BY_RECORD_TYPE = {
  expense: ['decrease'],
  income: ['increase'],
  transfer: ['decrease'],
  adjustment: ['increase', 'decrease'],
  receivable: ['decrease', 'increase', 'write_off'],
  payable: ['none', 'decrease', 'write_off'],
};

/** 各类型的「产生」阶段默认方向（docs/13 §5） */
export const DEFAULT_DIRECTION = {
  expense: 'decrease',
  income: 'increase',
  transfer: 'decrease',
  adjustment: 'decrease',
  receivable: 'decrease',
  payable: 'none',
};

/** 人类可读阶段名（应收：借出/收回；应付：登记欠款/还款） */
export const DIRECTION_STAGE_LABEL = {
  receivable: { decrease: '借出', increase: '收回', write_off: '坏账核销' },
  payable: { none: '登记欠款', decrease: '还款', write_off: '债务免除' },
  adjustment: { increase: '调增', decrease: '调减' },
  transfer: { decrease: '转出' },
};

export const LIMITS = {
  AMOUNT_MAX_CENTS: 9_999_999_999, // ¥99,999,999.99（docs/13 §13.3 场景 3）
  NAME_MAX_LEN: 50,
  MERCHANT_MAX_LEN: 50,
  COUNTERPARTY_MAX_LEN: 50,
  NOTE_MAX_LEN: 500,
};

/**
 * 手续费适用性：以 `docs/03 §1.2` 的公式为准（与 .ts 的 FEE_APPLICABLE 同源）。
 *
 * **导出**是刻意的：表单的字段显隐必须和这里**同一个信源**。此前表单用的是
 * 一套硬编码的否定式判断（`!(t==='payable' && d==='none')` 这种），
 * 漏了 `write_off` → 核销时手续费框还显示、后端却会 400（真踩过）。
 */
export const FEE_APPLICABLE = {
  expense: ['decrease'],
  income: ['increase'],
  transfer: ['decrease'],
  adjustment: [],
  receivable: ['decrease'],
  payable: ['decrease'],
};

/** 折扣适用性：同上（`docs/12 §五 D7` 已登记 §8.1 与 §1.2 的矛盾，取 §1.2） */
export const DISCOUNT_APPLICABLE = {
  expense: ['decrease'],
  income: ['increase'],
  transfer: [],
  adjustment: [],
  receivable: ['increase'],
  payable: ['decrease'],
};

/* ------------------------------------------------------------------ *
 * 金额字符串 ↔ 整数分
 * 存储与计算全程整数「分」，只有在输入期与展示期才出现字符串（README §核心原则 2）
 * ------------------------------------------------------------------ */

/** 分 → 十进制字符串（与后端 utils/money.formatCents 同义，负数带前导 '-'） */
export function formatCents(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const negative = n < 0;
  const abs = Math.abs(n);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 归一化「分」：消除 `-0`。
 * JS 里 `-(0)` 是 `-0`，`Object.is(-0, 0)` 为 false，比对与断言都会被它咬到。
 */
function zero(n) {
  return n === 0 ? 0 : n;
}

/**
 * 输入期清洗（docs/13 §6.1 / §13 场景 7、8）：
 *   · 只保留数字与 1 个小数点，最多 2 位小数
 *   · 自动剔除粘贴进来的千分位与货币符号（`¥1,234.56` → `1234.56`）
 *   · 前导 0 折叠（`007` → `7`，但保留 `0.xx`）
 *   · 一个数字都没有（`.` / `¥` / 空）→ 归一为 `''`（**未填**，不是 0；
 *     docs/13 §13 场景 7 明示「`.` 单独存在视为未填」）
 * 返回**字符串**，原样用于输入框 value。
 */
export function sanitizeAmountInput(raw) {
  let s = String(raw ?? '');
  // 全角数字与全角句号（中文输入法下极常见）
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[。．]/g, '.');
  if (!/\d/.test(s)) return '';
  // 剔除货币符号、千分位、空格与任何其它非法字符
  s = s.replace(/[^\d.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot >= 0) {
    s = `${s.slice(0, firstDot + 1)}${s.slice(firstDot + 1).replace(/\./g, '')}`;
  }
  const [intPart, decPart] = s.split('.');
  const int = (intPart ?? '').replace(/^0+(?=\d)/, '');
  if (s.includes('.')) return `${int}.${(decPart ?? '').slice(0, 2)}`;
  return int;
}

/** 失焦 / 提交前的规范化：`1.` → `1.00`，`.5` → `0.50`，未填 → '' */
export function normalizeAmountInput(raw) {
  const s = sanitizeAmountInput(raw);
  if (s === '') return '';
  const [intPart, decPart] = s.split('.');
  const int = intPart === '' ? '0' : intPart;
  if (!s.includes('.')) return `${int}.00`;
  return `${int}.${(decPart ?? '').padEnd(2, '0').slice(0, 2)}`;
}

/**
 * 十进制字符串 → 整数分。
 * 非法返回 null（**不抛**）—— 表单需要区分「未填」与「填错」，
 * 而纯计算入口用的是下面抛错的 `centsOf`。
 */
export function parseAmountToCents(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [intPart, decPart = ''] = (negative ? s.slice(1) : s).split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** 千分位展示（`1234.56` → `1,234.56`）；只用于展示，不参与计算 */
export function groupThousands(decimal) {
  const s = String(decimal ?? '');
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [int, dec] = body.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+$)/g, ',');
  return `${negative ? '-' : ''}${grouped}${dec !== undefined ? `.${dec}` : ''}`;
}

/**
 * 把预览文案里的 `¥1234.56` 变成 `¥1,234.56`（docs/13 §6.3：金额一律带千分位）。
 * 后端 `previewLines` 与本地纯函数保持一致（不带千分位，便于逐字对读），
 * 展示层在这里补上分组 —— 无 lookbehind，老 Safari 也能跑。
 */
export function groupMoneyInText(line) {
  const parts = String(line ?? '').split('¥');
  if (parts.length === 1) return parts[0];
  return parts
    .map((seg, i) => {
      if (i === 0) return seg;
      return seg.replace(/^(-?\d+)(\.|$)/, (_m, digits, tail) => `${groupThousands(digits)}${tail}`);
    })
    .join('¥');
}

/* ------------------------------------------------------------------ *
 * 计算
 * ------------------------------------------------------------------ */

/** 与后端 AppError('VALIDATION_ERROR', ...) 同构的轻量错误 */
export class AmountError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'AmountError';
    this.code = 'VALIDATION_ERROR';
    this.field = field;
    this.details = [{ field, message }];
  }
}

function fail(field, message) {
  throw new AmountError(field, message);
}

function assertIntInRange(value, field, min, max, label) {
  if (!Number.isSafeInteger(value)) fail(field, `${label}必须是整数分`);
  if (value < min || value > max) {
    fail(field, `${label}需在 ${formatCents(min)} ~ ${formatCents(max)} 之间`);
  }
}

/**
 * 计算一笔账单的全部金额 —— 纯函数，无副作用、不查库。
 *
 * @param {{recordType:string, direction:string, amount:number, fee:number, discount:number}} input
 *        金额单位为**整数分**
 * @returns {{actualAmount:number, accountDelta:number, toAccountDelta:number|null,
 *            feeAccountDelta:number, extraDeltas:Array<{role:'fee',accountType:'fee',delta:number}>,
 *            explanation:string, previewLines:string[]}}
 * @throws {AmountError} 类型/方向组合非法、金额越界、该阶段不适用 F/D、实际值为负、
 *         或 direction 与 accountDelta 符号不一致
 */
export function calculateAmounts(input) {
  const { recordType, direction, fee, discount } = input;
  const amount = input.amount;

  // ---- 1) 类型与方向的合法性（与 DDL 的 ck_direction_by_type 同源） ----
  const allowed = DIRECTION_BY_RECORD_TYPE[recordType];
  if (!allowed) fail('recordType', '记录类型不合法');
  if (!allowed.includes(direction)) {
    fail('direction', `${RECORD_TYPE_LABEL[recordType]}不支持「${direction}」方向`);
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
  let actualAmount;
  let accountDelta;
  let toAccountDelta = null;
  let feeAccountDelta = 0;
  const lines = [];
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
      lines.push(`账户将${direction === 'increase' ? '增加' : '减少'} ¥${money(amount)}（对账调整）`);
      break;
    }
    case 'receivable': {
      if (direction === 'decrease') {
        actualAmount = amount + fee;
        accountDelta = -(amount + fee);
        toAccountDelta = amount;
        lines.push(`账户将减少 ¥${money(amount + fee)}`);
        lines.push(`债权 +¥${money(amount)}`);
      } else if (direction === 'write_off') {
        actualAmount = amount;
        accountDelta = 0;
        toAccountDelta = -amount;
        lines.push('账户余额不变（钱在借出时就已离开，核销只是不再预期收回）');
        lines.push(`债权 −¥${money(amount)}`);
      } else {
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
        actualAmount = amount;
        accountDelta = 0;
        toAccountDelta = amount;
        lines.push('账户余额不变');
        lines.push(`债务 +¥${money(amount)}`);
      } else if (direction === 'write_off') {
        actualAmount = amount;
        accountDelta = 0;
        toAccountDelta = -amount;
        lines.push('账户余额不变');
        lines.push(`债务 −¥${money(amount)}`);
      } else {
        actualAmount = amount + fee - discount;
        accountDelta = -actualAmount;
        toAccountDelta = -amount;
        lines.push(`账户将减少 ¥${money(actualAmount)}`);
        lines.push(`债务 −¥${money(amount)}`);
      }
      break;
    }
    default:
      fail('recordType', '记录类型不合法');
  }

  // ---- 5) 实际值不得为负（docs/03 §8.2 的 `A + F − D ≥ 0`，泛化到全部场景） ----
  if (actualAmount < 0) {
    const hint =
      recordType === 'income'
        ? `手续费不能超过金额 + 折扣（当前最多 ¥${money(amount + discount)}）`
        : `折扣不能超过金额 + 手续费（当前最多 ¥${money(amount + fee)}）`;
    fail(discount > 0 ? 'discount' : 'fee', hint);
  }

  // ---- 6) 双源交叉校验：direction 是传进来的，accountDelta 是算出来的 ----
  if (!isDirectionConsistent(recordType, direction, accountDelta, actualAmount)) {
    fail('direction', `${RECORD_TYPE_LABEL[recordType]}的「${direction}」与实际账户变动方向不一致`);
  }

  return {
    actualAmount: zero(actualAmount),
    accountDelta: zero(accountDelta),
    toAccountDelta: toAccountDelta === null ? null : zero(toAccountDelta),
    feeAccountDelta: zero(feeAccountDelta),
    extraDeltas:
      feeAccountDelta !== 0
        ? [{ role: 'fee', accountType: 'fee', delta: zero(feeAccountDelta) }]
        : [],
    explanation: explain(recordType, direction, { amount, fee, discount }, actualAmount, accountDelta),
    previewLines: lines,
  };
}

/**
 * 方向一致性判定 —— 双源交叉校验的核心。
 *
 * 两个例外（与 .ts 注释同）：
 *  · `payable` 的「产生」阶段主账户恒不动（`accountDelta === 0`）；
 *  · 实际值为 0 的账单（`docs/13 §13.6`：折扣恰好等于 `A + F`）——账户确实不动。
 */
export function isDirectionConsistent(recordType, direction, accountDelta, actualAmount) {
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
      return false;
    default:
      return false;
  }
}

function explain(recordType, direction, v, actualAmount, accountDelta) {
  const money = formatCents;
  const label = RECORD_TYPE_LABEL[recordType];
  const deltaText =
    accountDelta === 0
      ? '账户余额不变'
      : `账户${accountDelta > 0 ? '增加' : '减少'} ${money(Math.abs(accountDelta))}`;

  const formulas = {
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

/**
 * 便捷包装：把「表单三个输入框的字符串」直接算成结果。
 * 任一项未填按 0 处理；`amount` 缺失或非法 → 返回 `{ ok:false, field, message }`
 * 而不是抛错 —— 表单要的是「安静地什么都不显示」，不是弹窗。
 */
export function tryCalculateFromStrings({ recordType, direction, amount, fee, discount }) {
  const amountCents = parseAmountToCents(amount);
  if (amountCents === null || amountCents <= 0) {
    return { ok: false, field: 'amount', message: '请填写金额', silent: true };
  }
  const feeCents = parseAmountToCents(fee) ?? 0;
  const discountCents = parseAmountToCents(discount) ?? 0;
  try {
    const result = calculateAmounts({
      recordType,
      direction,
      amount: amountCents,
      fee: feeCents,
      discount: discountCents,
    });
    return { ok: true, result, amountCents, feeCents, discountCents };
  } catch (err) {
    if (err instanceof AmountError) return { ok: false, field: err.field, message: err.message };
    throw err;
  }
}

/**
 * 双算比对：只比数字，不比文案。
 * 文案可能因展示层加千分位而不同，数字不同才是真回归（docs/13 §6.2）。
 *
 * ⚠️ 线上格式差异不算分歧：`POST /transactions/preview` 会把「不涉及该账户」的
 * Δ 序列化成 `null`（见 `src/modules/transactions/index.ts` 的 `fmt` 分支），
 * 而本地纯函数给出的是数字 `0`。因此比对前先把 `null / undefined` 归一为 0 ——
 * 否则每一笔都会误报「双算不一致」，真回归反而被噪音淹没。
 */
export function amountsMismatch(local, remote) {
  if (!local || !remote) return false;
  const norm = (v) => (v === null || v === undefined ? 0 : Number(v));
  const pairs = [
    ['actualAmount', local.actualAmount, remote.actualAmount],
    ['accountDelta', local.accountDelta, remote.accountDelta],
    ['toAccountDelta', local.toAccountDelta, remote.toAccountDelta],
    ['feeAccountDelta', local.feeAccountDelta, remote.feeAccountDelta],
  ];
  return pairs.some(([, a, b]) => norm(a) !== norm(b));
}
