/**
 * Stage 4 端到端冒烟：账户 / 分类 / 标签 / 对账。
 *
 * 覆盖重点（对齐 docs/03 的账务规约）：
 *   · 余额公式 balance = opening + Σaccount_delta + Σto_account_delta
 *     边界：opening_date ≤ tx_date（2026-10-14 口径修正，见 docs/14）、软删除排除、
 *           转账双向计入；
 *   · 对账：差异额 → adjustment 账单（actual=|diff|、Δ 保留符号）、对账历史、健康度；
 *   · 分类：两层约束、同级重名、有引用只能停用；
 *   · 跨账本一律 404；无令牌 401。
 *
 * 用法：node scripts/smoke-stage4.mjs http://127.0.0.1:3000
 */
import Database from 'better-sqlite3';
import { P } from './lib/url.mjs';

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

/**
 * 路径段编码。
 * ⚠️ 预置数据主键是复合 ID（`ldg_xxx#acc_sys_receivable`），`#` 在 URL 中是片段分隔符，
 * 不编码会被截断成 404。静态路由段编码后不变，故可整段处理。
 */
function encodePath(p) {
  const [pathPart, query] = p.split('?');
  const encoded = pathPart
    .split('/')
    .map((s) => (s ? encodeURIComponent(s) : s))
    .join('/');
  return query ? `${encoded}?${query}` : encoded;
}

/**
 * 每次调用带一个独立伪造 IP。
 * 注册限流是**内存计数器**（3 次/小时/IP），smoke3 / smoke8 已经用这一招各自独立成桶；
 * smoke4 之前漏了，会撞上前面脚本用掉的配额（429，且要等 ~30 分钟）。
 * 服务端 trustProxy 已开启，伪造头对它就是真实来源 —— 这是既定约定，不是绕过漏洞。
 */
/**
 * ⚠️ 起点必须**随机**。写死 0 的话，两次运行会拿到同一串 IP，
 * 而注册限流是「每 IP 每小时 N 次」—— 连跑几遍就把前几个 IP 的配额用光，
 * 于是第一次注册就 429，且要等几十分钟。这是纯工程噪声，不是被测行为。
 * 256 个 /24 × 254 个主机 ≈ 6.5 万个起点，够连跑很久不撞。
 */
let ipCounter = Math.floor(Math.random() * 65000);
const nextIp = () => `10.2${Math.floor(ipCounter / 65000) % 5}0.${Math.floor(ipCounter / 254) % 254}.${(ipCounter++ % 254) + 1}`;

async function call(method, path, { body, token, form } = {}) {
  const headers = { 'X-Forwarded-For': nextIp() };
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

const yuan = (cents) => (cents / 100).toFixed(2);
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* =================== 0) 建两个账号（用于跨账本测试） =================== */
const stamp = Date.now().toString(36);
async function register(nick, key) {
  const r = await call('POST', '/auth/register', {
    body: {
      username: `s4${key}${stamp}`.slice(0, 32),
      nickname: nick,
      password: 'Smoke4Pass!2026',
      platform: 'web',
    },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
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

/* =================== 1) 账户分组 =================== */
console.log('\n=== 1) 账户分组 ===');
let r = await call('GET', `/ledgers/${ledgerA}/account-groups`, { token: tokenA });
check('预置账户分组 6 个', r.status === 200 && r.json.data.length === 6, `got ${r.json?.data?.length}`);

const cashGroup = r.json.data.find((g) => g.kind === 'asset');
check('分组含 accountCount 与 totalBalance', typeof cashGroup?.accountCount === 'number' && typeof cashGroup?.totalBalance === 'string');

r = await call('POST', `/ledgers/${ledgerA}/account-groups`, {
  token: tokenA,
  body: { name: '境外账户', kind: 'asset', icon: '🌍' },
});
check('新建分组 201', r.status === 201, `got ${r.status}`);
const newGroupId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/account-groups`, { token: tokenA, body: { name: '境外账户', kind: 'asset' } });
check('同名分组 → 409', r.status === 409, `got ${r.status}`);

r = await call('GET', `/ledgers/${ledgerB}/account-groups`, { token: tokenA });
check('跨账本读分组 → 404', r.status === 404, `got ${r.status}`);

/* =================== 2) 账户 CRUD =================== */
console.log('\n=== 2) 账户 ===');
r = await call('GET', `/ledgers/${ledgerA}/accounts`, { token: tokenA });
check('预置 3 个系统虚拟账户', r.status === 200 && r.json.data.filter((a) => a.isSystem).length === 3, `got ${r.json?.data?.filter((a) => a.isSystem).length}`);
check('虚拟账户 kind=virtual', r.json.data.filter((a) => a.isSystem).every((a) => a.kind === 'virtual'));

const openingDate = day(-30);
r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: {
    groupId: newGroupId,
    name: '测试储蓄卡',
    type: 'debit_card',
    openingBalance: '10000.00',
    openingDate,
    icon: '💳',
  },
});
check('新建账户 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const acc = r.json.data;
check('余额 = 期初（无流水）', acc.balance === '10000.00', `got ${acc.balance}`);
check('kind 由 type 推导为 asset', acc.kind === 'asset');

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: { groupId: newGroupId, name: '测试储蓄卡', type: 'debit_card' },
});
check('同名账户 → 409', r.status === 409, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: { groupId: newGroupId, name: '信用卡A', type: 'credit_card', creditLimit: '50000.00', billingDay: 5, dueDay: 20 },
});
check('信用卡扩展字段落库', r.status === 201 && r.json.data.creditLimit === '50000.00' && r.json.data.billingDay === 5 && r.json.data.dueDay === 20);
const cardId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: { groupId: newGroupId, name: '转入户', type: 'debit_card', openingBalance: '0.00', openingDate },
});
const acc2 = r.json.data;

r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: { groupId: 'grp_not_exist_' + stamp, name: '坏账户', type: 'cash' },
});
check('分组不存在 → 404', r.status === 404, `got ${r.status}`);

/* =================== 3) 余额公式（直接造流水） =================== */
console.log('\n=== 3) 余额公式与边界 ===');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

let txSeq = 0;

/**
 * 由 record_type + account_delta 推导 direction —— 与 docs/12 §7.1 的映射、
 * 以及 DDL 的 ck_direction_by_type 同源，避免手工造数时踩 CHECK。
 */
function autoDirection(recordType, delta) {
  switch (recordType) {
    case 'expense':
    case 'transfer':
      return 'decrease';
    case 'income':
      return 'increase';
    case 'payable':
      return delta === 0 ? 'none' : 'decrease';
    case 'receivable':
      return delta < 0 ? 'decrease' : 'increase';
    default:
      return delta > 0 ? 'increase' : 'decrease'; // adjustment
  }
}

function insertTx(over = {}) {
  txSeq += 1;
  const id = `tx_smoke_${stamp}_${txSeq}`;
  const base = {
    id,
    ledger_id: ledgerA,
    record_type: 'expense',
    account_id: acc.id,
    amount: 100,
    fee: 0,
    discount: 0,
    actual_amount: 100,
    account_delta: -100,
    to_account_delta: null,
    tx_date: day(-10),
    occurred_at: new Date().toISOString(),
    created_by: userA,
    updated_by: userA,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  const row = { ...base, ...over };
  // direction 在合并后再算，保证与最终的 record_type / account_delta 自洽
  row.direction = over.direction ?? autoDirection(row.record_type, row.account_delta);
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO transactions (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
  return id;
}

// a) 正常支出：−5000.00
insertTx({ account_delta: -500000, amount: 500000, actual_amount: 500000, tx_date: day(-10) });
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('期初 10000 − 支出 5000 = 5000', r.json.data.balance === '5000.00', `got ${r.json?.data?.balance}`);
check('outflow 统计正确', r.json.data.outflow === '5000.00', `got ${r.json?.data?.outflow}`);

// b) 收入 +2000.00
insertTx({ record_type: 'income', account_delta: 200000, amount: 200000, actual_amount: 200000, tx_date: day(-5) });
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('再 + 收入 2000 = 7000', r.json.data.balance === '7000.00', `got ${r.json?.data?.balance}`);
check('inflow 统计正确', r.json.data.inflow === '2000.00', `got ${r.json?.data?.inflow}`);

// c) 边界：tx_date == opening_date **计入**（2026-10-14 口径修正，见 docs/14）
//    这条断言原先锁的是「== 不计入（严格大于）」—— 锁住的其实是缺陷本身：
//    建账当天的账不进余额，界面上表现为「记了一笔，余额却没动」。
insertTx({ account_delta: -111111, amount: 111111, actual_amount: 111111, tx_date: openingDate });
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check(
  'tx_date == opening_date 计入余额（期初余额是期初日之前的存量）',
  r.json.data.balance === '5888.89',
  `got ${r.json?.data?.balance}`,
);

// d) 边界：tx_date < opening_date 仍不计入（这条边界**没有**变）
insertTx({ account_delta: -222222, amount: 222222, actual_amount: 222222, tx_date: day(-60) });
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('tx_date < opening_date 不计入余额', r.json.data.balance === '5888.89', `got ${r.json?.data?.balance}`);

// e) 软删除排除
const softId = insertTx({ account_delta: -333333, amount: 333333, actual_amount: 333333, tx_date: day(-3) });
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('未删除时计入（5888.89 − 3333.33）', r.json.data.balance === '2555.56', `got ${r.json?.data?.balance}`);
db.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), softId);
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('软删除后余额自动回滚到 5888.89', r.json.data.balance === '5888.89', `got ${r.json?.data?.balance}`);

// f) 转账双向计入：主账户 −1005.00，目标账户 +1000.00
insertTx({
  record_type: 'transfer',
  account_id: acc.id,
  to_account_id: acc2.id,
  amount: 100000,
  fee: 500,
  actual_amount: 100000,
  account_delta: -100500,
  to_account_delta: 100000,
  tx_date: day(-2),
});
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('转出方 −1005 → 4883.89', r.json.data.balance === '4883.89', `got ${r.json?.data?.balance}`);
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc2.id}/balance`, { token: tokenA });
check('转入方 +1000（读 to_account_delta）', r.json.data.balance === '1000.00', `got ${r.json?.data?.balance}`);

// g) 借贷平衡（docs/03 §1.4）：转账类交易，普通账户 ΣΔ = −F，费用虚拟账户单独记 −F
const feeAcc = db
  .prepare(`SELECT id FROM accounts WHERE ledger_id = ? AND type = 'fee' LIMIT 1`)
  .get(ledgerA);
// 费用账户是账本引导时创建的（期初日期＝当天），把期初日期前移才能让历史流水计入，
// 与普通账户（openingDate = day(-30)）保持同一口径。
db.prepare('UPDATE accounts SET opening_date = ? WHERE id = ?').run(openingDate, feeAcc.id);
const balanceDate = day(-1);
// ⚠️ 只造**一行**转账：费用账户的 Δ 由 balance.ts 的派生分支给出（docs/12 D6），
//    不再手工另插一行手续费腿，否则会重复计账。
insertTx({
  record_type: 'transfer',
  account_id: acc.id,
  to_account_id: acc2.id,
  amount: 100000,
  fee: 500,
  actual_amount: 100000,
  account_delta: -100500,
  to_account_delta: 100000,
  tx_date: balanceDate,
});
const normalSum = db
  .prepare(
    `SELECT COALESCE(SUM(account_delta),0) + COALESCE(SUM(COALESCE(to_account_delta,0)),0) AS s
       FROM transactions
      WHERE ledger_id = ? AND tx_date = ? AND deleted_at IS NULL AND account_id <> ?`,
  )
  .get(ledgerA, balanceDate, feeAcc.id);
check('借贷平衡：普通账户 ΣΔ = −F（净资产减少手续费）', Number(normalSum.s) === -500, `ΣΔ=${normalSum.s}`);
r = await call('GET', `/ledgers/${ledgerA}/accounts/${feeAcc.id}/balance`, { token: tokenA });
const feeExpected = db
  .prepare(
    `SELECT COALESCE(SUM(fee),0) AS s FROM transactions
      WHERE ledger_id = ? AND record_type = 'transfer' AND deleted_at IS NULL AND fee > 0`,
  )
  .get(ledgerA).s;
check(
  `费用虚拟账户余额 = −ΣF（派生，docs/12 D6）期望 −${(Number(feeExpected) / 100).toFixed(2)}`,
  r.json.data.balance === `-${(Number(feeExpected) / 100).toFixed(2)}`,
  `got ${r.json?.data?.balance}`,
);

// 指定日期重算
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance?date=${day(-6)}`, { token: tokenA });
check(
  '按指定日期重算（T=−6 时含 −5000 与期初当日的 −1111.11）',
  r.json.data.balance === '3888.89',
  `got ${r.json?.data?.balance}`,
);

/* =================== 4) 分类 =================== */
console.log('\n=== 4) 分类 ===');
// ⚠️ 必须带 `?recordType=expense`：不带则拿全类型树，tree[0] 可能是**收入**一级分类，
// 用它当新增子类的 parentId 会被后端以「跨 record_type 挂父类」拒掉，
// 而且会把后面「三层非法 / 同级重名 / 删除」三条断言全部拖成级联失败。
r = await call('GET', `/ledgers/${ledgerA}/categories?recordType=expense`, { token: tokenA });
const tree = r.json.data;
check('支出分类主类别 ≥ 10', r.status === 200 && tree.length >= 10, `got ${tree.length}`);
check('主类别含 children 数组', Array.isArray(tree[0]?.children) && tree[0].children.length > 0);
const subTotal = tree.reduce((n, p) => n + p.children.length, 0);
check('支出子类别 ≥ 30', subTotal >= 30, `got ${subTotal}`);
const parentId = tree[0].id;

r = await call('POST', `/ledgers/${ledgerA}/categories`, {
  token: tokenA,
  body: { recordType: 'expense', parentId, name: '测试子类', icon: '🧪' },
});
check('新增子类别 201 且 level=2', r.status === 201 && r.json.data.level === 2, `got ${r.status} level=${r.json?.data?.level}`);
const newCatId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/categories`, {
  token: tokenA,
  body: { recordType: 'expense', parentId, name: '测试子类' },
});
check('同级重名 → 409', r.status === 409, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/categories`, {
  token: tokenA,
  body: { recordType: 'expense', parentId: newCatId, name: '三层非法' },
});
check('三层分类被拒绝 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/categories`, {
  token: tokenA,
  body: { recordType: 'income', parentId, name: '跨类型挂载' },
});
check('跨 record_type 挂父类 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/categories`, {
  token: tokenA,
  body: { recordType: 'transfer', name: '转账不该有分类' },
});
check('transfer 不允许建分类 → 400', r.status === 400, `got ${r.status}`);

r = await call('DELETE', `/ledgers/${ledgerA}/categories/${newCatId}`, { token: tokenA });
check('删除无引用分类 → 归档成功', r.status === 200 && r.json.data.archived === true);

r = await call('GET', `/ledgers/${ledgerA}/categories`, { token: tokenA });
check('归档后默认列表不再出现', !r.json.data.some((p) => p.children.some((c) => c.id === newCatId)));

/* 内置分类（is_default=1）：名称不可改，可停用可恢复，可换展示图标 */
const presetParent = tree.find((p) => p.isDefault);
const presetChild = presetParent?.children?.[0];
r = await call('PATCH', `/ledgers/${ledgerA}/categories/${presetChild.id}`, {
  token: tokenA,
  body: { name: '试图改内置分类' },
});
check('内置分类改名被拒 → 400', r.status === 400, `got ${r.status}`);
r = await call('PATCH', `/ledgers/${ledgerA}/categories/${presetChild.id}`, {
  token: tokenA,
  body: { icon: 'coffee' },
});
check('内置分类可换展示图标', r.status === 200 && r.json.data.icon === 'coffee', `got ${r.status} icon=${r.json?.data?.icon}`);
r = await call('DELETE', `/ledgers/${ledgerA}/categories/${presetChild.id}`, { token: tokenA });
check('内置分类可停用（归档）', r.status === 200 && r.json.data.archived === true);
r = await call('POST', `/ledgers/${ledgerA}/categories/${presetChild.id}/restore`, { token: tokenA });
check('内置分类可恢复', r.status === 200 && r.json.data.archivedAt === null);

/* 近一年使用统计：txCount / txAmount */
r = await call('GET', `/ledgers/${ledgerA}/categories`, { token: tokenA });
const statCat = r.json.data[0];
check('分类带近一年统计字段', typeof statCat.txCount === 'number' && typeof statCat.txAmount === 'string', `txCount=${statCat.txCount} txAmount=${statCat.txAmount}`);

// 有账单引用的分类：只停用不物理删除
const usedCat = tree[0];
insertTx({ category_id: usedCat.children[0].id, parent_category_id: usedCat.id, account_delta: -1000, amount: 1000, actual_amount: 1000, tx_date: day(-4) });
r = await call('GET', `/ledgers/${ledgerA}/categories`, { token: tokenA });
const usedParent = r.json.data.find((p) => p.id === usedCat.id);
check('主类别 txCount 聚合了子类引用', usedParent.txCount >= 1, `got ${usedParent.txCount}`);
r = await call('DELETE', `/ledgers/${ledgerA}/categories/${usedCat.id}`, { token: tokenA });
check('有引用分类仅停用（返回引用数）', r.status === 200 && r.json.data.txCount >= 1, `txCount=${r.json?.data?.txCount}`);
const stillThere = db
  .prepare('SELECT COUNT(*) AS c FROM categories WHERE id = ?')
  .get(usedCat.id);
check('停用而非物理删除（行仍在库中）', Number(stillThere.c) === 1);

/* =================== 5) 标签 =================== */
console.log('\n=== 5) 标签 ===');
r = await call('GET', `/ledgers/${ledgerA}/tags`, { token: tokenA });
check('预置标签 8 个', r.status === 200 && r.json.data.length === 8, `got ${r.json?.data?.length}`);
check('标签含 color 与 useCount', typeof r.json.data[0].color === 'string' && typeof r.json.data[0].useCount === 'number');

r = await call('POST', `/ledgers/${ledgerA}/tags`, { token: tokenA, body: { name: '测试标签' } });
check('新建标签 201（自动配色）', r.status === 201 && /^#[0-9A-F]{6}$/i.test(r.json.data.color), `got ${r.status} ${r.json?.data?.color}`);
const tagId = r.json?.data?.id;

r = await call('POST', `/ledgers/${ledgerA}/tags`, { token: tokenA, body: { name: '测试标签' } });
check('同名标签 → 409', r.status === 409, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/tags`, { token: tokenA, body: { name: 'x', color: '#123456' } });
check('非法色值被拒 → 400', r.status === 400, `got ${r.status}`);

db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(
  db.prepare('SELECT id FROM transactions WHERE ledger_id = ? LIMIT 1').get(ledgerA).id,
  tagId,
);
r = await call('GET', `/ledgers/${ledgerA}/tags`, { token: tokenA });
check('useCount 实时统计为 1', r.json.data.find((t) => t.id === tagId)?.useCount === 1, `got ${r.json.data.find((t) => t.id === tagId)?.useCount}`);

r = await call('DELETE', `/ledgers/${ledgerA}/tags/${tagId}`, { token: tokenA });
check('删除标签返回使用次数', r.status === 200 && r.json.data.useCount === 1);

/* =================== 6) 对账 =================== */
console.log('\n=== 6) 对账 ===');
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
const before = r.json.data.balance;
check('对账前余额可读', typeof before === 'string', `balance=${before}`);

const beforeCents = Math.round(Number(before) * 100);
const targetCents = 600000; // 实际余额 6000.00
const expectedDiff = targetCents - beforeCents;
const expectedDiffStr = yuan(Math.abs(expectedDiff));
const signedStr = `${expectedDiff < 0 ? '-' : ''}${yuan(Math.abs(expectedDiff))}`;

r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile/preview`, {
  token: tokenA,
  body: { actualBalance: '6000.00', reconcileDate: day(0) },
});
check('对账预览 200', r.status === 200, `got ${r.status}`);
check('预览返回 systemBalance = 当前账面', r.json.data.systemBalance === before, `${r.json?.data?.systemBalance} vs ${before}`);
check('diffAmount = 实际 − 账面', r.json.data.diffAmount === signedStr, `got ${r.json?.data?.diffAmount} 期望 ${signedStr}`);
check('不一致时 isBalanced=false', r.json.data.isBalanced === false);
check('返回 suggestedReasons', Array.isArray(r.json.data.suggestedReasons) && r.json.data.suggestedReasons.length > 0);

r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile`, {
  token: tokenA,
  body: { actualBalance: '6000.00', reconcileDate: day(0) },
});
check('有差异但未填原因 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile`, {
  token: tokenA,
  body: { actualBalance: '6000.00', reconcileDate: day(0), reasonCode: 'bank_fee' },
});
check('正式提交对账 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const rec = r.json?.data;
check('生成 adjustment 调整单', Boolean(rec?.adjustmentTransaction?.id));
check('调整单 amount = |差额|', rec.adjustmentTransaction?.amount === expectedDiffStr, `got ${rec?.adjustmentTransaction?.amount} 期望 ${expectedDiffStr}`);
check('调整单 accountDelta 保留符号', rec.adjustmentTransaction?.accountDelta === signedStr, `got ${rec?.adjustmentTransaction?.accountDelta} 期望 ${signedStr}`);
check('对账后余额 = 实际余额', rec.newBalance === '6000.00', `got ${rec?.newBalance}`);

r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
check('账面余额确实被调整单修正为 6000', r.json.data.balance === '6000.00', `got ${r.json?.data?.balance}`);

const adjRow = db
  .prepare(`SELECT record_type, amount, actual_amount, account_delta, adjustment_reason FROM transactions WHERE id = ?`)
  .get(rec.adjustmentTransaction.id);
check('调整单落库 record_type=adjustment', adjRow.record_type === 'adjustment');
check('调整单 actual = |Δ|', adjRow.actual_amount === Math.abs(adjRow.account_delta));
check('调整单记录 adjustment_reason', adjRow.adjustment_reason === 'bank_fee', `got ${adjRow.adjustment_reason}`);

r = await call('GET', `/ledgers/${ledgerA}/reconciliations`, { token: tokenA });
check('对账历史可查', r.status === 200 && r.json.data.length >= 1, `got ${r.json?.data?.length}`);
check('历史含 operator 与 diffAmount', typeof r.json.data[0].operator?.nickname === 'string' && typeof r.json.data[0].diffAmount === 'string');

r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}`, { token: tokenA });
check('账户 lastReconciledAt 已更新', r.json.data.lastReconciledAt === day(0), `got ${r.json?.data?.lastReconciledAt}`);
check('账户 lastReconciledBalance 已更新', r.json.data.lastReconciledBalance === '6000.00', `got ${r.json?.data?.lastReconciledBalance}`);
check('unreconciledDiff 归零', r.json.data.unreconciledDiff === '0.00', `got ${r.json?.data?.unreconciledDiff}`);

// 账实相符路径
r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile/preview`, {
  token: tokenA,
  body: { actualBalance: '6000.00', reconcileDate: day(0) },
});
// 预览层**不**返回 adjustmentTransaction —— 调整单是 submit 的产物
// （service.ts 里 previewReconcile 与 submitReconcile 是两个不同出口）。
// 「无调整单」在预览阶段体现为 diffAmount === '0.00'。
check(
  '账实相符：isBalanced=true 且 diffAmount=0',
  r.status === 200 && r.json.data.isBalanced === true && r.json.data.diffAmount === '0.00',
  `got ${r.status} balanced=${r.json?.data?.isBalanced} diff=${r.json?.data?.diffAmount}`,
);

// reasonCode=other 必填说明
r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile`, {
  token: tokenA,
  body: { actualBalance: '5900.00', reasonCode: 'other' },
});
check('reasonCode=other 缺说明 → 400', r.status === 400, `got ${r.status}`);

r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile`, {
  token: tokenA,
  body: { actualBalance: '5900.00', reasonCode: 'other', reasonNote: '前台手工调整' },
});
check('other + 说明 → 200', r.status === 200, `got ${r.status}`);

// lockBeforeDate（用账实相符路径，避免额外生成调整单）
r = await call('GET', `/ledgers/${ledgerA}/accounts/${acc.id}/balance`, { token: tokenA });
const acc2Balance = r.json.data.balance;
r = await call('POST', `/ledgers/${ledgerA}/accounts/${acc.id}/reconcile`, {
  token: tokenA,
  body: { actualBalance: acc2Balance, reconcileDate: day(0), lockBeforeDate: true },
});
check('对账可锁定此前账单', r.status === 200 && r.json.data.lockedBeforeDate === day(0), `got ${r.status} ${r.json?.data?.lockedBeforeDate}`);
const lockRow = db.prepare('SELECT locked_before_date FROM accounts WHERE id = ?').get(acc.id);
check('locked_before_date 落库', lockRow.locked_before_date === day(0), `got ${lockRow.locked_before_date}`);

r = await call('GET', `/ledgers/${ledgerA}/reconciliation-summary`, { token: tokenA });
check('账本健康度可读', r.status === 200 && typeof r.json.data.totalAccounts === 'number');
check('健康度含 90 天对账次数', typeof r.json.data.reconcileCount90d === 'number', `got ${r.json?.data?.reconcileCount90d}`);
check('健康度含 averageDiff', typeof r.json.data.avgAbsDiff === 'string');

/* =================== 7) 净资产与汇总 =================== */
console.log('\n=== 7) 汇总 ===');
r = await call('GET', `/ledgers/${ledgerA}/accounts/summary`, { token: tokenA });
check('汇总接口 200', r.status === 200, `got ${r.status}`);
const sum = r.json.data;
check('虚拟账户不计入净资产', typeof sum.netWorth === 'string' && typeof sum.assetTotal === 'string');
// 逐账户求和要跟 summary 的 assetTotal 对齐，所以这里取**账户列表**而不是 summary 对象
const accsAll = await call('GET', `/ledgers/${ledgerA}/accounts`, { token: tokenA });
const manualAssets = accsAll.json.data
  .filter((a) => a.kind === 'asset' && a.archivedAt === null)
  .reduce((n, a) => n + Math.round(Number(a.balance) * 100), 0);
check('assetTotal 与逐账户求和一致', yuan(manualAssets) === sum.assetTotal, `${yuan(manualAssets)} vs ${sum.assetTotal}`);

/* =================== 8) 权限与隔离 =================== */
console.log('\n=== 8) 权限与数据隔离 ===');
r = await call('GET', `/ledgers/${ledgerB}/accounts/summary`, {});
check('无令牌 → 401', r.status === 401, `got ${r.status}`);
// ⚠️ 必须是「拿 B 的令牌读 A 的分类」才是跨账本；写成 ledgerB + tokenB 是同账本，
// 必然 200 —— 断言会假红，而且把「隔离」这条最重要的保护测成了空气。
r = await call('GET', `/ledgers/${ledgerA}/categories`, { token: tokenB });
check('跨账本读分类 → 404', r.status === 404, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerB}/accounts`, {
  token: tokenB,
  body: { groupId: 'x', name: 'y', type: 'cash' },
});
check('跨账本建账户 → 404', r.status === 404, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerB}/accounts/${acc2.id}/reconcile`, {
  token: tokenB,
  body: { actualBalance: '1.00', reasonCode: 'bank_fee' },
});
check('跨账本对账 → 404', r.status === 404, `got ${r.status}`);
r = await call('DELETE', `/ledgers/${ledgerB}/tags/${tagId}`, { token: tokenB });
check('跨账本删标签 → 404', r.status === 404, `got ${r.status}`);

/* =================== 9) 归档保护 =================== */
console.log('\n=== 9) 归档与保护 ===');
const sysAcc = accsAll.json.data.find((a) => a.isSystem);
r = await call('DELETE', `/ledgers/${ledgerA}/accounts/${sysAcc.id}`, { token: tokenA });
check('系统虚拟账户不可归档 → 400', r.status === 400, `got ${r.status}`);

r = await call('DELETE', `/ledgers/${ledgerA}/accounts/${cardId}`, { token: tokenA });
check('普通账户可归档 → 204', r.status === 204, `got ${r.status}`);
r = await call('GET', `/ledgers/${ledgerA}/accounts`, { token: tokenA });
check('归档后默认列表不含该账户', !r.json.data.some((a) => a.id === cardId));
r = await call('GET', `/ledgers/${ledgerA}/accounts?includeArchived=true`, { token: tokenA });
check('includeArchived=true 可查到', r.json.data.some((a) => a.id === cardId));

/**
 * 删分组**不带走账户**：组内账户统一移到「未分组」，分组本身物理删除。
 * 之前这里是「分组下仍有账户 → 400」，那等于把账户锁死在一个不想用的分类里。
 */
r = await call('DELETE', `/ledgers/${ledgerA}/account-groups/${newGroupId}`, { token: tokenA });
check(
  '删分组 → 组内账户移到「未分组」（mode=removed）200',
  r.status === 200 && r.json.data.mode === 'removed' && r.json.data.movedAccounts >= 1,
  `got ${r.status} ${JSON.stringify(r.json?.data)}`,
);
r = await call('GET', `/ledgers/${ledgerA}/accounts?includeArchived=true`, { token: tokenA });
check(
  '被删分组的账户仍在，且归属「未分组」',
  r.json.data.some(
    (a) => a.id === cardId && (a.groupName === '未分组' || /未分组/.test(a.groupName ?? '')),
  ),
  `cardId 归属 ${r.json.data.find((a) => a.id === cardId)?.groupName}`,
);

/* =================== 9.5) 账户分组生命周期 =================== */
console.log('\n=== 9.5) 账户分组：增 / 改 / 停用 / 恢复 ===');

// 建：带 Lucide 图标名与负债类型
r = await call('POST', `/ledgers/${ledgerA}/account-groups`, {
  token: tokenA,
  body: { name: '房贷专项', kind: 'liability', icon: 'landmark' },
});
check('新建分组（负债 + Lucide 图标）201', r.status === 201, `got ${r.status}`);
const lifeGroup = r.json?.data;
check('分组回参含 icon/kind/archivedAt', lifeGroup?.icon === 'landmark' && lifeGroup?.kind === 'liability' && lifeGroup?.archivedAt === null);

// 改：名称 + 类型 + 图标
r = await call('PATCH', `/ledgers/${ledgerA}/account-groups/${lifeGroup.id}`, {
  token: tokenA,
  body: { name: '房贷专项（改名）', kind: 'asset', icon: 'vault' },
});
check('更新分组名称/类型/图标 200', r.status === 200 && r.json.data.name === '房贷专项（改名）' && r.json.data.kind === 'asset' && r.json.data.icon === 'vault', `got ${r.status}`);

// 名称为空 / 过长 → 400
r = await call('PATCH', `/ledgers/${ledgerA}/account-groups/${lifeGroup.id}`, {
  token: tokenA, body: { name: '' },
});
check('分组名为空 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerA}/account-groups`, {
  token: tokenA, body: { name: '一二三四五六七八九十一二三四五六七八九十一', kind: 'asset' },
});
check('分组名超过 20 字 → 400', r.status === 400, `got ${r.status}`);

// 空分组直接物理删除
r = await call('DELETE', `/ledgers/${ledgerA}/account-groups/${lifeGroup.id}`, { token: tokenA });
check('空分组 → 物理删除（mode=removed）200', r.status === 200 && r.json.data.mode === 'removed' && r.json.data.movedAccounts === 0, `got ${r.status} ${JSON.stringify(r.json?.data)}`);
r = await call('GET', `/ledgers/${ledgerA}/account-groups`, { token: tokenA });
check('物理删除后列表不含该分组', !r.json.data.some((g) => g.id === lifeGroup.id));
r = await call('GET', `/ledgers/${ledgerA}/account-groups?includeArchived=true`, { token: tokenA });
check('物理删除后 includeArchived 也不含（无幽灵行）', !r.json.data.some((g) => g.id === lifeGroup.id));

// 重新建同名分组 → 应放行（名字已释放）
r = await call('POST', `/ledgers/${ledgerA}/account-groups`, {
  token: tokenA, body: { name: '房贷专项（改名）', kind: 'liability' },
});
check('删除后同名可重建 201', r.status === 201, `got ${r.status}`);
const lifeGroup2 = r.json?.data;

// 分组下建账户 → 删除时账户保留并搬走（有活跃账户时**停用**才被拒）
r = await call('POST', `/ledgers/${ledgerA}/accounts`, {
  token: tokenA,
  body: { groupId: lifeGroup2.id, name: '房贷账户（冒烟）', type: 'loan', openingBalance: '-1200000.00', openingDate: day(-40) },
});
check('在分组下建账户 201', r.status === 201, `got ${r.status}`);
const lifeAcc = r.json?.data;
/* 用 lifeGroup3 承接后面的「停用 → 恢复」生命周期：lifeGroup2 在本段已被删除 */
let lifeGroup3 = null;
r = await call('POST', `/ledgers/${ledgerA}/account-groups/${lifeGroup2.id}/archive`, { token: tokenA });
check('有活跃账户 → 停用 400 且提示数量', r.status === 400 && /1 个账户/.test(r.json?.error?.message ?? ''), `got ${r.status} ${r.json?.error?.message}`);

// 删掉分组 → 账户搬到「未分组」，分组本身物理删除（不再是「转为停用」）
r = await call('DELETE', `/ledgers/${ledgerA}/account-groups/${lifeGroup2.id}`, { token: tokenA });
check('有活跃账户 → 删除 200 且搬走账户', r.status === 200 && r.json.data.movedAccounts === 1, `got ${r.status} ${JSON.stringify(r.json?.data)}`);
r = await call('GET', `/ledgers/${ledgerA}/accounts`, { token: tokenA });
check('账户仍在且已归属「未分组」', r.json.data.some((a) => a.id === lifeAcc.id && /未分组/.test(a.groupName ?? '')), `got ${r.json.data.find((a) => a.id === lifeAcc.id)?.groupName}`);

// 停用走**显式**停用接口：空分组可停用，停用的分组可恢复
r = await call('POST', `/ledgers/${ledgerA}/account-groups`, {
  token: tokenA, body: { name: '房贷专项（停用用）', kind: 'asset' },
});
check('另建一个空分组 201', r.status === 201, `got ${r.status}`);
lifeGroup3 = r.json?.data;
r = await call('POST', `/ledgers/${ledgerA}/account-groups/${lifeGroup3.id}/archive`, { token: tokenA });
check('空分组可停用 200', r.status === 200 && r.json.data.archivedAt, `got ${r.status}`);
const archivedGroup = lifeGroup3;
r = await call('GET', `/ledgers/${ledgerA}/account-groups`, { token: tokenA });
check('停用分组默认不可见', !r.json.data.some((g) => g.id === archivedGroup.id));
r = await call('GET', `/ledgers/${ledgerA}/account-groups?includeArchived=true`, { token: tokenA });
check('includeArchived=true 可查到停用分组', r.json.data.some((g) => g.id === archivedGroup.id && g.archivedAt));

// 停用即释放名字：同名新分组可建（部分唯一索引）
r = await call('POST', `/ledgers/${ledgerA}/account-groups`, {
  token: tokenA, body: { name: archivedGroup.name, kind: 'asset' },
});
check('停用后同名可重建 201（部分唯一索引）', r.status === 201, `got ${r.status}`);
const clashGroup = r.json?.data;

// 恢复同名 → 409
r = await call('POST', `/ledgers/${ledgerA}/account-groups/${archivedGroup.id}/restore`, { token: tokenA });
check('同名活跃分组存在时恢复 → 409', r.status === 409, `got ${r.status}`);

// 清掉同名活跃分组后恢复成功
r = await call('DELETE', `/ledgers/${ledgerA}/account-groups/${clashGroup.id}`, { token: tokenA });
check('删除同名活跃分组（空）→ removed', r.status === 200 && r.json.data.mode === 'removed', `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerA}/account-groups/${archivedGroup.id}/restore`, { token: tokenA });
check('恢复停用分组 200', r.status === 200 && r.json.data.archivedAt === null, `got ${r.status}`);
r = await call('GET', `/ledgers/${ledgerA}/account-groups`, { token: tokenA });
check('恢复后默认列表可见', r.json.data.some((g) => g.id === archivedGroup.id));

// 幂等：重复恢复不报错
r = await call('POST', `/ledgers/${ledgerA}/account-groups/${archivedGroup.id}/restore`, { token: tokenA });
check('重复恢复幂等 200', r.status === 200, `got ${r.status}`);

// 隔离与鉴权
r = await call('PATCH', `/ledgers/${ledgerB}/account-groups/${archivedGroup.id}`, {
  token: tokenA, body: { name: '越权改名' },
});
check('跨账本改分组 → 404', r.status === 404, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerB}/account-groups/${archivedGroup.id}/restore`, { token: tokenA });
check('跨账本恢复分组 → 404', r.status === 404, `got ${r.status}`);
r = await call('DELETE', `/ledgers/${ledgerA}/account-groups/grp_not_exist_${stamp}`, { token: tokenA });
check('删除不存在的分组 → 404', r.status === 404, `got ${r.status}`);
r = await call('POST', `/ledgers/${ledgerA}/account-groups`, { body: { name: '无令牌' } });
check('无令牌建分组 → 401', r.status === 401, `got ${r.status}`);

/* =================== 10) 审计 =================== */
console.log('\n=== 10) 更新与审计 ===');
r = await call('PATCH', `/ledgers/${ledgerA}/accounts/${acc2.id}`, {
  token: tokenA,
  body: { name: '转入户（改名）', note: '冒烟改名' },
});
check('更新账户 200 且名称已变', r.status === 200 && r.json.data.name === '转入户（改名）', `got ${r.status} ${r.json?.data?.name}`);

r = await call('PATCH', `/ledgers/${ledgerA}/account-groups/${archivedGroup.id}`, {
  token: tokenA,
  body: { name: '境外账户（改名）' },
});
check('更新分组 200', r.status === 200 && r.json.data.name === '境外账户（改名）', `got ${r.status}`);

const auditActions = db
  .prepare(`SELECT DISTINCT action FROM ledger_logs WHERE ledger_id = ?`)
  .all(ledgerA)
  .map((x) => x.action);
check('记录了 create/update/delete', ['create', 'update', 'delete'].every((a) => auditActions.includes(a)), auditActions.join(','));
check('记录了对账动作 reconcile', auditActions.includes('reconcile'), auditActions.join(','));

db.close();

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
