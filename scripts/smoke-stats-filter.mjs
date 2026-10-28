/**
 * 统计页筛选生效冒烟测试（真实 HTTP，不使用任何 mock）
 * 用法：node scripts/smoke-stats-filter.mjs [baseUrl]
 *
 * ## 为什么要专门测这个
 *
 * 统计页的「来源 / 类型 / 分类」筛选曾经**完全不生效**，而且不报错：
 * 前端确实把 `accountId / categoryId / recordType` 发到了 URL 上，
 * 但 `/stats/summary` 等路由只取了 `dateFrom / dateTo / keyword`，
 * 其余参数**在路由层被丢掉**，聚合查询照常跑、结果照常返回 —— 只是
 * 和没筛选时一模一样。
 *
 * 这类失效最难被发现：页面不红、不报错、数字也「看着合理」，
 * 用户只能得出「这个软件算错了」的结论。
 *
 * 所以这里对**每个筛选维度**都造数据、逐个加筛选、断言数字真的变了。
 * 任何一层把参数丢了，断言立刻红。
 *
 * ⚠️ 路径插值一律用 P 标签（自动转义），查询串用 qs() ——
 * 虚拟账户 id 含 #，不转义会被当成 URL 片段截断。
 *
 * ⚠️ 注释里**别写反引号**：audit:routes 靠正则抽「模板字面量」，
 * 注释里出现字母 P 紧跟反引号会被当成一个模板路径 → 判成「匹配不到任何路由」。
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

/**
 * 每次调用默认使用不同来源 IP，避免被限流互相干扰（trustProxy 已开启）。
 *
 * ⚠️ 起点必须随机：写死 0 时连跑两遍会重放同一串 IP ——
 * 注册限流是「每 IP 每小时 N 次」，于是第二遍开头就 429。
 */
let ipSeq = Math.floor(Math.random() * 60000);
function nextIp() {
  ipSeq++;
  return `10.77.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
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

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const to = today;

/* =================== 0)账号与账本 =================== */
const stamp = Date.now().toString(36);
const reg = await call('POST', '/auth/register', {
  body: {
    username: `sf${stamp}`.slice(0, 32),
    nickname: '筛选验证',
    password: 'StatsFilter!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error(`  ❌ 注册失败 ${reg.status} ${JSON.stringify(reg.json)}`);
  process.exit(1);
}
const token = reg.json.data.accessToken;
const ledger = reg.json.data.ledger.id;
console.log(`\n账本 ${ledger} · 区间 ${from} ~ ${to}`);

/* =================== 1) 造数 =================== */
const groups = await call('GET', P`/ledgers/${ledger}/account-groups`, { token });
const assetGroup = groups.json.data.find((g) => g.kind === 'asset');

async function mkAccount(name) {
  const r = await call('POST', P`/ledgers/${ledger}/accounts`, {
    token,
    body: { groupId: assetGroup.id, name, type: 'debit_card', openingBalance: '10000.00', openingDate: from },
  });
  return r.json.data;
}
const bank = await mkAccount('筛选验证储蓄卡');
const wallet = await mkAccount('筛选验证零钱');

const expCats = await call('GET', P`/ledgers/${ledger}/categories` + qs({ recordType: 'expense' }), { token });
const foodParent = expCats.json.data.find((c) => c.children?.length) ?? expCats.json.data[0];
const foodSub = foodParent.children[0];
const incCats = await call('GET', P`/ledgers/${ledger}/categories` + qs({ recordType: 'income' }), { token });
const incomeSub = (incCats.json.data.find((c) => c.children?.length) ?? incCats.json.data[0]).children[0];
check('取到支出一级/二级与收入二级分类', Boolean(foodSub && incomeSub));

async function mkTx(body) {
  const r = await call('POST', P`/ledgers/${ledger}/transactions`, {
    token,
    body: { ...body, txDate: today },
  });
  if (r.status !== 201) console.error(`  ❌ 建单失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}
/** 支出 32.00（折 2.00 → 实际 30.00）在 bank / 餐饮 */
await mkTx({ recordType: 'expense', accountId: bank.id, categoryId: foodSub.id, name: '验证午餐', amount: '32.00', discount: '2.00' });
/** 支出 10.00 在 wallet / 餐饮 */
await mkTx({ recordType: 'expense', accountId: wallet.id, categoryId: foodSub.id, name: '验证晚餐', amount: '10.00' });
/** 收入 100.00 在 bank / 工资 */
await mkTx({ recordType: 'income', accountId: bank.id, categoryId: incomeSub.id, name: '验证工资', amount: '100.00' });

const summary = async (q) => {
  const r = await call('GET', P`/ledgers/${ledger}/stats/summary` + qs({ dateFrom: from, dateTo: to, ...q }), { token });
  return r.json.data;
};

/* =================== 2) 基线（不带筛选）=================== */
console.log('\n=== 基线 · 不带筛选 ===');
const base = await summary({});
check('支出 = 40.00（30.00 + 10.00）', base.totalExpense === '40.00', `got ${base.totalExpense}`);
check('收入 = 100.00', base.totalIncome === '100.00', `got ${base.totalIncome}`);
check('录入总额 = 142.00（32 + 10 + 100）', base.totalRecorded === '142.00', `got ${base.totalRecorded}`);
check('折扣合计 = 2.00', base.totalDiscount === '2.00', `got ${base.totalDiscount}`);
check('手续费合计 = 0.00', base.totalFee === '0.00', `got ${base.totalFee}`);
check('净额 = 140.00（录入 + 手续费 − 折扣）', base.netAmount === '140.00', `got ${base.netAmount}`);

/* =================== 3) 来源账户 =================== */
console.log('\n=== 来源账户 · accountId ===');
const byBank = await summary({ accountId: bank.id });
check('bank 支出 = 30.00', byBank.totalExpense === '30.00', `got ${byBank.totalExpense}`);
check('bank 收入 = 100.00', byBank.totalIncome === '100.00', `got ${byBank.totalIncome}`);
check('bank 录入总额 = 132.00', byBank.totalRecorded === '132.00', `got ${byBank.totalRecorded}`);
const byWallet = await summary({ accountId: wallet.id });
check('wallet 支出 = 10.00', byWallet.totalExpense === '10.00', `got ${byWallet.totalExpense}`);
check('wallet 收入 = 0.00', byWallet.totalIncome === '0.00', `got ${byWallet.totalIncome}`);
check('wallet 录入总额 = 10.00', byWallet.totalRecorded === '10.00', `got ${byWallet.totalRecorded}`);

/* =================== 4) 分类 =================== */
console.log('\n=== 分类 · categoryId / parentCategoryId ===');
const bySub = await summary({ categoryId: foodSub.id });
check('二级分类 支出 = 40.00', bySub.totalExpense === '40.00', `got ${bySub.totalExpense}`);
check('二级分类 收入 = 0.00', bySub.totalIncome === '0.00', `got ${bySub.totalIncome}`);
check('二级分类 录入总额 = 42.00', bySub.totalRecorded === '42.00', `got ${bySub.totalRecorded}`);
const byParent = await summary({ parentCategoryId: foodParent.id });
check('一级分类 支出 = 40.00', byParent.totalExpense === '40.00', `got ${byParent.totalExpense}`);
check('一级分类 录入总额 = 42.00', byParent.totalRecorded === '42.00', `got ${byParent.totalRecorded}`);

/* =================== 5) 类型 =================== */
console.log('\n=== 类型 · recordType ===');
const onlyExpense = await summary({ recordType: 'expense' });
check('仅支出：支出 = 40.00', onlyExpense.totalExpense === '40.00', `got ${onlyExpense.totalExpense}`);
check('仅支出：收入 = 0.00', onlyExpense.totalIncome === '0.00', `got ${onlyExpense.totalIncome}`);
check('仅支出：录入总额 = 42.00', onlyExpense.totalRecorded === '42.00', `got ${onlyExpense.totalRecorded}`);
check('仅支出：折扣合计 = 2.00', onlyExpense.totalDiscount === '2.00', `got ${onlyExpense.totalDiscount}`);
const onlyIncome = await summary({ recordType: 'income' });
check('仅收入：收入 = 100.00', onlyIncome.totalIncome === '100.00', `got ${onlyIncome.totalIncome}`);
check('仅收入：支出 = 0.00', onlyIncome.totalExpense === '0.00', `got ${onlyIncome.totalExpense}`);
check('仅收入：录入总额 = 100.00', onlyIncome.totalRecorded === '100.00', `got ${onlyIncome.totalRecorded}`);

/* =================== 6) 组合 =================== */
console.log('\n=== 组合筛选 ===');
const combo = await summary({ accountId: bank.id, recordType: 'expense' });
check('bank + 支出：支出 = 30.00', combo.totalExpense === '30.00', `got ${combo.totalExpense}`);
check('bank + 支出：录入总额 = 32.00', combo.totalRecorded === '32.00', `got ${combo.totalRecorded}`);

/* =================== 7) 其它统计端点 =================== */
console.log('\n=== 其它统计端点也响应筛选 ===');
const trend = await call(
  'GET',
  P`/ledgers/${ledger}/stats/trend` + qs({ dateFrom: from, dateTo: to, granularity: 'day', accountId: bank.id }),
  { token },
);
const trendExpense = trend.json.data.reduce((n, x) => n + Number(x.expense ?? 0), 0);
check('trend 按账户过滤后支出合计 = 30', trendExpense === 30, `got ${trendExpense}`);

const cat = await call(
  'GET',
  P`/ledgers/${ledger}/stats/by-category` + qs({ dateFrom: from, dateTo: to, recordType: 'expense', level: '1', accountId: wallet.id }),
  { token },
);
const catSum = cat.json.data.reduce((n, x) => n + Number(x.amount ?? 0), 0);
check('by-category 按账户过滤后合计 = 10', catSum === 10, `got ${catSum}`);

const acc = await call(
  'GET',
  P`/ledgers/${ledger}/stats/by-account` + qs({ dateFrom: from, dateTo: to, categoryId: foodSub.id }),
  { token },
);
check(
  'by-account 按分类过滤后仍有账户维度数据',
  Array.isArray(acc.json.data) && acc.json.data.length > 0,
  JSON.stringify(acc.json.data).slice(0, 120),
);

const cmp = await call(
  'GET',
  P`/ledgers/${ledger}/stats/comparison` + qs({ dateFrom: from, dateTo: to, accountId: bank.id }),
  { token },
);
check(
  'comparison 上一期也按账户过滤',
  cmp.json.data?.previous?.expense !== undefined,
  JSON.stringify(cmp.json.data?.previous ?? {}).slice(0, 120),
);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
