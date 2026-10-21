/**
 * Stage 16 冒烟：**退款（冲减项）口径**。
 *
 * 要证的不是「接口通不通」，而是三件容易静默错的事：
 *   · 退款**不能**虚增收入（记成 income 是最常见的错法，且净结余碰巧是对的）
 *   · 退款后**分类支出**要回落（不相减就会 210 + 210 = 420）
 *   · **部分退款**与**跨月退款**都要正确，且跨月不需要回滚原月
 *
 * 用法：node scripts/smoke-stage16.mjs [baseUrl]
 */
import { P, qs } from './lib/url.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
let pass = 0, fail = 0; const failures = [];
const check = (n, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${n}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(n); console.log(`  ❌ ${n}${extra ? '  ' + extra : ''}`); }
};
const call = async (method, path, { body, token } = {}) => {
  const headers = { 'X-Forwarded-For': `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { __raw: text.slice(0, 200) }; }
  return { status: res.status, json };
};
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date(); const todayStr = iso(now);
const Y = now.getFullYear(), M = now.getMonth() + 1, MP = pad(M);
const lastMonth = iso(new Date(Y, M - 2, 15));

console.log('\n━━ Stage 16 · 退款（冲减项）口径 ━━\n');

const reg = await call('POST', '/auth/register', { body: { username: `rf${Date.now().toString(36)}`.slice(0, 32), nickname: '退款', password: 'RefundPass!2026', platform: 'web' } });
if (reg.status !== 201 && reg.status !== 200) { console.error('注册失败', JSON.stringify(reg.json)); process.exit(1); }
const token = reg.json.data.accessToken;
const ledger = (await call('GET', '/ledgers', { token })).json.data[0];
const G = (await call('GET', P`/ledgers/${ledger.id}/account-groups`, { token })).json.data;
const grp = G.find((x) => x.id.endsWith('#grp_bank')) ?? G[0];
const acc = (await call('POST', P`/ledgers/${ledger.id}/accounts`, { token, body: { groupId: grp.id, name: '退款卡', type: 'debit_card', openingBalance: '10000.00' } })).json.data;
const cats = (await call('GET', P`/ledgers/${ledger.id}/categories?recordType=expense`, { token })).json.data;
const cat = (cats.find((p) => (p.children ?? []).length) ?? cats[0]).children[0];

const tx = async (body) => (await call('POST', P`/ledgers/${ledger.id}/transactions`, { token, body: { accountId: acc.id, txDate: todayStr, fee: '0', discount: '0', ...body } }));
/**
 * ⚠️ 查询串必须拼在 P 标签模板**之外**。P 会把每个插值做 encodeURIComponent，
 * 查询串里的分隔符一旦被转义，服务端就只看到一个超长的路径段，结果是 404。
 * 所以路径走 P、查询串走 qs()，两者分开。
 */
const summary = async (from, to) =>
  (await call('GET', P`/ledgers/${ledger.id}/stats/summary` + qs({ dateFrom: from, dateTo: to }), { token })).json.data;

/* ══════ 1. 全额退款：净支出归零，收入不受影响 ══════ */
console.log('── 1. 全额退款 ──');
const e1 = (await tx({ recordType: 'expense', categoryId: cat.id, name: '买鞋', amount: '210.00' })).json.data;
check('建一笔支出 210', !!e1?.id, e1?.id);
let s = await summary(`${Y}-${MP}-01`, todayStr);
check('退款前支出 = 210.00', s.totalExpense === '210.00', s.totalExpense);
check('退款前收入 = 0.00', s.totalIncome === '0.00', s.totalIncome);

const r1 = await tx({ recordType: 'expense', categoryId: cat.id, name: '退货退款', amount: '210.00', isRefund: true });
check('建退款 201/200', r1.status === 201, `got ${r1.status} ${JSON.stringify(r1.json?.error ?? '')}`);
const rr = r1.json.data;
check('退款被标记为 refund', rr?.adjustmentReason === 'refund', rr?.adjustmentReason);
check('退款的账户Δ是**正**的（钱回来了）', Number(rr?.accountDelta) > 0, String(rr?.accountDelta));

s = await summary(`${Y}-${MP}-01`, todayStr);
check('★ 全额退款后支出 = 0.00（不是 420）', s.totalExpense === '0.00', s.totalExpense);
check('★ 收入仍为 0.00（退款没被记成收入）', s.totalIncome === '0.00', s.totalIncome);
check('净结余 = 0.00', s.netBalance === '0.00', s.netBalance);

/* ══════ 2. 部分退款 ══════ */
console.log('\n── 2. 部分退款 ──');
await tx({ recordType: 'expense', categoryId: cat.id, name: '买书', amount: '100.00' });
const r2 = await tx({ recordType: 'expense', categoryId: cat.id, name: '退一本', amount: '30.00', isRefund: true });
check('部分退款 201', r2.status === 201, `got ${r2.status}`);
s = await summary(`${Y}-${MP}-01`, todayStr);
check('★ 部分退款后支出 = 70.00（100 − 30）', s.totalExpense === '70.00', s.totalExpense);

/* ══════ 3. 跨月退款 ══════ */
console.log('\n── 3. 跨月退款 ──');
const old = await tx({ recordType: 'expense', categoryId: cat.id, name: '上月消费', amount: '500.00', txDate: lastMonth });
check('上月支出 201（可能是已结账→允许）', old.status === 201 || old.status === 400, `got ${old.status}`);
const lastFrom = lastMonth.slice(0, 8) + '01';
const sLastBefore = await summary(lastFrom, lastMonth);
const r3 = await tx({ recordType: 'expense', categoryId: cat.id, name: '跨月退款', amount: '500.00', txDate: lastMonth, isRefund: true });
check('跨月退款 201', r3.status === 201, `got ${r3.status} ${JSON.stringify(r3.json?.error ?? '')}`);
const sLastAfter = await summary(lastFrom, lastMonth);
check(
  '★ 跨月退款冲减的是**原属期**，本月不受影响',
  sLastAfter.totalExpense !== sLastBefore.totalExpense,
  `${sLastBefore.totalExpense} → ${sLastAfter.totalExpense}`,
);

/* ══════ 4. 分类维度也冲减 ══════ */
console.log('\n── 4. 分类维度 ──');
const catNet = (await call('GET', P`/ledgers/${ledger.id}/stats/category-expense-net`, { token })).json.data;
const row = (catNet ?? []).find((x) => x.categoryId === cat.id);
check('分类合计已扣冲减项（不是 810）', row && Number(row.amount) < 810, JSON.stringify({ amount: row?.amount }));

/* ══════ 5. 退款的校验闸 ══════ */
console.log('\n── 5. 校验闸 ──');
const badFee = await tx({ recordType: 'expense', categoryId: cat.id, name: '带手续费的退款', amount: '10.00', fee: '1.00', isRefund: true });
check('退款带手续费 → 400', badFee.status === 400, `got ${badFee.status}`);
const badCat = await tx({ recordType: 'expense', name: '无分类退款', amount: '10.00', isRefund: true });
check('退款不选分类 → 400（否则冲减不到任何一类）', badCat.status === 400, `got ${badCat.status}`);
const badType = await tx({ recordType: 'transfer', toAccountId: acc.id, name: '转账退款', amount: '10.00', isRefund: true });
check('转账标退款 → 400', badType.status === 400, `got ${badType.status}`);

/* ══════ 6. 不变量巡检 ══════ */
console.log('\n── 6. 不变量 ──');
const audit = await import('node:child_process');
try {
  audit.execSync('node scripts/audit-ledger-invariants.mjs', { stdio: 'pipe' });
  check('账务不变量巡检通过', true, '');
} catch (e) {
  check('账务不变量巡检通过', false, String(e.stdout ?? '').slice(-200));
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
