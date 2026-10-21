/**
 * DOM 基础工具 + 图标集。
 * 零依赖 —— 单镜像自托管场景不引入任何前端构建链。
 */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/** HTML 字符串 → 元素 */
export function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/* ---------------- 图标（统一 1.6 描边、currentColor，替代 SF Symbols） ---------------- */
const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="M5 5l14 14M19 5L5 19"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>',
  shield: '<path d="M12 3l7.5 3v6c0 4.4-3 8-7.5 9-4.5-1-7.5-4.6-7.5-9V6z"/>',
  split: '<path d="M4 6h4l4 6 4-6h4M4 18h4l4-6"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16.5 14.5h.01"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.8 5.8 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 19.5a5.8 5.8 0 0 0-1.6-4"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  tag: '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14.5 5.5 18.5 9.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5M4 13a8 8 0 0 0 14 4.5"/><path d="M20 4v5h-5M4 20v-5h5"/>',
  scale: '<path d="M12 4v16M7 20h10M4 9l3-3 3 3-3 3zM14 9l3-3 3 3-3 3z"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  book: '<path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M17 7h2v13H8"/>',
  // 分期账单导航项用。放在这里而不是靠 lucide()：侧栏走 icon()，缺名会静默渲染成问号
  'credit-card': '<rect x="3" y="5.5" width="18" height="13" rx="2.6"/><path d="M3 10h18M6.5 14.5h4"/>',
  // 统计用「靶心」（预算的图标）—— chart 已被趋势线占用
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15"/>',

  // ---- 侧栏导航项（icon() 的缺名会静默返回空串，界面上就是一个「没有图标」的项）----
  /**
   * 往来：两只手相握。`hand-coins` / `heart-handshake` 在 lucide 那边有，
   * 但侧栏走的是这里的 icon()，必须自己有一份。
   */
  handshake:
    '<path d="M11 17.5 8.5 20a2.1 2.1 0 0 1-3-3l2.6-2.6"/><path d="M6.5 10.5 4 13a2.1 2.1 0 0 0 3 3l2.5-2.5"/><path d="m8 15 6-6"/><path d="m12.5 7.5.9-.9a2.1 2.1 0 0 1 3 3L15 11"/><path d="M18 12.5 20.5 10a2.1 2.1 0 0 0-3-3L15 9.5"/>',
  /** 模板：两张叠放的卡片 */
  copy: '<rect x="8.5" y="3.5" width="12" height="14" rx="2.2"/><path d="M15.5 20.5h-9a2 2 0 0 1-2-2v-11"/>',
  /** 周期账单：日历 + 循环箭头（与「记一笔的日期」区分开） */
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M9.5 14.5a3 3 0 0 1 4.6 2.5"/><path d="m9 14 1.2 1.6L8 17"/>',
};

export function icon(name, size = 20) {
  const p = PATHS[name];
  if (!p) return '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* ---------------- Lucide 开源图标（ISC） ----------------
 * 图标数据由 scripts/gen-lucide.mjs 从 lucide-static 生成到 lucide-data.js，
 * 离线自托管，不依赖 CDN。缺名时回退到 tag 图标，保证版面不塌。 */
import { LUCIDE } from './lucide-data.js';

export function lucide(name, size = 16, cls = '') {
  const body = LUCIDE[name] ?? LUCIDE['circle-help'] ?? '';
  const label = LUCIDE[name] ? '' : ` data-missing-icon="${esc(name)}"`;
  return `<svg class="lucide ${cls ? esc(cls) : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${label}>${body}</svg>`;
}

/**
 * 账户类型的兜底图标。
 *
 * 存在的理由：`entityIcon('')` 返回空串 —— 渲染出来就是「图标位空着」，
 * 不报错、不占位，一眼扫过去像排版没对齐。系统虚拟账户（债权/债务/手续费）
 * 曾经因为 seed 没写 icon 而全员空白，且**永久**成立（用户不会去编辑它们）。
 * 与其在每个调用点判空，不如在这里统一回退。
 *
 * 图标名与 `src/config/constants.ts` 的 `SYSTEM_VIRTUAL_ACCOUNTS[].icon`
 * 刻意保持同一套字面量，两处任一写错都会静默变成 `circle-help` 问号图。
 */
export const ACCOUNT_TYPE_ICON = {
  cash: 'banknote',
  debit_card: 'landmark',
  credit_card: 'credit-card',
  third_party: 'wallet-cards',
  prepaid: 'wallet',
  investment: 'piggy-bank',
  fixed_deposit: 'badge-dollar-sign',
  loan: 'hand-coins',
  receivable: 'hand-coins',
  payable: 'heart-handshake',
  fee: 'circle-percent',
  other: 'banknote',
};

/**
 * 账户行图标：`a.icon` 优先，为空则按 `a.type` 回退，再空才真的不渲染。
 *
 * ⚠️ 刻意**不**回退到 `circle-help`：问号图标是在说「这里出错了」，
 * 而「用户没设图标」不是错误。留空由调用点决定（行内会塌掉、页面级才留空）。
 */
export function accountIcon(a, size = 16, cls = '') {
  return entityIcon(a?.icon, size, cls) || entityIcon(ACCOUNT_TYPE_ICON[a?.type], size, cls);
}

/** 实体图标兼容渲染：Lucide 图标名 → 矢量图；旧 emoji → 原样输出。 */
export function entityIcon(name, size = 16, cls = '') {
  const v = String(name ?? '').trim();
  if (!v) return '';
  if (LUCIDE[v]) return lucide(v, size, cls);
  return `<span class="emoji-icon ${cls ? esc(cls) : ''}">${esc(v)}</span>`;
}

/* ---------------- Toast ---------------- */
export function toast(message, kind = 'info', ttl = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = h(`<div class="toast" data-kind="${esc(kind)}" role="status">${esc(message)}</div>`);
  root.appendChild(node);
  setTimeout(() => node.remove(), ttl);
}

/**
 * 带动作按钮的 Toast（docs/13 §7.1 / §7.4）。
 *
 * 记完账的确认条要做三件事：说出「记了什么」、给一次**再记一笔**、给一次**撤销**。
 * 撤销窗口刻意等于本 Toast 的存活期（5 秒）—— 它比 30 天回收站短得多，
 * 但足够覆盖「手滑记错」，且不引入 redo（状态机保持单线）。
 *
 * @param {string} message
 * @param {Array<{label:string, onClick:Function, primary?:boolean}>} actions
 * @param {{ttl?:number, kind?:string}} [opts]
 * @returns {{ close: () => void }}
 */
export function actionToast(message, actions = [], { ttl = 5000, kind = 'success' } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return { close: () => {} };

  const node = h(`
    <div class="toast toast--action" data-kind="${esc(kind)}" role="status">
      <span class="toast__msg">${esc(message)}</span>
      <span class="toast__acts">${actions
        .map(
          (a, i) =>
            `<button class="toast__act${a.primary ? ' toast__act--primary' : ''}" type="button" data-i="${i}">${esc(a.label)}</button>`,
        )
        .join('')}</span>
    </div>
  `);

  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    node.remove();
  };

  node.querySelectorAll('.toast__act').forEach((btn) =>
    btn.addEventListener('click', () => {
      const action = actions[Number(btn.dataset.i)];
      close();
      action?.onClick?.();
    }),
  );

  root.appendChild(node);
  // 有动作的 Toast 不该被误触清掉：鼠标悬停时暂停倒计时
  const start = () => {
    timer = setTimeout(close, ttl);
  };
  node.addEventListener('mouseenter', () => timer && clearTimeout(timer));
  node.addEventListener('mouseleave', start);
  start();

  return { close };
}

/* ---------------- 按钮 loading 态 ---------------- */
export function setLoading(btn, loading, loadingText = '处理中') {
  if (!btn) return;
  if (loading) {
    btn.dataset.original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn__spinner"></span><span>${esc(loadingText)}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.original) btn.innerHTML = btn.dataset.original;
  }
}

/* ---------------- 表单错误 ---------------- */
export function clearFieldErrors(form) {
  form.querySelectorAll('.field__error').forEach((el) => (el.textContent = ''));
  form.querySelectorAll('.input').forEach((el) => el.removeAttribute('aria-invalid'));
}

export function applyFieldErrors(form, map) {
  let first = null;
  for (const [field, message] of Object.entries(map || {})) {
    const wrap = form.querySelector(`[data-field="${CSS.escape(field)}"]`);
    if (!wrap) continue;
    const err = wrap.querySelector('.field__error');
    if (err) err.textContent = message;
    const input = wrap.querySelector('.input');
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (!first) first = input;
    }
  }
  first?.focus();
}

/* ---------------- 用户展示 ---------------- */
export function initials(name) {
  const s = String(name ?? '').trim();
  if (!s) return '·';
  return /[\u4e00-\u9fa5]/.test(s[0]) ? s[0] : s.slice(0, 2).toUpperCase();
}

export function avatarHtml(user, cls = '') {
  const name = user?.nickname || user?.username || '';
  const klass = `avatar${cls ? ' ' + cls : ''}`;
  if (user?.avatarPath) {
    return `<span class="${klass}"><img src="${esc(user.avatarPath)}" alt="${esc(name)}"></span>`;
  }
  return `<span class="${klass}">${esc(initials(name))}</span>`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10).split('-');
  return s.length === 3 ? `${s[0]} 年 ${Number(s[1])} 月 ${Number(s[2])} 日` : iso;
}

export const ROLE_LABEL = { owner: '所有者', admin: '管理员', member: '成员' };
export const LEDGER_TYPE_LABEL = { personal: '个人账本', shared: '共同账本' };

/* ---------------- 记账语义字典（对齐 docs/02 §六、docs/08） ---------------- */
export const RECORD_TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  receivable: '应收',
  payable: '应付',
  adjustment: '余额调整',
};

export const ACCOUNT_KIND_LABEL = { asset: '资产', liability: '负债', virtual: '虚拟' };

export const ACCOUNT_TYPE_LABEL = {
  cash: '现金',
  debit_card: '储蓄卡',
  credit_card: '信用卡',
  third_party: '微信 / 支付宝',
  prepaid: '储值卡',
  investment: '投资',
  fixed_deposit: '定期存款',
  loan: '贷款',
  receivable: '债权（借出）',
  payable: '债务（欠款）',
  fee: '手续费',
  other: '其他',
};

export const RECONCILE_REASON_LABEL = {
  unrecorded_expense: '未记账消费',
  unrecorded_income: '未记账收入',
  bank_fee: '银行手续费',
  interest: '利息',
  fx_diff: '汇率差异',
  history_missing: '历史遗漏',
  entry_error: '录入错误',
  other: '其他',
};

/** 金额展示：¥ 1,234.56 */
export function money(value) {
  const n = Number(value ?? 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}¥ ${Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 带正负号（用于净结余、差额） */
export function signedMoney(value) {
  const n = Number(value ?? 0);
  return `${n > 0 ? '+' : ''}${money(n)}`;
}

/**
 * 金额滚动：只在「英雄数字」（净资产）上使用，其余金额保持静态。
 * 纪律对齐 00-DESIGN：单一减速缓动、不弹跳；tabular-nums 保证滚动时宽度不抖。
 * prefers-reduced-motion 时直接显示终值。
 */
export function countUp(el, value, { duration = 600 } = {}) {
  if (!el) return;
  const target = Number(value ?? 0);
  if (!Number.isFinite(target)) {
    el.textContent = money(0);
    return;
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = money(target);
    return;
  }
  const start = performance.now();
  const decel = (t) => 1 - Math.pow(1 - t, 3); /* 标准缓动的 JS 近似（减速曲线） */
  const tick = (now) => {
    const p = Math.min((now - start) / duration, 1);
    el.textContent = money(target * decel(p));
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = money(target); /* 收尾写精确值 */
  };
  requestAnimationFrame(tick);
}

/** 余额语义色：负数（负债/透支）用告警色 */
export function tone(value) {
  const n = Number(value ?? 0);
  if (n > 0) return 'is-pos';
  if (n < 0) return 'is-neg';
  return 'is-zero';
}

/** 收支语义：支出用告警色、收入用成功色（记账应用通用，非股票涨跌） */
export const FLOW_TONE = { expense: 'is-neg', income: 'is-pos' };

/** YYYY-MM → 2026 年 10 月 */
export function monthLabel(ym) {
  const [y, m] = String(ym).split('-');
  return `${y} 年 ${Number(m)} 月`;
}

/** 今天 YYYY-MM-DD */
export function todayStr(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
