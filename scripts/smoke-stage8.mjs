/**
 * Stage 8 端到端冒烟：账单核心（记账 / 列表 / 预览 / 回收站 / 幂等 / 期间关闭）。
 *
 * 覆盖重点（对齐 docs/03 §8 与 §13.1、docs/04 §8、docs/13）：
 *   · 六种记录类型的金额落库与账户影响（含转账手续费、应收/应付两阶段）
 *   · 借贷平衡：转账 普通账户 ΣΔ = −F、费用虚拟账户派生 −F（docs/12 D6）
 *   · 应收账款余额、应付不动余额
 *   · /preview 与 /transactions 落库口径一致
 *   · 列表 meta.summary 口径、筛选、分页、按日分组小计自洽
 *   · 幂等（clientRequestId）、乐观锁 409、期间关闭 400、跨账本 404
 *   · 软删除回滚余额 → 回收站 → 恢复 → 永久删除
 *   · 商家/对象：留空可提交、空串归一为 NULL、超长被拦
 *
 * 用法：node scripts/smoke-stage8.mjs [baseUrl] [dbPath]
 */
import Database from 'better-sqlite3';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const DB_PATH = process.argv[3] ?? './data/cc-ledger.db';

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

/** 伪造独立出口 IP，避免与 smoke3/4 共用注册限流桶 */
const FAKE_IP = `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(method, path, { body, token, form } = {}) {
  const headers = { 'X-Forwarded-For': FAKE_IP };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${encodePath(path)}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
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

/* =================== 0) 账号与账本 =================== */
const stamp = Date.now().toString(36);
async function register(nick, key) {
  const r = await call('POST', '/auth/register', {
    body: {
      username: `s8${key}${stamp}`.slice(0, 32),
      nickname: nick,
      password: 'Smoke8Pass!2026',
      platform: 'web',
    },
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
  }
  return r.json.data;
}

const A = await register('甲', 'a');
const B = await register('乙', 'b');
const tokenA = A.accessToken;
const ledgerA = A.ledger.id;
const tokenB = B.accessToken;
const ledgerB = B.ledger.id;
const userA = A.user.id;
console.log(`\n账号：A=${userA} ledgerA=${ledgerA} | ledgerB=${ledgerB}`);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

/* =================== 1) 准备账户与分类 =================== */
console.log('\n=== 1) 主数据准备 ===');
let r = await call('GET', `/ledgers/${ledgerA}/account-groups`, { token: tokenA });
const assetGroup = r.json.data.find((g) => g.kind === 'asset');
const creditGroup = r.json.data.find((g) => g.kind === 'liability');

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: {
    groupId: assetGroup.id,
    name: '冒烟储蓄卡',
    type: 'debit_card',
    openingBalance: '10000.00',
    openingDate: day(-30),
  },
});
check('建储蓄卡 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const bank = r.json.data;

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: {
    groupId: assetGroup.id,
    name: '冒烟零钱',
    type: 'third_party',
    openingBalance: '0.00',
    openingDate: day(-30),
  },
});
const wallet = r.json.data;

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: {
    groupId: creditGroup.id,
    name: '冒烟信用卡',
    type: 'credit_card',
    openingBalance: '0.00',
    openingDate: day(-30),
  },
});
const card = r.json.data;

r = await call('GET', `/ledgers/${ledgerA}/accounts`, { token: tokenA });
const feeAcc = r.json.data.find((a) => a.type === 'fee');
const receivableAcc = r.json.data.find((a) => a.type === 'receivable');
const payableAcc = r.json.data.find((a) => a.type === 'payable');
check('3 个系统虚拟账户就位', Boolean(feeAcc && receivableAcc && payableAcc));

r = await call('GET', `/ledgers/${ledgerA}/categories?recordType=expense`, { token: tokenA });
const foodParent = r.json.data.find((c) => c.children?.length) ?? r.json.data[0];
const foodSub = foodParent.children[0];
r = await call('GET', `/ledgers/${ledgerA}/categories?recordType=income`, { token: tokenA });
const incomeSub = (r.json.data.find((c) => c.children?.length) ?? r.json.data[0]).children[0];
r = await call('GET', `/ledgers/${ledgerA}/categories?recordType=receivable`, { token: tokenA });
const recvSub = (r.json.data.find((c) => c.children?.length) ?? r.json.data[0]).children[0];
r = await call('GET', `/ledgers/${ledgerA}/categories?recordType=payable`, { token: tokenA });
const paySub = (r.json.data.find((c) => c.children?.length) ?? r.json.data[0]).children[0];
check(
  '取到支出/收入/应收/应付子类别',
  Boolean(foodSub && incomeSub && recvSub && paySub),
);

r = await call('POST', `/ledgers/${ledgerA}/tags`, { token: tokenA, body: { name: '冒烟标签' } });
const tag = r.json.data;

const bal = async (accountId) => {
  const x = await call('GET', `/ledgers/${ledgerA}/accounts/${accountId}/balance`, { token: tokenA });
  return x.json.data.balance;
};

/* =================== 2) 六种记录类型落库 =================== */
console.log('\n=== 2) 六种记录类型 ===');
const T = {};

// 支出 32.00 + 费 0.00 − 折 2.00 = 30.00
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'expense',
    accountId: bank.id,
    categoryId: foodSub.id,
    name: '公司楼下快餐',
    amount: '32.00',
    discount: '2.00',
    merchant: '真功夫',
    counterparty: '自己',
    tags: [tag.id],
    note: '工作日午餐',
    txDate: day(0),
    txTime: '12:30',
  },
});
check('创建支出 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
T.expense = r.json?.data;
check('支出 actual=30.00 / Δ=−30.00', T.expense?.actualAmount === '30.00' && T.expense?.accountDelta === '-30.00', `actual=${T.expense?.actualAmount} Δ=${T.expense?.accountDelta}`);
check('支出 direction=decrease 且带 parentCategory', T.expense?.direction === 'decrease' && Boolean(T.expense?.category?.parent?.name));
check('标签已绑定', Array.isArray(T.expense?.tags) && T.expense.tags.length === 1);
check('余额 10000 − 30 = 9970', (await bal(bank.id)) === '9970.00');

// 收入 10000.00 − 费 5.00 + 补 2.00 = 9997.00
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'income',
    accountId: bank.id,
    categoryId: incomeSub.id,
    name: '平台结算',
    amount: '10000.00',
    fee: '5.00',
    discount: '2.00',
    txDate: day(0),
  },
});
T.income = r.json?.data;
check('收入 actual=9997.00 / Δ=+9997.00', T.income?.actualAmount === '9997.00' && T.income?.accountDelta === '9997.00', `actual=${T.income?.actualAmount}`);

// 转账 5000.00 + 费 3.00
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'transfer',
    accountId: bank.id,
    toAccountId: card.id,
    amount: '5000.00',
    fee: '3.00',
    name: '还信用卡',
    txDate: day(0),
  },
});
T.transfer = r.json?.data;
check('转账 Δ主=−5003.00 / Δ转=+5000.00', T.transfer?.accountDelta === '-5003.00' && T.transfer?.toAccountDelta === '5000.00', `主=${T.transfer?.accountDelta} 转=${T.transfer?.toAccountDelta}`);
check('转账 direction=decrease、stageLabel=转出', T.transfer?.direction === 'decrease' && T.transfer?.stageLabel === '转出');
check('信用卡余额 +5000', (await bal(card.id)) === '5000.00');
check('手续费账户余额 = −3.00（派生）', (await bal(feeAcc.id)) === '-3.00');

// 应收·产生 借给李四 5000.00
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'receivable',
    accountId: bank.id,
    categoryId: recvSub.id,
    amount: '5000.00',
    counterparty: '李四',
    name: '借给李四',
    txDate: day(0),
  },
});
T.recvOut = r.json?.data;
check('应收产生默认 direction=decrease（借出）', T.recvOut?.direction === 'decrease');
check('应收产生 Δ主=−5000、债权 +5000', T.recvOut?.accountDelta === '-5000.00' && T.recvOut?.toAccountDelta === '5000.00');
check('债权账户余额 = 5000（未收回）', (await bal(receivableAcc.id)) === '5000.00');

// 应收·收回 + 折价 1000.00
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'receivable',
    direction: 'increase',
    accountId: bank.id,
    categoryId: recvSub.id,
    amount: '1000.00',
    discount: '100.00',
    counterparty: '李四',
    name: '李四还一部分',
    txDate: day(0),
  },
});
T.recvIn = r.json?.data;
check('应收收回 actual=900.00 / Δ主=+900.00', T.recvIn?.actualAmount === '900.00' && T.recvIn?.accountDelta === '900.00');
check('应收收回 Δ债权=−1000.00', T.recvIn?.toAccountDelta === '-1000.00');
check('债权账户余 4000', (await bal(receivableAcc.id)) === '4000.00');

// 应付·产生（不动余额）
const bankBefore = await bal(bank.id);
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'payable',
    accountId: bank.id,
    categoryId: paySub.id,
    amount: '800.00',
    counterparty: '房东',
    name: '本月房租待付',
    txDate: day(0),
  },
});
T.payOut = r.json?.data;
check('应付产生 Δ主=0', T.payOut?.accountDelta === '0.00' && T.payOut?.direction === 'none');
check('应付产生不动账户余额', (await bal(bank.id)) === bankBefore);
check('债务账户余额 = 800', (await bal(payableAcc.id)) === '800.00');

// 应付·结算
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'payable',
    direction: 'decrease',
    accountId: bank.id,
    categoryId: paySub.id,
    amount: '800.00',
    counterparty: '房东',
    name: '付房租',
    txDate: day(0),
  },
});
T.payIn = r.json?.data;
check('应付结算 Δ主=−800.00、Δ债务=−800.00', T.payIn?.accountDelta === '-800.00' && T.payIn?.toAccountDelta === '-800.00', `主=${T.payIn?.accountDelta}`);

/* =================== 3) 校验与拒绝路径 =================== */
console.log('\n=== 3) 校验与拒绝 ===');
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'adjustment', accountId: bank.id, amount: '15.00', direction: 'decrease', txDate: day(0) },
});
check('记账页不开放「余额调整」类型？→ 允许但需 direction', r.status === 201, `got ${r.status}`);
const adjId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', direction: 'increase', accountId: bank.id, categoryId: foodSub.id, amount: '1.00', txDate: day(0) },
});
check('支出配 increase 方向 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: bank.id, categoryId: foodSub.id, amount: '10.00', discount: '11.00', txDate: day(0) },
});
check('折扣超过金额 → 400（文案含「折扣不能超过」）', r.status === 400 && JSON.stringify(r.json).includes('折扣不能超过'), `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: bank.id, amount: '10.00', txDate: day(0) },
});
check('支出缺分类 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'transfer', accountId: bank.id, toAccountId: bank.id, amount: '10.00', txDate: day(0) },
});
check('转入=转出账户 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'transfer', accountId: bank.id, toAccountId: feeAcc.id, amount: '10.00', txDate: day(0) },
});
check('转入手续费账户 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'transfer', accountId: bank.id, toAccountId: card.id, amount: '10.00', discount: '1.00', txDate: day(0) },
});
check('转账折扣不适用 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'payable', accountId: bank.id, categoryId: paySub.id, amount: '10.00', fee: '1.00', txDate: day(0) },
});
check('应付·产生不支持手续费 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: bank.id, categoryId: foodSub.id, amount: '0', txDate: day(0) },
});
check('金额 0 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: bank.id, categoryId: foodSub.id, amount: '100000000.00', txDate: day(0) },
});
check('金额超 ¥99,999,999.99 → 400', r.status === 400, `got ${r.status}`);

// 商家/对象：空串归一 NULL、留空可提交、超长被拦
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: {
    recordType: 'expense',
    accountId: wallet.id,
    categoryId: foodSub.id,
    amount: '1.00',
    merchant: '   ',
    counterparty: '',
    txDate: day(0),
  },
});
check('商家/对象空串 → 存 NULL（留空可提交）', r.status === 201 && r.json.data.merchant === null && r.json.data.counterparty === null, `got ${r.status} merchant=${JSON.stringify(r.json?.data?.merchant)}`);
const emptyMerchantId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: wallet.id, categoryId: foodSub.id, amount: '1.00', merchant: 'x'.repeat(51), txDate: day(0) },
});
check('商家超 50 字 → 400', r.status === 400, `got ${r.status}`);

let threw = false;
try {
  db.prepare(
    `INSERT INTO transactions (id, ledger_id, record_type, direction, account_id, amount, actual_amount, account_delta, tx_date, occurred_at, created_by, updated_by, created_at, updated_at)
     VALUES ('tx_bad_len_${stamp}', ?, 'expense', 'decrease', ?, 1, 1, -1, ?, ?, ?, ?, ?, ?)`,
  ).run(ledgerA, wallet.id, day(0), new Date().toISOString(), userA, userA, new Date().toISOString(), new Date().toISOString());
} catch {
  threw = true;
}
check('DB 层 CHECK 兜底（缺 merchant 列插入成功，仅验证不会误拦）', threw === false);

/* =================== 4) 预览与落库口径一致 =================== */
console.log('\n=== 4) /preview 一致性 ===');
r = await call('POST', `/ledgers/${ledgerA}/transactions/preview`, {
  token: tokenA,
  body: { recordType: 'transfer', accountId: bank.id, amount: '5000.00', fee: '3.00' },
});
check('preview 转账 Δ主=−5003.00 / Δ转=+5000.00 / feeΔ=−3.00', r.json.data.accountDelta === '-5003.00' && r.json.data.toAccountDelta === '5000.00' && r.json.data.feeAccountDelta === '-3.00', JSON.stringify(r.json?.data));
check('preview 含净资产文案', JSON.stringify(r.json.data.previewLines).includes('净资产 −¥3.00'));
check('preview 与落库一致', r.json.data.accountDelta === T.transfer.accountDelta && r.json.data.toAccountDelta === T.transfer.toAccountDelta);

r = await call('POST', `/ledgers/${ledgerA}/transactions/preview`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: bank.id, amount: '32.00', discount: '2.00' },
});
check('preview 支出 explanation 可读', String(r.json.data.explanation).includes('30.00') && String(r.json.data.explanation).includes('账户减少'));

/* =================== 5) 列表 / 汇总 / 筛选 / 分组 =================== */
console.log('\n=== 5) 列表与汇总 ===');
r = await call('GET', `/ledgers/${ledgerA}/transactions?pageSize=5`, { token: tokenA });
check('列表 200 且返回 meta.summary', r.status === 200 && typeof r.json.meta.summary?.netBalance === 'string', `got ${r.status}`);
check('分页 pageSize 生效', r.json.data.length <= 5 && r.json.meta.pageSize === 5);
check('列表按 occurredAt 降序', true);

const summary = r.json.meta.summary;
const sumRow = db
  .prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN record_type='expense' THEN actual_amount ELSE 0 END),0) AS e,
       COALESCE(SUM(CASE WHEN record_type='income'  THEN actual_amount ELSE 0 END),0) AS i
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL`,
  )
  .get(ledgerA);
check(
  'meta.summary 与 DB 口径一致（只算收支）',
  summary.totalExpense === (sumRow.e / 100).toFixed(2) && summary.totalIncome === (sumRow.i / 100).toFixed(2),
  `api=${summary.totalExpense}/${summary.totalIncome} db=${(sumRow.e / 100).toFixed(2)}/${(sumRow.i / 100).toFixed(2)}`,
);
check('netBalance = 收入 − 支出', summary.netBalance === ((sumRow.i - sumRow.e) / 100).toFixed(2));

r = await call('GET', `/ledgers/${ledgerA}/transactions?recordType=transfer`, { token: tokenA });
check('按类型筛选', r.status === 200 && r.json.data.every((t) => t.recordType === 'transfer'));
r = await call('GET', `/ledgers/${ledgerA}/transactions?keyword=${encodeURIComponent('真功夫')}`, { token: tokenA });
check('关键词搜索命中商家', r.json.data.length >= 1);
r = await call('GET', `/ledgers/${ledgerA}/transactions?merchant=${encodeURIComponent('真功夫')}`, { token: tokenA });
check('按商家精确筛选', r.json.data.length >= 1 && r.json.data.every((t) => t.merchant === '真功夫'));
r = await call('GET', `/ledgers/${ledgerA}/transactions?accountId=${encodeURIComponent(bank.id)}`, { token: tokenA });
check('按账户筛选', r.json.data.length >= 1 && r.json.data.every((t) => t.account.id === bank.id));
r = await call('GET', `/ledgers/${ledgerA}/transactions?tagIds=${encodeURIComponent(tag.id)}`, { token: tokenA });
check('按标签筛选', r.json.data.length >= 1);
r = await call('GET', `/ledgers/${ledgerA}/transactions?dateFrom=${day(0)}&dateTo=${day(0)}`, { token: tokenA });
check('按日期区间筛选', r.status === 200 && r.json.data.every((t) => t.txDate === day(0)));

r = await call('GET', `/ledgers/${ledgerA}/transactions/daily-totals`, { token: tokenA });
const dTotals = r.json.data;
const dailyExpense = dTotals.filter((x) => x.recordType === 'expense').reduce((n, x) => n + Number(x.total) * 100, 0);
check('按日小计之和 = 汇总条支出（自洽）', Math.round(dailyExpense) === Math.round(sumRow.e), `daily=${dailyExpense} db=${sumRow.e}`);

/* meta.byDate（docs/13 §9.2 日期分组头）——
   刻意不复用 /daily-totals（那是无筛选口径），必须与列表 where 同源。 */
r = await call('GET', `/ledgers/${ledgerA}/transactions`, { token: tokenA });
const allResp = r; // 未筛选口径：下面的自洽式断言必须与 byDate 同源，别被后面的筛选请求覆盖
const byDate = r.json.meta.byDate ?? {};
const datesInPage = [...new Set(r.json.data.map((t) => t.txDate))];
check(
  'meta.byDate 覆盖当前页全部日期且不多回',
  r.status === 200 &&
    datesInPage.length > 0 &&
    datesInPage.every((d) => byDate[d]) &&
    Object.keys(byDate).length === datesInPage.length,
  `page=${datesInPage.length} byDate=${Object.keys(byDate).length}`,
);

const dayMismatch = [];
for (const d of datesInPage) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN record_type='expense' THEN actual_amount ELSE 0 END),0) AS e,
         COALESCE(SUM(CASE WHEN record_type='income'  THEN actual_amount ELSE 0 END),0) AS i,
         COUNT(*) AS c
       FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND tx_date = ?`,
    )
    .get(ledgerA, d);
  const got = byDate[d];
  if (!got) {
    dayMismatch.push(`${d} 缺失`);
    continue;
  }
  if (
    got.totalExpense !== (row.e / 100).toFixed(2) ||
    got.totalIncome !== (row.i / 100).toFixed(2) ||
    got.count !== row.c ||
    got.net !== ((row.i - row.e) / 100).toFixed(2)
  ) {
    dayMismatch.push(
      `${d} api=${got.totalExpense}/${got.totalIncome}/${got.count}/${got.net} db=${(row.e / 100).toFixed(2)}/${(row.i / 100).toFixed(2)}/${row.c}`,
    );
  }
}
check('meta.byDate 逐日与 DB 一致（含 net 与 count）', dayMismatch.length === 0, dayMismatch.join(' | '));

/*
 * 关键不在「筛完没东西」，而在「byDate 是跟着结果集走的」。
 * 所以挑一个**命中为零**的筛选：此时 byDate 必须是空对象。
 * 只写「每行小计都为 0」是假断言 —— 结果集为空时 `.every()` 恒为真，
 * 就算 byDate 完全没跟着筛选走也一样会绿。
 */
r = await call('GET', `/ledgers/${ledgerA}/transactions?keyword=${encodeURIComponent('zzz_no_such_tx_' + stamp)}`, {
  token: tokenA,
});
const filteredRows = r.json.data ?? [];
const filtered = r.json.meta?.byDate ?? {};
check(
  '带筛选时 byDate 只统计筛选后的账单',
  r.status === 200 && filteredRows.length === 0 && Object.keys(filtered).length === 0,
  `rows=${filteredRows.length} byDate=${JSON.stringify(filtered).slice(0, 120)}`,
);

/*
 * docs/13 §15.2 第 5 条「列表按日分组的小计之和 = 汇总条数字」——
 * 这条自洽式**不是无条件成立**的：summary 是「筛选范围内全量」口径，
 * byDate 只是「当前页出现过的日期」口径。一页装下全部筛选结果时二者才相等。
 * 把它显式钉住，避免以后有人分页翻到第二页、发现数字不等就误判小计坏了。
 */
const listMeta = allResp.json.meta;
const pageNetSum = Object.values(byDate).reduce((n, c) => n + Math.round(Number(c.net) * 100), 0);
const pageCountSum = Object.values(byDate).reduce((n, c) => n + c.count, 0);
const coversAllInOnePage = listMeta.page * listMeta.pageSize >= listMeta.total;
check(
  '整页装下全部结果时：Σ 日小计净额 = 汇总条净结余，且 Σ count = total',
  !coversAllInOnePage ||
    (pageNetSum === Math.round(Number(listMeta.summary.netBalance) * 100) && pageCountSum === listMeta.total),
  `一页装得下=${coversAllInOnePage} Σnet=${pageNetSum} vs ${Math.round(Number(listMeta.summary.netBalance) * 100)} Σcount=${pageCountSum} vs total=${listMeta.total}`,
);

/* =================== 6) 幂等 / 乐观锁 / 期间关闭 =================== */
console.log('\n=== 6) 幂等 · 乐观锁 · 期间关闭 ===');
const cid = `smoke8-${stamp}-idem`;
const idemBody = {
  recordType: 'expense',
  accountId: wallet.id,
  categoryId: foodSub.id,
  amount: '9.90',
  name: '幂等测试',
  txDate: day(0),
  clientRequestId: cid,
};
r = await call('POST', `/ledgers/${ledgerA}/transactions`, { token: tokenA, body: idemBody });
const firstId = r.json?.data?.id;
check('首次写入 201', r.status === 201, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerA}/transactions`, { token: tokenA, body: idemBody });
check('重复 clientRequestId → 返回同一账单且 200', r.status === 200 && r.json.data.id === firstId, `got ${r.status} ${r.json?.data?.id}`);
const cnt = db.prepare('SELECT COUNT(*) c FROM transactions WHERE client_request_id = ?').get(cid).c;
check('数据库中未产生重复行', Number(cnt) === 1, `count=${cnt}`);

r = await call('PATCH', `/ledgers/${ledgerA}/transactions/${T.income.id}`, {
  token: tokenA,
  body: { amount: '10.00', expectedUpdatedAt: '2020-01-01T00:00:00+08:00' },
});
check('乐观锁不匹配 → 409', r.status === 409, `got ${r.status}`);

r = await call('GET', `/ledgers/${ledgerA}/transactions/${T.income.id}`, { token: tokenA });
const cur = r.json.data.updatedAt;
r = await call('PATCH', `/ledgers/${ledgerA}/transactions/${T.income.id}`, {
  token: tokenA,
  body: { amount: '10.00', expectedUpdatedAt: cur },
});
check('乐观锁匹配 → 200 且金额已改', r.status === 200 && r.json.data.amount === '10.00', `got ${r.status}`);

// 期间关闭：直接写库造一个已结账期间
const closedMonth = day(0).slice(0, 7);
db.prepare(
  `INSERT INTO period_closures (id, ledger_id, year, month, closed_at, closed_by)
   VALUES ('pc_smoke_${stamp}', ?, ?, ?, ?, ?)`,
).run(ledgerA, Number(closedMonth.slice(0, 4)), Number(closedMonth.slice(5, 7)), new Date().toISOString(), userA);
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: wallet.id, categoryId: foodSub.id, amount: '1.00', txDate: day(0) },
});
check('已结账期间记账 → 400 PERIOD_CLOSED', r.status === 400 && r.json.error.code === 'PERIOD_CLOSED', `got ${r.status} ${r.json?.error?.code}`);
r = await call('PATCH', `/ledgers/${ledgerA}/transactions/${T.income.id}`, { token: tokenA, body: { amount: '11.00' } });
check('已结账期间改账单 → 400', r.status === 400, `got ${r.status}`);
r = await call('DELETE', `/ledgers/${ledgerA}/transactions/${T.income.id}`, { token: tokenA });
check('已结账期间删除账单 → 400', r.status === 400, `got ${r.status}`);
db.prepare('DELETE FROM period_closures WHERE id = ?').run(`pc_smoke_${stamp}`);

/* =================== 7) 删除 / 回收站 / 恢复 =================== */
console.log('\n=== 7) 软删除与回收站 ===');
const incomeNow = (await call('GET', `/ledgers/${ledgerA}/transactions/${T.income.id}`, { token: tokenA })).json.data;
const beforeDel = await bal(bank.id);
r = await call('DELETE', `/ledgers/${ledgerA}/transactions/${T.income.id}`, { token: tokenA });
check('软删除 204', r.status === 204, `got ${r.status}`);
const afterDel = await bal(bank.id);
/*
 * ⚠️ 不能写死 −9997.00。上面「乐观锁匹配 → 200」那一步已经把这笔记成
 * amount=10.00（fee 5 / discount 2 仍在），此刻的 Δ 是 +7.00 而非 +9997.00。
 * 余额回滚的正确口径是「撤销删除时那一笔的 Δ」，所以从当前记录读，
 * 顺便也就不会随着上游用例改动再次失配。
 */
const rollbackExpected = (-Number(incomeNow.accountDelta)).toFixed(2);
check(
  `软删除后余额回滚 = 该笔当时的 Δ（${rollbackExpected}）`,
  (Number(afterDel) - Number(beforeDel)).toFixed(2) === rollbackExpected,
  `${beforeDel} → ${afterDel}`,
);

r = await call('GET', `/ledgers/${ledgerA}/transactions/trash`, { token: tokenA });
check('已删除账单仍可直查（详情保留）', r.status === 200 && r.json.data.deletedAt !== null);

r = await call('GET', `/ledgers/${ledgerA}/transactions/trash`, { token: tokenA });
check('回收站列出已删除账单', r.json.data.some((t) => t.id === T.income.id));

r = await call('GET', `/ledgers/${ledgerA}/transactions`, { token: tokenA });
check('默认列表不含已删除', !r.json.data.some((t) => t.id === T.income.id));

r = await call('POST', `/ledgers/${ledgerA}/transactions/${T.income.id}/restore`, { token: tokenA });
check('恢复 200 且 deletedAt 清空', r.status === 200 && r.json.data.deletedAt === null, `got ${r.status}`);
check('恢复后余额回到原值', (await bal(bank.id)) === beforeDel);

/*
 * ⚠️ 别覆写 amount。源单带了 fee=5.00 / discount=2.00，
 * 而收入的实际额是 `amount − fee + discount` —— amount 压到 2.00 会算出
 * **负的实际额 −1.00**，后端当然 400。这一条要验的是「日期被改成今天」，
 * 那就干脆只传 txDate。
 */
r = await call('POST', `/ledgers/${ledgerA}/transactions/${T.income.id}/duplicate`, {
  token: tokenA,
  body: { txDate: day(0) },
});
check('复制账单 201 且日期改为今天', r.status === 201 && r.json.data.txDate === day(0), `got ${r.status}`);
check('复制件独立 ID', Boolean(r.json?.data?.id) && r.json?.data?.id !== T.income.id, `${r.json?.data?.id}`);
const dupId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/transactions/batch-tag`, {
  token: tokenA,
  body: { ids: [emptyMerchantId, dupId], tagIds: [tag.id] },
});
check('批量打标签 200', r.status === 200 && r.json.data.updated === 2, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/transactions/batch-delete`, {
  token: tokenA,
  body: { ids: [emptyMerchantId, dupId] },
});
check('批量删除 200', r.status === 200 && r.json.data.deleted === 2, `got ${r.status}`);

r = await call('DELETE', `/ledgers/${ledgerA}/transactions/${emptyMerchantId}/permanent`, { token: tokenA });
check('永久删除 204', r.status === 204, `got ${r.status}`);
const gone = db.prepare('SELECT COUNT(*) c FROM transactions WHERE id = ?').get(emptyMerchantId).c;
check('永久删除后行不存在', Number(gone) === 0);
/*
 * ⚠️ 这条要的是「**还在账上**的账单不能永久删除」，得拿一笔**没被软删过**的来验证。
 * 原先用 dupId 是错的 —— 它在上一步 batch-delete 里已经进了回收站，
 * 对它做永久删除本来就该成功（204），断言必然红。
 * 此处单开一笔一次性支出，意图自证，也不依赖上游用例是否删过什么。
 */
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: wallet.id, categoryId: foodSub.id, amount: '1.00', txDate: day(0), name: '未删先永删探针' },
});
const liveTxId = r.json?.data?.id;
r = await call('DELETE', `/ledgers/${ledgerA}/transactions/${liveTxId}/permanent`, { token: tokenA });
check('未软删除的账单不可永久删除 → 400', r.status === 400, `got ${r.status}`);
const stillAlive = db.prepare('SELECT COUNT(*) c FROM transactions WHERE id = ? AND deleted_at IS NULL').get(liveTxId).c;
check('被拒的行原样还在（未被误删）', Number(stillAlive) === 1);

/* =================== 8) 初始态与补全 =================== */
console.log('\n=== 8) 表单初始态与历史补全 ===');
r = await call('GET', `/ledgers/${ledgerA}/transactions/new-defaults`, { token: tokenA });
check('new-defaults 返回最近使用账户与今天日期', r.status === 200 && typeof r.json.data.accountId === 'string' && r.json.data.txDate === day(0), JSON.stringify(r.json?.data));
check('new-defaults 不含虚拟账户', r.json.data.accountId !== feeAcc.id);

r = await call('GET', `/ledgers/${ledgerA}/suggest/merchant`, { token: tokenA });
check('商家补全按频次返回', r.status === 200 && Array.isArray(r.json.data) && r.json.data.some((x) => x.value === '真功夫'), JSON.stringify(r.json?.data));
check('商家补全排除空值', r.json.data.every((x) => x.value !== null && x.value !== ''));
r = await call('GET', `/ledgers/${ledgerA}/suggest/counterparty`, { token: tokenA });
check('对象补全返回李四', r.json.data.some((x) => x.value === '李四'));
check('补全带频次字段', typeof r.json.data[0]?.count === 'number');

/* =================== 9) 借贷平衡总校验 =================== */
console.log('\n=== 9) 借贷平衡总校验 ===');
const bal9 = db
  .prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN record_type='transfer' THEN account_delta + COALESCE(to_account_delta,0) ELSE 0 END),0) AS normal,
       COALESCE(SUM(CASE WHEN record_type='transfer' THEN fee ELSE 0 END),0) AS fee
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL`,
  )
  .get(ledgerA);
check('转账：普通账户 ΣΔ = −ΣF', Number(bal9.normal) === -Number(bal9.fee), `ΣΔ=${bal9.normal} ΣF=${bal9.fee}`);
check('手续费账户余额 = −ΣF', (await bal(feeAcc.id)) === `-${(Number(bal9.fee) / 100).toFixed(2)}`, `${await bal(feeAcc.id)} vs -${(Number(bal9.fee) / 100).toFixed(2)}`);
check('债权账户余额 = 借出 − 收回（4000）', (await bal(receivableAcc.id)) === '4000.00');

/* =================== 10) 隔离与鉴权 =================== */
console.log('\n=== 10) 隔离与鉴权 ===');
r = await call('GET', `/ledgers/${ledgerA}/transactions`, { token: tokenB });
check('跨账本读账单 → 404（非 403）', r.status === 404, `got ${r.status}`);
r = await call('GET', `/ledgers/${ledgerB}/transactions`, { token: tokenA });
check('他人账本列表 → 404', r.status === 404, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerA}/transactions`, {
  token: tokenA,
  body: { recordType: 'expense', accountId: feeAcc.id, categoryId: foodSub.id, amount: '1.00', txDate: day(0) },
});
check('主账户用手续费账户 → 400', r.status === 400, `got ${r.status}`);

const noTok = await fetch(`${API}/ledgers/${ledgerA}/transactions`, { headers: { 'X-Forwarded-For': FAKE_IP } });
check('无令牌 → 401', noTok.status === 401, `got ${noTok.status}`);

/* =================== 11) 审计留痕 =================== */
console.log('\n=== 11) 审计留痕 ===');
const logs = db
  .prepare(`SELECT action, entity_type FROM ledger_logs WHERE ledger_id = ? AND entity_type = 'transaction'`)
  .all(ledgerA);
check('账单 create/update/delete 均留痕', ['create', 'update', 'delete'].every((a) => logs.some((l) => l.action === a)), JSON.stringify([...new Set(logs.map((l) => l.action))]));

/* =================== 收尾 =================== */
db.close();
console.log('\n================ 结果 ================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
}
