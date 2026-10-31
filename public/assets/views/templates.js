/**
 * 模板管理（`docs/05 §10.3` 的「手动创建：在模板管理页从空白开始配」，
 * 以及 §10.6 的「模板可锁定置顶」「预置模板可编辑也可删除」）。
 *
 * ## 为什么这个页面的表单用**原生控件**，不复用记账页的 Mega Menu
 *
 * 记账页的类型/分类选择器是给**高频录入**做的：三列联动、搜索、建议条、时段推荐 ——
 * 一切为了少点一次。模板配置是**低频**动作，一天可能一次，两年可能十次。
 * 为它复用那套浮层只会带来两个后果：多一堆分支要维护，以及在管理场景里
 * 「快速」这个卖点毫无价值。这里用 select + chip，快且稳。
 *
 * ## 排序不用拖拽，用上移 / 下移
 *
 * 拖拽在移动端要和纵向滚动抢手势（`docs/09 §3.4` 已经为左滑手势踩过一轮），
 * 而 `reorder` 接口本来就是「传全量 id 数组按序写 sort_order」，
 * 上移/下移 = 交换相邻两项在数组里的位置，一行代码的事。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { esc, h, icon, lucide, money, setLoading, toast, applyFieldErrors } from '../ui.js';
import {
  DEFAULT_DIRECTION,
  DIRECTION_BY_RECORD_TYPE,
  DIRECTION_STAGE_LABEL,
  RECORD_TYPES,
  parseAmountToCents,
} from '../lib/amounts.js';
import { TYPE_ICON } from '../lib/tx-format.js';
/** 类型 + 分类的三级面板：与记账页**同一个模块**，两边不再各画一套 */
import { createTypeCatPicker, pickTriggerHtml } from '../lib/type-cat-picker.js';

const TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  receivable: '应收款项',
  payable: '应付款项',
  adjustment: '余额调整',
};
/** 余额调整不能做模板（它只由对账生成，docs/05 §9.5） */
const TEMPLATABLE_TYPES = RECORD_TYPES.filter((t) => t !== 'adjustment');

/** 模板图标候选项：从记账页已在用的语义图标里挑（生成集里都有，见 gen-lucide 的 UI_ICONS） */
const ICON_CHOICES = [
  '', 'receipt', 'banknote', 'arrow-left-right', 'hand-coins', 'heart-handshake',
  'utensils', 'coffee', 'croissant', 'tram-front', 'car-taxi-front', 'fuel',
  'shopping-basket', 'package', 'house', 'lightbulb', 'stethoscope', 'graduation-cap',
];

export async function renderTemplates(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  const [tplRes, accRes, grpRes, catRes, tagRes] = await Promise.all([
    Api.listTemplates(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id).then((r) => r.data),
    Api.listCategories(ledger.id).then((r) => r.data),
    Api.listTags(ledger.id).then((r) => r.data),
  ]);

  let list = tplRes;
  const accounts = accRes.filter((a) => a.kind !== 'virtual');
  const groups = grpRes.filter((g) => !g.archivedAt);
  const tags = tagRes.filter((t) => !t.archivedAt);

  const frame = appFrame({
    active: 'templates',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">模板</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 把重复的录入固化下来，长按「记一笔」一键预填
            </p>
          </div>
          <button class="btn btn--sm" type="button" data-action="add">新建模板</button>
        </div>
      </div>

      <div data-role="form-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'templates', go, ledger });

  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');

  /* ---------------- 渲染 ---------------- */

  const warningOf = (tpl) => (tpl.warnings ?? []).find((w) => w.level === 'error') ?? null;

  function rowHtml(tpl, index, groupStart, groupEnd) {
    const p = tpl.payload ?? {};
    const sub = [p.accountName, p.categoryName].filter(Boolean).join(' › ') || '未指定账户与分类';
    const warn = warningOf(tpl);
    const amount = Number(p.defaultAmount ?? 0) > 0 ? money(String(p.defaultAmount)) : null;
    const marks = [
      tpl.isDefault ? '<span class="badge">预置</span>' : '',
      tpl.pinned ? '<span class="tplm-row__pin">置顶</span>' : '',
      warn ? `<span class="tplm-row__warn" title="${esc(warn.message)}">${lucide('triangle-alert', 13)}</span>` : '',
    ].join('');
    return `
      <div class="tplm-row${tpl.pinned ? ' is-pinned' : ''}" data-tpl="${esc(tpl.id)}">
        <span class="tplm-row__icon">${tpl.icon ? lucide(tpl.icon, 18) : lucide('receipt', 18)}</span>
        <span class="tplm-row__main">
          <span class="tt-body-strong">${esc(tpl.name)}${marks}</span>
          <span class="tt-fine-print">
            ${esc(sub)}${amount ? ` · 建议 ${esc(amount)}` : ''} · 用过 ${tpl.useCount} 次
          </span>
        </span>
        <span class="tplm-row__acts">
          <button class="btn btn--quiet btn--sm" type="button" data-act="pin"
                  aria-pressed="${tpl.pinned}" title="${tpl.pinned ? '取消置顶' : '置顶'}">
            ${tpl.pinned ? '取消置顶' : '置顶'}
          </button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="up" ${index <= groupStart ? 'disabled' : ''}
                  aria-label="上移" title="上移">${icon('arrow-up', 15)}</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="down" ${index >= groupEnd ? 'disabled' : ''}
                  aria-label="下移" title="下移">${icon('chevron-down', 15)}</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="edit">编辑</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="del">删除</button>
        </span>
      </div>`;
  }

  function render() {
    /**
     * 列表按「锁定 / 未锁定」分成两组渲染，因为服务端排序就是
     * `pinned DESC, use_count DESC, ...` —— 组之间不可移动（置顶项天生在前）。
     * 上移/下移的可用性因此按**组内位置**算。
     */
    const pinned = list.filter((t) => t.pinned);
    const loose = list.filter((t) => !t.pinned);
    const rows = [];
    if (pinned.length) {
      rows.push('<p class="tplm-group">已置顶</p>');
      pinned.forEach((t, i) => rows.push(rowHtml(t, i, 0, pinned.length - 1)));
    }
    if (loose.length) {
      // 分组标题只作分组用 —— 数量已经在上面的 .list-meta 里说过了，别重复一遍
      rows.push(`<p class="tplm-group">${pinned.length ? '其余' : '全部模板'}</p>`);
      loose.forEach((t, i) => rows.push(rowHtml(t, i, 0, loose.length - 1)));
    }

    listSlot.innerHTML = `
      <div class="list-meta">
        <span class="tt-fine-print">共 ${list.length} 个模板</span>
        <span class="tt-fine-print">长按「记一笔」即可选模板；金额只是建议值</span>
      </div>
      ${
        list.length === 0
          ? `<div class="card empty-state">
               <span class="empty-state__icon">${lucide('copy', 22)}</span>
               <p class="tt-body-strong">还没有模板</p>
               <p class="tt-caption text-muted">
                 记完一笔后在详情页点「存为模板」，或点右上角从空白开始配一个
               </p>
             </div>`
          : `<div class="tplm-list">${rows.join('')}</div>`
      }
    `;

    listSlot.querySelectorAll('.tplm-row [data-act]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-tpl]').dataset.tpl;
        const act = btn.dataset.act;
        if (act === 'edit') openForm(list.find((t) => t.id === id));
        else if (act === 'del') removeTpl(id);
        else if (act === 'pin') togglePin(id);
        else move(id, act === 'up' ? -1 : 1);
      }),
    );
  }

  /* ---------------- 动作 ---------------- */

  const reload = async () => {
    list = (await Api.listTemplates(ledger.id)).data;
    render();
  };

  async function togglePin(id) {
    const tpl = list.find((t) => t.id === id);
    try {
      await Api.updateTemplate(ledger.id, id, { pinned: !tpl.pinned });
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /**
   * 上移 / 下移：只在**同一置顶分组内**交换相邻两项。
   * 服务端 `reorder` 收的是全量 id 数组，所以这里重排后整份传回去。
   */
  async function move(id, delta) {
    const group = list.filter((t) => !!t.pinned === !!list.find((x) => x.id === id).pinned);
    const at = group.findIndex((t) => t.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= group.length) return;
    const swapped = [...group];
    [swapped[at], swapped[to]] = [swapped[to], swapped[at]];
    const ids = swapped.map((t) => t.id);
    // 把分组内的顺序贴回全量列表，再整份提交
    let cursor = 0;
    const next = list.map((t) => (ids.includes(t.id) ? ids[cursor++] : t.id));
    try {
      await Api.reorderTemplates(ledger.id, next);
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeTpl(id) {
    const tpl = list.find((t) => t.id === id);
    if (!window.confirm(`删除模板「${tpl.name}」？\n\n已记的账单不受影响。`)) return;
    try {
      await Api.deleteTemplate(ledger.id, id);
      await reload();
      toast('模板已删除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 表单 ---------------- */

  const flatCats = (t) => {
    const out = [];
    for (const p of catRes) {
      if (p.recordType !== t) continue;
      for (const c of p.children ?? []) {
        if (!c.archivedAt) out.push({ ...c, parentName: p.name, parentId: p.id });
      }
    }
    return out.sort((a, b) => (a.txCount ?? 0) > (b.txCount ?? 0) ? -1 : 1);
  };

  /**
   * 模板表单。
   *
   * ## 为什么整体改写成「记账页那一套」
   *
   * 模板的字段就是一笔账单的字段（类型 / 分类 / 账户 / 金额 / 商家 / 备注 ……），
   * 早先这里用一套更朴素的原生控件自己画了一遍，理由是「配置是低频动作」。
   * 代价是用户得学两套操作：在记账页学会的三级选择器，到了模板页变成两个下拉；
   * 而且模板**直接喂给**记账表单（长按「记一笔」一键预填），
   * 两边不一致时，「预填出来的东西和我平时记的不一样」会被当成 bug。
   * 所以现在：类型与分类用**同一个三级面板**（lib/type-cat-picker.js），
   * 其余字段沿用记账页的 `.field-row` / `.field` 语法，宽度也跟着 `.compose`（720px）。
   *
   * 唯一的区别是**没有附件卡**：模板固化的是「怎么记」，凭证是每次记账时才有的东西。
   */
  function openForm(tpl = null) {
    const p = tpl?.payload ?? {};
    let curType = tpl ? (p.recordType ?? 'expense') : 'expense';
    let curCat = p.categoryId ?? null;
    let curDir = p.direction ?? DEFAULT_DIRECTION[curType];
    /** 图标：没指定就跟着类型走（与记账页同一套语义图标） */
    let curIcon = tpl?.icon ?? TYPE_ICON[curType] ?? '';

    const accOptions = (selected, includeEmpty = true) =>
      (includeEmpty ? '<option value="">不指定</option>' : '') +
      groups
        .map((g) => {
          const inGroup = accounts.filter((a) => a.groupId === g.id && !a.archivedAt);
          if (!inGroup.length) return '';
          return `<optgroup label="${esc(g.name)}">${inGroup
            .map(
              (a) =>
                `<option value="${esc(a.id)}"${selected === a.id ? ' selected' : ''}>${esc(a.name)}</option>`,
            )
            .join('')}</optgroup>`;
        })
        .join('');

    /** 一级分类树（已过滤归档；只有带未归档子类的支才列出） */
    const catTrees = (t) =>
      catRes.filter(
        (x) =>
          x.recordType === t &&
          !x.archivedAt &&
          (x.children ?? []).some((c) => !c.archivedAt),
      );

    const form = h(`
      <div class="tpl-form compose">
        <section class="card compose__card">
          <form novalidate class="stack stack--md">
            <div class="compose__block">
              <div class="compose__block-head">
                <span class="tt-body-strong">${tpl ? `编辑模板「${esc(tpl.name)}」` : '新建模板'}</span>
                <span class="tt-fine-print">最多 20 字，同一账本内不可重名</span>
              </div>

              <div class="field-row">
                <div class="field field--wide" data-field="name">
                  <label class="field__label" for="tpl-name">模板名</label>
                  <input class="input" id="tpl-name" name="name" maxlength="20"
                         value="${esc(tpl?.name ?? '')}" placeholder="例如：楼下便利店" />
                  <span class="field__error"></span>
                </div>
                <div class="field" data-field="icon">
                  <span class="field__label" id="tpl-icon-label">图标</span>
                  <div class="icon-pick" data-role="icon-pick" role="radiogroup" aria-labelledby="tpl-icon-label"></div>
                  <input type="hidden" name="icon" value="${esc(curIcon)}" />
                  <span class="field__error"></span>
                </div>
              </div>
            </div>

            <div class="compose__block">
              <!--
                类型与分类 = 记账页那个三级面板（同一个模块产出同一份标记）。
                原来这里是「记录类型」下拉 + 「分类」下拉两个控件，
                与记账页的合并入口不一致：在记账页一次能点完的事，这里要开两个下拉。
              -->
              <div class="field" data-field="recordType">
                ${pickTriggerHtml({ labelId: 'tpl-pick-label', label: '类型与分类' })}
              </div>

              <div class="field" data-field="direction" data-role="dir-field" hidden>
                <span class="field__label" id="tpl-dir-label">收付方向</span>
                <div class="segmented" role="radiogroup" aria-labelledby="tpl-dir-label"
                     data-role="dir-seg"></div>
              </div>
            </div>

            <div class="compose__block">
              <div class="field-row field-row--money">
                <div class="field" data-field="accountId">
                  <label class="field__label" for="tpl-acc">账户</label>
                  <select class="input select" id="tpl-acc" name="accountId">${accOptions(
                    p.accountId ?? null,
                  )}</select>
                  <span class="field__error"></span>
                </div>
                <div class="field amount-field" data-field="defaultAmount">
                  <label class="field__label" for="tpl-amt">金额建议值</label>
                  <input class="input" id="tpl-amt" name="defaultAmount" inputmode="decimal"
                         value="${esc(p.defaultAmount && p.defaultAmount !== '0.00' ? p.defaultAmount : '')}"
                         placeholder="可留空" data-money />
                  <span class="tt-fine-print">只是建议值，记账时仍可改</span>
                  <span class="field__error"></span>
                </div>
              </div>

              <div class="field" data-field="toAccountId" data-role="to-field" hidden>
                <label class="field__label" for="tpl-to">转入账户</label>
                <select class="input select" id="tpl-to" name="toAccountId">${accOptions(
                  p.toAccountId ?? null,
                )}</select>
                <span class="field__error"></span>
              </div>

              <div class="field-row field-row--fee">
                <div class="field" data-field="fee">
                  <label class="field__label" for="tpl-fee">手续费</label>
                  <input class="input" id="tpl-fee" name="fee" inputmode="decimal"
                         value="${esc(p.fee && p.fee !== '0.00' ? p.fee : '')}" placeholder="一般留空" data-money />
                  <span class="field__error"></span>
                </div>
                <div class="field" data-field="discount">
                  <label class="field__label" for="tpl-discount">折扣</label>
                  <input class="input" id="tpl-discount" name="discount" inputmode="decimal"
                         value="${esc(p.discount && p.discount !== '0.00' ? p.discount : '')}" placeholder="一般留空" data-money />
                  <span class="field__error"></span>
                </div>
              </div>
            </div>

            <div class="compose__block">
              <div class="field-row field-row--named">
                <div class="field field--wide" data-field="txName">
                  <label class="field__label" for="tpl-tname">账单名称</label>
                  <input class="input" id="tpl-tname" name="txName" maxlength="50"
                         value="${esc(p.name ?? '')}" placeholder="例如：便利店" />
                  <span class="field__error"></span>
                </div>
                <div class="field" data-field="merchant">
                  <label class="field__label" for="tpl-merchant">商家</label>
                  <input class="input" id="tpl-merchant" name="merchant" maxlength="50"
                         value="${esc(p.merchant ?? '')}" />
                  <span class="field__error"></span>
                </div>
              </div>

              <div class="field-row">
                <div class="field" data-field="counterparty">
                  <label class="field__label" for="tpl-cp">对象</label>
                  <input class="input" id="tpl-cp" name="counterparty" maxlength="50"
                         value="${esc(p.counterparty ?? '')}" placeholder="转账 / 应收应付时用" />
                  <span class="field__error"></span>
                </div>
                <div class="field field--wide" data-field="note">
                  <label class="field__label" for="tpl-note">备注</label>
                  <input class="input" id="tpl-note" name="note" maxlength="500"
                         value="${esc(p.note ?? '')}" />
                  <span class="field__error"></span>
                </div>
              </div>

              <div class="field" data-field="tagIds">
                <span class="field__label">标签</span>
                <div class="cat-pick__row" data-role="tag-row">
                  ${
                    tags.length
                      ? tags
                          .map(
                            (t) => `
                    <button class="option-chip" type="button" role="checkbox" data-tag="${esc(t.id)}"
                            aria-checked="${(p.tagIds ?? []).includes(t.id)}">
                      <span class="option-chip__dot" style="--tag-color:${esc(t.color ?? '')}"></span>
                      <span>${esc(t.name)}</span>
                    </button>`,
                          )
                          .join('')
                      : '<span class="tt-fine-print">这个账本还没有标签</span>'
                  }
                </div>
                <span class="field__error"></span>
              </div>
            </div>

            <div class="row">
              <button class="btn btn--sm" type="submit">${tpl ? '保存' : '创建'}</button>
              <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
            </div>
          </form>
        </section>
      </div>
    `);

    const toField = form.querySelector('[data-role=to-field]');
    const dirField = form.querySelector('[data-role=dir-field]');
    const dirSeg = form.querySelector('[data-role=dir-seg]');
    const iconPick = form.querySelector('[data-role=icon-pick]');
    const iconInput = form.querySelector('[name=icon]');

    /* ---------------- 图标：可视化选择 ---------------- */

    /**
     * 图标原来是 `<select>`，option 的文案就是图标名（coffee / tram-front），
     * 于是用户看到的是一排看不懂的英文 —— 图标列表页里它等于不存在。
     * 现在画成图标网格：每一格就是它自己，选中的带强调描边。
     * 除图标外保留一个「无」：模板可以不指定图标（列表里回落到票据图标）。
     */
    const paintIcons = () => {
      iconPick.innerHTML =
        `<button class="icon-pick__item icon-pick__item--none" type="button" role="radio"
                 data-icon="" aria-checked="${curIcon === ''}" title="不指定图标">无</button>` +
        ICON_CHOICES.filter(Boolean)
          .map(
            (n) => `
          <button class="icon-pick__item" type="button" role="radio" data-icon="${esc(n)}"
                  aria-checked="${curIcon === n}" title="${esc(n)}" aria-label="${esc(n)}">
            ${lucide(n, 18)}
          </button>`,
          )
          .join('');
      iconPick.querySelectorAll('[data-icon]').forEach((btn) =>
        btn.addEventListener('click', () => {
          curIcon = btn.dataset.icon;
          iconInput.value = curIcon;
          paintIcons();
        }),
      );
    };

    /* ---------------- 收付方向：与记账页同为分段控件 ---------------- */

    const paintDirection = () => {
      const choices = DIRECTION_BY_RECORD_TYPE[curType] ?? [];
      dirField.hidden = choices.length <= 1;
      if (choices.length <= 1) {
        curDir = choices[0] ?? DEFAULT_DIRECTION[curType];
        dirSeg.innerHTML = '';
        return;
      }
      if (!choices.includes(curDir)) curDir = DEFAULT_DIRECTION[curType];
      dirSeg.innerHTML = choices
        .map(
          (d) => `
        <button class="segmented__item" type="button" role="radio" data-dir="${esc(d)}"
                aria-checked="${curDir === d}">
          ${esc(DIRECTION_STAGE_LABEL[curType]?.[d] ?? d)}
        </button>`,
        )
        .join('');
      dirSeg.querySelectorAll('[data-dir]').forEach((btn) =>
        btn.addEventListener('click', () => {
          curDir = btn.dataset.dir;
          paintDirection();
        }),
      );
    };

    /* ---------------- 类型与分类：记账页那个三级面板 ---------------- */

    const picker = createTypeCatPicker({
      host: form.querySelector('[data-field=recordType]'),
      types: TEMPLATABLE_TYPES,
      treesOf: catTrees,
      flatCats,
      value: () => ({ recordType: curType, categoryId: curCat }),
      /**
       * 副值：选了分类就写「类型 · 一级分类」，没选就给该类型的一句话解释。
       * 与记账页同一口径（那边多带一个阶段，模板的阶段由下面的分段控件单独呈现）。
       */
      subLabel: (meta) => {
        const c = curCat ? flatCats(curType).find((x) => x.id === curCat) : null;
        return c ? [meta.label, c.parentName].filter(Boolean).join(' · ') : meta.hint;
      },
      onPick: (type, categoryId) => {
        const prevIcon = TYPE_ICON[curType] ?? '';
        curType = type;
        curCat = categoryId ?? null;
        /**
         * 图标跟着类型走，但**只改「还没自己选过」的那次**（沿用旧逻辑）：
         * 用户手动挑过的图标在切类型时不该被覆盖 —— 判断依据是
         * 当前图标还等于上一个类型的语义图标，或等于空。
         */
        if (curIcon === '' || curIcon === prevIcon) {
          curIcon = TYPE_ICON[type] ?? '';
          iconInput.value = curIcon;
          paintIcons();
        }
        syncType();
        picker.paintTrigger();
        /**
         * 选完就收起 —— 与记账页同一手感（那边是 closePanels({ focus: true })）。
         * 少了这一步，面板会一直压在表单上，用户得再点一次触发器才知道选生效了。
         */
        closePick();
      },
    });

    const pickHost = form.querySelector('[data-role=pick-host]');
    const pickPanel = form.querySelector('[data-role=pick-panel]');
    const pickTrigger = form.querySelector('[data-role=pick-trigger]');
    let onDocClick = null;
    let onEsc = null;

    const closePick = () => {
      pickPanel.hidden = true;
      pickTrigger.setAttribute('aria-expanded', 'false');
      pickHost.classList.remove('is-open');
      if (onDocClick) document.removeEventListener('click', onDocClick);
      if (onEsc) document.removeEventListener('keydown', onEsc);
      onDocClick = null;
      onEsc = null;
    };

    pickTrigger.addEventListener('click', () => {
      if (!pickPanel.hidden) {
        closePick();
        return;
      }
      picker.resetDraft();
      pickPanel.hidden = false;
      pickTrigger.setAttribute('aria-expanded', 'true');
      pickHost.classList.add('is-open');
      picker.paintPanel();
      /** 点面板外 / Esc 收起 —— 与记账页同一套收起手感 */
      onDocClick = (e) => {
        if (!pickHost.contains(e.target)) closePick();
      };
      onEsc = (e) => {
        if (e.key === 'Escape') closePick();
      };
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onEsc);
    });
    form.querySelector('[data-role=cat-search]').addEventListener('input', (e) => {
      picker.setQuery(e.target.value);
      picker.paintPanel();
    });
    form.querySelector('[data-role=cat-clear]').addEventListener('click', () => {
      curCat = null;
      picker.paintTrigger();
      picker.paintPanel();
      closePick();
    });

    /** 类型变了：转账户显隐、方向候选都要跟着换（别把上一类型的残留值提交上去） */
    const syncType = () => {
      toField.hidden = curType !== 'transfer';
      paintDirection();
    };

    picker.paintTrigger();
    paintIcons();
    syncType();

    form.querySelectorAll('[data-tag]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-checked') === 'true';
        chip.setAttribute('aria-checked', String(!on));
      }),
    );

    form.querySelector('[data-role=cancel]').addEventListener('click', () => {
      closePick();
      formSlot.replaceChildren();
    });

    form.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = f.querySelector('button[type=submit]');
      const name = f.name.value.trim();
      if (!name) {
        f.name.focus();
        toast('模板名不能为空', 'error');
        return;
      }
      setLoading(submit, true, '保存中');
      const payload = {
        name,
        icon: iconInput.value || null,
        payload: {
          recordType: curType,
          direction: curDir || DEFAULT_DIRECTION[curType],
          accountId: f.accountId.value || null,
          toAccountId: curType === 'transfer' ? f.toAccountId.value || null : null,
          categoryId: curCat || null,
          name: f.txName.value.trim() || null,
          merchant: f.merchant.value.trim() || null,
          counterparty: f.counterparty.value.trim() || null,
          note: f.note.value.trim() || null,
          fee: parseAmountToCents(f.fee.value) ?? 0,
          /**
           * 折扣**以前是写死的 0**：后端 `templates` 的 payload schema 里明明有这一项，
           * 「再记一笔」的种子也照着读，只有这里的表单没给出口 ——
           * 于是「模板里配的折扣」永远填不进去，而用户看不出为什么会丢。
           */
          discount: parseAmountToCents(f.discount.value) ?? 0,
          defaultAmount: parseAmountToCents(f.defaultAmount.value) ?? 0,
          tagIds: [...form.querySelectorAll('[data-tag][aria-checked=true]')].map((c) => c.dataset.tag),
        },
      };
      try {
        if (tpl) {
          await Api.updateTemplate(ledger.id, tpl.id, payload);
          toast('模板已更新', 'success');
        } else {
          await Api.createTemplate(ledger.id, payload);
          toast(`模板「${name}」已创建`, 'success');
        }
        closePick();
        formSlot.replaceChildren();
        await reload();
      } catch (err) {
        setLoading(submit, false);
        // 字段级错误（VALIDATION_ERROR）逐条映射到对应输入框；
        // 重名（DUPLICATE_RESOURCE）没有字段详情，但**它就是「名称」的问题** ——
        // 与标签页同一套做法（那边也是直接往 name 的 .field__error 里写）。
        if (Array.isArray(err?.details) && err.details.length) {
          const map = Object.fromEntries(err.details.map((d) => [d.field, d.message]));
          if (applyFieldErrors(f, map)) toast('有字段填得不对', 'error');
          else toast(err.message, 'error');
        } else {
          const wrap = f.querySelector('[data-field=name] .field__error');
          if (wrap) wrap.textContent = err.message;
          toast(err.message, 'error');
        }
      }
    });

    formSlot.replaceChildren(form);
    form.querySelector('[name=name]').focus();
  }

  frame.querySelector('[data-action=add]').addEventListener('click', () => openForm(null));

  render();
  return null;
}