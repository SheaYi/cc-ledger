/**
 * 预算（docs/16 五阶段闭环：编制 → 执行控制 → 预警 → 调整 → 差异分析与复盘）。
 *
 * 交互承载规范：所有二级功能只走弹窗、底部抽屉、下拉控件、气泡卡片、页面内折叠；
 * 占层浮层由 lib/overlay.js 统一管栈，最多两层，第二层只放危险确认。
 * 本页不再出现内联表单卡片，也不再用原生 confirm。
 *
 * 数据纪律：已用 U 一律由后端统一口径给出（正常减冲减、报销与转账不占预算），
 * 前端不做任何二次求和推导；除零与缺数据的字段按 03 规约显示破折号，不补 0。
 *
 * 与账单联动：切回页面、自定义数据变更事件、以及可见状态下的定时轮询，
 * 都只重绘当前阶段容器（局部刷新），不重建整页、不重置月份与维度。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { applyFieldErrors, esc, icon, lucide, money, monthLabel, setLoading, toast, todayStr } from '../ui.js';
import { parseAmountToCents } from '../lib/amounts.js';
import { budgetScopeTriggerHtml, createBudgetScopePicker } from '../lib/budget-scope-picker.js';
import {
  closeAllOverlays,
  collapseHtml,
  confirmAction,
  initCollapses,
  openDrawer,
  openPopover,
} from '../lib/overlay.js';

const STAGES = [
  { key: 'plan', label: '编制' },
  { key: 'control', label: '执行' },
  { key: 'alert', label: '预警' },
  { key: 'adjust', label: '调整' },
  { key: 'review', label: '复盘' },
];

const STAGE_HINT = {
  plan: '定类型、定方法、定周期，把每块钱安排到位置上',
  control: '预算额、已用、承诺占用、预留与真正还能花的可用额度',
  alert: '分级阈值、时间进度、大额消费、耗尽预测与超支后策略',
  adjust: '追加削减、调拨、结转、复制模板与周期归档，全部留痕',
  review: '预算与实际对照、差异归因、准确率与下期建议',
};

const KIND_LABEL = { expense: '支出', income: '收入', savings: '储蓄' };
const METHOD_LABEL = {
  zero_base: '零基预算', envelope: '信封法', ratio: '比例模板',
  historical: '历史推荐', elastic: '弹性预算',
};

/**
 * 五种编制方法的「打开」直达新建预算时预填的默认值。
 * 只碰表单里本来就存在的字段，不新增数据绑定；所有字段仍可逐项修改。
 * `note` 只是给抽屉顶部的一句说明，不参与提交。
 */
const METHOD_PRESETS = {
  zero_base: {
    note: '零基预算：从 0 起逐项论证，通常按分类各立一条，合计不超出总预算。',
    budgetMethod: 'zero_base', budgetKind: 'expense', categoryId: '',
    periodType: 'monthly', occupancyMode: 'full', alertRatio: 80,
  },
  envelope: {
    note: '信封法：先把总额分装到各分类，再按信封里的余额花钱。',
    budgetMethod: 'envelope', budgetKind: 'expense', categoryId: '',
    periodType: 'monthly', occupancyMode: 'full', alertRatio: 80,
  },
  ratio: {
    note: '比例模板：按收入减固定支出后的基数，套一套固定比例分配。',
    budgetMethod: 'ratio', budgetKind: 'expense', categoryId: '',
    periodType: 'monthly', occupancyMode: 'full', alertRatio: 90,
  },
  historical: {
    note: '历史推荐：用近几期实际支出的中位数作为本期额度起点。',
    budgetMethod: 'historical', budgetKind: 'expense', categoryId: '',
    periodType: 'monthly', occupancyMode: 'full', alertRatio: 90,
  },
  elastic: {
    note: '弹性预算：固定基数 + 收入浮动比例，额度随本期收入变化。',
    budgetMethod: 'elastic', budgetKind: 'expense', categoryId: '',
    periodType: 'monthly', occupancyMode: 'full', alertRatio: 80,
  },
};
const LEVEL_LABEL = { info: '提示', warning: '警告', danger: '严重' };
const POLICY_LABEL = {
  allow: '允许并标记超支', confirm: '二次确认后继续',
  block: '阻止保存', suggest_transfer: '建议从其他分类调拨',
};
const CHANNEL_LABEL = { in_app: '站内', banner: '横幅', digest: '汇总' };

const pad = (n) => String(n).padStart(2, '0');
const dash = '—';
/** 元字符串 / null 统一展示；后端 03 §10.4 的 null 是「不计算」，不是 0 */
const amt = (v) => (v === null || v === undefined || v === '' ? dash : money(v));
const pct = (v) => (v === null || v === undefined || v === '' ? dash : `${v}%`);
const num = (v) => Number(v ?? 0);
/** 预警分级配色：80/90 用 danger 弱化线，100 才用 danger 本体 */
function tierOf(ratio) {
  const r = num(ratio);
  if (r > 100) return 'is-over';
  if (r >= 90) return 'is-t3';
  if (r >= 80) return 'is-t2';
  return '';
}
function metric(label, value, sub = '', cls = '') {
  return `<div class="bdg2-metric">
    <span class="bdg2-metric__label">${esc(label)}</span>
    <span class="bdg2-metric__value ${cls}">${esc(value)}</span>
    ${sub ? `<span class="bdg2-metric__sub">${esc(sub)}</span>` : ''}
  </div>`;
}
function barHtml(ratio, timeProgress) {
  const r = Math.max(0, Math.min(100, num(ratio)));
  const t = Math.max(0, Math.min(100, num(timeProgress)));
  return `<div class="bdg2-bar" role="img" aria-label="执行率 ${esc(String(ratio))}%">
    <span class="bdg2-bar__fill ${tierOf(ratio)}" style="width:${r}%"></span>
    ${timeProgress !== undefined && timeProgress !== null
      ? `<span class="bdg2-bar__time" style="left:${t}%" title="时间进度 ${esc(String(t))}%"></span>`
      : ''}
  </div>`;
}
function emptyHtml(text, sub = '') {
  return `<div class="card empty-state">
    <span class="empty-state__icon">${lucide('target', 22)}</span>
    <p class="tt-body-strong">${esc(text)}</p>
    ${sub ? `<p class="tt-caption text-muted">${esc(sub)}</p>` : ''}
  </div>`;
}
function field(label, name, inputHtml, hint = '') {
  return `<div class="field" data-field="${esc(name)}">
    <label class="field__label" for="f-${esc(name)}">${esc(label)}</label>
    ${inputHtml}
    ${hint ? `<span class="bdg2-hint">${esc(hint)}</span>` : ''}
    <span class="field__error"></span>
  </div>`;
}

/**
 * 新建 / 编辑预算专用的一行：标签在左、控件在右，同一栅格列宽。
 * 与 `field()` 的区别只是排布 —— `data-field` / `.field__error` 全部保留，
 * `applyFieldErrors()` 与按 name 取值（`f.amount` 等）的行为完全不变。
 */
function formRow(label, name, inputHtml, hint = '') {
  return `<div class="bdg2-form__row" data-field="${esc(name)}">
    <label class="bdg2-form__label" for="f-${esc(name)}">${esc(label)}</label>
    <div class="bdg2-form__ctrl">
      ${inputHtml}
      ${hint ? `<span class="bdg2-hint">${esc(hint)}</span>` : ''}
      <span class="field__error"></span>
    </div>
  </div>`;
}

/** 打开一个带提交按钮的抽屉；统一处理 loading、字段级报错与取消 */
function drawerForm({ title, body, submitText = '保存', onSubmit, wide = false, onClose = null }) {
  const layer = openDrawer({
    title,
    wide,
    onClose,
    body: `<form novalidate class="stack stack--md">
      ${body}
      <div class="row row--sm row--wrap">
        <button class="btn btn--primary" type="submit">${esc(submitText)}</button>
        <button class="btn btn--quiet" type="button" data-role="cancel">取消</button>
      </div>
    </form>`,
  });
  if (!layer) return null;
  const form = layer.body.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    setLoading(btn, true, '处理中');
    try {
      await onSubmit(form, layer);
    } catch (err) {
      setLoading(btn, false);
      const map = err?.fieldErrors ?? Object.fromEntries((err?.details ?? []).map((d) => [d.field, d.message]));
      applyFieldErrors(form, map);
      /* 字段级错误已经落在输入框旁边时，不再叠一条通用 toast 抢注意力 */
      if (!Object.keys(map).length) toast(err?.message ?? '操作失败', 'error');
    }
  });
  form.querySelector('[data-role=cancel]').addEventListener('click', () => layer.close());
  return layer;
}

let activeCleanup = null;

export async function renderBudgets(container, { go } = {}) {
  /* 上一次渲染留下的轮询与监听必须先撤掉，否则切页后仍在后台拉数据 */
  activeCleanup?.();
  closeAllOverlays();

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  const now = new Date();
  const state = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    stage: 'plan',
    dim: 'ledger',
    dimId: '',
  };
  /** 每个阶段把原始响应缓存在这里，供气泡卡片等后续交互读取，避免重复请求 */
  const cache = {};
  let loadSeq = 0;
  let lastRefresh = null;
  let flatCats = [];

  const [catRes, tagRes] = await Promise.all([
    Api.listCategories(ledger.id, { recordType: 'expense' }).then((r) => r.data).catch(() => []),
    Api.listTags(ledger.id).then((r) => r.data).catch(() => []),
  ]);
  const tags = (tagRes ?? []).filter((t) => !t.archivedAt);
  for (const p of catRes ?? []) {
    for (const c of p.children ?? []) {
      /* parentId 给「类型 + 定位」合并菜单分组用；后端 dto 里字段名也可能是 parent_id */
      if (!c.archivedAt) flatCats.push({ ...c, parentName: p.name, parentId: c.parentId ?? p.id });
    }
  }
  const catOptions = (selected = '') =>
    flatCats
      .map((c) => `<option value="${esc(c.id)}"${selected === c.id ? ' selected' : ''}>${esc(`${c.parentName} › ${c.name}`)}</option>`)
      .join('');

  const frame = appFrame({
    active: 'budgets',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">预算</h1>
            <p class="tt-caption text-muted">${esc(ledger.name)} · 编制 → 执行 → 预警 → 调整 → 复盘</p>
          </div>
          <div class="row row--sm row--wrap">
            <!-- 日期字段仍是同一个隐藏 input：选中的年月回填到它，再走既有 change → load() 链路 -->
            <input type="hidden" data-role="month" value="${state.year}-${pad(state.month)}" />
            <button class="mcal-trigger" type="button" data-act="month" data-role="month-trigger"
                    aria-haspopup="dialog" aria-expanded="false" aria-label="选择账期月份">
              <span class="mcal-trigger__ico">${lucide('calendar', 16)}</span>
              <span class="mcal-trigger__text" data-role="month-text"></span>
              <span class="mcal-trigger__chev">${icon('chevron-down', 16)}</span>
            </button>
            <button class="btn btn--sm btn--secondary" type="button" data-act="refresh">刷新</button>
          </div>
        </div>
      </div>
      <div class="bdg2-tabs" data-role="tabs" role="tablist" aria-label="预算阶段"></div>
      <div data-role="stage"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'budgets', go, ledger });

  const stageSlot = frame.querySelector('[data-role=stage]');
  const tabsSlot = frame.querySelector('[data-role=tabs]');
  const monthField = frame.querySelector('[data-role=month]');
  const monthTrigger = frame.querySelector('[data-role=month-trigger]');
  const monthText = frame.querySelector('[data-role=month-text]');
  let monthPop = null;

  /** 月份日历只回填这一个日期字段；改账期的动作仍由既有 change 监听统一执行 */
  function paintMonthTrigger() {
    monthField.value = `${state.year}-${pad(state.month)}`;
    monthText.textContent = `${state.year} 年 ${state.month} 月`;
    monthTrigger.setAttribute('aria-label', `账期 ${state.year} 年 ${state.month} 月，点击选择月份`);
  }

  const monthGridHtml = (viewYear) =>
    Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const on = viewYear === state.year && m === state.month;
      return `<button class="mcal__cell${on ? ' is-on' : ''}" type="button"
        data-y="${viewYear}" data-m="${m}" aria-pressed="${on}">${m} 月</button>`;
    }).join('');

  function monthCalendarHtml(viewYear) {
    return `
      <div class="mcal">
        <div class="mcal__head">
          <button class="mcal__nav is-prev" type="button" data-step="-1" aria-label="上一年">${icon('chevron-down', 16)}</button>
          <span class="mcal__year" data-role="mcal-year">${viewYear} 年</span>
          <button class="mcal__nav is-next" type="button" data-step="1" aria-label="下一年">${icon('chevron-down', 16)}</button>
        </div>
        <div class="mcal__grid" data-role="mcal-grid">${monthGridHtml(viewYear)}</div>
        <div class="mcal__foot">
          <span>仅按月切换账期</span>
          <button class="mcal__today" type="button" data-today>回到本月</button>
        </div>
      </div>`;
  }

  function openMonthCalendar() {
    if (monthPop?.root?.isConnected) {
      monthPop.close();
      monthPop = null;
      monthTrigger.setAttribute('aria-expanded', 'false');
      return;
    }
    let viewYear = state.year;
    const handle = openPopover(monthTrigger, monthCalendarHtml(viewYear), {
      width: 292,
      align: 'end',
      onClose: () => {
        monthPop = null;
        monthTrigger.setAttribute('aria-expanded', 'false');
      },
    });
    monthPop = handle;
    handle.root.classList.add('ov-pop--menu');
    handle.root.setAttribute('role', 'dialog');
    monthTrigger.setAttribute('aria-expanded', 'true');

    const grid = handle.root.querySelector('[data-role=mcal-grid]');
    const yearLabel = handle.root.querySelector('[data-role=mcal-year]');
    const repaint = () => {
      yearLabel.textContent = `${viewYear} 年`;
      grid.innerHTML = monthGridHtml(viewYear);
    };
    const pick = (y, m) => {
      /* 回填隐藏日期字段并派发 change：state / load() / 局部刷新逻辑一字未改 */
      monthField.value = `${y}-${m}`;
      monthField.dispatchEvent(new Event('change', { bubbles: true }));
      paintMonthTrigger();
      monthPop?.close();
      monthPop = null;
      monthTrigger.setAttribute('aria-expanded', 'false');
    };
    handle.root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.step) {
        viewYear += Number(btn.dataset.step);
        repaint();
      } else if (btn.hasAttribute('data-today')) {
        pick(now.getFullYear(), now.getMonth() + 1);
      } else if (btn.dataset.m) {
        pick(Number(btn.dataset.y), Number(btn.dataset.m));
      }
    });
  }

  function paintTabs() {
    tabsSlot.innerHTML = STAGES.map(
      (s) => `<button class="bdg2-tabs__item" type="button" role="tab" data-act="stage" data-stage="${s.key}"
        aria-current="${state.stage === s.key ? 'true' : 'false'}">${esc(s.label)}</button>`,
    ).join('');
  }

  const ym = () => ({ year: state.year, month: state.month });
  const periodKey = () => `${state.year}-${pad(state.month)}`;

  /* ================================================================ *
   * 阶段一 预算编制
   * ================================================================ */
  async function stagePlan() {
    const [progress, methods, rules, list] = await Promise.all([
      Api.budgetProgress(ledger.id, ym()).then((r) => r.data),
      Api.budgetMethods(ledger.id).then((r) => r.data),
      Api.budgetPeriodRules(ledger.id).then((r) => r.data),
      Api.listBudgets(ledger.id, ym()).then((r) => r.data),
    ]);
    cache.plan = { progress, methods, rules, list };
    const total = progress.find((r) => r.categoryId === null) ?? null;
    const cats = progress.filter((r) => r.categoryId !== null);
    const allocated = cats.reduce((a, r) => a + num(r.amount), 0);
    const unallocated = total ? num(total.amount) - allocated : null;

    const methodBody = (methods ?? [])
      .map(
        (m) => `<div class="bdg2-method">
          <div>
            <p class="tt-body-strong">${esc(m.name)}</p>
            <p class="tt-fine-print text-muted">${esc(m.desc)}</p>
          </div>
          <div class="bdg2-method__acts">
            <button class="btn btn--sm btn--secondary" type="button" data-act="method" data-method="${esc(m.key)}">打开</button>
            <button class="btn btn--quiet btn--sm" type="button" data-act="method-tools" data-method="${esc(m.key)}"
                    aria-label="${esc(m.name)}预览与批量生成">批量工具</button>
          </div>
        </div>`,
      )
      .join('');

    const ruleBody = (rules ?? [])
      .map((r) => `<p class="tt-caption" style="margin:0 0 8px"><strong>${esc(r.name)}</strong> · ${esc(r.desc)}</p>`)
      .join('');

    const listBody = progress.length
      ? `<div class="bdg2-tbl-wrap"><table class="bdg2-tbl">
          <thead><tr><th>范围</th><th>类型</th><th>编制方法</th><th>周期</th><th>额度</th><th>占用方式</th><th></th></tr></thead>
          <tbody>${progress
            .map(
              (r) => `<tr>
                <td>${esc(r.categoryName ?? r.projectLabel ?? '总预算')}</td>
                <td>${esc(KIND_LABEL[r.budgetKind] ?? '支出')}</td>
                <td>${esc(METHOD_LABEL[r.budgetMethod] ?? '手动')}</td>
                <td>${esc(r.periodLabel ?? `${r.year} 年 ${r.month ?? '-'} 月`)}</td>
                <td class="tnum">${esc(money(r.amount))}</td>
                <td>${esc(r.occupancyMode === 'spread' ? '按还款期分摊展示' : '一次性全额')}</td>
                <td>
                  <button class="btn btn--quiet btn--sm" type="button" data-act="edit-budget" data-id="${esc(r.id)}">编辑</button>
                  <button class="btn btn--quiet btn--sm" type="button" data-act="del-budget" data-id="${esc(r.id)}">删除</button>
                </td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>`
      : emptyHtml('本月还没有预算', '先设一条总预算，或用下面的编制方法一次性生成分类额度');

    return `
      <div class="bdg2-metrics">
        ${metric('总预算', total ? money(total.amount) : dash, total ? '账本级约束' : '尚未设置')}
        ${metric('已分配', money(allocated.toFixed(2)), `${cats.length} 条分类 / 项目预算`)}
        ${metric('未分配', unallocated === null ? dash : money(unallocated.toFixed(2)),
          unallocated !== null && unallocated < 0 ? '超额分配，建议调整' : '零基预算下应为 0',
          unallocated !== null && unallocated < 0 ? 'is-neg' : '')}
        ${metric('预算条数', String(progress.length), '含收入 / 储蓄目标类')}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head">
          <div class="bdg2-card__title">${lucide('target', 18)}<span>编制方法</span></div>
          <button class="btn btn--sm" type="button" data-act="add-budget">新建预算</button>
        </div>
        <div class="bdg2-stack">
          ${collapseHtml({ title: '五种编制方法', subtitle: '点「打开」直接新建预算，编制方法与关联字段已预填', body: methodBody || '暂无', open: true })}
          ${collapseHtml({ title: '周期与归属规则', subtitle: '按消费日期归期、报销与转账不占预算', body: ruleBody || '暂无' })}
        </div>
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>${esc(STAGE_HINT.plan)}</span></div></div>
        ${listBody}
      </div>`;
  }

  /* ================================================================ *
   * 阶段二 执行控制
   * ================================================================ */
  async function stageControl() {
    const q = { ...ym(), dim: state.dim, dimId: state.dimId || undefined };
    const [ctl, progress, opts] = await Promise.all([
      Api.budgetControl(ledger.id, q).then((r) => r.data),
      Api.budgetProgress(ledger.id, ym()).then((r) => r.data),
      Api.budgetDimensionOptions(ledger.id).then((r) => r.data),
    ]);
    const choices = [{ key: 'ledger', id: '', label: '全账本' }];
    for (const a of opts?.accounts ?? []) choices.push({ key: 'account', id: a.id, label: `账户 · ${a.label}` });
    for (const m of opts?.members ?? []) choices.push({ key: 'member', id: m.id, label: `成员 · ${m.label}` });
    for (const t of opts?.tags ?? []) choices.push({ key: 'tag', id: t.id, label: `标签 · ${t.label}` });
    cache.control = { ctl, progress, choices };
    const pmap = new Map((progress ?? []).map((p) => [p.id, p]));
    const rows = [...(ctl?.rows ?? [])].sort((a, b) => {
      if (a.over !== b.over) return a.over ? -1 : 1;
      return Math.abs(num(b.available)) - Math.abs(num(a.available));
    });
    const totalProgress = (progress ?? []).find((r) => r.categoryId === null) ?? null;
    const t = ctl?.totals ?? {};
    const selectedIdx = Math.max(0, choices.findIndex((c) => c.key === state.dim && c.id === state.dimId));

    const dimSelect = `<select class="input" data-role="dim" aria-label="切换统计维度" style="width:auto;max-width:100%">
      ${choices.map((c, i) => `<option value="${i}"${i === selectedIdx ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
    </select>`;

    const rowHtml = rows.length
      ? rows
          .map((r) => {
            const p = pmap.get(r.budgetId);
            const ratio = r.usedRatio ?? dash;
            return `<div class="bdg2-row" data-row="${esc(r.budgetId)}">
              <div class="bdg2-row__name">
                ${esc(r.label)}
                ${r.budgetKind !== 'expense' ? `<span class="badge badge--dark">${esc(KIND_LABEL[r.budgetKind] ?? r.budgetKind)}目标</span>` : ''}
                ${r.over ? '<span class="badge badge--danger">超支</span>' : ''}
                <div style="margin-top:6px">${barHtml(num(ratio), p?.timeProgress)}</div>
                <span class="bdg2-hint">执行率 ${esc(ratio === null ? dash : `${ratio}%`)} · 时间进度 ${esc(String(p?.timeProgress ?? dash))}%</span>
              </div>
              <span class="bdg2-row__num"><small>预算额 B</small>${esc(money(r.budgetAmount))}</span>
              <span class="bdg2-row__num"><small>已用 U</small>${esc(money(r.used))}</span>
              <span class="bdg2-row__num"><small>占用 C + 预留 R</small>${esc(money((num(r.committed) + num(r.reserved)).toFixed(2)))}</span>
              <span class="bdg2-row__num"><small>可用 A</small><span class="${num(r.available) < 0 ? 'is-neg' : ''}">${esc(money(r.available))}</span></span>
              <div class="bdg2-row__acts">
                <button class="btn btn--quiet btn--sm" type="button" data-act="resv-detail" data-id="${esc(r.budgetId)}">占用明细</button>
                <button class="btn btn--quiet btn--sm" type="button" data-act="resv-new" data-id="${esc(r.budgetId)}">新增占用</button>
              </div>
            </div>`;
          })
          .join('')
      : emptyHtml('本月没有可执行的预算', '先到「编制」阶段设一条总预算或分类预算');

    return `
      <div class="bdg2-metrics">
        ${metric('预算额 B', amt(t.budgetAmount), '含调拨与追加削减')}
        ${metric('已用 U', amt(t.used), `执行率 ${pct(t.usedRatio)}`)}
        ${metric('承诺占用 C', amt(t.committed), '尚未落成账单的确定支出')}
        ${metric('预留 R', amt(t.reserved), '专项池预提与手工预留')}
        ${metric('可用额度 A', amt(t.available), 'B − U − C − R', num(t.available) < 0 ? 'is-neg' : '')}
      </div>
      <div class="bdg2-metrics">
        ${metric('时间进度', totalProgress ? `${totalProgress.timeProgress}%` : dash,
          totalProgress ? `${totalProgress.elapsedDays} / ${totalProgress.periodDays} 天` : '')}
        ${metric('日均消耗', totalProgress ? money(totalProgress.dailyBurn) : dash, '截至今天')}
        ${metric('预计期末支出', totalProgress ? amt(totalProgress.projectedSpent) : dash,
          totalProgress?.projectedSpent === null ? '不足 3 天，暂不预测' : '按当前速度外推')}
        ${metric('每天还可花', totalProgress ? amt(totalProgress.dailyRemaining) : dash, '剩余额度 ÷ 剩余天数')}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head">
          <div class="bdg2-card__title"><span>${ctl?.archived ? '已归档账期（只读快照）' : '执行明细'}</span>
            ${ctl?.archived ? '<span class="badge badge--dark">已归档</span>' : ''}</div>
          <div class="row row--sm row--wrap">${dimSelect}</div>
        </div>
        <p class="bdg2-hint">${esc(STAGE_HINT.control)}。超支自动置顶；进度条上的灰线是时间进度。
          ${lastRefresh ? `最近刷新 ${esc(lastRefresh.toLocaleTimeString('zh-CN'))}` : ''}</p>
        ${rowHtml}
      </div>`;
  }

  /* ================================================================ *
   * 阶段三 预警
   * ================================================================ */
  async function stageAlert() {
    const [rules, center, policy] = await Promise.all([
      Api.budgetAlertRules(ledger.id).then((r) => r.data),
      Api.budgetAlertCenter(ledger.id, ym()).then((r) => r.data),
      Api.budgetPrecheckPolicy(ledger.id, ym()).then((r) => r.data),
    ]);
    cache.alert = { rules, center, policy };
    const tiers = rules?.descriptions ?? [];
    const items = center?.items ?? [];
    const tierBody = tiers
      .map(
        (t) => `<div class="bdg2-method">
          <div><p class="tt-body-strong">${esc(String(t.tier))}% · ${esc(t.label)}</p>
          <p class="tt-fine-print text-muted">${esc(t.behavior)}</p></div>
        </div>`,
      )
      .join('');
    const alertHtml = items.length
      ? items
          .map(
            (a) => `<div class="bdg2-alert is-${esc(a.level)}">
              <span class="bdg2-alert__dot"></span>
              <div>
                <p class="tt-caption" style="margin:0">${esc(a.message)}</p>
                <p class="bdg2-hint">${esc(LEVEL_LABEL[a.level] ?? a.level)} · ${esc(a.kind)}${a.suppressed ? ' · 免打扰时段，暂不推送' : ''}</p>
              </div>
            </div>`,
          )
          .join('')
      : emptyHtml('当前没有预警', '预算执行到阈值、出现大额消费或耗尽风险时会自动列出');

    const policyBody = `
      <p class="tt-caption" style="margin:0 0 8px">超支后策略：<strong>${esc(POLICY_LABEL[policy?.policy] ?? policy?.policy ?? dash)}</strong></p>
      <p class="tt-caption" style="margin:0 0 8px">大额消费阈值：${esc(amt(policy?.largeExpenseThreshold))}</p>
      <p class="bdg2-hint">记账时的四条出口：${esc((policy?.options ?? []).join(' / '))}</p>
      ${(policy?.transferSources ?? []).length
        ? `<p class="bdg2-hint">可调出额度的分类：${esc((policy.transferSources ?? []).slice(0, 5).map((s) => s.label).join('、'))}</p>`
        : '<p class="bdg2-hint">当前没有可调出额度的分类</p>'}`;

    return `
      <div class="bdg2-metrics">
        ${metric('分级阈值', (rules?.alertTiers ?? []).join(' / ') + '%', '提示 / 警告 / 严重')}
        ${metric('提醒渠道', (center?.channels ?? []).map((c) => CHANNEL_LABEL[c] ?? c).join('、') || dash, '渠道与免打扰可调整')}
        ${metric('免打扰', rules?.dndEnabled ? `${rules.dndFrom} – ${rules.dndTo}` : '关闭', rules?.dndEnabled ? '时段内不推送' : '始终推送')}
        ${metric('时间进度预警', rules?.timeProgressAlert ? '开启' : '关闭', '执行率跑赢时间 10pp 时提示')}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head">
          <div class="bdg2-card__title"><span>预警规则</span></div>
          <button class="btn btn--sm btn--secondary" type="button" data-act="prefs-edit">编辑规则</button>
        </div>
        ${tierBody || '<p class="bdg2-hint">暂无阈值</p>'}
        ${collapseHtml({ title: '超支后行为策略', subtitle: '记账页预检时给出，不拦路', body: policyBody })}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>预警中心</span>
          <span class="badge badge--dark">${items.length} 条</span></div>
          ${center?.suppressed ? '<span class="badge badge--accent">免打扰中</span>' : ''}
        </div>
        ${alertHtml}
        <p class="bdg2-hint">这里是当前事实的只读清单，可随局部刷新反复读取；不会把提醒标记成已读。</p>
      </div>`;
  }

  /* ================================================================ *
   * 阶段四 调整
   * ================================================================ */
  async function stageAdjust() {
    const [changes, preview, periods, transfers, progress] = await Promise.all([
      Api.listBudgetChanges(ledger.id, { limit: 20 }).then((r) => r.data),
      Api.budgetArchivePreview(ledger.id, ym()).then((r) => r.data).catch(() => null),
      Api.listArchivedBudgetPeriods(ledger.id).then((r) => r.data),
      Api.listBudgetTransfers(ledger.id, ym()).then((r) => r.data),
      Api.budgetProgress(ledger.id, ym()).then((r) => r.data),
    ]);
    cache.adjust = { changes, preview, periods, transfers, progress };
    const actions = [
      ['adj-append', '追加 / 削减', '必须填原因，写入变更留痕'],
      ['adj-transfer', '额度转移', '分类之间挪额度，不产生账单'],
      ['adj-rollover', '结转与负结转', '把上月结余带入本月或转储蓄'],
      ['adj-template', '复制模板', '把本期额度存成模板，供下期复用'],
      ['adj-copy-prev', '从上月复制', '已存在的预算不会被覆盖'],
      ['adj-changes', '变更留痕', '所有调整的金额、原因与时间'],
      ['adj-transfers', '调拨记录', '可撤销的额度转移历史'],
      ['adj-archive', '周期重置归档', '写快照并锁定历史，不删除数据'],
    ];
    const actionHtml = actions
      .map(
        ([act, label, sub]) => `<button class="bdg2-metric" type="button" data-act="${esc(act)}" style="cursor:pointer;text-align:left">
          <span class="bdg2-metric__value" style="font-size:14px">${esc(label)}</span>
          <span class="bdg2-metric__sub">${esc(sub)}</span>
        </button>`,
      )
      .join('');

    const archivedSelect = `<select class="input" data-role="archived" aria-label="选择归档账期" style="width:auto;max-width:100%">
      <option value="">选择已归档账期</option>
      ${(periods ?? []).map((p) => `<option value="${esc(p.period)}">${esc(monthLabel(p.period))} · ${p.count} 条</option>`).join('')}
    </select>`;

    return `
      <div class="bdg2-metrics">
        ${metric('本期预算', `${(progress ?? []).length} 条`, '可追加削减的对象')}
        ${metric('本期调拨', `${(transfers ?? []).length} 笔`, '净额会进入预算额 B')}
        ${metric('可归档', preview ? `${preview.count} 条` : dash, preview ? `账期 ${preview.period}` : '本期无可归档预算')}
        ${metric('已归档账期', `${(periods ?? []).length} 个`, '归档后复盘读快照')}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>${esc(STAGE_HINT.adjust)}</span></div>${archivedSelect}</div>
        <div class="bdg2-metrics">${actionHtml}</div>
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>最近变更</span></div></div>
        ${(changes ?? []).length
          ? (changes ?? []).slice(0, 8)
              .map(
                (c) => `<div class="recon-line">
                  <span class="tt-caption">${esc(c.action ?? '调整')}</span>
                  <span class="tt-caption tnum">${esc(c.createdAt ?? '')}</span>
                  <span class="bdg2-hint">${esc(c.note ?? '')}</span>
                </div>`,
              )
              .join('')
          : '<p class="bdg2-hint">还没有调整记录。所有写操作都会在这里留痕。</p>'}
      </div>`;
  }

  /* ================================================================ *
   * 阶段五 差异分析与复盘
   * ================================================================ */
  async function stageReview() {
    const [review, trend, suggestions, periods] = await Promise.all([
      Api.budgetReview(ledger.id, ym()).then((r) => r.data),
      Api.budgetReviewTrend(ledger.id, { year: state.year }).then((r) => r.data),
      Api.budgetReviewSuggestions(ledger.id, ym()).then((r) => r.data),
      Api.listArchivedBudgetPeriods(ledger.id).then((r) => r.data),
    ]);
    cache.review = { review, trend, suggestions, periods };
    const s = review?.summary ?? {};
    const rows = review?.rows ?? [];
    const maxVal = Math.max(
      1,
      ...(trend ?? []).map((t) => Math.max(num(t.budget), num(t.actual))),
    );
    const trendHtml = (trend ?? [])
      .map((t) => {
        const hB = Math.round((num(t.budget) / maxVal) * 100);
        const hU = Math.round((num(t.actual) / maxVal) * 100);
        const over = num(t.actual) > num(t.budget) && t.budget !== null;
        return `<div class="bdg2-trend__col" title="${esc(`${t.period} 预算 ${amt(t.budget)} / 实际 ${amt(t.actual)}`)}">
          <div style="display:flex;align-items:flex-end;gap:2px;height:100%;width:100%;justify-content:center">
            <span class="bdg2-trend__bar${hB === 0 ? ' is-empty' : ''}" style="height:${Math.max(2, hB)}%;opacity:0.35"></span>
            <span class="bdg2-trend__bar${hU === 0 ? ' is-empty' : ''}${over ? ' is-over' : ''}" style="height:${Math.max(2, hU)}%"></span>
          </div>
          <span class="bdg2-trend__label">${t.month}</span>
        </div>`;
      })
      .join('');

    const tableHtml = rows.length
      ? `<div class="bdg2-tbl-wrap"><table class="bdg2-tbl">
        <thead><tr><th>范围</th><th>预算 B</th><th>实际 U</th><th>差异 Δ</th><th>差异率 δ</th><th>性质</th><th>准确率</th><th>归因</th></tr></thead>
        <tbody>${rows
          .map(
            (r, i) => `<tr>
              <td>${esc(r.label)}${r.over ? ' <span class="badge badge--danger">超支</span>' : ''}</td>
              <td class="tnum">${esc(money(r.budget))}</td>
              <td class="tnum">${esc(money(r.actual))}</td>
              <td class="tnum ${num(r.variance) > 0 ? 'is-neg' : ''}">${esc(money(r.variance))}</td>
              <td class="tnum">${esc(pct(r.varianceRatio))}</td>
              <td>${esc(r.directionLabel)}</td>
              <td class="tnum">${esc(pct(r.accuracy))}</td>
              <td><button class="btn btn--quiet btn--sm" type="button" data-act="review-attr" data-idx="${i}">查看</button></td>
            </tr>`,
          )
          .join('')}</tbody></table></div>`
      : emptyHtml('本期没有可复盘的预算', '可以先到「编制」阶段设好预算，或切换到有数据的账期');

    const rankHtml = (list, title) => `<div>
      <p class="tt-body-strong" style="margin:0 0 8px">${esc(title)}</p>
      ${(list ?? []).length
        ? (list ?? [])
            .map((x) => `<div class="recon-line"><span class="tt-caption">${esc(x.label)}</span>
              <span class="tt-caption tnum">${esc(money(x.variance))}</span>
              <span class="bdg2-hint">${esc(pct(x.varianceRatio))}</span></div>`)
            .join('')
        : '<p class="bdg2-hint">无</p>'}
    </div>`;

    const sugHtml = (suggestions?.items ?? []).length
      ? `<div class="bdg2-tbl-wrap"><table class="bdg2-tbl">
          <thead><tr><th>范围</th><th>本期额度</th><th>建议额度</th><th>变化</th><th>依据</th></tr></thead>
          <tbody>${(suggestions.items ?? [])
            .map(
              (x) => `<tr>
                <td>${esc(x.label)}</td>
                <td class="tnum">${esc(money(x.currentAmount))}</td>
                <td class="tnum">${esc(money(x.suggestedAmount))}</td>
                <td class="tnum">${esc(pct(x.changeRatio))}</td>
                <td style="white-space:normal;min-width:220px">${esc(x.reason)}</td>
              </tr>`,
            )
            .join('')}</tbody></table></div>`
      : '<p class="bdg2-hint">本期没有预算，无法给出下期建议</p>';

    const compareHtml = ['mom', 'yoy']
      .map((k) => {
        const c = review?.comparison?.[k];
        return `<div><p class="tt-body-strong" style="margin:0 0 8px">${esc(c?.label ?? k)}</p>
          <div class="recon-line"><span class="tt-caption">本期实际</span><span class="tt-caption tnum">${esc(amt(c?.currentActual))}</span></div>
          <div class="recon-line"><span class="tt-caption">对比期（${esc(c?.period ?? dash)}）</span><span class="tt-caption tnum">${esc(amt(c?.previousActual))}</span></div>
          <div class="recon-line"><span class="tt-caption">变动</span><span class="tt-caption tnum">${esc(amt(c?.change))} · ${esc(pct(c?.changeRatio))}</span></div>
          ${c?.note ? `<p class="bdg2-hint">${esc(c.note)}</p>` : ''}</div>`;
      })
      .join('');

    return `
      <div class="bdg2-metrics">
        ${metric('预算合计', amt(s.budget), review?.periodLabel ?? periodKey())}
        ${metric('实际合计', amt(s.actual), '正常减冲减后的净额')}
        ${metric('差异 Δ', amt(s.variance), `差异率 ${pct(s.varianceRatio)}`, num(s.variance) > 0 ? 'is-neg' : '')}
        ${metric('预算准确率', pct(s.accuracy), '越接近 100% 越准')}
        ${metric('有利 / 不利', `${s.favorableCount ?? 0} / ${s.unfavorableCount ?? 0}`, '按预算类型反转判定')}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>预算与实际对照</span></div>
          <span class="bdg2-hint">Δ = U − B；B 或对比期为 0 时显示破折号</span></div>
        ${tableHtml}
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>超支与结余排行</span></div></div>
        <div class="bdg2-metrics">${rankHtml(review?.rankings?.overspend, '超支最多')}${rankHtml(review?.rankings?.surplus, '结余最多')}</div>
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>环比 / 同比</span></div></div>
        <div class="bdg2-metrics">${compareHtml}</div>
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head"><div class="bdg2-card__title"><span>${esc(String(state.year))} 年趋势</span></div>
          <span class="bdg2-hint">浅色 = 预算，深色 = 实际；缺数据的月份留空不补 0</span></div>
        <div class="bdg2-trend">${trendHtml}</div>
      </div>
      <div class="card bdg2-card">
        <div class="bdg2-card__head">
          <div class="bdg2-card__title"><span>下期调额建议</span></div>
          <button class="btn btn--sm" type="button" data-act="gen-next">一键生成 ${esc(suggestions?.nextPeriod ?? '下月')} 预算</button>
        </div>
        ${sugHtml}
        <p class="bdg2-hint" style="margin-top:12px">${esc(suggestions?.note ?? '')}</p>
        ${(periods ?? []).length
          ? `<p class="bdg2-hint">已归档账期 ${esc(String(periods.length))} 个，归档月读快照，不随今天的编辑变形。</p>`
          : ''}
      </div>`;
  }

  const renderers = { plan: stagePlan, control: stageControl, alert: stageAlert, adjust: stageAdjust, review: stageReview };

  async function load() {
    const seq = ++loadSeq;
    stageSlot.innerHTML = '<div class="card empty-state"><p class="tt-caption text-muted">加载中…</p></div>';
    try {
      const html = await renderers[state.stage]();
      /* 过期响应不落地：切阶段 / 切月份时旧请求可能后回来，覆盖新页是静默错 */
      if (seq !== loadSeq || !frame.isConnected) return;
      stageSlot.innerHTML = html;
      initCollapses(stageSlot);
      lastRefresh = new Date();
      paintTabs();
    } catch (err) {
      if (seq !== loadSeq || !frame.isConnected) return;
      stageSlot.innerHTML = `<div class="card empty-state"><p class="tt-caption is-neg">${esc(err?.message ?? '加载失败')}</p></div>`;
    }
  }

  /* ================================================================ *
   * 抽屉：编制方法 / 预算表单 / 预警设置 / 调整动作
   * ================================================================ */

  function openBudgetForm(row = null, presetMethod = null) {
    const isTotal = row?.categoryId === null;
    /* 方法「打开」只带一组初值；字段名、取值方式与提交时的 payload 一字未改 */
    const preset = presetMethod ? METHOD_PRESETS[presetMethod] ?? {} : {};
    const v = (key, fallback) => (row ? (row[key] ?? fallback) : (preset[key] ?? fallback));
    const selected = (key, val, fallback) => (v(key, fallback) === val ? ' selected' : '');
    const body = `
      <p class="bdg2-hint">${esc(preset.note ?? (row ? '修改会写入变更留痕' : '预算额、类型与编制方法都可以在此一次设定'))}</p>
      <div class="bdg2-form">
        <div class="bdg2-form__row bdg2-form__row--pick" data-field="categoryId">
          <span class="bdg2-form__label" id="bdg-scope-label">类型与定位</span>
          <div class="bdg2-form__ctrl">
            ${budgetScopeTriggerHtml({ labelId: 'bdg-scope-label' })}
            <!-- 不用 disabled：隐藏字段仍要能被 form.elements 按 name 稳定取到，
                 总预算的定位锁定由合并菜单的 lockScope 负责 -->
            <input type="hidden" name="categoryId" id="f-categoryId" value="${esc(v('categoryId', ''))}" />
            <span class="bdg2-form__hidden" data-field="budgetKind">
              <input type="hidden" name="budgetKind" id="f-budgetKind" value="${esc(v('budgetKind', 'expense'))}" />
              <span class="field__error"></span>
            </span>
            <span class="bdg2-hint">${esc(isTotal ? '总预算的定位固定为整个账本，编辑时不可改动' : '一次选定预算类型与定位；收入 / 储蓄是达成目标，超额不是超支')}</span>
            <span class="field__error"></span>
          </div>
        </div>
        ${formRow('预算额（元）', 'amount', `<input class="input" id="f-amount" name="amount" inputmode="decimal" value="${esc(v('amount', ''))}" placeholder="3000.00" />`)}
        ${formRow('编制方法', 'budgetMethod', `<select class="input select" id="f-budgetMethod" name="budgetMethod">
          <option value="">手动</option>
          ${Object.entries(METHOD_LABEL).map(([k, label]) => `<option value="${k}"${selected('budgetMethod', k, '')}>${label}</option>`).join('')}
        </select>`, '由方法「打开」带入时可随时改回手动')}
        ${formRow('周期', 'periodType', `<select class="input select" id="f-periodType" name="periodType">
          ${[['monthly', '月'], ['weekly', '周'], ['yearly', '年'], ['custom', '自定义']]
            .map(([k, label]) => `<option value="${k}"${selected('periodType', k, 'monthly')}>${label}</option>`).join('')}
        </select>`)}
        ${formRow('占用方式', 'occupancyMode', `<select class="input select" id="f-occupancyMode" name="occupancyMode">
          <option value="full"${selected('occupancyMode', 'full', 'full')}>一次性全额</option>
          <option value="spread"${selected('occupancyMode', 'spread', 'full')}>按还款期分摊展示</option>
        </select>`, '只改预算展示，不改账务')}
        ${formRow('账期开始', 'periodStart', `<input class="input" id="f-periodStart" name="periodStart" type="date" value="${esc(v('periodStart', ''))}" />`, '周 / 自定义必填')}
        ${formRow('账期结束', 'periodEnd', `<input class="input" id="f-periodEnd" name="periodEnd" type="date" value="${esc(v('periodEnd', ''))}" />`)}
        ${formRow('专项项目名', 'projectLabel', `<input class="input" id="f-projectLabel" name="projectLabel" maxlength="60" value="${esc(v('projectLabel', ''))}" placeholder="例如：装修、旅行" />`, '填了项目名就按下面选的标签归集支出')}
        ${formRow('归集标签', 'scopeId', `<select class="input select" id="f-scopeId" name="scopeId">
          <option value="">不按标签归集</option>
          ${tags.map((t) => `<option value="${esc(t.id)}"${selected('scopeId', t.id, '')}>${esc(t.name)}</option>`).join('')}
        </select>`, '标签预算 / 专项项目预算都靠它取数')}
        ${formRow('预警线（%）', 'alertRatio', `<input class="input" id="f-alertRatio" name="alertRatio" type="number" min="1" max="100" value="${esc(String(v('alertRatio', 80)))}" />`)}
        ${formRow('本条预警', 'alertEnabled', `<select class="input select" id="f-alertEnabled" name="alertEnabled">
          <option value="on"${v('alertEnabled', true) === false ? '' : ' selected'}>开启</option>
          <option value="off"${v('alertEnabled', true) === false ? ' selected' : ''}>静音（单独关掉这一条）</option>
        </select>`)}
      </div>`;
    let picker = null;
    const layer = drawerForm({
      title: row ? '编辑预算' : '新建预算',
      body,
      onClose: () => picker?.close(),
      onSubmit: async (f, layer) => {
        const cents = parseAmountToCents(f.amount.value);
        if (cents === null || cents <= 0) {
          toast('预算金额必须大于 0', 'error');
          f.amount.focus();
          setLoading(f.querySelector('button[type=submit]'), false);
          return;
        }
        const projectName = f.projectLabel.value.trim();
        const scopeId = f.scopeId.value || null;
        const payload = {
          categoryId: f.categoryId.value || null,
          periodType: f.periodType.value,
          year: state.year,
          month: state.month,
          amount: f.amount.value,
          budgetKind: f.budgetKind.value,
          budgetMethod: f.budgetMethod.value || null,
          occupancyMode: f.occupancyMode.value,
          periodStart: f.periodStart.value || null,
          periodEnd: f.periodEnd.value || null,
          projectLabel: projectName || null,
          /* 有项目名 = 专项项目预算，只选标签 = 标签预算；两者都按标签取数 */
          scope: scopeId ? (projectName ? 'project' : 'tag') : 'category',
          scopeId,
          alertRatio: Number(f.alertRatio.value || 80),
          alertEnabled: f.alertEnabled.value !== 'off',
        };
        if (row) await Api.updateBudget(ledger.id, row.id, payload);
        else await Api.createBudget(ledger.id, payload);
        layer.close();
        toast(row ? '预算已更新' : '预算已创建', 'success');
        await load();
      },
    });
    if (!layer) return null;
    const form = layer.body.querySelector('form');
    picker = createBudgetScopePicker({
      trigger: form.querySelector('[data-bsp-trigger]'),
      cats: flatCats,
      lockScope: isTotal,
      value: () => ({
        budgetKind: form.elements.budgetKind.value,
        categoryId: form.elements.categoryId.value || null,
      }),
      /* 只写两个隐藏字段：表单按 name 取值与提交 payload 的写法保持原样 */
      onPick: (next) => {
        form.elements.budgetKind.value = next.budgetKind;
        form.elements.categoryId.value = next.categoryId ?? '';
      },
    });
    return layer;
  }

  /** 编制方法抽屉：预览结果在同一个抽屉里换 HTML，不另开一层 */
  function openMethodDrawer(key) {
    const doc = (cache.plan?.methods ?? []).find((m) => m.key === key);
    const title = doc?.name ?? METHOD_LABEL[key] ?? '编制方法';
    let html = `<p class="bdg2-hint">${esc(doc?.desc ?? '')}</p><div data-role="result"></div>`;

    if (key === 'zero_base' || key === 'envelope') {
      html = `<p class="bdg2-hint">${esc(doc?.desc ?? '')}</p>
        ${field('总预算（元）', 'total', '<input class="input" id="f-total" name="total" inputmode="decimal" placeholder="10000.00" />')}
        <p class="tt-body-strong" style="margin:8px 0">按分类分配</p>
        <div class="stack stack--sm">${flatCats
          .slice(0, 16)
          .map((c) => `<div class="recon-line">
            <span class="tt-caption">${esc(`${c.parentName} › ${c.name}`)}</span>
            <input class="input" style="width:140px" data-cat="${esc(c.id)}" inputmode="decimal" placeholder="0.00" />
          </div>`)
          .join('')}</div>
        <div data-role="result"></div>
        <div class="row row--sm row--wrap" style="margin-top:12px">
          <button class="btn btn--secondary btn--sm" type="button" data-method-act="preview">预览分配</button>
          <button class="btn btn--sm" type="button" data-method-act="apply">按分配生成预算</button>
        </div>`;
    } else if (key === 'ratio') {
      html = `<p class="bdg2-hint">${esc(doc?.desc ?? '')}</p>
        <div class="row row--sm row--wrap" data-role="presets"></div><div data-role="result"></div>`;
    } else if (key === 'historical') {
      html = `<p class="bdg2-hint">${esc(doc?.desc ?? '')}</p><div data-role="result"></div>`;
    } else if (key === 'elastic') {
      html = `<p class="bdg2-hint">${esc(doc?.desc ?? '')}</p>
        <div class="field-row">
          ${field('固定基数（元）', 'base', '<input class="input" id="f-base" name="base" inputmode="decimal" placeholder="3000.00" />')}
          ${field('收入浮动比例（%）', 'ratio', '<input class="input" id="f-ratio" name="ratio" inputmode="decimal" placeholder="10" />')}
        </div>
        <div data-role="result"></div>
        <div class="row row--sm row--wrap" style="margin-top:12px">
          <button class="btn btn--secondary btn--sm" type="button" data-method-act="preview">计算有效额度</button>
          <button class="btn btn--sm" type="button" data-method-act="apply">应用为总预算</button>
        </div>`;
    }

    const layer = openDrawer({ title, wide: key === 'envelope' || key === 'zero_base', body: html });
    if (!layer) return;
    const result = layer.body.querySelector('[data-role=result]');
    const collect = () => {
      const allocations = [...layer.body.querySelectorAll('[data-cat]')]
        .map((el) => ({ categoryId: el.dataset.cat, amount: el.value.trim() }))
        .filter((x) => x.amount && parseAmountToCents(x.amount) > 0);
      return { total: layer.body.querySelector('[name=total]')?.value?.trim() ?? '', allocations };
    };
    const applyMany = async (items) => {
      if (!items.length) {
        toast('没有可生成的额度', 'default');
        return;
      }
      const settled = await Promise.allSettled(
        items.map((x) => Api.createBudget(ledger.id, { categoryId: x.categoryId, ...ym(), amount: x.amount, budgetMethod: key })),
      );
      const ok = settled.filter((s) => s.status === 'fulfilled').length;
      toast(`已生成 ${ok} 条，${settled.length - ok} 条跳过（已存在或校验未通过）`, ok ? 'success' : 'default');
      layer.close();
      await load();
    };

    layer.body.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-method-act], [data-preset], [data-apply]');
      if (!btn) return;
      try {
        if (btn.dataset.preset) {
          const plan = (await Api.planBudgetByRatio(ledger.id, { ...ym(), preset: btn.dataset.preset })).data;
          result.innerHTML = `<div class="recon-line"><span class="tt-caption">基数（收入 − 固定支出）</span><span class="tt-caption tnum">${esc(money(plan.baseAmount))}</span></div>
            <p class="bdg2-hint">${esc(plan.baseNote ?? '')}</p>
            ${(plan.suggestions ?? [])
              .map((x) => `<div class="recon-line"><span class="tt-caption">${esc(x.categoryName)}</span>
                <span class="tt-caption tnum">${esc(money(x.amount))}</span>
                <button class="btn btn--quiet btn--sm" type="button" data-apply="${esc(x.categoryId)}" data-amt="${esc(x.amount)}">采用</button></div>`)
              .join('')}`;
          return;
        }
        if (btn.dataset.apply) {
          const item = { categoryId: btn.dataset.apply, amount: btn.dataset.amt };
          await applyMany([item]);
          return;
        }
        if (key === 'zero_base' || key === 'envelope') {
          const input = collect();
          if (!input.total || parseAmountToCents(input.total) === null) {
            toast('请先填总预算', 'error');
            return;
          }
          if (btn.dataset.methodAct === 'preview') {
            /* 一条都没填时不发请求：envelope 端点要求 allocations 至少 1 条，
               塞一条假数据会拿到 400，而这个 400 看起来像「功能坏了」 */
            if (!input.allocations.length) {
              result.innerHTML = `<div class="recon-line"><span class="tt-caption">已分配</span><span class="tt-caption tnum">${esc(money('0.00'))}</span></div>
                <div class="recon-line"><span class="tt-caption">未分配</span><span class="tt-caption tnum">${esc(money(input.total))}</span></div>
                <p class="bdg2-hint">还没有给任何分类分配额度；零基预算要求先把总额安排完。</p>`;
              return;
            }
            const plan = (await Api.planBudgetEnvelope(ledger.id, { total: input.total, allocations: input.allocations })).data;
            result.innerHTML = `<div class="recon-line"><span class="tt-caption">已分配</span><span class="tt-caption tnum">${esc(money(plan.allocated))}</span></div>
              <div class="recon-line"><span class="tt-caption">未分配</span><span class="tt-caption tnum ${num(plan.unallocated) < 0 ? 'is-neg' : ''}">${esc(money(plan.unallocated))}</span></div>
              ${plan.overAllocated ? `<p class="tt-caption is-neg">超额分配 ${esc(money(plan.overAllocated))}，可以生成，但建议先调整</p>` : ''}
              ${(plan.items ?? []).map((x) => `<div class="recon-line"><span class="tt-caption">${esc(x.categoryName)}</span><span class="tt-caption tnum">${esc(money(x.amount))}</span></div>`).join('')}`;
          } else {
            await applyMany(input.allocations);
          }
          return;
        }
        if (key === 'elastic') {
          const baseCents = parseAmountToCents(layer.body.querySelector('[name=base]')?.value ?? '');
          const ratioBp = Math.round(num(layer.body.querySelector('[name=ratio]')?.value) * 100);
          if (baseCents === null || baseCents <= 0 || ratioBp <= 0) {
            toast('请填固定基数与大于 0 的比例', 'error');
            return;
          }
          const q = { ...ym(), base: baseCents, ratioBp };
          if (btn.dataset.methodAct === 'preview') {
            const p = (await Api.elasticBudgetPreview(ledger.id, q)).data;
            result.innerHTML = `<div class="recon-line"><span class="tt-caption">固定基数</span><span class="tt-caption tnum">${esc(money(p.fixedBase))}</span></div>
              <div class="recon-line"><span class="tt-caption">本期收入 × ${esc(p.ratioPercent)}%</span><span class="tt-caption tnum">${esc(money(p.variable))}</span></div>
              <div class="recon-line"><span class="tt-caption">当前有效额度</span><span class="tt-caption tnum">${esc(money(p.effectiveAmount))}</span></div>
              <p class="bdg2-hint">${esc(p.note)}</p>`;
          } else {
            const p = (await Api.elasticBudgetPreview(ledger.id, q)).data;
            const existing = (cache.plan?.progress ?? []).find((r) => r.categoryId === null);
            const payload = {
              categoryId: null, periodType: 'monthly', ...ym(), amount: p.effectiveAmount,
              budgetKind: 'expense', budgetMethod: 'elastic',
              elasticBase: baseCents, elasticRatio: ratioBp,
            };
            if (existing) await Api.updateBudget(ledger.id, existing.id, payload);
            else await Api.createBudget(ledger.id, payload);
            layer.close();
            toast('弹性总预算已应用', 'success');
            await load();
          }
        }
      } catch (err) {
        toast(err?.message ?? '操作失败', 'error');
      }
    });

    /* 比例法 / 历史推荐：打开抽屉即加载列表 */
    (async () => {
      try {
        if (key === 'ratio') {
          const presets = (await Api.budgetRatioPresets(ledger.id)).data ?? [];
          layer.body.querySelector('[data-role=presets]').innerHTML = presets
            .map((p) => `<button class="btn btn--sm btn--secondary" type="button" data-preset="${esc(p.key)}">${esc(p.name ?? p.key)}</button>`)
            .join('');
        } else if (key === 'historical') {
          const rows = (await Api.budgetSuggestions(ledger.id, state.year, state.month)).data ?? [];
          result.innerHTML = rows.length
            ? rows
                .slice(0, 16)
                .map((x) => `<div class="recon-line"><span class="tt-caption">${esc(x.categoryName)}</span>
                  <span class="tt-caption tnum">${esc(money(x.suggested))}</span>
                  <span class="bdg2-hint">${esc(String(x.sampleMonths))} 个月样本 · P50 ${esc(money(x.medianMonthly))}</span>
                  <button class="btn btn--quiet btn--sm" type="button" data-apply="${esc(x.categoryId)}" data-amt="${esc(x.suggested)}">采用</button></div>`)
                .join('')
            : '<p class="bdg2-hint">历史数据不足，先记几个月账</p>';
        }
      } catch (err) {
        if (result) result.innerHTML = `<p class="tt-caption is-neg">${esc(err?.message ?? '加载失败')}</p>`;
      }
    })();
  }

  function openPrefsForm() {
    const p = cache.alert?.rules ?? {};
    const body = `
      <p class="bdg2-hint">三档阈值按递增顺序填写；渠道与超支后策略会作用在预警中心和记账预检上。</p>
      <div class="field-row">
        ${field('第一档（%）', 't1', `<input class="input" id="f-t1" name="t1" type="number" min="1" max="200" value="${esc(String(p.alertTiers?.[0] ?? 80))}" />`)}
        ${field('第二档（%）', 't2', `<input class="input" id="f-t2" name="t2" type="number" min="1" max="200" value="${esc(String(p.alertTiers?.[1] ?? 90))}" />`)}
        ${field('第三档（%）', 't3', `<input class="input" id="f-t3" name="t3" type="number" min="1" max="200" value="${esc(String(p.alertTiers?.[2] ?? 100))}" />`)}
      </div>
      <div class="field-row">
        ${field('大额消费阈值（元）', 'largeExpense', `<input class="input" id="f-largeExpense" name="largeExpense" inputmode="decimal" value="${p.largeExpenseCents === null || p.largeExpenseCents === undefined ? '' : esc(String(p.largeExpenseCents / 100))}" placeholder="留空 = 提示本期最大单笔" />`)}
        ${field('超支后策略', 'overspendPolicy', `<select class="input select" id="f-overspendPolicy" name="overspendPolicy">
          ${Object.entries(POLICY_LABEL).map(([k, v]) => `<option value="${k}"${(p.overspendPolicy ?? 'allow') === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select>`)}
      </div>
      <div class="field-row">
        ${field('免打扰开始', 'dndFrom', `<input class="input" id="f-dndFrom" name="dndFrom" type="time" value="${esc(p.dndFrom ?? '')}" />`)}
        ${field('免打扰结束', 'dndTo', `<input class="input" id="f-dndTo" name="dndTo" type="time" value="${esc(p.dndTo ?? '')}" />`, '不允许跨午夜')}
      </div>
      <label class="check"><input type="checkbox" name="dndEnabled"${p.dndEnabled ? ' checked' : ''} /><span>开启免打扰时段</span></label>
      <label class="check"><input type="checkbox" name="timeProgressAlert"${p.timeProgressAlert !== false ? ' checked' : ''} /><span>开启时间进度预警</span></label>
      <div class="field" data-field="channels"><label class="field__label">提醒渠道</label>
        <div class="row row--sm row--wrap">
          ${Object.entries(CHANNEL_LABEL).map(([k, v]) => `<label class="check"><input type="checkbox" name="channels" value="${k}"${(p.channels ?? []).includes(k) ? ' checked' : ''} /><span>${esc(v)}</span></label>`).join('')}
        </div><span class="field__error"></span></div>`;
    return drawerForm({
      title: '编辑预警规则',
      body,
      onSubmit: async (f, layer) => {
        const tiers = [f.t1.value, f.t2.value, f.t3.value].map(Number);
        const largeCents = f.largeExpense.value.trim() ? parseAmountToCents(f.largeExpense.value) : null;
        const channels = [...f.querySelectorAll('[name=channels]:checked')].map((x) => x.value);
        await Api.updateBudgetPrefs(ledger.id, {
          alertTiers: tiers,
          largeExpenseCents: largeCents,
          channels,
          overspendPolicy: f.overspendPolicy.value,
          dndEnabled: f.dndEnabled.checked,
          dndFrom: f.dndFrom.value || null,
          dndTo: f.dndTo.value || null,
          timeProgressAlert: f.timeProgressAlert.checked,
        });
        layer.close();
        toast('预警规则已更新', 'success');
        await load();
      },
    });
  }

  function openReservationForm(budgetId) {
    const rows = cache.control?.ctl?.rows ?? [];
    const body = `
      <p class="bdg2-hint">承诺占用 C 是「还没落成账单的确定支出」，预留 R 是专项池预提或手工预留。
        两者都不进收支统计；兑现后要释放，否则会和已用 U 双计。</p>
      <div class="field-row">
        ${field('类型', 'kind', `<select class="input select" id="f-kind" name="kind">
          <option value="committed">承诺占用 C</option><option value="reserved">预留 R</option></select>`)}
        ${field('金额（元）', 'amount', '<input class="input" id="f-amount" name="amount" inputmode="decimal" placeholder="500.00" />')}
      </div>
      <div class="field-row">
        ${field('归属预算', 'budgetId', `<select class="input select" id="f-budgetId" name="budgetId">
          ${rows.map((r) => `<option value="${esc(r.budgetId)}"${r.budgetId === budgetId ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>`)}
        ${field('预计兑现日', 'expectedOn', `<input class="input" id="f-expectedOn" name="expectedOn" type="date" value="${esc(todayStr())}" />`)}
      </div>
      ${field('说明', 'note', '<input class="input" id="f-note" name="note" maxlength="200" placeholder="例如：已下单未付款的家电" />')}`;
    return drawerForm({
      title: '新增承诺占用 / 预留',
      body,
      onSubmit: async (f, layer) => {
        const cents = parseAmountToCents(f.amount.value);
        if (cents === null || cents <= 0) {
          toast('金额必须大于 0', 'error');
          setLoading(f.querySelector('button[type=submit]'), false);
          return;
        }
        await Api.createBudgetReservation(ledger.id, {
          kind: f.kind.value,
          amount: f.amount.value,
          budgetId: f.budgetId.value || null,
          expectedOn: f.expectedOn.value || null,
          note: f.note.value.trim() || null,
        });
        layer.close();
        toast('已占用额度', 'success');
        await load();
      },
    });
  }

  function openAdjustForm(kind) {
    const rows = cache.adjust?.progress ?? [];
    const budgetOpts = rows
      .map((r) => `<option value="${esc(r.id)}">${esc(r.categoryName ?? r.projectLabel ?? '总预算')} · ${esc(money(r.amount))}</option>`)
      .join('');

    if (kind === 'adj-append') {
      return drawerForm({
        title: '追加 / 削减预算',
        body: `${field('预算', 'budgetId', `<select class="input select" id="f-budgetId" name="budgetId">${budgetOpts}</select>`)}
          ${field('调整额（元，削减填负数）', 'delta', '<input class="input" id="f-delta" name="delta" inputmode="decimal" placeholder="200.00 或 -100.00" />')}
          ${field('调整原因', 'reason', '<input class="input" id="f-reason" name="reason" maxlength="200" placeholder="必填，会记入变更留痕" />')}`,
        onSubmit: async (f, layer) => {
          await Api.adjustBudget(ledger.id, f.budgetId.value, { delta: f.delta.value, reason: f.reason.value.trim() });
          layer.close();
          toast('调整已记录', 'success');
          await load();
        },
      });
    }
    if (kind === 'adj-transfer') {
      const src = rows.filter((r) => r.categoryId !== null);
      return drawerForm({
        title: '额度转移',
        body: `<p class="bdg2-hint">移动额度，不产生账单、账户余额不变；历史可撤销。</p>
          <div class="field-row">
            ${field('从', 'fromCategoryId', `<select class="input select" id="f-fromCategoryId" name="fromCategoryId">${src.map((r) => `<option value="${esc(r.categoryId)}">${esc(r.categoryName ?? '未分类')}</option>`).join('')}</select>`)}
            ${field('挪到', 'toCategoryId', `<select class="input select" id="f-toCategoryId" name="toCategoryId">${catOptions()}</select>`)}
          </div>
          ${field('金额（元）', 'amount', '<input class="input" id="f-amount" name="amount" inputmode="decimal" placeholder="100.00" />')}
          ${field('说明', 'note', '<input class="input" id="f-note" name="note" maxlength="200" />')}`,
        onSubmit: async (f, layer) => {
          await Api.transferBudget(ledger.id, {
            ...ym(), fromCategoryId: f.fromCategoryId.value, toCategoryId: f.toCategoryId.value,
            amount: f.amount.value, note: f.note.value.trim() || null,
          });
          layer.close();
          toast('额度已转移', 'success');
          await load();
        },
      });
    }
    if (kind === 'adj-rollover') {
      const pm = state.month === 1 ? 12 : state.month - 1;
      const py = state.month === 1 ? state.year - 1 : state.year;
      return drawerForm({
        title: '结转与负结转',
        body: `<p class="bdg2-hint">从 ${py} 年 ${pm} 月结转到 ${state.year} 年 ${state.month} 月。负结转会把超支带进本期。</p>
          ${field('模式', 'mode', `<select class="input select" id="f-mode" name="mode">
            <option value="carry">只结转正结余</option>
            <option value="carry_negative">负结转（把超支带进本期）</option>
            <option value="clear">不结转</option>
            <option value="to_savings">结余转储蓄目标</option></select>`)}
          <p class="bdg2-hint">负结转会把上期超支以负数写入本期预算，本期可用额度相应减少；这是不可逆的写入，需要二次确认。</p>
          ${field('说明', 'note', '<input class="input" id="f-note" name="note" maxlength="200" />')}`,
        onSubmit: async (f, layer) => {
          if (f.mode.value === 'carry_negative') {
            const ok = await confirmAction({
              title: '确认负结转',
              lines: [
                { text: `把 ${py} 年 ${pm} 月的超支额滚入 ${state.year} 年 ${state.month} 月？`, strong: true },
                '超支会以负数写入下期预算，下期可用额度变少；该操作会留痕但不会自动撤销。',
              ],
              confirmText: '确认带入超支',
            });
            if (!ok) {
              setLoading(f.querySelector('button[type=submit]'), false);
              return;
            }
          }
          await Api.rolloverBudget(ledger.id, {
            fromYear: py, fromMonth: pm, toYear: state.year, toMonth: state.month,
            mode: f.mode.value, note: f.note.value.trim() || null,
          });
          layer.close();
          toast('结转完成', 'success');
          await load();
        },
      });
    }
    if (kind === 'adj-template') {
      return drawerForm({
        title: '把本期存成模板',
        body: `${field('模板名', 'name', `<input class="input" id="f-name" name="name" maxlength="40" value="${esc(periodKey())} 预算" />`)}
          ${field('说明', 'note', '<input class="input" id="f-note" name="note" maxlength="200" />')}
          <p class="bdg2-hint">本期 ${rows.length} 条预算会按分类与额度存入模板；总预算行不进模板。</p>`,
        onSubmit: async (f, layer) => {
          const items = rows
            .filter((r) => r.categoryId !== null)
            .map((r) => ({ categoryId: r.categoryId, amount: r.amount }));
          if (!items.length) {
            toast('本期没有分类预算可存模板', 'default');
            setLoading(f.querySelector('button[type=submit]'), false);
            return;
          }
          await Api.saveBudgetTemplate(ledger.id, { name: f.name.value.trim(), note: f.note.value.trim() || null, items });
          layer.close();
          toast('模板已保存', 'success');
        },
      });
    }
    return null;
  }

  function openListDrawer(title, rows, render) {
    const layer = openDrawer({ title, body: rows.length ? rows.map(render).join('') : '<p class="bdg2-hint">暂无记录</p>' });
    return layer;
  }

  /* ================================================================ *
   * 事件：统一委托到常驻 frame，innerHTML 重绘不会丢监听
   * ================================================================ */
  async function archiveCurrent() {
    const p = cache.adjust?.preview;
    const ok = await confirmAction({
      title: '归档本账期预算',
      lines: [
        { text: `将 ${periodKey()} 的 ${p?.count ?? 0} 条预算写入快照并标记为归档。`, strong: true },
        '归档后该账期的执行率与差异锁定为当时的数值，之后改预算或补记账单都不会改写历史。',
        '数据不会被删除；复盘仍可回看，年度趋势改读快照。',
      ],
      confirmText: '确认归档',
    });
    if (!ok) return;
    const out = (await Api.archiveBudgetPeriod(ledger.id, ym())).data;
    toast(`已归档 ${out.archived} 条预算`, 'success');
    await load();
  }

  const clickHandlers = {
    async refresh() {
      await load();
    },
    month() {
      openMonthCalendar();
    },
    async stage(el) {
      state.stage = el.dataset.stage;
      paintTabs();
      await load();
    },
    async 'add-budget'() {
      openBudgetForm(null);
    },
    async 'edit-budget'(el) {
      const row = (cache.plan?.progress ?? []).find((r) => r.id === el.dataset.id);
      openBudgetForm(row ?? null);
    },
    async 'del-budget'(el) {
      const row = (cache.plan?.progress ?? []).find((r) => r.id === el.dataset.id);
      const ok = await confirmAction({
        title: '删除预算',
        lines: [
          { text: `删除「${row?.categoryName ?? row?.projectLabel ?? '总预算'}」？`, strong: true },
          '删除后本期的执行率、对照表与排行都会重新计算；历史账单不受影响。',
        ],
        confirmText: '删除',
      });
      if (!ok) return;
      await Api.deleteBudget(ledger.id, el.dataset.id);
      toast('预算已删除', 'success');
      await load();
    },
    /** 五种编制方法的「打开」= 直接新建预算，预填方法 + 关联默认字段，仍可逐项编辑 */
    async method(el) {
      openBudgetForm(null, el.dataset.method);
    },
    /** 原有的预览 / 批量生成能力保留在这个次要入口，功能不丢 */
    async 'method-tools'(el) {
      openMethodDrawer(el.dataset.method);
    },
    async 'resv-new'(el) {
      openReservationForm(el.dataset.id);
    },
    'resv-detail'(el) {
      const row = (cache.control?.ctl?.rows ?? []).find((r) => r.budgetId === el.dataset.id);
      const list = row?.reservations ?? [];
      const body = `<p class="tt-body-strong" style="margin:0 0 8px">${esc(row?.label ?? '预算')}</p>
        ${list.length
          ? list
              .map((x) => `<p class="tt-caption" style="margin:0 0 6px">${esc(x.kind === 'committed' ? '承诺占用' : '预留')} · ${esc(money(x.amount))}
                <br><span class="bdg2-hint">${esc(x.expectedOn ?? '未填兑现日')} · ${esc(x.note ?? x.source)}</span></p>`)
              .join('')
          : '<p class="bdg2-hint">这条预算还没有占用或预留</p>'}
        <p class="bdg2-hint">可用额度 A = B − U − C − R。兑现后请到占用记录里释放，避免与已用 U 双计。</p>`;
      openPopover(el, body, { width: 300 });
    },
    async 'prefs-edit'() {
      openPrefsForm();
    },
    async 'adj-append'() {
      openAdjustForm('adj-append');
    },
    async 'adj-transfer'() {
      openAdjustForm('adj-transfer');
    },
    async 'adj-rollover'() {
      openAdjustForm('adj-rollover');
    },
    async 'adj-template'() {
      openAdjustForm('adj-template');
    },
    async 'adj-copy-prev'() {
      const pm = state.month === 1 ? 12 : state.month - 1;
      const py = state.month === 1 ? state.year - 1 : state.year;
      const ok = await confirmAction({
        title: '从上月复制预算',
        lines: [
          { text: `把 ${py} 年 ${pm} 月的预算复制到 ${state.year} 年 ${state.month} 月？`, strong: true },
          '本月已存在的预算不会被覆盖。',
        ],
        confirmText: '复制',
        danger: false,
      });
      if (!ok) return;
      const out = (await Api.copyBudgetFromPrevious(ledger.id, {
        fromYear: py, fromMonth: pm, toYear: state.year, toMonth: state.month,
      })).data;
      toast(out.created ? `已复制 ${out.created} 条，跳过 ${out.skipped ?? 0} 条` : '上月没有可复制的预算', out.created ? 'success' : 'default');
      await load();
    },
    async 'adj-changes'() {
      const rows = (await Api.listBudgetChanges(ledger.id, { limit: 50 })).data ?? [];
      openListDrawer('变更留痕', rows, (c) => `<div class="recon-line">
        <span class="tt-caption">${esc(c.action ?? '调整')}</span>
        <span class="tt-caption tnum">${esc(c.createdAt ?? '')}</span>
        <span class="bdg2-hint">${esc(c.note ?? '')}</span></div>`);
    },
    async 'adj-transfers'() {
      const rows = (await Api.listBudgetTransfers(ledger.id, ym())).data ?? [];
      const layer = openListDrawer('调拨记录', rows, (t) => `<div class="recon-line">
        <span class="tt-caption">${esc(t.fromCategoryName ?? '?')} → ${esc(t.toCategoryName ?? '?')}</span>
        <span class="tt-caption tnum">${esc(money(t.amount))}</span>
        <button class="btn btn--quiet btn--sm" type="button" data-revoke="${esc(t.id)}">撤销</button></div>`);
      layer?.body?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-revoke]');
        if (!btn) return;
        try {
          await Api.revokeBudgetTransfer(ledger.id, btn.dataset.revoke);
          layer.close();
          toast('已撤销调拨', 'success');
          await load();
        } catch (err) {
          toast(err?.message ?? '撤销失败', 'error');
        }
      });
    },
    async 'adj-archive'() {
      await archiveCurrent();
    },
    'review-attr'(el) {
      const r = (cache.review?.review?.rows ?? [])[Number(el.dataset.idx)];
      if (!r) return;
      const body = `<p class="tt-body-strong" style="margin:0 0 8px">${esc(r.label)} · 差异归因</p>
        ${(r.attributions ?? []).map((a) => `<p class="tt-caption" style="margin:0 0 6px">${esc(a.text)}</p>`).join('')}
        <p class="bdg2-hint">归因是可解释的启发式结论，每条都基于本期账单与时间进度，不做黑盒推断。</p>`;
      openPopover(el, body, { width: 320 });
    },
    async 'gen-next'() {
      const sug = cache.review?.suggestions;
      const items = (sug?.items ?? []).map((x) => ({
        categoryId: x.categoryId, amount: x.suggestedAmount, budgetKind: x.budgetKind,
        scope: x.scope, scopeId: x.scopeId, projectLabel: x.projectLabel,
      }));
      if (!items.length) {
        toast('没有可生成的建议', 'default');
        return;
      }
      const ok = await confirmAction({
        title: '生成下期预算',
        lines: [
          { text: `按建议生成 ${sug.nextPeriod} 的 ${items.length} 条预算？`, strong: true },
          '已存在的预算不会被覆盖；生成后可在「编制」阶段逐条修改。',
        ],
        confirmText: '生成',
        danger: false,
      });
      if (!ok) return;
      const out = (await Api.generateNextBudgets(ledger.id, { ...ym(), items })).data;
      toast(`新建 ${out.created} 条，跳过 ${out.skipped} 条`, 'success');
      await load();
    },
  };

  frame.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !frame.contains(el)) return;
    const fn = clickHandlers[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve(fn(el, e)).catch((err) => toast(err?.message ?? '操作失败', 'error'));
  });

  frame.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.role === 'month') {
      const [y, m] = el.value.split('-').map(Number);
      state.year = y;
      state.month = m;
      load().catch(() => {});
    } else if (el.dataset.role === 'dim') {
      const c = (cache.control?.choices ?? [])[Number(el.value)];
      if (!c) return;
      state.dim = c.key;
      state.dimId = c.id;
      load().catch(() => {});
    } else if (el.dataset.role === 'archived' && el.value) {
      Api.archivedBudgetSnapshot(ledger.id, el.value)
        .then((r) => {
          const rows = r.data ?? [];
          openListDrawer(`${monthLabel(el.value)} 归档快照`, rows, (x) => `<div class="recon-line">
            <span class="tt-caption">${esc(x.label)}</span>
            <span class="tt-caption tnum">预算 ${esc(money(x.amount))}</span>
            <span class="tt-caption tnum">实际 ${esc(money(x.actual))}</span>
            <span class="tt-caption tnum">差异 ${esc(money(x.variance))} · ${esc(pct(x.varianceRatio))}</span></div>`);
        })
        .catch((err) => toast(err?.message ?? '读取快照失败', 'error'));
    }
  });

  /* ---------------- 与账单联动的局部刷新 ---------------- */
  const listeners = [];
  const on = (target, evt, fn) => {
    target.addEventListener(evt, fn);
    listeners.push([target, evt, fn]);
  };
  const cleanup = () => {
    listeners.forEach(([t, evt, fn]) => t.removeEventListener(evt, fn));
    if (pollTimer) clearInterval(pollTimer);
    closeAllOverlays();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;

  const softRefresh = () => {
    if (!frame.isConnected) {
      cleanup();
      return;
    }
    if (document.hidden) return;
    /* 只重绘阶段容器：月份、维度、分段控件与滚动位置都不动 */
    load().catch(() => {});
  };
  let pollTimer = setInterval(softRefresh, 30000);
  on(window, 'focus', softRefresh);
  on(document, 'visibilitychange', softRefresh);
  on(window, 'cc:ledger-data-changed', softRefresh);

  paintMonthTrigger();
  paintTabs();
  await load();
  return cleanup;
}
