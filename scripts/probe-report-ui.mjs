/**
 * 报表页（11 模块）CDP 探针。
 *
 * 纪律来自 scripts/lib/cdp.mjs：先 wipe 再导航；等**本次动作产生的信号**；
 * 断言真实渲染结果（几何 / 文本 / 元素数），不断言内部实现。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'report');

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, errors, netFails } = probe;
const c = checker();
const { check } = c;

/* ══════════ 数据基座 ══════════ */
await wipe();
const H = {
  'Content-Type': 'application/json',
  'X-Forwarded-For': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
};
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: `rp${Date.now().toString(36)}`.slice(0, 32),
      nickname: '报表',
      password: 'ReportProbe!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };
const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const groups = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json()).data;
const grp = groups.find((x) => x.id.endsWith('#grp_bank')) ?? groups[0];
const acc = (
  await (
    await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
      method: 'POST', headers: POST,
      body: JSON.stringify({ name: '招商银行', type: 'debit_card', groupId: grp.id, openingBalance: '50000.00' }),
    })
  ).json()
).data;
const ec = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories?recordType=expense`}`, { headers: AH })).json()).data;
const pc = ec.find((p) => (p.children ?? []).length >= 2) ?? ec[0];
const c0 = pc.children[0];
const c1 = pc.children[1];
const ic = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories?recordType=income`}`, { headers: AH })).json()).data;
const inc = (ic.find((p) => (p.children ?? []).length) ?? ic[0]).children[0];
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

for (let i = 0; i < 24; i += 1) {
  await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
    method: 'POST', headers: POST,
    body: JSON.stringify({
      accountId: acc.id, txDate: day(i % 20), fee: '0', discount: '0',
      recordType: 'expense', categoryId: (i % 3 === 0 ? c1 : c0).id,
      name: `消费${i}`, amount: `${30 + ((i * 17) % 400)}.00`,
      counterparty: i % 2 ? '楼下食堂' : '超市',
    }),
  });
}
for (const [d, a] of [[5, '18000.00'], [12, '900.00']]) {
  await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
    method: 'POST', headers: POST,
    body: JSON.stringify({ accountId: acc.id, txDate: day(d), fee: '0', discount: '0', recordType: 'income', categoryId: inc.id, name: '工资', amount: a }),
  });
}

const auth = authInjector({ token: TOKEN });
const q = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const titles = () => ev(`Array.from(document.querySelectorAll('.section .section__head h2')).map(x=>x.textContent.trim())`);

/* ══════════ 1. 全局筛选栏 ══════════ */
console.log('\n── 模块 1 · 全局筛选栏 ──');
await open('/stats', { wait: '.kpi-card', theme: 'light', arm: auth.arm });
await new Promise((r) => setTimeout(r, 1800));

/**
 * 筛选栏是**一条工具条**，不是一张表单。
 *
 * 旧断言逐个检查 8 个 .field__label 的名字 —— 那是「表单式筛选栏」的形态。
 * 工具条形态下控件靠 placeholder 自述（「全部来源」「全部类型」本身就是说明），
 * 再挂一个 label 是重复。所以断言改为：控件在、自述文本在、**没有**逐个挂 label。
 */
const fb = JSON.parse(
  await ev(`JSON.stringify((() => {
    const card = document.querySelector('.st-filter__card');
    const bar = document.querySelector('.st-filter__bar');
    if (!card || !bar) return null;
    const kw = document.querySelector('#st-f-kw');
    // 三个下拉 + 搜索框已移到工具条下方的常驻筛选面板（与 .st-filter__bar 同级），
    // 故从 .st-filter__card 范围内查找；工具条高度断言仍针对 .st-filter__bar。
    return {
      hasSource: !!card.querySelector('#st-f-source'),
      hasType: !!card.querySelector('#st-f-type'),
      hasCat: !!card.querySelector('#st-f-cat'),
      hasKw: !!kw,
      labelCount: bar.querySelectorAll('.field__label').length,
      catGroups: card.querySelectorAll('#st-f-cat optgroup').length,
      sourceHint: ((card.querySelector('#st-f-source option') || {}).textContent || '').trim(),
      catHint: ((card.querySelector('#st-f-cat option') || {}).textContent || '').trim(),
      height: Math.round(bar.getBoundingClientRect().height),
      kwRadius: kw ? getComputedStyle(kw).borderTopLeftRadius : 0,
      actsRight: Math.round(bar.querySelector('.st-filter__acts').getBoundingClientRect().right),
      barRight: Math.round(bar.getBoundingClientRect().right),
    };
  })())`),
);
check(
  '筛选工具条含 来源 / 类型 / 分类 三个下拉 + 搜索框',
  Boolean(fb && fb.hasSource && fb.hasType && fb.hasCat && fb.hasKw),
  JSON.stringify(fb),
);
check(
  '控件靠自述文本说清用途（不再逐个挂 label）',
  Boolean(fb) && fb.labelCount === 0 && fb.sourceHint === '全部来源' && fb.catHint === '全部分类',
  `label=${fb?.labelCount} 来源=${fb?.sourceHint} 分类=${fb?.catHint}`,
);
check('一级 + 二级合并成一个分类下拉（optgroup 分组）', Number(fb?.catGroups) > 0, `${fb?.catGroups} 组`);
check('筛选栏只有一行（不占主视觉高度）', Number(fb?.height) <= 60, `${fb?.height}px`);
check(
  '搜索框是胶囊形（00-DESIGN search-input 与 CTA 同一套语法）',
  parseInt(String(fb?.kwRadius), 10) >= 100,
  String(fb?.kwRadius),
);
const quicks = await ev(`Array.from(document.querySelectorAll('[data-quick]')).map(x=>x.textContent.trim())`);
check('快捷账期四选（本周/本月/本年/近12月）',
  quicks.length === 4 && quicks.includes('本周') && quicks.includes('近12月'), JSON.stringify(quicks));

/**
 * 动作按钮在**标题行右侧**（需求 1），写法与账户页一致：
 * `.page__hero > .row.row--between` 的右半格。
 *
 * 断言的是三件事，缺一条都会让「标题行右对齐」这个承诺落空：
 *   ① 两个入口都在 hero 里；
 *   ② 与标题**同一水平线**（垂直中心差值 ≤ 一行）；
 *   ③ 右边缘与 hero 右边缘对齐（不是靠左堆着）。
 */
const heroActs = JSON.parse(
  await ev(`JSON.stringify((() => {
    const hero = document.querySelector('.page__hero');
    if (!hero) return null;
    const h1 = hero.querySelector('h1');
    const exportBtn = hero.querySelector('[data-role=export]');
    const importLink = Array.from(hero.querySelectorAll('a.btn')).find((a) => a.textContent.includes('导入账目'));
    if (!exportBtn || !importLink) return { missing: true };
    const hb = hero.getBoundingClientRect();
    const eb = exportBtn.getBoundingClientRect();
    const ib = importLink.getBoundingClientRect();
    const h1b = h1.getBoundingClientRect();
    return {
      heroRight: Math.round(hb.right),
      actsRight: Math.round(Math.max(eb.right, ib.right)),
      sameRow: Math.abs((eb.top + eb.bottom) / 2 - (h1b.top + h1b.bottom) / 2) <= 24,
      importHref: importLink.getAttribute('href'),
      inBar: !!document.querySelector('.st-filter__bar [data-role=export]'),
      gap: Math.round(ib.left - eb.right),
    };
  })())`),
);
check('标题行右侧同时有「导出报表」与「导入账目」', heroActs?.missing !== true, JSON.stringify(heroActs));
check('动作按钮与标题同行', heroActs?.sameRow === true, JSON.stringify(heroActs));
check('动作按钮右对齐到内容右边缘', Number(heroActs?.heroRight) - Number(heroActs?.actsRight) <= 4,
  `距右边缘 ${Number(heroActs?.heroRight) - Number(heroActs?.actsRight)}px`);
check('「导入账目」指向 /import', heroActs?.importHref === '/import', String(heroActs?.importHref));
check('动作按钮已从筛选栏移出（不再重复出现）', heroActs?.inBar === false, String(heroActs?.inBar));
check('两个按钮之间留 8px 间距（.row 的既有间距）', Number(heroActs?.gap) === 8, `${heroActs?.gap}px`);

/**
 * 条件芯片：常显 + 可逐个摘掉。
 *
 * 必须常显：账期本身就是筛选条件，用户截图给客服时对方看到的是
 * 一个「看起来没筛选」的页面，而数据其实是某个特定月份的。
 * 必须可摘：写成一句话时想去掉一条得回到对应下拉去改；芯片点一下就摘掉。
 */
check('条件芯片常显（账期本身就是筛选）', Number(await q('.st-filter-sum .st-chip')) >= 1);
await ev(`(() => { const s = document.querySelector('#st-f-type'); s.value = 'expense'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 1200));
check('选类型后出现可摘的条件芯片', Number(await q('[data-clear=type]')) === 1, `${await q('[data-clear=type]')} 个`);
await ev(`document.querySelector('[data-clear=type]').click()`);
await new Promise((r) => setTimeout(r, 1200));
check('点芯片的 × 摘掉那一条条件', Number(await q('[data-clear=type]')) === 0);

/** 「自定义」要把当前区间带进去 —— 用户点它是想微调，不是想从两个空框开始填 */
await ev(`document.querySelector('[data-role=custom]').click()`);
await new Promise((r) => setTimeout(r, 1200));
check('点「自定义」露出日期区间行', (await ev(`!document.querySelector('[data-role=range-row]').hidden`)) === true);
check(
  '切进自定义时带上当前区间（不是两个空框）',
  /^\d{4}-\d{2}-\d{2}$/.test(String(await ev(`document.querySelector('#st-f-from').value`))),
  String(await ev(`document.querySelector('#st-f-from').value`)),
);
await ev(`document.querySelector('[data-quick=month]').click()`);
await new Promise((r) => setTimeout(r, 1200));
check('切回快捷账期后日期行收起', (await ev(`document.querySelector('[data-role=range-row]').hidden`)) === true);

/* ══════════ 2. 账期切换器 ══════════ */
console.log('\n── 模块 2 · 账期切换器 ──');
/**
 * 账期前后翻页**并进了筛选工具条**，原来那条「独占一行、居中摆放」的切换器
 * 已删除（它只有三个元素却占满一整行，而它要表达的信息 — 当前是哪个账期 —
 * 条件芯片已经写明）。
 *
 * 断言覆盖两件事：功能仍在（翻页真的改变账期），
 * 以及**那一条独立行确实没了**（否则删除只做了一半，页面会同时出现两处账期控件）。
 */
check('翻页控件在筛选工具条内',
  (await ev(`!!document.querySelector('.st-filter__bar [data-role=prev]')`)) === true &&
  (await ev(`!!document.querySelector('.st-filter__bar [data-role=next]')`)) === true);
check('原「账期切换器」独立行已删除', (await ev(`!!document.querySelector('.st-period')`)) === false);
check('账期标签也在工具条内',
  (await ev(`!!document.querySelector('.st-filter__bar [data-role=period-label]')`)) === true);
const p0 = await ev(`(document.querySelector('[data-role=period-label]')||{}).textContent`);
check('账期标签形如 YYYY-MM', /^\d{4}-\d{2}$/.test(String(p0).trim()), String(p0));
await ev(`document.querySelector('[data-role=prev]').click()`);
await new Promise((r) => setTimeout(r, 1200));
const p1 = await ev(`(document.querySelector('[data-role=period-label]')||{}).textContent`);
check('点上一账期真的变了', String(p1).trim() !== String(p0).trim(), `${p0} → ${p1}`);
await ev(`document.querySelector('[data-role=next]').click()`);
await new Promise((r) => setTimeout(r, 1200));

/* ══════════ 3. KPI 卡 ══════════ */
console.log('\n── 模块 3 · KPI 概览卡 ──');
check('4 张 KPI 卡', Number(await q('.kpi-card')) === 4);
const kLabels = await ev(`Array.from(document.querySelectorAll('.kpi-card__label')).map(x=>x.textContent.trim())`);
check('卡面为总收入 / 净支出 / 笔数 / 期末现金',
  kLabels.includes('总收入') && kLabels.includes('净支出') && kLabels.includes('期末现金'), JSON.stringify(kLabels));
/**
 * 「每张卡都可点」不等于「每张都跳账单列表」。
 * 期末现金 = 各账户余额合计，它的**明细**在账户页（每张卡的余额构成），
 * 跳到流水列表反而答非所问。所以断言是「每张都有去处且去处有意义」。
 */
const kHrefs = await ev(`Array.from(document.querySelectorAll('.kpi-card')).map(a=>a.getAttribute('href'))`);
check(
  '每张卡都可点且有意义的去处（收支→流水，现金→账户）',
  kHrefs.length === 4 &&
    kHrefs.slice(0, 3).every((h) => String(h).startsWith('/transactions')) &&
    kHrefs[3] === '/accounts',
  JSON.stringify(kHrefs),
);
const subs = await ev(`Array.from(document.querySelectorAll('.kpi-card__sub')).map(x=>x.textContent.trim())`);
check('净支出卡给出结余率', subs.some((s) => s.includes('结余率')), JSON.stringify(subs));

/* ══════════ 4. 周期对比表 ══════════ */
console.log('\n── 模块 4 · 周期对比 ──');
/**
 * 对比表只跨 4 栅格（约 318px），6 列平铺会让金额互相盖住 ——
 * 所以形态是「主行：本周期 + 环比，副行：上期 / 去年同期 / 同比」。
 * 断言检查的是**信息齐全**（5 个口径都在卡里出现），而不是列数 ——
 * 列数是实现细节，口径齐不齐才是这张卡的承诺。
 */
const cmpText = String(await ev(`document.querySelector('[data-role=compare]').textContent`));
check(
  '对比表给出 本周期 / 上期 / 环比 / 去年同期 / 同比 五个口径',
  ['本周期', '上期', '环比', '去年同期', '同比'].every((k) => cmpText.includes(k)),
  cmpText.slice(0, 90),
);
check('对比表 3 条指标（支出/收入/结余）', Number(await q('[data-role=compare] .cmp-item')) === 3);
/**
 * ⚠️ 金额**不得**互相盖住。
 *
 * 断言的是同一个 `.cmp-row` 里相邻两个金额格的边界不重叠 ——
 * 这是「6 列挤在 4 栅格里」那个 bug 的直接表征：
 * 文字会画到隔壁格子上，看起来像「¥4,102.001,310.00」这样一个错数字。
 */
const cmpOverlap = await ev(`(() => {
  let bad = 0;
  document.querySelectorAll('[data-role=compare] .cmp-row').forEach((row) => {
    const cells = Array.from(row.querySelectorAll('.cmp-row__num'));
    for (let i = 1; i < cells.length; i += 1) {
      if (cells[i - 1].getBoundingClientRect().right > cells[i].getBoundingClientRect().left + 1) bad += 1;
    }
  });
  return bad;
})()`);
check('对比表金额格互不重叠', Number(cmpOverlap) === 0, `${cmpOverlap} 处重叠`);

/**
 * ⚠️ 语义色纪律：差异列**不得**用 `is-pos` / `is-neg`。
 *
 * 「支出比上期多 ¥2,792」染绿等于说「多花了钱，很好」—— 那是一句假话，
 * 而且看起来很像信息。差异的方向用箭头表达，好坏留给用户判断。
 * 这条断言存在的意义是：**将来有人「顺手」给差异列加个颜色就会红**。
 */
const cmpColors = await ev(
  `Array.from(document.querySelectorAll('[data-role=compare] .cmp-row:not(.cmp-row--head) .cmp-row__num'))
     .filter((x) => x.classList.contains('is-pos') || x.classList.contains('is-neg')).length`,
);
check('差异列用中性色 + 箭头（不给收支语义色）', Number(cmpColors) === 0, `${cmpColors} 处带语义色`);
const cmpArrows = await ev(
  `Array.from(document.querySelectorAll('[data-role=compare] .cmp-row:not(.cmp-row--head) .cmp-row__num'))
     .filter((x) => /[↑↓→]/.test(x.textContent)).length`,
);
check('差异列给出方向箭头', Number(cmpArrows) > 0, `${cmpArrows} 处`);

/* ══════════ 5~11 ══════════ */
console.log('\n── 模块 5~11 · 图表 ──');
const t = await titles();
for (const [name, ok] of [
  ['近 12 个月收支趋势', t.some((x) => x.includes('近 12 个月收支趋势'))],
  ['支出构成', t.includes('支出构成')],
  ['分类排行', t.includes('分类排行')],
  ['每日支出趋势', t.includes('每日支出趋势')],
  ['星期消费分布', t.includes('星期消费分布')],
  ['成员消费', t.includes('成员消费')],
  ['净资产趋势', t.includes('净资产趋势')],
  ['账户消费一览', t.includes('账户消费一览')],
]) check(`模块「${name}」存在`, ok === true);

check('12 月趋势画满 12 根柱组（含 0 值月，保证轴等距）', Number(await q('[data-role=m-trend12] .st-bargroup')) === 12,
  `${await q('[data-role=m-trend12] .st-bargroup')} 根`);
check('环形图有扇区', Number(await q('[data-role=m-donut] .st-arc')) > 0);
check('排行榜有数据行', Number(await q('[data-role=m-rank] .rank-row')) > 1);
check('每日趋势有数据点', Number(await q('[data-role=m-daily] .st-point')) > 1);
check('星期分布 7 根柱（含无支出日）', Number(await q('[data-role=m-weekday] .st-bar')) === 7);
check('成员饼图有扇区', Number(await q('[data-role=m-member] .st-slice')) > 0);

/**
 * 星期分布**不再有自己的范围切换器**（需求 4）。
 *
 * 它原来带「本月 / 近3月 / 全年」三个按钮，只影响这一张图 ——
 * 于是会出现「顶部筛了 10 月、这张图却是近 3 月」这种页面内部互相矛盾的状态，
 * 而用户不容易发现，只会觉得数字不对。一张图的口径必须与所在页面一致。
 */
check('星期分布已移除「本月/近3月/全年」切换器',
  Number(await q('[data-role=m-weekday] [data-wd]')) === 0 &&
    Number(await q('[data-role=m-weekday] .chip')) === 0,
  `按钮 ${await q('[data-role=m-weekday] .chip')} 个`);
check('星期分布口径跟随全局账期',
  String(await ev(`document.querySelector('[data-role=m-weekday] .section__head').textContent`)).includes('当前账期'),
  String(await ev(`document.querySelector('[data-role=m-weekday] .section__head').textContent`)).trim());

const accountRows = JSON.parse(
  await ev(`JSON.stringify(Array.from(document.querySelectorAll('[data-role=m-accounts] tbody tr')).slice(0, 2).map((tr) =>
    Array.from(tr.children).map((td) => td.textContent.trim())))`),
);
check('账户表有行', accountRows.length > 0, `${accountRows.length} 行`);
/**
 * ⚠️ 账户「类型」必须是**中文**（需求 8）。
 *
 * 后端给的是枚举（debit_card / third_party …），直接铺到界面上就是英文，
 * 而这一列的读者是「想知道这张卡是什么」的用户 —— 他看到 debit_card 只能去猜。
 * 断言直接查「有没有 ASCII 标识符残留」，而不是查某个具体词 ——
 * 不然换一个账户类型就漏过去了。
 */
check(
  '账户表「类型」列是中文（不是 debit_card 这类枚举）',
  accountRows.every((r) => !/^[a-z][a-z_]*$/.test(String(r[1] ?? '').trim())),
  JSON.stringify(accountRows.map((r) => r[1])),
);

/* ══════════ 饼图规范与图表提示 ══════════ */
console.log('\n── 饼图规范 · 图例靠右 / 合计 / Tooltip ──');

/** 图例一律在图的**右侧**（需求 2）：图例左边缘必须在图区右边缘之后 */
const legendGeo = JSON.parse(
  await ev(`JSON.stringify(['m-donut', 'm-member'].map((role) => {
    const card = document.querySelector('[data-role=' + role + ']');
    const plot = card?.querySelector('.chart-figure__plot');
    const lg = card?.querySelector('.chart-legend');
    if (!plot || !lg) return { role, missing: true };
    const p = plot.getBoundingClientRect();
    const l = lg.getBoundingClientRect();
    return {
      role,
      rightOfPlot: l.left >= p.right - 2,
      sameRow: Math.abs((l.top + l.bottom) / 2 - (p.top + p.bottom) / 2) <= 40,
      hasTotal: !!lg.querySelector('.chart-legend__total-val'),
      totalText: (lg.querySelector('.chart-legend__total-val') || {}).textContent || '',
      items: lg.querySelectorAll('.chart-legend__item').length,
      dots: lg.querySelectorAll('.chart-legend__dot').length,
    };
  }))`),
);
for (const g of legendGeo) {
  check(`${g.role} 图例在图的右侧`, g.rightOfPlot === true && g.sameRow === true, JSON.stringify(g));
  check(`${g.role} 图例区给出总金额`, g.hasTotal === true && String(g.totalText).length > 0, String(g.totalText));
  check(`${g.role} 图例条目带色点`, Number(g.dots) > 0 && Number(g.items) > 0, `${g.items} 条`);
}

/**
 * 扇区配色：相邻扇区必须区分得开。
 *
 * 判据是**色差**：把两个 stroke/fill 解析成数值后比 RGB 距离。
 * 早先用灰度阶梯时最后两档在白卡上几乎同色（距离 < 20），
 * 扇区看起来像「缺了一块」—— 断言直接卡这条线。
 */
const sliceColors = await ev(
  `Array.from(document.querySelectorAll('[data-role=m-donut] .st-arc')).map((el) => getComputedStyle(el).stroke)`,
);
const dupColor = new Set(sliceColors.map(String)).size !== sliceColors.length;
check('扇区配色互不重复', sliceColors.length <= 1 || dupColor === false, JSON.stringify(sliceColors.slice(0, 4)));

/** 悬停扇区 → 出提示，且提示含名称 / 金额 / 占比（需求 2 / 3） */
await ev(`(() => {
  const el = document.querySelector('[data-role=m-donut] .st-arc');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
})()`);
await new Promise((r) => setTimeout(r, 300));
const tipText = String(await ev(`(document.querySelector('.chart-tip') || {}).textContent || ''`));
const tipShown = (await ev(`!!document.querySelector('.chart-tip') && !document.querySelector('.chart-tip').hidden`)) === true;
check('悬停扇区出现 Tooltip', tipShown, tipText.slice(0, 60));
check('Tooltip 含名称 / 金额 / 占比',
  /¥/.test(tipText) && /占比/.test(tipText), tipText.slice(0, 60));
c.shot(await probe.shot('report-tooltip-1440', { dir: OUT, focus: '[data-role=m-donut]' }));

/** 移到图表外 → 提示收起（不能挂在屏幕上不走） */
await ev(`document.querySelector('[data-role=m-trend12]').dispatchEvent(
  new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5 }))`);
await new Promise((r) => setTimeout(r, 200));
check('移出图表后 Tooltip 收起',
  (await ev(`!document.querySelector('.chart-tip') || document.querySelector('.chart-tip').hidden`)) === true);

/** 折线图的**数据点**也要有提示（需求 3：所有图表统一支持） */
const tipKinds = JSON.parse(
  await ev(`JSON.stringify({
    point: document.querySelectorAll('[data-role=m-daily] .st-point[data-tip]').length,
    bargroup: document.querySelectorAll('[data-role=m-trend12] .st-bargroup[data-tip]').length,
    bar: document.querySelectorAll('[data-role=m-weekday] .st-bar[data-tip]').length,
    slice: document.querySelectorAll('[data-role=m-member] .st-slice[data-tip]').length,
    area: document.querySelectorAll('[data-role=m-networth] svg rect[data-tip]').length,
  })`),
);
check('折线图数据点带提示数据', Number(tipKinds.point) > 0, `${tipKinds.point} 点`);
check('柱状图柱体带提示数据', Number(tipKinds.bargroup) > 0 && Number(tipKinds.bar) > 0,
  `趋势 ${tipKinds.bargroup} 组 · 星期 ${tipKinds.bar} 柱`);
check('饼图扇区带提示数据', Number(tipKinds.slice) > 0, `${tipKinds.slice} 扇`);
/**
 * 空态引导：**每个数据区块都必须在无数据时自己解释清楚**。
 * 新账本没有净资产快照，所以这块要么有图、要么有空态文案 ——
 * 不允许「两者都没有」（那是一块纯白，用户以为页面坏了）。
 */
/**
 * ⚠️ 面积图**至少两个非零时点**才有意义。
 *
 * 后端在没有快照时会补 12 个空桶，所以「数组非空」和「有非零值」都不足以
 * 证明「能画图」——只满足后者时画出来是一块空白坐标轴 + 一个孤零零的
 * 月份标签，用户会以为数据丢了。
 *
 * 所以这条断言的是**排他性**：要么真的画出了图，要么明确走了空态；
 * 不允许「有 svg 但里面什么都没有」这种中间态。
 */
const nwSvg = Number(await q('[data-role=m-networth] svg'));
const nwPoly = Number(await q('[data-role=m-networth] svg polygon'));
const nwEmpty = Number(await q('[data-role=m-networth] .chart-empty'));
check('净资产趋势：要么出图，要么给空态引导', (nwSvg > 0 && nwPoly > 0) || nwEmpty === 1,
  `svg=${nwSvg} 面积块=${nwPoly} 空态=${nwEmpty}`);
/**
 * ⚠️ 命中区只在**真的出图**时才该有：没有快照时走空态文案，
 * 此时 svg 根本不存在，`rect[data-tip]` 为 0 是**正确**的。
 * 早先这条断言无条件要求 > 0，于是新账本（空态）必然判红 ——
 * 它真正要卡的是「有图时有没有命中区」，所以按是否出图分流。
 */
check('面积图给出命中区（否则无处悬停）',
  nwSvg === 0 ? nwEmpty === 1 : Number(tipKinds.area) > 0,
  nwSvg === 0 ? '空态（无图，无需命中区）' : `${tipKinds.area} 列`);
/**
 * 空态必须说清「为什么空」与「怎么才会有」。
 * 只写「暂无数据」等于把用户留在原地 —— 他不知道是自己操作错了、
 * 还是功能坏了、还是需要等一等。
 */
check(
  '空态文案给出原因与出路（不是一句「暂无数据」）',
  nwEmpty === 0 ||
    /快照/.test(String(await ev(`document.querySelector('[data-role=m-networth] .chart-empty').textContent`))),
  String(await ev(`(document.querySelector('[data-role=m-networth] .chart-empty')||{}).textContent || '（有图）'`)).slice(0, 60),
);
/**
 * 金额**不得折行**：「¥50,000.00」折成「¥」+「50,000.00」两行后，
 * 一张表里的数字高高低低，根本没法逐行比较。
 */
/**
 * ⚠️ 用 **Range 实测文字占了几行**，不能拿元素高度去比 line-height。
 *
 * 表格单元格的高度由**同一行里最高的那个格**决定 ——
 * 账户名是「名字 + 类型」两行，旁边的金额格会被一起撑高。
 * 按高度判断会把「被撑高的单行金额」全判成折行（第一版就是这么误报的），
 * 而 Range 取到的是文字自己的矩形，行数骗不了人。
 */
const moneyWrap = String(
  await ev(`JSON.stringify((() => {
    try {
      const bad = [];
      document.querySelectorAll('.report-grid .tbl td.tnum, .report-grid .cmp-row__num, .report-grid .rank-row__num').forEach((el) => {
        if (!el.firstChild || el.firstChild.nodeType !== 3) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
        if (tops.size > 1) bad.push(el.textContent.trim().slice(0, 20) + ' x' + tops.size);
      });
      return bad;
    } catch (err) { return ['ERR ' + (err && err.message)]; }
  })())`),
);
check('表内金额不折行', JSON.parse(moneyWrap || '[]').length === 0, moneyWrap.slice(0, 90));
/**
 * 图表不得横向溢出卡片（报表页明确禁止横向滚动）。
 * 卡的右边界要能被图表内容包住。
 */
const chartOverflow = await ev(`(() => {
  let bad = 0;
  document.querySelectorAll('.report-grid .card').forEach((card) => {
    const cr = card.getBoundingClientRect();
    card.querySelectorAll('svg, table, .rank-table').forEach((el) => {
      if (el.getBoundingClientRect().right > cr.right + 1) bad += 1;
    });
  });
  return bad;
})()`);
check('卡内图表 / 表格不溢出卡片边界', Number(chartOverflow) === 0, `${chartOverflow} 处溢出`);

/* ══════════ Bento 栅格 ══════════ */
console.log('\n── Bento 栅格 ──');
/**
 * 栅格几何：跨列数由「(自身宽 + 列间距) ÷ (容器宽 + 列间距) ÷ 12」反推。
 * 直接读 grid-column 更省事，但那样测的是**声明值**而不是**渲染结果** ——
 * 一旦 span 类被别处覆盖，读声明值的断言仍然全绿，而页面已经错了。
 */
const geo = JSON.parse(
  await ev(`JSON.stringify((() => {
    const g = document.querySelector('.report-grid');
    const cs = getComputedStyle(g);
    const gw = g.getBoundingClientRect().width;
    const unit = (gw + 8) / 12;
    const items = Array.from(g.querySelectorAll(':scope > .section, .st-kpi-row > .kpi-card'));
    return {
      cols: cs.gridTemplateColumns.split(' ').length,
      colGap: cs.columnGap,
      rowGap: cs.rowGap,
      page: Math.round(document.querySelector('.page').getBoundingClientRect().width),
      items: items.map((el) => {
        const r = el.getBoundingClientRect();
        const card = el.matches('.kpi-card') ? el : el.querySelector('.card');
        const cr = card.getBoundingClientRect();
        const ccs = getComputedStyle(card);
        return {
          role: el.dataset.role || 'kpi',
          span: Math.round((r.width + 8) / unit),
          top: Math.round(cr.top),
          h: Math.round(cr.height),
          radius: ccs.borderTopLeftRadius,
          pad: ccs.paddingTop,
          border: ccs.borderTopWidth,
          shadow: ccs.boxShadow,
        };
      }),
    };
  })())`),
);
check('桌面 12 栅格', Number(geo?.cols) === 12, `${geo?.cols} 列`);
check('列间距 8px', geo?.colGap === '8px', String(geo?.colGap));
check('卡片间距 20px', geo?.rowGap === '20px', String(geo?.rowGap));
check('页面外边距 32px（内容 1440 锁宽由外壳吸收）', Number(geo?.page) > 900, `${geo?.page}px`);

/**
 * 按行检查：每排的跨列之和必须 = 12，且同排卡片顶边与高度严格一致。
 * 「和 = 12」不是形式主义 —— 少了就会在行尾留一条空槽，
 * 多了就会把下一项挤到下一行，两种情况在视觉上都只是一点空隙，看不出是错的。
 */
/**
 * 六排（需求 5：分类排行与账户消费各占一整行，不再 8+4 挤在一排）。
 * 两张多列表格挤在 4 栅格里时字段会被压到折行、金额互相盖住 ——
 * 整宽之后列才均分得开。
 */
const rows = [[3, 3, 3, 3], [4, 8], [4, 4, 4], [8, 4], [12], [12]];
let cursor = 0;
const rowNames = ['KPI 通栏', '对比+趋势', '构成/每日/星期', '净资产+成员', '分类排行', '账户一览'];
for (let i = 0; i < rows.length; i += 1) {
  const want = rows[i];
  const take = geo.items.slice(cursor, cursor + want.length);
  cursor += want.length;
  const got = take.map((x) => x.span);
  check(
    `第 ${i + 1} 排（${rowNames[i]}）跨列 = ${want.join('+')}`,
    got.length === want.length && got.every((s, k) => s === want[k]),
    `实际 ${got.join('+')}`,
  );
  const tops = new Set(take.map((x) => x.top));
  const hs = new Set(take.map((x) => x.h));
  check(`第 ${i + 1} 排卡片顶边对齐`, tops.size === 1, `top=${[...tops].join(',')}`);
  check(`第 ${i + 1} 排卡片等高`, hs.size === 1, `h=${[...hs].join(',')}`);
}

/** 卡片样式全站统一：圆角 12px · 1px 细边框 · 内边距 24px · 无重投影 */
const cardStyles = new Set(geo.items.map((x) => `${x.radius}|${x.border}|${x.pad}`));
check(
  '所有卡片圆角 12px + 1px 边框 + 24px 内边距',
  cardStyles.size === 1 && [...cardStyles][0] === '12px|1px|24px',
  [...cardStyles].join(' / '),
);
check(
  '卡片无重投影（00-DESIGN：阴影只给产品影像）',
  geo.items.every((x) => x.shadow === 'none'),
  geo.items.find((x) => x.shadow !== 'none')?.shadow ?? 'none',
);

/* ══════════ 交互：点击下钻 ══════════ */
console.log('\n── 交互 · 点击下钻 ──');
const firstKpi = await ev(`document.querySelector('.kpi-card').getAttribute('href')`);
check('KPI 卡带类型筛选', String(firstKpi).includes('recordType='), String(firstKpi));
await ev(`document.querySelector('[data-role=m-rank] .rank-row.is-clickable').click()`);
await new Promise((r) => setTimeout(r, 1300));
check('点排行榜跳到该分类账单', String(await ev(`location.pathname + location.search`)).includes('categoryId='),
  String(await ev(`location.pathname + location.search`)));

await open('/stats', { wait: '.kpi-card', theme: 'light', arm: auth.arm });
await new Promise((r) => setTimeout(r, 1500));
c.shot(await probe.shot('report-1440', { dir: OUT, focus: '.st-filter' }));
c.shot(await probe.shot('report-charts-1440', { dir: OUT, focus: '[data-role=m-donut]' }));
/** 第五排：排行榜（8 列）+ 账户表（4 列）—— 账户表是 4 列版，必须在这里核一遍 */
c.shot(await probe.shot('report-tables-1440', { dir: OUT, focus: '[data-role=m-accounts]' }));

/* ══════════ 移动端 ══════════ */
console.log('\n── 移动端 ──');
await open('/stats', { wait: '.kpi-card', theme: 'light', width: 390, height: 900, arm: auth.arm });
await new Promise((r) => setTimeout(r, 1500));
const ov = await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth');
check('390px 无横向滚动', Number(ov) <= 1, `${ov}px`);
const gridCols = await ev(`getComputedStyle(document.querySelector('.report-grid')).gridTemplateColumns.split(' ').length`);
check('窄屏报表栅格单列堆叠', Number(gridCols) === 1, `${gridCols} 列`);
/**
 * 窄屏必须**顺序不变**地单列堆叠。
 *
 * 直接读 DOM 顺序而不是视觉位置：视觉位置在单列下必然自上而下，测不出问题；
 * 而 DOM 顺序错了的话，Tab 键的焦点顺序与读屏的朗读顺序都会跟着错 ——
 * 「视觉顺序与焦点顺序不一致」是很难被发现但影响很大的可达性缺陷。
 */
const domOrder = await ev(`Array.from(document.querySelectorAll('.report-grid > .section, .st-kpi-row > .kpi-card'))
  .map(x => x.dataset.role || 'kpi')`);
const wantOrder = [
  'kpi', 'kpi', 'kpi', 'kpi',
  'compare', 'm-trend12',
  'm-donut', 'm-daily', 'm-weekday',
  'm-networth', 'm-member',
  'm-rank', 'm-accounts',
];

/**
 * ⚠️ `rank-row` 的**轨道数必须与「可见单元格」数相等**（需求 6 的隐性地雷）。
 *
 * 少一条轨道时最后那个单元格会静默换到下一行：表头与表体错位、
 * 「小计」整列掉下去，而页面不报任何错（这个坑本轮已经踩过一次）。
 *
 * 注意是**可见**单元格数：≤640px 时代码按设计隐藏「笔数/占比/小计」三列
 * （8 格 → 5 格、5 轨），那是布局意图，不是错位。早先这条断言拿 8 去比 5，
 * 在移动端必然判红 —— 它真正要卡的是「可见格 ≠ 轨道数」，而隐藏那三格
 * 之后表头与表体同批隐藏，两者的可见数必须一致。
 */
const rankShape = JSON.parse(
  await ev(`JSON.stringify((() => {
    const row = document.querySelector('[data-role=m-rank] .rank-row:not(.rank-row--head)');
    const head = document.querySelector('[data-role=m-rank] .rank-row--head');
    const visible = (el) => Array.from(el.children).filter((c) => getComputedStyle(c).display !== 'none').length;
    return {
      tracks: getComputedStyle(row).gridTemplateColumns.split(' ').length,
      headCells: head.children.length,
      bodyCells: row.children.length,
      headVisible: visible(head),
      bodyVisible: visible(row),
      tabs: row.querySelectorAll('.rank-row__bar .rank-row__fill').length,
    };
  })())`),
);
check('排行榜轨道数 = 可见单元格数（表头与表体一致）',
  rankShape.tracks === rankShape.bodyVisible && rankShape.headVisible === rankShape.bodyVisible,
  JSON.stringify(rankShape));
check('排行榜有占比条', Number(rankShape.tabs) > 0, `${rankShape.tabs} 条`);

/** 账户表在整宽卡片里按**百分比**均分，不再用固定像素列宽 */
const acctCols = await ev(`(() => {
  const t = document.querySelector('[data-role=m-accounts] .tbl--acct');
  if (!t) return null;
  const cs = getComputedStyle(t);
  const cells = Array.from(t.querySelectorAll('tbody tr:first-child td')).map((td) =>
    Math.round(td.getBoundingClientRect().width));
  return JSON.stringify({ layout: cs.tableLayout, cells });
})()`);
const acctInfo = JSON.parse(String(acctCols));
check('账户表用固定布局 + 百分比列宽（宽度变化时列一起变）',
  acctInfo?.layout === 'fixed' && Number(acctInfo.cells[0]) > Number(acctInfo.cells[1]),
  String(acctCols));
check('账户表 5 列（账户 / 类型 / 期初 / 期末 / 结余）',
  Array.isArray(acctInfo?.cells) && acctInfo.cells.length === 5, String(acctCols));
check('窄屏单列且顺序不变', JSON.stringify(domOrder) === JSON.stringify(wantOrder), JSON.stringify(domOrder));
const mRowGap = await ev(`getComputedStyle(document.querySelector('.report-grid')).rowGap`);
check('窄屏卡片间距收紧到 12px', mRowGap === '12px', String(mRowGap));
c.shot(await probe.shot('report-mobile-390', { dir: OUT, focus: '.st-filter' }));
/** 窄屏的**账户表**：表头隐藏、改成 2 列卡片行 —— 这张最容易在窄屏被漏掉 */
c.shot(await probe.shot('report-mobile-table-390', { dir: OUT, focus: '[data-role=m-accounts]' }));

check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));

probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
