/**
 * 令牌工具（docs/02 §3.2、docs/04 §2）。
 *
 * - access token：JWT（HS256），由 @fastify/jwt 签发校验，默认 15 分钟
 * - refresh token：不透明随机串（`rt_` 前缀），DB 中只存 SHA-256 哈希，默认 30 天
 *   （移动端按 docs/01 §7.1 延长至 90 天，由调用方传入 expiresIn）
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { newId, ID_PREFIX } from './id.js';

/** 把 "15m" / "30d" / "12h" / "45s" / "900" 解析为秒 */
export function parseDurationSeconds(input: string, fallback = 900): number {
  const s = input.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(s);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const factor: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return n * (factor[unit] ?? 1);
}

/** 生成 refresh token 明文（仅此一次可见，不落库） */
export function createRefreshToken(): { id: string; token: string } {
  return {
    id: newId(ID_PREFIX.refreshToken),
    token: `${ID_PREFIX.refreshToken}_${randomBytes(32).toString('base64url')}`,
  };
}

/** refresh token → SHA-256 十六进制（入库存这个） */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 邀请码字符集：6 位大写字母数字，排除易混字符 I O 0 1（docs/04 §4.6） */
const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateInviteCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) code += INVITE_ALPHABET[randomInt(0, INVITE_ALPHABET.length)];
  return code;
}

/** 相对当前时间偏移的 ISO 时间戳 */
export function isoAfterSeconds(seconds: number): string {
  return toIso(new Date(Date.now() + seconds * 1000));
}

/** Date → 本地时区 ISO-8601（与 utils/money.nowIso 同构，避免循环依赖） */
export function toIso(date: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}
