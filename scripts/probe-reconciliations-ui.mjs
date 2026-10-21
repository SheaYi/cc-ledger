/**
 * 对账历史页 —— CDP 探针
 *
 * 验六件事：
 *   1. /reconciliations 能渲染（路由接线 + 模块链接，body 非空）
 *   2. 健康度四个数字取自 reconciliationSummary（断言具体数值，不是「有内容」）
 *   3. 记录行的账面/实际/差额与后端返回逐格相等 —— 金额只有一个出口 money()
 *   4. **legacyBoundary 挂在记录行上**，不只在页脚（核对型页面的核心要求）
 *   5. 账户筛选真的生效（筛完行数变少，且全是被选中的账户）
 *   6. 空态有引导入口，不是一句「暂无数据」
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'reconciliations');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, waitUntil, errors, netFails } = probe;
const c = checker();
const { check } = c;

/* ---------- 建数据：一个账户做两次对账（一次相符、一次有差额） ---------- */
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.77.${Math.floor(Math.random() * 250)}.5` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'recon' + Date.now().toString(36),
      nickname: '对账探针',
      password: 'ReconProbe123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

/** 用注册自带账本 —— 界面显示的是「当前账本」（currentLedger），新建的看不见 */
const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const groups = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json()).data;
const grp = groups.find((x) => x.id.endsWith('#grp_bank')) ?? groups[0];

async function mkAccount(name, opening) {
  return (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
        method: 'POST',
        headers: POST,
        body: JSON.stringify({ name, type: 'debit_card', groupId: grp.id, openingBalance: opening }),
      })
    ).json()
  ).data;
}
const accA = await mkAccount('工资卡', '5000.00');
const accB = await mkAccount('零钱卡', '200.00');
/**
 * 「从未对账」账户必须在**页面加载之前**建好。
 * 筛选下拉的选项是渲染时从账户列表快照出来的，事后建的账户不在 `<option>` 里 ——
 * 给 select 赋一个不存在的 value 会被静默置空，筛选根本没生效，
 * 于是「空态」永远测不到（第一版就这样：全部断言绿，唯独空态那三条超时）。
 */
const accC = await mkAccount('从未对账的卡', '0.00');

const cats = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}`, { headers: AH })).json()).data;
let cat = null;
for (const p of cats) {
  if (p.recordType !== 'expense') continue;
  for (const ch of p.children ?? []) if (!cat && /餐饮/.test(p.name)) cat = ch;
}
const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = ds(new Date());

await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({
    recordType: 'expense',
    accountId: accA.id,
    categoryId: cat?.id,
    amount: '100.00',
    txDate: todayStr,
    clientRequestId: 'rp-' + Math.random().toString(36).slice(2),
  }),
});

/** 对账：actual='5000.00' → 与账面 4900 有差；再对一次 actual='4900.00' → 相符 */
async function reconcile(accId, actual) {
  const r = await (
    await fetch(`${API}${P`/ledgers/${ledger.id}/accounts/${accId}/reconcile`}`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ actualBalance: actual, reconcileDate: todayStr, createAdjustment: false }),
    })
  ).json();
  return r.data;
}
await reconcile(accA.id, '5000.00');
await reconcile(accA.id, '4900.00');
await reconcile(accB.id, '200.00');

/**
 * ⚠️ 真值必须从 **listReconciliations** 读，不能用 submitReconcile 的返回值。
 *
 * `submitReconcile` 的 `isBalanced` 恒为 `true` —— 它回答的是「**对完之后**
 * 账实相符了吗」，不是「对账当时有没有差额」。差额要生成调整单把账调平，
 * 所以返回必然是相符；差额本身在 `diffAmount` 里。
 * 拿它当 `isBalanced` 的期望值，会把一条有差额的记录当成相符来断言 ——
 * 而页面的徽标（来自 list 的 `isBalanced`）反而是对的，于是断言自证其说地绿着。
 */
const serverSummary = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/reconciliation-summary`}`, { headers: AH })).json()).data;
const serverRows = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/reconciliations`}`, { headers: AH })).json()).data;
console.log(
  `对账 3 次 → 列表 ${serverRows.length} 条：` +
    serverRows.map((r) => `${r.account.name} ${r.isBalanced ? '相符' : `差 ${r.diffAmount}`}`).join(' / '),
);

/* ---------- 干净起点 ---------- */
await wipe();
const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });

/* ══════════════ 1. 页面渲染 ══════════════ */
console.log('\n── 1. 页面渲染 ──');
const opened = await open('/reconciliations', {
  wait: '.recon-hist__row',
  theme: 'light',
  arm: auth.arm,
});
check('页面渲染出记录行', opened === true);
check('body 非空（模块链接没炸）', (await ev(`document.body.innerText.length`)) > 100, String(await ev(`document.body.innerText.length`)));

/* ══════════════ 2. 健康度数字 ══════════════ */
console.log('\n── 2. 账本健康度 ──');
const health = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.stat-strip__cell')].map(c => ({
    label: c.querySelector('.stat-strip__label').textContent.trim(),
    value: c.querySelector('.stat-strip__value').textContent.replace(/\\s+/g,' ').trim(),
  })))`),
);
check('健康度有 4 个指标', health.length === 4, JSON.stringify(health));
const byLabel = Object.fromEntries(health.map((x) => [x.label, x.value]));
check(
  '「已对账账户」= 后端值',
  byLabel['已对账账户'] === `${serverSummary.reconciledAccounts} / ${serverSummary.totalAccounts}`,
  `页面=${byLabel['已对账账户']} 后端=${serverSummary.reconciledAccounts}/${serverSummary.totalAccounts}`,
);
check('「近 90 天对账」= 后端值', byLabel['近 90 天对账'] === `${serverSummary.reconcileCount90d} 次`, `${byLabel['近 90 天对账']} vs ${serverSummary.reconcileCount90d} 次`);
check(
  '「当前有差额」= 后端值',
  byLabel['当前有差额'] === String(serverSummary.accountsWithDiff),
  `${byLabel['当前有差额']} vs ${serverSummary.accountsWithDiff}`,
);
check('「平均差额」带 ¥ 前缀（money 是唯一出口）', /^¥/.test(byLabel['平均差额'] ?? ''), byLabel['平均差额']);

/**
 * 「该对账了」不能漏掉**从未对账**的账户。
 *
 * 后端把 `lastReconciledAt === null` 的账户也放进 `unreconciledList`，
 * 但第一版页面只按 `currentDiff !== 0` 和 `daysSinceReconcile > 30` 过滤 ——
 * `null > 30` 是 false，`null ?? 0` 也不大于 30，于是这类账户**两边都漏掉**，
 * 兜底文案打印「所有账户都对过」。本探针的 accC 就是从未对账的，
 * 它必须出现在待办清单里，且总数 = 1（accA/accB 都对过且无差额）。
 */
const todoText = await ev(`document.querySelector('[data-role=todo]').textContent.replace(/\\s+/g,' ').trim()`);
check('待办清单列出从未对账的账户', todoText.includes(accC.name) && todoText.includes('从未对账'), todoText.slice(0, 160));
check(
  '待办总数正确（只有 accC 未对；accA/accB 对过且无差额）',
  todoText.includes('1 个账户'),
  todoText.slice(0, 160),
);
check(
  '已对账且无差额时**不**打印「所有账户都对过」',
  !todoText.includes('所有账户都对过'),
  todoText.slice(0, 160),
);

/**
 * 「已对账账户」的分母**不能含虚拟账户**。
 *
 * 虚拟账户是债权/债务台账，压根没有「银行实际余额」这回事，永远不需要对账。
 * 早先后端没过滤，新账本一打开就是「已对账账户 0/3」并把三个系统账户
 * 列成「该对账了」—— 而前端又过滤了虚拟账户，用户点过去发现没有对账入口。
 * 这里钉死：分母 = 真实账户数，且未对账清单里不出现系统台账账户。
 */
const realAccs = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, { headers: AH })).json()).data.filter(
  (a) => a.kind !== 'virtual',
);
const virtualNames = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, { headers: AH })).json())
  .data.filter((a) => a.kind === 'virtual')
  .map((a) => a.name);
check(
  '分母 = 真实账户数（虚拟台账账户不计入对账口径）',
  serverSummary.totalAccounts === realAccs.length,
  `后端=${serverSummary.totalAccounts} 真实=${realAccs.length}`,
);
check(
  '「该对账了」清单里不含虚拟账户',
  !(serverSummary.unreconciledList ?? []).some((x) => virtualNames.includes(x.accountName)),
  JSON.stringify((serverSummary.unreconciledList ?? []).map((x) => x.accountName)),
);
check(
  '已对账的账户数不超过真实账户数',
  serverSummary.reconciledAccounts <= realAccs.length,
  `${serverSummary.reconciledAccounts} > ${realAccs.length}`,
);

/* ══════════════ 3. 记录行逐格比对 ══════════════ */
console.log('\n── 3. 记录行 vs 后端 ──');
const rows = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.recon-hist__row')].map(r => ({
    account: r.querySelector('.tt-body-strong').textContent.trim(),
    badges: [...r.querySelectorAll('.badge')].map(b => b.textContent.trim()),
    meta: r.querySelector('.tt-fine-print').textContent.replace(/\\s+/g,' ').trim(),
    nums: [...r.querySelectorAll('.recon-hist__num')].map(n =>
      [...n.children].map(x => x.textContent.trim()).join(' ')),
    hasAdj: !!r.querySelector('.recon-hist__adj'),
  })))`),
);
check('记录行数 = 后端条数', rows.length === serverRows.length, `页面=${rows.length} 后端=${serverRows.length}`);

/** 页面上的「账面 5,000.00」→ 归一为 5000.00 再比，避免分隔符/符号干扰 */
const norm = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
for (const [i, r] of serverRows.entries()) {
  const ui = rows[i];
  if (!ui) break;
  check(
    `第 ${i + 1} 行账户名一致`,
    ui.account === r.account.name,
    `${ui.account} vs ${r.account.name}`,
  );
  const uiNums = ui.nums.map(norm);
  check(
    `第 ${i + 1} 行账面/实际与后端一致`,
    uiNums[0] === Number(r.systemBalance) && uiNums[1] === Number(r.actualBalance),
    `页面 ${JSON.stringify(ui.nums)} vs 后端 ${r.systemBalance}/${r.actualBalance}`,
  );
  const balBadge = ui.badges.find((b) => b.includes('相符') || b.includes('差额'));
  check(
    `第 ${i + 1} 行徽标与 isBalanced 一致`,
    r.isBalanced ? !!balBadge?.includes('相符') : !!balBadge?.includes('差额'),
    `${JSON.stringify(ui.badges)} isBalanced=${r.isBalanced}`,
  );
  check(`第 ${i + 1} 行对账日正确`, ui.meta.includes(r.reconcileDate), `${ui.meta} 含 ${r.reconcileDate}`);
}
c.shot(await probe.shot('recon-hist-light-1440', { dir: OUT, focus: '.recon-hist__row' }));

/* ══════════════ 4. 旧口径标注 ══════════════ */
console.log('\n── 4. 旧口径标注（docs/14）──');
const legacy = JSON.parse(
  await ev(`JSON.stringify({
    rowBadges: [...document.querySelectorAll('.recon-hist__row .badge')].map(b => b.textContent.trim()),
    noteBlocks: document.querySelectorAll('.recon-hist__legacy').length,
    noteText: document.querySelector('.recon-hist__legacy')?.textContent.replace(/\\s+/g,' ').trim() ?? '',
  })`),
);
check(
  '每条 legacyBoundary 记录的行内都有「旧口径」徽标',
  serverRows.filter((r) => r.legacyBoundary).length === 0 ||
    serverRows.filter((r) => r.legacyBoundary).every(() => legacy.rowBadges.includes('旧口径')),
  JSON.stringify(legacy.rowBadges),
);
check(
  '本探针建的记录都是新口径 → **不**渲染旧口径说明（纯噪音）',
  legacy.noteBlocks === 0,
  `noteBlocks=${legacy.noteBlocks} text=${legacy.noteText.slice(0, 80)}`,
);

/* ══════════════ 5. 账户筛选 ══════════════ */
console.log('\n── 5. 账户筛选 ──');
const total = rows.length;
await ev(`(() => {
  const s = document.querySelector('[data-role=f-account]');
  s.value = ${JSON.stringify(accB.id)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
const after = await waitUntil(
  async () => {
    const n = await ev(`document.querySelectorAll('.recon-hist__row').length`);
    return n !== total ? n : null;
  },
  { label: '筛选后重渲染' },
);
check('筛选后行数变化', after !== null, `before=${total} after=${after}`);
const names = await ev(`JSON.stringify([...document.querySelectorAll('.recon-hist__row .tt-body-strong')].map(e => e.textContent.trim()))`);
check('筛选后只剩被选中的账户', JSON.parse(names).every((n) => n === accB.name), names);

/* ══════════════ 6. 空态 ══════════════ */
console.log('\n── 6. 空态 ──');
/**
 * 造一个真·空态：筛 accC（「从未对账的卡」，一条对账记录都没有）。
 *
 * 不用「把时间范围调到近 30 天」造空 —— 今天的记录正好落在窗口内，
 * 这类靠时序碰出来的空态探针会在别的日期红掉。
 * 也不用事后新建账户再筛 —— 详见 accC 那条注释。
 */
await ev(`(() => {
  const s = document.querySelector('[data-role=f-range]');
  s.value = '';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  const a = document.querySelector('[data-role=f-account]');
  a.value = ${JSON.stringify(accC.id)};
  a.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
const empty = await waitUntil(
  async () => (await ev(`!!document.querySelector('.empty-state')`)) || null,
  { label: '空态渲染' },
);
check('无记录账户 → 渲染空态', !!empty);
const emptyText = await ev(`document.querySelector('.empty-state')?.textContent.replace(/\\s+/g,' ').trim() ?? ''`);
check('空态说明「还没有对账记录」', emptyText.includes('还没有对账记录'), emptyText.slice(0, 100));
check('空态有「去对账」按钮', !!(await ev(`!!document.querySelector('.empty-state [data-role=empty-go]')`)));
c.shot(await probe.shot('recon-hist-empty-1440', { dir: OUT, focus: '.empty-state' }));

/* ══════════════ 7. 暗色 + 移动端 ══════════════ */
console.log('\n── 7. 暗色与移动端 ──');
await open('/reconciliations', { wait: '.recon-hist__row', theme: 'dark', arm: auth.arm });
check('暗色下记录行渲染', (await ev(`document.querySelectorAll('.recon-hist__row').length`)) > 0);
check(
  'html[data-theme] 确实是 dark',
  (await ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark',
);
c.shot(await probe.shot('recon-hist-dark-1440', { dir: OUT, focus: '.recon-hist__row' }));

await open('/reconciliations', {
  wait: '.recon-hist__row',
  width: 390,
  height: 844,
  mobile: true,
  theme: 'light',
  arm: auth.arm,
});
/**
 * ≤833px 折成**卡片式两列**（第 1 行 标签 + 金额，第 2 行 状态 + 时间）。
 *
 * 以前这里断言的是「flex-direction 变 column」—— 那是旧版 flex 两栏的降级方式。
 * 改成栅格后判定式已经不适用，但**意图**没变：金额不能被压缩。
 * 所以改成直接量意图 —— 金额字号不降、金额块没有溢出裁切，
 * 而不是去测某一种具体的 CSS 实现（换实现就红、而 bug 照样在）。
 */
const mobileOk = await ev(`(() => {
  const r = document.querySelector('.recon-hist__row');
  if (!r) return { ok: false, why: 'no-row' };
  const cs = getComputedStyle(r);
  const nums = r.querySelector('.recon-hist__nums');
  const amt = r.querySelector('.recon-hist__amt');
  return {
    ok: cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length === 2,
    display: cs.display,
    cols: cs.gridTemplateColumns,
    amtFontSize: amt ? getComputedStyle(amt).fontSize : null,
    numsClipped: nums ? nums.scrollWidth - nums.clientWidth : null,
  };
})()`);
check('≤833px 记录行折成两列卡片（标签与金额同行）', mobileOk.ok === true, JSON.stringify(mobileOk));
check(
  '≤833px 金额不被压缩（字号不降、无裁切）',
  mobileOk.amtFontSize === '13px' && mobileOk.numsClipped === 0,
  JSON.stringify(mobileOk),
);
c.shot(await probe.shot('recon-hist-light-390', { dir: OUT, focus: '.recon-hist__row' }));

/* ══════════════ 8. 栅格对齐（这一页的核心诉求）══════════════ */
/**
 * 「列不对齐」以前是这样的：排期每一行是一条**独立**的 flex，
 * 列宽由该行自己的内容决定 —— 列定义存在 N 份，必然漂移。
 *
 * 修法是让列定义只存在**一份**（`--*-cols` 变量），表头与数据行都引用它。
 * 所以断言要验的是「N 行的列定义与实位置完全相同」，而不是「看起来齐了」：
 * 后者截图能过，但下一行内容一变就复发。
 */
console.log('\n── 8. 栅格对齐 ──');
await open('/reconciliations', { wait: '.recon-hist__row', theme: 'light', arm: auth.arm });

const schedAlign = JSON.parse(
  await ev(`JSON.stringify((() => {
    const head = document.querySelector('.recon-sched__head');
    const rows = [...document.querySelectorAll('.recon-sched__row')];
    const colsOf = (el) => getComputedStyle(el).gridTemplateColumns;
    const xsOf = (el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left));
    return {
      hasHead: !!head,
      rowCount: rows.length,
      headCols: head ? colsOf(head) : null,
      rowCols: [...new Set(rows.map(colsOf))],
      headXs: head ? xsOf(head) : null,
      rowXs: rows.map(xsOf),
    };
  })())`),
);
check('排期渲染出表头与数据行', schedAlign.hasHead && schedAlign.rowCount > 0, JSON.stringify(schedAlign.rowCount));
check(
  '排期所有行的列定义**完全一致**（去重后只剩一份）',
  schedAlign.rowCols.length === 1,
  JSON.stringify(schedAlign.rowCols),
);
check(
  '排期表头与数据行共用同一套列定义（这是列不对齐的根治点）',
  schedAlign.headCols === schedAlign.rowCols[0],
  `head=${schedAlign.headCols} row=${schedAlign.rowCols[0]}`,
);
check(
  '排期每一列的起始 x 逐行相等（横向无错位）',
  schedAlign.rowXs.every((xs) => xs.length === schedAlign.headXs.length && xs.every((x, i) => Math.abs(x - schedAlign.headXs[i]) <= 1)),
  JSON.stringify({ head: schedAlign.headXs, rows: schedAlign.rowXs }),
);

const histAlign = JSON.parse(
  await ev(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('.recon-hist__row')];
    const rightsOf = (sel) => rows.map((r) => {
      const n = r.querySelector(sel);
      return n ? Math.round(n.getBoundingClientRect().right) : null;
    });
    return {
      heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      amtRights: rightsOf('.recon-hist__amt'),
      dateRights: rightsOf('.recon-hist__date'),
      colCounts: [...new Set(rows.map((r) => getComputedStyle(r).gridTemplateColumns.split(' ').length))],
    };
  })())`),
);
check('记录行统一行高（高低不齐 = 某一被内容顶高了）', new Set(histAlign.heights).size === 1, JSON.stringify(histAlign.heights));
check(
  '记录行四列（标签 / 状态 / 金额 / 时间）',
  histAlign.colCounts.length === 1 && histAlign.colCounts[0] === 4,
  JSON.stringify(histAlign.colCounts),
);
check(
  '金额右边界逐行对齐（tnum + 右对齐，便于上下比对）',
  new Set(histAlign.amtRights.filter((x) => x !== null)).size === 1,
  JSON.stringify(histAlign.amtRights),
);
check(
  '日期右边界逐行对齐',
  new Set(histAlign.dateRights.filter((x) => x !== null)).size === 1,
  JSON.stringify(histAlign.dateRights),
);
c.shot(await probe.shot('recon-align-1440', { dir: OUT, focus: '.recon-sched' }));

/* ══════════════ 9. 四张指标卡 ══════════════ */
console.log('\n── 9. 四张指标卡 ──');
const metrics = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.metric')].map((m) => ({
    title: m.querySelector('.metric__title')?.textContent.trim() ?? null,
    value: m.querySelector('.metric__value')?.textContent.trim() ?? null,
    state: m.querySelector('.metric__state')?.textContent.trim() ?? null,
    badge: m.querySelector('.badge')?.textContent.trim() ?? null,
    h: Math.round(m.getBoundingClientRect().height),
    pad: getComputedStyle(m).padding,
    radius: getComputedStyle(m).borderRadius,
  }))) `),
);
check('四张指标卡都渲染了标题 / 数值 / 状态说明', metrics.length === 4 && metrics.every((m) => m.title && m.value && m.state), JSON.stringify(metrics.map((m) => m.title)));
check('四张卡**等高**（不是只对齐了边框）', new Set(metrics.map((m) => m.h)).size === 1, JSON.stringify(metrics.map((m) => m.h)));
check(
  '四张卡内边距与圆角一致',
  new Set(metrics.map((m) => m.pad)).size === 1 && new Set(metrics.map((m) => m.radius)).size === 1,
  JSON.stringify(metrics.map((m) => [m.pad, m.radius])),
);
check('每张卡都有状态徽标（不读完正文就知道有没有问题）', metrics.every((m) => m.badge), JSON.stringify(metrics.map((m) => m.badge)));
c.shot(await probe.shot('recon-metrics-1440', { dir: OUT, focus: '.metric-grid' }));

/* ══════════════ 10. 跨断点自检（对齐 / 间距 / 触控）══════════════ */
/**
 * 版式修复最容易「只在改的那个宽度下成立」—— 所以对齐要逐个断点重验一遍，
 * 而不是 1440 截图看着齐就算完。这里跑文档的四个结构断点：
 * 1440（内容锁宽）/ 1024（收侧栏）/ 833（触屏）/ 390（手机）。
 */
console.log('\n── 10. 跨断点自检 ──');
for (const w of [1440, 1024, 833, 390]) {
  await open('/reconciliations', {
    wait: '.recon-hist__row',
    width: w,
    height: 900,
    mobile: w <= 833,
    theme: 'light',
    arm: auth.arm,
  });

  const bp = JSON.parse(
    await ev(`JSON.stringify((() => {
      const rows = [...document.querySelectorAll('.recon-hist__row')];
      const sRows = [...document.querySelectorAll('.recon-sched__row')];
      const head = document.querySelector('.recon-sched__head');
      const headVisible = head ? getComputedStyle(head).display !== 'none' : false;
      const csCols = sRows.map((r) => getComputedStyle(r).gridTemplateColumns);
      const btns = [...document.querySelectorAll('.recon-hist__row button, .recon-sched__row button, [data-role=f-account], [data-role=f-range]')];
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
        amtRights: rows.map((r) => { const a = r.querySelector('.recon-hist__amt'); return a ? Math.round(a.getBoundingClientRect().right) : null; }),
        sCols: [...new Set(csCols)],
        headCols: head ? getComputedStyle(head).gridTemplateColumns : null,
        sRowsVisible: headVisible,
        minBtnH: btns.length ? Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().height))) : null,
      };
    })())`),
  );

  check(`${w}px 无横向溢出`, bp.scrollW <= bp.innerW + 1, `scrollW=${bp.scrollW} innerW=${bp.innerW}`);
  check(`${w}px 记录行等高`, new Set(bp.heights).size === 1, JSON.stringify(bp.heights));
  check(
    `${w}px 金额右边界逐行对齐`,
    new Set(bp.amtRights.filter((x) => x !== null)).size === 1,
    JSON.stringify(bp.amtRights),
  );
  /**
   * 排期表在 ≤833px 会折成卡片、**表头必须跟着隐藏** —— 此时「列」不再存在，
   * 断言要按宽度分情况：宽屏验「表头与数据行同一套列定义」，
   * 窄屏验「表头确实不在了」。一刀切地只数行是不够的 ——
   * 表头留着且仍是桌面五列，会让「列不对齐」换个形态继续存在。
   */
  if (w > 833) {
    check(
      `${w}px 排期表头与数据行同一套列定义`,
      bp.sRowsVisible && bp.sCols.length === 1 && bp.sCols[0] === bp.headCols,
      JSON.stringify({ head: bp.headCols, rows: bp.sCols }),
    );
  } else {
    check(`${w}px 排期折成卡片后表头隐藏（否则指错格子）`, bp.sRowsVisible === false, JSON.stringify(bp.headCols));
    check(
      `${w}px 排期所有行列定义一致`,
      bp.sCols.length === 1,
      JSON.stringify(bp.sCols),
    );
  }
  check(
    `${w}px 可见控件 ≥44px（00-DESIGN 触控底线）`,
    bp.minBtnH === null || bp.minBtnH >= 44,
    String(bp.minBtnH),
  );
  c.shot(await probe.shot(`recon-bp-${w}`, { dir: OUT, focus: '.recon-hist__row' }));
  /** 窄屏的排期卡片是另一套排布（表头已隐藏），单独留一张图给人看 */
  if (w <= 833) c.shot(await probe.shot(`recon-sched-${w}`, { dir: OUT, focus: '.recon-sched' }));
}

/* 整页长图（1440 内容锁宽）—— 给人工复核用，探针自己不需要它 */
await open('/reconciliations', { wait: '.recon-hist__row', width: 1440, height: 1760, theme: 'light', arm: auth.arm });
c.shot(await probe.shot('recon-full-1440', { dir: OUT }));

/* ══════════════ 收尾 ══════════════ */
const unexpected = errors.filter((e) => !e.includes('favicon'));
check('全程零控制台报错', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
check('全程零 4xx/5xx API', netFails.length === 0, netFails.slice(0, 4).join(' | '));
check('零缺失图标', (await ev(`document.querySelectorAll('[data-missing-icon]').length`)) === 0);

probe.close();
probe.finish(c.results, { shots: c.shots, exitOnFail: true });
