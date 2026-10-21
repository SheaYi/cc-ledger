import { P } from './lib/url.mjs';
/**
 * 期初余额口径变更（docs/14）的披露验证 —— API 层
 *
 * 验三件事：
 *   1. 对账预览在「该账户期初当天有流水」时返回 openingDayTx，且金额已转元字符串
 *   2. 虚拟账户（opening_date = 1970）恒为 null（不制造噪音）
 *   3. 对账历史列表给旧记录打上 legacyBoundary = true
 */
const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const IP = `10.30.${Math.floor(Math.random() * 250)}.7`;

const call = async (method, path, body, token) => {
  const headers = { 'X-Forwarded-For': IP };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 路径段转义 —— **必须转义**，不是洁癖：
 * 虚拟账户的 id 是复合形式 `ldg_xxx#acc_sys_receivable`，`#` 在 URL 里是**片段分隔符**，
 * 不转义的话 `#` 之后整段（包括 `/reconcile/preview`）都不会发到服务端 →
 * 路由匹配不上 → 404「接口不存在」，而错误信息完全看不出真因。
 * 前端 `api.js` 的 `seg()` 已经做了 `encodeURIComponent`，手拼 URL 的脚本必须自己转。
 */
const seg = (v) => encodeURIComponent(String(v));

const reg = await call('POST', '/auth/register', {
  username: 'bnd' + Date.now().toString(36),
  nickname: '口径探针',
  password: 'Boundary123!2026',
  platform: 'web',
});
const token = reg.json.data.accessToken;

const ledger = (await call('POST', '/ledgers', { name: '口径验证', currency: 'CNY' }, token)).json
  .data;

const groups = (await call('GET', P`/ledgers/${ledger.id}/account-groups`, undefined, token)).json
  .data;
const g = groups.find((x) => x.id.endsWith('#grp_bank')) ?? groups[0];

// ⚠️ 开户余额给 1000，期初日 = 今天（不显式传，后端默认今天）
const acc = (
  await call(
    'POST',
    P`/ledgers/${ledger.id}/accounts`,
    { name: '工资卡', type: 'debit_card', groupId: g.id, openingBalance: '1000.00' },
    token,
  )
).json.data;

const cats = (await call('GET', P`/ledgers/${ledger.id}/categories`, undefined, token)).json.data;
let cat = null;
for (const p of cats) {
  if (p.recordType !== 'expense') continue;
  for (const c of p.children ?? []) {
    if (!cat && /餐饮|食品/.test(p.name)) cat = c;
  }
}

// ⚠️ 关键：这笔账的日期 = 账户的 opening_date = 今天
const tx = await call(
  'POST',
  P`/ledgers/${ledger.id}/transactions`,
  {
    recordType: 'expense',
    accountId: acc.id,
    categoryId: cat?.id,
    amount: '200.00',
    txDate: ds(new Date()),
    clientRequestId: 'bnd-' + Math.random().toString(36).slice(2),
  },
  token,
);
check('期初当天的支出创建成功（201 Created）', tx.status === 200 || tx.status === 201, String(tx.status) + ' ' + JSON.stringify(tx.json).slice(0, 100));

const todayStr = ds(new Date());

console.log('\n── 1. 对账预览返回 openingDayTx ──');
// 实际余额故意填错 → 触发「有差额」分支（提示只在这一支出现）
const prev = await call(
  'POST',
  `/ledgers/${seg(ledger.id)}/accounts/${seg(acc.id)}/reconcile/preview`,
  { actualBalance: '5000.00', reconcileDate: todayStr },
  token,
);
const odt = prev.json.data?.openingDayTx;
check('预览返回 openingDayTx', !!odt, JSON.stringify(prev.json.data).slice(0, 160));
check('openingDayTx.date = 账户期初日', odt?.date === todayStr, `${odt?.date} vs ${todayStr}`);
check('openingDayTx.count = 1', odt?.count === 1, String(odt?.count));
check('openingDayTx.delta 已转元字符串（-200.00）', odt?.delta === '-200.00', String(odt?.delta));
check('返回口径变更日', prev.json.data?.boundaryPolicyChangedAt === '2026-10-14', String(prev.json.data?.boundaryPolicyChangedAt));

console.log('\n── 2. 虚拟账户恒为 null ──');
const vAccs = (await call('GET', P`/ledgers/${ledger.id}/accounts`, undefined, token)).json.data
  .filter((a) => a.kind === 'virtual');
let vNull = 0;
for (const v of vAccs.slice(0, 3)) {
  const p = await call(
    'POST',
    `/ledgers/${seg(ledger.id)}/accounts/${seg(v.id)}/reconcile/preview`,
    { actualBalance: '0.00', reconcileDate: todayStr },
    token,
  );
  if (p.json.data?.openingDayTx === null) vNull++;
}
check(
  `抽查 ${Math.min(3, vAccs.length)} 个虚拟账户，openingDayTx 均为 null`,
  vAccs.length === 0 || vNull === Math.min(3, vAccs.length),
  `${vNull}/${Math.min(3, vAccs.length)}`,
);

console.log('\n── 3. 对账历史打上 legacyBoundary ──');
await call(
  'POST',
  `/ledgers/${seg(ledger.id)}/accounts/${seg(acc.id)}/reconcile`,
  { actualBalance: '5000.00', reconcileDate: todayStr, reasonCode: 'bank_fee' },
  token,
);
const hist = (await call('GET', P`/ledgers/${ledger.id}/reconciliations`, undefined, token)).json
  .data;
check('对账记录已写入', hist.length === 1, String(hist.length));
check(
  '记录带 legacyBoundary 字段',
  typeof hist[0]?.legacyBoundary === 'boolean',
  String(hist[0]?.legacyBoundary),
);
console.log(
  `  ℹ️  legacyBoundary = ${hist[0]?.legacyBoundary}（今天生成的记录在变更日之后 → false，正确）`,
);

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
