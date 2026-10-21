/**
 * 对账历史与账本健康度（`docs/04 §12.3 / §12.4`，`docs/05 §9.7`）
 *
 * ## 为什么要有这一页
 *
 * 对账这个动作在 `/accounts` 里发生（每个账户一个「对账」按钮 → 面板），
 * 但**对完就结束了**：面板收起后，这次对账的账面/实际/差额/原因/操作人
 * 只留在 `reconciliation_records` 表里，前端没有任何入口能看到。
 *
 * 这不是锦上添花。口径变更（`docs/14`）之后尤其要紧：历史记录里的
 * `systemBalance` 是**当时按当时口径算出来的**，变更日之前的记录与之后的
 * 记录**不可直接比较**。用户看到余额跳变时的第一反应是「我的钱丢了」，
 * 而答案就在这些记录里 —— 他得能翻到它。
 *
 * ## 两个数据源，一页呈现
 *
 *   · `reconciliationSummary` → 账本健康度：对过几个账户、90 天对了几次、
 *     平均差额多大、**哪些账户该对了**。这是「现在该做什么」。
 *   · `listReconciliations` → 历史记录流。这是「过去发生了什么」。
 *
 * 后端两个接口早就存在且**前端从未调用过**，这一页是它们的第一个消费方。
 *
 * ## 口径标注必须挂在记录上，不能只写页脚
 *
 * 每条记录带 `legacyBoundary`（`createdAt` 早于口径变更日即 true）。
 * 用户翻历史通常是为了核对**某一条**，图省事只在页头写一句总说明等于没写。
 *
 * ## 版式：这一页自己管了三套列定义
 *
 * 复用既有排版类（`stat-strip` / `badge` / `empty-state` / `list-meta` /
 * `section` / `card`），但**不复用 `.recon-line`** —— 它是 flex 两端对齐，
 * 每一行独立算宽，同一列在上下行必然错位。本页的四处列表（排期、记录、
 * 该对账了、卡内明细）统一改成「列定义写进 `--*-cols` 变量、表头与数据行
 * 引用同一个变量」的栅格，详见 app.css「对账历史页」那一节。
 * 原则是**：同一套列的宽度定义只能存在一处**，改列只改一处。
 *
 * 新增的类只有 `.recon-sched*` / `.recon-hist*` / `.metric*` / `.recon-todo*`
 * 这四族（记录行的四列布局没有现成等价物）。不新造 `badge--success` 这类
 * 「看起来该有」的类：它们和既有阶梯差一档就等于把阶梯完整性打坏了
 * （见 MEMORY 的排版纪律）—— 三态一律用既有的 `.badge` / `.badge--accent` /
 * `.badge--danger`。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { esc, icon, money, toast, RECONCILE_REASON_LABEL } from '../ui.js';

/**
 * 收支配色。与股票相反 —— 本项目「负向 = 红、正向 = 绿」
 * （`.is-neg/.is-pos`，代码注释里已写明，别按 A 股直觉反过来）。
 *
 * ⚠️ 只能给**有符号含义**的数字用。差额有（多出来/少了），
 * 「平均差额」没有（它是 `avg(abs(...))`，恒正 —— 染绿等于在说「差得挺好」）。
 */
function toneClass(v) {
  const n = Number(v ?? 0);
  return n < 0 ? 'is-neg' : n > 0 ? 'is-pos' : 'is-zero';
}

/** `2026-10-01T20:00:00+08:00` → `10-01 20:00`；非法值原样返回 */
function shortStamp(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(iso ?? '');
}

/** 相对天数的自然说法。null = 从未对账，与「对过但很久」不是一回事 */
function daysText(days) {
  if (days === null || days === undefined) return '从未对账';
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function dateFromDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function renderReconciliations(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  /** 筛选初值取自 URL —— 分享/刷新能保持，但不必进 app.js 的路由表 */
  const params = new URLSearchParams(window.location.search);
  let accountFilter = params.get('accountId') ?? '';
  let range = params.get('range') ?? '90';

  const [summary, accRes] = await Promise.all([
    Api.reconciliationSummary(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
  ]);
  /** 虚拟账户是台账口径，从不对账，不进筛选项（否则选出来永远是空） */
  const accounts = accRes.filter((a) => a.kind !== 'virtual');

  const frame = appFrame({
    active: 'reconciliations',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">对账历史</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 每次对账的账面、实际与差额都留痕，可随时回查
            </p>
          </div>
          <button class="btn btn--secondary btn--sm" type="button" data-role="to-accounts">
            ${icon('wallet', 16)}<span>去对账</span>
          </button>
        </div>
      </div>

      <div class="stat-strip recon-hist__health" data-role="health"></div>
      <div data-role="todo"></div>
      <div data-role="schedule"></div>
      <div data-role="tools"></div>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">对账记录</h2>
          <div class="row row--md row--wrap recon-hist__filters">
            <select class="input recon-hist__select" data-role="f-account" aria-label="按账户筛选">
              <option value="">全部账户</option>
              ${accounts
                .map(
                  (a) =>
                    `<option value="${esc(a.id)}"${a.id === accountFilter ? ' selected' : ''}>${esc(a.name)}</option>`,
                )
                .join('')}
            </select>
            <select class="input recon-hist__select" data-role="f-range" aria-label="时间范围">
              <option value="30"${range === '30' ? ' selected' : ''}>近 30 天</option>
              <option value="90"${range === '90' ? ' selected' : ''}>近 90 天</option>
              <option value="365"${range === '365' ? ' selected' : ''}>近一年</option>
              <option value=""${range === '' ? ' selected' : ''}>全部</option>
            </select>
          </div>
        </div>
        <div data-role="list"></div>
      </section>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'reconciliations', go, ledger });

  const healthSlot = frame.querySelector('[data-role=health]');
  const todoSlot = frame.querySelector('[data-role=todo]');
  const schedSlot = frame.querySelector('[data-role=schedule]');
  const toolsSlot = frame.querySelector('[data-role=tools]');
  const listSlot = frame.querySelector('[data-role=list]');
  const accSelect = frame.querySelector('[data-role=f-account]');
  const rangeSelect = frame.querySelector('[data-role=f-range]');

  /* ---------------- 健康度 ---------------- */

  function paintHealth() {
    const need = summary.unreconciledList ?? [];
    /**
     * 「该对账了」里混着两种情况，权重完全不同：
     *   · 对过但**当前差额非零**（`currentDiff ≠ 0`）→ 更紧急，改完才算对过
     *   · 超过 30 天没对（`daysSinceReconcile` 大）
     * 混在一张列表里按同一句文案渲染，会让「从没对过」和「对完还差着」看起来一样重。
     */
    const drifted = need.filter((x) => Number(x.currentDiff ?? 0) !== 0);
    const stale = need.filter((x) => (x.daysSinceReconcile ?? 0) > 30);
    /**
     * ⚠️ **「从未对账」必须单列一类**。
     *
     * 后端把 `lastReconciledAt === null` 的账户也塞进 `unreconciledList`，
     * 但它的 `daysSinceReconcile` 是 **null**。而上面两个过滤条件是
     * `currentDiff !== 0` 和 `daysSinceReconcile > 30` —— `null > 30` 为 false，
     * `null ?? 0` 也不大于 30，于是这类账户**从两个条件里都漏出去**，
     * 待办清单里看不到它，兜底文案于是打印「所有账户都对过」。
     *
     * 那是**最坏的一种错**：新账户完全不存在于待办里，而用户被告知一切正常。
     * （第一版截图就是 2/3 已对账却写着「所有账户都对过」。）
     */
    const never = need.filter(
      (x) => x.lastReconciledAt === null || x.lastReconciledAt === undefined,
    );
    /** 只列真正需要动作的：从未对过 / 对完还差着 / 超过 30 天没对 */
    const pending = never.length + drifted.length + stale.length;

    healthSlot.innerHTML = `
      <div class="stat-strip__cell">
        <span class="stat-strip__label">已对账账户</span>
        <span class="stat-strip__value tnum">${summary.reconciledAccounts} / ${summary.totalAccounts}</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">当前有差额</span>
        <span class="stat-strip__value tnum ${summary.accountsWithDiff ? 'is-neg' : 'is-zero'}">${
          summary.accountsWithDiff
        }</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">近 90 天对账</span>
        <span class="stat-strip__value tnum">${summary.reconcileCount90d} 次</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">平均差额</span>
        <!--
          刻意**不**套 toneClass：avgAbsDiff 是 avg(abs(diff))，恒为正，
          按收支配色（正=绿）会把它染绿，读起来像「平均差 ¥33 挺好的」。
          平均差额的大小本身没有好坏，只有「比上次大/小」，这一版没有上期值可比。
          语义色只给**有符号含义**的数字用（差额有，avgAbsDiff 没有）。
        -->
        <span class="stat-strip__value tnum">${money(summary.avgAbsDiff)}</span>
      </div>
    `;

    todoSlot.innerHTML = pending
      ? `
      <div class="card stack stack--sm">
        <div class="recon-todo">
          <div class="recon-todo__row">
            <span class="tt-caption recon-todo__name text-muted">该对账了</span>
            <span class="tt-body-strong">${pending} 个账户</span>
          </div>
          ${never
            .map(
              (x) => `<div class="recon-todo__row">
              <span class="tt-caption recon-todo__name">${esc(x.accountName)}</span>
              <span class="tt-caption text-muted">从未对账</span>
            </div>`,
            )
            .join('')}
          ${drifted
            .map(
              (x) => `<div class="recon-todo__row">
              <span class="tt-caption recon-todo__name">${esc(x.accountName)}</span>
              <span class="tt-caption is-neg tnum">当前差额 ${money(x.currentDiff)}</span>
            </div>`,
            )
            .join('')}
          ${stale
            .map(
              (x) => `<div class="recon-todo__row">
              <span class="tt-caption recon-todo__name">${esc(x.accountName)}</span>
              <span class="tt-caption text-muted">${daysText(x.daysSinceReconcile)}没对了</span>
            </div>`,
            )
            .join('')}
        </div>
        <button class="btn btn--sm btn--secondary" type="button" data-role="go-recon">去账户页对账</button>
      </div>`
      : `
      <div class="card">
        <p class="tt-caption text-muted">所有账户都对过，且当前无差额。</p>
      </div>`;

    todoSlot.querySelector('[data-role=go-recon]')?.addEventListener('click', () => go('/accounts'));
  }

  /* ---------------- 记录列表 ---------------- */

  /**
   * 记录行 = 四列栅格：**标签 / 状态 / 金额 / 时间**（列定义见 app.css 的 `--hist-cols`）。
   *
   * 以前是「左叙述 + 右数字」两栏，右栏的起始 x 由左栏有多长决定 ——
   * 某一行多一行归因说明，右栏整体就被推走，账面与实际对不齐。
   * 现在是四列，金额与时间各自占固定的列，互相不再拉扯。
   *
   * ⚠️ 两个**取值锚点**不能动（探针与人工核对都依赖它）：
   *   · 行内**第一个** `.tt-body-strong` = 账户名 —— 所以 ① 列里
   *     不能出现第二个同类节点；
   *   · 行内**第一个** `.tt-fine-print` = 含 `reconcileDate` 的日期行 ——
   *     所以金额标签与归因说明都用自己的类（`.recon-hist__num-label` /
   *     `.recon-hist__reason` / `.recon-hist__sub`），不复用 tt-fine-print。
   *     这是「只要读错一个同类兄弟节点就静默取到别的句子」的那类错误，不报错。
   */
  function rowHtml(r) {
    const balanced = r.isBalanced;
    const reason = [
      r.reasonCode ? RECONCILE_REASON_LABEL[r.reasonCode] ?? r.reasonCode : '',
      r.reasonNote ?? '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `
      <div class="recon-hist__row">
        <div class="recon-hist__label">
          <span class="tt-body-strong recon-hist__acct">${esc(r.account?.name ?? '—')}</span>
          ${
            reason
              ? `<span class="recon-hist__reason" title="${esc(reason)}">${esc(reason)}</span>`
              : ''
          }
        </div>
        <div class="recon-hist__status">
          ${
            balanced
              ? `<span class="badge badge--dark">账实相符</span>`
              : `<span class="badge">差额 <span class="tnum ${toneClass(r.diffAmount)}">${money(
                  r.diffAmount,
                )}</span></span>`
          }
          ${
            r.legacyBoundary
              ? `<span class="badge" title="该记录录入于 ${esc(
                  (r.createdAt ?? '').slice(0, 10),
                )}，账面余额按旧口径计算（建账当天的流水不计入）">旧口径</span>`
              : ''
          }
        </div>
        <div class="recon-hist__nums">
          <span class="recon-hist__num"
            ><span class="recon-hist__num-label">账面</span
            ><span class="tnum recon-hist__amt">${money(r.systemBalance)}</span></span
          >
          <span class="recon-hist__num"
            ><span class="recon-hist__num-label">实际</span
            ><span class="tnum recon-hist__amt">${money(r.actualBalance)}</span></span
          >
          ${
            r.adjustmentTransactionId
              ? `<a class="recon-hist__adj" href="/transactions/${encodeURIComponent(
                  r.adjustmentTransactionId,
                )}" data-link>查看调整单</a>`
              : balanced
                ? ''
                : `<span class="recon-hist__sub">未生成调整单</span>`
          }
        </div>
        <div class="recon-hist__when">
          <span class="tt-fine-print recon-hist__date">对账日 ${esc(r.reconcileDate)}</span>
          <span class="recon-hist__sub"
            >录入 ${esc(shortStamp(r.createdAt))}${r.operator?.nickname ? ` · ${esc(r.operator.nickname)}` : ''}</span
          >
        </div>
      </div>`;
  }

  async function load() {
    /**
     * 加载态画**三根递减的骨架**，而不是一根。
     *
     * 一根孤立的条给不出「这是一个列表」的信息，用户读到的是「什么都没有」
     * 而不是「正在加载」—— 列表页的骨架屏必须像列表。
     * 三根宽度也刻意不同：等宽会读成三行同样的东西（不像记录行）。
     * 宽度写在 CSS 里：以前是这里写 `style="width:50%"`，把样式决策搬出样式层，
     * 是改造时最容易漏掉的一处。
     */
    listSlot.innerHTML = `<div class="card card--flush">
      <div class="recon-hist__loading">
        <span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span>
      </div>
    </div>`;
    const query = {};
    if (accountFilter) query.accountId = accountFilter;
    if (range) query.dateFrom = dateFromDaysAgo(Number(range));
    try {
      const rows = (await Api.listReconciliations(ledger.id, query)).data;

      if (!rows.length) {
        /**
         * 空态要说清**是哪一种空** —— 两件事对用户的下一步完全不同：
         *   · 这个账户**从没对过** → 该去对账（第一次）
         *   · 对过但**落在筛选范围外** → 该改筛选（去历史里翻）
         * 混成一句「暂无数据」，等于把该做的事也一起吞了。
         *
         * 判据用 `summary.unreconciledList` 里的 `lastReconciledAt === null`：
         * 后端已经算了「哪些账户从没对过」，不必在前端重新推断。
         */
        const sel = accounts.find((a) => a.id === accountFilter);
        const neverReconciled =
          !!sel && (summary.unreconciledList ?? []).some((x) => x.accountId === sel.id && !x.lastReconciledAt);
        const filtered = accountFilter || range;

        listSlot.innerHTML = `
          <div class="card">
            <div class="empty-state">
              <span class="empty-state__icon" aria-hidden="true">${icon('info', 20)}</span>
              <p class="tt-body-strong">${
                neverReconciled ? '还没有对账记录' : filtered ? '该范围内没有对账记录' : '还没有对账记录'
              }</p>
              <p class="tt-caption text-muted">
                ${
                  neverReconciled
                    ? `${sel.name} 还没有对过账。到账户页点它的「对账」，填入银行 App 里的实际余额即可。`
                    : filtered
                      ? '换个账户，或把时间范围放宽到「全部」。'
                      : '到账户页点某个账户的「对账」，填入银行 App 里的实际余额即可完成第一次对账。'
                }
              </p>
              ${
                neverReconciled || !filtered
                  ? '<button class="btn btn--sm btn--secondary" type="button" data-role="empty-go">去对账</button>'
                  : '<button class="btn btn--sm btn--quiet" type="button" data-role="empty-reset">看全部记录</button>'
              }
            </div>
          </div>`;
        listSlot.querySelector('[data-role=empty-go]')?.addEventListener('click', () => go('/accounts'));
        listSlot.querySelector('[data-role=empty-reset]')?.addEventListener('click', () => {
          accountFilter = '';
          range = '';
          accSelect.value = '';
          rangeSelect.value = '';
          load();
        });
        return;
      }

      const legacyCount = rows.filter((r) => r.legacyBoundary).length;
      listSlot.innerHTML = `
        <div class="card card--flush">
          ${
            legacyCount
              ? `<div class="recon-hist__legacy">
                   <span class="badge">旧口径</span>
                   <p class="tt-fine-print text-muted">
                     本页有 ${legacyCount} 条记录的账面余额是按<strong>旧口径</strong>算的
                     （建账当天的流水不计入余额），与其它记录不可直接比较 ——
                     若差额恰为期初日当天的净流水，说明当初的期初余额被填大了。
                   </p>
                 </div>`
              : ''
          }
          <div class="list-meta"><span class="tt-fine-print">共 ${rows.length} 条记录</span></div>
          <div class="recon-hist">${rows.map(rowHtml).join('')}</div>
        </div>`;
    } catch (err) {
      listSlot.innerHTML = `<div class="card"><p class="tt-caption text-muted">加载失败：${esc(err.message)}</p></div>`;
      toast(err.message, 'error');
    }
  }

  /* ================================================================== *
   * R-05 对账排期
   * ================================================================== */

  /**
   * 排期状态里 `never`（**从没对过账**）必须单独一档并排在前面。
   *
   * 它不是「逾期 999 天」：`daysSince` 为 null 时 `null > 30` 与
   * `null ?? 0 > 30` 都是 false，它会从所有「超期」条件里两边都漏掉。
   * 而「这个账户从来没人核过」恰恰是最该被看见的事。
   */
  const DUE_LABEL = {
    never: { text: '从未对账', cls: 'badge--danger' },
    overdue: { text: '已逾期', cls: 'badge--danger' },
    due: { text: '今天该对', cls: 'badge--accent' },
    upcoming: { text: '未到期', cls: '' },
    off: { text: '未设周期', cls: '' },
  };

  /**
   * 排期表：**表头与数据行引用同一条 `--sched-cols`**。
   *
   * 以前这里用 `.recon-line`（flex + justify-content: space-between），
   * 每一行是一条**独立**的 flex —— 行的列宽由该行自己的内容决定，
   * 于是「天府银行」和「招行信用卡」两行的同一列必然落在不同的 x 上。
   * 逐行校对宽度治不了本：下一行内容一变就复发。
   *
   * 现在的列定义只在 app.css 里存在一处（`.recon-sched` 的 `--sched-cols`），
   * 表头与行都 `var()` 引用它 —— 二者物理上无法错位，改列只需改一处。
   *
   * 列的角色也交给 CSS 判断（`> :nth-child(n+3)` 右对齐）：视图里不写任何
   * 对齐样式，因此不存在「写漏一个单元格」的可能。
   */
  async function renderSchedule() {
    const rows = (await Api.reconSchedule(ledger.id)).data ?? [];
    const order = { never: 0, overdue: 1, due: 2, upcoming: 3, off: 4 };
    const sorted = [...rows].sort((a, b) => (order[a.dueState] ?? 9) - (order[b.dueState] ?? 9));
    const pending = sorted.filter((r) => r.dueState === 'never' || r.dueState === 'overdue' || r.dueState === 'due');

    schedSlot.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">对账排期</h2>
          <span class="tt-fine-print">${pending.length ? `${esc(String(pending.length))} 个账户待办` : '都在节奏上'}</span>
        </div>
        <div class="card card--flush">
          ${
            sorted.length
              ? `<div class="recon-sched">
                  <div class="recon-sched__head">
                    <span>账户</span>
                    <span>状态</span>
                    <span>上次对账</span>
                    <span>下次到期</span>
                    <span>操作</span>
                  </div>
                  ${sorted
                    .map((r) => {
                      const b = DUE_LABEL[r.dueState] ?? { text: r.dueState, cls: '' };
                      return `
                  <div class="recon-sched__row">
                    <span class="recon-sched__acct">${esc(r.accountName)}</span>
                    <span class="recon-sched__state"
                      ><span class="badge ${b.cls}">${esc(b.text)}</span></span
                    >
                    <span class="recon-sched__num recon-sched__last"
                      >${r.daysSinceLast === null ? '—' : `${esc(String(r.daysSinceLast))} 天前`}</span
                    >
                    <span class="recon-sched__num recon-sched__next">${r.nextDue ? esc(r.nextDue) : '—'}</span>
                    <span class="recon-sched__act"
                      ><button class="btn btn--quiet btn--sm" type="button" data-cycle="${esc(r.accountId)}">设置周期</button></span
                    >
                  </div>`;
                    })
                    .join('')}
                </div>`
              : '<p class="recon-sched__empty tt-caption text-muted">还没有账户</p>'
          }
        </div>
      </section>`;

    schedSlot.querySelectorAll('[data-cycle]').forEach((btn) =>
      btn.addEventListener('click', () => setCycle(btn, btn.dataset.cycle)),
    );
  }

  async function setCycle(btn, accountId) {
    const cur = (btn.dataset.state ?? '');
    btn.disabled = true;
    try {
      /**
       * 三态轮换：不提醒 → 每周 → 每月 → 不提醒。
       * 用轮换而不是弹表单，是因为「多久对一次」这个决定
       * **不值得**一个表单 —— 账户性质决定了答案（现金周、卡月）。
       */
      const next = cur === 'weekly' ? 'monthly' : cur === 'monthly' ? null : 'weekly';
      await Api.setReconSchedule(ledger.id, accountId, {
        cycle: next,
        anchorDay: next === 'monthly' ? 1 : next === 'weekly' ? 1 : null,
        remindDays: 3,
      });
      await renderSchedule();
    } catch (err) {
      btn.disabled = false;
      toast(err?.message ?? '设置失败', 'error');
    }
  }

  /* ================================================================== *
   * R-11 匹配率 / R-12 重复扣费 / R-13 缺凭证 / R-14 自动同步
   * ================================================================== */

  /**
   * 四张指标卡统一成同一副骨架：**标题 + 状态徽标 / 数值 / 状态说明 / 辅助文案**。
   *
   * 以前这四块是直接堆裸 `<p>` 的 —— 有的有标题却没有数值、有的有数值却没有
   * 说明，卡片高度跟着内容伸缩，四张摆在一起并不像「一组」。
   *
   * 结构上的统一带来两个副作用，都是想要的：
   *   · **等高**：外层 `auto-fit` 网格 + `stretch`，辅助文案 `margin-top:auto`
   *     顶到卡底 —— 于是每行的 baseline 也对齐，而不只是边框对齐；
   *   · **状态可见**：每张卡右上必有一枚徽标，用户不用读完正文才知道有没有问题。
   *
   * ⚠️ 三态只用既有徽标变体（不新增第四档）：正常 → `.badge`、
   * 待处理 → `.badge--accent`、异常 → `.badge--danger`（这是最近补齐的一档，
   * 此前「从未对账 / 已逾期 / 已超支」都写着它而 CSS 里没有 —— 渲染成了灰色）。
   * 判定全部来自后端已经算好的字段，前端不重算阈值（否则两处结论会不一致）。
   */
  const PERIOD_LABEL = { monthly: '每月', weekly: '每周', quarterly: '每季', yearly: '每年' };

  async function renderTools() {
    const [rate, dup, missing, sync] = await Promise.all([
      Api.reconMatchRate(ledger.id).then((r) => r.data).catch(() => null),
      Api.duplicateCharges(ledger.id).then((r) => r.data).catch(() => null),
      Api.missingReceipts(ledger.id, '200').then((r) => r.data).catch(() => null),
      Api.bankSyncStatus(ledger.id).then((r) => r.data).catch(() => null),
    ]);

    /**
     * 匹配率低于 90% 时**才**提示漏记风险，且样本不足 20 笔时不提示 ——
     * 3 笔里匹配 2 笔说不上「漏记」。阈值与样本量都由后端判定（riskHint），
     * 前端只负责呈现，不重算 —— 否则两个页面的结论会不一致。
     */
    const rateTotal = Number(rate?.total ?? 0);
    const rateState =
      rateTotal === 0
        ? { text: '待开始', cls: 'badge--accent' }
        : rate?.riskHint
          ? { text: '异常', cls: 'badge--danger' }
          : { text: '正常', cls: '' };

    const dupTotal = Number(dup?.total ?? 0);
    const dupItems = dup?.items ?? [];
    const dupStale = Number(dup?.possiblyStale?.length ?? 0);
    const dupState =
      dupStale > 0
        ? { text: `${dupStale} 项待核`, cls: 'badge--accent' }
        : dupTotal > 0
          ? { text: '正常', cls: '' }
          : { text: '无订阅', cls: '' };

    const missCount = Number(missing?.count ?? 0);
    const missState = missCount > 0 ? { text: '待补', cls: 'badge--accent' } : { text: '正常', cls: '' };

    /** 银行同步是**恒定的能力边界**而不是待办事项 —— 用中性徽标，不用告警色 */
    const syncSupported = sync?.supported === true;
    const syncState = { text: syncSupported ? '已接入' : '暂不支持', cls: '' };

    toolsSlot.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">记账工具</h2>
          <span class="tt-fine-print">完整度 / 重复 / 凭证 / 同步</span>
        </div>
        <div class="metric-grid">
          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">记账完整度</h3>
              <span class="badge ${rateState.cls}">${esc(rateState.text)}</span>
            </div>
            ${
              /**
               * ⚠️ 一条流水都没导入时**不能显示「100%」**。
               * 后端的 `matchRate` 在 total=0 时返回 100（除零的兜底值），
               * 直接显示会让人以为「完整度满分」—— 而真实情况是「还没开始对」。
               * 分母为 0 时给「—」，这是全站对无意义比率的统一处理。
               */
              rateTotal > 0
                ? `<p class="metric__value tnum">${esc(String(rate.matchRate))}%</p>
                   <p class="metric__state">已匹配 <span class="tnum">${esc(String(rate.matched))}</span> / <span class="tnum">${esc(String(rateTotal))}</span> 笔</p>`
                : `<p class="metric__value">—</p>
                   <p class="metric__state">还没有导入过流水</p>`
            }
            ${
              rate?.riskHint
                ? `<p class="metric__hint is-neg">${esc(rate.riskHint)}</p>`
                : `<p class="metric__hint">阈值 ${esc(String(rate?.threshold ?? 90))}%，样本满 20 笔才提示风险</p>`
            }
          </article>

          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">重复扣费</h3>
              <span class="badge ${dupState.cls}">${esc(dupState.text)}</span>
            </div>
            <p class="metric__value tnum">${esc(String(dupTotal))} 项</p>
            <p class="metric__state">${dupTotal ? '已确认为订阅的周期性支出' : '还没有确认过的订阅'}</p>
            ${
              dupItems.length
                ? `<div class="metric__list">
                     ${dupItems
                       .slice(0, 3)
                       .map(
                         (d) => `<div class="metric__item">
                           <span class="metric__item-label">${esc(d.userLabel || d.merchant)} · ${esc(
                             PERIOD_LABEL[d.periodType] ?? d.periodType,
                           )}</span>
                           <span class="metric__item-value tnum">${esc(money(d.amount))}</span>
                         </div>`,
                       )
                       .join('')}
                   </div>
                   <p class="metric__hint">${dupItems.length > 3 ? `共 ${dupItems.length} 项，显示金额最高的 3 项` : '按年支出从高到低'}</p>`
                : `<p class="metric__hint">在统计页确认订阅后会出现在这里</p>`
            }
            ${
              dupStale
                ? `<p class="metric__hint">${esc(String(dupStale))} 项已超过 45 天没再出现，可能已经停了</p>`
                : ''
            }
          </article>

          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">缺凭证</h3>
              <span class="badge ${missState.cls}">${esc(missState.text)}</span>
            </div>
            <p class="metric__value tnum">${esc(String(missCount))} 笔</p>
            <p class="metric__state">${esc(missing?.threshold ?? '¥200.00')} 以上的大额支出</p>
            <p class="metric__hint">${missCount ? '建议逐笔补一张回单或截图' : '大额支出都已经有凭证了'}</p>
          </article>

          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">银行自动同步</h3>
              <span class="badge ${syncState.cls}">${esc(syncState.text)}</span>
            </div>
            <p class="metric__value">${syncSupported ? '已接入' : '—'}</p>
            <p class="metric__state">${esc(sync?.reason ?? '—')}</p>
            ${
              sync?.alternative
                ? `<p class="metric__hint">替代路径：${esc(sync.alternative)}</p>`
                : '<p class="metric__hint">用流水导入配合自动匹配完成对账</p>'
            }
          </article>
        </div>
      </section>`;
  }

  /* ---------------- 接线 ---------------- */

  frame.querySelector('[data-role=to-accounts]').addEventListener('click', () => go('/accounts'));
  accSelect.addEventListener('change', () => {
    accountFilter = accSelect.value;
    load();
  });
  rangeSelect.addEventListener('change', () => {
    range = rangeSelect.value;
    load();
  });

  paintHealth();
  renderSchedule().catch(() => {});
  renderTools().catch(() => {});
  await load();
  return frame;
}
