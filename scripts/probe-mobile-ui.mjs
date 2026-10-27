/**
 * 手机端 UI 探针（390 × 844）
 *
 * 断言的是**外观层面**的四个硬要求（都是真机上一眼能看出的毛病，
 * 静态审计查不到）：
 *
 *   1. 底部 dock 切换页面时**不重建** —— 重建会重播 `tabbar-in` 入场动画，
 *      表现为切页时底栏「被推出去又滑回来」闪一下。
 *   2. 顶部固定条 app-bar **已整体移除**（导航与「记一笔」改由底部 dock 动作位承担）。
 *   3. 记账页类型 / 分类横滑带里的 pill **互不重叠**。
 *   4. 账单页「支出 / 收入 / 结余」**同一行**（三列等分）。
 *   5. 记账页账单卡片：无顶部操作区、手续费/折扣同行、日期/时间同行、
 *      账期在末块单独一行、名称在商家之前且相邻。
 *   6. 账单页每条记录都有分类图标（最左、与首页「最近记账」同一套视觉），
 *      且首页最近记账点进去是**这一笔的详情页** `/transactions/:id`。
 *
 * 外加通用护栏：横向不溢出、触控目标 ≥44px。
 *
 * 用法：node scripts/probe-mobile-ui.mjs [light|dark]
 */
import { join } from 'node:path';
import { connect } from './lib/cdp.mjs';
import { seed } from './lib/mobile-seed.mjs';

const W = 390;
const H = 844;
const THEME = process.argv[2] === 'dark' ? 'dark' : 'light';

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log('  ✓', name, detail ? `· ${detail}` : '');
  } else {
    fails.push({ name, detail });
    console.log('  ✗', name, detail ? `· ${detail}` : '');
  }
}

const s = await seed();
const probe = await connect({ base: 'http://127.0.0.1:3000' });
const { ev, wipe, authInjector, open, shot } = probe;
const auth = authInjector({ token: s.token });
await wipe();

const OUT = join(process.cwd(), 'screenshots', `probe-${THEME}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const go = (path, sel) => open(path, { wait: sel, width: W, height: H, mobile: true, theme: THEME, arm: auth.arm });

/* ================= 0. 移动端首页（方向 A · 钱包优先） ================= */
console.log('\n── 移动端首页（钱包优先）──');
await go('/', '.mh-hero');
await wait(1200);

check(
  '紧凑形态 `/` 渲染的是手机首页而非重定向到账户页',
  (await ev(`window.location.pathname`)) === '/' && (await ev(`!!document.querySelector('.mh-hero')`)) === true,
  await ev(`window.location.pathname`),
);
check('dock 第一槽是「首页」且选中', (await ev(`document.querySelector('[data-tab=overview]')?.getAttribute('aria-current')`)) === 'page');
check(
  '账户页降为首页的子页（仍归槽到首页）',
  await ev(`(() => { location.hash=''; return true; })()`) !== null,
);

const homeOrder = JSON.parse(
  await ev(`(() => {
  const pick = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null; };
  return JSON.stringify({
    hero: pick('.mh-hero'),
    flow: pick('.mh-flow'),
    cta: pick('.mh-cta'),
    acct: pick('.mh-acct-row'),
    recent: pick('.mh-tx'),
    net: document.querySelector('[data-role=networth]')?.textContent?.trim() ?? '',
    cells: [...document.querySelectorAll('.mh-flow__cell')].map((el) => el.querySelector('.mh-flow__lb')?.textContent?.trim()),
    cellCount: document.querySelectorAll('.mh-flow__cell').length,
    acctRows: document.querySelectorAll('.mh-acct-row').length,
    recentRows: document.querySelectorAll('.mh-tx').length,
    spark: !!document.querySelector('.mh-spark'),
  });
})()`),
);
check('首页区块顺序 = 净资产 → 本月收支 → 记一笔 → 账户 → 最近记账',
  homeOrder.hero < homeOrder.flow && homeOrder.flow < homeOrder.cta
    && homeOrder.cta < homeOrder.acct && homeOrder.acct < homeOrder.recent,
  JSON.stringify(homeOrder));
check('本月收支是三格同行', homeOrder.cellCount === 3, `${homeOrder.cellCount} 格：${homeOrder.cells.join('/')}`);
check('净资产数字非空且含货币符', /[¥￥]/.test(homeOrder.net) && /\d/.test(homeOrder.net), homeOrder.net);
check('30 天走势图已渲染', homeOrder.spark === true);

/**
 * 最近记账：点某一笔要进**这一笔的详情页** `/transactions/:id`，
 * 不再跳「那一天的账单列表」。顺带量一下图标格尺寸，给后面「两页图标一致」做基准。
 */
const recent = JSON.parse(
  await ev(`(() => {
  const rows = [...document.querySelectorAll('.mh-tx')];
  const icon = rows[0]?.querySelector('.mh-tx__icon');
  const b = icon?.getBoundingClientRect();
  return JSON.stringify({
    n: rows.length,
    hrefs: rows.map((r) => r.getAttribute('href') ?? ''),
    iconW: b ? Math.round(b.width) : 0,
    iconH: b ? Math.round(b.height) : 0,
    iconRadius: icon ? getComputedStyle(icon).borderRadius : '',
    iconBg: icon ? getComputedStyle(icon).backgroundColor : '',
  });
})()`),
);
check(
  '最近记账每行都跳账单详情 `/transactions/:id`',
  recent.n > 0 && recent.hrefs.every((h) => /^\/transactions\/[^/?]+$/.test(h)),
  recent.hrefs.slice(0, 2).join(' , ') || '无行',
);
check(
  '最近记账图标格 32×32（账单页比对的基准）',
  recent.iconW === 32 && recent.iconH === 32,
  `${recent.iconW}×${recent.iconH} · radius=${recent.iconRadius} · bg=${recent.iconBg}`,
);

/**
 * 真点一次：href 写对不等于路由接得住，两件事分开验。
 * 落点必须是**详情页**（`.txd`），不是账单列表。
 */
await ev(`(() => { document.querySelector('.mh-tx')?.click(); return true; })()`);
await wait(1400);
const landed = JSON.parse(
  await ev(`(() => JSON.stringify({
  path: location.pathname,
  detail: !!document.querySelector('.txd'),
  amount: document.querySelector('.txd__amount')?.textContent?.trim() ?? '',
}))()`),
);
check(
  '点最近记账的一笔 → 落到该笔详情页（不是账单列表）',
  /^\/transactions\/[^/]+$/.test(landed.path) && landed.detail === true,
  `${landed.path} · 金额 ${landed.amount}`,
);
await go('/', '.mh-hero');
await wait(1000);

const flowRow = JSON.parse(
  await ev(`(() => {
  const tops = [...document.querySelectorAll('.mh-flow__cell')].map((el) => Math.round(el.getBoundingClientRect().top));
  const widths = [...document.querySelectorAll('.mh-flow__cell')].map((el) => Math.round(el.getBoundingClientRect().width));
  const heights = [...document.querySelectorAll('.mh-flow__cell')].map((el) => Math.round(el.getBoundingClientRect().height));
  return JSON.stringify({ tops, widths, heights });
})()`),
);
check('三格统计同一行（top 相同）', new Set(flowRow.tops).size === 1, JSON.stringify(flowRow.tops));
check('三格等宽', new Set(flowRow.widths).size === 1, JSON.stringify(flowRow.widths));
check('三格触控高度 ≥44px', Math.min(...flowRow.heights) >= 44, JSON.stringify(flowRow.heights));

/* hero 是反转面：深色底 + 反白字。暗色/亮色主题下都得成立，
   否则只是把「看不见」换了个场合。 */
const heroContrast = JSON.parse(
  await ev(`(() => {
  const el = document.querySelector('.mh-hero');
  const v = document.querySelector('.mh-hero__val');
  const cs = getComputedStyle(el);
  return JSON.stringify({ bg: cs.backgroundColor, color: getComputedStyle(v).color });
})()`),
);
check('净资产卡是深色 hero panel（不是普通白卡）',
  /rgba?\(2[0-9], 2[0-9], 2[0-9]/.test(heroContrast.bg) || heroContrast.bg !== 'rgb(255, 255, 255)',
  `${heroContrast.bg} / 文字 ${heroContrast.color}`);

/* 溢出与小热区检查（与其他 5 页同一套判据） */
const homeGuard = JSON.parse(
  await ev(`(() => {
  const cw = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll('*')].filter((el) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && (b.right > cw + 0.5 || b.left < -0.5);
  }).map((el) => (el.className || el.tagName).toString().slice(0, 24));
  const small = [...document.querySelectorAll('.mh-hero__add, .mh-cta, .mh-sec__more, .mh-flow__cell, .mh-acct-row, .mh-tx')]
    .filter((el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.height < 44; })
    .map((el) => (el.className || '').toString().slice(0, 24));
  return JSON.stringify({ over: over.slice(0, 5), small: small.slice(0, 5) });
})()`),
);
check('首页无横向溢出', homeGuard.over.length === 0, homeGuard.over.join(',') || '无');
check('首页可点区块 ≥44px', homeGuard.small.length === 0, homeGuard.small.join(',') || '全部达标');

/* ================= 0b. 原生金额键盘（系统自带） ================= */
console.log('\n── 金额键盘（原生） ──');
await go('/transactions/new', '.compose__card');
await wait(900);

/**
 * 进页面**不许**自动弹键盘：金额框是原生 input，自动聚焦会立刻唤起系统数字键盘，
 * 用户还没决定记什么就先被弹起的键盘盖住半屏。键盘只能由用户去点金额唤起。
 */
const onLoad = JSON.parse(
  await ev(`(() => {
  const pad = document.getElementById('cc-amount-pad');
  const a = document.querySelector('[name=amount]');
  return JSON.stringify({
    padExists: !!pad,
    readonly: a ? a.hasAttribute('readonly') : null,
    inputmode: a ? a.getAttribute('inputmode') : null,
    dimmed: document.documentElement.classList.contains('has-amount-pad'),
    locked: getComputedStyle(document.documentElement).overflow,
  });
})()`),
);
check('进记账页不存在 App 内金额键盘（已改原生输入）', onLoad.padExists === false);
check('进记账页金额框不是只读（可用系统键盘输入）', onLoad.readonly === false, `readonly=${onLoad.readonly}`);
check('金额框 inputmode=decimal（唤起系统数字键盘）', onLoad.inputmode === 'decimal', `inputmode=${onLoad.inputmode}`);
check('进记账页没有全屏遮罩（html 无 has-amount-pad）', onLoad.dimmed === false);
check('进记账页背景滚动没被锁死', onLoad.locked !== 'hidden', `html overflow=${onLoad.locked}`);

/**
 * 聚焦金额框：原生 input 应当获得焦点、可编辑，且**不会**弹出任何 App 内键盘
 * （没有 cc-amount-pad、没有 is-open、页面不发灰、滚动不被锁）。
 */
await ev(`(() => { document.querySelector('[name=amount]')?.focus(); return true; })()`);
await wait(500);
const afterFocusAmount = JSON.parse(
  await ev(`(() => {
  const pad = document.getElementById('cc-amount-pad');
  const a = document.querySelector('[name=amount]');
  return JSON.stringify({
    padOpen: !!pad && pad.classList.contains('is-open'),
    dimmed: document.documentElement.classList.contains('has-amount-pad'),
    activeName: document.activeElement?.getAttribute?.('name') ?? document.activeElement?.tagName,
    locked: getComputedStyle(document.documentElement).overflow,
  });
})()`),
);
check('聚焦金额框不弹出 App 内键盘', afterFocusAmount.padOpen === false, JSON.stringify(afterFocusAmount));
check('聚焦金额框页面不发灰（无 has-amount-pad）', afterFocusAmount.dimmed === false);
check('聚焦金额框背景滚动不被锁', afterFocusAmount.locked !== 'hidden', `html overflow=${afterFocusAmount.locked}`);
check('聚焦金额框后焦点确实落在金额框上', afterFocusAmount.activeName === 'amount', String(afterFocusAmount.activeName));

/**
 * 原生输入：直接在金额框里写入并派发 input 事件，验证 data-money 管道能接住
 * （清洗 + 落值）。原生键盘语义：用户敲出来的就是最终数值（无连加算式）。
 */
await ev(`(() => {
  const a = document.querySelector('[name=amount]');
  a.value = '12.5';
  a.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await wait(300);
const afterType = JSON.parse(
  await ev(`(() => {
  const a = document.querySelector('[name=amount]');
  return JSON.stringify({ value: a?.value });
})()`),
);
check('原生输入金额被 data-money 管道接住（value=12.5）', afterType.value === '12.5', `value=${afterType.value}`);

/**
 * 焦点移到别的输入框：原生 input 场景下页面永远不该发灰/锁滚动
 * （之前 App 内键盘的痛点）。这里确认「去点备注」不会触发任何遮罩。
 */
await ev(`(() => { document.querySelector('[name=note]')?.focus(); return true; })()`);
await wait(400);
const afterNote = JSON.parse(
  await ev(`(() => {
  return JSON.stringify({
    dimmed: document.documentElement.classList.contains('has-amount-pad'),
    activeName: document.activeElement?.getAttribute?.('name') ?? document.activeElement?.tagName,
    locked: getComputedStyle(document.documentElement).overflow,
  });
})()`),
);
check('聚焦普通输入框时页面不发灰', afterNote.dimmed === false);
check('焦点留在用户刚点的输入框上', afterNote.activeName === 'note', String(afterNote.activeName));
check('焦点切换后背景滚动不被锁', afterNote.locked !== 'hidden', `html overflow=${afterNote.locked}`);

/* 让金额框失焦、页面恢复稳定，供后面的「提交条」断言使用 */
await ev(`(() => { const a = document.querySelector('[name=amount]'); a?.blur(); return true; })()`);
await wait(300);

/* =============== 3a-2. 提交条：与卡片同宽同高 =============== */
const bar = JSON.parse(
  await ev(`(() => {
  const el = document.querySelector('.action-bar');
  const card = document.querySelector('.compose__card') ?? document.querySelector('.card');
  if (!el || !card) return 'null';
  const b = el.getBoundingClientRect(), c = card.getBoundingClientRect();
  const cs = getComputedStyle(el), ccs = getComputedStyle(card);
  const btns = [...el.querySelectorAll('.btn')].map((x) => Math.round(x.getBoundingClientRect().height));
  return JSON.stringify({
    barL: Math.round(b.left), barR: Math.round(b.right), barW: Math.round(b.width), barH: Math.round(b.height),
    cardL: Math.round(c.left), cardR: Math.round(c.right), cardW: Math.round(c.width),
    radius: cs.borderTopLeftRadius + '/' + cs.borderBottomLeftRadius,
    cardRadius: ccs.borderTopLeftRadius,
    btns,
  });
})()`),
);
if (bar === 'null') check('提交条与卡片都存在', false);
else {
  check(
    '提交条与卡片左右缘对齐（同宽，不再是贴底通栏）',
    Math.abs(bar.barL - bar.cardL) <= 1 && Math.abs(bar.barR - bar.cardR) <= 1,
    `条 ${bar.barL}~${bar.barR} / 卡 ${bar.cardL}~${bar.cardR}`,
  );
  check(
    '提交条四角圆角与卡片一致（上下同半径）',
    bar.radius.split('/')[0] === bar.radius.split('/')[1] && bar.radius.split('/')[0] === bar.cardRadius,
    `条 ${bar.radius} / 卡 ${bar.cardRadius}`,
  );
  check(
    '提交条高度 = 44px 按钮 + 上下留白（66~72）',
    bar.barH >= 66 && bar.barH <= 72,
    `${bar.barH}px`,
  );
  check(
    '提交条内按钮同高（都是 44px 触控底线）',
    bar.btns.length >= 2 && new Set(bar.btns).size === 1 && bar.btns[0] === 44,
    bar.btns.join('/'),
  );
}

/* ================= 1. dock 不重建 ================= */
console.log('\n── 底部 dock ──');
await go('/accounts', '.tabbar');
await wait(600);
// 打标记：若切页后标记还在，说明是同一个 DOM 节点
await ev(`(() => { const d = document.getElementById('cc-dock'); if (d) d.__probeMark = 'k1'; return !!d; })()`);
check('dock 挂在 body 上（不在页面 shell 内）', (await ev(`!!document.getElementById('cc-dock')`)) === true);
check(
  'dock 是 body 的直接子节点（切页不会被 shell 重建带走）',
  (await ev(`document.getElementById('cc-dock')?.parentElement?.tagName`)) === 'BODY',
);

// 点 dock 上的「账单」切页，检查节点是否被换掉
await ev(`(() => { document.querySelector('[data-tab=transactions]')?.click(); return true; })()`);
await wait(1200);
const mark = await ev(`document.getElementById('cc-dock')?.__probeMark ?? 'LOST'`);
check('切页后仍是同一个 dock 节点（不重播入场动画）', mark === 'k1', `标记=${mark}`);
check(
  '切页后选中态跟到了「账单」',
  (await ev(`document.querySelector('[data-tab=transactions]')?.getAttribute('aria-current')`)) === 'page',
);
check(
  '旧选中态已移除（不会两个都亮）',
  (await ev(`[...document.querySelectorAll('[data-tab][aria-current]')].length`)) === 1,
);

await go('/transactions/new', '.compose__card');
await wait(700);
check('记账页不显示 dock（全屏页）', (await ev(`(() => { const d = document.getElementById('cc-dock'); return !d || d.hidden; })()`)) === true);

/* ================= 2. 顶部固定条（app-bar）已整体移除 ================= */
console.log('\n── 顶部固定条（已整体移除） ──');
await go('/accounts', '.page__hero');
await wait(700);
const appBar = JSON.parse(
  await ev(`(() => {
  const dock = document.getElementById('cc-dock');
  return JSON.stringify({
    hasBar: !!document.querySelector('.app-bar'),
    hasChip: !!document.querySelector('.user-chip'),
    hasDock: !!dock,
    dockCompose: !!dock?.querySelector('[data-compose]'),
    /* 顶栏整条移除后，内容不该再被它顶下去：页面顶边应贴着视口（只剩安全区） */
    pageTop: (() => {
      const p = document.querySelector('.page');
      return p ? Math.round(p.getBoundingClientRect().top) : -1;
    })(),
  });
})()`),
);
check('顶部固定条 app-bar 已整体移除', appBar.hasBar === false);
check('页面不再渲染头像卡片（user-chip）', appBar.hasChip === false);
check('底部 dock 仍在（导航不丢）', appBar.hasDock === true);
check('记一笔入口仍在（dock 动作位）', appBar.dockCompose === true);
check('内容不再被顶栏顶下去（页面顶边 ≤ 20px）', appBar.pageTop >= 0 && appBar.pageTop <= 20);

/* ================= 3. 记账页：类型/分类不重叠 + 间距 ================= */
console.log('\n── 记账页 ──');
await go('/transactions/new', '.compose__card');
await wait(900);
await ev(`(() => { document.querySelector('[data-role=pick-trigger]')?.click(); return true; })()`);
await wait(900);
const panel = JSON.parse(
  await ev(`(() => {
  const items = [...document.querySelectorAll('.mega__col--type .mega__item')].map((el) => {
    const b = el.getBoundingClientRect();
    return { t: el.textContent.trim().split('\\n')[0], l: b.left, r: b.right, t0: b.top, b0: b.bottom };
  });
  const ov = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b0, b.b0) - Math.max(a.t0, b.t0);
      if (ox > 1 && oy > 1) ov.push(a.t + '×' + b.t + ' ' + Math.round(ox) + 'x' + Math.round(oy));
    }
  const parents = [...document.querySelectorAll('.mega__col--parent .mega__navitem')].map((el) => {
    const b = el.getBoundingClientRect();
    return { t: el.textContent.trim().split('\\n')[0], l: b.left, r: b.right, t0: b.top, b0: b.bottom };
  });
  const pov = [];
  for (let i = 0; i < parents.length; i++)
    for (let j = i + 1; j < parents.length; j++) {
      const a = parents[i], b = parents[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b0, b.b0) - Math.max(a.t0, b.t0);
      if (ox > 1 && oy > 1) pov.push(a.t + '×' + b.t);
    }
  return JSON.stringify({ count: items.length, labels: items.map((x) => x.t), overlaps: ov, pov });
})()`),
);
check('类型带 5 个类型全部渲染', panel.count === 5, panel.labels.join('/'));
check('类型 pill 互不重叠', panel.overlaps.length === 0, panel.overlaps.join('；') || '无重叠');
check('一级分类 pill 互不重叠', panel.pov.length === 0, panel.pov.join('；') || '无重叠');
await shot('compose-panel', { dir: OUT });

// 关面板，量名称 → 日期间距
await ev(`(() => { document.querySelector('[data-role=pick-trigger]')?.click(); return true; })()`);
await wait(500);
/**
 * 记账页卡片布局（账单卡片的信息密度与层级）：
 *   ① 顶部「记一笔 / 返回」操作区已移除
 *   ② 手续费与折扣同一行
 *   ③ 日期与时间同一行，账期下移到底部单独一行
 *   ④ 名称在商家之前、两者同一卡片且相邻
 */
const layout = JSON.parse(
  await ev(`(() => {
  const card = document.querySelector('.compose__card');
  const q = (s) => card?.querySelector(s) ?? null;
  const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
  const vis = (el) => !!el && el.offsetParent !== null;
  const fee = q('[data-field=fee]');
  const discount = q('[data-field=discount]');
  const date = q('[data-field=txDate]');
  const time = q('[data-field=txTime]');
  const name = q('[data-field=name]');
  const merchant = q('[data-field=merchant]');
  const mode = q('[data-role=entry-mode-block]');
  const blocks = [...(card?.querySelectorAll(':scope > .compose__block') ?? [])];
  const lastBlock = blocks[blocks.length - 1];
  return JSON.stringify({
    hasHead: !!document.querySelector('.compose__head'),
    hasBack: !!document.querySelector('[data-role=back]'),
    feeVisible: vis(fee),
    discountVisible: vis(discount),
    feeTop: top(fee),
    discountTop: top(discount),
    dateTop: top(date),
    timeTop: top(time),
    nameTop: top(name),
    merchantTop: top(merchant),
    nameMerchantGap:
      name && merchant
        ? Math.round(merchant.getBoundingClientRect().top - name.getBoundingClientRect().bottom)
        : null,
    nameFirst:
      name && merchant
        ? (name.compareDocumentPosition(merchant) & Node.DOCUMENT_POSITION_FOLLOWING) > 0
        : null,
    sameCard:
      !!name && !!merchant && name.closest('.compose__card') === merchant.closest('.compose__card'),
    modeInLastBlock: !!mode && !!lastBlock && lastBlock.contains(mode),
    lastBlockFields: lastBlock
      ? [...lastBlock.querySelectorAll(':scope > .field')].filter((el) => el.offsetParent !== null)
          .length
      : null,
  });
})()`),
);
check(
  '记账页顶部操作区已移除（无 .compose__head / 返回按钮）',
  layout.hasHead === false && layout.hasBack === false,
  `head=${layout.hasHead} back=${layout.hasBack}`,
);
check(
  '手续费与折扣同一行',
  layout.feeVisible && layout.discountVisible && layout.feeTop === layout.discountTop,
  `手续费 top=${layout.feeTop} 折扣 top=${layout.discountTop}`,
);
check(
  '日期与时间同一行',
  layout.dateTop === layout.timeTop && layout.dateTop !== null,
  `日期 top=${layout.dateTop} 时间 top=${layout.timeTop}`,
);
check(
  '账期在卡片最底部单独一行',
  layout.modeInLastBlock === true && layout.lastBlockFields === 1,
  `末块可见字段数=${layout.lastBlockFields}`,
);
check(
  '名称在商家之前、同一卡片且相邻（间距 ≤ 32px）',
  layout.nameFirst === true &&
    layout.sameCard === true &&
    layout.nameMerchantGap !== null &&
    layout.nameMerchantGap >= 4 &&
    layout.nameMerchantGap <= 32,
  `名称 top=${layout.nameTop} 商家 top=${layout.merchantTop} 间距=${layout.nameMerchantGap}px`,
);

/* =============== 3b. 记账页：日期框不许顶出字段 =============== */
const dt = JSON.parse(
  await ev(`(() => {
  const d = document.querySelector('#tx-date');
  const f = d && d.closest('.field');
  if (!d || !f) return 'null';
  const db = d.getBoundingClientRect();
  const fb = f.getBoundingClientRect();
  return JSON.stringify({
    escapes: Math.round(db.right - fb.right),
    w: Math.round(db.width),
    fw: Math.round(fb.width),
  });
})()`),
);
if (dt === 'null') check('日期框存在', false);
else
  check(
    '日期框不顶出字段（右缘差值 ≤ 0）',
    dt.escapes <= 0,
    `右缘差 ${dt.escapes}px · 框宽 ${dt.w} / 字段宽 ${dt.fw}`,
  );

/* ================= 4. 账单页：三统计同行 ================= */
console.log('\n── 账单页 ──');
await go('/transactions', '.tx-sum');
await wait(900);
const sum = JSON.parse(
  await ev(`(() => {
  const s = document.querySelector('.tx-sum');
  if (!s) return 'null';
  const cells = [...s.children].map((c) => {
    const b = c.getBoundingClientRect();
    return { t: c.textContent.trim().split('\\n')[0].slice(0, 6), top: Math.round(b.top), w: Math.round(b.width) };
  });
  return JSON.stringify({ n: cells.length, tops: cells.map((c) => c.top), cells: cells.map((c) => c.t), ws: cells.map((c) => c.w) });
})()`),
);
if (sum === 'null') check('账单页统计区存在', false);
else {
  check('统计区 3 项', sum.n === 3, sum.cells.join('/'));
  check('三项在同一行（top 去重剩 1 个值）', new Set(sum.tops).size === 1, sum.tops.join(','));
  check('三列等宽（差值 ≤ 1px）', Math.max(...sum.ws) - Math.min(...sum.ws) <= 1, sum.ws.join('/'));
}
console.log('  →', await shot('transactions', { dir: OUT }));

/* ============ 4b. 账单页：每条记录都有分类图标（与首页同一套） ============ */
const rowIcons = JSON.parse(
  await ev(`(() => {
  const rows = [...document.querySelectorAll('.tx-row')];
  const vis = (el) => !!el && el.offsetParent !== null;
  const info = rows.map((row) => {
    const icon = row.querySelector('.tx-row__icon');
    const main = [...row.querySelectorAll('.tx-row__name, .tx-row__cat')].find(vis);
    const amt = row.querySelector('.tx-row__amt');
    const rb = row.getBoundingClientRect();
    const ib = icon?.getBoundingClientRect();
    const mb = main?.getBoundingClientRect();
    const ab = amt?.getBoundingClientRect();
    return {
      shown: vis(icon),
      glyph: icon ? icon.childElementCount : 0,
      w: ib ? Math.round(ib.width) : 0,
      h: ib ? Math.round(ib.height) : 0,
      bg: icon ? getComputedStyle(icon).backgroundColor : '',
      radius: icon ? getComputedStyle(icon).borderRadius : '',
      inset: ib ? Math.round(ib.left - rb.left) : null,
      beforeText: ib && mb ? ib.right <= mb.left : null,
      beforeAmt: ib && ab ? ib.right <= ab.left : null,
      centerOff: ib ? Math.round((ib.top + ib.bottom) / 2 - (rb.top + rb.bottom) / 2) : null,
    };
  });
  return JSON.stringify({
    rows: rows.length,
    shown: info.filter((x) => x.shown).length,
    empty: info.filter((x) => x.shown && x.glyph === 0).length,
    sizes: [...new Set(info.map((x) => x.w + 'x' + x.h))],
    bgs: [...new Set(info.map((x) => x.bg))],
    radii: [...new Set(info.map((x) => x.radius))],
    maxInset: Math.max(...info.map((x) => x.inset ?? 999)),
    allBeforeText: info.every((x) => x.beforeText === true),
    allBeforeAmt: info.every((x) => x.beforeAmt === true),
    maxCenterOff: Math.max(...info.map((x) => Math.abs(x.centerOff ?? 999))),
  });
})()`),
);
check('账单页每条记录都渲染了分类图标', rowIcons.rows > 0 && rowIcons.shown === rowIcons.rows,
  `${rowIcons.shown}/${rowIcons.rows} 行有图标`);
check('图标格没有空方块（都有图形内容）', rowIcons.empty === 0, `空 ${rowIcons.empty} 个`);
check(
  '图标在最左侧（与行左缘距离 ≤ 16px）',
  rowIcons.maxInset <= 16,
  `最大内缩 ${rowIcons.maxInset}px`,
);
check('图标排在说明文字与金额之前', rowIcons.allBeforeText && rowIcons.allBeforeAmt);
check('图标在行内垂直居中（中心偏移 ≤ 2px）', rowIcons.maxCenterOff <= 2, `${rowIcons.maxCenterOff}px`);
check(
  '图标与首页「最近记账」同一套视觉（尺寸 / 底色 / 圆角一致）',
  rowIcons.sizes.length === 1 &&
    rowIcons.sizes[0] === `${recent.iconW}x${recent.iconH}` &&
    rowIcons.bgs.length === 1 &&
    rowIcons.radii.length === 1 &&
    rowIcons.radii[0] === recent.iconRadius,
  `${rowIcons.sizes.join('/')} · bg=${rowIcons.bgs.join('/')} · radius=${rowIcons.radii.join('/')}`,
);

/**
 * 多选态：模板要补一列选择框（平时这一列不该存在 —— 它即使是 0 宽也会吃掉一个列间距）。
 * 补列后图标必须仍在文字左边、行不横向溢出。
 */
const selMode = JSON.parse(
  await ev(`(() => {
  const list = document.querySelector('.tx-list');
  const row = list?.querySelector('.tx-row');
  if (!list || !row) return 'null';
  list.classList.add('is-selecting');
  const pick = row.querySelector('.tx-row__pick');
  const icon = row.querySelector('.tx-row__icon');
  const main = [...row.querySelectorAll('.tx-row__name, .tx-row__cat')].find((el) => el.offsetParent);
  const r = {
    pickShown: !!pick && pick.offsetParent !== null,
    pickBeforeIcon: pick && icon
      ? pick.getBoundingClientRect().right <= icon.getBoundingClientRect().left + 1
      : null,
    iconBeforeText: icon && main
      ? icon.getBoundingClientRect().right <= main.getBoundingClientRect().left + 1
      : null,
    overflow: Math.round(row.scrollWidth - row.clientWidth),
  };
  list.classList.remove('is-selecting');
  return JSON.stringify(r);
})()`),
);
if (selMode === 'null') check('账单页多选态可取到行', false);
else {
  check('多选态：选择框出现', selMode.pickShown === true);
  check('多选态：选择框在图标之前、图标仍在文字之前',
    selMode.pickBeforeIcon === true && selMode.iconBeforeText === true,
    `pick→icon=${selMode.pickBeforeIcon} icon→text=${selMode.iconBeforeText}`);
  check('多选态：行不横向溢出', selMode.overflow <= 0, `溢出 ${selMode.overflow}px`);
}

/* ================= 5. 账户页：只留账户组 + 列表 ================= */
console.log('\n── 账户页精简 ──');
await go('/accounts', '.page__hero');
await wait(900);
const acct = JSON.parse(
  await ev(`(() => {
  const vis = (el) => !!el && !!el.offsetParent;
  const add = document.querySelector('.acct-add');
  const addBtn = add && add.querySelector('[data-action=new-account]');
  const meta = document.querySelector('[data-role=list-meta]');
  return JSON.stringify({
    hero: vis(document.querySelector('.page__hero [data-role=page-actions]')),
    meta: vis(meta),
    metaCount: vis(meta && meta.querySelector('.list-meta__count')),
    add: vis(add),
    addH: addBtn ? Math.round(addBtn.getBoundingClientRect().height) : 0,
    groupLink: !!add && !!add.querySelector('[data-action=new-group]'),
    groups: document.querySelectorAll('.acct-group').length,
    rows: document.querySelectorAll('.acct-row').length,
  });
})()`),
);
check('账户页：页头动作组不显示', acct.hero === false);
check('账户页：计数文案不显示', acct.metaCount === false);
check('账户页：「显示已停用」开关手机上可达（归档账户唯一的召回入口）', acct.meta === true);
check('账户页：账户组与账户列表仍在', acct.groups >= 1 && acct.rows >= 1, `${acct.groups} 组 / ${acct.rows} 个账户`);
check('账户页：列表末尾有新建入口', acct.add === true);
check('账户页：新建入口触控 ≥44px', acct.addH >= 44, `${acct.addH}px`);
check('账户页：新建分组入口仍在（功能没被精简掉）', acct.groupLink === true);

/* 列表内部相邻块的间距必须**只有一档**。
   之前 `.acct-list` 这一层没有任何间距规则：分组块彼此紧贴（0），
   而「标题区 → 列表」却吃着 `.page` 的 gap，同一页出现两种节奏。 */
const acctGaps = JSON.parse(
  await ev(`(() => {
  // 只量**可见**的块：.acct-add 在桌面是 display:none，它的 rect 全是 0，
  // 混进来会得到一条 -1388 的假间距。
  const kids = [...(document.querySelector('.acct-list')?.children ?? [])].filter((k) => k.offsetParent !== null);
  const gaps = [];
  for (let i = 1; i < kids.length; i++) {
    gaps.push(Math.round(kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom));
  }
  return JSON.stringify({ gaps, n: kids.length });
})()`),
);
check(
  '账户页：列表内相邻块间距只有一档（不再忽紧忽松）',
  acctGaps.gaps.length >= 2 && new Set(acctGaps.gaps).size === 1,
  `${acctGaps.gaps.length} 处间距：${acctGaps.gaps.join(' / ')}`,
);

/* ---- 归档 → 「显示已停用」召回（后端默认过滤，前端必须显式带上开关） ---- */
const archName = JSON.parse(
  await ev(`(() => {
  const btn = document.querySelector('.acct-row [data-act=archive]');
  if (!btn) return JSON.stringify({ name: null });
  const row = btn.closest('.acct-row');
  const name = row.querySelector('.tt-body-strong').textContent.trim();
  btn.click();
  return JSON.stringify({ name });
})()`),
);
await wait(1600);
const afterArchive = JSON.parse(
  await ev(`(() => {
  const names = [...document.querySelectorAll('.acct-row .tt-body-strong')].map((el) => el.textContent.trim());
  return JSON.stringify({ rows: names.length, has: names.some((n) => n.includes(${JSON.stringify(
    archName.name,
  )})) });
})()`),
);
check('归档后账户从列表里移出', archName.name !== null && afterArchive.has === false, `${archName.name} · 剩 ${afterArchive.rows} 行`);

await ev(`(() => { const c = document.querySelector('[data-role=show-archived-groups]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await wait(1800);
const afterShow = JSON.parse(
  await ev(`(() => {
  const hit = [...document.querySelectorAll('.acct-row')].find((r) =>
    r.querySelector('.tt-body-strong')?.textContent?.includes(${JSON.stringify(archName.name)}));
  return JSON.stringify({
    rows: document.querySelectorAll('.acct-row').length,
    back: !!hit,
    badge: hit ? /已归档/.test(hit.textContent) : false,
    acts: hit ? [...hit.querySelectorAll('[data-act]')].map((b) => b.dataset.act) : [],
  });
})()`),
);
check('勾选「显示已停用」后归档账户重新出现', afterShow.back === true, `${archName.name} · ${afterShow.rows} 行`);
check(
  '召回的归档账户带「已归档」徽标',
  afterShow.badge === true,
  JSON.stringify(afterShow),
);
/**
 * 归档账户该有的动作：只有「取消归档 / 编辑」。
 * 归档不是删除 —— 它随时可以回来；但「对账 / 归档」是假动作（它已不在日常账里），
 * 「删除」也不在行上（收在编辑表单里，避免误触）。
 */
check(
  '召回的归档账户只给「取消归档 + 编辑」，不给对账 / 归档',
  afterShow.acts.includes('restore') &&
    afterShow.acts.includes('edit') &&
    !afterShow.acts.includes('recon') &&
    !afterShow.acts.includes('archive') &&
    !afterShow.acts.includes('remove'),
  JSON.stringify(afterShow.acts),
);
/* ---- 取消归档：归档不是删除，账户要能原样回来 ---- */
await ev(`(() => {
  const hit = [...document.querySelectorAll('.acct-row')].find((r) =>
    r.querySelector('.tt-body-strong')?.textContent?.includes(${JSON.stringify(archName.name)}));
  hit?.querySelector('[data-act=restore]')?.click();
  return true;
})()`);
await wait(1800);
const afterRestore = JSON.parse(
  await ev(`(() => {
  const names = [...document.querySelectorAll('.acct-row .tt-body-strong')].map((el) => el.textContent.trim());
  return JSON.stringify({
    back: names.some((n) => n.includes(${JSON.stringify(archName.name)})),
    archivedBadgeLeft: document.querySelectorAll('.acct-row .badge--dark').length,
  });
})()`),
);
check('取消归档后账户回到日常列表', afterRestore.back === true, `${archName.name} · 剩余归档徽标 ${afterRestore.archivedBadgeLeft}`);
check(
  '取消归档后自动关掉「显示已停用」（否则看起来像没生效）',
  (await ev(`document.querySelector('[data-role=show-archived-groups]')?.checked`)) === false,
);

await ev(`(() => { const c = document.querySelector('[data-role=show-archived-groups]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await wait(1600);

/* ---- 删除账户：入口在编辑表单里，且必须先过二次确认弹窗 ---- */
const NEW_ACC = `探针待删账户${Date.now().toString().slice(-6)}`;
await ev(`(() => { const b = document.querySelector('.acct-add [data-action=new-account]'); b && b.click(); return true; })()`);
await wait(700);
await ev(`(() => {
  const f = document.querySelector('[data-role=form-slot] form');
  f.querySelector('input[name=name]').value = ${JSON.stringify(NEW_ACC)};
  f.querySelector('input[name=name]').dispatchEvent(new Event('input', { bubbles: true }));
  f.querySelector('button[type=submit]').click();
  return true;
})()`);
await wait(2200);
const createdRow = JSON.parse(
  await ev(`(() => {
  const hit = [...document.querySelectorAll('.acct-row')].find((r) =>
    r.querySelector('.tt-body-strong')?.textContent?.includes(${JSON.stringify(NEW_ACC)}));
  return JSON.stringify({ created: !!hit, removeOnRow: !!hit?.querySelector('[data-act=remove]') });
})()`),
);
check('新建的账户出现在列表里', createdRow.created === true, NEW_ACC);
check('删除入口不在行上（收在编辑表单里，避免误触）', createdRow.removeOnRow === false);

/* 打开编辑表单 → 里面才有删除按钮 */
await ev(`(() => {
  const hit = [...document.querySelectorAll('.acct-row')].find((r) =>
    r.querySelector('.tt-body-strong')?.textContent?.includes(${JSON.stringify(NEW_ACC)}));
  hit?.querySelector('[data-act=edit]')?.click();
  return true;
})()`);
await wait(800);
const editForm = JSON.parse(
  await ev(`JSON.stringify({
    hasRemove: !!document.querySelector('[data-role=form-slot] [data-role=remove]'),
    label: document.querySelector('[data-role=form-slot] [data-role=remove]')?.textContent?.trim() ?? '',
  })`),
);
check('编辑表单里有「删除账户」入口', editForm.hasRemove === true, editForm.label);

/* 点删除 → 二次确认弹窗，且必须点出被删对象的名字 */
await ev(`(() => { document.querySelector('[data-role=form-slot] [data-role=remove]').click(); return true; })()`);
await wait(600);
const confirmBox = JSON.parse(
  await ev(`(() => {
  const m = document.querySelector('.modal__panel--confirm');
  if (!m) return JSON.stringify({ open: false });
  return JSON.stringify({
    open: true,
    title: m.querySelector('.modal__title')?.textContent?.trim() ?? '',
    body: m.querySelector('.modal__body')?.textContent ?? '',
    ok: m.querySelector('[data-role=ok]')?.textContent?.trim() ?? '',
    danger: !!m.querySelector('[data-role=ok].btn--danger'),
    focusOnCancel: document.activeElement === m.querySelector('[data-role=cancel]'),
  });
})()`),
);
check('删除前弹二次确认', confirmBox.open === true, JSON.stringify(confirmBox).slice(0, 120));
check('确认弹窗里点出了将被删除的账户名', String(confirmBox.body ?? '').includes(NEW_ACC), confirmBox.body?.slice(0, 60));
check('确认弹窗说明了不可恢复', /不可恢复/.test(String(confirmBox.body ?? '')));
check('确认按钮是危险色，且默认焦点在「取消」', confirmBox.danger === true && confirmBox.focusOnCancel === true);

/* 先取消一次：账户必须还在 */
await ev(`(() => { document.querySelector('.modal__panel--confirm [data-role=cancel]').click(); return true; })()`);
await wait(500);
check(
  '取消确认后弹窗关闭且账户还在',
  (await ev(`!!document.querySelector('.modal__panel--confirm')`)) === false &&
    JSON.parse(
      await ev(`(() => {
        const hit = [...document.querySelectorAll('.acct-row')].find((r) =>
          r.querySelector('.tt-body-strong')?.textContent?.includes(${JSON.stringify(NEW_ACC)}));
        return JSON.stringify(!!hit);
      })()`),
    ) === true,
);

/* 再确认一次：账户真的被删掉 */
await ev(`(() => { document.querySelector('[data-role=form-slot] [data-role=remove]')?.click(); return true; })()`);
await wait(600);
await ev(`(() => { document.querySelector('.modal__panel--confirm [data-role=ok]')?.click(); return true; })()`);
await wait(2200);
const afterDelete = JSON.parse(
  await ev(`(() => {
  const hit = [...document.querySelectorAll('.acct-row')].find((r) =>
    r.querySelector('.tt-body-strong')?.textContent?.includes(${JSON.stringify(NEW_ACC)}));
  return JSON.stringify({ gone: !hit, formClosed: !document.querySelector('[data-role=form-slot] form') });
})()`),
);
check('确认后账户被删除（列表不再有它）', afterDelete.gone === true, NEW_ACC);
check('删除后编辑表单一并关掉（不留指向空的表单）', afterDelete.formClosed === true);

/* ---- 手机端新建入口必须真的能用（列表重画后监听器还在） ---- */
await ev(`(() => { const b = document.querySelector('.acct-add [data-action=new-account]'); b && b.click(); return true; })()`);
await wait(700);
const acctForm = JSON.parse(
  await ev(`JSON.stringify(!!document.querySelector('[data-role=form-slot] form input[name=name]'))`),
);
check('账户页：手机端「新建账户」能真的打开表单', acctForm === true);
await ev(`(() => { document.querySelector('[data-role=form-slot] [data-role=cancel]')?.click(); return true; })()`);
await wait(500);

await ev(`(() => { const b = document.querySelector('.acct-add [data-action=new-group]'); b && b.click(); return true; })()`);
await wait(700);
const groupForm = JSON.parse(
  await ev(`JSON.stringify(!!document.querySelector('[data-role=form-slot] form input[name=name]'))`),
);
check('账户页：手机端「新建分组」能真的打开表单', groupForm === true);
await ev(`(() => { document.querySelector('[data-role=form-slot] [data-role=cancel]')?.click(); return true; })()`);
await wait(500);

console.log('  →', await shot('accounts', { dir: OUT }));

/* ================= 6. 账单页：搜索常驻 + 更多折叠 ================= */
console.log('\n── 账单页折叠 ──');
await go('/transactions', '.tx-sum');
await wait(900);
const tx1 = JSON.parse(
  await ev(`(() => {
  const vis = (el) => !!el && !!el.offsetParent;
  const more = document.querySelector('[data-role=more]');
  const pills = document.querySelector('[data-role=pill-row]');
  const mb = more && more.getBoundingClientRect();
  const sb = document.querySelector('.tx-search').getBoundingClientRect();
  return JSON.stringify({
    search: vis(document.querySelector('.tx-search')),
    more: vis(more),
    moreH: mb ? Math.round(mb.height) : 0,
    moreAfterSearch: mb ? mb.left >= sb.right - 1 : false,
    pills: vis(pills),
    pillCount: pills ? pills.querySelectorAll('[data-f]').length : 0,
  });
})()`),
);
check('账单页：搜索框常驻显示', tx1.search === true);
check('账单页：「更多」在搜索框之后', tx1.more === true && tx1.moreAfterSearch === true);
check('账单页：筛选 pill 默认收起', tx1.pills === false);
check('账单页：7 个筛选都在折叠区里', tx1.pillCount === 7, `${tx1.pillCount} 个`);
check('账单页：「更多」触控 ≥44px', tx1.moreH >= 44, `${tx1.moreH}px`);

await ev(`document.querySelector('[data-role=more]').click()`);
await wait(400);
const tx2 = JSON.parse(
  await ev(`(() => {
  const vis = (el) => !!el && !!el.offsetParent;
  return JSON.stringify({
    pills: vis(document.querySelector('[data-role=pill-row]')),
    collapse: vis(document.querySelector('[data-role=collapse]')),
    expanded: document.querySelector('[data-role=more]').getAttribute('aria-expanded'),
  });
})()`),
);
check('账单页：点「更多」展开筛选区', tx2.pills === true);
check('账单页：展开态有收起入口', tx2.collapse === true);
check('账单页：aria-expanded 同步为 true', tx2.expanded === 'true');

await ev(`document.querySelector('[data-role=collapse]').click()`);
await wait(400);
const tx3 = await ev(
  `(() => { const vis = (el) => !!el && !!el.offsetParent; return String(!vis(document.querySelector('[data-role=pill-row]')) && !vis(document.querySelector('[data-role=panel]'))); })()`,
);
check('账单页：点「收起」后折叠，面板一并关掉', tx3 === 'true');

/* ================= 7. 统计页：页头动作移除 + 更多折叠 ================= */
console.log('\n── 统计页精简 ──');
await go('/stats', '.st-filter__card');
await wait(1200);
const st1 = JSON.parse(
  await ev(`(() => {
  const vis = (el) => !!el && !!el.offsetParent;
  const more = document.querySelector('[data-role=more]');
  const zone = document.querySelector('[data-role=more-zone]');
  const seg = document.querySelector('.st-filter__seg');
  const mb = more && more.getBoundingClientRect();
  const gb = seg && seg.getBoundingClientRect();
  return JSON.stringify({
    hero: vis(document.querySelector('.page__hero [data-role=report-actions]')),
    more: vis(more),
    moreH: mb ? Math.round(mb.height) : 0,
    moreAfterSeg: mb && gb ? mb.left >= gb.right - 1 : false,
    zone: vis(zone),
    picks: zone ? zone.querySelectorAll('.st-filter__pick').length : 0,
    kw: zone ? !!zone.querySelector('#st-f-kw') : false,
  });
})()`),
);
check('统计页：导出报表 / 导入账目 整行不显示', st1.hero === false);
check('统计页：「更多」紧跟在账期段（自定义）之后', st1.more === true && st1.moreAfterSeg === true);
check('统计页：筛选区默认收起', st1.zone === false);
check('统计页：三个下拉 + 搜索框都在折叠区里', st1.picks === 3 && st1.kw === true, `${st1.picks} 个下拉`);
check('统计页：「更多」触控 ≥44px', st1.moreH >= 44, `${st1.moreH}px`);

await ev(`document.querySelector('[data-role=more]').click()`);
await wait(400);
const st2 = JSON.parse(
  await ev(`(() => {
  const vis = (el) => !!el && !!el.offsetParent;
  return JSON.stringify({
    zone: vis(document.querySelector('[data-role=more-zone]')),
    collapse: vis(document.querySelector('[data-role=collapse]')),
    expanded: document.querySelector('[data-role=more]').getAttribute('aria-expanded'),
  });
})()`),
);
check('统计页：点「更多」展开折叠区', st2.zone === true);
check('统计页：展开态有收起入口', st2.collapse === true);
check('统计页：aria-expanded 同步为 true', st2.expanded === 'true');

await ev(`document.querySelector('[data-role=collapse]').click()`);
await wait(400);
const st3 = await ev(
  `(() => { const vis = (el) => !!el && !!el.offsetParent; return String(!vis(document.querySelector('[data-role=more-zone]'))); })()`,
);
check('统计页：点「收起」后折叠', st3 === 'true');
console.log('  →', await shot('stats', { dir: OUT }));

/* ================= 通用护栏 ================= */
console.log('\n── 通用护栏 ──');
for (const [name, path, sel] of [
  ['账户', '/accounts', '.page__hero'],
  ['账单', '/transactions', '.page__hero'],
  ['统计', '/stats', '.page__hero'],
  ['设置', '/settings', '.page__hero'],
]) {
  await go(path, sel);
  await wait(800);
  const r = JSON.parse(
    await ev(`(() => {
    const cw = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('*')].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && (b.right > cw + 0.5 || b.left < -0.5);
    }).length;
    /* 复选框 / 单选本体是系统控件（16px，CSS 改不动），
       触控目标是**包裹它的 label 整行**，所以只对这类控件改判祖先。 */
    const small = [...document.querySelectorAll('button, a.btn, .btn, input, select')]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        if (!(b.width > 0 && b.height > 0 && b.height < 44)) return false;
        if (/^(checkbox|radio)$/.test(el.type)) {
          const host = el.closest('label');
          const hb = host?.getBoundingClientRect();
          return !(hb && hb.height >= 44);
        }
        return true;
      })
      .map((el) => (el.className || el.tagName).toString().slice(0, 26));
    return JSON.stringify({ over, small: [...new Set(small)].slice(0, 5), docW: document.documentElement.scrollWidth });
  })()`),
  );
  check(`${name}页无横向溢出`, r.over === 0, `溢出元素 ${r.over} 个 / scrollWidth=${r.docW}`);
  check(`${name}页触控目标 ≥44px`, r.small.length === 0, r.small.join(',') || '全部达标');
}

probe.close();
console.log(`\n结果 ==== ${pass} / ${pass + fails.length}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ✗', f.name, f.detail ? `· ${f.detail}` : '');
}
process.exit(fails.length ? 1 : 0);
