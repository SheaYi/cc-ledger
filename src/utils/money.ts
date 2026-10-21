/**
 * 金额工具 —— 全程使用「分」(INTEGER)，杜绝浮点误差。
 * 对齐 docs/01 §5.1、docs/04 §1.2。
 */

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

/** 十进制字符串/数字 → 整数分 */
export function parseAmountToCents(input: string | number): number {
  const s = typeof input === 'number' ? input.toFixed(2) : input.trim();
  if (!AMOUNT_RE.test(s)) {
    throw new Error(`非法金额格式：${String(input)}（最多 2 位小数的十进制字符串）`);
  }
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [intPartRaw, fracPartRaw = ''] = body.split('.');
  const intPart = intPartRaw ?? '0';
  const fracPart = (fracPartRaw + '00').slice(0, 2);
  const cents = Number(intPart) * 100 + Number(fracPart);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`金额超出安全范围：${String(input)}`);
  }
  return negative ? -cents : cents;
}

/** 整数分 → 十进制字符串（固定 2 位小数） */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`金额必须为整数分：${String(cents)}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${negative ? '-' : ''}${yuan}.${String(fen).padStart(2, '0')}`;
}

/** 当前时间戳（ISO-8601 带本地时区偏移，如 2026-10-12T19:43:36+08:00） */
export function nowIso(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offM = pad(Math.abs(offsetMin) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${offH}:${offM}`
  );
}

/** 本地日期 YYYY-MM-DD */
export function today(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
