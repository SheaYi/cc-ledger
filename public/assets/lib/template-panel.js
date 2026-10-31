/**
 * 模板面板（`docs/05 §10.5`）：长按「记一笔」带出常用模板，一键预填。
 *
 * 为什么是长按而不是短按：短按的语义必须是「打开空表单」（最常用、最不该被干扰），
 * 长按才是「我这次要照着上次记」——两个意图在同一颗按钮上并存，只能靠手势区分
 * （`docs/07 §Stage 9`、`docs/13 §3.5`）。
 *
 * 面板只做两件事：**展示 + 选中**。选中即写一次性种子（`sessionStorage`）再跳转，
 * 记账页消费后立即焚毁（`compose-seed.v1`，与「再记一笔」同一个机制）。
 * 面板自己不碰表单状态 —— 那样会让「打开面板看一眼就关掉」也变成一次填表。
 */
import { Api } from '../api.js';
import { esc, h, lucide, money, toast } from '../ui.js';
import { currentLedger, loadSession } from '../session.js';

/** 种子键：与「再记一笔」「往来结清」共用同一个（读掉即焚，一次性） */
const SEED_KEY = 'cc-ledger.compose-seed.v1';

/**
 * 面板与遮罩的**顶层挂点**：常驻 `document.body`，不随任何视图重建。
 *
 * 为什么不挂在触发器旁边（`.mega-host`，旧做法）：侧栏那条 `.mega-host` 埋在
 * `.sidebar` 里面，而侧栏是 `overflow-y: auto` —— 绝对定位的面板会被它**裁切**，
 * 面板标题被切掉、列表只能露出上半截；同时它的 `z-index` 被锁在侧栏的层叠上下文里，
 * 抬不过 `-main` 的内容，于是账单列表的金额列压在面板上面，两边互相遮。
 *
 * 挂到 body 顶层、`position: fixed` 铺满视口，就同时解决了裁切与层叠两件事：
 * 面板不再属于任何滚动容器或层叠上下文，**自己就是最上面的一层**。
 */
const OVERLAY_ID = 'cc-tpl-overlay';

function overlayRoot() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = h('<div class="tpl-overlay" hidden></div>');
    el.id = OVERLAY_ID;
    document.body.appendChild(el);
  }
  return el;
}

/**
 * 把面板放到触发器旁边。
 *
 * `above / below` 由**实测可用空间**决定，不再按「是侧栏还是 TabBar」猜：
 * 旧规则把两者写成两套 CSS（`.mega--tpl` 向上、`.mega-host--side` 向下），
 * 一旦按钮换位置或视口变矮，写死的方向就会把面板顶出视口。
 */
function placePanel(panel, anchor) {
  const pad = 12;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = anchor ? anchor.getBoundingClientRect() : null;

  const width = Math.min(rect ? Math.max(rect.width, 280) : 360, vw - pad * 2);
  let left = rect ? rect.left : (vw - width) / 2;
  left = Math.max(pad, Math.min(left, vw - width - pad));

  const below = rect ? vh - rect.bottom - gap - pad : vh - pad * 2;
  const above = rect ? rect.top - gap - pad : 0;
  /** 下方连 220px 都放不下就翻上去（220 ≈ 头 + 两条模板，再短就没用了） */
  const openUp = below < 220 && above > below;

  panel.style.width = `${Math.round(width)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.transform = 'none';
  if (openUp) {
    panel.style.top = 'auto';
    panel.style.bottom = `${Math.round(vh - (rect?.top ?? vh) + gap)}px`;
    panel.style.maxHeight = `${Math.round(Math.min(above, vh - pad * 2))}px`;
  } else {
    panel.style.bottom = 'auto';
    panel.style.top = `${Math.round((rect?.bottom ?? 0) + gap)}px`;
    panel.style.maxHeight = `${Math.round(Math.min(below, vh - pad * 2))}px`;
  }
}

/** 关掉面板并清掉遮罩 */
export function closeTemplatePanel() {
  const root = document.getElementById(OVERLAY_ID);
  if (!root) return;
  /**
   * **移除**节点，而不是加 hidden。
   *
   * 反复开关面板会不断往同一个 host 里 append 新面板/遮罩，只切 hidden 的话
   * `host.querySelector(...)` 永远命中**第一个**（早已隐藏的那个）—— 于是第二次打开时
   * Esc 与点遮罩看起来「没反应」：它们关掉的是上一次留下的残影，新面板还挂在屏幕上。
   * 直接移除就没有这个歧义，也不用去记「到底关的是哪一个」。
   */
  root.querySelectorAll('.mega--tpl, .scrim').forEach((el) => el.remove());
  root.hidden = true;
  window.removeEventListener('resize', closeTemplatePanel.onReflow);
  window.removeEventListener('scroll', closeTemplatePanel.onReflow, true);
  closeTemplatePanel.onReflow = null;
}

function rowHtml(tpl) {
  const p = tpl.payload ?? {};
  // 副标题：账户 › 分类（缺一个就少一段，不留多余的分隔符）
  const sub = [p.accountName, p.categoryName].filter(Boolean).join(' › ') || '未指定账户与分类';
  const warn = (tpl.warnings ?? []).filter((w) => w.level === 'error');
  const soft = (tpl.warnings ?? []).filter((w) => w.level === 'warn');
  const amount = Number(p.defaultAmount ?? 0) > 0 ? money(String(p.defaultAmount)) : null;
  const marks = [
    tpl.pinned ? '<span class="tpl-row__pin" title="已锁定置顶">置顶</span>' : '',
    warn.length
      ? `<span class="tpl-row__warn" title="${esc(warn[0].message)}">${lucide('triangle-alert', 13)}</span>`
      : '',
    soft.length
      ? `<span class="tpl-row__warn tpl-row__warn--soft" title="${esc(soft[0].message)}">${lucide('info', 13)}</span>`
      : '',
  ].join('');
  return `
    <button class="tpl-row" type="button" data-tpl="${esc(tpl.id)}">
      <span class="tpl-row__icon">${tpl.icon ? lucide(tpl.icon, 18) : lucide('receipt', 18)}</span>
      <span class="tpl-row__text">
        <span class="tpl-row__name">${esc(tpl.name)}${marks}</span>
        <span class="tpl-row__sub">${esc(sub)}</span>
      </span>
      <span class="tpl-row__amt tnum">${amount ? esc(amount) : ''}</span>
    </button>`;
}

/**
 * 模板 → 记账表单种子的映射（**面板点击**与 **`?template=` 路由**共用这一份）。
 *
 * 固化：类型 / 阶段 / 账户 / 转账户 / 分类 / 名称 / 商家 / 对象 / 备注 / 手续费 / 折扣 / 标签。
 * 不固化：金额（只作建议值）、日期与时间（每次记当下）——`docs/05 §10.2`。
 */
export function templateSeedOf(tpl) {
  const p = tpl?.payload ?? {};
  return {
    purpose: 'template',
    recordType: p.recordType,
    direction: p.direction,
    accountId: p.accountId,
    toAccountId: p.toAccountId,
    categoryId: p.categoryId,
    name: p.name,
    merchant: p.merchant,
    counterparty: p.counterparty,
    note: p.note,
    tagIds: p.tagIds ?? [],
    fee: p.fee,
    discount: p.discount,
    defaultAmount: p.defaultAmount,
    templateName: tpl?.name ?? '',
    warnings: tpl?.warnings ?? [],
  };
}

/** 把种子写进 sessionStorage（读掉即焚）。返回是否写入成功。 */
export function writeTemplateSeed(tpl) {
  try {
    sessionStorage.setItem(SEED_KEY, JSON.stringify(templateSeedOf(tpl)));
    return true;
  } catch {
    // sessionStorage 不可用（隐私模式）：退回普通空表单，不给半截预填
    return false;
  }
}

/**
 * 打开面板。
 * @param {{ledger: object, go: (p: string) => void, anchor?: Element}} cfg
 *        anchor 是触发元素（TabBar 的「记」按钮）；缺省时挂到 body 上居中。
 */
export async function openTemplatePanel({ ledger, go, anchor }) {
  if (!go) return;

  /**
   * 账本兜底：`currentLedger()` 必须传 `me`（session.js 的签名），而 TabBar 是全站共用的
   * ——不能指望每个视图都记得往 mountTabBar 里传 ledger（第一版就是漏传导致面板永远不开，
   * 而且失败得很安静：onLongPress 里直接 return，界面上什么现象都没有）。
   * 这里自己兜一份，任何页面调得通。
   */
  let led = ledger?.id ? ledger : null;
  if (!led) {
    try {
      led = currentLedger(await loadSession());
    } catch {
      led = null;
    }
  }
  if (!led?.id) {
    toast('账本信息还没就绪，请稍后再试');
    return;
  }
  const ledgerId = led.id;

  closeTemplatePanel();

  const host = overlayRoot();
  host.hidden = false;

  const scrim = h('<div class="scrim" data-role="tpl-scrim" hidden></div>');
  const panel = h(`
    <div class="mega mega--tpl" role="dialog" aria-label="选择模板" hidden>
      <div class="tpl-panel__head">
        <span class="tpl-panel__title">选个模板开始</span>
        <button class="tpl-panel__x" type="button" data-role="tpl-close" aria-label="关闭">
          ${lucide('x', 16)}
        </button>
      </div>
      <div class="tpl-panel__body" data-role="tpl-body">
        <div class="tpl-skel"></div>
        <div class="tpl-skel"></div>
        <div class="tpl-skel"></div>
      </div>
    </div>
  `);
  host.appendChild(scrim);
  host.appendChild(panel);

  const body = panel.querySelector('[data-role=tpl-body]');
  const close = () => closeTemplatePanel();
  scrim.addEventListener('click', close);
  panel.querySelector('[data-role=tpl-close]').addEventListener('click', close);
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  // 每次打开都换一个新监听，所以关闭时必须解绑 —— 否则长按十次就叠了十个 keydown。
  closeTemplatePanel.onEsc = () => document.removeEventListener('keydown', onKey);

  scrim.removeAttribute('hidden');
  panel.removeAttribute('hidden');
  openTemplatePanel.onEsc?.();

  /**
   * 面板现在按视口坐标摆放，滚动窗口（或把浏览器拉窄）之后必须**重新算一遍**，
   * 否则它会停在旧位置上，慢慢和触发器脱节。
   * 用 capture 阶段的 scroll 才能接住滚动发生在内层容器（`main`）的情况。
   */
  closeTemplatePanel.onReflow = () => placePanel(panel, anchor);
  window.addEventListener('resize', closeTemplatePanel.onReflow);
  window.addEventListener('scroll', closeTemplatePanel.onReflow, true);
  placePanel(panel, anchor);

  let list = [];
  try {
    list = (await Api.listTemplates(ledgerId)).data ?? [];
  } catch {
    body.innerHTML = `<p class="tpl-panel__empty">模板加载失败，请稍后再试</p>`;
    return;
  }

  if (!list.length) {
    body.innerHTML = `
      <p class="tpl-panel__empty">
        还没有模板。记完一笔后点「存为模板」，下次长按这里就能一键预填。
      </p>`;
    return;
  }

  body.innerHTML = `<div class="tpl-list">${list.map(rowHtml).join('')}</div>`;

  body.querySelectorAll('[data-tpl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.tpl;
      btn.disabled = true;
      let tpl = list.find((t) => t.id === id);
      // 用一次才 +1（顺手做掉，省一次往返）；失败不阻断预填
      try {
        tpl = (await Api.useTemplate(ledgerId, id)).data ?? tpl;
      } catch {
        /* 计数失败不该挡住记账 */
      }
      writeTemplateSeed(tpl);
      closeTemplatePanel();
      go('/transactions/new');
    });
  });
}