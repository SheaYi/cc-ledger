/**
 * 概览 —— 打开账本先看到「钱」：净资产、本月收支、账户快览、对账状态。
 * 这一页不含任何账号/设置类内容（那些在「我的」）。
 *
 * ## 两版 DOM，按形态分派，不是一版自适应
 *
 * 桌面走本页面（多栏、信息平铺）；紧凑形态（≤1023px）走 `mobile-home.js`
 * （方向 A · 钱包优先）。判据是信息优先级不同：手机上「我这个月还剩多少」
 * 必须排在第一屏，而桌面有横向空间把五类信息平铺成同级。
 * 强行共用一套 DOM，必然变成「桌面版塌成一列」，两头都让步。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import {
  ACCOUNT_KIND_LABEL,
  ACCOUNT_TYPE_LABEL,
  countUp,
  accountIcon,
  entityIcon,
  esc,
  formatDate,
  h,
  icon,
  isCompact,
  money,
  monthLabel,
  toast,
} from '../ui.js';

/**
 * 有符号数字的语义色：正 = 绿（收入/盈余），负 = 红（支出/亏损），0 = 中性。
 *
 * ⚠️ 只喂「有确定好坏含义的有符号数字」。支出这种**金额量**（后端 `periodFlow()`
 * 返回的 `expense` 是正数，`accountDelta` 才是负数）必须先取反再喂进来，
 * 否则会被染成绿色 —— "本月支出 ¥2,792" 一片绿，等于说「花得多是好事」。
 */
function toneClass(v) {
  const n = Number(v);
  return n > 0 ? 'is-pos' : n < 0 ? 'is-neg' : '';
}

/**
 * 账户行：**整行可点，跳到该账户的账单列表**。
 *
 * ## 为什么是「账单列表」而不是「账户详情」
 *
 * 用户点一个账户卡片时，脑子里的问题只有一个：「**这张卡上有哪些账？**」。
 * 账户页回答的是「它的余额 / 待对账 / 属性」，那是**管理员**视角；
 * 账单列表才是**这张卡发生过什么**。
 *
 * ## 为什么用 query 而不是路径段
 *
 * 账单页的筛选是 query 驱动的（`transactions.js` 从 `?accountId=` 读初值），
 * 跳转带 query 才能让「筛选面板」显示当前条件 —— 否则用户看到一整个月全部账单，
 * 却不知道已经被筛过了。**筛了但看不出来 = 没筛。**
 *
 * 同时带 `recordType=` 不给：账户行已经回答了「哪个账户」，
 * 一次只给一个筛选维度，多给会让筛选行变成一行看不懂的组合条件。
 *
 * ## 无障碍
 *
 * 整行是 `<a>` 而不是 `<div role=button>` + click 处理器：
 * 中键/右键新标签打开、读屏念出链接、Tab 键可达，全都不用额外代码。
 */
function accountLine(a) {
  const href = `/transactions?accountId=${encodeURIComponent(a.id)}`;
  return `
    <a class="acct-row acct-row--link" href="${href}" data-link title="查看 ${esc(a.name)} 的账单">
      <span class="acct-row__icon">${accountIcon(a, 16)}</span>
      <span class="acct-row__main">
        <span class="tt-body-strong acct-row__name">${esc(a.name)}</span>
        <span class="tt-fine-print">${esc(ACCOUNT_TYPE_LABEL[a.type] ?? a.type)}${
          a.lastReconciledAt ? ` · 上次对账 ${esc(formatDate(a.lastReconciledAt))}` : ' · 未对账'
        }</span>
      </span>
      <span class="acct-row__amount ${toneClass(a.balance)} tnum">${money(a.balance)}</span>
      <span class="acct-row__go" aria-hidden="true">${icon('chevron', 14)}</span>
    </a>
  `;
}

export async function renderOverview(container, { go }) {
  /* 手机/平板钱包版首页（方向 A · 钱包优先）。见本文件顶部的分派说明。 */
  if (isCompact()) {
    const { renderMobileHome } = await import('./mobile-home.js');
    return renderMobileHome(container, { go });
  }

  const shell = appFrame({
    active: 'overview',
    inner: `
      <div class="card"><div class="skeleton" style="width:40%"></div>
      <div class="skeleton" style="width:64%;height:32px;margin-top:16px"></div></div>
    `,
  });
  container.replaceChildren(shell);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return shell;
  }

  /**
   * 账户要连**已归档**的一起取回来，但不是为了展示它们 ——
   * 是为了区分两种「一个分组也渲染不出来」：
   *   · 真的一个账户都没有      → 引导去建账户；
   *   · 账户都在，只是全被归档了 → 引导去账户页取消归档。
   * 只按「未归档」取数据的话，第二种会被误报成第一种，
   * 用户明明有 8 个账户，首页却说「还没有账户」。
   */
  const [summary, groups, accounts] = await Promise.all([
    Api.accountSummary(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id, { includeArchived: true }).then((r) => r.data),
  ]);

  const allReal = accounts.filter((a) => a.kind !== 'virtual');
  const realAccounts = allReal.filter((a) => !a.archivedAt);
  const archivedCount = allReal.length - realAccounts.length;
  const virtualAccounts = accounts.filter((a) => a.kind === 'virtual');
  const flow = summary.period;

  /**
   * 空分组整体不渲染：连标题、卡片容器、合计金额一起不出。
   *
   * 「该分组下暂无账户」这种占位块在首页是纯噪音 —— 它占掉一屏里最贵的
   * 位置，回答的却是一个用户没问的问题（他关心的是钱在哪儿，不是哪个分类空着）。
   * 管理空分组要去账户页，那是管理视角的活儿，不该出现在首页。
   */
  const groupBlocks = groups
    .map((g) => {
      const list = realAccounts.filter((a) => a.groupId === g.id);
      if (list.length === 0) return '';
      return `
        <div class="acct-group">
          <div class="acct-group__head">
            <span class="acct-group__name">${entityIcon(g.icon, 14)} ${esc(g.name)}</span>
            <span class="tt-fine-print tnum">${money(g.totalBalance)}</span>
          </div>
          <div class="card card--flush">${list.map(accountLine).join('')}</div>
        </div>
      `;
    })
    .join('');

  /**
   * 空状态按「为什么空」分两种措辞。
   * 一个账户都没有和「账户都在，只是归档了」的下一步动作完全不同，
   * 混成一句「还没有账户」会把人带向「再建一个」，而他要的是「找回原来那个」。
   */
  const accountsEmptyState = groupBlocks
    ? ''
    : archivedCount > 0
      ? `<div class="card empty-state">
           <span class="empty-state__icon">${'📦'}</span>
           <p class="tt-body-strong">账户都已归档</p>
           <p class="tt-caption text-muted">
             ${archivedCount} 个账户当前处于归档状态，归档的账户不参与首页快览。
             到账户页勾选「显示已停用」，可取消归档让它们回到日常列表。
           </p>
           <a class="btn btn--sm" href="/accounts" data-link>去账户页</a>
         </div>`
      : `<div class="card empty-state">
           <span class="empty-state__icon">${'💰'}</span>
           <p class="tt-body-strong">还没有账户</p>
           <p class="tt-caption text-muted">先建一张银行卡或现金账户，才能开始记账</p>
           <a class="btn btn--sm" href="/accounts" data-link>去添加账户</a>
         </div>`;

  const ledgerSwitcher =
    me.ledgers.length > 1
      ? `<div class="chip-row chip-row--inline" data-role="ledger-switch">
           ${me.ledgers
             .map(
               (l) => `
             <button class="chip" type="button" role="radio"
                     aria-checked="${l.id === ledger.id}" data-value="${esc(l.id)}">
               ${esc(l.name)}<span class="chip__sub">${l.memberCount} 人</span>
             </button>`,
             )
             .join('')}
         </div>`
      : '';

  const frame = appFrame({
    active: 'overview',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <h1 class="tt-display-md">概览</h1>
        <p class="tt-caption text-muted">
          ${esc(ledger.name)} · ${esc(monthLabel(flow.dateFrom.slice(0, 7)))} · 共 ${flow.txCount} 笔变动
        </p>
      </div>

      ${ledgerSwitcher}

      <section class="networth">
        <div class="networth__label">净资产</div>
        <div class="networth__value tnum" data-role="networth-value">${money(summary.netWorth)}</div>
        <div class="networth__split">
          <span>资产合计 <b class="tnum">${money(summary.assetTotal)}</b></span>
          <span>负债合计 <b class="tnum">${money(summary.liabilityTotal)}</b></span>
        </div>
      </section>

      <!-- 三格取色：支出是流出（红）、收入是流入（绿）、结余是有符号数（正绿负红）。
           支出显示成「量」不带负号：标签已经写明「本月支出」，
           再写 −¥ 会被读成「支出为负」，那是在描述退款而不是花钱。 -->
      <section class="flow-grid">
        <div class="flow-cell">
          <span class="flow-cell__label">本月支出</span>
          <span class="flow-cell__value tnum ${toneClass(-Math.abs(flow.expense))}">${money(flow.expense)}</span>
        </div>
        <div class="flow-cell">
          <span class="flow-cell__label">本月收入</span>
          <span class="flow-cell__value tnum ${toneClass(flow.income)}">${money(flow.income)}</span>
        </div>
        <div class="flow-cell">
          <span class="flow-cell__label">本月结余</span>
          <span class="flow-cell__value tnum ${toneClass(flow.net)}">${money(flow.net)}</span>
        </div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-display-md">账户</h2>
          <a class="btn btn--pearl btn--sm" href="/accounts" data-link>管理账户</a>
        </div>
        ${groupBlocks || accountsEmptyState}
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-display-md">对账状态</h2>
          <div class="row row--md row--wrap">
            <a class="btn btn--pearl btn--sm" href="/reconciliations" data-link>对账历史</a>
            <a class="btn btn--pearl btn--sm" href="/accounts" data-link>去对账</a>
          </div>
        </div>
        <div class="card stack stack--sm">
          <div class="recon-line">
            <span class="tt-caption text-muted">已对账账户</span>
            <span class="tt-body-strong tnum">${summary.reconciledCount} / ${summary.accountCount}</span>
          </div>
          <div class="recon-line">
            <span class="tt-caption text-muted">当前有差额的账户</span>
            <span class="tt-body-strong tnum ${
              summary.accountsWithDiff > 0 ? 'is-neg' : ''
            }">${summary.accountsWithDiff}</span>
          </div>
          <p class="tt-fine-print">
            余额不可直接编辑；发现差异时通过对账生成调整单，账面与现实的每次修正都会留下记录。
          </p>
        </div>
      </section>

      ${
        virtualAccounts.length
          ? `<section class="section">
               <div class="section__head">
                 <h2 class="tt-display-md">债权与债务</h2>
                 <p class="tt-fine-print text-muted">系统台账，随往来自动变动</p>
               </div>
               <div class="card card--flush">
                 ${virtualAccounts
                   .map(
                     (a) => `
                   <div class="acct-row acct-row--static">
                     <span class="acct-row__icon">${accountIcon(a, 16)}</span>
                     <span class="acct-row__main">
                       <span class="tt-body-strong acct-row__name">${esc(a.name)}</span>
                       <span class="tt-fine-print">${esc(
                         ACCOUNT_KIND_LABEL[a.kind] ?? a.kind,
                       )}账户 · 系统自动维护</span>
                     </span>
                     <span class="acct-row__amount ${toneClass(a.balance)} tnum">${money(
                       a.balance,
                     )}</span>
                   </div>`,
                   )
                   .join('')}
               </div>
             </section>`
          : ''
      }
    `,
  });

  mountTabBar(frame, { active: 'overview', go });
  container.replaceChildren(frame);

  /* 英雄数字滚动一次（prefers-reduced-motion 时 countUp 内部直接落终值） */
  countUp(frame.querySelector('[data-role=networth-value]'), summary.netWorth);

  /* 切换当前账本 */
  frame.querySelectorAll('[data-role=ledger-switch] .chip').forEach((chip) =>
    chip.addEventListener('click', async () => {
      if (chip.getAttribute('aria-checked') === 'true') return;
      try {
        await Api.setCurrentLedger(chip.dataset.value);
        const { invalidateSession } = await import('../session.js');
        invalidateSession();
        toast('已切换当前账本', 'success');
        go('/');
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );

  return frame;
}
