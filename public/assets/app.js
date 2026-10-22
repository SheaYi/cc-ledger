/**
 * CC记账 · 前端入口
 * 极简 history 路由，页面以「记账」为核心：
 *   /                     概览（净资产 + 本月收支 + 账户快览）
 *   /transactions         账单列表（按日分组 + 筛选 + 批量）
 *   /transactions/new     记账页（唯一规范路径，docs/13 §3.4）
 *   /transactions/:id     账单详情
 *   /transactions/:id/edit 编辑账单（同一套表单，走 PATCH + 乐观锁）
 *   /accounts             账户（余额、期初、信用卡、对账）
 *   /categories           分类（两层科目表）
 *   /tags                 标签（多维标记）
 *   /settings             我的（资料 / 账本 / 成员 / 安全）
 *   /login  /register  /invite/:code
 * `/tx/new` 是记账页的**兼容别名**（docs/13 §3.4 解决 D4）：
 * 命中后前端重定向到 `/transactions/new` 并保留全部 query，
 * 这样 09 §6.3 已经印出去的二维码与 PWA 快捷指令不作废。
 * 不引入任何构建工具 —— 静态文件直接由 Fastify 托管。
 */
import { auth } from './store.js';
import { init as initTheme } from './theme.js';
import { rememberComposeSource } from './session.js';
import { setChromeNav } from './chrome.js';
import { renderLogin, renderRegister } from './views/auth.js';
import { renderOverview } from './views/overview.js';
import { renderAccounts } from './views/accounts.js';
import { renderReconciliations } from './views/reconciliations.js';
import { renderCategories } from './views/categories.js';
import { renderTags } from './views/tags.js';
import { renderTemplates } from './views/templates.js';
import { renderRecurring } from './views/recurring.js';
import { renderInstallments } from './views/installments.js';
import { renderBudgets } from './views/budgets.js';
import { renderStats } from './views/stats.js';
import { renderImport } from './views/import.js';
import { renderSettings } from './views/settings.js';
import { renderInvite } from './views/invite.js';
import { renderTransactionForm } from './views/transaction-form.js';
import { renderTransactions } from './views/transactions.js';
import { renderDebts } from './views/debts.js';
import { renderTransactionDetail } from './views/transaction-detail.js';

const app = document.getElementById('app');

/** 需要登录的页面：path → 渲染函数（**精确匹配**） */
const PAGES = {
  '/': renderOverview,
  '/transactions': renderTransactions,
  '/transactions/new': renderTransactionForm,
  '/accounts': renderAccounts,
  '/reconciliations': renderReconciliations,
  '/debts': renderDebts,
  '/categories': renderCategories,
  '/tags': renderTags,
  '/templates': renderTemplates,
  '/recurring': renderRecurring,
  '/installments': renderInstallments,
  '/budgets': renderBudgets,
  '/stats': renderStats,
  '/import': renderImport,
  '/settings': renderSettings,
};

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

/**
 * 紧凑形态（≤1023px）—— 与 TabBar 的显示断点**同一个数**。
 *
 * 手机端首页落点是「账户」而不是「概览」：底部 5 槽是 账户/账单/记一笔/统计/设置，
 * 概览不在栏里，若 `/` 仍渲染概览，首屏会出现「底栏没有任何一项亮着」的悬空态。
 * 桌面不变（概览仍是 `/`）。
 *
 * ⚠️ 断点写在这里而不是 mobile.css：它是**路由**判据，不是样式判据，
 *    两侧各写一份必然漂移。
 */
const isCompact = () => window.matchMedia('(max-width: 1023px)').matches;

function go(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  render();
}

function query(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * 把导航函数注入外壳层（`chrome.js`）。
 * 侧栏 / 顶栏 / TabBar 的「记一笔」要靠它跳转与打开模板面板 ——
 * 由 app.js 注入一次，各页面不必把 `go` 一层层往下传（22 处调用，漏一处就退化）。
 */
setChromeNav(go);

async function render() {
  const path = currentPath();
  const inviteMatch = /^\/invite\/([A-Za-z0-9]+)$/.exec(path);

  // 记账页的兼容别名：/tx/new → /transactions/new（保留 query），文档与代码的首选出厂值
  // 一律用规范路径，别名只为兜住已经发出去的链接（docs/13 §3.4 解决 D4）。
  if (path === '/tx/new') {
    go(`/transactions/new${window.location.search}`, { replace: true });
    return;
  }

  // 手机/平板：`/` 落到「账户」（底部导航第一槽），避免首屏无选中态。
  // replace 而非 push：用户按返回键不该在「/ ↔ /accounts」之间来回弹。
  if (path === '/' && isCompact()) {
    go('/accounts', { replace: true });
    return;
  }

  if (inviteMatch) {
    app.replaceChildren();
    await renderInvite(app, { code: inviteMatch[1].toUpperCase(), go });
    return;
  }

  if (path === '/register') {
    renderRegister(app, { onSuccess: () => go(query('next') || '/', { replace: true }) });
    return;
  }

  if (path === '/login') {
    renderLogin(app, {
      onSuccess: () => go(query('next') || query('redirect') || '/', { replace: true }),
    });
    return;
  }

  /* 需要登录的两类路由：先精确匹配 PAGES（`/transactions` 与 `/transactions/new`
     都在表里，所以不会被下面的动态规则抢走），再匹配账单的动态路径。 */
  const page = PAGES[path];
  const dynamic = page ? null : matchTransactionRoutes(path);

  if (page || dynamic) {
    if (!auth.isLoggedIn) {
      go(`/login?next=${encodeURIComponent(path + window.location.search)}`, { replace: true });
      return;
    }
    const ctx = { go, query, path };
    if (page) await page(app, ctx);
    else if (dynamic.editId) await renderTransactionForm(app, { ...ctx, editId: dynamic.editId });
    else await renderTransactionDetail(app, { ...ctx, txId: dynamic.id });
    return;
  }

  // 未知路径 → 回到概览
  go('/', { replace: true });
}

/**
 * 账单的动态路径。顺序即优先级：带 `/edit` 的更具体，必须先判。
 * 账单 ID 形如 `tx_01J...`，但也可能是预置数据的复合 ID（`ldg_x#tx_y`），
 * 所以这里只排除空段，不做字符集限制 —— 真正的合法性由后端 404 兜底。
 */
function matchTransactionRoutes(path) {
  const edit = /^\/transactions\/([^/]+)\/edit$/.exec(path);
  if (edit) return { editId: decodeURIComponent(edit[1]) };
  const one = /^\/transactions\/([^/]+)$/.exec(path);
  if (one && one[1] !== 'new') return { id: decodeURIComponent(one[1]) };
  return null;
}

// SPA 内链拦截
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || href.startsWith('http')) return;
  e.preventDefault();
  // 去记账页之前记住「从哪来」：记完账要回到这一页（docs/13 §7.2）
  if (href === '/transactions/new' || href.startsWith('/transactions/new?')) {
    rememberComposeSource(currentPath() + window.location.search);
  }
  go(href);
});

window.addEventListener('popstate', render);

/**
 * 桌面快捷键 `n` → 记账页（docs/13 §3.5）。
 *
 * 三条守卫缺一不可：
 *  ① **输入态不抢** —— 在备注/搜索框里打「n」就跳走是最吵的死法；
 *  ② **组合键不响应** —— Ctrl/Meta/Alt+n 留给浏览器与系统（Mac 上是新建窗口）；
 *  ③ **不响应长按重复**（`e.repeat`）—— 否则按住不放会连续 render。
 * 另外跳转前必须 `rememberComposeSource()`：桌面用户常从「往来 / 账户」页按 n，
 * 记完账要回到**他刚才所在的页面**，而不是默认的账单列表（docs/13 §7.2）。
 */
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (currentPath() === '/transactions/new') return;
  rememberComposeSource(currentPath() + window.location.search);
  go('/transactions/new');
});

// 全局兜底：未处理异常不白屏
window.addEventListener('unhandledrejection', (e) => {
  console.error('未处理的异步异常', e.reason);
});

// 主题：首屏配色已由 index.html 的内联脚本落定；
// 这里补上「自动模式下跟随系统实时切换」的监听。
initTheme();

/**
 * Service Worker 注册（docs/09 §四）。
 *
 * 只在**安全上下文**注册：NAS 上若用 http + 局域网 IP 部署，注册会失败 ——
 * 那是预期降级（09 §806 已说明 PWA 能力要求 HTTPS），静默处理即可，
 * 应用本身仍作为普通网页完整可用。
 *
 * 注册时机选 load 之后：首屏渲染不该被 SW 安装阻塞。
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 不支持或被浏览器策略拒绝：功能降级为普通网页 */
    });
  });
}

/**
 * 软键盘适配（docs/09 §3.3）。
 * 记账页的金额输入会唤起数字键盘，键盘高度必须让「落底的操作栏」知道，
 * 否则提交按钮会被键盘压住。用 visualViewport 而不是 innerHeight：
 * 前者在 iOS 上能拿到键盘真实占位，且不会踩到 Safari 的历史 bug。
 * 只写一个 CSS 变量，布局细节全部留在样式层。
 */
(function trackKeyboardHeight() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const sync = () => {
    const offset = Math.max(0, window.innerHeight - vv.height);
    root.style.setProperty('--keyboard-height', `${Math.round(offset)}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
})();

render();
