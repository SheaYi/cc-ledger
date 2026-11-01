/**
 * 图标选择器：一个触发器 + 一个图标库弹层（搜索 / 分组浏览 / 清除）。
 *
 * 为什么要它：模板页最早把 18 个图标**平铺在表单里**，占据三行高度，
 * 旁边「模板名」输入框只有 44px —— 一行里两个控件差出 100px，
 * 表单立刻变成锯齿形。图标是「低频、候选多」的输入，
 * 正确的形态是**藏进弹层**，用的时候才展开。
 *
 * 与 `type-cat-picker.js` 同一套写法：标记由 xxxHtml() 产出、
 * 状态与行为由 createXxx() 接管，两处共用同一份结构，改一处不会漏另一处。
 *
 * ⚠️ 全部 DOM 查询限定在传入的 host 内（这个选择器将来会用在分类页 / 账户页）。
 */
import { esc, lucide } from '../ui.js';
import { ICON_GROUPS, ICON_FLAT, iconNameOf } from './icon-catalog.js';

/** 触发器的外观：与 `.input` 同高（44px），图标 + 中文名 + 展开箭头 */
export function iconPickerHtml({ labelId = 'icon-label', label = '图标' } = {}) {
  return `
    ${label ? `<span class="field__label" id="${esc(labelId)}">${esc(label)}</span>` : ''}
    <div class="mega-host" data-role="icon-host">
      <button class="icon-trigger" type="button" data-role="icon-trigger"
              aria-haspopup="menu" aria-expanded="false" aria-labelledby="${esc(labelId)}">
        <span class="icon-trigger__icon" data-role="icon-preview"></span>
        <span class="icon-trigger__text" data-role="icon-text"></span>
        <span class="icon-trigger__chev">${lucide('chevron-down', 16)}</span>
      </button>

      <div class="mega mega--icon" data-role="icon-panel" role="menu"
           aria-labelledby="${esc(labelId)}" hidden>
        <!-- 搜索：中文名与英文名都能命中（图标库里找的是「咖啡」不是 coffee） -->
        <div class="mega__head">
          <span class="mega__search-icon">${lucide('search', 15)}</span>
          <input class="mega__search" type="search" data-role="icon-search"
                 placeholder="搜索图标（中文或英文）" autocomplete="off" enterkeyhint="search" />
        </div>

        <div class="icon-cats" data-role="icon-cats" role="tablist"></div>
        <div class="icon-grid icon-grid--pop" data-role="icon-grid" role="radiogroup"
             aria-label="图标"></div>

        <div class="mega__foot">
          <span class="mega__hint" data-role="icon-hint"></span>
          <button class="mega__clear" type="button" data-role="icon-clear" hidden>清除图标</button>
        </div>
      </div>
    </div>`;
}

/**
 * 建一个图标选择器实例。
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.host   包着触发器与弹层的容器
 * @param {()=>string} cfg.value   当前图标名（空串 = 不指定）
 * @param {(name:string)=>void} cfg.onPick 选中回调（清除时传空串）
 */
export function createIconPicker(cfg) {
  const host = cfg.host;
  const $ = (sel) => host.querySelector(sel);

  const panel = $('[data-role=icon-panel]');
  const trigger = $('[data-role=icon-trigger]');
  const grid = $('[data-role=icon-grid]');
  const cats = $('[data-role=icon-cats]');
  const search = $('[data-role=icon-search]');
  const clear = $('[data-role=icon-clear]');
  const hint = $('[data-role=icon-hint]');
  const iconHost = $('[data-role=icon-host]');

  let query = '';
  /** 当前浏览的分组；空串 = 全部 */
  let cat = '';

  const tile = (it) => {
    const on = it.name === cfg.value();
    return `
      <button class="icon-grid__item${on ? ' is-on' : ''}" type="button" role="radio"
              aria-checked="${on}" data-icon="${esc(it.name)}" title="${esc(it.cn)}">
        ${it.name ? lucide(it.name, 18) : lucide('circle-dashed', 18)}
      </button>`;
  };

  const paintCats = () => {
    cats.innerHTML = ICON_GROUPS.map(
      (g) => `
      <button class="icon-cat" type="button" role="tab"
              aria-selected="${cat === g.key}" data-cat="${esc(g.key)}">${esc(g.label)}</button>`,
    ).join('');
    cats.querySelectorAll('[data-cat]').forEach((btn) =>
      btn.addEventListener('click', () => {
        cat = btn.dataset.cat;
        paintPanel();
      }),
    );
  };

  const paintGrid = () => {
    const q = query.trim().toLowerCase();
    let list = ICON_FLAT;
    if (q) {
      // 搜索时无视分组：用户已经知道要找什么，再按组翻一遍是倒退
      list = list.filter(
        (i) =>
          i.cn.includes(q) || i.name.includes(q) || i.kw.toLowerCase().includes(q),
      );
    } else if (cat) {
      list = list.filter((i) => i.group === cat);
    }
    grid.innerHTML = list.length
      ? list.map(tile).join('')
      : '<p class="mega__empty">没有匹配的图标</p>';
    grid.querySelectorAll('[data-icon]').forEach((el) =>
      el.addEventListener('click', () => {
        cfg.onPick(el.dataset.icon);
      }),
    );
    hint.textContent = q
      ? `命中 ${list.length} 个`
      : cat
        ? `${ICON_GROUPS.find((g) => g.key === cat).label} · ${list.length} 个`
        : `共 ${ICON_FLAT.length} 个图标`;
  };

  const paintPanel = () => {
    paintCats();
    paintGrid();
  };

  const paintTrigger = () => {
    const v = cfg.value();
    const preview = $('[data-role=icon-preview]');
    if (preview) preview.innerHTML = v ? lucide(v, 18) : lucide('circle-dashed', 18);
    const text = $('[data-role=icon-text]');
    if (text) text.textContent = v ? iconNameOf(v) : '不指定';
    trigger.classList.toggle('is-empty', !v);
  };

  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    iconHost.classList.remove('is-open');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onEsc);
  };

  const open = () => {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    iconHost.classList.add('is-open');
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onEsc);
  };

  /** 弹层外的点击：与记账页三级面板同一套收起手感 */
  function onDocClick(e) {
    if (!iconHost.contains(e.target)) close();
  }
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }

  trigger.addEventListener('click', () => {
    if (panel.hidden) {
      /**
       * 打开前把搜索词与分组复位：上一次「搜了没选」的中间态留到下一次，
       * 用户打开看到的是一个被过滤过的库，而触发器上写的还是原图标。
       */
      query = '';
      cat = '';
      if (search) search.value = '';
      open();
      paintPanel();
    } else {
      close();
    }
  });

  if (search) {
    search.addEventListener('input', (e) => {
      query = e.target.value ?? '';
      paintGrid();
    });
  }

  if (clear) {
    clear.addEventListener('click', () => {
      cfg.onPick('');
    });
  }

  const paintClear = () => {
    if (clear) clear.hidden = !cfg.value();
  };

  const paint = () => {
    paintTrigger();
    paintClear();
  };

  paint();

  return {
    /** 重画触发器与「清除」按钮的可用性 */
    paint,
    /** 弹层开着且外部值变了时重画弹层 */
    paintPanel,
    close,
    get isOpen() {
      return !panel.hidden;
    },
  };
}
