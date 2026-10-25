/**
 * 账单列表页 `/transactions`（docs/13 §9）
 *
 * 这一页要回答三个问题，顺序不能乱：
 *   ① **这段时间花了多少**（汇总条，`meta.summary`，随筛选实时变）
 *   ② **我想看哪一批**（筛选行：类型 / 账户 / 分类 / 标签 / 日期 / 附加 / 搜索）
 *   ③ **具体是哪几笔**（按日分组 + 当日小计 + 行内操作）
 *
 * 三条与后端约定强绑定的实现要点：
 *  · **当日小计必须与筛选同源**。`GET /transactions/daily-totals` 是**无筛选**的全量口径，
 *    带筛选时直接用它会让日期头出现「列表 12 笔、小计 8000」这种自相矛盾，
 *    因此列表接口的 `meta.byDate` 是同一个 `where` 聚合出来的（`service.ts` 已实现）。
 *  · **行点击进详情、`⋯` 进动作菜单**：两者共存时必须判断事件来源，
 *    否则点「删除」会先跳详情页（这类 bug 在移动端尤其致命）。
 *  · **选择态有两条进入路径**：桌面 hover 出的复选框、移动长按 400ms
 *    （`docs/13 §9.4`），两轮手势共用一套选择模型 `selected: Set<id>`。
 *
 * 有意为之、勿当 bug 修：
 *  · 金额符号一律取 `signedAmount`（= `accountDelta`），**转账对主账户永远是负**（§9.3）。
 *  · 删除是软删除（30 天回收站），所以文案说「已移入回收站」而不是「已删除」。
 *  · 移动端未做左滑（见 `docs/13 §15.1` 的偏离登记 V7），动作菜单常驻 44×44。
 *  · 汇总条是**筛选范围全量**口径、日期小计是**当前页**口径（`§9.1` 图里写的就是
 *    `meta.summary`），所以第 1 页还没加载完时二者不相等 —— 由 hero 副标题
 *    「共 N 笔，已加载 M 笔」解释差额，不是 bug。
 *
 * 关于 `RECORD_TYPE_LABEL` 有两份：这里的短标签（「应收 / 应付」）来自 `ui.js`，
 * 用于筛选 chips 与徽标；`lib/amounts.js` 里另有一份长标签（「应收款项 / 应付款项」），
 * 那是公式报错文案的用语，由 `check-amounts-parity.mts` 与后端逐字对齐，两者**不要合并**。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import {
  RECORD_TYPE_LABEL,
  actionToast,
  esc,
  entityIcon,
  h,
  icon,
  lucide,
  money,
  setLoading,
  toast,
} from '../ui.js';
import {
  amountText,
  amountTone,
  dayLabel,
  dayWeekday,
  extraText,
  subjectIcon,
  subjectText,
  tagDots,
  typeBadge,
} from '../lib/tx-format.js';
import { downloadTextFile } from '../lib/download.js';

const PAGE_SIZE = 20;
/** 长按进入选择态的阈值（与 chrome.js 的「记」保持一致：400ms / 8px） */
const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 8;

/** 可筛选的记录类型（顺序即 chips 顺序，与记账页的类型顺序一致） */
const TYPE_FILTERS = ['expense', 'income', 'transfer', 'receivable', 'payable', 'adjustment'];

const SORTS = [
  { value: '-occurredAt', label: '按时间（新→旧）' },
  { value: 'occurredAt', label: '按时间（旧→新）' },
  { value: '-amount', label: '按金额（大→小）' },
  { value: '-createdAt', label: '按录入时间（新→旧）' },
];

/* ---------------- 日期预设（docs/13 §9.1 的 [日期▾]） ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function monthRange(offset) {
  const first = new Date();
  first.setDate(1);
  first.setMonth(first.getMonth() + offset);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: iso(first), to: iso(last) };
}

const DATE_PRESETS = [
  { key: 'all', label: '全部时间' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '近 7 天' },
  { key: 'month', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'year', label: '今年' },
  { key: 'custom', label: '自定义' },
];

function resolvePreset(key) {
  const now = new Date();
  switch (key) {
    case 'today':
      return { from: iso(now), to: iso(now) };
    case 'week': {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return { from: iso(d), to: iso(now) };
    }
    case 'month':
      return monthRange(0);
    case 'lastMonth':
      return monthRange(-1);
    case 'year':
      return { from: `${now.getFullYear()}-01-01`, to: iso(now) };
    default:
      return { from: '', to: '' };
  }
}

/** 反向识别：当前日期区间命中哪个预设（用于把「已选」回显到 pill 上） */
function matchPreset(from, to) {
  if (!from && !to) return 'all';
  for (const p of DATE_PRESETS) {
    if (p.key === 'custom' || p.key === 'all') continue;
    const r = resolvePreset(p.key);
    if (r.from === from && r.to === to) return p.key;
  }
  return 'custom';
}

/* ================================================================== */

export async function renderTransactions(container, { go, query }) {
  const loading = appFrame({
    active: 'transactions',
    inner: `<div class="card"><div class="skeleton" style="width:38%"></div>
            <div class="skeleton" style="width:72%;margin-top:16px"></div>
            <div class="skeleton" style="width:64%;margin-top:12px"></div></div>`,
  });
  container.replaceChildren(loading);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return loading;
  }

  /* ---------------- 筛选态（初始值来自 URL，支持从账户 / 分类 / 标签页跳转携带） ---------------- */
  const q = query ?? ((name) => new URLSearchParams(window.location.search).get(name));
  const filters = {
    types: new Set((q('recordType') ?? '').split(',').filter(Boolean).filter((t) => TYPE_FILTERS.includes(t))),
    accountId: q('accountId') ?? '',
    parentCategoryId: q('parentCategoryId') ?? '',
    categoryId: q('categoryId') ?? '',
    tags: new Set((q('tagIds') ?? '').split(',').filter(Boolean)),
    tagMatchMode: q('tagMatchMode') === 'all' ? 'all' : 'any',
    /**
     * 「附加」子项：`discount`（有折扣）/ `fee`（有手续费）。
     * 只接受这两个值 —— URL 是用户可改的输入，非法值进来会让后端拼出
     * 一个恒假条件（列表永远空），比忽略它更难查。
     */
    extras: new Set(
      (q('extras') ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x === 'discount' || x === 'fee'),
    ),
    dateFrom: q('dateFrom') ?? '',
    dateTo: q('dateTo') ?? '',
    keyword: q('keyword') ?? '',
    sort: SORTS.some((s) => s.value === q('sort')) ? q('sort') : '-occurredAt',
  };

  /* ---------------- 数据 ---------------- */
  const page = { n: 1, total: 0, totalPages: 1 };
  let items = [];
  let byDate = {};
  let summary = null;
  let loadError = null;
  /**
   * 请求时序（详见 `load()` 顶部注释）。
   *  · `loadSeq` —— 每次「筛选」自增，响应回来时比对，过期的直接丢弃；
   *  · `morePending` —— 只用于「加载更多 / 触底加载」，防重复 append。
   * 两者**不能合并成一把锁**：合并就会出现「筛选被静默吞掉」（真踩过）。
   */
  let loadSeq = 0;
  let morePending = false;
  let openFilter = null;
  /** 手机端「更多」折叠区是否展开（桌面端恒常显，这个值不参与桌面渲染） */
  let moreOpen = false;

  const selected = new Set();
  let selectionMode = false;

  const [accountsRes, groupsRes, catRes, tagsRes] = await Promise.all([
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id, { includeArchived: true }).then((r) => r.data),
    Api.listCategories(ledger.id).then((r) => r.data),
    Api.listTags(ledger.id).then((r) => r.data),
  ]);
  const accounts = accountsRes.filter((a) => a.kind !== 'virtual');
  const activeAccounts = accounts.filter((a) => !a.archivedAt);
  const groups = groupsRes;
  const catTrees = catRes;
  const tags = tagsRes.filter((t) => !t.archivedAt);

  /* ---------------- 骨架 ---------------- */
  const frame = appFrame({
    active: 'transactions',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div class="stack stack--sm">
            <h1>账单</h1>
            <p class="tt-caption text-muted" data-role="hero-sub">
              ${esc(ledger.name)} · 正在读取…
            </p>
          </div>
          <div class="row row--md">
            <a class="btn btn--sm" href="/transactions/new" data-link">${icon('plus', 16)}记一笔</a>
            <button class="btn btn--quiet btn--sm" type="button" data-role="export">${icon('download', 16)}导出</button>
          </div>
        </div>
      </div>

      <div class="tx-toolbar" data-role="toolbar">
        <div class="tx-sum" role="group" aria-label="筛选结果汇总">
          <div class="tx-sum__cell">
            <span class="tx-sum__label">支出</span>
            <span class="tx-sum__value tnum is-neg" data-role="sum-expense">¥ 0.00</span>
          </div>
          <div class="tx-sum__cell">
            <span class="tx-sum__label">收入</span>
            <span class="tx-sum__value tnum is-pos" data-role="sum-income">¥ 0.00</span>
          </div>
          <div class="tx-sum__cell">
            <span class="tx-sum__label">结余</span>
            <span class="tx-sum__value tnum" data-role="sum-net">¥ 0.00</span>
          </div>
        </div>

        <!--
          筛选区两行结构（手机端的核心改动）：

          第一行 = 常驻：搜索框 + 「更多」+ 清除筛选。
          搜索是**唯一值得常驻**的筛选 —— 它有输入态，收起来就再也看不出
          「我现在是不是搜着某个词」，而这正是手机上最容易忘的一件事。

          第二行 = 折叠：7 个筛选 pill。
          它们只在「我要改条件」那一刻才有用，平时是 7 颗永远占两行的按钮。
          .tx-filters__pills 在桌面用 display:contents 参与父级 flex 排布
          （与改造前逐字节一致），只有手机端才变成独立的一行。
        -->
        <div class="tx-filters" data-role="filters" data-more="off">
          <div class="tx-filters__row" data-role="filter-row">
            <label class="tx-search">
              <span class="visually-hidden">搜索账单</span>
              ${icon('search', 16)}
              <input class="tx-search__input" type="search" data-role="keyword"
                     placeholder="搜索名称 / 商家 / 对象 / 备注" autocomplete="off" />
            </label>
            <button class="tx-more" type="button" data-role="more"
                    aria-expanded="false" aria-controls="tx-filter-pills">更多</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="clear" hidden>清除筛选</button>
            <div class="tx-filters__pills" id="tx-filter-pills" data-role="pill-row">
              <button class="tx-pill" type="button" data-f="types" aria-expanded="false">类型</button>
              <button class="tx-pill" type="button" data-f="accountId" aria-expanded="false">账户</button>
              <button class="tx-pill" type="button" data-f="categoryId" aria-expanded="false">分类</button>
              <button class="tx-pill" type="button" data-f="tags" aria-expanded="false">标签</button>
              <button class="tx-pill" type="button" data-f="date" aria-expanded="false">日期</button>
              <button class="tx-pill" type="button" data-f="extras" aria-expanded="false">附加</button>
              <button class="tx-pill" type="button" data-f="sort" aria-expanded="false">排序</button>
              <!--
                展开态的收起入口。为什么不能只靠「再点一次更多」：
                「更多」在顶部，展开后 7 颗 pill 铺满整屏，用户滑到底部时
                已经看不见它了 —— 收起必须出现在用户**停下来的地方**。
              -->
              <button class="tx-pill tx-pill--quiet" type="button" data-role="collapse">收起</button>
            </div>
          </div>
          <div class="tx-panel" data-role="panel" hidden></div>
        </div>
      </div>

      <div data-role="list"></div>
      <div data-role="foot"></div>
    `,
  });
  mountTabBar(frame, { active: 'transactions', go });
  container.replaceChildren(frame);

  const $ = (sel) => frame.querySelector(sel);
  const listSlot = $('[data-role=list]');
  const footSlot = $('[data-role=foot]');
  const panel = $('[data-role=panel]');

  /* ================================================================== *
   * 查询与数据加载
   * ================================================================== */

  function buildQuery(nextPage) {
    const params = {
      page: nextPage,
      pageSize: PAGE_SIZE,
      sort: filters.sort,
    };
    if (filters.types.size) params.recordType = [...filters.types].join(',');
    if (filters.accountId) params.accountId = filters.accountId;
    if (filters.categoryId) params.categoryId = filters.categoryId;
    else if (filters.parentCategoryId) params.parentCategoryId = filters.parentCategoryId;
    if (filters.tags.size) {
      params.tagIds = [...filters.tags].join(',');
      params.tagMatchMode = filters.tagMatchMode;
    }
    if (filters.extras.size) params.extras = [...filters.extras].join(',');
    if (filters.dateFrom) params.dateFrom = filters.dateFrom;
    if (filters.dateTo) params.dateTo = filters.dateTo;
    if (filters.keyword.trim()) params.keyword = filters.keyword.trim();
    return params;
  }

  /** 把筛选同步进 URL（`replaceState`，不触发重渲染）：刷新与分享都能还原同一批账单 */
  function syncUrl() {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(buildQuery(1))) {
      if (k === 'page' || k === 'pageSize' || k === 'sort') continue;
      sp.set(k, String(v));
    }
    if (filters.sort !== '-occurredAt') sp.set('sort', filters.sort);
    const s = sp.toString();
    window.history.replaceState({}, '', `/transactions${s ? `?${s}` : ''}`);
  }

  /**
   * 拉列表。`reset` = 换筛选（回到第一页重建），否则 = 翻页追加。
   *
   * ## 为什么不能用一个 `if (busy) return;` 挡住并发
   *
   * 那行代码把「并发」当成了「重复」：只要有一个请求在飞，后面的**全部静默丢弃**。
   * 而用户改筛选的真实节奏恰好是连点 —— 打开「附加」面板后顺手勾「折扣」再勾
   * 「手续费」，两次点击相隔几十毫秒，可一个请求要几百毫秒。于是第二次点击被吞掉：
   * chip 显示两项都选中、pill 显示「附加 2」，**列表却只有折扣的结果**。
   * 用户看到的就是「筛选不生效」，且没有任何报错可查（连网络面板都只有一个请求，
   * 看着像后端没按参数过滤）。类型/账户/分类等**任何**多选筛选都有同一个坑，
   * 只是「附加」把两个子项放在一个面板里，最容易连点，所以最先在这里暴露。
   *
   * ## 正确语义：最后点的那个说了算
   *
   * 每次 `reset` 自增 `loadSeq` 并记下自己的号；响应回来先比号，
   * 不是最新的就**直接丢弃、不 paint**（否则慢的旧响应后到会把新结果覆盖回去，
   * 比「不发请求」更难查）。翻页走 `morePending` 独立开关：它是追加，
   * 挡的只是重复 append，不能顺带把筛选也挡住。
   */
  async function load({ reset = false } = {}) {
    if (!reset) {
      if (morePending) return;
      morePending = true;
    }
    const seq = reset ? ++loadSeq : loadSeq;
    const target = reset ? 1 : page.n + 1;
    if (reset) {
      listSlot.replaceChildren(skeletonRows(3));
      footSlot.replaceChildren();
    } else {
      footSlot.querySelector('[data-role=more-btn]') &&
        setLoading(footSlot.querySelector('[data-role=more-btn]'), true, '加载中');
    }

    try {
      const res = await Api.listTransactions(ledger.id, buildQuery(target));
      // 期间又改过筛选 → 这份结果已经过期，丢弃（不 paint、不写 items）
      if (seq !== loadSeq) return;
      loadError = null;
      items = reset ? res.data : [...items, ...res.data];
      byDate = res.meta?.byDate ?? {};
      summary = res.meta?.summary ?? null;
      page.n = res.meta?.page ?? target;
      page.total = res.meta?.total ?? items.length;
      page.totalPages = res.meta?.totalPages ?? 1;
      syncUrl();
      paintSummary();
      paintFilters();
      paintList();
      paintFoot();
    } catch (err) {
      if (seq !== loadSeq) return;
      loadError = err;
      if (reset) items = [];
      paintList();
      paintFoot();
    } finally {
      if (!reset) morePending = false;
    }
  }

  /* ================================================================== *
   * 导出当前筛选的账单（客户端 CSV，UTF-8 BOM + RFC4180 转义）
   * ================================================================== */
  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function rowsToCsv(rows) {
    const DIR_LABEL = { increase: '增加', decrease: '减少', none: '无', write_off: '核销' };
    const headers = [
      '日期', '时间', '类型', '方向', '主类别', '子类别', '账户', '转入账户',
      '名称', '商家', '对象', '金额', '手续费', '折扣', '实际值', '标签', '备注', '记账人',
    ];
    const lines = [headers.map(csvCell).join(',')];
    for (const tx of rows) {
      const tags = (tx.tags ?? []).map((t) => t.name).join('、');
      lines.push([
        tx.txDate ?? '',
        tx.txTime ?? '',
        RECORD_TYPE_LABEL[tx.recordType] ?? tx.recordType ?? '',
        DIR_LABEL[tx.direction] ?? tx.direction ?? '',
        tx.category?.parent?.name ?? '',
        tx.category?.name ?? '',
        tx.account?.name ?? '',
        tx.toAccount?.name ?? '',
        tx.name ?? '',
        tx.merchant ?? '',
        tx.counterparty ?? '',
        tx.amount ?? '',
        tx.fee ?? '',
        tx.discount ?? '',
        tx.actualAmount ?? '',
        tags,
        tx.note ?? '',
        tx.createdBy?.nickname ?? '',
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n');
  }

  function downloadCsv(filename, csv) {
    // UTF-8 BOM 让 Excel 正确识别中文（缺了会乱码）
    // 三条铁律（入 DOM / click 后 remove / 异步 revoke）由统一工具承担，见 lib/download.js
    downloadTextFile(filename, '﻿' + csv, { mime: 'text/csv;charset=utf-8', throwOnEmpty: true });
  }

  async function exportCsv() {
    const btn = $('[data-role=export]');
    setLoading(btn, true, '导出中');
    try {
      // 拉取当前筛选下的全量账单：后端 pageSize 上限 200，循环翻页直到取完
      const rows = [];
      let pageN = 1;
      for (;;) {
        const q = { ...buildQuery(pageN), pageSize: 200 };
        const res = await Api.listTransactions(ledger.id, q);
        const data = res.data ?? [];
        rows.push(...data);
        if (data.length < 200) break;
        pageN += 1;
      }
      if (!rows.length) {
        toast('当前筛选没有可导出的账单', 'error');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`账单_${ledger.name}_${stamp}.csv`, rowsToCsv(rows));
      toast(`已导出 ${rows.length} 笔账单`, 'success');
    } catch (e) {
      toast(`导出失败：${e.message ?? '未知错误'}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  $('[data-role=export]')?.addEventListener('click', () => {
    exportCsv().catch((e) => toast(e.message ?? '导出失败', 'error'));
  });

  /* ================================================================== *
   * 汇总条 / 筛选行
   * ================================================================== */

  function paintSummary() {
    const s = summary ?? { totalExpense: '0.00', totalIncome: '0.00', netBalance: '0.00' };
    const exp = $('[data-role=sum-expense]');
    const inc = $('[data-role=sum-income]');
    const net = $('[data-role=sum-net]');
    exp.textContent = money(Number(s.totalExpense));
    inc.textContent = money(Number(s.totalIncome));
    net.textContent = money(Number(s.netBalance));
    net.className = `tx-sum__value tnum ${amountTone(s.netBalance)}`;

    const sub = $('[data-role=hero-sub]');
    const scope = activeFilterCount() > 0 ? '筛选后' : '全部';
    sub.textContent = items.length
      ? `${ledger.name} · ${scope}共 ${page.total} 笔，已加载 ${items.length} 笔`
      : `${ledger.name} · ${scope}共 ${page.total} 笔`;
  }

  function activeFilterCount() {
    return (
      filters.types.size +
      (filters.accountId ? 1 : 0) +
      (filters.parentCategoryId || filters.categoryId ? 1 : 0) +
      filters.tags.size +
      filters.extras.size +
      (filters.dateFrom || filters.dateTo ? 1 : 0) +
      (filters.keyword.trim() ? 1 : 0)
    );
  }

  /** pill 上回显「已选了谁」——比一个孤零零的「已选 2」有用得多 */
  function pillState(key) {
    switch (key) {
      case 'types':
        return {
          label: filters.types.size ? `类型 ${filters.types.size}` : '类型',
          on: filters.types.size > 0,
        };
      case 'accountId': {
        const a = accounts.find((x) => x.id === filters.accountId);
        return { label: a ? `账户：${a.name}` : '账户', on: !!a };
      }
      case 'categoryId': {
        const c = resolveCategoryLabel();
        return { label: c ? `分类：${c}` : '分类', on: !!c };
      }
      case 'tags':
        return {
          label: filters.tags.size ? `标签 ${filters.tags.size}` : '标签',
          on: filters.tags.size > 0,
        };
      case 'date': {
        const preset = matchPreset(filters.dateFrom, filters.dateTo);
        if (preset === 'all') return { label: '日期', on: false };
        if (preset === 'custom') {
          return { label: `${filters.dateFrom || '…'} ~ ${filters.dateTo || '…'}`, on: true };
        }
        return {
          label: `日期：${DATE_PRESETS.find((p) => p.key === preset)?.label ?? ''}`,
          on: true,
        };
      }
      case 'extras':
        return {
          label: filters.extras.size ? `附加 ${filters.extras.size}` : '附加',
          on: filters.extras.size > 0,
        };
      case 'sort': {
        const s = SORTS.find((x) => x.value === filters.sort);
        return {
          label: `排序：${(s?.label ?? '').replace('按', '')}`,
          on: filters.sort !== '-occurredAt',
        };
      }
      default:
        return { label: key, on: false };
    }
  }

  function resolveCategoryLabel() {
    if (!filters.categoryId && !filters.parentCategoryId) return '';
    for (const p of catTrees) {
      if (p.id === filters.categoryId) return p.name;
      if (p.id === filters.parentCategoryId) {
        const child = (p.children ?? []).find((c) => c.id === filters.categoryId);
        return child ? `${p.name} › ${child.name}` : `${p.name}（全部）`;
      }
      const child = (p.children ?? []).find((c) => c.id === filters.categoryId);
      if (child) return `${p.name} › ${child.name}`;
    }
    return '已选';
  }

  function paintFilters() {
    const count = activeFilterCount();
    $('[data-role=clear]').hidden = count === 0;
    $('[data-role=clear]').textContent = count ? `清除筛选（${count}）` : '清除筛选';

    $('[data-role=pill-row]')
      .querySelectorAll('.tx-pill')
      .forEach((btn) => {
        const key = btn.dataset.f;
        if (!key) return; // 末尾那颗「收起」不是筛选 pill
        const { label, on } = pillState(key);
        btn.textContent = label;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-expanded', String(openFilter === key));
      });

    /* 「更多」上的角标：折叠着的时候，用户唯一能知道「还筛着东西」的地方。
       没有它，折叠 = 把生效中的筛选藏起来，列表怎么短的说不清。 */
    const more = $('[data-role=more]');
    if (more) {
      /* 角标只数**折叠区里的**条件：搜索框是常驻的，已经自己显示着词，
         再计进来会让角标虚高（看着筛了 2 项，其实只有 1 项藏在里面）。 */
      const extra = activeFilterCount() - (filters.keyword.trim() ? 1 : 0);
      more.textContent = extra ? `更多 · ${extra}` : '更多';
      more.setAttribute('aria-expanded', String(moreOpen));
      more.classList.toggle('is-on', extra > 0);
    }

    const kw = $('[data-role=keyword]');
    if (kw.value !== filters.keyword) kw.value = filters.keyword;
  }

  /* ---------------- 筛选面板 ---------------- */

  /**
   * 「更多 / 收起」—— 手机端把 7 颗筛选 pill 收进折叠区。
   *
   * 状态只写在 `.tx-filters[data-more]` 上，**显隐交给 CSS**：
   * 折叠区在桌面端是常显的（`display: contents` 时这个属性被忽略），
   * 同一个 class 在两种形态下语义不同才是对的 —— 桌面没有「更多」按钮，
   * 也就永远不会走到这里。
   *
   * 收起时必须把当前打开的面板一起关掉：面板是 pill 的下级，
   * pill 都收起来了，面板留在原地就成了「没有来源的一块浮层」。
   */
  function setMore(open) {
    moreOpen = open;
    $('[data-role=filters]').dataset.more = open ? 'on' : 'off';
    if (!open && openFilter) {
      openFilter = null;
      paintPanel();
    }
    paintFilters();
  }

  $('[data-role=more]').addEventListener('click', () => setMore(!moreOpen));
  $('[data-role=collapse]').addEventListener('click', () => setMore(false));

  $('[data-role=pill-row]')
    .querySelectorAll('.tx-pill')
    .forEach((btn) =>
      btn.addEventListener('click', () => {
        const key = btn.dataset.f;
        if (!key) return; // 末尾那颗「收起」不是筛选 pill
        openFilter = openFilter === key ? null : key;
        paintPanel();
        paintFilters();
      }),
    );

  function paintPanel() {
    if (!openFilter) {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    panel.hidden = false;
    panel.replaceChildren(buildPanel(openFilter));
  }

  function buildPanel(key) {
    switch (key) {
      case 'types':
        return chipPanel({
          title: '记录类型（可多选）',
          options: TYPE_FILTERS.map((t) => ({ value: t, label: RECORD_TYPE_LABEL[t] ?? t })),
          selected: filters.types,
          multiple: true,
          onToggle: (v) => {
            if (filters.types.has(v)) filters.types.delete(v);
            else filters.types.add(v);
            applyFilters();
          },
        });
      case 'accountId':
        return chipPanel({
          title: '账户',
          options: [
            { value: '', label: '全部账户' },
            ...activeAccounts.map((a) => ({ value: a.id, label: a.name, icon: a.icon })),
          ],
          selected: new Set([filters.accountId]),
          onToggle: (v) => {
            filters.accountId = filters.accountId === v ? '' : v;
            applyFilters();
          },
        });
      case 'categoryId':
        return buildCategoryPanel();
      case 'tags':
        return buildTagPanel();
      case 'date':
        return buildDatePanel();
      case 'extras':
        return buildExtrasPanel();
      case 'sort':
        return chipPanel({
          title: '排序',
          options: SORTS,
          selected: new Set([filters.sort]),
          onToggle: (v) => {
            filters.sort = v;
            openFilter = null;
            applyFilters();
          },
        });
      default:
        return h('<div></div>');
    }
  }

  function chipPanel({ title, options, selected, multiple = false, onToggle }) {
    const node = h(`
      <div class="tx-panel__body">
        <p class="tx-panel__title">${esc(title)}</p>
        <div class="tx-panel__chips"></div>
      </div>
    `);
    const host = node.querySelector('.tx-panel__chips');
    options.forEach((o) => {
      const on = selected.has(o.value);
      const chip = h(`
        <button class="chip chip--mini" type="button" aria-checked="${on}" data-v="${esc(o.value)}">
          ${o.icon ? entityIcon(o.icon, 16) : ''}<span>${esc(o.label)}</span>
        </button>
      `);
      chip.addEventListener('click', () => onToggle(o.value, { multiple }));
      host.appendChild(chip);
    });
    return node;
  }

  function buildCategoryPanel() {
    const node = h(`
      <div class="tx-panel__body">
        <p class="tx-panel__title">分类（先选主分类，再可选到子分类）</p>
        <div class="tx-panel__chips" data-role="parents"></div>
        <div class="tx-panel__sub" data-role="children" hidden>
          <p class="tx-panel__title">子分类</p>
          <div class="tx-panel__chips" data-role="child-chips"></div>
        </div>
      </div>
    `);
    const parentHost = node.querySelector('[data-role=parents]');
    const childWrap = node.querySelector('[data-role=children]');
    const childHost = node.querySelector('[data-role=child-chips]');

    const all = h(`<button class="chip chip--mini" type="button" data-v="" aria-checked="${
      !filters.parentCategoryId && !filters.categoryId
    }"><span>全部分类</span></button>`);
    all.addEventListener('click', () => {
      filters.parentCategoryId = '';
      filters.categoryId = '';
      applyFilters();
    });
    parentHost.appendChild(all);

    catTrees.forEach((p) => {
      const on = filters.parentCategoryId === p.id || (p.children ?? []).some((c) => c.id === filters.categoryId);
      const chip = h(`
        <button class="chip chip--mini" type="button" aria-checked="${on}" data-v="${esc(p.id)}">
          ${entityIcon(p.icon, 16)}<span>${esc(p.name)}</span>
          <span class="chip__sub">${esc(RECORD_TYPE_LABEL[p.recordType] ?? '')}</span>
        </button>
      `);
      chip.addEventListener('click', () => {
        filters.parentCategoryId = filters.parentCategoryId === p.id ? '' : p.id;
        filters.categoryId = '';
        paintPanel();
        paintFilters();
        load({ reset: true });
      });
      parentHost.appendChild(chip);
    });

    const current = catTrees.find((p) => p.id === filters.parentCategoryId);
    if (current) {
      childWrap.hidden = false;
      const allChild = h(`<button class="chip chip--mini" type="button" aria-checked="${
        !filters.categoryId
      }" data-v=""><span>${esc(current.name)}（全部）</span></button>`);
      allChild.addEventListener('click', () => {
        filters.categoryId = '';
        applyFilters();
      });
      childHost.appendChild(allChild);
      (current.children ?? []).forEach((c) => {
        const chip = h(`
          <button class="chip chip--mini" type="button" aria-checked="${
            filters.categoryId === c.id
          }" data-v="${esc(c.id)}">
            ${entityIcon(c.icon, 16)}<span>${esc(c.name)}</span>
          </button>
        `);
        chip.addEventListener('click', () => {
          filters.categoryId = filters.categoryId === c.id ? '' : c.id;
          applyFilters();
        });
        childHost.appendChild(chip);
      });
    }
    return node;
  }

  function buildTagPanel() {
    const node = h(`
      <div class="tx-panel__body">
        <p class="tx-panel__title">标签${filters.tags.size > 1 ? '（多选）' : ''}</p>
        <div class="tx-panel__chips" data-role="tag-chips"></div>
        <div class="tx-panel__foot" data-role="mode" ${filters.tags.size > 1 ? '' : 'hidden'}>
          <span class="tt-fine-print">多标签匹配：</span>
          <button class="chip chip--mini" type="button" data-mode="any" aria-checked="${
            filters.tagMatchMode === 'any'
          }">任一命中</button>
          <button class="chip chip--mini" type="button" data-mode="all" aria-checked="${
            filters.tagMatchMode === 'all'
          }">全部命中</button>
        </div>
      </div>
    `);
    const host = node.querySelector('[data-role=tag-chips]');
    if (tags.length === 0) {
      host.appendChild(h(`<span class="tt-fine-print text-muted">这个账本还没有标签</span>`));
    }
    tags.forEach((t) => {
      const chip = h(`
        <button class="chip chip--mini" type="button" aria-checked="${filters.tags.has(t.id)}"
                data-v="${esc(t.id)}" style="--tag:${esc(t.color)}">
          <span class="chip__dot"></span><span>${esc(t.name)}</span>
        </button>
      `);
      chip.addEventListener('click', () => {
        if (filters.tags.has(t.id)) filters.tags.delete(t.id);
        else filters.tags.add(t.id);
        applyFilters();
      });
      host.appendChild(chip);
    });
    node.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        filters.tagMatchMode = b.dataset.mode;
        applyFilters();
      }),
    );
    return node;
  }

  /**
   * 「附加」面板：折扣 / 手续费 两个可多选的子项。
   *
   * 刻意复用 `chipPanel` 而不是新写一套复选框 —— 与「类型」面板的
   * 视觉与交互完全同源（chip + `aria-checked` + 点一下即生效），
   * 用户不需要在两套控件语法之间切换。
   */
  function buildExtrasPanel() {
    return chipPanel({
      title: '附加项（可多选）',
      options: [
        { value: 'discount', label: '折扣' },
        { value: 'fee', label: '手续费' },
      ],
      selected: filters.extras,
      multiple: true,
      onToggle: (v) => {
        if (filters.extras.has(v)) filters.extras.delete(v);
        else filters.extras.add(v);
        applyFilters();
      },
    });
  }

  function buildDatePanel() {
    const active = matchPreset(filters.dateFrom, filters.dateTo);
    const node = h(`
      <div class="tx-panel__body">
        <p class="tx-panel__title">日期范围</p>
        <div class="tx-panel__chips" data-role="presets"></div>
        <div class="tx-panel__foot">
          <input class="input" type="date" data-role="from" value="${esc(filters.dateFrom)}" aria-label="开始日期" />
          <span class="tt-fine-print">至</span>
          <input class="input" type="date" data-role="to" value="${esc(filters.dateTo)}" aria-label="结束日期" />
          <button class="btn btn--sm" type="button" data-role="apply-date">应用</button>
        </div>
      </div>
    `);
    const host = node.querySelector('[data-role=presets]');
    DATE_PRESETS.filter((p) => p.key !== 'custom').forEach((p) => {
      const chip = h(`
        <button class="chip chip--mini" type="button" aria-checked="${active === p.key}" data-v="${p.key}">
          <span>${esc(p.label)}</span>
        </button>
      `);
      chip.addEventListener('click', () => {
        const r = resolvePreset(p.key);
        filters.dateFrom = r.from;
        filters.dateTo = r.to;
        applyFilters();
      });
      host.appendChild(chip);
    });
    node.querySelector('[data-role=apply-date]').addEventListener('click', () => {
      filters.dateFrom = node.querySelector('[data-role=from]').value;
      filters.dateTo = node.querySelector('[data-role=to]').value;
      applyFilters();
    });
    return node;
  }

  function applyFilters() {
    paintPanel();
    paintFilters();
    load({ reset: true });
  }

  $('[data-role=clear]').addEventListener('click', () => {
    filters.types.clear();
    filters.accountId = '';
    filters.parentCategoryId = '';
    filters.categoryId = '';
    filters.tags.clear();
    filters.extras.clear();
    filters.dateFrom = '';
    filters.dateTo = '';
    filters.keyword = '';
    filters.sort = '-occurredAt';
    openFilter = null;
    applyFilters();
    toast('已清除全部筛选');
  });

  // 搜索：输入不请求（防抖 400ms），回车立即请求 —— 与记账页的双算时机同源
  let kwTimer = null;
  $('[data-role=keyword]').addEventListener('input', (e) => {
    filters.keyword = e.target.value;
    if (kwTimer) clearTimeout(kwTimer);
    kwTimer = setTimeout(() => {
      paintFilters();
      load({ reset: true });
    }, 400);
  });
  $('[data-role=keyword]').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (kwTimer) clearTimeout(kwTimer);
    filters.keyword = e.target.value;
    load({ reset: true });
  });

  /* ================================================================== *
   * 列表渲染
   * ================================================================== */

  function skeletonRows(n) {
    const wrap = h('<div class="tx-day"></div>');
    for (let i = 0; i < n; i += 1) {
      wrap.appendChild(
        h(`<div class="card card--flush tx-skel">
             <div class="skeleton" style="width:22%"></div>
             <div class="skeleton" style="width:46%;margin-top:12px"></div>
           </div>`),
      );
    }
    return wrap;
  }

  function paintList() {
    if (loadError && items.length === 0) {
      listSlot.replaceChildren(errorBlock(loadError));
      return;
    }

    if (items.length === 0) {
      listSlot.replaceChildren(emptyBlock());
      return;
    }

    // 按 txDate 归组（后端已按 occurredAt 降序，这里只做分组不重排）
    const groups = [];
    let last = null;
    for (const tx of items) {
      if (!last || last.date !== tx.txDate) {
        last = { date: tx.txDate, rows: [] };
        groups.push(last);
      }
      last.rows.push(tx);
    }

    const frag = document.createDocumentFragment();
    groups.forEach((g) => frag.appendChild(dayGroup(g)));
    if (loadError) frag.appendChild(errorBlock(loadError, { inline: true }));
    listSlot.replaceChildren(frag);
    // 重绘后把选择态重新贴回去（列表是整段替换的，状态不在 DOM 上）
    listSlot.classList.toggle('is-selecting', selectionMode);
  }

  function dayGroup(g) {
    const cell = byDate[g.date];
    const node = h(`
      <section class="tx-day">
        <header class="tx-day__head">
          <h2 class="tx-day__date">${esc(dayLabel(g.date))}<span class="tx-day__wd">${esc(
            dayWeekday(g.date),
          )}</span></h2>
          <p class="tx-day__sum tnum">
            ${
              cell
                ? `${Number(cell.totalExpense) ? `<span class="is-neg">支出 ${money(Number(cell.totalExpense))}</span>` : ''}
                   ${Number(cell.totalIncome) ? `<span class="is-pos">收入 ${money(Number(cell.totalIncome))}</span>` : ''}
                   <span class="tx-day__count">${cell.count} 笔</span>`
                : ''
            }
          </p>
        </header>
        <div class="card card--flush tx-day__body"></div>
      </section>
    `);
    const body = node.querySelector('.tx-day__body');
    g.rows.forEach((tx) => body.appendChild(rowNode(tx)));
    return node;
  }

  /**
   * 行：**一套 DOM 服务三档断点**（列显隐全部交给 CSS）。
   *
   * 六个信息列的顺序与 `docs/13 §9.3` 一致：时间 · 分类 · 名称 · 账户 · 商家/对象 · 金额。
   * `.tx-row__meta` 是个开关：桌面 `display: contents`（三个子元素各自成为一列），
   * 移动 `display: flex`（折叠成第二行「名称 · 账户 · 商家」）。
   * 这样就不需要为移动端写第二套模板 —— 两套模板必然会在改字段时漏改一边。
   */
  function rowNode(tx) {
    const delta = Number(tx.signedAmount ?? tx.accountDelta ?? 0);
    const extra = extraText(tx);
    const badge = typeBadge(tx);
    const dots = tagDots(tx);
    /**
     * 徽标格**始终存在**（没有徽标时为空）。
     * 不能按需省略：行是 `grid-template-columns` 定死轨道的网格，
     * 少一个元素会让后面的子元素整体前移一格 —— 金额列会与相邻行错开。
     * 空 span 落在 `auto` 轨道上宽度为 0，不占位。
     */
    const badges = [
      badge ? `<span class="badge">${esc(badge)}</span>` : '',
      tx.attachmentCount ? `<span class="badge">${esc(String(tx.attachmentCount))} 附件</span>` : '',
    ].join('');

    const node = h(`
      <div class="tx-row" data-id="${esc(tx.id)}" data-tone="${amountTone(delta)}">
        <label class="tx-row__pick" title="选择">
          <input type="checkbox" tabindex="-1" aria-label="选择「${esc(subjectText(tx))}」" />
        </label>

        <span class="tx-row__time tnum">${esc(tx.txTime ? String(tx.txTime).slice(0, 5) : '—')}</span>

        <span class="tx-row__subject">
          <span class="tx-row__icon">${entityIcon(subjectIcon(tx), 16)}</span>
          <span class="tx-row__cat">${esc(subjectText(tx))}</span>
          ${
            dots.shown.length
              ? `<span class="tx-row__tags">${dots.shown
                  .map(
                    (t) =>
                      `<span class="tx-dot" style="--tag:${esc(t.color)}" title="${esc(t.name)}"></span>`,
                  )
                  .join('')}${
                  dots.more ? `<span class="tx-row__tags-more">+${dots.more}</span>` : ''
                }</span>`
              : ''
          }
        </span>

        <span class="tx-row__meta">
          <span class="tx-row__name">${esc(tx.name ?? '')}</span>
          <span class="tx-row__acct">${esc(tx.account?.name ?? '')}</span>
          <span class="tx-row__extra">${esc(extra)}</span>
          <span class="tx-row__badges">${badges}</span>
        </span>

        <span class="tx-row__amt tnum ${amountTone(delta)}">${esc(amountText(delta))}</span>

        <button class="tx-row__more" type="button" aria-label="更多操作" aria-haspopup="menu"
                aria-expanded="false">${lucide('ellipsis', 18)}</button>
        <div class="tx-row__menu" role="menu" hidden>
          <button class="tx-row__menu-item" type="button" role="menuitem" data-act="open">${lucide('eye', 16)}查看详情</button>
          ${
            tx.recordType === 'adjustment'
              ? ''
              : `<button class="tx-row__menu-item" type="button" role="menuitem" data-act="edit">${lucide('pencil', 16)}编辑</button>`
          }
          <button class="tx-row__menu-item" type="button" role="menuitem" data-act="copy">${lucide('copy', 16)}复制一笔</button>
          <button class="tx-row__menu-item tx-row__menu-item--danger" type="button" role="menuitem" data-act="del">${lucide('trash-2', 16)}移入回收站</button>
        </div>
      </div>
    `);

    if (selected.has(tx.id)) node.classList.add('is-picked');

    /* ---- 行点击 → 详情（排除勾选与动作按钮） ---- */
    node.addEventListener('click', (e) => {
      if (e.target.closest('button, input, label, .tx-row__menu')) return;
      if (selectionMode) {
        togglePick(tx.id);
        return;
      }
      go(`/transactions/${encodeURIComponent(tx.id)}`);
    });

    /* ---- 桌面：复选框 ---- */
    const check = node.querySelector('input[type=checkbox]');
    check.checked = selected.has(tx.id);
    check.addEventListener('change', () => togglePick(tx.id, true));

    /* ---- 动作菜单 ---- */
    const moreBtn = node.querySelector('.tx-row__more');
    const menu = node.querySelector('.tx-row__menu');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeAllMenus();
      menu.hidden = !willOpen;
      /**
       * 展开方向：默认向下；下方放不下时翻到行的上方。
       *
       * 裁切问题已经由 `.tx-day__body { overflow: visible }` 解决（见 app.css），
       * 这里只管另一半：行靠近视口底部时，向下展开的菜单会跑出屏幕 ——
       * 那同样表现为「只能看到一点点」。翻上去的前提是上方真的放得下，
       * 否则宁可留在下方（至少还能滚）。
       */
      if (willOpen) {
        menu.classList.remove('tx-row__menu--up');
        const rowRect = node.getBoundingClientRect();
        const menuH = menu.offsetHeight;
        const roomBelow = window.innerHeight - rowRect.bottom;
        const roomAbove = rowRect.top;
        if (menuH + 8 > roomBelow && roomAbove > menuH + 8) {
          menu.classList.add('tx-row__menu--up');
        }
      }
      moreBtn.setAttribute('aria-expanded', String(willOpen));
      node.classList.toggle('is-menu', willOpen);
      if (willOpen) menu.querySelector('.tx-row__menu-item')?.focus({ preventScroll: true });
    });
    menu.querySelectorAll('[data-act]').forEach((item) =>
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAllMenus();
        const act = item.dataset.act;
        if (act === 'open') go(`/transactions/${encodeURIComponent(tx.id)}`);
        else if (act === 'edit') go(`/transactions/${encodeURIComponent(tx.id)}/edit`);
        else if (act === 'copy') go(`/transactions/new?copyFrom=${encodeURIComponent(tx.id)}`);
        else if (act === 'del') await removeOne(tx);
      }),
    );

    /* ---- 移动：长按 400ms 进选择态（与「记」同源的手势参数） ---- */
    let timer = null;
    let sx = 0;
    let sy = 0;
    let pressed = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    node.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return; // 桌面走 hover 复选框
      pressed = false;
      sx = e.clientX;
      sy = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        pressed = true;
        enterSelection(tx.id);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    });
    node.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > MOVE_CANCEL_PX || Math.abs(e.clientY - sy) > MOVE_CANCEL_PX) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'contextmenu'].forEach((evt) =>
      node.addEventListener(evt, cancel),
    );
    node.addEventListener(
      'click',
      (e) => {
        if (!pressed) return;
        pressed = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );

    return node;
  }

  function closeAllMenus() {
    listSlot.querySelectorAll('.tx-row__menu').forEach((m) => {
      m.hidden = true;
      // 方向是「这一次展开」的结果，不该残留到下一次（那次可能放得下）
      m.classList.remove('tx-row__menu--up');
    });
    listSlot.querySelectorAll('.tx-row__more').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    listSlot.querySelectorAll('.tx-row.is-menu').forEach((r) => r.classList.remove('is-menu'));
  }

  // 视图被换掉后这两个文档级监听仍挂着，所以进来先确认 frame 还在文档里再干活
  document.addEventListener('click', (e) => {
    if (!frame.isConnected) return;
    if (!e.target.closest('.tx-row__more, .tx-row__menu')) closeAllMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (!frame.isConnected) return;
    if (e.key === 'Escape') closeAllMenus();
  });

  /* ---------------- 选择态 ---------------- */

  function enterSelection(id) {
    selectionMode = true;
    if (id) selected.add(id);
    syncSelection();
  }

  function togglePick(id, force) {
    if (force === true) selected.add(id);
    else if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    selectionMode = selected.size > 0;
    syncSelection();
  }

  function syncSelection() {
    listSlot.classList.toggle('is-selecting', selectionMode);
    listSlot.querySelectorAll('.tx-row').forEach((row) => {
      const on = selected.has(row.dataset.id);
      const box = row.querySelector('input[type=checkbox]');
      if (box) box.checked = on;
      row.classList.toggle('is-picked', on);
    });
    paintSelectBar();
  }

  function paintSelectBar() {
    let bar = frame.querySelector('[data-role=selectbar]');
    if (!selectionMode) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = h(`
        <div class="tx-selectbar" data-role="selectbar" role="region" aria-label="批量操作">
          <span class="tx-selectbar__count" data-role="sel-count"></span>
          <button class="btn btn--quiet btn--sm" type="button" data-role="sel-cancel">取消</button>
          <button class="btn btn--quiet btn--sm" type="button" data-role="sel-tag">打标签</button>
          <button class="btn btn--danger btn--sm" type="button" data-role="sel-del">移入回收站</button>
        </div>
      `);
      bar.querySelector('[data-role=sel-cancel]').addEventListener('click', () => {
        selected.clear();
        selectionMode = false;
        syncSelection();
      });
      bar.querySelector('[data-role=sel-del]').addEventListener('click', batchRemove);
      bar.querySelector('[data-role=sel-tag]').addEventListener('click', openBatchTag);
      frame.appendChild(bar);
    }
    bar.querySelector('[data-role=sel-count]').textContent = `已选 ${selected.size} 笔`;
  }

  function openBatchTag() {
    if (selected.size === 0) return;
    const node = h(`
      <div class="card tx-batchtag">
        <div class="row row--between row--wrap">
          <p class="tt-body-strong">给选中的 ${selected.size} 笔打标签</p>
          <button class="btn btn--quiet btn--sm" type="button" data-role="close">关闭</button>
        </div>
        <div class="tx-panel__chips" data-role="chips"></div>
        <div class="row">
          <button class="btn btn--sm" type="button" data-role="add">追加标签</button>
          <span class="tt-fine-print">追加不会移除这笔账单已有的标签</span>
        </div>
      </div>
    `);
    const picked = new Set();
    const host = node.querySelector('[data-role=chips]');
    if (tags.length === 0) host.appendChild(h('<span class="tt-fine-print text-muted">还没有标签，请先到「标签」页新建</span>'));
    tags.forEach((t) => {
      const chip = h(`
        <button class="chip chip--mini" type="button" aria-checked="false" style="--tag:${esc(t.color)}">
          <span class="chip__dot"></span><span>${esc(t.name)}</span>
        </button>
      `);
      chip.addEventListener('click', () => {
        const on = picked.has(t.id);
        if (on) picked.delete(t.id);
        else picked.add(t.id);
        chip.setAttribute('aria-checked', String(!on));
      });
      host.appendChild(chip);
    });
    node.querySelector('[data-role=close]').addEventListener('click', () => node.remove());
    node.querySelector('[data-role=add]').addEventListener('click', async (e) => {
      if (picked.size === 0) {
        toast('请先选择要追加的标签', 'error');
        return;
      }
      const btn = e.currentTarget;
      setLoading(btn, true, '处理中');
      try {
        await Api.batchTagTransactions(ledger.id, [...selected], [...picked], 'add');
        toast(`已给 ${selected.size} 笔账单追加 ${picked.size} 个标签`, 'success');
        node.remove();
        selected.clear();
        selectionMode = false;
        load({ reset: true });
      } catch (err) {
        setLoading(btn, false);
        toast(err.message, 'error');
      }
    });
    frame.appendChild(node);
  }

  async function batchRemove() {
    if (selected.size === 0) return;
    if (!window.confirm(`确认把选中的 ${selected.size} 笔账单移入回收站？\n\n回收站保留 30 天，期间可随时恢复。`)) return;
    const ids = [...selected];
    try {
      await Api.batchDeleteTransactions(ledger.id, ids);
      selected.clear();
      selectionMode = false;
      toast(`已移入回收站 ${ids.length} 笔`, 'success');
      load({ reset: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 单笔删除（软删除 + 撤销） ---------------- */

  async function removeOne(tx) {
    const label = subjectText(tx);
    if (!window.confirm(`把「${label} ${amountText(tx.signedAmount)}」移入回收站？\n\n回收站保留 30 天，期间可恢复。`))
      return;
    try {
      await Api.deleteTransaction(ledger.id, tx.id);
      load({ reset: true });
      actionToast(`已移入回收站 · ${label}`, [
        {
          label: '撤销',
          primary: true,
          onClick: async () => {
            try {
              await Api.restoreTransaction(ledger.id, tx.id);
              toast('已恢复', 'success');
              load({ reset: true });
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ]);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ================================================================== *
   * 空态 / 错误 / 底部分页
   * ================================================================== */

  function emptyBlock() {
    const filtered = activeFilterCount() > 0;
    return h(`
      <div class="card empty-state">
        <span class="empty-state__icon">${lucide(filtered ? 'search' : 'receipt', 22)}</span>
        <p class="tt-body-strong">${filtered ? '没有符合条件的账单' : '还没有账单'}</p>
        <p class="tt-caption text-muted">${
          filtered
            ? '换个条件试试，或清除全部筛选看看所有账单。'
            : '账单总是从第一笔开始的。记下今天花的钱，这里就有内容了。'
        }</p>
        ${
          filtered
            ? '<button class="btn btn--sm" type="button" data-role="empty-clear">清除全部筛选</button>'
            : '<a class="btn btn--sm" href="/transactions/new" data-link>记第一笔</a>'
        }
      </div>
    `);
  }

  function errorBlock(err, { inline = false } = {}) {
    const node = h(`
      <div class="card tx-error">
        <span class="tx-error__icon">${lucide('triangle-alert', 20)}</span>
        <div class="tx-error__main">
          <p class="tt-body-strong">账单没能加载出来</p>
          <p class="tt-caption text-muted">${
            inline ? '已有的账单还在下面，重试即可补上这一页。' : ''
          }${esc(err?.message ?? '网络或服务暂时不可用')}</p>
        </div>
        <button class="btn btn--sm" type="button" data-role="retry">重试</button>
      </div>
    `);
    node.querySelector('[data-role=retry]').addEventListener('click', (e) => {
      setLoading(e.currentTarget, true, '重试中');
      load({ reset: !inline }).finally(() => setLoading(e.currentTarget, false));
    });
    return node;
  }

  function paintFoot() {
    if (items.length === 0) {
      footSlot.replaceChildren();
      const btn = listSlot.querySelector('[data-role=empty-clear]');
      btn?.addEventListener('click', () => $('[data-role=clear]').click());
      return;
    }
    const hasMore = page.n < page.totalPages;
    if (!hasMore) {
      footSlot.replaceChildren(
        h(`<p class="tx-foot__end">已全部加载 · 共 ${page.total} 笔</p>`),
      );
      return;
    }
    const node = h(`
      <div class="tx-foot">
        <button class="btn btn--secondary btn--sm" type="button" data-role="more-btn">
          加载更多（还有 ${page.total - items.length} 笔）
        </button>
        <span class="tx-foot__sentinel" data-role="sentinel" aria-hidden="true"></span>
      </div>
    `);
    node.querySelector('[data-role=more-btn]').addEventListener('click', () => load());
    footSlot.replaceChildren(node);

    // 移动端滚动到底自动加载（docs/13 §9.2）；桌面保留显式按钮
    const sentinel = node.querySelector('[data-role=sentinel]');
    if (window.IntersectionObserver && window.matchMedia('(max-width: 833px)').matches) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting) && !morePending) {
            io.disconnect();
            load();
          }
        },
        { rootMargin: '160px' },
      );
      io.observe(sentinel);
    }
  }

  /* ---------------- 启动 ---------------- */
  await load({ reset: true });
  return frame;
}
