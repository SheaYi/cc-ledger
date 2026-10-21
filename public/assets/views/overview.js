/**
 * 概览 —— 打开账本先看到「钱」：净资产、本月收支、账户快览、对账状态。
 * 这一页不含任何账号/设置类内容（那些在「我的」）。
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
  money,
  monthLabel,
  toast,
} from '../ui.js';

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

  const [summary, groups, accounts] = await Promise.all([
    Api.accountSummary(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
  ]);

  const realAccounts = accounts.filter((a) => a.kind !== 'virtual');
  const virtualAccounts = accounts.filter((a) => a.kind === 'virtual');
  const flow = summary.period;
  const noAccounts = realAccounts.length === 0;

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

      <section class="flow-grid">
        <div class="flow-cell">
          <span class="flow-cell__label">本月支出</span>
          <span class="flow-cell__value tnum ${toneClass(flow.expense)}">${money(flow.expense)}</span>
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
        ${
          noAccounts
            ? `<div class="card empty-state">
                 <span class="empty-state__icon">${'💰'}</span>
                 <p class="tt-body-strong">还没有账户</p>
                 <p class="tt-caption text-muted">先建一张银行卡或现金账户，才能开始记账</p>
                 <a class="btn btn--sm" href="/accounts" data-link>去添加账户</a>
               </div>`
            : groupBlocks
        }
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
