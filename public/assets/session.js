/**
 * 前端会话上下文：当前用户 + 当前账本。
 * 所有记账页面都从这里取「我在哪本账上」，避免各页面各拉一份。
 */
import { Api, ApiError } from './api.js';
import { auth } from './store.js';

let inflight = null;

/** 拉取（并缓存）当前用户档案；force=true 时强制刷新 */
export async function loadSession(force = false) {
  if (auth.me && !force) return auth.me;
  if (!inflight) {
    inflight = Api.me()
      .then((res) => {
        auth.me = res.data;
        return auth.me;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function invalidateSession() {
  auth.me = null;
  inflight = null;
}

/** 当前账本：优先 currentLedgerId，回落到第一本 */
export function currentLedger(me) {
  if (!me) return null;
  return me.ledgers.find((l) => l.id === me.currentLedgerId) ?? me.ledgers[0] ?? null;
}

/** 判断错误是否为登录失效 */
export function isAuthError(err) {
  return err instanceof ApiError && err.status === 401;
}

/* ---------------- 「记一笔」的来源页（docs/13 §7.2） ----------------
 * 记完账要回到「用户从哪儿点进来的那一页」，而不是无脑回首页。
 * 四个入口（侧栏 CTA / 移动顶栏图标 / TabBar 中心 / 列表页按钮）都走
 * app.js 的同一次 SPA 内链跳转，所以在那一处记录即可 —— 视图不需要各自记得埋点。
 * 用 sessionStorage 而不是 query：URL 是给人看和分享的，不该被"你刚才在哪"污染。
 */
const COMPOSE_SOURCE_KEY = 'cc-ledger.compose-source.v1';

export function rememberComposeSource(path) {
  try {
    sessionStorage.setItem(COMPOSE_SOURCE_KEY, path);
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，静默降级到默认落点 */
  }
}

export function composeSource(fallback = '/transactions') {
  try {
    return sessionStorage.getItem(COMPOSE_SOURCE_KEY) || fallback;
  } catch {
    return fallback;
  }
}
