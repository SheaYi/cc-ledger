/**
 * 统计页「账期=所有」+ 趋势时间归集 冒烟测试（真实 HTTP，不使用任何 mock）
 * 用法：node scripts/smoke-stats-range-trend.mjs [baseUrl]
 *
 * ## 为什么要专门测这个
 *
 * 这两个改动都是**静默失效**型：不报错、页面照常渲染，只是数字不对。
 *
 * ① 趋势图曾把**整个区间的金额全累加到第一个桶**。根因是 `trend()` 的 SQL
 *    有 `sum()` / `count()` 却**没有 GROUP BY**：SQLite 于是把区间聚成一行，
 *    `date` 取裸列（未定义取哪行），`expense` 却是全区间总和。按 date 建 Map 时
 *    全部金额挂到那一个日期上 —— 「每日支出趋势」只有第一天有值。
 *    断言「有值的桶个数 == 有交易的日期个数」，缺 GROUP BY 时必然是 1。
 *
 * ② 账期「所有」要求不受时间限制。它不能靠「不传 dateFrom/dateTo」表达，
 *    因为空值的既有语义是**默认本月**；用显式 `all=1` 才不会把所有老调用方
 *    一夜之间从「本月」改成「全部」。这里验证两者确实给出不同的数。
 *
 * ③ 退款必须**相减**（`docs/03 §1.6`）：支出 210 后退款 210，净支出是 0，
 *    而 `SUM(actual_amount)` 得 420。趋势图与 KPI 必须给出同一个 0。
 *
 * ⚠️ 路径插值一律用 P 标签（自动转义），查询串用 qs()。
 * ⚠️ 注释里别写反引号：audit:routes 靠正则抽模板字面量，注释里的字母 P
 *    紧跟反引号会被当成模板路径 → 误判「匹配不到任何路由」。
 */
import { P, qs } from './lib/url.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name} ${extra}`);
  }
}

let ipSeq = Math.floor(Math.random() * 60000);
function nextIp() {
  ipSeq++;
  return `10.88.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

async function call(method, path, { body, token, ip } = {}) {
  const headers = { 'X-Forwarded-For': ip ?? nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (offsetDays) => {
  const x = new Date();
  x.setDate(x.getDate() - offsetDays);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};
const today = isoOf(0);
const monthFrom = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-01`;
const inMonth = (d) => d >= monthFrom && d <= today;

/* =================== 0) 账号与账本 =================== */
const stamp = Date.now().toString(36);
const reg = await call('POST', '/auth/register', {
  body: {
    username: `rt${stamp}`.slice(0, 32),
    nickname: '趋势验证',
    password: 'RangeTrend!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error(`  ❌ 注册失败 ${reg.status} ${JSON.stringify(reg.json)}`);
  process.exit(1);
}
const token = reg.json.data.accessToken;
const ledger = reg.json.data.ledger.id;
console.log(`\n账本 ${ledger} · 今天 ${today} · 本月自 ${monthFrom}`);

/* =================== 1) 造数：三个不同日期 =================== */
const groups = await call('GET', P`/ledgers/${ledger}/account-groups`, { token });
const assetGroup = groups.json.data.find((g) => g.kind === 'asset');
const bank = (
  await call('POST', P`/ledgers/${ledger}/accounts`, {
    token,
    body: { groupId: assetGroup.id, name: '趋势验证卡', type: 'debit_card', openingBalance: '100000.00', openingDate: monthFrom },
  })
).json.data;

const expCats = await call('GET', P`/ledgers/${ledger}/categories` + qs({ recordType: 'expense' }), { token });
const foodParent = expCats.json.data.find((c) => c.children?.length) ?? expCats.json.data[0];
const foodSub = foodParent.children[0];

async function mkTx(body, txDate) {
  const r = await call('POST', P`/ledgers/${ledger}/transactions`, {
    token,
    body: { accountId: bank.id, categoryId: foodSub.id, ...body, txDate },
  });
  if (r.status !== 201) console.error(`  ❌ 建单失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}

/** 三笔支出散布在三个日期：今天-1、今天-3、今天-40（最后一笔落在上月） */
const D1 = isoOf(1);
const D2 = isoOf(3);
const D3 = isoOf(40);
await mkTx({ recordType: 'expense', name: '近支出', amount: '10.00' }, D1);
await mkTx({ recordType: 'expense', name: '中支出', amount: '20.00' }, D2);
await mkTx({ recordType: 'expense', name: '远支出', amount: '30.00' }, D3);

/** 落在本月内的不同日期（去重）—— 期望有值的桶个数 */
const monthDays = [...new Set([D1, D2, D3].filter(inMonth))];
const monthSum = [D1, D2, D3]
  .filter(inMonth)
  .reduce((n, d) => n + (d === D1 ? 10 : d === D2 ? 20 : 30), 0);
console.log(`造数：${D1}=10 · ${D2}=20 · ${D3}=30 ；本月内有交易的日期 ${monthDays.length} 个，合计 ${monthSum}`);

const trend = async (q) => {
  const r = await call('GET', P`/ledgers/${ledger}/stats/trend` + qs(q), { token });
  return r.json.data ?? [];
};
const summary = async (q) => {
  const r = await call('GET', P`/ledgers/${ledger}/stats/summary` + qs(q), { token });
  return r.json.data ?? {};
};

/* =================== 2) 趋势按日期归集（核心回归）=================== */
console.log('\n=== 每日趋势：按实际交易日期归集 ===');
const daily = await trend({ dateFrom: monthFrom, dateTo: today, granularity: 'day' });
const nonZero = daily.filter((b) => Number(b.expense ?? 0) > 0);
check(
  `有值的桶个数 = 有交易的日期个数（${monthDays.length}）`,
  nonZero.length === monthDays.length,
  `got ${nonZero.length} · ${JSON.stringify(daily.slice(0, 6))}`,
);
check(
  '不是「全部金额堆在第一天」',
  !(daily.length > 1 && Number(daily[0].expense ?? 0) === monthSum && monthSum > 0 && monthDays.length > 1),
  JSON.stringify(daily.slice(0, 3)),
);
for (const d of monthDays) {
  const bucket = daily.find((b) => b.period === d);
  const want = d === D1 ? '10.00' : d === D2 ? '20.00' : '30.00';
  check(`${d} 支出 = ${want}`, bucket?.expense === want, `got ${bucket?.expense}`);
}
/** 缺失日期补 0：区间内没有交易的某天必须是 0 而不是 undefined */
const quiet = daily.find((b) => !monthDays.includes(b.period));
check('缺失日期补 0（不是 undefined / 不是累加值）', quiet === undefined || Number(quiet.expense ?? 0) === 0, `got ${quiet?.expense}`);
const dailySum = daily.reduce((n, b) => n + Number(b.expense ?? 0), 0);
check(`每日趋势合计 = ${monthSum}（不重复不遗漏）`, dailySum === monthSum, `got ${dailySum}`);

/* =================== 3) 月度趋势 =================== */
console.log('\n=== 月度趋势：各月独立归集 ===');
const monthly = await trend({ dateFrom: isoOf(400), dateTo: today, granularity: 'month' });
const mNonZero = monthly.filter((b) => Number(b.expense ?? 0) > 0);
check('月度桶数量 > 1（不是全堆在第一个月）', mNonZero.length >= 1 && monthly.length > 1, `got ${JSON.stringify(monthly.map((b) => b.period + ':' + b.expense))}`);
check('月度趋势合计 = 60（10 + 20 + 30）', monthly.reduce((n, b) => n + Number(b.expense ?? 0), 0) === 60, `got ${JSON.stringify(monthly)}`);
const firstMonthAll = monthly.length > 1 && Number(monthly[0].expense ?? 0) === 60;
check('月度：不是「全部金额堆在第一个月」', !firstMonthAll, JSON.stringify(monthly.slice(0, 3)));

/* =================== 4) 账期「所有」 =================== */
console.log('\n=== 账期「所有」：不受时间范围限制 ===');
const monthSummary = await summary({ dateFrom: monthFrom, dateTo: today });
const allSummary = await summary({ all: '1' });
check(`本月支出 = ${monthSum}.00`, monthSummary.totalExpense === `${monthSum}.00`, `got ${monthSummary.totalExpense}`);
check('所有支出 = 60.00（含上月那笔 30）', allSummary.totalExpense === '60.00', `got ${allSummary.totalExpense}`);
check('「所有」与「本月」确实不同（证明 all 生效）', allSummary.totalExpense !== monthSummary.totalExpense, `${allSummary.totalExpense} vs ${monthSummary.totalExpense}`);
check('「所有」返回 allMode = true', allSummary.allMode === true, `got ${allSummary.allMode}`);
check('「所有」的 dateRange 为空串', allSummary.dateRange?.from === '' && allSummary.dateRange?.to === '', JSON.stringify(allSummary.dateRange));
/** 日均不能是 NaN —— 空区间喂给 daysInRange 会得到 NaN */
check('「所有」的日均支出是数字（不是 NaN）', Number.isFinite(Number(allSummary.dailyExpense)), `got ${allSummary.dailyExpense}`);

const allTrend = await trend({ all: '1', granularity: 'day' });
check(
  '「所有」趋势合计 = 60（三笔都在）',
  allTrend.reduce((n, b) => n + Number(b.expense ?? 0), 0) === 60,
  `got ${JSON.stringify(allTrend.map((b) => b.period + ':' + b.expense))}`,
);
check('「所有」趋势桶数 ≥ 3（跨度按首末笔铺开）', allTrend.length >= 3, `got ${allTrend.length}`);

/* =================== 5) 退款必须相减 =================== */
console.log('\n=== 退款冲减（docs/03 §1.6）===');
const beforeRefund = await summary({ dateFrom: monthFrom, dateTo: today });
await mkTx({ recordType: 'expense', name: '可退支出', amount: '210.00' }, D1);
await mkTx({ recordType: 'expense', name: '退款', amount: '210.00', isRefund: true }, D1);
const afterRefund = await summary({ dateFrom: monthFrom, dateTo: today });
const expBefore = Number(beforeRefund.totalExpense ?? 0);
const expAfter = Number(afterRefund.totalExpense ?? 0);
check(
  '支出 210 + 退款 210 → 净支出不变（不是 +210，也不是 +420）',
  Math.abs(expAfter - expBefore) < 0.005,
  `before ${expBefore} · after ${expAfter}`,
);
const d1After = (await trend({ dateFrom: monthFrom, dateTo: today, granularity: 'day' })).find((b) => b.period === D1);
check(
  '趋势图同一天也把退款相减（与 KPI 同口径）',
  d1After !== undefined && Number(d1After.expense ?? 0) === 10,
  `got ${d1After?.expense}`,
);

/* =================== 6) 无数据边界 =================== */
console.log('\n=== 边界：区间内无数据 ===');
/**
 * ⚠️ 必须用一个**肯定没有账单**的区间，而不是复用上面造过数的账本 ——
 * 那账本有 60 元的支出，「无数据」断言当然会红。
 */
const empty = await summary({ dateFrom: '2001-01-01', dateTo: '2001-01-31' });
check('无数据：支出 = 0.00', empty.totalExpense === '0.00', `got ${empty.totalExpense}`);
check('无数据：收入 = 0.00', empty.totalIncome === '0.00', `got ${empty.totalIncome}`);
check('无数据：净额 = 0.00', empty.netAmount === '0.00', `got ${empty.netAmount}`);
check('无数据：折扣 = 0.00', empty.totalDiscount === '0.00', `got ${empty.totalDiscount}`);
check('无数据：手续费 = 0.00', empty.totalFee === '0.00', `got ${empty.totalFee}`);
check('无数据：日均不出现 NaN', Number.isFinite(Number(empty.dailyExpense)), `got ${empty.dailyExpense}`);

console.log('\n=== 边界：空账本 + 「所有」（actualSpan 无数据兜底）===');
const reg2 = await call('POST', '/auth/register', {
  body: {
    username: `re${Date.now().toString(36)}`.slice(0, 32),
    nickname: '空账本',
    password: 'EmptyLedger!2026',
    platform: 'web',
  },
});
const token2 = reg2.json.data?.accessToken;
const ledger2 = reg2.json.data?.ledger?.id;
check('注册到第二个账号', Boolean(token2 && ledger2), JSON.stringify(reg2.json).slice(0, 120));
if (token2 && ledger2) {
  const r2 = await call('GET', P`/ledgers/${ledger2}/stats/summary` + qs({ all: '1' }), { token: token2 });
  const s2 = r2.json.data ?? {};
  check('空账本：支出 = 0.00', s2.totalExpense === '0.00', `got ${s2.totalExpense}`);
  check('空账本：净额 = 0.00', s2.netAmount === '0.00', `got ${s2.netAmount}`);
  /** actualSpan 在没有任何账单时退化成「今天」，天数必须是 1 而不是 NaN */
  check('空账本：区间天数 = 1（不是 NaN）', s2.periodDays === 1, `got ${s2.periodDays}`);
  check('空账本：日均 = 0.00（不是 NaN）', s2.dailyExpense === '0.00', `got ${s2.dailyExpense}`);
  const t2 = await call('GET', P`/ledgers/${ledger2}/stats/trend` + qs({ all: '1', granularity: 'day' }), { token: token2 });
  check('空账本：趋势返回数组而不是崩', Array.isArray(t2.json.data), JSON.stringify(t2.json).slice(0, 120));
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
