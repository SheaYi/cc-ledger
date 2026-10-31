/**
 * 类型 + 分类的**三级选择面板**（类型 → 一级分类 → 二级分类）。
 *
 * 为什么要抽成模块：`docs/13 §4.4` 改版二把这个选择器做成了 Mega Menu，
 * 起初只服务于记账页。模板页要「类型与分类合并成一个入口、点开与记账页同一个弹层」，
 * 于是它有了第二个调用方 —— 一旦复制一份，字段增删必然一边改一边漏，
 * 而「两边长得不一样」本身就是 bug（用户刚在记账页学会的操作，在模板页失灵）。
 *
 * 模块只管**面板这件事本身**：草稿态、三列渲染、搜索、选中回传。
 * 调用方通过 cfg 提供「有哪些类型」「分类树怎么取」「选中后交给谁」，
 * 谁也不替谁做业务决定。
 *
 * ⚠️ 全部 DOM 查询限定在传入的 host 内：这个面板在两个不同的页面里各渲染一次，
 * 用 document.querySelector 会跨页命中（先渲染的那份永远赢）。
 */
import { esc, lucide, icon } from '../ui.js';
import { TYPE_ICON } from './tx-format.js';

/**
 * 第一列的分组。
 *
 * 旧的「一级分段 [支出][收入][转账] + 更多 ▾」把 6 个类型切成两组，
 * 用户得先点「更多」才知道还有应收应付；而且分段控件只放得下两三个字，
 * 「应收款项」被压成「应收」，语义丢了。分组标题一次摊开，配合下面每项的
 * 一句话解释，比「先点更多再找」省一次点击。
 */
export const TYPE_GROUPS = [
  { label: '常用', types: ['expense', 'income', 'transfer'] },
  { label: '债权债务', types: ['receivable', 'payable'] },
];

/**
 * 每个类型的一句话解释。
 * 记账新手卡住的地方几乎都是「这笔到底动谁的钱」—— 一句大白话比标签管用。
 */
export const TYPE_META = {
  expense: { label: '支出', hint: '钱从账户花出去' },
  income: { label: '收入', hint: '钱进到账户里' },
  transfer: { label: '转账', hint: '账户之间挪钱' },
  receivable: { label: '应收款项', hint: '借出，或收回对方还的钱' },
  payable: { label: '应付款项', hint: '欠了钱，或把欠的还掉' },
};

/** 有分类的类型（= 除转账外全部；docs/03 §8.1 的 ✓ 项） */
export const TYPE_WITH_CATEGORY = new Set(['expense', 'income', 'receivable', 'payable']);

/** 需要用户选第二个账户的类型 */
export const TYPE_WITH_TO_ACCOUNT = new Set(['transfer']);

/**
 * 选择器的**外观**：一个触发按钮 + 一个面板。
 * 记账页与模板页共用这一份标记 —— 两处要的就是同一个控件。
 */
export function pickTriggerHtml({ labelId = 'pick-label', label = '类型与分类' } = {}) {
  return `
    ${label ? `<span class="field__label" id="${esc(labelId)}">${esc(label)}</span>` : ''}
    <div class="mega-host" data-role="pick-host">
      <button class="pick-trigger" type="button" data-role="pick-trigger"
              aria-haspopup="menu" aria-expanded="false" aria-labelledby="${esc(labelId)}">
        <span class="pick-trigger__icon" data-role="pick-icon"></span>
        <span class="pick-trigger__text">
          <span class="pick-trigger__label" data-role="pick-label"></span>
          <span class="pick-trigger__sub" data-role="pick-sub"></span>
        </span>
        <span class="pick-trigger__chev">${icon('chevron-down', 16)}</span>
      </button>

      <div class="mega mega--pick" data-role="pick-panel" role="menu"
           aria-labelledby="${esc(labelId)}" hidden>
        <!-- 建议：最近用过的二级分类（由调用方提供，无则不渲染这块） -->
        <div class="mega__suggest" data-role="suggest" hidden>
          <span class="mega__suggest-badge">${lucide('sparkles', 13)}<span>建议</span></span>
          <div class="mega__suggest-chips" data-role="suggest-chips"></div>
        </div>

        <div class="mega__head">
          <span class="mega__search-icon">${lucide('search', 15)}</span>
          <input class="mega__search" type="search" data-role="cat-search"
                 placeholder="搜索分类（跨全部类型）" autocomplete="off" enterkeyhint="search" />
        </div>

        <div class="mega__panes" data-role="panes">
          <div class="mega__col mega__col--type" data-role="col-type"></div>
          <div class="mega__col mega__col--parent" data-role="col-parent"></div>
          <div class="mega__col mega__col--leaf" data-role="col-leaf"></div>
        </div>

        <div class="mega__foot">
          <span class="mega__hint" data-role="pick-hint">分类记在子类别上，一级只是分组</span>
          <button class="mega__clear" type="button" data-role="cat-clear" hidden>清除分类</button>
        </div>
      </div>
    </div>`;
}

/**
 * 建一个选择器实例。
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.host   包着触发器与面板的那层容器（.mega-host 的父级）
 * @param {string[]} cfg.types    第一列要列出的类型（模板页不含「余额调整」）
 * @param {(t:string)=>Array} cfg.treesOf  某类型下的一级分类树（已过滤归档）
 * @param {(t:string)=>Array} cfg.flatCats 某类型下的二级分类扁平表
 * @param {()=>{recordType:string, categoryId:string|null}} cfg.value 当前值
 * @param {(type:string, categoryId:string|null)=>void} cfg.onPick 选完回调
 * @param {(meta:object, hasCat:boolean)=>string} [cfg.subLabel] 触发器副标题
 * @param {()=>Array} [cfg.suggestions] 面板顶部的「建议」条目
 * @param {()=>void} [cfg.onOpen]
 * @param {()=>void} [cfg.onClose]
 */
export function createTypeCatPicker(cfg) {
  const host = cfg.host;
  const $ = (sel) => host.querySelector(sel);

  const types = cfg.types;
  const groups = TYPE_GROUPS.map((g) => ({
    label: g.label,
    types: g.types.filter((t) => types.includes(t)),
  })).filter((g) => g.types.length);

  /**
   * 面板内的草稿：类型 + 当前展开的一级分类。
   *
   * 「点了类型但还没点分类」是一个**中间态**，它只活在这里、不回写调用方的状态。
   * 否则用户点开面板看一眼「应收款项」又关掉，记账表单里的类型就被悄悄改掉了；
   * 只有落到二级分类上（或选无分类的转账）才算一次完整选择。
   */
  const draft = { type: cfg.value().recordType, parentId: null };
  let query = '';

  /**
   * 二级分类 chip。
   *
   * `typeTag` 只在**搜索态跨类型**时出现（标明这个子类属于哪种类型）；
   * 常规级联态下不传 —— 那时左边第一列已经把类型写明白了，重复标一遍是噪声。
   */
  const catChip = (c, typeTag = null) => {
    const on = !typeTag && draft.type === cfg.value().recordType && c.id === cfg.value().categoryId;
    return `
      <button class="option-chip${typeTag ? ' option-chip--tagged' : ''}" type="button"
              role="menuitemradio" aria-checked="${on}"
              data-cat="${esc(c.id)}"${typeTag ? ` data-cat-type="${esc(typeTag)}"` : ''}
              title="${esc(`${c.parentName} › ${c.name}`)}">
        ${c.icon ? lucide(c.icon, 14) : ''}<span>${esc(c.name)}</span>
        ${typeTag ? `<span class="option-chip__type">${esc(TYPE_META[typeTag]?.label ?? '')}</span>` : ''}
      </button>`;
  };

  const treesOf = (t) => cfg.treesOf(t) ?? [];

  /** 把草稿对齐到当前值：每次展开面板都从「现在的选择」重新出发 */
  const resetDraft = () => {
    const v = cfg.value();
    draft.type = v.recordType;
    const trees = treesOf(v.recordType);
    /**
     * 重新打开面板时优先落在**当前选中分类所在的那支**上：
     * 用户的上一次选择就长在那根树枝上，打开却先停在别的支，等于要他重找一遍。
     * 没有选过（或那支已被归档）才退到第一支。
     */
    const cur = v.categoryId
      ? (cfg.flatCats(v.recordType) ?? []).find((c) => c.id === v.categoryId)
      : null;
    draft.parentId =
      (cur && trees.some((p) => p.id === cur.parentId) ? cur.parentId : null) ??
      trees[0]?.id ??
      null;
    query = '';
    const search = $('[data-role=cat-search]');
    if (search) search.value = '';
  };

  const paintTrigger = () => {
    const v = cfg.value();
    const meta = TYPE_META[v.recordType] ?? TYPE_META.expense;
    const cat = cfg.flatCats(v.recordType).find((c) => c.id === v.categoryId) ?? null;

    const iconSlot = $('[data-role=pick-icon]');
    if (iconSlot) {
      iconSlot.innerHTML = lucide(cat?.icon || TYPE_ICON[v.recordType] || 'tag', 18);
    }
    const label = $('[data-role=pick-label]');
    if (label) label.textContent = cat ? cat.name : meta.label;

    const sub = $('[data-role=pick-sub]');
    if (sub) {
      sub.textContent = cfg.subLabel
        ? cfg.subLabel(meta, Boolean(cat))
        : cat
          ? [meta.label, cat.parentName].filter(Boolean).join(' · ')
          : meta.hint;
    }
    const trigger = $('[data-role=pick-trigger]');
    if (trigger) {
      trigger.classList.toggle('is-empty', !cat && TYPE_WITH_CATEGORY.has(v.recordType));
    }
  };

  const paintSuggest = () => {
    const wrap = $('[data-role=suggest]');
    if (!wrap) return;
    const list = typeof cfg.suggestions === 'function' ? cfg.suggestions() : [];
    // 搜索态下建议让位：用户已经在主动找某个分类，再推「最近用过」只会碍事
    const show = list.length > 0 && !query.trim();
    wrap.hidden = !show;
    if (!show) return;
    $('[data-role=suggest-chips]').innerHTML = list
      .map(
        (c) => `
        <button class="suggest-chip" type="button" role="menuitem"
                data-sug="${esc(c.id)}" data-sug-type="${esc(c.recordType ?? 'expense')}"
                title="${esc(`${c.parentName} › ${c.name}`)}">
          <span class="suggest-chip__icon">${lucide(c.icon || 'tag', 14)}</span>
          <span class="suggest-chip__name">${esc(c.name)}</span>
        </button>`,
      )
      .join('');
    $('[data-role=suggest-chips]')
      .querySelectorAll('[data-sug]')
      .forEach((el) =>
        el.addEventListener('click', () => {
          cfg.onPick(el.dataset.sugType, el.dataset.sug);
        }),
      );
  };

  const paintPanel = () => {
    const panes = $('[data-role=panes]');
    const colType = $('[data-role=col-type]');
    const colParent = $('[data-role=col-parent]');
    const colLeaf = $('[data-role=col-leaf]');
    if (!panes || !colType || !colParent || !colLeaf) return;

    const clear = $('[data-role=cat-clear]');
    if (clear) clear.hidden = !cfg.value().categoryId;
    paintSuggest();

    /* ---- 搜索态：三列让位，整幅宽度交给命中结果（跨全部类型） ---- */
    const q = query.trim().toLowerCase();
    if (q) {
      panes.dataset.mode = 'search';
      colType.hidden = true;
      colParent.hidden = true;
      colLeaf.hidden = false;
      const hits = [];
      for (const t of types) {
        if (!TYPE_WITH_CATEGORY.has(t)) continue;
        for (const c of cfg.flatCats(t)) {
          if (c.name.toLowerCase().includes(q) || c.parentName.toLowerCase().includes(q)) {
            hits.push({ ...c, recordType: t });
          }
        }
      }
      hits.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
      colLeaf.innerHTML = hits.length
        ? `<p class="mega__col-title">命中 ${hits.length} 个</p>
           <div class="mega__grid">${hits.map((c) => catChip(c, c.recordType)).join('')}</div>`
        : `<p class="mega__empty">没有匹配的分类</p>`;
      colLeaf.querySelectorAll('[data-cat]').forEach((el) =>
        el.addEventListener('click', () => cfg.onPick(el.dataset.catType, el.dataset.cat)),
      );
      return;
    }

    colType.hidden = false;
    colParent.hidden = false;

    /* ---- 第一级：类型 ---- */
    colType.innerHTML = groups
      .map(
        (g) => `
      <div class="mega__group">
        <p class="mega__col-title">${esc(g.label)}</p>
        ${g.types
          .map((t) => {
            const m = TYPE_META[t];
            const on = t === draft.type;
            return `
            <button class="mega__item${on ? ' is-on' : ''}" type="button"
                    role="menuitemradio" aria-checked="${on}" data-type="${esc(t)}">
              <span class="mega__item-icon">${lucide(TYPE_ICON[t] ?? 'circle-help', 17)}</span>
              <span class="mega__item-text">
                <span class="mega__item-name">${esc(m.label)}</span>
                <span class="mega__item-hint">${esc(m.hint)}</span>
              </span>
              ${on ? `<span class="mega__item-mark">${lucide('check', 16)}</span>` : ''}
            </button>`;
          })
          .join('')}
      </div>`,
      )
      .join('');
    colType.querySelectorAll('[data-type]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const next = btn.dataset.type;
        // 无分类的类型（转账）：点到它本身就是「选完了」
        if (!TYPE_WITH_CATEGORY.has(next)) {
          cfg.onPick(next, null);
          return;
        }
        draft.type = next;
        draft.parentId = treesOf(next)[0]?.id ?? null;
        paintPanel();
      }),
    );

    /* ---- 转账：没有第二、三级，把剩下的宽度换成一句解释 ---- */
    if (!TYPE_WITH_CATEGORY.has(draft.type)) {
      panes.dataset.mode = 'leaf-less';
      colLeaf.hidden = true;
      colLeaf.innerHTML = '';
      colParent.innerHTML = `
        <p class="mega__col-title">分类</p>
        <p class="mega__empty">转账不记分类 —— 选好下面的「转入账户」就行。</p>`;
      return;
    }
    panes.dataset.mode = 'cascade';
    colLeaf.hidden = false;

    /* ---- 第二级：一级分类 ---- */
    const trees = treesOf(draft.type);
    // 分类被删空的类型：没有第二、三级可走，只留「只改类型」的出口
    if (!trees.length) {
      panes.dataset.mode = 'leaf-less';
      colLeaf.hidden = true;
      colLeaf.innerHTML = '';
      colParent.innerHTML = `
        <p class="mega__col-title">一级分类</p>
        <p class="mega__empty">该类型下还没有分类。</p>
        <button class="btn btn--quiet btn--sm" type="button" data-role="type-only">
          只用「${esc(TYPE_META[draft.type].label)}」，先不选分类
        </button>`;
      colParent
        .querySelector('[data-role=type-only]')
        ?.addEventListener('click', () => cfg.onPick(draft.type, null));
      return;
    }
    if (!trees.some((p) => p.id === draft.parentId)) {
      draft.parentId = trees[0]?.id ?? null;
    }
    colParent.innerHTML = `<p class="mega__col-title">一级分类</p>
         <div class="mega__list">${trees
           .map((p) => {
             const kids = (p.children ?? []).filter((c) => !c.archivedAt);
             const on = p.id === draft.parentId;
             // 该支下已有选中项 → 留一个点，收起面板后也知道「选在哪一支」
             const hasPick =
               draft.type === cfg.value().recordType &&
               kids.some((c) => c.id === cfg.value().categoryId);
             return `
             <button class="mega__navitem${on ? ' is-on' : ''}${hasPick ? ' has-pick' : ''}"
                     type="button" role="menuitem" aria-checked="${on}" data-parent="${esc(p.id)}">
               <span class="mega__navitem-icon">${p.icon ? lucide(p.icon, 16) : ''}</span>
               <span class="mega__navitem-name">${esc(p.name)}</span>
               <span class="mega__navitem-count">${kids.length}</span>
             </button>`;
           })
           .join('')}</div>`;
    colParent.querySelectorAll('[data-parent]').forEach((el) =>
      el.addEventListener('click', () => {
        draft.parentId = el.dataset.parent;
        paintPanel();
      }),
    );

    /* ---- 第三级：二级分类 ---- */
    const pane = trees.find((p) => p.id === draft.parentId);
    const kids = (pane?.children ?? [])
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        parentId: pane.id,
        parentName: pane.name,
        count: c.txCount ?? 0,
      }))
      // 频次优先：记账是重复动作，常用分类应该伸手就够得到（docs/05 §3.4）
      .sort((a, b) => b.count - a.count);
    colLeaf.innerHTML = pane
      ? `<p class="mega__col-title">${esc(pane.name)}</p>
         <div class="mega__grid">${kids.map((c) => catChip(c)).join('')}</div>`
      : `<p class="mega__empty">选一个一级分类</p>`;
    colLeaf.querySelectorAll('[data-cat]').forEach((el) =>
      el.addEventListener('click', () => cfg.onPick(draft.type, el.dataset.cat)),
    );
  };

  /**
   * 面板打开时把草稿对齐到当前值。
   * 不做这件事的话，上一次「只看没选」的中间态会留到下一次打开 ——
   * 用户看到的第一列停留在上次的「应收款项」，而表单里明明是支出。
   */
  const onOpen = () => {
    resetDraft();
    paintPanel();
  };

  return {
    /** 重画触发器（外部字段变了要调） */
    paintTrigger,
    /** 重画面板（外部值变了而面板开着时要调） */
    paintPanel,
    /** 面板打开前的准备 */
    resetDraft,
    onOpen,
    /** 面板内的搜索词变了 */
    setQuery(v) {
      query = v ?? '';
    },
    getQuery: () => query,
    /** 「清除分类」按钮 */
    hasClearButton: () => Boolean($('[data-role=cat-clear]')),
    draft,
  };
}
