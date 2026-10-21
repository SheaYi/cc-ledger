/**
 * 客户端会话状态（localStorage 持久化）
 * 令牌策略与后端一致：access 15 分钟 + refresh 30 天（移动端 90 天）。
 */
const KEY = 'cc-ledger.auth.v1';
const DEVICE_KEY = 'cc-ledger.device.v1';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
}

/** 设备平台判定（决定 refresh token 有效期：mobile → 90 天） */
export function detectPlatform() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return isMobile ? 'mobile' : 'web';
}

export const auth = {
  /** @returns {{accessToken:string, refreshToken:string, expiresAt:number}|null} */
  get session() {
    return readJson(KEY, null);
  },
  get accessToken() {
    return this.session?.accessToken ?? null;
  },
  get refreshToken() {
    return this.session?.refreshToken ?? null;
  },
  get isLoggedIn() {
    return Boolean(this.session?.accessToken);
  },
  save({ accessToken, refreshToken, expiresIn }) {
    writeJson(KEY, {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (Number(expiresIn ?? 900) - 20) * 1000,
    });
  },
  clear() {
    writeJson(KEY, null);
    writeJson(DEVICE_KEY, null);
    this.me = null;
  },
  /** access token 是否已接近过期（提前 20 秒刷新） */
  get isExpiring() {
    const s = this.session;
    return !s || Date.now() >= (s.expiresAt ?? 0);
  },
  me: null,
};

export const device = {
  get platform() {
    const stored = readJson(DEVICE_KEY, null);
    if (stored?.platform) return stored.platform;
    const platform = detectPlatform();
    writeJson(DEVICE_KEY, { platform });
    return platform;
  },
};
