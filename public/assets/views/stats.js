/**
 * 报表页（对标主流记账 App）。
 *
 * ## 这一页的组织原则
 *
 * **自上而下 = 从粗到细**。用户看报表的心理顺序是：
 *   ① 我这期间总体怎么样（KPI）
 *   ② 比之前是好了还是差了（对比）
 *   ③ 钱都去哪了（构成）
 *   ④ 什么时候花的、谁花的、从哪张卡出的（细粒度维度）
 *
 * 所以 11 个模块按这个顺序排，而不是按「实现难度」或「接口可用性」排。
 * 任何把「账户明细表」放在「KPI」之上的排法，都是在逼用户先读细节再找结论。
 *
 * ## 为什么不复用旧的「趋势 → 占比 → 账户」三块
 *
 * 旧布局只有 3 个图，回答不了「谁花的」「哪天花的多」「这张卡剩多少」。
 * 这页的定位是**报表**（定期回看、做决策），不是**速览**（随手一瞥）。
 *
 * ## 金额与日期格式
 *
 * 全页统一：金额走 `money()`（¥ + 千分位 + 两位小数），日期 YYYY-MM-DD。
 * 这两条是硬要求 —— 同一个页面里出现两种金额格式，用户会开始怀疑数字。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { ACCOUNT_TYPE_LABEL, esc, icon, money, toast } from '../ui.js';
import { downloadTextFile } from '../lib/download.js';
import {
  attachTips,
  bars,
  donut,
  groupedBars,
  lineChart,
  PALETTE,
  pie,
  rankTable,
  stackedArea,
} from '../lib/charts.js';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 账期快捷选项。
 *
 * `近12月` 是滚动 12 个月（不是「今年」）—— 报表页要能看出季节性，
 * 而「今年」在 3 月只有 3 个月数据，看不出任何趋势。
 */
const QUICK = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '本年' },
  { key: 'last12', label: '近12月' },
];

const TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  receivable: '应收款项',
  payable: '应付款项',
  transfer: '转账',
  adjustment: '余额调整',
};

function weekRange(offset = 0) {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: iso(mon), to: iso(sun) };
}
function monthRange(offset = 0) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  const to = offset === 0 && end > now ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : end;
  return { from: iso(from), to: iso(to) };
}
function yearRange(offset = 0) {
  const y = new Date().getFullYear() + offset;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}
function last12Range() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: iso(from), to: iso(to) };
}

/** 账期切换：按当前区间的**跨度类型**平移，而不是死板地按月移 */
function shiftRange(range, dir) {
  const f = new Date(`${range.from}T00:00:00`);
  const t = new Date(`${range.to}T00:00:00`);
  const days = Math.round((t - f) / 86400000) + 1;
  if (days <= 7) return { from: iso(new Date(f.setDate(f.getDate() + dir * 7))), to: iso(new Date(t.setDate(t.getDate() + dir * 7))) };
  if (days <= 31) {
    const nf = new Date(f.getFullYear(), f.getMonth() + dir, 1);
    const nt = new Date(f.getFullYear(), f.getMonth() + dir + 1, 0);
    return { from: iso(nf), to: iso(nt) };
  }
  return yearRange((new Date(`${range.from}T00:00:00`).getFullYear() - new Date().getFullYear()) + dir);
}

const periodLabel = (r) => {
  if (!r?.from) return '自定义';
  // 同一自然月 → 「2026-10」；否则给区间
  const f = r.from.slice(0, 7);
  return f === r.to.slice(0, 7) ? f : `${r.from} ~ ${r.to}`;
};

export async function renderStats(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  /* ---------------- 状态 ---------------- */

  /**
   * 筛选状态。
   * `manualRange` 标记「用户手填过日期」—— 一旦为真，账期切换器改为
   * 按用户填的区间平移，而不是回到快捷选项。
   */
  const filters = {
    quick: 'month',
    manualRange: false,
    dateFrom: '',
    dateTo: '',
    types: new Set(),
    accountId: '',
    parentCategoryId: '',
    categoryId: '',
    keyword: '',
  };

  /**
   * ⚠️ 自定义区间必须**两个日期都填**才生效。
   *
   * 用户把结束日期清空时，`{from:'2026-10-01', to:''}` 会被直接发给后端 ——
   * `to` 是空字符串，后端 `lte(txDate, '')` 匹配不到任何行，
   * 于是页面显示「这个区间没有任何数据」而没有任何报错指向日期框被清空了。
   * 缺一个就退回本月，至少用户看到的是「有数据的本月」而不是「空报表」。
   */
  const activeRange = () => {
    if (filters.manualRange && filters.dateFrom && filters.dateTo) {
      return { from: filters.dateFrom, to: filters.dateTo };
    }
    if (filters.quick === 'week') return weekRange(0);
    if (filters.quick === 'year') return yearRange(0);
    if (filters.quick === 'last12') return last12Range();
    return monthRange(0);
  };

  /** 手机端「更多」折叠区是否展开（桌面端恒常显，这个值不参与桌面渲染） */
  let moreOpen = false;

  /** 除账期以外还有没有在筛选 —— 决定「重置」按钮要不要出现 */
  const hasExtraFilters = () =>
    Boolean(filters.types.size || filters.accountId || filters.parentCategoryId || filters.categoryId || filters.keyword);

  const queryOf = () => {
    const r = activeRange();
    return {
      dateFrom: r.from,
      dateTo: r.to,
      ...(filters.types.size ? { recordType: [...filters.types].join(',') } : {}),
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.parentCategoryId ? { parentCategoryId: filters.parentCategoryId } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.keyword ? { keyword: filters.keyword } : {}),
    };
  };

  /** 账单列表跳转：带上当前全部筛选 */
  const txHref = (extra = {}) => {
    const q = queryOf();
    const sp = new URLSearchParams();
    if (q.recordType) sp.set('recordType', q.recordType);
    if (q.dateFrom) sp.set('dateFrom', q.dateFrom);
    if (q.dateTo) sp.set('dateTo', q.dateTo);
    if (q.accountId) sp.set('accountId', q.accountId);
    if (q.keyword) sp.set('keyword', q.keyword);
    if (q.parentCategoryId && !extra.categoryId) sp.set('parentCategoryId', q.parentCategoryId);
    for (const [k, v] of Object.entries(extra)) if (v) sp.set(k, v);
    return `/transactions?${sp.toString()}`;
  };

  let metaAccounts = [];
  let catTree = { expense: [], income: [], receivable: [], payable: [] };
  const accountName = (id) => metaAccounts.find((a) => a.id === id)?.name ?? '该账户';
  const categoryName = (id) => {
    for (const list of Object.values(catTree)) {
      for (const p of list) {
        if (p.id === id) return p.name;
        const c = (p.children ?? []).find((x) => x.id === id);
        if (c) return `${p.name} › ${c.name}`;
      }
    }
    return '该分类';
  };

  /* ---------------- 骨架 ---------------- */

  const frame = appFrame({
    active: 'stats',
    user: me,
    ledger,
    inner: `
      <!--
        标题行：动作按钮（导出 / 导入）与标题**同行右对齐**。
        写法照抄账户页的既有实现（.page__hero > .row.row--between >
        左「标题 + 副标题」/ 右 .row 按钮组），没有新增任何自定义组件。
      -->
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">统计</h1>
            <p class="tt-caption text-muted">${esc(ledger.name)} · 口径与概览、对账完全一致</p>
          </div>
          <!--
            手机端整行不渲染（mobile.css 的 [data-role=report-actions]）：
            统计页是**看结果**的地方，导出 / 导入是「拿着结果去干活」，
            不该在看结果之前占掉一整行。账单页顶部已有「导出」，
            导入也从对账明细里能进，手机上不缺入口。
            桌面端保留（左栏导航没有导入，报表导出也只在统计页）。
          -->
          <div class="row" data-role="report-actions">
            <button class="btn btn--quiet btn--sm" type="button" data-role="export">导出报表</button>
            <a class="btn btn--quiet btn--sm" href="/import" data-link>导入账目</a>
          </div>
        </div>
      </div>

      <!--
        模块 1：全局筛选栏。

        形态是**一条工具条**，不是一张表单。
        旧版是 8 个带标签的下拉排满两行，高度 200px+，把报表页的顶部空间全吃掉了；
        而筛选是**高频微调**（改个账期、换个分类），不该占据主视觉。
        主流记账 App（随手记 / 钱迹 / Monarch）的做法都是「一行工具条 + 条件芯片」，
        控件靠 placeholder 自述，不逐个挂 label。

        账期前后翻页（‹ ›）并进这条工具条，原来那条**独占一行的居中切换器**
        已删除：它只放了三个元素却占满一整行，而它要表达的信息
        （「当前是哪个账期」）已经由右边的条件芯片给出。
      -->
      <section class="section st-filter">
        <div class="card st-filter__card">
          <div class="st-filter__bar">
            <!-- 分段控件随筛选状态重画，所以是空槽 -->
            <div class="segmented st-filter__seg" role="group" aria-label="账期快捷选择" data-role="quick"></div>

            <!--
              「更多」紧跟在「自定义」之后（DOM 上是 seg 的下一个兄弟）。
              不放进 seg 内部：seg 在手机端是横滑带，塞进去的按钮会被滑出屏幕，
              而它恰恰是最该常驻的那个。桌面端此按钮隐藏，筛选面板常驻展开。
            -->
            <button class="st-filter__more" type="button" data-role="more"
                    aria-expanded="false" aria-controls="st-filter-more-zone">更多</button>

            <div class="st-filter__stepper">
              <button class="btn btn--quiet btn--icon btn--sm" type="button" data-role="prev"
                      aria-label="上一账期">‹</button>
              <span class="st-filter__period tnum" data-role="period-label"></span>
              <button class="btn btn--quiet btn--icon btn--sm" type="button" data-role="next"
                      aria-label="下一账期">›</button>
            </div>

            <div class="st-filter__acts">
              <button class="btn btn--quiet btn--sm" type="button" data-role="reset" hidden>重置</button>
            </div>
          </div>

          <!--
            筛选面板（来源 / 类型 / 分类 / 搜索）。
            桌面端是工具条下方的常驻面板，独立于工具条一行，所有筛选项始终完整展示；
            手机端收进折叠区，由上方「更多」控制显隐。
            结构上与 .st-filter__bar 同级，不再靠 display:contents 把控件塞回工具条。
          -->
          <div class="st-filter__zone" id="st-filter-more-zone" data-role="more-zone" data-more="off">
            <div class="st-filter__picks" data-role="picks"></div>

            <label class="st-filter__search">
              <span class="st-filter__search-ico" aria-hidden="true">${icon('search', 14)}</span>
              <input class="input st-filter__kw" type="search" id="st-f-kw"
                     placeholder="搜索对象 / 名称 / 商家" autocomplete="off" />
            </label>

            <!-- 展开态的收起入口：与「更多」同一个动作，出现在用户滑到的地方 -->
            <button class="st-filter__zone-collapse" type="button" data-role="collapse">收起</button>
          </div>

          <!-- 自定义区间：只在真的在自定义时才出现，否则就是两行没人看的日期框 -->
          <div class="st-filter__range" data-role="range-row" hidden>
            <span class="st-filter__range-label">自定义账期</span>
            <input class="input st-filter__date" type="date" id="st-f-from" aria-label="开始日期" />
            <span class="st-filter__tilde" aria-hidden="true">→</span>
            <input class="input st-filter__date" type="date" id="st-f-to" aria-label="结束日期" />
          </div>

          <!-- 条件芯片：筛选是**不可见状态**，必须显式写出来，且要能一键摘掉某一项 -->
          <div class="st-filter__chips st-filter-sum" data-role="filter-sum"></div>
        </div>
      </section>

      <!--
        Bento 栅格（12 列 / 列间距 8px / 卡片间距 20px）。

        顺序即优先级，六排的体量节奏是「小 → 大 → 小」：
          ① 4 张 KPI（各 3 列）
          ② 对比表 4 + 趋势图 8（主视觉）
          ③ 构成 / 每日 / 星期 各 4
          ④ 净资产 8 + 成员 4
          ⑤ 分类排行 12
          ⑥ 账户一览 12

        排行与账户**各自独占一行**（原先是 8 + 4 挤在同一排）：
        两张都是「多列字段」的表，塞进 4 栅格时字段被压到折行、金额互相盖住；
        整宽之后列才能均分，数字才能对齐。

        KPI 那 4 张卡**直接**是栅格项（外层用 display:contents 让子元素参与父栅格），
        而不是再来一层 12 列嵌套 —— 嵌套栅格要重复算一遍列宽，改间距时两处必须同步改，
        迟早对不齐。
      -->
      <div class="grid report-grid">
        <div class="st-kpi-row" data-role="kpi"></div>
        <section class="section span-4" data-role="compare"></section>
        <section class="section span-8" data-role="m-trend12"></section>
        <section class="section span-4" data-role="m-donut"></section>
        <section class="section span-4" data-role="m-daily"></section>
        <section class="section span-4" data-role="m-weekday"></section>
        <section class="section span-8" data-role="m-networth"></section>
        <section class="section span-4" data-role="m-member"></section>
        <section class="section span-12" data-role="m-rank"></section>
        <section class="section span-12" data-role="m-accounts"></section>
      </div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'stats', go, ledger });
  /** 报表页内容多，内容锁宽提到 1440px（00-DESIGN：≥1441px 由外边距吸收多余宽度） */
  frame.querySelector('.page')?.classList.add('page--report');

  const $ = (sel) => frame.querySelector(sel);
  const slotKpi = $('[data-role=kpi]');
  const slotCmp = $('[data-role=compare]');
  const slotTrend12 = $('[data-role=m-trend12]');
  const slotDonut = $('[data-role=m-donut]');
  const slotRank = $('[data-role=m-rank]');
  const slotDaily = $('[data-role=m-daily]');
  const slotWeekday = $('[data-role=m-weekday]');
  const slotMember = $('[data-role=m-member]');
  const slotNetWorth = $('[data-role=m-networth]');
  const slotAccounts = $('[data-role=m-accounts]');

  /** 筛选栏的静态控件只绑一次（重建的部分走委托，不需要重挂） */
  wireFilterControls();

  /* ---------------- 元数据 ---------------- */

  try {
    metaAccounts = ((await Api.listAccounts(ledger.id)).data ?? []).filter((a) => a.kind !== 'virtual');
  } catch {
    metaAccounts = [];
  }
  await Promise.all(
    ['expense', 'income', 'receivable', 'payable'].map(async (rt) => {
      try {
        catTree[rt] = (await Api.listCategories(ledger.id, { recordType: rt })).data ?? [];
      } catch {
        catTree[rt] = [];
      }
    }),
  );

  /* ---------------- 模块 1：全局筛选栏 ---------------- */

  /* ---------------- 模块 1：全局筛选栏 ---------------- */

  /**
   * 筛选栏是一条**工具条**，不是一张表单。三条关键取舍：
   *
   * ① 不给每个控件挂 label。旧版 8 个带标签的下拉排满两行、吃掉 200px+ 高度，
   *    而筛选是「改一下就看结果」的高频微调，不该占据报表页的主视觉高度。
   *    控件少且自述性强（「全部来源」「全部类型」本身就是说明）。
   *
   * ② 一级 + 二级合并成一个分类下拉。旧版要先选一级才能选二级，中间还有一次重绘；
   *    合并后用 optgroup 分组，一次点开全部可见，同时保留「整个一级」这个选项 ——
   *    否则用户没法只看一级汇总。
   *
   * ③ 条件芯片可逐个摘掉。摘要写成一句话时，想去掉其中一条得回到对应下拉去改；
   *    写成芯片后点一下就摘掉，少一次「找到控件在哪」的搜索。
   */
  function paintFilters() {
    /**
     * 分类筛选提示：无选择 → 「全部分类」；选了子分类 → 「父 › 子」；
     * 选了整个一级 → 「父（全部）」。
     */
    const catHint = () => {
      if (filters.categoryId) return categoryName(filters.categoryId);
      if (filters.parentCategoryId) return `${categoryName(filters.parentCategoryId)}（全部）`;
      return '全部分类';
    };

    const seg = $('[data-role=quick]');
    if (seg) {
      seg.innerHTML =
        QUICK.map(
          (q) =>
            `<button class="segmented__item st-filter__segitem" type="button" data-quick="${q.key}"
               aria-pressed="${!filters.manualRange && filters.quick === q.key}">${esc(q.label)}</button>`,
        ).join('') +
        `<button class="segmented__item st-filter__segitem" type="button" data-role="custom"
           aria-pressed="${filters.manualRange}">自定义</button>`;
    }

    const picks = $('[data-role=picks]');
    if (picks) {
      picks.innerHTML = `
        <select class="st-filter__pick select" id="st-f-source" aria-label="来源账户">
          <option value="">全部来源</option>
          ${metaAccounts
            .map(
              (a) =>
                `<option value="${esc(a.id)}"${filters.accountId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`,
            )
            .join('')}
        </select>
        <select class="st-filter__pick select" id="st-f-type" aria-label="记账类型">
          <option value="">全部类型</option>
          ${['expense', 'income', 'receivable', 'payable']
            .map(
              (t) =>
                `<option value="${t}"${filters.types.has(t) ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`,
            )
            .join('')}
        </select>
        <button type="button" class="st-filter__pick st-filter__pick--cat" id="st-f-cat"
                aria-label="分类" aria-haspopup="dialog" aria-expanded="false">
          <span class="st-filter__pick-label">${esc(catHint())}</span>
          ${icon('chevron-down', 14)}
        </button>`;
    }

    const rangeRow = $('[data-role=range-row]');
    if (rangeRow) {
      rangeRow.hidden = !filters.manualRange;
      const from = $('#st-f-from');
      const to = $('#st-f-to');
      if (from) from.value = filters.dateFrom;
      if (to) to.value = filters.dateTo;
    }

    const kwEl = $('#st-f-kw');
    if (kwEl && kwEl.value !== filters.keyword) kwEl.value = filters.keyword;

    const resetBtn = $('[data-role=reset]');
    if (resetBtn) resetBtn.hidden = !filters.manualRange && !hasExtraFilters();

    paintMore();
    paintFilterSummary();
  }

  /**
   * 「更多 / 收起」—— 手机端把「三个下拉 + 搜索框」收进折叠区。
   *
   * 状态写在 `[data-role=more-zone][data-more]` 上，**显隐交给 CSS**：
   * 桌面端这块是 `display: contents`（直接参与工具条排布），
   * 属性写了也不起作用 —— 这正是要的效果：桌面没有「更多」按钮，
   * 也就永远不会把工具条折叠掉。
   */
  function paintMore() {
    const more = $('[data-role=more]');
    const zone = $('[data-role=more-zone]');
    const n =
      filters.types.size +
      (filters.accountId ? 1 : 0) +
      (filters.parentCategoryId || filters.categoryId ? 1 : 0) +
      (filters.keyword ? 1 : 0);
    if (more) {
      more.textContent = n ? `更多 · ${n}` : '更多';
      more.setAttribute('aria-expanded', String(moreOpen));
      more.classList.toggle('is-on', n > 0);
    }
    if (zone) zone.dataset.more = moreOpen ? 'on' : 'off';
  }

  function setMore(open) {
    moreOpen = open;
    paintMore();
  }

  /**
   * 事件统一**委托**到筛选卡片上，只绑一次。
   *
   * 为什么委托：分段控件与条件芯片都是 paintFilters 重建出来的，
   * 重建后逐个 addEventListener 会得到「同一个按钮挂了 N 次」的重复触发；
   * 绑在不变的容器上则无论内部怎么重建都只有一份监听器。
   */
  function wireFilterControls() {
    const card = $('.st-filter__card');
    if (!card) return;

    card.addEventListener('click', (e) => {
      const quick = e.target.closest('[data-quick]');
      if (quick) {
        filters.quick = quick.dataset.quick;
        filters.manualRange = false;
        filters.dateFrom = '';
        filters.dateTo = '';
        paintFilters();
        load();
        return;
      }
      if (e.target.closest('[data-role=custom]')) {
        /**
         * 切进自定义时把**当前区间原样带进去**。
         * 用户点「自定义」是想微调，不是想从两个空日期框开始填 ——
         * 带进去之后他只需要改一头。
         */
        const r = activeRange();
        filters.dateFrom = r.from;
        filters.dateTo = r.to;
        filters.manualRange = true;
        paintFilters();
        load();
        return;
      }
      if (e.target.closest('#st-f-cat')) {
        openCatModal();
        return;
      }
      if (e.target.closest('[data-role=more]')) {
        setMore(!moreOpen);
        return;
      }
      if (e.target.closest('[data-role=collapse]')) {
        setMore(false);
        return;
      }
      if (e.target.closest('[data-role=reset]')) {
        filters.quick = 'month';
        filters.manualRange = false;
        filters.dateFrom = '';
        filters.dateTo = '';
        filters.types = new Set();
        filters.accountId = '';
        filters.parentCategoryId = '';
        filters.categoryId = '';
        filters.keyword = '';
        paintFilters();
        load();
        return;
      }
      const clear = e.target.closest('[data-clear]');
      if (clear) {
        const k = clear.dataset.clear;
        if (k === 'type') filters.types = new Set();
        if (k === 'source') filters.accountId = '';
        if (k === 'cat') {
          filters.parentCategoryId = '';
          filters.categoryId = '';
        }
        if (k === 'kw') filters.keyword = '';
        paintFilters();
        load();
      }
    });

    card.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'st-f-source') {
        filters.accountId = t.value;
        paintFilters();
        load();
        return;
      }
      if (t.id === 'st-f-type') {
        filters.types = t.value ? new Set([t.value]) : new Set();
        filters.parentCategoryId = '';
        filters.categoryId = '';
        paintFilters();
        load();
        return;
      }
      if (t.id === 'st-f-from' || t.id === 'st-f-to') {
        filters.dateFrom = $('#st-f-from')?.value ?? '';
        filters.dateTo = $('#st-f-to')?.value ?? '';
        filters.manualRange = true;
        paintFilters();
        load();
      }
    });

    let kwTimer = null;
    card.addEventListener('input', (e) => {
      if (e.target.id !== 'st-f-kw') return;
      const v = e.target.value.trim();
      clearTimeout(kwTimer);
      kwTimer = setTimeout(() => {
        if (filters.keyword === v) return;
        filters.keyword = v;
        paintFilterSummary();
        load();
      }, 400);
    });
  }

  /**
   * 条件芯片。**必须常显** —— 账期本身就是筛选条件，
   * 用户截图给客服时对方看到的是一个「看起来没筛选」的页面，
   * 而数据其实是某个特定月份的。
   */
  function paintFilterSummary() {
    const slot = $('[data-role=filter-sum]');
    if (!slot) return;
    const chip = (key, label) =>
      `<button class="chip chip--mini st-chip" type="button" data-clear="${key}"
         aria-label="清除条件 ${esc(label)}">${esc(label)}<span class="st-chip__x" aria-hidden="true">×</span></button>`;
    const chips = [
      /** 账期不可摘：摘掉它就没有「本周期」这个概念了，所以它不是按钮 */
      `<span class="st-chip st-chip--fixed">账期 ${esc(periodLabel(activeRange()))}</span>`,
    ];
    if (filters.types.size) {
      chips.push(chip('type', `类型 ${[...filters.types].map((t) => TYPE_LABEL[t]).join('/')}`));
    }
    if (filters.accountId) chips.push(chip('source', `来源 ${accountName(filters.accountId)}`));
    if (filters.categoryId) chips.push(chip('cat', `分类 ${categoryName(filters.categoryId)}`));
    else if (filters.parentCategoryId) {
      chips.push(chip('cat', `分类 ${categoryName(filters.parentCategoryId)}（全部）`));
    }
    if (filters.keyword) chips.push(chip('kw', `搜索 ${filters.keyword}`));
    slot.innerHTML = chips.join('');
  }

  /* ---------------- 模块 1b：分类树 modal ---------------- */

  /**
   * 分类筛选从「超长的全部分类下拉」改为**模态树状逐级筛选**。
   *
   * 为什么是模态而不是内联下拉：
   * 旧版 `#st-f-cat` 把「一级 + 二级」全塞进一个 select（optgroup），
   * 分类一多就长得超出视口、且无法在二级之间快速跳转。
   * 改成居中弹窗 + 压暗遮罩，内部用树状结构（类型 → 一级 → 二级）逐级展开，
   * 既解决长度问题，也让「看整个大类」与「只看某个二级」两种意图都一目了然。
   *
   * 复用既有 `.modal` 设计系统（`.modal / .modal__scrim / .modal__panel`），
   * 桌面端居中、移动端自动变为底部 sheet（见 `app.css` 的 `.modal` 媒体查询）。
   */

  /** 哪些类型要作为树顶展示：单选某类型只看该类型；未选 / 多选则四个类型都列出来 */
  const catTypeKeys = () =>
    filters.types.size === 1 ? [[...filters.types][0]] : ['expense', 'income', 'receivable', 'payable'];

  /** 已展开的一级分类（会话内记忆，关弹窗不清） */
  let expandedParents = new Set();

  function catNodeHtml(p, typeKey) {
    const kids = p.children ?? [];
    const isOpen = expandedParents.has(p.id);
    const selParent = filters.parentCategoryId === p.id && !filters.categoryId;
    const top = `
      <div class="cat-node cat-node--parent${selParent ? ' is-sel' : ''}">
        <button class="cat-node__toggle" type="button" data-act="toggle" data-id="${esc(p.id)}"
                aria-label="展开或收起" aria-expanded="${isOpen}">${icon(isOpen ? 'chevron-down' : 'chevron', 14)}</button>
        <button class="cat-node__label" type="button" data-act="pick-parent" data-type="${esc(typeKey)}" data-id="${esc(p.id)}">
          <span class="cat-node__name">${esc(p.name)}</span>
          <span class="cat-node__tag">全部</span>
        </button>
        ${kids.length ? `<span class="cat-node__count">${kids.length}</span>` : ''}
      </div>`;
    const children = isOpen && kids.length
      ? kids
          .map((c) => {
            const sel = filters.categoryId === c.id;
            return `<div class="cat-node cat-node--child${sel ? ' is-sel' : ''}">
              <button class="cat-node__label" type="button" data-act="pick-child" data-type="${esc(typeKey)}" data-id="${esc(c.id)}">
                <span class="cat-node__name">${esc(c.name)}</span>
              </button>
            </div>`;
          })
          .join('')
      : '';
    return top + children;
  }

  function paintCatTree() {
    const body = $('[data-role=cat-tree]');
    if (!body) return;
    const keys = catTypeKeys();
    const showTypeHeaders = keys.length > 1;
    body.innerHTML = keys
      .map((tk) => {
        const list = catTree[tk] ?? [];
        const header = showTypeHeaders ? `<div class="cat-type">${esc(TYPE_LABEL[tk] ?? tk)}</div>` : '';
        const nodes = list.length
          ? list.map((p) => catNodeHtml(p, tk)).join('')
          : `<div class="cat-empty">该类型暂无分类</div>`;
        return header + nodes;
      })
      .join('');
  }

  function onCatKeydown(e) {
    if (e.key === 'Escape') closeCatModal();
  }

  function openCatModal() {
    ensureCatModal();
    // 自动展开当前选择所在的枝
    if (filters.parentCategoryId) expandedParents.add(filters.parentCategoryId);
    else if (filters.categoryId) {
      for (const list of Object.values(catTree)) {
        for (const p of list) {
          if ((p.children ?? []).some((c) => c.id === filters.categoryId)) {
            expandedParents.add(p.id);
            break;
          }
        }
      }
    }
    paintCatTree();
    const m = $('.cat-modal');
    if (m) m.hidden = false;
    $('#st-f-cat')?.setAttribute('aria-expanded', 'true');
    frame.addEventListener('keydown', onCatKeydown);
  }

  function closeCatModal() {
    const m = $('.cat-modal');
    if (m) m.hidden = true;
    $('#st-f-cat')?.setAttribute('aria-expanded', 'false');
    frame.removeEventListener('keydown', onCatKeydown);
  }

  /** 懒构建一次，挂在 frame 上（切页时随 frame 一起被回收） */
  function ensureCatModal() {
    if ($('.cat-modal')) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal cat-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '选择分类');
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="modal__scrim" data-role="cat-close"></div>
      <div class="modal__panel" role="document">
        <div class="modal__head">
          <h2 class="modal__title">选择分类</h2>
          <button class="modal__close" type="button" aria-label="关闭" data-role="cat-close">${icon('close', 18)}</button>
        </div>
        <div class="modal__body cat-tree" data-role="cat-tree"></div>
        <div class="modal__foot">
          <button class="btn btn--ghost btn--sm" type="button" data-role="cat-clear">清除分类</button>
          <button class="btn btn--primary btn--sm" type="button" data-role="cat-close">完成</button>
        </div>
      </div>`;
    frame.appendChild(wrap);

    // 关闭：遮罩 / 完成 / 关闭按钮
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-role=cat-close]')) {
        closeCatModal();
        return;
      }
      if (e.target.closest('[data-role=cat-clear]')) {
        filters.parentCategoryId = '';
        filters.categoryId = '';
        closeCatModal();
        paintFilters();
        load();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = act.dataset.id;
      const type = act.dataset.type;
      if (act.dataset.act === 'toggle') {
        if (expandedParents.has(id)) expandedParents.delete(id);
        else expandedParents.add(id);
        paintCatTree();
        return;
      }
      if (act.dataset.act === 'pick-parent') {
        filters.types = new Set([type]);
        filters.parentCategoryId = id;
        filters.categoryId = '';
        closeCatModal();
        paintFilters();
        load();
        return;
      }
      if (act.dataset.act === 'pick-child') {
        filters.types = new Set([type]);
        filters.categoryId = id;
        filters.parentCategoryId = '';
        closeCatModal();
        paintFilters();
        load();
      }
    });
  }

  /* ---------------- 模块 2：账期切换器 ---------------- */

  function paintPeriod() {
    const r = activeRange();
    const el = $('[data-role=period-label]');
    if (el) el.textContent = periodLabel(r);
  }
  $('[data-role=prev]')?.addEventListener('click', () => {
    const r = shiftRange(activeRange(), -1);
    filters.dateFrom = r.from;
    filters.dateTo = r.to;
    filters.manualRange = true;
    paintFilters();
    load();
  });
  $('[data-role=next]')?.addEventListener('click', () => {
    const r = shiftRange(activeRange(), 1);
    filters.dateFrom = r.from;
    filters.dateTo = r.to;
    filters.manualRange = true;
    paintFilters();
    load();
  });

  /* ---------------- 导出 ---------------- */

  $('[data-role=export]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '导出中';
    try {
      const res = await Api.exportStatsCsv(ledger.id, queryOf());
      // 复用统一下载工具：入 DOM + 异步 revoke（这里原本是同步 revoke，同款隐患）
      downloadTextFile(`报表-${activeRange().from}-${activeRange().to}.csv`, res.raw ?? '', {
        mime: 'text/csv;charset=utf-8',
        throwOnEmpty: true,
      });
      toast('已导出 CSV', 'success');
    } catch (err) {
      toast(err?.message ?? '导出失败', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  /* ---------------- 净资产快照：补拍（事件委托，卡片每次重建都生效） ---------------- */

  frame.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action=backfill-nw]');
    if (!btn || btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '补拍中…';
    try {
      const res = await Api.backfillNetWorthSnapshots(ledger.id);
      const created = Number(res?.data?.created ?? 0);
      const nw = await Api.statsNetWorth(ledger.id, 12).then((r) => r.data).catch(() => []);
      paintNetWorth(nw);
      toast(created > 0 ? `已补拍 ${created} 个月快照` : '历史快照已是最新', 'success');
    } catch (err) {
      toast(err?.message ?? '补拍失败', 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  /* ---------------- 通用：区块外壳 ---------------- */

  const section = (title, sub, body, extraClass = '', action = '') =>
    `<div class="section__head">
       <h2 class="tt-body-strong">${esc(title)}</h2>
       ${sub ? `<span class="tt-fine-print">${esc(sub)}</span>` : ''}
       ${action}
     </div>
     <div class="card ${extraClass}">${body}</div>`;

  /* ---------------- 模块 3：KPI 卡 ---------------- */

  function paintKpi(sum, recv, pay) {
    /**
     * ⚠️ 字段名必须照 `summary()` 的真实返回取。
     *
     * 第一版写成 `sum.period.income`（沿用了概览页 `accountSummary().period` 的形状），
     * 而 `stats/summary` 返回的是**扁平**的 `totalIncome / totalExpense / netBalance`。
     * 取错的后果不是报错，是**四张卡全显示 0** —— 页面看起来正常，
     * 只有「这个月明明有收入为什么显示 0」这一个疑点，而用户会怀疑是自己的数据错了。
     */
    const income = Number(sum.totalIncome ?? 0);
    const expense = Number(sum.totalExpense ?? 0);
    const net = Number(sum.netBalance ?? 0);
    const expenseCount = Number(sum.expenseCount ?? 0);
    const incomeCount = Number(sum.incomeCount ?? 0);
    const cnt = expenseCount + incomeCount;
    const avg = expenseCount > 0 ? expense / expenseCount : 0;
    /** 结余率 = 净结余 / 收入。收入为 0 时给「—」而不是 0%（0% 会被读成「全花光了」） */
    const saveRate = income > 0 ? ((net / income) * 100).toFixed(1) : null;
    const cash = Number(sum.netAssets ?? 0);

    const card = (label, value, sub, href) => `
      <a class="kpi-card" href="${esc(href)}" data-link>
        <span class="kpi-card__label">${esc(label)}</span>
        <span class="kpi-card__value tnum">${esc(value)}</span>
        <span class="kpi-card__sub">${esc(sub)}</span>
      </a>`;

    /**
     * 4 张卡**直接**作为 12 栅格的栅格项（外层容器用 display:contents），
     * 不再套一层 12 列嵌套栅格。
     *
     * 嵌套栅格要重复算一遍列宽：父级改列间距时子级必须同步改，
     * 只要漏改一次，KPI 卡就会与下面的卡片错开半列，而这种错位
     * 在视觉上非常轻（1~2px），不对照栅格线看不出来，但整页会「发飘」。
     */
    slotKpi.innerHTML = `
      ${card('总收入', money(income), `${incomeCount} 笔`, txHref({ recordType: 'income' }))}
      ${card(
        '净支出',
        money(expense),
        saveRate === null ? '本期无收入' : `结余率 ${saveRate}%`,
        txHref({ recordType: 'expense' }),
      )}
      ${card('笔数与平均每笔', `${cnt} 笔`, `支出平均 ${money(avg)}`, txHref())}
      ${card('期末现金', money(cash), `待收 ${money(recv)} · 待付 ${money(pay)}`, '/accounts')}`;
  }

  /* ---------------- 模块 4：周期对比表 ---------------- */

  function paintCompare(sum, cmp, yoy) {
    const cur = {
      expense: Number(sum.totalExpense ?? 0),
      income: Number(sum.totalIncome ?? 0),
      net: Number(sum.netBalance ?? 0),
    };
    const prev = {
      expense: Number(cmp?.previous?.expense ?? cmp?.prev?.expense ?? 0),
      income: Number(cmp?.previous?.income ?? cmp?.prev?.income ?? 0),
      net: Number(cmp?.previous?.net ?? cmp?.prev?.net ?? 0),
    };
    const ly = {
      expense: Number(yoy?.previous?.expense ?? 0),
      income: Number(yoy?.previous?.income ?? 0),
      net: Number(yoy?.previous?.net ?? 0),
    };
    const diff = (a, b) => (b === 0 ? '—' : `${a - b >= 0 ? '+' : ''}${money(a - b)}`);

    /**
     * ⚠️ 差异**必须用中性色 + 箭头**，不能套收支配色（`is-pos` / `is-neg`）。
     *
     * 为什么：`is-neg` 是红、`is-pos` 是绿，而这里的差异既可能是「支出」也可能是
     * 「收入」。给支出行染绿等于说「这个月多花了 ¥2,792，很好」——
     * 那是一句假话，而且是**看起来很像信息的假话**（用户会当真）。
     *
     * 语义色只给「有确定好坏含义的有符号数字」（净结余、涨跌额）。
     * 差异的方向用箭头表达，好坏留给用户自己判断 —— 平台的立场是**不给判断**。
     */
    const diffText = (a, b) => {
      if (b === 0) return '—';
      const d = a - b;
      return `${d > 0 ? '↑' : d < 0 ? '↓' : '→'} ${diff(a, b)}`;
    };

    /**
     * 这张卡只跨 **4 栅格**，可用宽度约 318px。
     *
     * 6 列（项目/本周期/上期/环比/去年同期/同比）平铺时每列只有 53px，
     * 而「¥4,102.00」要 68px —— 于是金额**互相盖住**：
     * 页面上看到的是「¥4,102.001,310.00+¥2,792.00」，看起来像数字算错了。
     *
     * 所以拆成两层：主行给「本周期 + 环比」（最常看的两列），
     * 副行用一行小字交代「上期 / 去年同期 / 同比」。
     * 信息一个没少，宽度减到 3 列。
     */
    const row = (label, key) => `
      <div class="cmp-item">
        <div class="cmp-row">
          <span class="cmp-row__label">${esc(label)}</span>
          <span class="cmp-row__num tnum">${esc(money(cur[key]))}</span>
          <span class="cmp-row__num tnum">${esc(diffText(cur[key], prev[key]))}</span>
        </div>
        <p class="cmp-row__sub">
          上期 ${esc(money(prev[key]))} · 去年同期 ${esc(money(ly[key]))} · 同比 ${esc(diffText(cur[key], ly[key]))}
        </p>
      </div>`;

    slotCmp.innerHTML = section(
      '周期对比',
      '本周期 / 上期 / 去年同期',
      `<div class="cmp-table">
        <div class="cmp-row cmp-row--head">
          <span class="cmp-row__label">项目</span>
          <span class="cmp-row__num">本周期</span>
          <span class="cmp-row__num">环比</span>
        </div>
        ${row('支出', 'expense')}
        ${row('收入', 'income')}
        ${row('总结余', 'net')}
      </div>`,
    );
  }

  /* ---------------- 模块 5 / 6 / 7 / 8 / 9 / 10 / 11 ---------------- */

  function paintTrend12(rows) {
    const data = (rows ?? []).map((r) => {
      const period = String(r.period ?? r.date ?? r.label ?? '');
      // period 形如 "2026-10"；label 是后端给的 "10月"，优先用它（跨年会标出年份语义）
      const label = r.label ?? (period.length >= 7 ? `${Number(period.slice(5, 7))}月` : period);
      const monthStart = period.length >= 7 ? `${period.slice(0, 7)}-01` : '';
      return {
        label,
        income: Number(r.income ?? 0),
        expense: Number(r.expense ?? 0),
        net: Number(r.net ?? Number(r.income ?? 0) - Number(r.expense ?? 0)),
        /** 下钻到**整个月**，不是某一天 */
        dateFrom: monthStart,
        dateTo: monthStart && period.length >= 7
          ? new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).toISOString().slice(0, 10)
          : '',
      };
    });
    slotTrend12.innerHTML = section(
      '近 12 个月收支趋势',
      '柱为收支，虚线为结余',
      groupedBars(data, {
        hrefOf: (d) => txHref({ dateFrom: d.dateFrom, dateTo: d.dateTo }),
        tipOf: (d) => ({
          title: d.label,
          lines: [
            `收入 ${money(d.income)}`,
            `支出 ${money(d.expense)}`,
            `结余 ${money(d.net)}`,
          ],
        }),
      }),
    );
  }

  function paintDonut(cat) {
    const rows = (cat ?? []).map((c) => ({ ...c, amount: c.amount, name: c.name }));
    const total = rows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
    slotDonut.innerHTML = section(
      '支出构成',
      '点分类看它的账单',
      donut(rows, {
        centerLabel: '支出合计',
        centerValue: money(total),
        totalText: money(total),
        totalLabel: '支出合计',
        max: 7,
        hrefOf: (c) => txHref({ recordType: 'expense', categoryId: c.categoryId ?? c.id }),
        /**
         * 悬停提示：名称 · 金额 · 占比（需求 2 / 3）。
         * 占比在**这里**算而不是复用后端的 ratio —— 环形图的扇区角度是按
         * 「过滤掉 0 值后的合计」算的，用别的分母会让「提示里的百分比」
         * 与「图上这块扇形的大小」对不上，而用户对不上时只会怀疑数字是错的。
         */
        tipOf: (c) => ({
          title: c.name,
          lines: [
            money(c.amount),
            `占比 ${total > 0 ? ((Number(c.amount) / total) * 100).toFixed(1) : '0.0'}%`,
            c.count ? `${c.count} 笔` : '',
          ].filter(Boolean),
        }),
      }),
    );
  }

  function paintRank(cat) {
    const total = (cat ?? []).reduce((a, r) => a + Number(r.amount ?? 0), 0);
    const rows = (cat ?? [])
      .slice(0, 8)
      .map((c, i) => ({
        name: c.name,
        amount: money(c.amount),
        count: c.count ?? 0,
        ratio: total > 0 ? (Number(c.amount) / total) * 100 : 0,
        dot: PALETTE[i % PALETTE.length],
        href: txHref({ recordType: 'expense', categoryId: c.categoryId ?? c.id }),
      }));
    slotRank.innerHTML = section(
      '分类排行',
      '金额 · 笔数 · 占比 · 小计',
      rankTable(rows, { nameTitle: '分类' }),
    );
  }

  function paintDaily(points) {
    slotDaily.innerHTML = section(
      '每日支出趋势',
      '红点为异常峰值，点它看当日流水',
      lineChart(points ?? [], {
        ariaLabel: '每日支出',
        hrefOf: (p) => txHref({ dateFrom: p.date, dateTo: p.date }),
        tipOf: (p) => ({ title: p.date ?? p.label, lines: [`支出 ${money(p.value)}`] }),
      }),
    );
  }

  function paintWeekday(rows) {
    /**
     * 聚合范围**跟随全局账期**，卡片内不再有自己的「本月 / 近3月 / 全年」切换器。
     *
     * 为什么删掉它：报表页已经在顶部有账期筛选，卡片里再放一个只有这一张图
     * 认的独立范围，会出现「筛了 10 月、这张图却是近 3 月」这种页面内部
     * 互相矛盾的状态 —— 而用户不容易发现，只会觉得数字不对。
     * 一张图的口径必须与它所在页面的口径一致。
     */
    const data = (rows ?? []).map((r) => ({
      label: r.label,
      value: Number(r.expense ?? 0),
      count: r.count,
    }));
    const total = data.reduce((a, r) => a + r.value, 0);
    slotWeekday.innerHTML = section(
      '星期消费分布',
      '按当前账期统计',
      bars(data, {
        ariaLabel: '星期分布',
        tipOf: (r) => ({
          title: r.label,
          lines: [
            `支出 ${money(r.value)}`,
            `占比 ${total > 0 ? ((r.value / total) * 100).toFixed(1) : '0.0'}%`,
            `${r.count ?? 0} 笔`,
          ],
        }),
      }),
    );
  }

  function paintMember(rows) {
    const items = (rows ?? []).map((r) => ({
      ...r,
      name: r.memberName,
      amount: r.expense,
    }));
    const total = items.reduce((a, r) => a + Number(r.amount ?? 0), 0);
    slotMember.innerHTML = section(
      '成员消费',
      '按记录人统计',
      pie(items, {
        hrefOf: (r) => txHref({ memberId: r.memberId }),
        ariaLabel: '成员消费占比',
        totalLabel: '合计',
        valueText: (r) => money(r.amount),
        legendExtraOf: (r) => `${r.count ?? 0} 笔`,
        tipOf: (r) => ({
          title: r.name,
          lines: [
            money(r.amount),
            `占比 ${total > 0 ? ((Number(r.amount) / total) * 100).toFixed(1) : '0.0'}%`,
            `${r.count ?? 0} 笔`,
          ],
        }),
        footnote: '口径为「记录人」，不是消费人。',
      }),
    );
  }

  /**
   * 个人账本「成员消费」的替代卡（需求 ②）。
   *
   * 个人账本没有「成员」维度，原饼图无意义。改为在所选筛选范围内呈现四项
   * 录入汇总指标，沿用 .kpi-card 风格，与全站设计规范一致。
   *
   * 命名采用专业财务术语：
   *   录入总额 = Σ amount（所有录入金额合计）
   *   折扣合计 = Σ discount
   *   手续费合计 = Σ fee
   *   净额     = Σ actualAmount = 录入总额 + 手续费 − 折扣
   * 净额公式显式写在卡片副文案里，避免「扣减折扣与手续费」的方向歧义。
   */
  function paintPersonalSummary(s) {
    /**
     * ⚠️ 永远渲染，不依赖 `s` 是否取到。
     * 之前只在 `if (sum)` 时绘制，一旦 `statsSummary` 请求失败（catch → null）
     * 整张卡片就**空白**，用户看到的是「本期录入汇总无数据」。
     * 现在无论 `sum` 是否到位都画：缺失就显示 ¥0.00，至少给出一个可读的空态，
     * 而不是一块缺失的卡片。
     *
     * 同时做 NaN 兜底：`summary()` 返回的是分数字符串，经 `Number()` 转换后
     * 必须是有限数；任何非有限值都回落到 0，避免「¥ NaN」这类脏值。
     */
    const num = (v) => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    const recorded = num(s?.totalRecorded);
    const discount = num(s?.totalDiscount);
    const fee = num(s?.totalFee);
    const net = num(s?.netAmount);
    const item = (label, value, note) => `
      <div class="kpi-card">
        <span class="kpi-card__label">${esc(label)}</span>
        <span class="kpi-card__value tnum">${esc(money(value))}</span>
        <span class="kpi-card__sub">${esc(note)}</span>
      </div>`;
    slotMember.innerHTML = section(
      '本期录入汇总',
      '所选筛选范围内',
      `<div class="st-personal-sum">
        ${item('录入总额', recorded, '所有录入金额合计')}
        ${item('折扣合计', discount, '折扣金额合计')}
        ${item('手续费合计', fee, '手续费金额合计')}
        ${item('净额', net, '录入总额 + 手续费 − 折扣')}
      </div>`,
    );
  }

  function paintNetWorth(series) {
    const data = (series ?? []).map((s) => ({
      label: s.label ?? String(s.snapshotDate ?? '').slice(5),
      asset: Number(s.assetTotal ?? 0),
      debt: Number(s.liabilityTotal ?? 0),
    }));
    /**
     * ⚠️ 判据是「**非零时点的个数 ≥ 2**」，不是「数组非空」也不是「有非零值」。
     *
     * 后端在没有历史快照时会补出 12 个**空桶**（各项为 0），而账本一旦有账户，
     * 当月那一个桶就可能非零。于是：
     *   · `data.length > 0` 恒真 —— 画出来是一块空白坐标轴；
     *   · `some(非零)` 也真 —— 画出来是**一个孤立的点**，
     *     面积图退化成一个不可见的退化多边形，页面上只剩一个月份标签。
     * 两种都表现为「标题写着近 12 个月，图里什么都没有」，而用户会以为自己的数据丢了。
     *
     * 面积图要**两个点**才有「趋势」。凑不齐就老实给空态，并说清怎么才会有。
     * 此外 `netWorthSeries` 已裁掉开头连续的零月，所以这里 `asset+debt > 0` 的
     * 时点个数就是「真实有净值的月份数」，不会把贴 0 基准的平线算进来。
     */
    const nonZero = data.filter((d) => d.asset + d.debt > 0);
    const hasData = nonZero.length >= 2;
    const backfillBtn = `<button class="btn btn--quiet btn--sm" type="button" data-action="backfill-nw" title="按各月末余额补齐最近 12 个月的历史快照">补拍历史快照</button>`;
    slotNetWorth.innerHTML = section(
      '净资产趋势',
      '资产 / 负债，近 12 个月',
      hasData
        ? stackedArea(data, {
            ariaLabel: '净资产趋势',
            tipOf: (d) => ({
              title: d.label,
              lines: [
                `资产 ${money(d.asset)}`,
                `负债 ${money(d.debt)}`,
                `净资产 ${money(d.asset - d.debt)}`,
              ],
            }),
          })
        : `<div class="chart-empty">
             <div class="chart-empty__text">
               <p class="tt-caption">还没有净资产快照</p>
               <p class="tt-fine-print text-muted">快照记录某个时点的资产与负债，积累两个及以上的时点后这里就能看出趋势。若有历史账目，点右上角「补拍历史快照」即可一键补齐。</p>
             </div>
           </div>`,
      '',
      backfillBtn,
    );
  }

  function paintAccounts(rows) {
    /**
     * 这张卡现在**独占一行（12 栅格）**，所以可以给足 5 列：
     * 账户 · 类型 · 期初 · 期末 · 结余。
     *
     * 早先它挤在 4 栅格（约 366px）里，6 列的最小内容宽度是 388px ——
     * 放进去会从卡片右侧溢出、把整个文档撑出横向滚动条，
     * 于是当时把「类型」降成了账户名下的小字、只留 4 列。
     * 拆成独立卡片后宽度不再是瓶颈，类型回到自己的列里，
     * 名称列也就不必再挤成两行。
     *
     * ⚠️ 类型必须过 `ACCOUNT_TYPE_LABEL`。后端给的是枚举
     *    （`debit_card` / `third_party` …），直接铺到界面上就是英文，
     *    而这一列的读者是「想知道这张卡是什么」的用户。
     */
    const body = (rows ?? []).length
      ? `<table class="tbl tbl--acct">
          <thead>
            <tr>
              <th>账户</th><th>类型</th><th class="tnum">期初</th>
              <th class="tnum">期末</th><th class="tnum">结余</th>
            </tr>
          </thead>
          <tbody>
            ${(rows ?? [])
              .map(
                /**
                 * 窄屏时表头会隐藏（见 app.css 的 .tbl 窄屏规则），
                 * 单元格改由 data-label 自带标签 —— 否则用户看到一串裸金额，
                 * 不知道哪个是期初、哪个是期末。
                 * 标签写在 HTML 里而不是 CSS 的伪元素内容里：
                 * 伪元素里的文案对读屏软件与翻译工具都是不可见的。
                 */
                (a) => {
                  /**
                   * 结余只给语义色，**不再加箭头**。
                   * 金额本身自带正负号（`-¥ 400.00`），再叠一个 ↓ 就是同一个信息
                   * 说了两遍 —— 窄卡里「↓ -¥ 400.00」这种双符号很吵。
                   * 色觉障碍用户读的是那个负号，它才是必须保留的非色彩线索。
                   */
                  const tone = a.trend === 'up' ? 'is-pos' : a.trend === 'down' ? 'is-neg' : '';
                  return `<tr>
                  <td>${esc(a.name)}</td>
                  <td class="text-muted">${esc(ACCOUNT_TYPE_LABEL[a.type] ?? a.type)}</td>
                  <td class="tnum" data-label="期初">${esc(money(a.opening))}</td>
                  <td class="tnum" data-label="期末">${esc(money(a.closing))}</td>
                  <td class="tnum ${tone}" data-label="结余">${esc(money(a.net))}</td>
                </tr>`;
                },
              )
              .join('')}
          </tbody>
        </table>`
      : '<p class="tt-caption text-muted">这个区间还没有账户</p>';
    slotAccounts.innerHTML = section('账户消费一览', '期初 / 期末 / 结余', body);
  }

  /* ---------------- 数据加载 ---------------- */

  /** 星期分布跟随全局账期（卡片内已无独立范围切换器） */
  async function loadWeekday() {
    const scope = activeRange();
    try {
      const r = await Api.statsWeekday(ledger.id, { dateFrom: scope.from, dateTo: scope.to });
      paintWeekday(r.data ?? []);
    } catch {
      paintWeekday([]);
    }
  }

  async function load() {
    const q = queryOf();
    paintFilterSummary();
    paintPeriod();

    const [sum, cmp, yoy, trend12, cat, daily, member, nw, accBal, recv, pay] = await Promise.all([
      Api.statsSummary(ledger.id, q).then((r) => r.data).catch(() => null),
      Api.statsComparison(ledger.id, q).then((r) => r.data).catch(() => null),
      Api.statsYearOverYear(ledger.id, {
        year: Number(q.dateFrom.slice(0, 4)),
        month: Number(q.dateFrom.slice(5, 7)),
        ...(q.accountId ? { accountId: q.accountId } : {}),
        ...(q.parentCategoryId ? { parentCategoryId: q.parentCategoryId } : {}),
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.recordType ? { recordType: q.recordType } : {}),
      })
        .then((r) => r.data)
        .catch(() => null),
      /**
       * 模块 5 标题写的是「近 12 个月」，所以它**必须固定取近 12 个月**，
       * 不能跟着当前账期走。
       *
       * 跟着账期走的后果：用户筛「本月」，这张图就只剩 1 根柱子 ——
       * 标题说 12 个月、图里 1 根，用户第一反应是「图坏了」。
       * 「标题承诺了什么就给什么」比「所有区块都响应筛选」更重要。
       *
       * 同理，模块 10 净资产趋势也固定 12 个月（`statsNetWorth(12)`）。
       */
      Api.statsTrend(ledger.id, { dateFrom: last12Range().from, dateTo: last12Range().to, granularity: 'month' })
        .then((r) => r.data)
        .catch(() => []),
      Api.statsByCategory(ledger.id, { ...q, recordType: 'expense', level: 1 }).then((r) => r.data).catch(() => []),
      Api.statsTrend(ledger.id, { ...q, granularity: 'day' }).then((r) => r.data).catch(() => []),
      Api.statsByMember(ledger.id, q).then((r) => r.data).catch(() => []),
      Api.statsNetWorth(ledger.id, 12).then((r) => r.data).catch(() => []),
      Api.statsAccountsBalance(ledger.id, q).then((r) => r.data).catch(() => []),
      Api.statsOutstandingReceivables(ledger.id).then((r) => r.data).catch(() => ({ amount: '0.00' })),
      Api.statsOutstandingPayables(ledger.id).then((r) => r.data).catch(() => ({ amount: '0.00' })),
    ]);

    if (sum) paintKpi(sum, recv?.amount ?? '0.00', pay?.amount ?? '0.00');
    if (sum) paintCompare(sum, cmp, yoy);
    paintTrend12(trend12);
    paintDonut(cat);
    paintRank(cat);
    paintDaily(
      (daily ?? []).map((d) => {
        /**
         * ⚠️ 趋势接口的日期字段是 **`period`**（`YYYY-MM-DD`），不是 `date`。
         *
         * 早先这里读 `d.date`（永远 undefined）→ 标签全是空串：
         * 日期轴「一个字都没有」（用户报的就是这个）、悬停提示标题也全是 undefined。
         * 而 SVG 里的折线照常画出来，所以看起来「只有横轴坏了」。
         * 字段名一律以 `stats/trend` 的返回为准（见 `src/modules/stats/service.ts`：
         * 返回 `{ period, label, expense, income, net, count }`）。
         */
        const day = String(d.period ?? d.date ?? '');
        /** 轴标签用「月/日」：裸日号在跨月区间里分不清是哪个月（如两个「01」） */
        const label = day.length >= 10 ? `${day.slice(5, 7)}/${day.slice(8, 10)}` : day;
        return { label, value: Number(d.expense ?? 0), date: day };
      }),
    );
    if (ledger.type === 'personal') {
      paintPersonalSummary(sum);
    } else {
      paintMember(member);
    }
    paintNetWorth(nw);
    paintAccounts(accBal);
    await loadWeekday();
    wireCharts();
  }

  /**
   * 图表点击跳转接线。
   *
   * 统一在这里做（而不是每个图各自绑），因为**所有**可点图元的行为一致：
   * 读 `data-href` → `go()`。分散绑定到各处，迟早有一处忘了处理键盘。
   */
  function wireCharts() {
    /**
     * 图表提示只接一次（`attachTips` 内部有标记）：它走事件委托，
     * 之后 `slotX.innerHTML = ...` 重建多少次都不用重新接。
     * 放在这里而不是各 paint 函数里，是为了让「所有图表行为一致」
     * 这件事在代码上只有**一个**地方能出错。
     */
    attachTips(frame);
    frame.querySelectorAll('[data-href]').forEach((el) => {
      if (el.dataset.wired === '1') return;
      el.dataset.wired = '1';
      const jump = () => go(el.dataset.href);
      el.addEventListener('click', jump);
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        jump();
      });
    });
  }


  await paintFilters();
  await load();
  return frame;
}
