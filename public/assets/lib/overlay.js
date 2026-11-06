/**
 * 预算页统一浮层原语（docs/16 §2 交互承载规范）。
 *
 * 四类承载物：
 *   · modal    居中的表单 / 说明（第一层）
 *   · drawer   右侧抽屉（手机端自动变底部抽屉），放较长表单与明细（第一层）
 *   · popover  锚定在触发按钮旁的气泡卡片，放短解释（不占层）
 *   · collapse 页面内折叠，放规则与方法说明（不占层）
 *
 * 层级纪律：弹窗栈深最多 2 层，且**第 2 层只允许危险操作的二次确认**。
 * 这条约束必须写在原语里而不是靠调用方自觉 —— 只要有一个页面忘了，
 * 用户就会在「抽屉里点开弹窗、弹窗里又点开弹窗」之后找不到返回路径，
 * 而每一层单独看都是合理的。confirmAction 是唯一允许开在第 2 层的入口。
 *
 * 与 ui.js 的 confirmDialog 分工：那个是给「已在页面内」的危险动作用的，
 * 它不进本模块的栈；预算页一律用这里的 confirmAction，保证层级统一。
 */
import { esc, h, icon, toast } from '../ui.js';

const MAX_LAYERS = 2;
/** 栈里存的是 modal / drawer / confirm 三种「占层」浮层；popover 与折叠不占层 */
const stack = [];

let popCurrent = null;

function closePopover() {
  if (!popCurrent) return;
  /* 先摘掉再回调：onClose 里若又开了一个气泡，不会被这里二次关掉 */
  const cur = popCurrent;
  popCurrent = null;
  cur.root.remove();
  document.removeEventListener('pointerdown', cur.onDown, true);
  document.removeEventListener('keydown', cur.onKey, true);
  window.removeEventListener('scroll', cur.onScroll, true);
  window.removeEventListener('resize', cur.onScroll, true);
  cur.onClose?.();
}

/** 栈深守卫：返回 true 表示可以继续打开 */
function guard(kind) {
  if (stack.length >= MAX_LAYERS) {
    toast('最多只能打开两层浮层，请先关闭当前弹窗', 'default');
    return false;
  }
  if (stack.length === 1 && kind !== 'confirm') {
    toast('第二层只用于危险操作的二次确认', 'default');
    return false;
  }
  return true;
}

/**
 * 打开一个占层浮层。
 *
 * 返回的 handle 上带 body / foot 两个容器与 setBody / setFoot，
 * 这样抽屉里的「预览 → 结果」切换不需要关掉再开一层（那会瞬间撞到 2 层上限）。
 */
export function openLayer({
  kind = 'modal',
  title = '',
  body = '',
  foot = '',
  wide = false,
  onClose = null,
  onEscape = null,
} = {}) {
  if (!guard(kind)) return null;
  const layerIndex = stack.length;
  const isDrawer = kind === 'drawer';
  const isConfirm = kind === 'confirm';

  const root = h(`
    <div class="${isDrawer ? 'ov-drawer' : 'ov-modal'}${wide ? ' ov-modal--wide' : ''}" role="dialog" aria-modal="true">
      <div class="${isDrawer ? 'ov-drawer__scrim' : 'ov-modal__scrim'}" data-role="scrim"></div>
      <div class="${isDrawer ? 'ov-drawer__panel' : 'ov-modal__panel'}${isConfirm ? ' ov-modal__panel--confirm' : ''}" tabindex="-1">
        ${
          isConfirm
            ? ''
            : `<div class="ov-head">
                 <h3 class="ov-title">${esc(title)}</h3>
                 <button class="btn btn--icon" type="button" data-role="close" aria-label="关闭">${icon('close', 18)}</button>
               </div>`
        }
        <div class="ov-body" data-role="body">${body}</div>
        <div class="ov-foot" data-role="foot">${foot}</div>
      </div>
    </div>
  `);
  root.style.zIndex = String(70 + layerIndex * 10);

  const prevFocus = document.activeElement;
  let closed = false;
  const entry = { root, kind, close: null, onKey: null };

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', entry.onKey, true);
    root.remove();
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    onClose?.();
  };
  entry.close = close;
  entry.onKey = (e) => {
    /* 只让栈顶响应 Escape，否则一次按键会把两层一起关掉 */
    if (e.key === 'Escape' && stack[stack.length - 1] === entry) {
      e.preventDefault();
      e.stopPropagation();
      if (onEscape) onEscape();
      else close();
    }
  };

  root.querySelector('[data-role=scrim]').addEventListener('click', () => close());
  root.querySelector('[data-role=close]')?.addEventListener('click', () => close());
  document.addEventListener('keydown', entry.onKey, true);
  document.body.appendChild(root);
  stack.push(entry);

  const bodyEl = root.querySelector('[data-role=body]');
  const footEl = root.querySelector('[data-role=foot]');
  const handle = {
    root,
    body: bodyEl,
    foot: footEl,
    close,
    setBody: (html) => {
      bodyEl.innerHTML = html;
    },
    setFoot: (html) => {
      footEl.innerHTML = html;
    },
    /** 把一段 HTML 追加进 body，并返回刚插入的首个元素集合 */
    appendBody: (html) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const nodes = [...tpl.content.children];
      nodes.forEach((n) => bodyEl.appendChild(n));
      return nodes;
    },
  };
  /* 焦点默认落在面板，避免抽屉打开后 Tab 仍停在背后的页面上 */
  root.querySelector('.ov-modal__panel, .ov-drawer__panel')?.focus();
  return handle;
}

export const openModal = (opts = {}) => openLayer({ ...opts, kind: 'modal' });
export const openDrawer = (opts = {}) => openLayer({ ...opts, kind: 'drawer' });

/**
 * 危险操作二次确认（唯一允许出现在第 2 层）。
 * 默认焦点给「取消」：破坏性操作的默认值必须是不动手。
 */
export function confirmAction({ title = '确认操作', lines = [], confirmText = '确认', danger = true } = {}) {
  return new Promise((resolve) => {
    const body = `
      <div class="stack stack--sm">
        ${lines
          .map(
            (line) =>
              `<p class="${line.strong ? 'tt-body-strong' : 'tt-caption text-muted'}">${esc(line.text ?? line)}</p>`,
          )
          .join('')}
      </div>`;
    const foot = `
      <button class="btn btn--secondary btn--sm" type="button" data-role="cancel">取消</button>
      <button class="btn ${danger ? 'btn--danger' : 'btn--primary'} btn--sm" type="button" data-role="ok">${esc(confirmText)}</button>`;
    const head = `<div class="ov-head ov-head--confirm"><h3 class="ov-title">${esc(title)}</h3></div>`;
    let settle = () => {};
    const layer = openLayer({
      kind: 'confirm',
      body: head + body,
      foot,
      /* Escape 必须把 Promise 落地，否则「按 Esc 取消」会让调用方永远挂着 */
      onEscape: () => settle(false),
    });
    if (!layer) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      layer.close();
    };
    settle = done;
    layer.root.querySelector('[data-role=cancel]').addEventListener('click', () => done(false));
    layer.root.querySelector('[data-role=ok]').addEventListener('click', () => done(true));
    layer.root.querySelector('[data-role=scrim]').addEventListener('click', () => done(false));
    layer.root.querySelector('[data-role=cancel]').focus();
  });
}

/**
 * 锚定气泡卡片。不占弹窗层；同一时刻只允许一个。
 * 位置用视口坐标 + fixed，避免被祖先 overflow 裁掉（项目里踩过这个坑）。
 */
export function openPopover(anchor, html, { width = 280, align = 'start', onClose = null } = {}) {
  closePopover();
  if (!anchor) return { close: () => {} };
  const root = h(`<div class="ov-pop" role="tooltip">${html}</div>`);
  root.style.width = `${width}px`;
  document.body.appendChild(root);
  const rect = anchor.getBoundingClientRect();
  const w = root.getBoundingClientRect().width;
  let left = align === 'end' ? rect.right - w : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  const below = rect.bottom + 8;
  const above = rect.top - root.getBoundingClientRect().height - 8;
  const top = below + root.getBoundingClientRect().height <= window.innerHeight ? below : Math.max(8, above);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  const state = {
    root,
    onClose,
    onDown: (e) => {
      if (!root.contains(e.target) && !anchor.contains(e.target)) closePopover();
    },
    onKey: (e) => {
      if (e.key === 'Escape') closePopover();
    },
    onScroll: () => closePopover(),
  };
  popCurrent = state;
  /* 延迟一帧再挂捕获监听，否则本次点击的 pointerdown 会立刻把气泡关掉 */
  setTimeout(() => {
    if (popCurrent !== state) return;
    document.addEventListener('pointerdown', state.onDown, true);
    document.addEventListener('keydown', state.onKey, true);
    window.addEventListener('scroll', state.onScroll, true);
    window.addEventListener('resize', state.onScroll, true);
  }, 0);
  return { root, close: closePopover };
}

/** 页面内折叠：一段标题 + 可展开的正文。不占浮层层 */
export function collapseHtml({ title, subtitle = '', body = '', open = false, iconName = '' } = {}) {
  return `
    <section class="ov-collapse" data-ov-collapse>
      <button class="ov-collapse__head" type="button" data-role="toggle" aria-expanded="${open ? 'true' : 'false'}">
        <span class="ov-collapse__label">
          ${iconName ? `<span class="ov-collapse__icon">${icon(iconName, 16)}</span>` : ''}
          <span class="tt-body-strong">${esc(title)}</span>
          ${subtitle ? `<span class="tt-fine-print text-muted">${esc(subtitle)}</span>` : ''}
        </span>
        <span class="ov-collapse__chev">${icon('chevron-down', 16)}</span>
      </button>
      <div class="ov-collapse__body" data-role="body"${open ? '' : ' hidden'}>${body}</div>
    </section>`;
}

/** 给容器里所有折叠区接上开关（innerHTML 重绘后要重新调一次） */
export function initCollapses(root) {
  if (!root) return;
  root.querySelectorAll('[data-ov-collapse]').forEach((box) => {
    const btn = box.querySelector('[data-role=toggle]');
    const body = box.querySelector('[data-role=body]');
    if (!btn || !body || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const next = body.hidden;
      body.hidden = !next;
      btn.setAttribute('aria-expanded', String(next));
      box.classList.toggle('is-open', next);
    });
  });
}

/** 关掉预算页残留的全部浮层（切页 / 卸载时调用） */
export function closeAllOverlays() {
  closePopover();
  [...stack].reverse().forEach((s) => s.close());
}

export const overlayDepth = () => stack.length;
