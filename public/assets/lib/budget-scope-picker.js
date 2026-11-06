/**
 * 预算「类型 + 定位」合并选择器。
 *
 * 与记一笔的 `type-cat-picker.js` 是同一套 Mega Menu 语法：触发按钮用
 * `.pick-trigger`，面板里的行用 `.mega__item` / `.mega__navitem`，最终可选值用
 * `.option-chip`，底部用 `.mega__foot`。用户刚在记账页学会的操作，在这里不该失灵。
 *
 * 差别只在决策链的内容：记账是「类型 → 一级分类 → 二级分类」，预算是
 * 「预算类型 → 定位方式（总预算 / 一级分类）→ 二级分类」。两者都落在同一个
 * 弹窗菜单里完成，不再各开一个下拉框。
 *
 * 面板走 `overlay.js` 的 openPopover：**不占弹窗层**（预算页最多两层、第二层
 * 只放危险确认），且是 fixed 定位，不会被抽屉 `.ov-body` 的 overflow 裁掉。
 *
 * 数据纪律：模块只回传 `{ budgetKind, categoryId }`，写进表单里同名隐藏字段，
 * 提交时的 payload 拼装与字段级校验仍由调用方原样负责。
 */
import { esc, icon, lucide } from '../ui.js';
import { openPopover } from './overlay.js';

/** 预算类型：与后端 budgetKind 的三个取值一一对应 */
export const BUDGET_KINDS = [
  { key: 'expense', label: '支出预算', hint: '控制花钱，超出额度即超支', icon: 'wallet' },
  { key: 'income', label: '收入预算', hint: '达成目标，超额是有利差异', icon: 'trending-up' },
  { key: 'savings', label: '储蓄预算', hint: '存下多少，超额是有利差异', icon: 'piggy-bank' },
];

/** 「总预算」在第二列里是一个可直接落定的定位项，不是分类树的一支 */
export const SCOPE_TOTAL = '__total__';

/**
 * 触发按钮的标记。表单行自己渲染 label，所以这里刻意不带 `.field__label`，
 * 避免和「每行标签与输入框水平对齐」的栅格重复占一列。
 */
export function budgetScopeTriggerHtml({ labelId = 'bdg-scope-label' } = {}) {
  return `
    <div class="mega-host bsp-host" data-bsp-host>
      <button class="pick-trigger bsp-trigger" type="button" data-bsp-trigger
              aria-haspopup="menu" aria-expanded="false" aria-labelledby="${esc(labelId)}">
        <span class="pick-trigger__icon" data-bsp-icon></span>
        <span class="pick-trigger__text">
          <span class="pick-trigger__label" data-bsp-label></span>
          <span class="pick-trigger__sub" data-bsp-sub></span>
        </span>
        <span class="pick-trigger__chev">${icon('chevron-down', 16)}</span>
      </button>
    </div>`;
}

/**
 * 建一个选择器实例。
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.trigger  触发按钮
 * @param {Array} cfg.cats           二级分类扁平表 [{id,name,icon,parentId,parentName}]
 * @param {()=>{budgetKind:string, categoryId:string|null}} cfg.value 当前值
 * @param {(v:{budgetKind:string, categoryId:string|null})=>void} cfg.onPick 选中回传
 * @param {number} [cfg.width]      面板宽度（默认 360）
 */
export function createBudgetScopePicker(cfg) {
  const trigger = cfg.trigger;
  const cats = cfg.cats ?? [];
  const width = cfg.width ?? 360;
  const $ = (sel) => trigger.querySelector(sel);

  /** 按一级分类分组，保留原顺序（分类树本来就是用户排好的） */
  const parents = [];
  for (const c of cats) {
    const pid = c.parentId ?? c.parentName;
    let p = parents.find((x) => x.id === pid);
    if (!p) {
      p = { id: pid, name: c.parentName, kids: [] };
      parents.push(p);
    }
    p.kids.push(c);
  }

  let pop = null;
  let draftParent = SCOPE_TOTAL;
  let query = '';

  const currentCat = () => cats.find((c) => c.id === cfg.value().categoryId) ?? null;

  /** 每次展开都从「现在的选择」重新出发，别把上次只看没选的中间态带进来 */
  const resetDraft = () => {
    const cur = currentCat();
    draftParent = cur ? (cur.parentId ?? cur.parentName) : SCOPE_TOTAL;
    query = '';
  };

  const paintTrigger = () => {
    const v = cfg.value();
    const kind = BUDGET_KINDS.find((k) => k.key === v.budgetKind) ?? BUDGET_KINDS[0];
    const cat = currentCat();
    const iconSlot = $('[data-bsp-icon]');
    if (iconSlot) iconSlot.innerHTML = lucide(cat?.icon || kind.icon, 18);
    const label = $('[data-bsp-label]');
    if (label) label.textContent = cat ? cat.name : '总预算';
    const sub = $('[data-bsp-sub]');
    if (sub) sub.textContent = cat ? `${kind.label} · ${cat.parentName}` : `${kind.label} · 整个账本`;
  };

  const close = () => {
    if (pop?.root?.isConnected) pop.close();
    pop = null;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const isOpen = () => Boolean(pop?.root?.isConnected);

  const catChip = (c, tagged = false) => {
    const on = !tagged && c.id === cfg.value().categoryId;
    return `
      <button class="option-chip" type="button" role="menuitemradio" aria-checked="${on}"
              data-bsp-cat="${esc(c.id)}" title="${esc(`${c.parentName} › ${c.name}`)}">
        ${c.icon ? lucide(c.icon, 14) : ''}<span>${esc(c.name)}</span>
        ${tagged ? `<span class="option-chip__badge">${esc(c.parentName)}</span>` : ''}
      </button>`;
  };

  const bodyHtml = () => {
    const v = cfg.value();
    const q = query.trim().toLowerCase();

    const kinds = `
      <section class="bsp__sec">
        <p class="mega__col-title">预算类型</p>
        <div class="bsp__kinds">${BUDGET_KINDS.map((k) => {
          const on = k.key === v.budgetKind;
          return `
          <button class="mega__item${on ? ' is-on' : ''}" type="button" role="menuitemradio"
                  aria-checked="${on}" data-bsp-kind="${esc(k.key)}">
            <span class="mega__item-icon">${lucide(k.icon, 17)}</span>
            <span class="mega__item-text">
              <span class="mega__item-name">${esc(k.label)}</span>
              <span class="mega__item-hint">${esc(k.hint)}</span>
            </span>
            ${on ? `<span class="mega__item-mark">${lucide('check', 16)}</span>` : ''}
          </button>`;
        }).join('')}</div>
      </section>`;

    /* 编辑一条「总预算」时定位不可改：旧版这里是一个 disabled 的下拉，
       合并菜单也不能悄悄放开，否则会把账本级约束改成分类预算 */
    if (cfg.lockScope) {
      return `${kinds}
        <section class="bsp__sec">
          <p class="mega__col-title">定位</p>
          <p class="mega__empty">总预算的定位固定为整个账本，编辑时不可改动。</p>
        </section>`;
    }

    if (q) {
      const hits = cats.filter(
        (c) => c.name.toLowerCase().includes(q) || String(c.parentName ?? '').toLowerCase().includes(q),
      );
      return `${kinds}
        <section class="bsp__sec">
          <p class="mega__col-title">定位 · 命中 ${hits.length} 个分类</p>
          <div class="bsp__leaves">${hits.length
            ? `<div class="mega__grid">${hits.map((c) => catChip(c, true)).join('')}</div>`
            : '<p class="mega__empty">没有匹配的分类</p>'}</div>
        </section>`;
    }

    const totalOn = draftParent === SCOPE_TOTAL;
    const pane = parents.find((p) => p.id === draftParent);
    return `${kinds}
      <section class="bsp__sec">
        <p class="mega__col-title">定位</p>
        <div class="bsp__scopes">
          <button class="mega__navitem${totalOn ? ' is-on' : ''}" type="button"
                  role="menuitemradio" aria-checked="${totalOn}" data-bsp-total>
            <span class="mega__navitem-icon">${lucide('target', 16)}</span>
            <span class="mega__navitem-name">总预算（整个账本）</span>
            ${totalOn && !cfg.value().categoryId ? `<span class="mega__item-mark">${lucide('check', 16)}</span>` : ''}
          </button>
          ${parents.map((p) => `
          <button class="mega__navitem${p.id === draftParent ? ' is-on' : ''}" type="button"
                  role="menuitem" aria-checked="${p.id === draftParent}" data-bsp-parent="${esc(p.id)}">
            <span class="mega__navitem-icon">${lucide('layers', 16)}</span>
            <span class="mega__navitem-name">${esc(p.name)}</span>
            <span class="mega__navitem-count">${p.kids.length}</span>
          </button>`).join('')}
        </div>
        <div class="bsp__leaves">${pane
          ? `<div class="mega__grid">${pane.kids.map((c) => catChip(c)).join('')}</div>`
          : '<p class="mega__empty">一笔总约束，覆盖整个账本，不按分类拆分。</p>'}</div>
      </section>`;
  };

  const menuHtml = () => `
    <div class="bsp" role="menu" aria-label="预算类型与定位">
      ${cfg.lockScope ? '' : `<div class="bsp__head">
        <span class="bsp__search-ico">${lucide('search', 15)}</span>
        <input class="bsp__search" type="search" data-bsp-search
               placeholder="搜索分类（跨全部一级分类）" autocomplete="off" enterkeyhint="search" />
      </div>`}
      <div class="bsp__body" data-bsp-body>${bodyHtml()}</div>
      <div class="mega__foot">
        <span class="mega__hint">标签 / 专项项目请在表单下方补「归集标签」「专项项目名」</span>
        <button class="mega__clear" type="button" data-bsp-done>完成</button>
      </div>
    </div>`;

  const paintBody = () => {
    const body = pop?.root?.querySelector('[data-bsp-body]');
    if (body) body.innerHTML = bodyHtml();
  };

  const commit = (patch) => {
    const nextCategory = cfg.lockScope || patch.categoryId === undefined
      ? cfg.value().categoryId
      : patch.categoryId;
    cfg.onPick({
      budgetKind: patch.budgetKind ?? cfg.value().budgetKind,
      categoryId: nextCategory,
    });
    paintTrigger();
    paintBody();
  };

  const open = () => {
    resetDraft();
    const handle = openPopover(trigger, menuHtml(), {
      width,
      align: 'start',
      onClose: () => {
        pop = null;
        trigger.setAttribute('aria-expanded', 'false');
      },
    });
    pop = handle;
    pop.root.classList.add('ov-pop--menu');
    pop.root.setAttribute('role', 'dialog');
    trigger.setAttribute('aria-expanded', 'true');

    pop.root.addEventListener('input', (e) => {
      if (!e.target.matches('[data-bsp-search]')) return;
      query = e.target.value ?? '';
      paintBody();
    });

    pop.root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.bspKind) {
        commit({ budgetKind: btn.dataset.bspKind });
        return;
      }
      if (btn.hasAttribute('data-bsp-total')) {
        draftParent = SCOPE_TOTAL;
        commit({ categoryId: null });
        close();
        return;
      }
      if (btn.dataset.bspParent) {
        draftParent = btn.dataset.bspParent;
        paintBody();
        return;
      }
      if (btn.dataset.bspCat) {
        commit({ categoryId: btn.dataset.bspCat });
        close();
        return;
      }
      if (btn.hasAttribute('data-bsp-done')) close();
    });
  };

  trigger.addEventListener('click', () => {
    if (isOpen()) close();
    else open();
  });

  paintTrigger();
  return { paintTrigger, close, isOpen, open };
}
