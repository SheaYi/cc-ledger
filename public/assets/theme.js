/**
 * 主题三态运行时 —— 日间 / 夜间 / 自动。
 *
 * 设计取向（对齐 docs/00-DESIGN.md 与 docs/09 §8.1）
 * ---------------------------------------------------------------------------
 * · 主题是「用户意图」而不是「系统状态」。用户意图有三态（light / dark / auto），
 *   落地的配色只有两态（light / dark）。CSS 侧因此只需两个确定态选择器，
 *   由本模块把 auto 解析成实际取值后写入 <html data-theme>——
 *   避免 @media (prefers-color-scheme) 与显式选择器互相打架、把暗色块复制两份。
 * · 首屏由 index.html 的内联引导脚本先落 data-theme 再绘制（防闪烁 FOUC）；
 *   本模块只负责运行期的系统变化监听与用户切换，不参与首屏。
 * · 「自动」必须监听系统实时切换：系统日落自动转深色时，页面要跟着转，
 *   且仅当当前处于 auto 时才跟随——用户显式选了日间/夜间就不该被系统覆盖。
 * · 切换不做过渡动画：大面积 background-color 过渡会触发整屏重绘，
 *   中间帧还是两套配色的混色，观感更脏。主题是瞬时状态，不是动效。
 */

const KEY = 'cc-ledger.theme.v1';
const MQ = '(prefers-color-scheme: dark)';

/** 用户可选的三态 */
export const MODES = ['light', 'dark', 'auto'];

/** 三态的展示信息（设置页与快捷入口共用同一份文案，避免两处各写一遍） */
export const THEME_OPTIONS = [
  { value: 'light', label: '日间', icon: 'sun', desc: '始终使用亮色' },
  { value: 'dark', label: '夜间', icon: 'moon', desc: '始终使用暗色' },
  { value: 'auto', label: '自动', icon: 'monitor', desc: '跟随系统设置' },
];

export const MODE_LABEL = Object.fromEntries(THEME_OPTIONS.map((o) => [o.value, o.label]));

/** 移动端状态栏取色（docs/09 §8.1：meta theme-color 需随模式动态更新） */
const THEME_COLOR = { light: '#f5f5f7', dark: '#1d1d1f' };

const listeners = new Set();

function media() {
  return typeof window.matchMedia === 'function' ? window.matchMedia(MQ) : null;
}

/** 系统当前是否偏好深色 */
export function systemDark() {
  return media()?.matches ?? false;
}

/** 用户的意图（light / dark / auto）；存储不可用或值非法时回落到 auto */
export function getMode() {
  try {
    const raw = localStorage.getItem(KEY);
    return MODES.includes(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** 把用户意图解析为实际配色（light / dark） */
export function effective(mode = getMode()) {
  if (mode === 'auto') return systemDark() ? 'dark' : 'light';
  return mode === 'dark' ? 'dark' : 'light';
}

/** 当前实际生效的配色 */
export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * 把意图落到 DOM。
 * @returns {'light'|'dark'} 实际生效的配色
 */
export function apply(mode = getMode()) {
  const next = MODES.includes(mode) ? mode : 'auto';
  const theme = effective(next);
  const root = document.documentElement;
  root.dataset.theme = theme; // 配色（CSS 只认这两个值）
  root.dataset.themeMode = next; // 意图（调试 / 无障碍文案用）
  root.style.colorScheme = theme; // 原生控件、滚动条、选区跟随
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  return theme;
}

/** 用户切换主题 */
export function setMode(mode) {
  const next = MODES.includes(mode) ? mode : 'auto';
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* 隐私模式下写不进去也不影响本次会话生效 */
  }
  const theme = apply(next);
  notify(next, theme);
  return { mode: next, theme };
}

/** 订阅变更（设置页用它同步控件态；系统在 auto 下切换时也会触发） */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(mode, theme) {
  for (const fn of listeners) fn({ mode, theme, systemDark: systemDark() });
}

let wired = false;

/**
 * 启动运行期监听。应由 app.js 调用一次。
 * 首屏配色已由 index.html 的内联脚本落定，这里只补「系统实时变化」这一半。
 */
export function init() {
  apply();
  if (wired) return;
  wired = true;
  const mq = media();
  if (!mq) return;
  const handler = () => {
    // 只有处于自动模式才跟随系统；显式选择不被覆盖
    if (getMode() !== 'auto') return;
    const theme = apply('auto');
    notify('auto', theme);
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
  else mq.addListener(handler); // 老 WebView 兜底
}
