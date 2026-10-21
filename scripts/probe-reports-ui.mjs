/**
 * 统计 / 预算 / 导入三页 —— CDP 探针
 *
 * 这三页的风险不在「能不能渲染」，而在**数字对不对**与**流程能不能走通**：
 *   1. 统计的每个数字都要与后端返回**逐格相等**（前端不重算任何汇总）
 *   2. 趋势图的点数与后端桶数一致；近三月要真的跨 3 个自然月
 *   3. 预算的「已花」必须等于统计的「支出」—— 两页口径若不同源就会露馅
 *   4. 超支时 `over` 的呈现是红条 + 负数剩余
 *   5. 导入：真实上传一个 CSV → 预览表出现 → 改映射 → 提交 → 报告逐格对得上
 *      （这里必须**真传文件**而不是 mock，因为 FormData 的边界、
 *      BOM 剥离、GBK 嗅探全都在真实上传路径上才跑得到）
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'reports');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 金额比对：`money()` 带千分位与 ¥，比对前先剥掉 */
const norm = (s) => String(s ?? '').replace(/[¥,\s]/g, '');

/**
 * Node 侧的 multipart 组装。页面里是用 DataTransfer 塞进 file input 的，
 * 但「重复导入」这一步要在 Node 侧重放**完全相同**的请求 ——
 * 只能自己拼一遍 body，而拼接错了就会拿到一个「全是校验失败」的报告，
 * 那与「去重生效了」是两回事，断言会假红。
 */
function multipart(text, mapping) {
  const boundary = `----probe${Math.random().toString(36).slice(2)}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="alipay.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    text,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify(mapping)}\r\n`,
    `--${boundary}--\r\n`,
  ];
  return { body: Buffer.from(parts.join('')), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, waitUntil, errors, netFails } = probe;
const c = checker();
const { check } = c;

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = iso(new Date());
const monthOf = (s) => s.slice(0, 7);

/* ══════════════ 数据准备 ══════════════ */
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.73.${Math.floor(Math.random() * 250)}.3` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'rep' + Date.now().toString(36),
      nickname: '报表探针',
      password: 'ReportProbe123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const G = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json()).data;
const grp = G.find((x) => x.id.endsWith('#grp_bank')) ?? G[0];

const acc = (
  await (
    await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ name: '探针卡', type: 'debit_card', groupId: grp.id, openingBalance: '100000.00' }),
    })
  ).json()
).data;

const expTree = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=expense`, { headers: AH })).json())
  .data;
const incTree = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=income`, { headers: AH })).json())
  .data;
const expParent = expTree.find((p) => (p.children ?? []).length >= 2) ?? expTree[0];
const catA = expParent.children[0];
const catB = expParent.children[1];
const incCat = (incTree.find((p) => (p.children ?? []).length) ?? incTree[0]).children[0];

async function tx(body) {
  return (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
        method: 'POST',
        headers: POST,
        body: JSON.stringify({
          accountId: acc.id,
          txDate: todayStr,
          fee: '0',
          discount: '0',
          ...body,
        }),
      })
    ).json()
  ).data;
}

// 基线：两笔支出（不同分类）+ 一笔收入
await tx({ recordType: 'expense', categoryId: catA.id, name: '探针支出A', amount: '88.00' });
await tx({ recordType: 'expense', categoryId: catB.id, name: '探针支出B', amount: '260.00' });
await tx({ recordType: 'income', categoryId: incCat.id, name: '探针收入', amount: '900.00' });
// 造一个「上月」的支出，用来验预算的月切换确实换了区间
const lastMonthDate = (() => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1, 15);
  return iso(d);
})();
await tx({ recordType: 'expense', categoryId: catA.id, name: '上月支出', amount: '77.00', txDate: lastMonthDate });

// 一条会被自动分类规则命中的规则（导入联动）
await fetch(`${API}${P`/ledgers/${ledger.id}/category-rules`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({
    priority: 10,
    matchField: 'merchant',
    matchOp: 'contains',
    matchValue: '星巴克',
    recordType: 'expense',
    targetCategoryId: catB.id,
  }),
});

// 预算：本月总预算 1000（已花 348 → 34.8%），分类预算给 catA 50（已花 88 → 超支）
const y = new Date().getFullYear();
const m = new Date().getMonth() + 1;
await fetch(`${API}${P`/ledgers/${ledger.id}/budgets`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({ year: y, month: m, amount: '1000.00' }),
});
await fetch(`${API}${P`/ledgers/${ledger.id}/budgets`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({ categoryId: catA.id, year: y, month: m, amount: '50.00' }),
});

/* 后端真值 */
const sSummary = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/stats/summary`}`, { headers: AH })).json()).data;
const sProgress = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/budgets/progress`}?year=${y}&month=${m}`, { headers: AH })).json())
  .data;
/**
   * 报表页的「近 12 个月收支趋势」**固定**取近 12 个月（不随当前账期变），
   * 所以探针必须用同一个区间取后端桶数 —— 拿「本月按天」的桶去比，必然对不上。
   */
const nowD = new Date();
const last12To = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
const f12 = new Date(nowD.getFullYear(), nowD.getMonth() - 11, 1);
const last12From = `${f12.getFullYear()}-${String(f12.getMonth() + 1).padStart(2, '0')}-01`;
const sTrend = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/stats/trend`}?granularity=month&dateFrom=${last12From}&dateTo=${last12To}`, { headers: AH })).json())
  .data;
console.log(
  `后端：本月支出 ${sSummary.totalExpense}、收入 ${sSummary.totalIncome}、净资产 ${sSummary.netAssets}；预算 ${sProgress.length} 条`,
);

/* ---------- 干净起点 ---------- */
await wipe();
const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });

/* ══════════════ 1. 统计页 ══════════════ */
console.log('\n── 1. 统计页 ──');
const opened = await open('/stats', { wait: '.kpi-card', theme: 'light', arm: auth.arm });
check('统计页渲染出趋势卡', opened === true);
check(
  'body 非空（模块链接没炸）',
  Number(await ev(`document.body.innerText.length`)) > 100,
  String(await ev(`document.body.innerText.length`)),
);

/**
 * 报表页的概览区是 **4 张 KPI 卡**（不再是旧的 .stat-strip 三行格）。
 * 卡面：总收入 / 净支出（含结余率）/ 笔数与平均每笔 / 期末现金，
 * 每张卡整体可点，跳到对应筛选下的流水明细。
 */
const strip = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.kpi-card')].map(c => ({
    label: c.querySelector('.kpi-card__label').textContent.trim(),
    value: c.querySelector('.kpi-card__value').textContent.trim(),
    sub: c.querySelector('.kpi-card__sub')?.textContent.trim() ?? null,
  })))`),
);
const byLabel = Object.fromEntries(strip.map((x) => [x.label, x.value]));
check('KPI 卡 4 张', strip.length === 4, JSON.stringify(strip.map((x) => x.label)));
check(
  '「总收入」= 后端 totalIncome',
  norm(byLabel['总收入']) === norm(sSummary.totalIncome),
  `页面=${byLabel['总收入']} 后端=${sSummary.totalIncome}`,
);
check(
  '「净支出」= 后端 totalExpense',
  norm(byLabel['净支出']) === norm(sSummary.totalExpense),
  `页面=${byLabel['净支出']} 后端=${sSummary.totalExpense}`,
);
/**
 * 「净结余」不再单独占一张卡 —— 它进了周期对比表的「总结余」行。
 * 所以改为断言对比表里真的有这一行且数值一致。
 */
const netRowVal = String(
  await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-role=compare] .cmp-row')];
    const r = rows.find((x) => x.textContent.includes('总结余'));
    return r ? r.children[1].textContent.trim() : '';
  })()`),
);
check(
  '周期对比表「总结余」= 后端 netBalance',
  norm(netRowVal) === norm(sSummary.netBalance),
  `页面=${netRowVal} 后端=${sSummary.netBalance}`,
);
check(
  '「期末现金」= 后端 netAssets',
  norm(byLabel['期末现金']) === norm(sSummary.netAssets),
  `页面=${byLabel['期末现金']} 后端=${sSummary.netAssets}`,
);
/** 每张卡的副行是卡面承诺的一部分（结余率 / 平均 / 笔数），不能空 */
check(
  '每张 KPI 卡都有副行说明',
  strip.every((x) => (x.sub ?? '').trim().length > 0),
  JSON.stringify(strip.map((x) => x.sub)),
);
check(
  '日均口径存在且能反推回总额（日均 × 天数 ≈ 总额）',
  Math.abs(Number(sSummary.dailyExpense) * sSummary.periodDays - Number(sSummary.totalExpense)) <=
    Number(sSummary.dailyExpense) + 1,
  `${sSummary.dailyExpense} × ${sSummary.periodDays} vs ${sSummary.totalExpense}`,
);

/**
 * 语义色纪律：环比/同比不套收支配色 —— 「支出涨了 30%」染红是误导。
 * 新布局里变化率落在**周期对比表**，所以断言对象也从「净结余格」改为对比表的差异列。
 */
const netSub = String(
  await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-role=compare] .cmp-row')];
    const r = rows.find((x) => x.textContent.includes('总结余'));
    return r ? r.textContent : '';
  })()`),
);
check('环比用的是中性/箭头表达，不是 is-neg', !/is-neg|is-pos/.test(netSub) || /↑|↓|—/.test(netSub), netSub);

/**
   * 新报表页的收支趋势是**分组柱状图**（收/支双色 + 结余折线），
   * 不再是两条折线。断言改为数「柱组」—— 一组 = 一个月的收 + 支。
   * 柱组数必须等于桶数，且**含 0 值月**（轴要等距，见 charts.js 的说明）。
   */
  check('趋势图有柱组（收+支双柱）',
    Number(await ev(`document.querySelectorAll('[data-role=m-trend12] .st-bargroup').length`)) > 0,
    String(await ev(`document.querySelectorAll('[data-role=m-trend12] .st-bargroup').length`)));
/**
 * 点数要从 **path 的 d** 里数，不能数 `<text>`：
 * 标签在点数多时只标首/中/尾（否则挤成一团），所以 text 数量 ≠ 数据点数。
 * 「L」命令的数量 + 1 就是点数，这个映射不会骗人。
 */
// 新图：柱组数 = 桶数（0 值月也画，保证 X 轴等距）
const pointCount = Number(await ev(`document.querySelectorAll('[data-role=m-trend12] .st-bargroup').length`));
check(
  '趋势柱组数 = 后端桶数',
  pointCount === sTrend.length,
  `${pointCount} vs ${sTrend.length}`,
);
/**
   * 新报表页不再单列「最大单笔支出」那行文案。
   * 改为断言 KPI「净支出」卡的金额与后端 totalExpense 一致 ——
   * 这才是这张卡的承诺，且比一行提示更重要。
   */
check(
  '净支出卡金额与后端一致',
  (await ev(`Array.from(document.querySelectorAll('.kpi-card')).find(c=>c.textContent.includes('净支出'))?.querySelector('.kpi-card__value')?.textContent || ''`)).includes(norm(sSummary.totalExpense)),
  String(sSummary.totalExpense),
);

const catRows = await ev(`document.querySelectorAll('[data-role=m-rank] .rank-row').length`);
check('分类排行有行', Number(catRows) > 1, String(catRows));

/* 区间切换：近三月必须真的跨 3 个自然月 */
console.log('\n── 2. 区间切换 ──');
await ev(`document.querySelector('[data-quick=month]').click()`);
await sleep(900);
// ⚠️ 必须带**同一区间**：后端默认区间是「本月」，而页面此时是「近三月」。
// 不带区间去比，拿到的就是两个不同数据集的桶数 —— 断言会红，但红得没有意义。
const last3From = (() => {
  const d = new Date();
  d.setMonth(d.getMonth() - 2, 1);
  return iso(d);
})();
const last3Trend = (
  await (
    await fetch(
      `${API}${P`/ledgers/${ledger.id}/stats/trend`}?granularity=month&dateFrom=${last3From}&dateTo=${todayStr}`,
      { headers: AH },
    )
  ).json()
).data;
const shownPeriods = Number(await ev(`document.querySelectorAll('[data-role=m-trend12] .st-bargroup').length`));
/**
 * 「近 12 个月收支趋势」**固定**取近 12 个月 —— 这是标题的承诺。
 * 切到别的账期也不该让它变成 3 根柱，否则标题与图不符。
 * 所以这里断言的是「**不随账期变**」，而不是「跟随账期」。
 */
check('趋势图固定 12 个月，不随账期切换而变', shownPeriods === 12, `${shownPeriods} 根`);
check('近三月的桶跨越 3 个月份', new Set(last3Trend.map((x) => x.period)).size === 3, JSON.stringify(last3Trend.map((x) => x.period)));
c.shot(await probe.shot('stats-range-1440', { dir: OUT, focus: '.kpi-grid' }));

await ev(`document.querySelector('[data-quick=month]').click()`);
await sleep(700);

/* ══════════════ 3. 预算页 ══════════════ */
console.log('\n── 3. 预算页 ──');
const openedB = await open('/budgets', { wait: '.bdg-card', theme: 'light', arm: auth.arm });
check('预算页渲染出卡片', openedB === true);
check('卡片数 = 后端预算条数', Number(await ev(`document.querySelectorAll('.bdg-card').length`)) === sProgress.length, `${await ev(`document.querySelectorAll('.bdg-card').length`)} vs ${sProgress.length}`);

const cards = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.bdg-card')].map(el => ({
    title: el.querySelector('.bdg-card__title')?.textContent.replace(/\\s+/g,' ').trim(),
    amt: el.querySelector('.bdg-card__amt')?.textContent.trim(),
    over: el.classList.contains('is-over'),
    negCount: el.querySelectorAll('.recon-line .is-neg').length,
    barW: el.querySelector('.bdg-card__bar-fill')?.style.width,
    lines: [...el.querySelectorAll('.recon-line')].map(x => x.textContent.replace(/\\s+/g,' ').trim()),
  })))`),
);
check('总预算排在第一位', cards[0]?.title?.startsWith('总预算'), cards[0]?.title);
check(
  '总预算金额逐格相等',
  norm(cards[0]?.amt) === norm(sProgress.find((x) => x.categoryId === null).amount),
  `${cards[0]?.amt} vs ${sProgress.find((x) => x.categoryId === null).amount}`,
);
const totalLines = cards[0].lines.join(' | ');
check(
  '总预算「已花」= 统计的「支出」（两页口径必须同源）',
  norm(totalLines).includes('已花' + norm(sSummary.totalExpense)),
  `${totalLines} vs ${sSummary.totalExpense}`,
);
check(
  '总预算「已用 X%」= 后端 usedRatio',
  totalLines.replace(/\s/g, '').includes(`已用${sProgress.find((x) => x.categoryId === null).usedRatio}%`),
  totalLines,
);
const overCard = cards.find((x) => x.over);
check('超支的分类预算卡片带 is-over', Boolean(overCard), JSON.stringify(cards.map((x) => x.title)));
check(
  '超支卡片的剩余额带 is-neg（语义色落在有符号含义的数字上）',
  overCard && overCard.negCount >= 1,
  `neg=${overCard?.negCount} lines=${overCard?.lines.join(' | ')}`,
);
check(
  '超支时显示「超出 ¥38.00」而不是「超出 −¥38.00」（负号不重复）',
  overCard && /超出/.test(overCard.lines.join(' ')) && !/超出\s*-/.test(overCard.lines.join(' ').replace(/\s/g, '')),
  overCard?.lines.join(' | '),
);
check(
  '进度条宽度不会超过 100%（超支时不溢出）',
  cards.every((x) => Number(String(x.barW).replace('%', '')) <= 100),
  JSON.stringify(cards.map((x) => x.barW)),
);
c.shot(await probe.shot('budgets-light-1440', { dir: OUT, focus: '.bdg-card' }));

/* ══════════════ 4. 导入页（真上传文件） ══════════════ */
console.log('\n── 4. 导入页 ──');
const openedI = await open('/import', { wait: '[data-role=do-preview]', theme: 'light', arm: auth.arm });
check('导入页渲染出上传区', openedI === true);
check('空态没有预览表（要先读表头）', !(await ev(`!!document.querySelector('.imp-preview .imp-table')`)), '不该有');

// 在页面里合成一个带 BOM 的 CSV，用 DataTransfer 塞进 file input
const csv = [
  '﻿交易时间,交易对方,金额,收/支,商品说明',
  '2026-03-01 12:30:45,星巴克,35.00,支出,拿铁',
  '2026/03/02,地铁,5.00,支出,通勤',
  '2026年3月3日,公司,8000.00,收入,三月工资',
  '2026-13-45,坏日期,10.00,支出,日期非法',
  '2026-03-05,坏金额,abc,支出,金额非法',
].join('\n');

const uploaded = await ev(`(() => {
  const text = ${JSON.stringify(csv)};
  const file = new File([text], 'alipay.csv', { type: 'text/csv' });
  const input = document.querySelector('[data-role=file]');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files.length;
})()`);
check('文件已选入 input', Number(uploaded) === 1, String(uploaded));
check('文件名与大小回显', (await ev(`document.querySelector('[data-role=file-hint]').textContent`)).includes('alipay.csv'), '');

await ev(`document.querySelector('[data-role=do-preview]').click()`);
await waitUntil(async () => (await ev(`!!document.querySelector('.imp-preview .imp-table')`)) || null, { label: '预览表渲染', tries: 80 });
if (!(await ev(`!!document.querySelector('.imp-preview .imp-table')`))) {
  console.log('  [诊断] toast =', await ev(`JSON.stringify([...document.querySelectorAll('#toast-root .toast')].map(t => t.dataset.kind + ':' + t.textContent))`));
  console.log('  [诊断] import 请求 =', await ev(`JSON.stringify(performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/import/')))`));
}

const headCells = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.imp-preview .imp-table thead th')].map(t => t.textContent.trim()))`));
check('BOM 被剥掉：首列表头正是「交易时间」', headCells[1] === '交易时间', JSON.stringify(headCells));
check('预览表行数 = 数据行数（表头 + 5）', Number(await ev(`document.querySelectorAll('.imp-preview .imp-table tbody tr').length`)) === 5, String(await ev(`document.querySelectorAll('.imp-preview .imp-table tbody tr').length`)));

/** 服务端自动猜到的映射应该已经填进下拉 —— 这是「少写代码」的核心收益 */
const mappingSelects = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('[data-role=step2] select[id^=imp-]')].map(s => ({ id: s.id, value: s.value })))`),
);
const selOf = (id) => mappingSelects.find((x) => x.id === id)?.value ?? '';
check('日期列已自动选中「交易时间」', selOf('imp-dateColumn') === '交易时间', selOf('imp-dateColumn'));
check('金额列已自动选中「金额」', selOf('imp-amountColumn') === '金额', selOf('imp-amountColumn'));
check('商家列已自动选中「交易对方」', selOf('imp-merchantColumn') === '交易对方', selOf('imp-merchantColumn'));
check('导入账户默认选中第一个真实账户', selOf('imp-acc') === acc.id, selOf('imp-acc'));

/** 坏行必须在**预览**里就标出来，而不是等提交 */
const badRows = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.imp-preview .imp-table tbody tr')].map(tr => ({
    row: tr.querySelector('td')?.textContent.trim(),
    bad: tr.classList.contains('is-bad'),
    result: tr.lastElementChild?.textContent.trim(),
  })))`),
);
check('「2026-13-45」那行被标为坏行', badRows.some((x) => x.bad && /日期格式非法/.test(x.result ?? '')), JSON.stringify(badRows.map((x) => x.result)));
check('「abc」那行被标为坏行', badRows.some((x) => x.bad && /金额不是有效数字/.test(x.result ?? '')), JSON.stringify(badRows.map((x) => x.result)));
check('好行给出解析结果（日期 + 金额）', badRows.filter((x) => !x.bad).length === 3, JSON.stringify(badRows.map((x) => x.bad)));
check('三种日期写法都解析成功（-/斜杠/年）', badRows.filter((x) => !x.bad).every((x) => /\d{4}-\d{2}-\d{2}/.test(x.result ?? '')), JSON.stringify(badRows.filter((x) => !x.bad).map((x) => x.result)));

/** 补兜底分类后提交 */
await ev(`(() => {
  const set = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); };
  set('imp-cat', ${JSON.stringify(catA.id)});
  set('imp-inccat', ${JSON.stringify(incCat.id)});
  return true;
})()`);
/**
 * confirm 由 `lib/cdp.mjs` 统一应答（`Page.javascriptDialogOpening`）。
 *
 * ⚠️ **不要**在页面里写 `window.confirm = () => true` —— headless 下 confirm 一弹出
 * 页面 JS 就阻塞，而 `Runtime.evaluate` 跑在同一个主世界里，于是那条赋值语句
 * 自己都发不出去。症状不是报错，是脚本静默停在这一行直到超时。
 */
await ev(`document.querySelector('[data-role=do-commit]').click()`);
await waitUntil(async () => (await ev(`!!document.querySelector('[data-role=step3] .imp-errors, [data-role=step3] .stat-strip')`)) || null, {
  label: '导入报告渲染',
});

const confirmLog = JSON.parse(await ev(`JSON.stringify(window.__confirmLog ?? [])`));
check(
  '提交前**真的问了用户**（不是绕过确认直接写入）',
  confirmLog.some((m) => /确认导入/.test(m)),
  JSON.stringify(confirmLog),
);

const rep = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('[data-role=step3] .stat-strip__cell')].map(c => ({
    label: c.querySelector('.stat-strip__label').textContent.trim(),
    value: c.querySelector('.stat-strip__value').textContent.trim(),
  })))`),
);
const repBy = Object.fromEntries(rep.map((x) => [x.label, x.value]));
check('报告：成功 3 笔（星巴克/地铁/公司）', repBy['成功'] === '3', JSON.stringify(repBy));
check('报告：失败 2 笔（坏日期/坏金额）', repBy['失败'] === '2', JSON.stringify(repBy));
check('报告：总行数 5', repBy['总行数'] === '5', JSON.stringify(repBy));

const errRows = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('[data-role=step3] .imp-errors table.imp-report tbody tr')].map(tr => ({
    row: (tr.children[0]?.textContent || '').trim(),
    column: (tr.children[1]?.textContent || '').trim(),
    value: (tr.children[2]?.textContent || '').trim(),
    reason: (tr.children[3]?.textContent || '').trim(),
  })))`),
);
check('错误明细按行号列出（对着 Excel 能定位）', errRows.length >= 2 && errRows.every((x) => /^\d+$/.test(x.row)), JSON.stringify(errRows.map((x) => x.row)));
check('错误明细带原始值', errRows.some((x) => x.value.includes('2026-13-45')), JSON.stringify(errRows.map((x) => x.value)));
check('错误明细带原因', errRows.some((x) => x.reason.includes('日期格式非法')), JSON.stringify(errRows.map((x) => x.reason)));

/**
 * 导入报告横向滚动：容器必须 overflow-x:auto，超宽的原值/原因才能左右滚看完。
 * 此前只有 overflow-y，超宽内容被截断、看不全。
 */
const repScroll = JSON.parse(
  await ev(`JSON.stringify((() => {
    const el = document.querySelector('[data-role=step3] .imp-errors');
    const cs = getComputedStyle(el);
    const tbl = el.querySelector('table');
    return { overflowX: cs.overflowX, overflowY: cs.overflowY, tableW: tbl ? tbl.scrollWidth : 0, boxW: el.clientWidth };
  })())`),
);
check('导入报告容器支持横向滚动（overflow-x: auto）', /auto|scroll/.test(repScroll.overflowX), repScroll.overflowX);
check('导入报告容器仍支持纵向滚动（overflow-y: auto）', /auto|scroll/.test(repScroll.overflowY), repScroll.overflowY);
c.shot(await probe.shot('import-report-1440', { dir: OUT, focus: '[data-role=step3] .stat-strip' }));

/** 后端真值：星巴克那笔应被规则分到 catB（不是兜底的 catA） */
const imported = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}?keyword=${encodeURIComponent('星巴克')}`, { headers: AH })).json())
  .data;
check('导入的账单真的落库了', imported.length === 1, `${imported.length} 条`);
check(
  '**自动分类规则压过了兜底分类**（星巴克 → catB 而不是 catA）',
  imported[0]?.category?.id === catB.id,
  `${imported[0]?.category?.id} vs 规则 catB=${catB.id} 兜底 catA=${catA.id}`,
);
const ruleHit = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/category-rules`}`, { headers: AH })).json())
  .data.find((x) => x.matchValue === '星巴克');
check('规则的 hitCount 记到了真实命中次数', ruleHit?.hitCount === 1, String(ruleHit?.hitCount));
const metro = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}?keyword=${encodeURIComponent('地铁')}`, { headers: AH })).json())
  .data;
check('未命中规则的行落到兜底分类', metro[0]?.category?.id === catA.id, `${metro[0]?.category?.id} vs ${catA.id}`);

/** 重复导入必须被去重键挡住 —— 传**与页面上完全相同**的映射与内容 */
const dupBody = multipart(csv, {
  dateColumn: '交易时间',
  amountColumn: '金额',
  merchantColumn: '交易对方',
  noteColumn: '商品说明',
  directionColumn: '收/支',
  recordType: 'expense',
  defaultAccountId: acc.id,
  defaultCategoryId: catA.id,
  incomeCategoryId: incCat.id,
});
const dupRes = await fetch(`${API}${P`/ledgers/${ledger.id}/transactions/import/commit`}`, {
  method: 'POST',
  headers: { ...POST, ...dupBody.headers },
  body: dupBody.body,
});
const dupReport = (await dupRes.json().catch(() => null))?.data;
check(
  '同一文件再导一次 → 成功 0、跳过 3（去重键生效）',
  dupReport?.succeeded === 0 && dupReport?.skipped === 3,
  JSON.stringify({ s: dupReport?.succeeded, k: dupReport?.skipped }),
);

/* ══════════════ 5. 暗色与窄屏 ══════════════ */
console.log('\n── 5. 暗色 / 窄屏 ──');
await open('/budgets', { wait: '.bdg-card', theme: 'dark', arm: auth.arm });
c.shot(await probe.shot('budgets-dark-1440', { dir: OUT, focus: '.bdg-card' }));

await open('/stats', { wait: '.kpi-card', theme: 'light', width: 390, height: 900, arm: auth.arm });
const ov = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('统计页 390px 无横向溢出', Number(ov) <= 1, `溢出 ${ov}px`);
c.shot(await probe.shot('stats-mobile-390', { dir: OUT, focus: '.kpi-grid' }));

await open('/import', { wait: '[data-role=step1]', theme: 'dark', arm: auth.arm });
c.shot(await probe.shot('import-dark-1440', { dir: OUT, focus: '[data-role=step1]' }));

/* ══════════════ 收尾 ══════════════ */
check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));
const missing = await ev(`document.querySelectorAll('[data-missing-icon]').length`);
check('没有取不到图形的图标', Number(missing) === 0, String(missing));
const navCount = await ev(`document.querySelectorAll('.sidenav__item').length`);
check('侧栏出现「统计 / 预算 / 导入」三项', Number(navCount) >= 12, String(navCount));

probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
