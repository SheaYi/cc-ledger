import { P, qs } from './lib/url.mjs';
/**
 * Stage 9 端到端冒烟：债权债务的**结清关联 / 核销 / 未结清视图**
 * （docs/12 §六 D9 / D10 补的三个缺口）。
 *
 * 覆盖重点：
 *   · `direction='write_off'`（坏账核销 / 债务免除）：纯台账冲销，现金与净资产不动
 *   · 结清关联表：部分结清、一次冲抵多笔、超额被拒、类型不匹配被拒
 *   · 「未结清」视图：总额取虚拟台账，逐笔取关联，恒等式成立
 *   · 撤销（软删除）一笔结算 → 该笔债权自动回到未结清
 *   · 三层口径：产生/结算/核销对「现金 · 台账 · 损益」的影响各不相同
 *
 * 用法：node scripts/smoke-stage9.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`);
  }
}

function encodePath(p) {
  const [pathPart, query] = p.split('?');
  const encoded = pathPart
    .split('/')
    .map((s) => (s ? encodeURIComponent(s) : s))
    .join('/');
  return query ? `${encoded}?${query}` : encoded;
}

const FAKE_IP = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(method, path, { body, token } = {}) {
  const headers = { 'X-Forwarded-For': FAKE_IP };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${encodePath(path)}`, {
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

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const yuan = (s) => Math.round(Number(s ?? 0) * 100);

/* =================== 0) 账号 =================== */
const stamp = Date.now().toString(36);
const reg = await call('POST', '/auth/register', {
  body: {
    username: `s9${stamp}`.slice(0, 32),
    nickname: '丙',
    password: 'Smoke9Pass!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  throw new Error(`注册失败 ${reg.status} ${JSON.stringify(reg.json)}`);
}
const token = reg.json.data.accessToken;
const ledger = reg.json.data.ledger.id;
console.log(`\n账号 ledger=${ledger}`);

/* =================== 1) 主数据 =================== */
console.log('\n=== 1) 主数据 ===');
let r = await call('GET', P`/ledgers/${ledger}/account-groups`, { token });
const assetGroup = r.json.data.find((g) => g.kind === 'asset');
r = await call('POST', P`/ledgers/${ledger}/accounts`, {
  token,
  body: {
    groupId: assetGroup.id,
    name: '九号储蓄卡',
    type: 'debit_card',
    openingBalance: '100000.00',
    openingDate: day(-30),
  },
});
const bank = r.json.data;
check('建储蓄卡', r.status === 201);

r = await call('GET', P`/ledgers/${ledger}/accounts`, { token });
const recvAcc = r.json.data.find((a) => a.type === 'receivable');
const payAcc = r.json.data.find((a) => a.type === 'payable');
check('虚拟台账就位', Boolean(recvAcc && payAcc));

const subOf = async (rt) => {
  const x = await call('GET', P`/ledgers/${ledger}/categories` + qs({ recordType: rt }), { token });
  return (x.json.data.find((c) => c.children?.length) ?? x.json.data[0]).children[0];
};
const recvSub = await subOf('receivable');
const paySub = await subOf('payable');

const tx = (body) => call('POST', P`/ledgers/${ledger}/transactions`, { token, body });
const bal = async (id) => (await call('GET', P`/ledgers/${ledger}/accounts/${id}/balance`, { token })).json.data.balance;
const debts = async (q = '') => (await call('GET', P`/ledgers/${ledger}/debts` + q, { token })).json.data;
const settleable = async (rt) =>
  (await call('GET', P`/ledgers/${ledger}/debts/settleable` + qs({ recordType: rt }), { token })).json.data;

/* =================== 2) 产生笔 =================== */
console.log('\n=== 2) 产生：借出 800 / 登记欠款 1200 ===');
let r1 = await tx({
  recordType: 'receivable',
  direction: 'decrease',
  accountId: bank.id,
  categoryId: recvSub.id,
  name: '借给李四',
  counterparty: '李四',
  amount: '800.00',
  txDate: day(-60),
});
const loan = r1.json.data;
check('借出 800 落库', r1.status === 201, `got ${r1.status}`);

let r2 = await tx({
  recordType: 'payable',
  direction: 'none',
  accountId: bank.id,
  categoryId: paySub.id,
  name: '欠房东',
  counterparty: '房东',
  amount: '1200.00',
  txDate: day(-40),
});
const debt = r2.json.data;
check('登记欠款 1200 落库', r2.status === 201, `got ${r2.status}`);
check('登记欠款不动主账户', yuan(r2.json.data.accountDelta) === 0, String(r2.json.data.accountDelta));

let d = await debts();
check(
  '未结清视图：待收 800 / 待付 1200（直接取虚拟台账）',
  yuan(d.summary.totalReceivable) === 80000 && yuan(d.summary.totalPayable) === 120000,
  JSON.stringify(d.summary),
);
check('逐笔两笔都未结清', d.items.length === 2 && d.items.every((i) => yuan(i.outstanding) > 0));
check('净头寸 = 待收 − 待付 = −400', yuan(d.summary.netPosition) === -40000, d.summary.netPosition);

/* =================== 3) 部分结清 =================== */
console.log('\n=== 3) 部分结清：收回 300（关联借出笔） ===');
const cand = await settleable('receivable');
check('「结清哪一笔」候选项给出未结清 800', cand.length === 1 && yuan(cand[0].outstanding) === 80000, JSON.stringify(cand));

let r3 = await tx({
  recordType: 'receivable',
  direction: 'increase',
  accountId: bank.id,
  categoryId: recvSub.id,
  name: '李四还了 300',
  counterparty: '李四',
  amount: '300.00',
  txDate: day(-30),
  settles: [{ transactionId: loan.id, amount: '300.00' }],
});
check('部分结清 300 落库', r3.status === 201, `got ${r3.status} ${JSON.stringify(r3.json?.error ?? '')}`);
check('结算笔回显关联', r3.json.data.settlements?.[0]?.transactionId === loan.id, JSON.stringify(r3.json.data.settlements));

d = await debts();
const loanRow = d.items.find((i) => i.transactionId === loan.id);
check(
  '借出笔：已结清 300 / 未结清 500',
  yuan(loanRow.settled) === 30000 && yuan(loanRow.outstanding) === 50000,
  `${loanRow.settled} / ${loanRow.outstanding}`,
);
check('待收总额降到 500', yuan(d.summary.totalReceivable) === 50000, d.summary.totalReceivable);
check('未归属冲销为 0', yuan(d.summary.unallocatedReceivable) === 0, d.summary.unallocatedReceivable);

/* =================== 4) 一次冲抵多笔 =================== */
console.log('\n=== 4) 一次冲抵多笔 ===');
const loan2 = (
  await tx({
    recordType: 'receivable',
    direction: 'decrease',
    accountId: bank.id,
    categoryId: recvSub.id,
    name: '借给王五',
    counterparty: '王五',
    amount: '600.00',
    txDate: day(-20),
  })
).json.data;
let r4 = await tx({
  recordType: 'receivable',
  direction: 'increase',
  accountId: bank.id,
  categoryId: recvSub.id,
  name: '一次收两笔',
  amount: '900.00',
  txDate: day(-10),
  settles: [
    { transactionId: loan.id, amount: '500.00' },
    { transactionId: loan2.id, amount: '400.00' },
  ],
});
check('一笔结算冲抵两笔', r4.status === 201, `got ${r4.status} ${JSON.stringify(r4.json?.error ?? '')}`);
check('回显两条关联', r4.json.data.settlements?.length === 2, JSON.stringify(r4.json.data.settlements));

d = await debts('?status=all');
const l1 = d.items.find((i) => i.transactionId === loan.id);
const l2 = d.items.find((i) => i.transactionId === loan2.id);
check('借出笔一已结清（800 全清）', yuan(l1.outstanding) === 0, `${l1.settled}/${l1.outstanding}`);
check('借出笔二剩 200', yuan(l2.outstanding) === 20000, `${l2.settled}/${l2.outstanding}`);
check(
  '恒等式：Σ逐笔未结清 + 未归属 = 台账余额（应收）',
  yuan(l1.outstanding) + yuan(l2.outstanding) + yuan(d.summary.unallocatedReceivable) ===
    yuan(d.summary.totalReceivable),
  `${l1.outstanding}+${l2.outstanding}+${d.summary.unallocatedReceivable} vs ${d.summary.totalReceivable}`,
);

/* =================== 5) 六道闸门 =================== */
console.log('\n=== 5) 校验闸门 ===');
let bad = await tx({
  recordType: 'receivable',
  direction: 'increase',
  accountId: bank.id,
  categoryId: recvSub.id,
  amount: '500.00',
  txDate: day(-5),
  settles: [{ transactionId: loan2.id, amount: '500.00' }],
});
check('超额结清被拒 400', bad.status === 400, `got ${bad.status}`);

bad = await tx({
  recordType: 'receivable',
  direction: 'increase',
  accountId: bank.id,
  categoryId: recvSub.id,
  amount: '10.00',
  txDate: day(-5),
  settles: [{ transactionId: 'tx_不存在', amount: '10.00' }],
});
check('关联不存在的账单被拒 400', bad.status === 400, `got ${bad.status}`);

bad = await tx({
  recordType: 'receivable',
  direction: 'increase',
  accountId: bank.id,
  categoryId: recvSub.id,
  amount: '10.00',
  txDate: day(-5),
  settles: [{ transactionId: debt.id, amount: '10.00' }],
});
check('跨类型关联（用应收去冲应付）被拒 400', bad.status === 400, `got ${bad.status}`);

bad = await tx({
  recordType: 'receivable',
  direction: 'decrease',
  accountId: bank.id,
  categoryId: recvSub.id,
  amount: '10.00',
  txDate: day(-5),
  settles: [{ transactionId: loan.id, amount: '10.00' }],
});
check('产生笔不能带 settles 被拒 400', bad.status === 400, `got ${bad.status}`);

bad = await tx({
  recordType: 'receivable',
  direction: 'write_off',
  accountId: bank.id,
  amount: '100.00',
  fee: '1.00',
  txDate: day(-5),
});
check('核销不支持手续费被拒 400', bad.status === 400, `got ${bad.status}`);

/* =================== 6) 核销 =================== */
console.log('\n=== 6) 核销：剩余 200 坏账 + 欠款 1200 免除 200 ===');
const bankBefore = await bal(bank.id);
const summaryBefore = (await call('GET', P`/ledgers/${ledger}/transactions` + qs({ pageSize: 1 }), { token })).json.meta
  .summary;

let r5 = await tx({
  recordType: 'receivable',
  direction: 'write_off',
  accountId: bank.id,
  name: '李四赖账',
  counterparty: '李四',
  amount: '200.00',
  txDate: day(-3),
  settles: [{ transactionId: loan2.id, amount: '200.00' }],
});
check('坏账核销 200 落库', r5.status === 201, `got ${r5.status} ${JSON.stringify(r5.json?.error ?? '')}`);
check('核销不动主账户', yuan(r5.json.data.accountDelta) === 0, String(r5.json.data.accountDelta));
check('核销冲减债权台账', yuan(r5.json.data.toAccountDelta) === -20000, String(r5.json.data.toAccountDelta));

let r6 = await tx({
  recordType: 'payable',
  direction: 'write_off',
  accountId: bank.id,
  name: '房东免了 200',
  counterparty: '房东',
  amount: '200.00',
  txDate: day(-2),
  settles: [{ transactionId: debt.id, amount: '200.00' }],
});
check('债务免除 200 落库', r6.status === 201, `got ${r6.status}`);

const bankAfter = await bal(bank.id);
check(
  '核销不动现金（前后余额一致）',
  yuan(bankAfter) === yuan(bankBefore),
  `${bankBefore} → ${bankAfter}`,
);
const summaryAfter = (await call('GET', P`/ledgers/${ledger}/transactions` + qs({ pageSize: 1 }), { token })).json.meta
  .summary;
check(
  '核销不进损益（净结余不变）',
  yuan(summaryAfter.netBalance) === yuan(summaryBefore.netBalance),
  `${summaryBefore.netBalance} → ${summaryAfter.netBalance}`,
);

d = await debts();
check('待收归零', yuan(d.summary.totalReceivable) === 0, d.summary.totalReceivable);
check('待付剩 1000', yuan(d.summary.totalPayable) === 100000, d.summary.totalPayable);
check(
  '核销后：应收逐笔全清、仅剩应付 1000 未结清',
  d.items
    .filter((i) => i.recordType === 'receivable')
    .every((i) => yuan(i.outstanding) === 0) && d.summary.openCount === 1,
  JSON.stringify({ open: d.summary.openCount, recv: d.items.filter((i) => i.recordType === 'receivable').map((i) => i.outstanding) }),
);

/* =================== 7) 撤销一笔结算 → 未结清回涨 =================== */
console.log('\n=== 7) 撤销结算笔 → 未结清自动回涨 ===');
await call('DELETE', P`/ledgers/${ledger}/transactions/${r3.json.data.id}`, { token });
d = await debts('?status=all');
const backRow = d.items.find((i) => i.transactionId === loan.id);
check(
  '撤销「收回 300」后借出笔回到未结清 300',
  yuan(backRow.outstanding) === 30000,
  `${backRow.settled}/${backRow.outstanding}`,
);
check(
  '待收总额回涨到 300',
  yuan(d.summary.totalReceivable) === 30000,
  d.summary.totalReceivable,
);
check(
  '恒等式仍成立（撤销后）',
  d.items.filter((i) => i.recordType === 'receivable').reduce((s, i) => s + yuan(i.outstanding), 0) +
    yuan(d.summary.unallocatedReceivable) ===
    yuan(d.summary.totalReceivable),
  JSON.stringify({ items: d.items.map((i) => i.outstanding), un: d.summary.unallocatedReceivable, total: d.summary.totalReceivable }),
);

/* =================== 8) 未归属冲销 =================== */
console.log('\n=== 8) 未归属冲销 ===');
await tx({
  recordType: 'receivable',
  direction: 'increase',
  accountId: bank.id,
  categoryId: recvSub.id,
  amount: '50.00',
  txDate: day(-1),
});
d = await debts();
check(
  '不关联的结算笔计入「未归属冲销」而不是消失',
  yuan(d.summary.unallocatedReceivable) === 5000,
  d.summary.unallocatedReceivable,
);

/* =================== 9) status=all 与已结清归档 =================== */
console.log('\n=== 9) 视图筛选 ===');
const all = await debts('?status=all');
const open = await debts('');
check('status=all 列出全部产生笔', all.items.length >= 2, String(all.items.length));
check('默认只列未结清', open.items.length <= all.items.length, `${open.items.length} vs ${all.items.length}`);
check(
  '排序：未结清在前、其次最久的在前',
  open.items.length === 0 || yuan(open.items[0].outstanding) > 0,
  JSON.stringify(open.items.slice(0, 2).map((i) => [i.outstanding, i.ageDays])),
);
check(
  '已结清计数 = 1（借出笔二被核销清零；借出笔一因撤销回到未结清）',
  all.summary.clearedCount === 1,
  String(all.summary.clearedCount),
);

/* =================== 汇总 =================== */
console.log('\n========================================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  ❌', f));
}
console.log('========================================');
process.exit(fail ? 1 : 0);
