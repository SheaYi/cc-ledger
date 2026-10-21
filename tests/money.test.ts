import { describe, expect, it } from 'vitest';
import { formatCents, parseAmountToCents } from '../src/utils/money';

describe('金额工具（整数分）', () => {
  it('解析十进制字符串为分', () => {
    expect(parseAmountToCents('0.01')).toBe(1);
    expect(parseAmountToCents('12.30')).toBe(1230);
    expect(parseAmountToCents('128.5')).toBe(12850);
    expect(parseAmountToCents('128')).toBe(12800);
    expect(parseAmountToCents('0')).toBe(0);
    expect(parseAmountToCents('20000.00')).toBe(2000000);
    expect(parseAmountToCents('-150.00')).toBe(-15000);
  });

  it('拒绝非法金额', () => {
    expect(() => parseAmountToCents('12.345')).toThrow();
    expect(() => parseAmountToCents('abc')).toThrow();
    expect(() => parseAmountToCents('1.2.3')).toThrow();
    expect(() => parseAmountToCents('')).toThrow();
  });

  it('格式化分为十进制字符串', () => {
    expect(formatCents(1)).toBe('0.01');
    expect(formatCents(1230)).toBe('12.30');
    expect(formatCents(12850)).toBe('128.50');
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(-15000)).toBe('-150.00');
  });

  it('浮点陷阱：0.1 + 0.2 精确等于 0.30', () => {
    const a = parseAmountToCents('0.10');
    const b = parseAmountToCents('0.20');
    expect(formatCents(a + b)).toBe('0.30');
  });

  it('往返一致', () => {
    for (const s of ['0.00', '0.01', '9.99', '100.00', '8632.50', '12000.00']) {
      expect(formatCents(parseAmountToCents(s))).toBe(s);
    }
  });
});
