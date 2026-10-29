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

let host = null;

/** 关掉面板并清掉遮罩 */
export function closeTemplatePanel() {
  if (!host) return;
  /**
   * **移除**节点，而不是加 hidden。
   *
   * 反复开关面板会不断往同一个 host 里 append 新面板/遮罩，只切 hidden 的话
   * `host.querySelector(...)` 永远命中**第一个**（早已隐藏的那个）—— 于是第二次打开时
   * Esc 与点遮罩看起来「没反应」：它们关掉的是上一次留下的残影，新面板还挂在屏幕上。
   * 直接移除就没有这个歧义，也不用去记「到底关的是哪一个」。
   */
  host.querySelectorAll('.mega--tpl, .scrim').forEach((el) => el.remove());
  host.classList.remove('is-open');
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

  // 触发器外面要有定位上下文（.mega-host 是 position: relative）
  const mount = anchor?.closest('.mega-host') ?? anchor?.parentElement ?? null;
  if (mount && !mount.classList.contains('mega-host')) mount.classList.add('mega-host');

  host = mount
    ? mount
    : h('<div class="mega-host" data-role="tpl-anchor"></div>');
  if (!mount) document.body.appendChild(host);

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
  host.classList.add('is-open');

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