/**
 * Stage 8 · 金额计算规约单测
 *
 * 用例逐条对齐 `docs/03 §13.1`（金额计算必测用例，13 条）+ `§13.2`（借贷平衡）。
 * 这是全系统正确性的第一道闸门：改 `amounts.ts` 必须先让这里全绿。
 */
import { describe, expect, it } from 'vitest';
import { calculateAmounts, isDirectionConsistent } from '../src/modules/transactions/amounts.js';
import { AppError } from '../src/utils/errors.js';
import { LIMITS, type RecordType, type TxDirection } from '../src/config/constants.js';

const calc = (
  recordType: RecordType,
  direction: TxDirection,
  amount: number,
  fee = 0,
  discount = 0,
) => calculateAmounts({ recordType, direction, amount, fee, discount });

/** docs/03 §13.2：Δ主 + Δ第二账户 + Δ费用账户 */
const sumDeltas = (r: ReturnType<typeof calculateAmounts>) =>
  r.accountDelta + (r.toAccountDelta ?? 0) + r.feeAccountDelta;

/* ================================================================== *
 * 1. docs/03 §13.1 的 13 个必测用例
 * ================================================================== */
describe('docs/03 §13.1 金额计算必测用例', () => {
  it('1 纯支出 A=10000,F=0,D=0 → actual=10000, Δ=−10000', () => {
    const r = calc('expense', 'decrease', 10000);
    expect(r.actualAmount).toBe(10000);
    expect(r.accountDelta).toBe(-10000);
    expect(r.toAccountDelta).toBeNull();
    expect(r.feeAccountDelta).toBe(0);
  });

  it('2 支出+手续费 A=10000,F=200,D=0 → actual=10200, Δ=−10200', () => {
    const r = calc('expense', 'decrease', 10000, 200);
    expect(r.actualAmount).toBe(10200);
    expect(r.accountDelta).toBe(-10200);
  });

  it('3 支出+折扣 A=10000,F=0,D=1500 → actual=8500, Δ=−8500', () => {
    const r = calc('expense', 'decrease', 10000, 0, 1500);
    expect(r.actualAmount).toBe(8500);
    expect(r.accountDelta).toBe(-8500);
  });

  it('4 支出+费折 A=10000,F=200,D=1500 → actual=8700, Δ=−8700', () => {
    const r = calc('expense', 'decrease', 10000, 200, 1500);
    expect(r.actualAmount).toBe(8700);
    expect(r.accountDelta).toBe(-8700);
  });

  it('5 纯收入 A=2000000 → actual=2000000, Δ=+2000000', () => {
    const r = calc('income', 'increase', 2000000);
    expect(r.actualAmount).toBe(2000000);
    expect(r.accountDelta).toBe(2000000);
  });

  it('6 收入+平台抽成 A=10000,F=500 → actual=9500, Δ=+9500', () => {
    const r = calc('income', 'increase', 10000, 500);
    expect(r.actualAmount).toBe(9500);
    expect(r.accountDelta).toBe(9500);
  });

  it('7 收入+补贴 A=10000,F=500,D=200 → actual=9700, Δ=+9700', () => {
    const r = calc('income', 'increase', 10000, 500, 200);
    expect(r.actualAmount).toBe(9700);
    expect(r.accountDelta).toBe(9700);
  });

  it('8 转账+手续费 A=100000,F=300 → 转出 −100300 / 转入 +100000 / 费用 −300', () => {
    const r = calc('transfer', 'decrease', 100000, 300);
    expect(r.actualAmount).toBe(100000);
    expect(r.accountDelta).toBe(-100300);
    expect(r.toAccountDelta).toBe(100000);
    expect(r.feeAccountDelta).toBe(-300);
    expect(r.extraDeltas).toEqual([{ role: 'fee', accountType: 'fee', delta: -300 }]);
    // 普通账户 ΣΔ = −F（docs/03 §1.4，D6 修订后的正确表述）
    expect(r.accountDelta + (r.toAccountDelta ?? 0)).toBe(-300);
  });

  it('9 应收产生 A=100000,F=0 → 账户 −100000 / 债权 +100000', () => {
    const r = calc('receivable', 'decrease', 100000);
    expect(r.actualAmount).toBe(100000);
    expect(r.accountDelta).toBe(-100000);
    expect(r.toAccountDelta).toBe(100000);
  });

  it('10 应收收回+折价 A=100000,D=5000 → 账户 +95000 / 债权 −100000', () => {
    const r = calc('receivable', 'increase', 100000, 0, 5000);
    expect(r.actualAmount).toBe(95000);
    expect(r.accountDelta).toBe(95000);
    expect(r.toAccountDelta).toBe(-100000);
    expect(sumDeltas(r)).toBe(-5000); // 折价损失 = −D
  });

  it('11 应付产生 A=50000 → 账户 Δ=0 / 债务 +50000', () => {
    const r = calc('payable', 'none', 50000);
    expect(r.actualAmount).toBe(50000);
    expect(r.accountDelta).toBe(0);
    expect(r.toAccountDelta).toBe(50000);
  });

  it('12 应付支付+优惠 A=50000,D=2000 → 账户 −48000 / 债务 −50000', () => {
    const r = calc('payable', 'decrease', 50000, 0, 2000);
    expect(r.actualAmount).toBe(48000);
    expect(r.accountDelta).toBe(-48000);
    expect(r.toAccountDelta).toBe(-50000);
  });

  it('13 对账差异 system=50000, actual=48000 → Δ=−2000, actual=2000', () => {
    // 差额 −2000 → 调减 ¥20.00
    const r = calc('adjustment', 'decrease', 2000);
    expect(r.actualAmount).toBe(2000);
    expect(r.accountDelta).toBe(-2000);
    // 反向：差额 +2000 → 调增
    const up = calc('adjustment', 'increase', 2000);
    expect(up.accountDelta).toBe(2000);
  });
});

/* ================================================================== *
 * 2. docs/03 §13.2 借贷平衡（每个用例都跑）
 *
 * 表述修订见 docs/12 §五 D6：docs/03 §1.4 把「ΣΔ(普通账户) = −F」与
 * 「Δ(费用账户) = −F」两句写成了一式，按其自身列出的数值应为两式并列。
 * 下面两条不变量分别对应这两式。
 * ================================================================== */
describe('docs/03 §13.2 借贷平衡', () => {
  it('转账：普通账户 ΣΔ(转出+转入) = −F', () => {
    const r = calc('transfer', 'decrease', 100000, 300);
    expect(r.accountDelta + (r.toAccountDelta ?? 0)).toBe(-300);
  });

  it('转账：费用虚拟账户单独记 −F', () => {
    const r = calc('transfer', 'decrease', 100000, 300);
    expect(r.feeAccountDelta).toBe(-300);
  });

  it('应收产生：普通账户 ΣΔ = −F（债权账户记为对方科目，不计净资产）', () => {
    const r = calc('receivable', 'decrease', 100000, 500);
    expect(r.accountDelta).toBe(-100500);
    expect(r.toAccountDelta).toBe(100000);
  });

  it('应收收回：ΣΔ(账户 + 债权) = −D（折价损失）', () => {
    const r = calc('receivable', 'increase', 100000, 0, 5000);
    expect(r.accountDelta + (r.toAccountDelta ?? 0)).toBe(-5000);
  });

  it('应付产生：主账户零变动，仅债务账户增加（净资产不变）', () => {
    const r = calc('payable', 'none', 50000);
    expect(r.accountDelta).toBe(0);
    expect(r.toAccountDelta).toBe(50000);
  });

  it('应付支付：主账户减少 (A+F−D)，债务账户减少 A', () => {
    const r = calc('payable', 'decrease', 50000, 300, 2000);
    expect(r.accountDelta).toBe(-48300);
    expect(r.toAccountDelta).toBe(-50000);
  });

  it('全账户 ΣΔ 与 docs/03 §1.4 的代数合计一致', () => {
    // 支出：ΣΔ = −(A+F−D)
    expect(sumDeltas(calc('expense', 'decrease', 10000, 200, 1500))).toBe(-8700);
    // 收入：ΣΔ = +(A−F+D)
    expect(sumDeltas(calc('income', 'increase', 10000, 500, 200))).toBe(9700);
    // 转账含手续费：ΣΔ = −2F（docs/03 §1.4 的例子 A=1000,F=5 → −10）
    expect(sumDeltas(calc('transfer', 'decrease', 100000, 300))).toBe(-600);
  });
});

/* ================================================================== *
 * 3. 边界与校验
 * ================================================================== */
describe('边界与校验', () => {
  it('折扣恰等于 A+F 时实际值为 0，允许（docs/13 §13.6）', () => {
    const r = calc('expense', 'decrease', 10000, 200, 10200);
    expect(r.actualAmount).toBe(0);
    expect(r.accountDelta).toBe(0);
    expect(isDirectionConsistent('expense', 'decrease', 0, 0)).toBe(true);
  });

  it('折扣超过 A+F（实际值为负）→ 拒绝', () => {
    expect(() => calc('expense', 'decrease', 10000, 200, 10201)).toThrow(AppError);
    try {
      calc('expense', 'decrease', 10000, 200, 10201);
    } catch (e) {
      expect((e as AppError).details?.[0]?.field).toBe('discount');
      expect((e as AppError).details?.[0]?.message).toContain('折扣不能超过');
    }
  });

  it('收入手续费超过 A+D → 拒绝', () => {
    expect(() => calc('income', 'increase', 10000, 10201, 200)).toThrow(AppError);
  });

  it('amount = 0 或负数 → 拒绝（A > 0）', () => {
    expect(() => calc('expense', 'decrease', 0)).toThrow(AppError);
    expect(() => calc('expense', 'decrease', -1)).toThrow(AppError);
  });

  it('amount 超上限 ¥99,999,999.99 → 拒绝（docs/13 §13.3）', () => {
    expect(() => calc('expense', 'decrease', LIMITS.AMOUNT_MAX_CENTS)).not.toThrow();
    expect(() => calc('expense', 'decrease', LIMITS.AMOUNT_MAX_CENTS + 1)).toThrow(AppError);
  });

  it('非整数分 → 拒绝', () => {
    expect(() => calc('expense', 'decrease', 100.5)).toThrow(AppError);
  });

  it('非法「类型 + 方向」组合 → 拒绝（与 ck_direction_by_type 同源）', () => {
    expect(() => calc('expense', 'increase', 10000)).toThrow(AppError);
    expect(() => calc('income', 'decrease', 10000)).toThrow(AppError);
    expect(() => calc('transfer', 'none', 10000)).toThrow(AppError);
    expect(() => calc('payable', 'increase', 10000)).toThrow(AppError);
    expect(() => calc('receivable', 'none', 10000)).toThrow(AppError);
  });

  it('该阶段不适用手续费/折扣 → 拒绝（docs/13 §4.3）', () => {
    // 转账折扣不适用
    expect(() => calc('transfer', 'decrease', 10000, 0, 100)).toThrow(AppError);
    // 应收·产生 折扣不适用
    expect(() => calc('receivable', 'decrease', 10000, 0, 100)).toThrow(AppError);
    // 应收·结算 手续费不适用
    expect(() => calc('receivable', 'increase', 10000, 100)).toThrow(AppError);
    // 应付·产生 两者都不适用
    expect(() => calc('payable', 'none', 10000, 100)).toThrow(AppError);
    expect(() => calc('payable', 'none', 10000, 0, 100)).toThrow(AppError);
    // 余额调整 两者都不适用
    expect(() => calc('adjustment', 'decrease', 10000, 100)).toThrow(AppError);
  });

  it('转账不带手续费时费用账户 Δ = 0', () => {
    const r = calc('transfer', 'decrease', 100000);
    expect(r.feeAccountDelta).toBe(0);
    expect(r.extraDeltas).toEqual([]);
  });

  it('预览文案与 docs/03 §1.2 对齐（含净资产损失）', () => {
    const r = calc('transfer', 'decrease', 500000, 300);
    expect(r.previewLines).toContain('转出账户 −¥5003.00');
    expect(r.previewLines).toContain('转入账户 +¥5000.00');
    expect(r.previewLines).toContain('净资产 −¥3.00');
  });

  it('explanation 为人类可读口径（docs/04 §8.7）', () => {
    const r = calc('expense', 'decrease', 3200, 0, 200);
    expect(r.explanation).toContain('支出');
    expect(r.explanation).toContain('30.00');
    expect(r.explanation).toContain('账户减少 30.00');
  });
});

/* ================================================================== *
 * 4. 双源交叉校验
 * ================================================================== */
describe('direction 与 accountDelta 双源交叉校验', () => {
  const matrix: Array<[RecordType, TxDirection, number, number, boolean]> = [
    ['expense', 'decrease', -100, 100, true],
    ['income', 'increase', 100, 100, true],
    ['transfer', 'decrease', -100, 100, true],
    ['receivable', 'decrease', -100, 100, true],
    ['receivable', 'increase', 100, 100, true],
    ['payable', 'none', 0, 100, true],
    ['payable', 'decrease', -100, 100, true],
    ['adjustment', 'increase', 100, 100, true],
    ['adjustment', 'decrease', -100, 100, true],
    // 反向即视为污染
    ['expense', 'decrease', 100, 100, false],
    ['income', 'increase', -100, 100, false],
    ['adjustment', 'increase', -100, 100, false],
    ['payable', 'none', -100, 100, false],
  ];

  for (const [type, dir, delta, actual, ok] of matrix) {
    it(`${type}/${dir} Δ=${delta} → ${ok ? '一致' : '污染'}`, () => {
      expect(isDirectionConsistent(type, dir, delta, actual)).toBe(ok);
    });
  }
});
