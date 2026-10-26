/**
 * 任务 1~5 的 CDP 探针（侧栏分组 / 往来结清 / 统计筛选 / 概览跳转 / 三合一表单）。
 *
 * 纪律全部来自 scripts/lib/cdp.mjs：
 *   · 先 wipe 再导航
 *   · 等**本次动作产生的信号**，不只等「页面上本来就有」的元素
 *   · 断言实际渲染后的几何与文本，不断言内部实现
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'task5');

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, errors, netFails } = probe;
const c = checker();
const { check } = c;

/* ══════════ 数据基座 ══════════ */
await wipe();
const H = {
  'Content-Type': 'application/json',
  'X-Forwarded-For': `10.61.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
};
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: `t5${Date.now().toString(36)}`.slice(0, 32),
      nickname: '任务5',
      password: 'Task5Probe!2026',
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
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ name: '招行卡', type: 'debit_card', groupId: grp.id, openingBalance: '50000.00' }),
    })
  ).json()
).data;
const ec = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=expense`, { headers: AH })).json()).data;
const parent = ec.find((p) => (p.children ?? []).length >= 2) ?? ec[0];
const ic = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=income`, { headers: AH })).json()).data;
const incCat = (ic.find((p) => (p.children ?? []).length) ?? ic[0]).children[0];
const rc = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=receivable`, { headers: AH })).json()).data;
const rcat = (rc.find((p) => (p.children ?? []).length) ?? rc[0]).children[0];
const today = new Date().toISOString().slice(0, 10);
const tx = async (b) =>
  (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
        method: 'POST',
        headers: POST,
        body: JSON.stringify({ accountId: acc.id, txDate: today, fee: '0', discount: '0', ...b }),
      })
    ).json()
  ).data;

for (let i = 0; i < 6; i += 1) {
  await tx({
    recordType: 'expense',
    categoryId: parent.children[i % 2].id,
    name: `餐饮${i}`,
    amount: `${80 + i * 37}.00`,
    counterparty: '楼下食堂',
  });
}
await tx({ recordType: 'income', categoryId: incCat.id, name: '工资', amount: '18000.00', counterparty: '公司' });
const origin = await tx({
  recordType: 'receivable',
  direction: 'decrease',
  categoryId: rcat.id,
  counterparty: '张三',
  name: '借出',
  amount: '800.00',
});
await tx({
  recordType: 'receivable',
  direction: 'increase',
  categoryId: rcat.id,
  counterparty: '张三',
  name: '收回部分',
  amount: '300.00',
  settles: [{ transactionId: origin.id, amount: '300.00' }],
});

const auth = authInjector({ token: TOKEN });

/* ══════════ 任务 1：侧栏分组 ══════════ */
console.log('\n── 任务 1 · 侧栏 ──');
await open('/stats', { wait: '.kpi-card', theme: 'light', arm: auth.arm });

const groups2 = await ev(`Array.from(document.querySelectorAll('.sidenav__group-head')).map((x) => x.textContent.trim())`);
check('侧栏是四个语义分组 + 账号', groups2.length === 5 && groups2[0] === '总览', JSON.stringify(groups2));

const items = await ev(`Array.from(document.querySelectorAll('.sidenav__item')).map((x) => x.getAttribute('href'))`);
check('13 个业务项 + 2 个账号项', items.length === 15, `${items.length} 项`);

// 每个导航项都必须有图标（原来是「部分标题缺少图标」）
const noIcon = await ev(
  `Array.from(document.querySelectorAll('.sidenav__item')).filter((a) => !a.querySelector('svg')).length`,
);
check('无缺图标的导航项', Number(noIcon) === 0, `${noIcon} 项缺图标`);

// 分组标题不可点（给了 cursor:pointer 就是在骗人）
const titleClickable = await ev(
  `Array.from(document.querySelectorAll('.sidenav__group-head')).some((p) => getComputedStyle(p).cursor === 'pointer')`,
);
check('分组标题不给 pointer 光标', titleClickable === false);

// 选中态与收起态用同一套（同一个类 + aria-current）
const activeStyle = await ev(`(() => {
  const a = document.querySelector('.sidenav__item[aria-current="page"]');
  if (!a) return 'none';
  const cs = getComputedStyle(a);
  return cs.backgroundColor + '|' + cs.color;
})()`);
check('当前页有选中态底色', activeStyle !== 'none' && !String(activeStyle).includes('rgba(0, 0, 0, 0)'), String(activeStyle));
const marker = await ev(
  `getComputedStyle(document.querySelector('.sidenav__item[aria-current="page"]'), '::before').width`,
);
check('选中态有左侧标记条', marker === '2px', marker);

/* ══════════ 任务 3：统计筛选 + 图表跳转 ══════════ */
console.log('\n── 任务 3 · 统计筛选与图表跳转 ──');
/**
 * 筛选栏是**一条工具条**：三个自述式下拉 + 一个搜索框，不逐个挂 label。
 *
 * 旧断言逐个检查 8 个 .field__label 的名字 —— 那是「表单式筛选栏」的形态，
 * 已经整个换成工具条形态了。控件靠 placeholder 自述（「全部来源」本身就是说明），
 * 再挂一个 label 是重复。所以断言改为：控件在、自述在、**没有**逐个挂 label。
 */
const fb5 = JSON.parse(
  await ev(`JSON.stringify((() => {
    const bar = document.querySelector('.st-filter__bar');
    if (!bar) return null;
    return {
      hasSource: !!bar.querySelector('#st-f-source'),
      hasType: !!bar.querySelector('#st-f-type'),
      hasCat: !!bar.querySelector('#st-f-cat'),
      hasKw: !!bar.querySelector('#st-f-kw'),
      labelCount: bar.querySelectorAll('.field__label').length,
      catGroups: bar.querySelectorAll('#st-f-cat optgroup').length,
      height: Math.round(bar.getBoundingClientRect().height),
    };
  })())`),
);
check(
  '筛选工具条含 来源 / 类型 / 分类 三个下拉 + 搜索框',
  Boolean(fb5 && fb5.hasSource && fb5.hasType && fb5.hasCat && fb5.hasKw),
  JSON.stringify(fb5),
);
check('控件靠自述文本说清用途（不逐个挂 label）', Number(fb5?.labelCount) === 0, `${fb5?.labelCount} 个 label`);
check('一级 + 二级合并成一个分类下拉（optgroup 分组）', Number(fb5?.catGroups) > 0, `${fb5?.catGroups} 组`);
check('筛选栏只有一行（不占主视觉高度）', Number(fb5?.height) <= 60, `${fb5?.height}px`);

/**
 * 条件摘要**常显**（不再是无筛选时隐藏）。
 *
 * 旧设计认为「没筛选就不该显示」是减少噪声；但实际问题是：
 * 账期本身就是筛选，用户截图给客服时对方看到一个「看起来没筛选」的页面，
 * 而数据其实是某个特定月份的。所以摘要必须**始终**写明当前账期。
 */
const sum0 = String(await ev(`(document.querySelector('.st-filter-sum')||{}).textContent || ''`));
check('条件摘要常显且写明当前账期', /账期\s*\d{4}-\d{2}/.test(sum0), sum0.trim());

// 选了类型后摘要必须出现（筛了却看不出来 = 没筛）
await ev(`(() => { const s = document.querySelector('#st-f-type'); s.value='expense'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 800));
const summary = await ev(`(document.querySelector('.st-filter-sum')||{}).textContent || ''`);
check('筛选后显示条件摘要', String(summary).includes('类型'), String(summary).trim());

/**
 * 图表元素可点。
 *
 * ⚠️ 报表页改版后「图例」换成了**排行榜表格**（.rank-row），
 *    环形图扇区仍在（.st-arc）。所以断言按新结构取。
 *    「按账户行」仍在账户一览表里，但不再带 data-account ——
 *    账户表的下钻入口是账户页，这里改断言账户表有行即可。
 */
const arcs = await ev(`document.querySelectorAll('[data-role=m-donut] .st-arc.is-clickable').length`);
const rankRows = await ev(`document.querySelectorAll('[data-role=m-rank] .rank-row.is-clickable').length`);
const accRows = await ev(`document.querySelectorAll('[data-role=m-accounts] tbody tr').length`);
check('占比图扇形可点', Number(arcs) > 0, `${arcs} 个`);
check('排行榜行可点', Number(rankRows) > 0, `${rankRows} 行`);
check('账户一览表有行', Number(accRows) > 0, `${accRows} 行`);

// 点排行榜 → 跳到带筛选的账单列表
await ev(`document.querySelector('[data-role=m-rank] .rank-row.is-clickable').click()`);
await new Promise((r) => setTimeout(r, 1400));
const url = await ev(`location.pathname + location.search`);
check('点占比跳到账单列表且带分类筛选', String(url).includes('/transactions?') && String(url).includes('categoryId='), String(url));
const chips = await ev(`Array.from(document.querySelectorAll('.tx-pill.is-on')).map((x) => x.textContent.trim())`);
check('账单页筛选条显示已生效条件', chips.some((x) => x.includes('分类')), JSON.stringify(chips));
c.shot(await probe.shot('stats-filters-1440', { dir: OUT, focus: '.st-filter' }));
c.shot(await probe.shot('transactions-drill-1440', { dir: OUT, focus: '.tx-list' }));

/* ══════════ 任务 4：概览点击账户 ══════════ */
console.log('\n── 任务 4 · 概览账户跳转 ──');
await open('/', { wait: '.acct-row', theme: 'light', arm: auth.arm });
const href = await ev(`(document.querySelector('.acct-row--link')||{}).getAttribute?.('href') || ''`);
check('账户行跳该账户的账单列表', String(href).startsWith('/transactions?accountId='), String(href));
const hasGo = await ev(`!!document.querySelector('.acct-row--link .acct-row__go')`);
check('账户行有去向指示（不是死链）', hasGo === true);

/**
 * 首页不渲染空分组：连标题、卡片容器、合计一起不出。
 * 「该分组下暂无账户」这种占位块在首页是纯噪音 —— 它占掉一屏里最贵的位置，
 * 回答的却是一个用户没问的问题。管理空分组是账户页（管理视角）的活儿。
 */
const ovGroups = JSON.parse(
  await ev(`(() => {
  const gs = [...document.querySelectorAll('.acct-group')].map((g) => ({
    name: (g.querySelector('.acct-group__name')?.textContent ?? '').trim(),
    rows: g.querySelectorAll('.acct-row').length,
    hasHead: !!g.querySelector('.acct-group__head'),
  }));
  return JSON.stringify({ n: gs.length, gs });
})()`),
);
check('首页渲染了分组（种子数据有账户）', ovGroups.n >= 1, `${ovGroups.n} 组`);
check(
  '首页不渲染空分组（每个分组块都至少有一个账户行）',
  ovGroups.n >= 1 && ovGroups.gs.every((g) => g.rows >= 1),
  ovGroups.gs.map((g) => `${g.name}:${g.rows}`).join(' / '),
);
check(
  '首页没有「暂无账户」的占位卡片',
  (await ev(`Array.from(document.querySelectorAll('.empty')).some((e) => /暂无账户/.test(e.textContent))`)) === false,
);
await ev(`document.querySelector('.acct-row--link').click()`);
await new Promise((r) => setTimeout(r, 1300));
const url2 = await ev(`location.pathname + location.search`);
check('点击后进入该账户账单列表', String(url2).includes('accountId='), String(url2));
const chip2 = await ev(`Array.from(document.querySelectorAll('.tx-pill.is-on')).map((x) => x.textContent.trim())`);
check('筛选条显示账户名', chip2.some((x) => x.includes('招行卡')), JSON.stringify(chip2));
c.shot(await probe.shot('overview-account-link-1440', { dir: OUT, focus: '.acct-row--link' }));

/* ══════════ 任务 2：结清预填与部分结清 ══════════ */
console.log('\n── 任务 2 · 往来结清 ──');
await open('/debts', { wait: '.debt-card', theme: 'light', arm: auth.arm });
check(
  '待收 = ¥500（800 − 300）',
  String(await ev(`(document.querySelector('.debt-card__value')||{}).textContent`)).includes('500.00'),
);
await ev(`document.querySelector('.debt-row__hist').open = true`);
await new Promise((r) => setTimeout(r, 250));
const hist = await ev(
  `Array.from(document.querySelectorAll('.debt-row__hist-item')).map((x) => x.textContent.trim())`,
);
check('结清记录金额正确（¥300）', hist.some((x) => x.includes('300.00')), JSON.stringify(hist));
c.shot(await probe.shot('debts-1440', { dir: OUT, focus: '.debt-list' }));

// 点结清 → 表单预填类型/分类/账户/对象/名称
await ev(`document.querySelector('[data-act=settle]').click()`);
await new Promise((r) => setTimeout(r, 1600));
const pre = await ev(`(() => ({
  type: (document.querySelector('[data-role=pick-label]')||{}).textContent || '',
  amount: (document.querySelector('[name=amount]')||{}).value || '',
  counterparty: (document.querySelector('[name=counterparty]')||{}).value || '',
  settle: (document.querySelector('[data-role=settle-select]')||{}).value || '',
  settleAmt: (document.querySelector('[data-role=settle-amount]')||{}).value || '',
  catShown: (document.querySelector('[data-role=pick-sub]')||{}).textContent || '',
}))()`);
check('结清预填金额 = 还差 ¥500', pre.amount === '500.00', pre.amount);
check('结清预填往来对象', pre.counterparty === '张三', pre.counterparty);
check('结清预填关联那笔', Boolean(pre.settle), String(pre.settle).slice(0, 12));
check('结清预填「本次冲抵」', pre.settleAmt === '500.00', pre.settleAmt);
check('结清预填带出分类', String(pre.catShown).length > 0, String(pre.catShown));
c.shot(await probe.shot('settle-prefill-1440', { dir: OUT, focus: '.compose__card' }));

// 部分结清：把本笔金额改小 → 冲抵额自动收敛
await ev(`(() => { const a=document.querySelector('[name=amount]'); a.value='300.00'; a.dispatchEvent(new Event('input',{bubbles:true})); })()`);
await new Promise((r) => setTimeout(r, 400));
const shrunk = await ev(`(document.querySelector('[data-role=settle-amount]')||{}).value || ''`);
check('本笔金额改小后「本次冲抵」自动收敛', shrunk === '300.00', shrunk);

// 提交部分结清
await ev(`document.querySelector('[data-role=submit]').click()`);
await new Promise((r) => setTimeout(r, 2000));
const url3 = await ev(`location.pathname`);
check('部分结清提交后回账单列表', String(url3).includes('/transactions'), String(url3));
const debtsAfter = await (
  await fetch(`${API}${P`/ledgers/${ledger.id}/debts`}?status=all`, { headers: AH })
).json();
const item = (debtsAfter.data?.items ?? []).find((i) => i.transactionId === origin.id);
check('部分结清后已结 600 / 还差 200', item?.settled === '600.00' && item?.outstanding === '200.00', JSON.stringify({ s: item?.settled, o: item?.outstanding }));
check('结清记录显示两笔（300 + 300）', (item?.settlements ?? []).length === 2, JSON.stringify((item?.settlements ?? []).map((x) => x.amount)));

/* ══════════ 任务 5：三合一表单 ══════════ */
console.log('\n── 任务 5 · 三合一表单 ──');
await open('/transactions/new', { wait: '#tx-amount', theme: 'light', arm: auth.arm });
const modes = await ev(
  `Array.from(document.querySelectorAll('[data-role=entry-mode] option')).map((x) => x.textContent.trim())`,
);
check('三种形态合并进同一表单', modes.length === 3 && modes[0].includes('单次'), JSON.stringify(modes));

// 选周期 → 居中 modal
await ev(`(() => { const s=document.querySelector('[data-role=entry-mode]'); s.value='recurring'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 500));
check('选周期弹出 modal', (await ev(`!!document.querySelector('[data-role=plan-modal]')`)) === true);
const geo = await ev(`(() => {
  const p = document.querySelector('.modal__panel');
  const r = p.getBoundingClientRect();
  const gapTop = Math.round(r.top);
  const gapBottom = Math.round(window.innerHeight - r.bottom);
  return {gapTop, gapBottom, w: Math.round(r.width), centered: Math.abs(gapTop-gapBottom) < 40};
})()`);
check('modal 垂直居中', geo.centered === true, JSON.stringify(geo));
const scrimBg = await ev(`getComputedStyle(document.querySelector('.modal__scrim')).backgroundColor`);
check('遮罩是暗色（不是透明）', scrimBg !== 'rgba(0, 0, 0, 0)', scrimBg);
const rLabels = await ev(
  `Array.from(document.querySelectorAll('.modal__body .field__label')).map((x) => x.textContent.trim())`,
);
check('周期字段齐（频率/间隔/几号/周几/结束/提前）', rLabels.length === 6, JSON.stringify(rLabels));
c.shot(await probe.shot('modal-recurring-1440', { dir: OUT, focus: '.modal__panel' }));

// 频率联动
await ev(`(() => { const f=document.querySelector('#rc-freq'); f.value='weekly'; f.dispatchEvent(new Event('change')); })()`);
check('切周度 → 「每月第几日」隐藏', (await ev(`document.querySelector('[data-role=f-monthly]').hidden`)) === true);
check('切周度 → 「星期几」显示', (await ev(`!document.querySelector('[data-role=f-weekly]').hidden`)) === true);

// Esc 关闭且恢复滚动
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await new Promise((r) => setTimeout(r, 300));
check('Esc 关闭 modal', (await ev(`!document.querySelector('[data-role=plan-modal]')`)) === true);
check('关闭后恢复背景滚动', (await ev(`document.body.style.overflow`)) === '');

// 分期
await ev(`(() => { const s=document.querySelector('[data-role=entry-mode]'); s.value='installment'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 500));
const iLabels = await ev(
  `Array.from(document.querySelectorAll('.modal__body .field__label')).map((x) => x.textContent.trim())`,
);
check('分期字段齐（期数/频率/负债账户/手续费）', iLabels.length >= 6, JSON.stringify(iLabels));
check('期数默认 12', (await ev(`(document.querySelector('#ins-count')||{}).value`)) === '12');
// 手续费方式联动
await ev(`(() => { const f=document.querySelector('#ins-fm'); f.value='per_period'; f.dispatchEvent(new Event('change')); })()`);
check('按期收取 → 总额隐藏 / 每期显示',
  (await ev(`document.querySelector('[data-role=ins-total-fee]').hidden`)) === true &&
    (await ev(`!document.querySelector('[data-role=ins-per-fee]').hidden`)) === true);
c.shot(await probe.shot('modal-installment-1440', { dir: OUT, focus: '.modal__panel' }));

// 提交周期 → 真的建出规则
/**
 * ⚠️ 顺序很重要：**先选分类，再选形态**。
 *
 * `pickCategory` 会改 `state.recordType`（点「支出」那一下），
 * 而形态选择的 payload 是在选形态那一刻按当时的类型建的。
 * 反过来做的话：先选分期 → 再改类型 → 提交时按分期 payload 建计划，
 * 拿到的却是「支出」的分类 —— 断言看着在跑，实际上建出来的东西不对。
 *
 * 真实用户也是这个顺序（先说这笔记在哪个类，再说要不要重复）。
 */
await pickCategory();
await ev(`(() => { const s = document.querySelector('[data-role=entry-mode]'); s.value = 'recurring'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 450));
await ev(`document.querySelector('[data-role=modal-ok]').click()`);
await new Promise((r) => setTimeout(r, 400));

/**
 * 走**真实**的 Mega Menu 交互选分类。
 *
 * ⚠️ 不能用 `state.categoryId = x` 或假设有 `<select name=categoryId>`：
 *   分类是三级面板（类型 → 一级 → 二级），二级列要等一级被点才填充。
 *   探针想当然地按顺序点，结果二级列还是空的 —— 而**断言全绿、页面没提交**，
 *   看起来像功能坏了，其实是探针没走对路径。
 *   「断言必须走真实交互路径」与「轮询要等本次动作的信号」是同一条纪律。
 */
async function pickCategory(word = '支出') {
  await ev(`document.querySelector('[data-role=pick-trigger]').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const types = await ev(
    `Array.from(document.querySelectorAll('[data-role=col-type] .mega__item')).map((x) => x.textContent.trim())`,
  );
  if (!types.some((t) => t.includes(word))) throw new Error(`类型列没有「${word}」：${JSON.stringify(types)}`);
  await ev(
    `(() => { const t = Array.from(document.querySelectorAll('[data-role=col-type] .mega__item'))
       .find((x) => x.textContent.includes(${JSON.stringify(word)}));
       t.click(); })()`,
  );
  await new Promise((r) => setTimeout(r, 450));
  const parents = await ev(
    `Array.from(document.querySelectorAll('[data-role=col-parent] .mega__navitem')).map((x) => x.textContent.trim())`,
  );
  if (!parents.length) throw new Error(`一级分类列为空（类型列：${JSON.stringify(types)}）`);
  await ev(`document.querySelector('[data-role=col-parent] .mega__navitem').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const leaves = await ev(
    `Array.from(document.querySelectorAll('[data-role=col-leaf] .option-chip')).map((x) => x.textContent.trim())`,
  );
  if (!leaves.length) throw new Error(`二级分类列为空（一级列：${JSON.stringify(parents)}）`);
  await ev(`document.querySelector('[data-role=col-leaf] .option-chip').click()`);
  await new Promise((r) => setTimeout(r, 400));
}

await ev(`(() => {
  const set = (sel, v) => { const e = document.querySelector(sel); e.value = v;
    e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); };
  set('[name=amount]', '300.00');
  set('[name=name]', '房租');
})()`);
await ev(`document.querySelector('[data-role=submit]').click()`);
await new Promise((r) => setTimeout(r, 2600));
const url4 = await ev(`location.pathname`);
check('提交周期后跳到周期账单页', String(url4).includes('/recurring'), String(url4));
const rules = await (await fetch(`${API}${P`/ledgers/${ledger.id}/recurring-rules`}`, { headers: AH })).json();
check('周期规则真的建出来了', (rules.data ?? []).length >= 1, `${(rules.data ?? []).length} 条`);
check('规则带着主表单的金额与分类', (rules.data ?? [])[0]?.amount === '300.00' && Boolean((rules.data ?? [])[0]?.categoryId), JSON.stringify({ a: (rules.data ?? [])[0]?.amount, c: (rules.data ?? [])[0]?.categoryId }));
c.shot(await probe.shot('recurring-after-1440', { dir: OUT, focus: '.page' }));

/* ══════════ 移动端 ══════════ */
console.log('\n── 移动端 ──');
await open('/transactions/new', { wait: '#tx-amount', theme: 'light', width: 390, height: 900, arm: auth.arm });
await ev(`(() => { const s=document.querySelector('[data-role=entry-mode]'); s.value='installment'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await new Promise((r) => setTimeout(r, 500));
const ovf = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('390px modal 无横向溢出', Number(ovf) <= 1, `${ovf}px`);
const sheet = await ev(`(() => {
  const r = document.querySelector('.modal__panel').getBoundingClientRect();
  return Math.abs(Math.round(r.bottom) - window.innerHeight) < 3;
})()`);
check('窄屏 modal 贴底（拇指可达）', sheet === true);
const tap = await ev(`Math.round(document.querySelector('.modal__foot .btn').getBoundingClientRect().height)`);
check('modal 按钮 ≥ 44px', Number(tap) >= 44, `${tap}px`);
c.shot(await probe.shot('modal-mobile-390', { dir: OUT, focus: '.modal__panel' }));

check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));

probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
