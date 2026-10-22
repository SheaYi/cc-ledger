/**
 * 页面骨架（chrome）——记账工作台。
 *
 * 桌面（≥1024px）：左侧固定导航栏（sidebar）+ 右侧内容栏
 *   ┌──────────┬───────────────────────────┐
 *   │ 品牌      │  页面标题 / 内容 / 页脚      │
 *   │ 记一笔 CTA│                           │
 *   │ 当前账本  │                           │
 *   │ 主导航    │                           │
 *   │ 用户行    │                           │
 *   └──────────┴───────────────────────────┘
 * 移动（≤1023px）：左侧栏隐藏，改由顶部细条 + 底部 TabBar 导航。
 *
 * 导航刻意只放「已经能用」的模块，不做点不动的死链。
 *
 * 「记」的形态（docs/13 §3）：它是一个**动作**，不是导航目的地，
 * 因此两端都不占导航位、也不参与选中态 —— 桌面走侧栏 pill CTA（rounded.pill = 一切动作），
 * 移动走 TabBar 正中央的抬升动作位（docs/13 §3.2）。
 */
import { avatarHtml, esc, h, icon, LEDGER_TYPE_LABEL, toast } from './ui.js';
import { currentLedger, rememberComposeSource } from './session.js';
import { openTemplatePanel } from './lib/template-panel.js';

/** 记账页规范路径（docs/13 §3.4：`/tx/new` 只是兼容别名） */
export const COMPOSE_HREF = '/transactions/new';

/** 长按「记」带出模板面板的手势参数（docs/13 §3.2 / 09 §3.2） */
const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 8;

/**
 * 侧栏图标（`ui.js` 的 `icon()`，**不是** `lucide()`）。
 *
 * ⚠️ 两套图标库不能混用：`lucide()` 没有 `chevron-down`，缺名会静默渲染成问号
 *    并挂上 `data-missing-icon`（界面上看不出来，但截图里就是一个「？」）。
 *    侧栏统一走 `icon()`，新增导航项时**必须**在这里先有名字。
 */
const NAV_ICONS = {
  overview: 'home',
  transactions: 'book',
  accounts: 'wallet',
  debts: 'handshake',
  categories: 'list',
  tags: 'tag',
  templates: 'copy',
  recurring: 'calendar',
  installments: 'credit-card',
  stats: 'chart',
  budgets: 'target',
  import: 'download',
  reconciliations: 'scale',
  settings: 'user',
  invite: 'users',
};

/** 导航项的文案与路径。单独一张表是为了让「平铺」与「分组」共用同一份真值。 */
const NAV_ITEM_META = {
  overview: { label: '概览', href: '/' },
  transactions: { label: '账单', href: '/transactions' },
  accounts: { label: '账户', href: '/accounts' },
  debts: { label: '往来', href: '/debts' },
  categories: { label: '分类', href: '/categories' },
  tags: { label: '标签', href: '/tags' },
  templates: { label: '模板', href: '/templates' },
  recurring: { label: '周期账单', href: '/recurring' },
  installments: { label: '分期账单', href: '/installments' },
  stats: { label: '统计', href: '/stats' },
  budgets: { label: '预算', href: '/budgets' },
  import: { label: '导入', href: '/import' },
  /**
   * 「对账历史」**只在桌面侧栏出现** —— 它是「账户」的子页，不是并列的信息架构层。
   *
   * 但它确实需要一个入口：用户要么刚对完账想回查，要么发现余额不对要查历史。
   * 放进「数据」组（而不是「总览」）是因为它的动作是**核对既有记录**，
   * 与导入同属「对已经存在的账做点什么」，而账户页只放「当前待对账的账户」。
   */
  reconciliations: { label: '对账历史', href: '/reconciliations' },
  settings: { label: '设置', href: '/settings' },
  invite: { label: '成员', href: '/settings' },
};

/**
 * 主导航 = **四个语义分组**，而不是一条 13 项的平铺列表。
 *
 * ## 为什么分组
 *
 * 平铺 13 项的问题不是「长」，是**用户无法预测**：「我记的账在哪看、我欠的钱在哪看、
 * 我设的预算在哪看」都要在一条等权重的列表里线性搜索。
 * 分组把这三个问题直接映射成四段，且**每段用同一套措辞**：
 *
 *   · 总览 —— 打开就想知道的：现在有多少钱、这个月花了多少、谁欠谁
 *   · 记账 —— 往里写东西的：账单明细与它的效率件（分类/标签/模板）
 *   · 规划 —— 往**未来**安排的：周期与分期（不是记录，是调度）、预算（是约束不是钱）
 *   · 数据 —— 对已经存在的账做点什么：统计 / 对账 / 导入
 *
 * 「规划」独立成组是刻意的：周期账单与分期账单在功能上都是**未来时**，
 * 混在「记账」里会被误解成「已经记过的账」，而它们的操作语义（建规则、看排期）
 * 与「记一笔」完全不同。
 *
 * ## 顺序即优先级
 *
 * 顶部永远放用户 90% 时间在做的事（总览、账单、往来），
 * 低频的（导入）沉到底部 —— 与 `docs/13 §3.3` 定的「概览 → 账单 → 账户 → 分类」一致。
 */
const NAV_GROUPS = [
  { id: 'overview', label: '总览', items: ['overview', 'transactions', 'accounts', 'debts'] },
  { id: 'record', label: '记账', items: ['categories', 'tags', 'templates'] },
  { id: 'plan', label: '规划', items: ['recurring', 'installments', 'budgets'] },
  { id: 'data', label: '数据', items: ['stats', 'reconciliations', 'import'] },
];

/**
 * 平铺导出（顺序 = 各分组按序展开）——给 `PATHS`、`FALLBACK` 归槽与审计脚本用。
 * 侧栏渲染走下面的 `navGroups()`，两者同源于 `NAV_ITEM_META`，不会漂移。
 */
export const PRIMARY_NAV = NAV_GROUPS.flatMap((g) =>
  g.items.map((key) => ({ key, icon: NAV_ICONS[key], ...NAV_ITEM_META[key] })),
);

/** 分组视图（侧栏渲染用）。空组直接不输出标题，否则会出现只有标题没有项的空段。 */
export function navGroups() {
  return NAV_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: g.items.map((key) => ({
      key,
      icon: NAV_ICONS[key],
      ...NAV_ITEM_META[key],
    })),
  })).filter((g) => g.items.length > 0);
}

/**
 * 桌面侧栏的「记一笔」主 CTA —— pill 形态、占满侧栏宽度（docs/13 §3.3 表格第 1 行）。
 *
 * 它是 `<button>` 而不是 `<a data-link>`：现在带长按手势（长按出模板面板），
 * 语义上是**动作**而非导航目的地，点击跳转由 `wireComposeAction` 统一处理。
 * 再挂 data-link 会让全局内链拦截器与手势处理器各跳一次。
 */
function composeCta({ block = false } = {}) {
  return h(`
    <div class="sidebar__cta">
      <button class="btn compose-cta${block ? ' btn--block' : ''}" type="button" data-compose>
        ${icon('plus', 18)}<span>记一笔</span>
      </button>
      <span class="sidebar__cta-hint">长按可直接选模板</span>
    </div>
  `);
}

/**
 * 分组导航渲染。
 *
 * ## 三条视觉纪律（00-DESIGN › Components › Navigation）
 *
 * ① **选中态只由 `aria-current="page"` 一个来源表达**，不额外加 `is-active` 类。
 *    两处各写一遍就会出现「点了 A，A 和 B 都亮着」—— 状态机的真相必须在属性上，
 *    CSS 才能保证选中态与 hover/focus 的优先级永远正确。
 *
 * ② **组标题不是可点击元素**，用 `<p>` 而不是 `<div>`/`role=button`：
 *    它只是排版分组，读屏软件会念出来但不会把它当可聚焦目标。
 *
 * ③ **组标题不参与交互**所以不给 `cursor: pointer`，也不给它 hover 态 ——
 *    给了就是在暗示「能点」，那是骗人。
 *
 * 层级缩进：组标题缩进 12px 与项对齐（**不额外缩进**），
 * 因为层级已经由「标题 → 空行 → 项」表达清楚了；再缩一层会让窄侧栏里
 * 长标签（如「分期账单」）被迫换行。
 */
function navGroupsHtml(active) {
  const groups = navGroups();
  return groups
    .map((g, gi) => {
      const items = g.items
        .map(
          (n) => `
      <a class="sidenav__item" href="${esc(n.href)}" data-link${
        n.key === active ? ' aria-current="page"' : ''
      }>
        ${icon(n.icon, 18)}
        <span class="sidenav__label">${esc(n.label)}</span>
      </a>`,
        )
        .join('');
      // 首组不加顶部间距（它紧贴 CTA，下面每组之间才有分隔）
      const gap = gi === 0 ? '' : ' sidenav__group-head--gap';
      return `
      <div class="sidenav__group">
        <p class="sidenav__group-head${gap}">${esc(g.label)}</p>
        <div class="sidenav__items">${items}</div>
      </div>`;
    })
    .join('');
}

/**
 * 「我的」单独成组（成员管理只在协作账本里有意义，故按条件渲染）。
 *
 * 为什么它不在 `NAV_GROUPS` 里：它是**跨账本**的（改密码、退出登录与账本无关），
 * 混进任何一个业务组都会让「换一本账本后侧栏结构变了」——
 * 侧栏的分组结构应当只由账本内的功能决定。
 */
function accountGroupHtml(active) {
  const items = [
    { key: 'invite', label: '成员', href: NAV_ITEM_META.invite.href, icon: NAV_ICONS.invite },
    { key: 'settings', label: '设置', href: NAV_ITEM_META.settings.href, icon: NAV_ICONS.settings },
  ];
  return `
      <div class="sidenav__group">
        <p class="sidenav__group-head sidenav__group-head--gap">账号</p>
        <div class="sidenav__items">
          ${items
            .map(
              (n) => `
        <a class="sidenav__item" href="${esc(n.href)}" data-link${
          n.key === active ? ' aria-current="page"' : ''
        }>
          ${icon(n.icon, 18)}
          <span class="sidenav__label">${esc(n.label)}</span>
        </a>`,
            )
            .join('')}
        </div>
      </div>`;
}

/** @deprecated 平铺渲染。保留给「不分组的紧凑列表」场景（如登录页外框） */
function navItems(active) {
  return PRIMARY_NAV.map(
    (n) => `
      <a class="sidenav__item" href="${esc(n.href)}" data-link${
        n.key === active ? ' aria-current="page"' : ''
      }>
        ${icon(n.icon, 18)}
        <span class="sidenav__label">${esc(n.label)}</span>
      </a>`,
  ).join('');
}

/**
 * 桌面左侧导航栏。
 * user 未就绪（骨架屏阶段）时底部留空，不闪一个「登录」按钮出来。
 * @param {{active?: string, user?: object|null, ledger?: object|null, hideCompose?: boolean}} cfg
 */
export function sidebar({ active = '', user, ledger = null, hideCompose = false } = {}) {
  const ledgerBlock = ledger
    ? `
      <a class="sidebar__ledger" href="/settings" data-link title="查看账本与成员">
        <span class="sidebar__ledger-label">当前账本</span>
        <span class="sidebar__ledger-name">${esc(ledger.name)}</span>
        <span class="sidebar__ledger-meta">
          ${ledger.type ? `${esc(LEDGER_TYPE_LABEL[ledger.type] ?? '')} · ` : ''}${ledger.memberCount ?? 1} 人协作
        </span>
        <span class="sidebar__ledger-arrow">${icon('chevron', 16)}</span>
      </a>`
    : '';

  const foot = user
    ? `
      <a class="user-chip user-chip--full" href="/settings" data-link title="账号与设置">
        ${avatarHtml(user, 'avatar--sm')}
        <span class="user-chip__main">
          <span class="user-chip__name">${esc(user.nickname || user.username)}</span>
          <span class="user-chip__sub">@${esc(user.username)}</span>
        </span>
        ${icon('chevron', 16)}
      </a>`
    : user === null
      ? `<a class="btn btn--secondary btn--sm btn--block" href="/login" data-link>登录</a>`
      : ''; // user === undefined：会话还没回来，先留空

  const shell = h(`
    <aside class="sidebar">
      <div class="sidebar__head">
        <a class="brand" href="/" data-link>
          <span class="brand__tile">CC</span>
          <span class="brand__name">CC记账</span>
        </a>
      </div>

      <div class="sidebar__cta" data-role="cta-slot"></div>

      ${ledgerBlock}

      <nav class="sidenav" aria-label="主导航">
        ${navGroupsHtml(active)}
        ${accountGroupHtml(active)}
      </nav>

      <div class="sidebar__foot">${foot}</div>
    </aside>
  `);

  // 记账页自身不出现「记一笔」（已经在记了）
  if (!hideCompose) shell.querySelector('[data-role=cta-slot]').replaceWith(composeCta({ block: true }));
  return shell;
}

/**
 * 顶部细条（仅移动端显示）。
 * 桌面端品牌 / 导航 / 用户都在左侧栏里，这条不出现。
 * 右上角的 44×44 圆形图标按钮是移动端的第二个记账入口（docs/13 §3.3）。
 */
export function topBar({ user = null, hideCompose = false } = {}) {
  const chip = user
    ? `<a class="user-chip" href="/settings" data-link title="账号与设置">
         ${avatarHtml(user, 'avatar--sm')}
         <span class="user-chip__name">${esc(user.nickname || user.username)}</span>
       </a>`
    : `<a class="btn btn--quiet btn--sm" href="/login" data-link>登录</a>`;

  const compose = hideCompose
    ? ''
    : `<button class="btn btn--icon btn--pearl" type="button" data-compose
          title="记一笔（长按选模板）" aria-label="记一笔">${icon('plus', 20)}</button>`;

  return h(`
    <header class="app-bar">
      <div class="app-bar__inner">
        <a class="brand" href="/" data-link>
          <span class="brand__tile">CC</span>
          <span class="brand__name">CC记账</span>
        </a>
        <div class="app-bar__right">
          ${compose}
          ${chip}
        </div>
      </div>
    </header>
  `);
}

/** 一行版权页脚 */
export function siteFooter() {
  return h(`
    <footer class="footer-min">
      Copyright © 2026 CC记账 · 自托管版本 · 数据只存放在你自己的服务器
    </footer>
  `);
}

/**
 * 页面外框：左侧导航 + （移动端）顶栏 + 内容 + 页脚 + （移动端）底部导航。
 * 各记账页只需提供 inner HTML，避免每页重复拼骨架。
 * @param {{active?:string, user?:object|null, ledger?:object|null, inner?:string, hideCompose?:boolean}} cfg
 */
/**
 * 全站导航函数，由 `app.js` 在启动时注入（`setChromeNav(go)`）。
 *
 * 为什么不让每个页面把 `go` 一层层传给 `appFrame`：那是 22 处调用，
 * 漏一处就会让侧栏「记一笔」退化成整页刷新、并且**长按模板面板直接不打开**
 * （`openTemplatePanel` 没有 `go` 就 return，失败得毫无现象）。注入一次，
 * 新页面也自动对。
 */
let chromeNav = null;
export function setChromeNav(fn) {
  chromeNav = typeof fn === 'function' ? fn : null;
}
const navOf = (go) => go ?? chromeNav;

export function appFrame({ active = '', user, ledger = null, inner = '', hideCompose = false, go = null } = {}) {
  const root = h(`
    <div class="shell">
      <div data-role="sidebar-slot"></div>
      <div class="shell__main">
        <div data-role="nav-slot"></div>
        <main class="page">${inner}</main>
        <div data-role="footer-slot"></div>
      </div>
      <div data-role="tabbar-slot"></div>
    </div>
  `);
  root
    .querySelector('[data-role=sidebar-slot]')
    .replaceWith(sidebar({ active, user, ledger, hideCompose }));
  root.querySelector('[data-role=nav-slot]').replaceWith(topBar({ user, hideCompose }));
  root.querySelector('[data-role=footer-slot]').replaceWith(siteFooter());
  /**
   * 桌面两处「记一笔」（侧栏 CTA、移动端顶栏图标）都接上**同一个**手势处理器：
   * 短按跳空表单、长按出模板面板。`data-compose` 是唯一的识别标记 ——
   * 移动端 TabBar 的动作位也是它（那边自己包了一层 `.mega-host` 做定位上下文）。
   */
  root.querySelectorAll('[data-compose]').forEach((el) => {
    // 侧栏/顶栏的按钮还没有定位上下文，面板要靠它锚定
    if (!el.closest('.mega-host')) el.parentElement?.classList.add('mega-host', 'mega-host--side');
    wireComposeAction(el, {
      go: navOf(go),
      onLongPress: () => openTemplatePanel({ ledger, go: navOf(go), anchor: el }),
    });
  });
  return root;
}

/** 挂载底部导航（需要 go 才能切页；不传则回落到 app.js 注入的全局导航） */
export function mountTabBar(frame, { active, go, ledger = null }) {
  const slot = frame.querySelector('[data-role=tabbar-slot]');
  if (slot) slot.replaceWith(tabBar({ active, go: navOf(go), ledger }));
}

/**
 * 移动端底部导航（≤1023px 显示）—— 5 槽，正中央是**动作位**不是导航位。
 *
 *       账户   账单   ╭──╮  统计   设置
 *                      │记 │  ← pill 形态、抬升、不参与选中态
 *                      ╰──╯
 *
 * 槽位为什么是这五个（2026-10-22 重排，取代旧的「概览/账单/记/分类/我的」）：
 *   · **账户** 是打开就想知道的「我现在有多少钱、钱在哪」—— 记账 App 的首屏，
 *     手机端 `/` 也直接落到它（见 app.js 的移动端首页重定向）。
 *   · **账单** 是流水主界面（`docs/09 §2.2` 定的核心 Tab），记账 App 的第二个屏。
 *   · **记一笔** 是动作不是目的地：占中心、抬升、不参与选中态（docs/13 §3.2）。
 *   · **统计** 是「回头看」—— 收支趋势、分类占比、排行，手机上单独成屏才看得了图。
 *   · **设置** 收账号 / 账本 / 成员 / 安全，也是「我的」那类低频入口的落点。
 *
 * 被移出栏的页面全部在 `FALLBACK` 里有归属，**不变成不可达页面** ——
 * 它们仍从 5 个屏内部的入口进（如账户页的「分类管理」、账单页的「导入」）。
 *
 * 「记」的交互（docs/13 §3.2）：
 *   点击      → /transactions/new
 *   长按 400ms → 带出模板面板
 *   手指移动 > 8px → 取消长按（09 §3.2 的冲突处理）
 */
export function tabBar({ active = 'accounts', go, ledger = null } = {}) {
  const TABS = [
    { key: 'accounts', label: '账户', href: '/accounts', icon: 'wallet' },
    { key: 'transactions', label: '账单', href: '/transactions', icon: 'book' },
    { key: 'compose', label: '记一笔', href: COMPOSE_HREF, icon: 'plus', action: true },
    { key: 'stats', label: '统计', href: '/stats', icon: 'chart' },
    { key: 'settings', label: '设置', href: '/settings', icon: 'user' },
  ];

  /** 不在槽位里的页面 → 高亮它「归属于」的那个槽（避免整条栏没有选中态） */
  //
  // 归槽判据是「**用户是从哪个页面的哪个按钮进来的**」，而不是 URL 前缀 ——
  // 前者回答「我刚才在哪」，后者只是字符串匹配。
  //
  //   · 概览 / 往来 / 对账历史 → 账户（都是「看余额与状态」，账户是它们的落点）
  //   · 分类 / 标签 / 模板 / 周期 / 分期 → 账单（都是录入效率件，入口在记账表单与账单页）
  //   · 预算 → 统计（是约束与对比，不是流水）
  //   · 导入 → 账单（导入的是账单）
  //   · 成员 / 邀请 → 设置
  const FALLBACK = {
    overview: 'accounts',
    debts: 'accounts',
    reconciliations: 'accounts',
    categories: 'transactions',
    tags: 'transactions',
    templates: 'transactions',
    recurring: 'transactions',
    installments: 'transactions',
    import: 'transactions',
    budgets: 'stats',
    invite: 'settings',
  };
  const activeKey = TABS.some((t) => t.key === active) ? active : (FALLBACK[active] ?? active);

  const bar = h(`
    <nav class="tabbar" aria-label="主导航">
      <div class="tabbar__inner">
        ${TABS.map((t) =>
          t.action
            ? `<button class="tabbar__compose" type="button" data-compose aria-label="${esc(t.label)}"
                       title="点击记一笔 · 长按选模板">
                 <span class="tabbar__compose-pill">${icon(t.icon, 24)}</span>
               </button>`
            : `<a class="tabbar__item" href="${esc(t.href)}" data-tab="${t.key}"${
                activeKey === t.key ? ' aria-current="page"' : ''
              }>
                 ${icon(t.icon, 22)}<span>${esc(t.label)}</span>
               </a>`,
        ).join('')}
      </div>
    </nav>
  `);

  bar.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = TABS.find((t) => t.key === el.dataset.tab);
      go?.(tab?.href ?? '/');
    });
  });

  const compose = bar.querySelector('[data-compose]');
  if (compose) {
    /**
     * 模板面板要锚定在按钮**上方**弹出，需要一个定位上下文。
     * TabBar 的动作位是 .tabbar__inner 的直接子元素，没有 relative 容器，
     * 所以这里补一层 .mega-host（position: relative，样式与记账页浮层共用）。
     */
    const wrap = h('<span class="mega-host"></span>');
    compose.replaceWith(wrap);
    wrap.appendChild(compose);
    wireComposeAction(compose, {
      go,
      onLongPress: () =>
        openTemplatePanel({ ledger: ledger ?? currentLedger(), go: navOf(go), anchor: compose }),
    });
  }
  return bar;
}

/**
 * 「记」按钮的手势：短按跳转、长按带模板。
 * 用 pointerdown/up（而非 click 计时）才能在移动端与鼠标上表现一致；
 * 长按触发后吞掉随之而来的 click，避免「选了模板又跳一次空表单」。
 */
function wireComposeAction(el, { go, onLongPress } = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let longPressed = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      if (onLongPress) onLongPress();
      // 没有 onLongPress 就不响应长按（短按照常跳转），别弹一句「后续阶段开放」
      else timer = null;
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (
      Math.abs(e.clientX - startX) > MOVE_CANCEL_PX ||
      Math.abs(e.clientY - startY) > MOVE_CANCEL_PX
    ) {
      cancel();
    }
  });

  ['pointerup', 'pointercancel', 'pointerleave', 'contextmenu'].forEach((evt) =>
    el.addEventListener(evt, cancel),
  );

  el.addEventListener('click', (e) => {
    if (longPressed) {
      longPressed = false;
      e.preventDefault();
      return;
    }
    // 中心动作位不走 `data-link` 的内链拦截，来源页要在这里自己记（docs/13 §7.2）
    rememberComposeSource(window.location.pathname + window.location.search);
    if (go) go(COMPOSE_HREF);
    else window.location.assign(COMPOSE_HREF);
  });
}

/** 骨架通用占位动作 */
export function wireChrome(root) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action=soon]');
    if (!el) return;
    e.preventDefault();
    toast('该模块将在后续阶段开放');
  });
}

/** 空态卡片：统一「还没有内容」的表达 */
export function emptyState({ icon: iconName = 'info', title, body, action = null }) {
  return h(`
    <div class="empty-state">
      <span class="empty-state__icon">${icon(iconName, 22)}</span>
      <p class="tt-body-strong">${esc(title)}</p>
      ${body ? `<p class="tt-caption text-muted">${esc(body)}</p>` : ''}
      ${action ? `<button class="btn btn--sm" type="button" data-action="${esc(action.action)}">${esc(action.label)}</button>` : ''}
    </div>
  `);
}
