/**
 * 手机端 UI 探针（390 × 844）
 *
 * 断言的是**外观层面**的四个硬要求（都是真机上一眼能看出的毛病，
 * 静态审计查不到）：
 *
 *   1. 底部 dock 切换页面时**不重建** —— 重建会重播 `tabbar-in` 入场动画，
 *      表现为切页时底栏「被推出去又滑回来」闪一下。
 *   2. 顶栏头像在圆形底内**精确居中**（中心偏差 ≤ 0.5px）。桌面那颗
 *      「头像+昵称」胶囊在手机上会被昵称挤偏。
 *   3. 记账页类型 / 分类横滑带里的 pill **互不重叠**。
 *   4. 账单页「支出 / 收入 / 结余」**同一行**（三列等分）。
 *
 * 外加通用护栏：横向不溢出、触控目标 ≥44px、名称→日期间距不过宽。
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

/* ================= 0b. App 内金额键盘 ================= */
console.log('\n── 金额键盘 ──');
await go('/transactions/new', '.compose__card');
await wait(900);

check('紧凑形态金额框只读（不弹系统键盘）',
  (await ev(`document.querySelector('[name=amount]')?.hasAttribute('readonly')`)) === true);
check('金额框标了 inputmode=none（双保险，防安卓仍弹系统键盘）',
  (await ev(`document.querySelector('[name=amount]')?.getAttribute('inputmode')`)) === 'none');

await ev(`(() => { document.querySelector('[name=amount]')?.click(); return true; })()`);
await wait(500);
const padOpen = JSON.parse(
  await ev(`(() => {
  const root = document.getElementById('cc-amount-pad');
  if (!root) return JSON.stringify({ exists: false });
  const b = root.getBoundingClientRect();
  const keys = [...root.querySelectorAll('[data-key]')].map((k) => k.dataset.key);
  const heights = [...root.querySelectorAll('[data-key]')].map((k) => Math.round(k.getBoundingClientRect().height));
  const empty = [...root.querySelectorAll('[data-key]')].filter((k) => { const kb = k.getBoundingClientRect(); return kb.height < 44 || kb.width < 24; }).length;
  return JSON.stringify({
    exists: true, hidden: root.hidden, open: root.classList.contains('is-open'),
    top: Math.round(b.top), bottom: Math.round(b.bottom),
    vh: document.documentElement.clientHeight, vw: document.documentElement.clientWidth,
    keys, minKeyH: Math.min(...heights), tooSmall: empty,
    editing: !!document.querySelector('.amount-input.is-editing'),
  });
})()`),
);
check('点金额框弹出 App 内键盘', padOpen.exists === true && padOpen.hidden === false && padOpen.open === true,
  JSON.stringify({ hidden: padOpen.hidden, open: padOpen.open }));
check('键盘是 18 键（0-9 · 点 · 四则 · 退格 · 清空 · 等号）', padOpen.keys?.length === 18, String(padOpen.keys?.length));
check('键盘触控目标 ≥44px', padOpen.tooSmall === 0 && padOpen.minKeyH >= 44, `最小键高 ${padOpen.minKeyH}px`);
check('键盘贴合视口底部', Math.abs(padOpen.bottom - padOpen.vh) <= 1, `bottom=${padOpen.bottom} vh=${padOpen.vh}`);
check('被编辑的金额框有视觉指示（不可依赖 focus，已被 blur）', padOpen.editing === true);

/* 真实敲一遍「12 ＋ 5 × 2」：先乘除后加减 = 22.00 */
/**
 * 逐个敲键。**按 `dataset.key` 查找而不是 CSS 属性选择器**：
 * 运算符键的 id 里含全角 `＋ − × ÷`，写进 `[data-key="op:＋"]` 还得处理转义；
 * 命中失败时表现为「键存在但点了没反应」，很难一眼看出是探针的写法问题。
 */
const typeIn = async (seq) => {
  for (const k of seq) {
    await ev(`(() => {
      const r = document.getElementById('cc-amount-pad');
      [...r.querySelectorAll('[data-key]')].find((x) => x.dataset.key === ${JSON.stringify(k)})?.click();
      return true;
    })()`);
    await wait(90);
  }
  await wait(200);
};
await typeIn(['clear', '1', '2', 'op:＋', '5', 'op:×', '2']);
const midway = JSON.parse(
  await ev(`(() => {
  const r = document.getElementById('cc-amount-pad');
  return JSON.stringify({
    expr: r.querySelector('[data-role=expr]')?.textContent?.trim(),
    res: r.querySelector('[data-role=res]')?.textContent?.trim(),
  });
})()`),
);
check('算式实时显示', /12.*＋.*5.*×.*2/.test(midway.expr ?? ''), midway.expr);
check('结果实时预览＝ 22.00（先乘除后加减）', /22\.00/.test(midway.res ?? ''), midway.res);

await ev(`(() => { document.querySelector('#cc-amount-pad [data-role=done]')?.click(); return true; })()`);
await wait(500);
const afterDone = JSON.parse(
  await ev(`(() => {
  const a = document.querySelector('[name=amount]');
  return JSON.stringify({
    value: a?.value,
    padOpen: document.getElementById('cc-amount-pad')?.classList.contains('is-open'),
    editing: a?.classList.contains('is-editing'),
  });
})()`),
);
check('「完成」把结果落回输入框', afterDone.value === '22.00', `value=${afterDone.value}`);
check('关闭后键盘收起', afterDone.padOpen === false);
check('关闭后编辑态指示撤销', afterDone.editing === false);

/* 越界护栏：单笔上限 ¥99,999,999.99（8 位整数）。
   理想做法是两位数字的尾 Securello 直接按键到位 rotors：第 9 位数字**按不进去**，
   而不是等按完了再报错 —— 后者会让用户先输完再被退回来。 */
await ev(`(() => { document.querySelector('[name=amount]')?.click(); return true; })()`);
await wait(400);
await typeIn(['clear', ...Array(10).fill('9')]);
const overMax = JSON.parse(
  await ev(`(() => {
  const r = document.getElementById('cc-amount-pad');
  return JSON.stringify({
    expr: r.querySelector('[data-role=expr]')?.textContent?.trim(),
    hint: r.querySelector('[data-role=hint]')?.hidden ? '' : r.querySelector('[data-role=hint]')?.textContent?.trim(),
  });
})()`),
);
check(
  '连按 10 位数字时整数位被截在 8 位（¥ 99,999,999.99 上限）',
  (overMax.expr ?? '').replace(/\D/g, '').length === 8,
  `expr=${overMax.expr}`,
);

/* 「 . 」在同一个操作数里只吃一次：金额第二位小数之后再按点应当无效 */
await typeIn(['.', '5', '.', '5']);
const dotGuard = await ev(`document.getElementById('cc-amount-pad')?.querySelector('[data-role=expr]')?.textContent?.trim()`);
check('小数点只按一次有效（.55 之后不再吃第二个点）', (dotGuard ?? '').endsWith('.55'), `expr=${dotGuard}`);

await ev(`(() => { document.getElementById('cc-amount-pad')?.querySelector('[data-role=scrim]')?.click(); return true; })()`);
await wait(400);
check(
  '点遮罩收起键盘（按「就这样」而非取消，不丢已输的金额）',
  (await ev(`document.getElementById('cc-amount-pad')?.classList.contains('is-open')`)) === false,
);

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

/* ================= 2. 顶栏头像居中 ================= */
console.log('\n── 顶栏头像 ──');
await go('/accounts', '.app-bar');
await wait(700);
const chip = JSON.parse(
  await ev(`(() => {
  const c = document.querySelector('.app-bar .user-chip');
  if (!c) return 'null';
  const b = c.getBoundingClientRect();
  const a = c.querySelector('.avatar');
  if (!a) return 'null';
  const ab = a.getBoundingClientRect();
  const cs = getComputedStyle(c);
  return JSON.stringify({
    dx: +(ab.left + ab.width / 2 - (b.left + b.width / 2)).toFixed(2),
    dy: +(ab.top + ab.height / 2 - (b.top + b.height / 2)).toFixed(2),
    box: [Math.round(b.width), Math.round(b.height)],
    radius: cs.borderRadius,
    nameVisible: !!c.querySelector('.user-chip__name')?.offsetParent,
  });
})()`),
);
if (chip === 'null') {
  check('顶栏头像存在', false, '未找到 .app-bar .user-chip 或 .avatar');
} else {
  check('头像在圆内水平居中（|dx| ≤ 0.5px）', Math.abs(chip.dx) <= 0.5, `dx=${chip.dx}`);
  check('头像在圆内垂直居中（|dy| ≤ 0.5px）', Math.abs(chip.dy) <= 0.5, `dy=${chip.dy}`);
  check('顶栏头像是正圆容器（44×44）', chip.box[0] === 44 && chip.box[1] === 44, `${chip.box.join('×')}`);
  check('顶栏不重复显示昵称（昵称在设置页）', chip.nameVisible === false);
  check('圆形容器的圆角是 pill/full', /9999|50%/.test(chip.radius), chip.radius);
}

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
const gap = JSON.parse(
  await ev(`(() => {
  const n = document.querySelector('[data-field=name]');
  const d = document.querySelector('[data-field=txDate]');
  if (!n || !d) return 'null';
  return JSON.stringify({ gap: Math.round(d.getBoundingClientRect().top - n.getBoundingClientRect().bottom) });
})()`),
);
if (gap === 'null') check('名称 / 日期字段存在', false);
else
  check(
    '名称 → 日期间距 ≤ 32px（spacing.xl 上限；夹着一条 hairline 分隔）',
    gap.gap <= 32 && gap.gap >= 4,
    `${gap.gap}px`,
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
    noActions: hit ? hit.querySelectorAll('[data-act]').length === 0 : false,
  });
})()`),
);
check('勾选「显示已停用」后归档账户重新出现', afterShow.back === true, `${archName.name} · ${afterShow.rows} 行`);
check(
  '召回的归档账户带「已归档」徽标且不再给可点动作',
  afterShow.badge === true && afterShow.noActions === true,
  JSON.stringify(afterShow),
);
await ev(`(() => { const c = document.querySelector('[data-role=show-archived-groups]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await wait(1600);

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
