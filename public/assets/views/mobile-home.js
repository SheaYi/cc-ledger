/**
 * 手机端首页 —— 方向 A · 钱包优先（参照 Apple Wallet / 招行掌上生活）。
 *
 * ## 这一页回答什么问题
 *
 * 打开记账 App 的第一问是「**我这个月还剩多少**」，第二问才是「钱都在哪、最近记了什么」。
 * 所以顺序是：**结论（净资产 + 走势）→ 本月收支 → 账户余额 → 最近流水**。
 *
 * 桌面端的 `/` 走 `overview.js`（多栏、信息平铺）；本文件只在紧凑形态（≤1023px）渲染，
 * 由 `overview.js` 按 `isCompact()` 分派。**两套 DOM 而不是一套自适应**，是因为手机要的
 * 不是「桌面版塌成一列」，而是不同的信息优先级 —— 强行共用必然两头让步。
 *
 * ## 与其他 4 个槽的关系
 *
 * 底部 dock 是 首页 / 账单 / 记一笔 / 统计 / 设置（`chrome.js` 的 `DOCK_TABS`）。
 * 本页的所有区块都有「往下钻」的去处：账户 → `/accounts`，最近记账 → `/transactions`，
 * 本月收支的每一项 → 带好筛选的账单列表。**没有区块是终点**，否则用户会觉得被困住。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar, COMPOSE_HREF } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import {
  accountIcon,
  countUp,
  entityIcon,
  esc,
  icon,
  money,
  monthLabel,
} from '../ui.js';
import { amountText, amountTone, subjectIcon, subjectText } from '../lib/tx-format.js';

/** 最近记账取几条：够形成「刚才记了什么」的印象，但不至于把首页变成第二个账单页 */
const RECENT_LIMIT = 5;

/** 走势取多少天：30 天是「月」的自然单位，也是储蓄/透支拐点能被看见的最短窗口 */
const TREND_DAYS = 30;

function toneClass(v) {
  const n = Number(v);
  return n > 0 ? 'is-pos' : n < 0 ? 'is-neg' : '';
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

/** 最近 N 天（含今天）的起止日期 */
function recentRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: isoDay(from), to: isoDay(to) };
}

/**
 * 30 天**净资产**走势 —— 手写 SVG，不用 `lib/charts.js`。
 *
 * ## 为什么不用图表库
 *
 * `charts.js` 的 `lineChart` 需要坐标轴、数据点、悬停提示，是**图表区块**；
 * 这里要的是 hero 卡底部一条 34px 高的**签名线**（Apple Wallet 的那种呼吸感），
 * 职责是让人一眼看出「这段时间在涨还是在跌」，不承担读数 —— 数字由上方大字号给出。
 * 给一条 34px 的线配坐标轴和 tooltip，是把装饰当成仪表来用。
 *
 * ## 为什么必须画「累计」而不是每日 net
 *
 * 一开始画的是 daily `net`，于是图的上端 jitter 各日的盈亏、末端猛地一跳，
 * 且形状与 hero 上那个「净资产」数字**毫无关系** —— 用户会以为这是「每天的收支图」，
 * 而它明明挂在净资产下面。
 *
 * 现在做累计：`起点 = 当前净资产 − Σ(近 30 天每日 net)`，逐日累加后
 * **最后一个点严格等于 hero 的数字**。图与数字自洽，且含义唯一：
 * 「你的净资产这 30 天是怎么走到今天这个数的」。
 *
 * ## `preserveAspectRatio="none"` 的两个后果
 *
 * ① 图会被横向拉伸，所以**不能放 `<text>`**（文字会被压扁，`charts.js` 里同样的坑）；
 * ② 线条的自然去锯齿失效，故 `stroke-linejoin/round` 必须显式给出，否则折点会出尖刺。
 */
function sparkline(rows, netWorth, days) {
  const daily = new Map();
  for (const r of rows ?? []) {
    const day = String(r.period ?? '').slice(0, 10);
    if (day) daily.set(day, Number(r.net ?? 0));
  }

  /** 补全天序列：没有交易的日子净资产不变，不是「那一天不存在」 */
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push(daily.get(d) ?? 0);
  }

  /**
   * 剪掉**前导的空日子**。
   *
   * 「近 30 天」里如果前 18 天一笔账都没有，画出来就是一条 18 天的水平线加一次跳变 ——
   * 那条平线是我们的外推（净资产未变），不是观测事实。账本刚开的头两周到处是它，
   * 视觉上占了七成宽度却不含任何信息，还把真正的起伏压成一根针。
   * 所以从**最后一段空日子的前一天**起画 —— 保留一个 0 点做起坡的脚，
   * 之后每一天都真的有内容。窗口不足 2 点时退化为空态提示。
   */
  let startIdx = 0;
  while (startIdx < series.length - 2 && series[startIdx] === 0) startIdx += 1;
  /**
   * `startIdx - 1` 而不是 `startIdx`：必须留下**起坡的那只脚**。
   *
   * 第一次写成 `slice(startIdx)`，结果整条曲线几乎全平 —— 因为第一个非零日的
   * 累计值**已经是一天之后的净资产**（工资当天就跳了一大截），把它当起点就把
   * 「之前是多少」这个信息删掉了，剩下的只有起点之上的小幅波动。
   * 留一个 0 点，起点才是窗口真正的起始净资产。
   */
  const window = series.slice(Math.max(0, startIdx - 1));
  if (window.length < 2) {
    return '<div class="mh-spark mh-spark--empty">走势要攒够两天的现金流量才画得出来</div>';
  }

  const total = window.reduce((a, b) => a + b, 0);
  let acc = Number(netWorth ?? 0) - total;
  const points = window.map((v) => (acc += v));

  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const W = 100;
  const H = 28;
  const x = (i) => i * (W / (points.length - 1));
  const y = (v) => H - 4 - ((v - min) / span) * (H - 8);
  const xy = points.map((v, i) => [x(i), y(v)]);

  /**
   * Catmull-Rom → 三次贝塞尔。
   *
   * 为什么要平滑：这段序列里常见「很多天不动 + 一天工资入账」这种真实现象，
   * 直连出来是一条垂直断崖，看着像渲染坏了，而不是「那天净资产跳了一截」。
   * 平滑后每个**数据点仍然精确落在曲线上**（只是点与点之间不再是直线），
   * 所以既不撒谎，也把「突变」读成「变化」而不是「故障」。
   *
   * 控制点必须夹紧在画布内：Catmull-Rom 在陡变处会过冲到点位之外，
   * 一旦越过 viewBox 边界就会被 `preserveAspectRatio="none"` 一刀切平。
   */
  const clampY = (v) => Math.min(H, Math.max(0, v));
  const T = 0.8;
  let line = `M${xy[0][0].toFixed(2)},${xy[0][1].toFixed(2)}`;
  for (let i = 0; i < xy.length - 1; i += 1) {
    const p0 = xy[i - 1] ?? xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] ?? p2;
    const c1x = p1[0] + ((p2[0] - p0[0]) * T) / 6;
    const c1y = clampY(p1[1] + ((p2[1] - p0[1]) * T) / 6);
    const c2x = p2[0] - ((p3[0] - p1[0]) * T) / 6;
    const c2y = clampY(p2[1] - ((p3[1] - p1[1]) * T) / 6);
    line += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  const area = `${line} L${W},${H} L0,${H} Z`;
  const up = points[points.length - 1] >= points[0];

  return `
    <svg class="mh-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="近 ${points.length} 天净资产走势，${up ? '整体上升' : '整体下降'}">
      <path d="${area}" fill="currentColor" opacity="0.14" />
      <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.2"
            stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />
    </svg>
  `;
}

/**
 * 最近记账里的一行：图标 · 名称 · 时间+账户 · 金额。
 *
 * 点这一行跳到**它所在那一天的账单**（`dateFrom=dateTo=txDate`），而不是一个并不存在的
 * 「详情页」：账单列表本来就支持日期区间筛选，这样做不用加任何后端参数，
 * 且用户看到的是「这一天前前后后记了什么」——比单独一条的详情页更有用。
 */
function recentRow(tx) {
  const delta = Number(tx.signedAmount ?? tx.accountDelta ?? 0);
  const when = tx.txDate
    ? tx.txTime
      ? `${tx.txDate.slice(5).replace('-', '/')} ${String(tx.txTime).slice(0, 5)}`
      : tx.txDate.slice(5).replace('-', '/')
    : '';
  const sub = [when, tx.account?.name].filter(Boolean).join(' · ');
  const href = tx.txDate
    ? `/transactions?dateFrom=${encodeURIComponent(tx.txDate)}&dateTo=${encodeURIComponent(tx.txDate)}`
    : '/transactions';

  return `
    <a class="mh-tx" href="${href}" data-link>
      <span class="mh-tx__icon">${entityIcon(subjectIcon(tx), 16) || icon('list', 16)}</span>
      <span class="mh-tx__main">
        <span class="mh-tx__name">${esc(subjectText(tx))}</span>
        <span class="mh-tx__sub">${esc(sub)}</span>
      </span>
      <span class="mh-tx__amt tnum ${amountTone(delta)}">${esc(amountText(delta))}</span>
    </a>
  `;
}

export async function renderMobileHome(container, { go }) {
  const shell = appFrame({
    active: 'overview',
    inner: `
      <div class="mh-skeleton card"><div class="skeleton" style="width:34%"></div>
      <div class="skeleton" style="width:62%;height:30px;margin-top:16px"></div></div>
    `,
  });
  container.replaceChildren(shell);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return shell;
  }

  const range = recentRange(TREND_DAYS);
  const [summary, accounts, trend, recent] = await Promise.all([
    Api.accountSummary(ledger.id).then((r) => r.data).catch(() => null),
    /* 连已归档的一起取，只为分清「真没有账户」和「账户都归档了」两种空态；
       展示时归档账户一律不出现（归档 = 退出日常视图，不是消失） */
    Api.listAccounts(ledger.id, { includeArchived: true }).then((r) => r.data).catch(() => []),
    Api.statsTrend(ledger.id, { dateFrom: range.from, dateTo: range.to, granularity: 'day' })
      .then((r) => r.data)
      .catch(() => []),
    Api.listTransactions(ledger.id, { page: 1, pageSize: RECENT_LIMIT, sort: '-occurredAt' })
      .then((r) => r.data)
      .catch(() => []),
  ]);

  const realAccounts = (accounts ?? []).filter((a) => a.kind !== 'virtual' && !a.archivedAt);
  const archivedCount = (accounts ?? []).filter((a) => a.kind !== 'virtual' && a.archivedAt).length;
  const flow = summary?.period ?? { expense: 0, income: 0, net: 0, txCount: 0, dateFrom: '' };
  const monthName = flow.dateFrom ? monthLabel(flow.dateFrom.slice(0, 7)) : '本月';

  const frame = appFrame({
    active: 'overview',
    user: me,
    ledger,
    inner: `
      <!-- ① 结论：净资产 hero。深色是因为它是全页唯一的「反转面」，
           00-DESIGN 允许 hero/brand panel 用 --c-hero-panel；其他地方一律不这么做。 -->
      <section class="mh-hero">
        <div class="mh-hero__head">
          <span class="mh-hero__lb">净资产</span>
          <a class="mh-hero__add" href="${esc(COMPOSE_HREF)}" data-link aria-label="记一笔">
            ${icon('plus', 18)}
          </a>
        </div>
        <div class="mh-hero__val tnum" data-role="networth">${money(summary?.netWorth ?? 0)}</div>
        <div class="mh-hero__sub">
          <span>资产 <b class="tnum">${money(summary?.assetTotal ?? 0)}</b></span>
          <span>负债 <b class="tnum">${money(summary?.liabilityTotal ?? 0)}</b></span>
        </div>
        ${sparkline(trend, summary?.netWorth ?? 0, TREND_DAYS)}
      </section>

      <!-- ② 本月收支：三格。结余放在第三格而不是当标题副文案，
           是因为「花多少、进多少、剩多少」是同一级的三个问题。 -->
      <section class="mh-flow">
        <a class="mh-flow__cell" href="/transactions?recordType=expense" data-link>
          <span class="mh-flow__lb">${esc(monthName)}支出</span>
          <span class="mh-flow__v tnum ${toneClass(-Math.abs(flow.expense))}">${money(flow.expense)}</span>
        </a>
        <a class="mh-flow__cell" href="/transactions?recordType=income" data-link>
          <span class="mh-flow__lb">${esc(monthName)}收入</span>
          <span class="mh-flow__v tnum ${toneClass(flow.income)}">${money(flow.income)}</span>
        </a>
        <a class="mh-flow__cell mh-flow__cell--net" href="/transactions" data-link>
          <span class="mh-flow__lb">结余</span>
          <span class="mh-flow__v tnum ${toneClass(flow.net)}">${money(flow.net)}</span>
        </a>
      </section>

      <!-- ③ 记一笔：比 dock 中心的 pill 更宽的一条，但它不是重复件 ——
           dock 在屏幕最底（拇指区），这条在首屏第一屏末尾（视线区），
           二者服务的是「刚打开想记」和「看完余额想记」两种时机。 -->
      <a class="mh-cta" href="${esc(COMPOSE_HREF)}" data-link>
        ${icon('plus', 20)}
        <span>记一笔</span>
      </a>

      <!-- ④ 账户竖列表。原型里是横滑卡，实现改竖排：
           横滑在只有 1~2 个账户时右侧大片空白，且双手滑动才能看全；
           竖列表在 1~8 个账户区间都成立，还能直接给「查看全部」。 -->
      <section class="mh-sec">
        <div class="mh-sec__head">
          <h2 class="mh-sec__t">账户</h2>
          <a class="mh-sec__more" href="/accounts" data-link>全部 ${realAccounts.length} 个${icon('chevron', 13)}</a>
        </div>
        ${
          realAccounts.length === 0
            ? `<div class="card mh-empty">
                 <p class="tt-body-strong">${archivedCount > 0 ? '账户都已归档' : '还没有账户'}</p>
                 <p class="tt-caption text-muted">${
                   archivedCount > 0
                     ? `${archivedCount} 个账户已归档，到账户页可取消归档让它们回到这里`
                     : '先建一张银行卡或现金账户，才能开始记账'
                 }</p>
                 <a class="btn btn--sm" href="/accounts" data-link>去账户页</a>
               </div>`
            : `<div class="card card--flush mh-list">
                 ${realAccounts.slice(0, 4).map((a) => {
                   const href = `/transactions?accountId=${encodeURIComponent(a.id)}`;
                   return `
                   <a class="mh-acct-row" href="${href}" data-link>
                     <span class="mh-acct-row__icon">${accountIcon(a, 16)}</span>
                     <span class="mh-acct-row__name">${esc(a.name)}</span>
                     <span class="mh-acct-row__val tnum ${toneClass(a.balance)}">${money(a.balance)}</span>
                     <span class="mh-acct-row__go" aria-hidden="true">${icon('chevron', 14)}</span>
                   </a>`;
                 }).join('')}
               </div>`
        }
      </section>

      <!-- ⑤ 最近记账：给「我刚才记的东西在不在」一个确认感 -->
      <section class="mh-sec">
        <div class="mh-sec__head">
          <h2 class="mh-sec__t">最近记账</h2>
          <a class="mh-sec__more" href="/transactions" data-link>全部${icon('chevron', 13)}</a>
        </div>
        ${
          (recent ?? []).length === 0
            ? `<div class="card mh-empty">
                 <p class="tt-body-strong">还没有账单</p>
                 <p class="tt-caption text-muted">记下第一笔之后，这里会显示最近 5 条</p>
               </div>`
            : `<div class="card card--flush mh-list">${(recent ?? []).map(recentRow).join('')}</div>`
        }
      </section>
    `,
  });

  mountTabBar(frame, { active: 'overview', go, ledger });
  container.replaceChildren(frame);

  /* 英雄数字滚动一次（prefers-reduced-motion 时 countUp 内部直接落终值） */
  countUp(frame.querySelector('[data-role=networth]'), summary?.netWorth ?? 0);

  return frame;
}
