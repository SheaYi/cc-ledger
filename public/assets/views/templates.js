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

  function openForm(tpl = null) {
    const p = tpl?.payload ?? {};
    const rt = tpl ? (p.recordType ?? 'expense') : 'expense';
    const dir = p.direction ?? DEFAULT_DIRECTION[rt];

    const catOptions = (t, selected) => {
      const list = flatCats(t);
      if (!list.length) return '<option value="">该类型下还没有分类</option>';
      return (
        '<option value="">不选分类</option>' +
        list
          .map(
            (c) =>
              `<option value="${esc(c.id)}"${selected === c.id ? ' selected' : ''}>${esc(
                `${c.parentName} › ${c.name}`,
              )}</option>`,
          )
          .join('')
      );
    };

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

    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <div class="row row--between row--wrap">
            <p class="tt-body-strong">${tpl ? `编辑模板「${esc(tpl.name)}」` : '新建模板'}</p>
            <span class="tt-fine-print">最多 20 字，同一账本内不可重名</span>
          </div>

          <div class="field-row">
            <div class="field" data-field="name">
              <label class="field__label" for="tpl-name">模板名</label>
              <input class="input" id="tpl-name" name="name" maxlength="20"
                     value="${esc(tpl?.name ?? '')}" placeholder="例如：楼下便利店" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="icon">
              <label class="field__label" for="tpl-icon">图标</label>
              <select class="input select" id="tpl-icon" name="icon">
                ${ICON_CHOICES.map(
                  (n) =>
                    `<option value="${n}"${(tpl?.icon ?? '') === n ? ' selected' : ''}>${
                      n ? n : '（无图标）'
                    }</option>`,
                ).join('')}
              </select>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="recordType">
              <label class="field__label" for="tpl-rt">记录类型</label>
              <select class="input select" id="tpl-rt" name="recordType">
                ${TEMPLATABLE_TYPES.map(
                  (t) =>
                    `<option value="${t}"${rt === t ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="field" data-field="direction" data-role="dir-field">
              <label class="field__label" for="tpl-dir">阶段</label>
              <select class="input select" id="tpl-dir" name="direction"></select>
            </div>
            <div class="field" data-field="defaultAmount">
              <label class="field__label" for="tpl-amt">金额建议值（元）</label>
              <input class="input" id="tpl-amt" name="defaultAmount" inputmode="decimal"
                     value="${esc(p.defaultAmount && p.defaultAmount !== '0.00' ? p.defaultAmount : '')}"
                     placeholder="可留空" data-money />
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="accountId">
              <label class="field__label" for="tpl-acc">账户</label>
              <select class="input select" id="tpl-acc" name="accountId">${accOptions(
                p.accountId ?? null,
              )}</select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="toAccountId" data-role="to-field" ${rt === 'transfer' ? '' : 'hidden'}>
              <label class="field__label" for="tpl-to">转入账户</label>
              <select class="input select" id="tpl-to" name="toAccountId">${accOptions(
                p.toAccountId ?? null,
              )}</select>
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field" data-field="categoryId">
            <label class="field__label" for="tpl-cat">分类</label>
            <select class="input select" id="tpl-cat" name="categoryId">${catOptions(rt, p.categoryId ?? null)}</select>
            <span class="field__error"></span>
          </div>

          <div class="field-row">
            <div class="field" data-field="name2">
              <label class="field__label" for="tpl-tname">账单名称</label>
              <input class="input" id="tpl-tname" name="txName" maxlength="50"
                     value="${esc(p.name ?? '')}" placeholder="例如：便利店" />
            </div>
            <div class="field" data-field="merchant">
              <label class="field__label" for="tpl-merchant">商家</label>
              <input class="input" id="tpl-merchant" name="merchant" maxlength="50"
                     value="${esc(p.merchant ?? '')}" />
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="counterparty">
              <label class="field__label" for="tpl-cp">对象</label>
              <input class="input" id="tpl-cp" name="counterparty" maxlength="50"
                     value="${esc(p.counterparty ?? '')}" placeholder="转账 / 应收应付时用" />
            </div>
            <div class="field" data-field="fee">
              <label class="field__label" for="tpl-fee">手续费（元）</label>
              <input class="input" id="tpl-fee" name="fee" inputmode="decimal"
                     value="${esc(p.fee && p.fee !== '0.00' ? p.fee : '')}" placeholder="一般留空" data-money />
            </div>
          </div>

          <div class="field" data-field="note">
            <label class="field__label" for="tpl-note">备注</label>
            <input class="input" id="tpl-note" name="note" maxlength="500"
                   value="${esc(p.note ?? '')}" />
          </div>

          <div>
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
          </div>

          <div class="row">
            <button class="btn btn--sm" type="submit">${tpl ? '保存' : '创建'}</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          </div>
        </form>
      </div>
    `);

    const rtSel = form.querySelector('[name=recordType]');
    const dirSel = form.querySelector('[name=direction]');
    const catSel = form.querySelector('[name=categoryId]');
    const toField = form.querySelector('[data-role=to-field]');
    const dirField = form.querySelector('[data-role=dir-field]');

    /** 类型变了：阶段选项、分类候选、转账户显隐都要跟着换（别用旧的残留值提交） */
    const syncType = () => {
      const prev = rtSel.dataset.lastType ?? rt;
      const t = rtSel.value;
      rtSel.dataset.lastType = t;
      const dirs = DIRECTION_BY_RECORD_TYPE[t] ?? [];
      dirSel.innerHTML = dirs
        .map((d) => {
          const label = DIRECTION_STAGE_LABEL[t]?.[d] ?? d;
          return `<option value="${d}"${d === DEFAULT_DIRECTION[t] ? ' selected' : ''}>${esc(label)}</option>`;
        })
        .join('');
      dirField.hidden = dirs.length <= 1;
      toField.hidden = t !== 'transfer';
      const keep = catSel.value;
      catSel.innerHTML = catOptions(t, keep);
      if (catSel.value !== keep) catSel.value = '';
      /**
       * 图标跟着类型走 —— 但**只改「还没自己选过」的那次**：
       * 用户手动挑的图标在切类型时不该被覆盖（判断依据 = 当前值还是上一次的语义图标或空）。
       */
      const iconSel = form.querySelector('[name=icon]');
      if (iconSel.value === '' || iconSel.value === TYPE_ICON[prev]) {
        iconSel.value = TYPE_ICON[t] ?? '';
      }
    };
    rtSel.addEventListener('change', syncType);
    syncType();

    form.querySelectorAll('[data-tag]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-checked') === 'true';
        chip.setAttribute('aria-checked', String(!on));
      }),
    );

    form.querySelector('[data-role=cancel]').addEventListener('click', () => {
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
        icon: f.icon.value || null,
        payload: {
          recordType: rtSel.value,
          direction: dirSel.value || DEFAULT_DIRECTION[rtSel.value],
          accountId: f.accountId.value || null,
          toAccountId: rtSel.value === 'transfer' ? f.toAccountId.value || null : null,
          categoryId: catSel.value || null,
          name: f.txName.value.trim() || null,
          merchant: f.merchant.value.trim() || null,
          counterparty: f.counterparty.value.trim() || null,
          note: f.note.value.trim() || null,
          fee: parseAmountToCents(f.fee.value) ?? 0,
          discount: 0,
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