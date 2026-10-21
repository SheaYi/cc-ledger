import { qs } from './lib/url.mjs';
/**
 * Stage 11 端到端冒烟：**分期账单**（`docs/05 §十二` + `docs/04 §十一`）。
 *
 * 核心断言是**恒等式**，不是「某期等于某值」：
 *   · `Σ principal === totalAmount`、`Σ fee === totalFee`
 *   · **`Σ totalDue === 本金 + 手续费`** —— 这条破了，用户的信用卡就会残留或提前归零，
 *     而且**不会报任何错**（每期少还 1 分，钱包就是错的）。
 *   · **12 期还完后负债账户余额归零**（`docs/05 §12.3` 的步骤 3）
 *   · **绝不重复计支出**：全程支出账单只有 1 笔（首笔），每期是转账
 *
 * 用法：node scripts/smoke-stage12.mjs [baseUrl]
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
  const encoded = pathPart.split('/').map((s) => (s ? encodeURIComponent(s) : s)).join('/');
  return query ? `${encoded}?${query}` : encoded;
}

const FAKE_IP = `10.28.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

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

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => {
  const parts = s.split('-').map(Number);
  const x = new Date(parts[0], parts[1] - 1, parts[2] + n);
  return day(x);
};
const todayStr = day(new Date());
const centsOf = (s) => Math.round(Number(s) * 100);

console.log('\n━━ Stage 11 · 分期账单 ━━\n');

// ---------- 独立账本 ----------
const reg = await call('POST', '/auth/register', {
  body: {
    username: `s12${Date.now().toString(36)}`.slice(0, 32),
    nickname: '分期测试',
    password: 'Smoke12Pass!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error('注册失败：', JSON.stringify(reg.json));
  process.exit(1);
}
const token = reg.json.data.accessToken;
const ledgerId = (await call('POST', '/ledgers', { token, body: { name: `分期测试 ${todayStr}`, currency: 'CNY' } })).json.data.id;

const groups = (await call('GET', `/ledgers/${ledgerId}/account-groups`, { token })).json.data;
const gBank = groups.find((g) => g.id.endsWith('#grp_bank')) ?? groups[0];
const gCredit = groups.find((g) => g.id.endsWith('#grp_credit')) ?? groups[0];
// 还款账户（出钱的）
await call('POST', `/ledgers/${ledgerId}/accounts`, {
  token,
  body: { name: '储蓄卡', type: 'debit_card', groupId: gBank.id, openingBalance: '50000.00' },
});
// 负债账户（刷的）
await call('POST', `/ledgers/${ledgerId}/accounts`, {
  token,
  body: { name: '信用卡', type: 'credit_card', groupId: gCredit.id, openingBalance: '0.00', creditLimit: '50000.00' },
});
const accs = (await call('GET', `/ledgers/${ledgerId}/accounts`, { token })).json.data;
const savings = accs.find((a) => a.name === '储蓄卡');
const credit = accs.find((a) => a.name === '信用卡');

const cats = (await call('GET', `/ledgers/${ledgerId}/categories`, { token })).json.data;
let phone = null;
for (const p of cats) {
  if (p.recordType !== 'expense') continue;
  for (const c of p.children ?? []) if (/数码|电子|手机/.test(p.name + c.name)) phone = c;
}
check('测试账本具备分期所需的两类账户与分类', !!savings && !!credit && !!phone, `${savings?.name}/${credit?.name}/${phone?.name}`);

const base = `/ledgers/${ledgerId}/installment-plans`;
const balanceOf = async (accountId) =>
  Number((await call('GET', `/ledgers/${ledgerId}/accounts`, { token })).json.data.find((a) => a.id === accountId).balance);
const txCount = async (query = '') =>
  // ⚠️ query 参数是**已带 ? 的裸串**（调用方传 '&recordType=expense'），必须拼在 qs 之后
  (await call('GET', `/ledgers/${ledgerId}/transactions` + qs({ pageSize: 1 }) + query, { token })).json.meta.total;

/* ================= 1. 创建 ================= */
console.log('— 1. 创建（自动生成首笔支出 + 12 期明细）');
const txBefore = await txCount();
const created = await call('POST', base, {
  token,
  body: {
    title: 'iPhone',
    totalAmount: '12000.00',
    totalFee: '600.00',
    installmentCount: 12,
    frequency: 'monthly',
    // 首期就用今天：账户 opening_date = 建账当天，2026-10-14 起余额公式是 `≤`，
    // 当天的账计入（docs/14-期初余额口径决策.md）。旧口径下这里不得不写成
    // 「明天」来规避「首笔支出不进余额」—— 现在那个绕行已不需要，
    // 而用今天才真正验到「首期当天建账、当天还款」的路径。
    firstDate: todayStr,
    feeMode: 'once',
    feeHandling: 'first_period',
    accountId: savings.id,
    debtAccountId: credit.id,
    recordType: 'expense',
    categoryId: phone.id,
    merchant: 'Apple 店',
  },
});
check('创建成功返回 201', created.status === 201, String(created.status));
const plan = created.json.data?.plan;
const startTx = created.json.data?.startTransaction;
check('返回了首笔支出', !!startTx?.id, JSON.stringify(startTx));
check('grandTotal = 本金 + 手续费', plan?.grandTotal === '12600.00', String(plan?.grandTotal));
check('进度初始为 0/N', plan?.progress?.paidCount === 0 && plan?.progress?.totalCount === 12, JSON.stringify(plan?.progress));
check('账单 +1（只有这一笔支出）', (await txCount()) === txBefore + 1, `${txBefore} → ${await txCount()}`);

const creditAfterBuy = await balanceOf(credit.id);
check('负债账户被记了 −12600', creditAfterBuy === -12600, String(creditAfterBuy));
check(
  '首笔支出的日期 = 首期日期',
  (await call('GET', `/ledgers/${ledgerId}/transactions` + qs({ pageSize: 5 }), { token })).json.data[0].txDate === todayStr,
  '首期首笔记在首期日（今天）',
);
const savingsAfterBuy = await balanceOf(savings.id);
check('还款账户未被首笔支出影响', savingsAfterBuy === 50000, String(savingsAfterBuy));

/* ================= 2. 期表与恒等式 ================= */
console.log('\n— 2. 期表恒等式');
const scheds = (await call('GET', `${base}/${plan.id}/schedules`, { token })).json.data;
check('12 期', scheds.length === 12, String(scheds.length));
check('seq 连续 1..12', scheds.every((s, i) => s.seq === i + 1), 'ok');
check(
  '首期 = 1000 本金 + 600 手续费 = 1600',
  centsOf(scheds[0].principal) === 100000 && centsOf(scheds[0].fee) === 60000 && centsOf(scheds[0].totalDue) === 160000,
  JSON.stringify(scheds[0]),
);
check('其余各期各还 1000', scheds.slice(1).every((s) => centsOf(s.totalDue) === 100000), String(centsOf(scheds[1].totalDue)));
check(
  'Σ principal === 总额',
  scheds.reduce((a, s) => a + centsOf(s.principal), 0) === 1200000,
  String(scheds.reduce((a, s) => a + centsOf(s.principal), 0)),
);
check(
  'Σ fee === 总手续费',
  scheds.reduce((a, s) => a + centsOf(s.fee), 0) === 60000,
  String(scheds.reduce((a, s) => a + centsOf(s.fee), 0)),
);
check(
  '**Σ totalDue === 本金 + 手续费**（分期存在的理由）',
  scheds.reduce((a, s) => a + centsOf(s.totalDue), 0) === 1260000,
  String(scheds.reduce((a, s) => a + centsOf(s.totalDue), 0)),
);
check('到期日逐月递增', scheds.every((s, i) => i === 0 || s.dueDate > scheds[i - 1].dueDate), scheds.map((s) => s.dueDate).join(' '));

/* ================= 3. 校验（上轮教训：必须逐条对齐生成路径） ================= */
console.log('\n— 3. 写入校验');
const mk = (over) =>
  call('POST', base, {
    token,
    body: {
      title: `坏${Math.random().toString(36).slice(2, 6)}`,
      totalAmount: '1000.00',
      installmentCount: 12,
      firstDate: todayStr,
      accountId: savings.id,
      debtAccountId: credit.id,
      categoryId: phone.id,
      ...over,
    },
  });
check('重名被拒（409）', (await call('POST', base, { token, body: { title: 'iPhone', totalAmount: '1.00', installmentCount: 2, firstDate: todayStr, accountId: savings.id, debtAccountId: credit.id, categoryId: phone.id } })).status === 409, '');
check('账户相同被拒（转账要求两端不同）', (await mk({ debtAccountId: savings.id })).status === 400, '');
check('账户不存在被拒', (await mk({ accountId: 'acc_没有' })).status === 400, '');
check('分类缺失被拒（首笔支出要分类）', (await mk({ categoryId: null })).status === 400, '');
check('分类类型不匹配被拒', (await mk({ recordType: 'income' })).status === 400, '');
check('虚拟账户被拒', (await mk({ debtAccountId: accs.find((a) => a.kind === 'virtual')?.id })).status === 400, '');
check('期数超范围被拒（0 / 61）', (await mk({ installmentCount: 0 })).status === 400 && (await mk({ installmentCount: 61 })).status === 400, '');
check('金额为 0 被拒', (await mk({ totalAmount: '0' })).status === 400, '');

/* ================= 4. 还款（转账，不是支出） ================= */
console.log('\n— 4. 还款');
const txBeforePay = await txCount();
const pay1 = await call('POST', `/ledgers/${ledgerId}/installment-schedules/${scheds[0].id}/pay`, { token, body: {} });
check('标记已还成功（201）', pay1.status === 201, String(pay1.status));
check('账单 +1', (await txCount()) === txBeforePay + 1, `${txBeforePay} → ${await txCount()}`);

const afterPay1 = await call('GET', `/ledgers/${ledgerId}/transactions` + qs({ pageSize: 50 }), { token });
const txList = afterPay1.json.data;
const repayTx = txList.find((t) => t.id === pay1.json.data.transactionId);
check('还的是**转账**不是支出', repayTx?.recordType === 'transfer', repayTx?.recordType);
check('转账两头正确（储蓄卡 → 信用卡）', repayTx?.account?.name === '储蓄卡' && repayTx?.toAccount?.name === '信用卡', `${repayTx?.account?.name} → ${repayTx?.toAccount?.name}`);
check('首期还了 1600', centsOf(repayTx?.amount) === 160000, String(repayTx?.amount));

const creditAfter1 = await balanceOf(credit.id);
check('负债账户回升 1600', creditAfter1 === -12600 + 1600, String(creditAfter1));
const savingsAfter1 = await balanceOf(savings.id);
check('还款账户减少 1600', savingsAfter1 === 50000 - 1600, String(savingsAfter1));

// 幂等：同一期再点一次
const payAgain = await call('POST', `/ledgers/${ledgerId}/installment-schedules/${scheds[0].id}/pay`, { token, body: {} });
check('同一期再点一次返回 200 + reused（不重复生成）', payAgain.status === 200 && payAgain.json.data.reused === true, `${payAgain.status} reused=${payAgain.json.data?.reused}`);
check('账单数不变', (await txCount()) === txBeforePay + 1, String(await txCount()));

/* ================= 5. 全部还完 → 负债归零 ================= */
console.log('\n— 5. 12 期还完，负债账户归零（docs/05 §12.3 步骤 3）');
for (const s of scheds.slice(1)) {
  await call('POST', `/ledgers/${ledgerId}/installment-schedules/${s.id}/pay`, { token, body: {} });
}
const creditFinal = await balanceOf(credit.id);
check('**负债账户归零**', creditFinal === 0, String(creditFinal));
const savingsFinal = await balanceOf(savings.id);
check('还款账户累计支出 12600', savingsFinal === 50000 - 12600, String(savingsFinal));

const after = (await call('GET', `${base}/${plan.id}`, { token })).json.data;
check('进度 12/12', after.progress.paidCount === 12, JSON.stringify(after.progress));
check('剩余 0.00', after.progress.remainingAmount === '0.00', after.progress.remainingAmount);
check('计划状态变为已还清', after.status === 'settled', after.status);
check(
  '**支出账单只有 1 笔**（不因还款重复计支出）',
  (await txCount('&recordType=expense')) === 1,
  `${await txCount('&recordType=expense')} 笔支出 / ${await txCount('&recordType=transfer')} 笔转账`,
);
check('转账账单 12 笔', (await txCount('&recordType=transfer')) === 12, String(await txCount('&recordType=transfer')));

/* ================= 6. 已还清后不可操作 ================= */
console.log('\n— 6. 结清后的约束');
check('已还清不能提前结清', (await call('POST', `${base}/${plan.id}/settle-early`, { token, body: {} })).status === 400, '');
check('已还清不能取消', (await call('POST', `${base}/${plan.id}/cancel`, { token, body: {} })).status === 400, '');
check('已还清不能删（已还的转账需要出处）', (await call('DELETE', `${base}/${plan.id}`, { token })).status === 400, '');

/* ================= 7. 提前结清 ================= */
console.log('\n— 7. 提前结清');
const plan2 = await call('POST', base, {
  token,
  body: {
    title: '家电',
    totalAmount: '6000.00',
    installmentCount: 12,
    firstDate: todayStr,
    accountId: savings.id,
    debtAccountId: credit.id,
    categoryId: phone.id,
  },
});
const plan2Dto = plan2.json.data.plan;
const scheds2 = (await call('GET', `${base}/${plan2Dto.id}/schedules`, { token })).json.data;
check('第二个计划建好（6 期数 × 500）', scheds2.length === 12 && centsOf(scheds2[0].totalDue) === 50000, JSON.stringify(scheds2[0]));
// 先还掉第 1 期 —— 这样「结清」验的才是**剩余 11 期**，而不是全部 12 期
await call('POST', `/ledgers/${ledgerId}/installment-schedules/${scheds2[0].id}/pay`, { token, body: {} });
const creditBeforeSettle = await balanceOf(credit.id);

// 结清日期用默认的「今天」：这正是要验的核心 —— 建账当天的转账也必须进余额，
// 否则「12 期还完负债账户归零」这条恒等式在同一天建账时就验不到（docs/14）。
const settle = await call('POST', `${base}/${plan2Dto.id}/settle-early`, {
  token,
  body: {},
});
check('提前结清成功', settle.status === 200, String(settle.status));
check('结清金额 = **剩余 11 期**合计（不含已还的第 1 期）', centsOf(settle.json.data.amount) === 550000, settle.json.data.amount);
check('结清涵盖 11 期', settle.json.data.periods === 11, String(settle.json.data.periods));
const creditAfterSettle = await balanceOf(credit.id);
check('结清后负债账户归零', creditAfterSettle === 0, `${creditBeforeSettle} → ${creditAfterSettle}`);
const plan2After = (await call('GET', `${base}/${plan2Dto.id}`, { token })).json.data;
check('结清后状态为已还清', plan2After.status === 'settled', plan2After.status);

/* ================= 8. 取消 ================= */
console.log('\n— 8. 取消分期');
const plan3 = await call('POST', base, {
  token,
  body: {
    title: '装修贷',
    totalAmount: '30000.00',
    installmentCount: 24,
    firstDate: todayStr,
    accountId: savings.id,
    debtAccountId: credit.id,
    categoryId: phone.id,
  },
});
const plan3Dto = plan3.json.data.plan;
const scheds3 = (await call('GET', `${base}/${plan3Dto.id}/schedules`, { token })).json.data;
await call('POST', `/ledgers/${ledgerId}/installment-schedules/${scheds3[0].id}/pay`, { token, body: {} });
const txBeforeCancel = await txCount();
check('取消成功', (await call('POST', `${base}/${plan3Dto.id}/cancel`, { token, body: {} })).status === 200, '');
check('取消不改账单（首笔支出与已还的转账都留着）', (await txCount()) === txBeforeCancel, `${txBeforeCancel} → ${await txCount()}`);
const plan3After = (await call('GET', `${base}/${plan3Dto.id}`, { token })).json.data;
check('状态为已取消', plan3After.status === 'cancelled', plan3After.status);
check('已还的期仍是 paid', plan3After.progress.paidCount === 1, JSON.stringify(plan3After.progress));
check('取消后不能再还剩下的期', (await call('POST', `/ledgers/${ledgerId}/installment-schedules/${scheds3[1].id}/pay`, { token, body: {} })).status === 400, '');
check('已还过期的计划不能删', (await call('DELETE', `${base}/${plan3Dto.id}`, { token })).status === 400, '');

/* ================= 9. 手续费模式 ================= */
console.log('\n— 9. 手续费模式');
const perPeriod = await call('POST', base, {
  token,
  body: {
    title: '订阅分期',
    totalAmount: '1200.00',
    perPeriodFee: '10.00',
    installmentCount: 12,
    firstDate: todayStr,
    feeMode: 'per_period',
    feeHandling: 'per_period',
    accountId: savings.id,
    debtAccountId: credit.id,
    categoryId: phone.id,
  },
});
const perPeriodDto = perPeriod.json.data.plan;
const schedsPer = (await call('GET', `${base}/${perPeriodDto.id}/schedules`, { token })).json.data;
check('每期收：总额 = 每期 × 期数', perPeriodDto.totalFee === '120.00', perPeriodDto.totalFee);
check('每期本金 100', centsOf(schedsPer[0].principal) === 10000, schedsPer[0].principal);
check('每期手续费 10', centsOf(schedsPer[0].fee) === 1000, schedsPer[0].fee);
check(
  'Σ totalDue === 本金 + 总额手续费',
  schedsPer.reduce((a, s) => a + centsOf(s.totalDue), 0) === centsOf(perPeriodDto.grandTotal),
  `${schedsPer.reduce((a, s) => a + centsOf(s.totalDue), 0)} vs ${centsOf(perPeriodDto.grandTotal)}`,
);

const manual = await call('POST', base, {
  token,
  body: {
    title: '手动尾款',
    totalAmount: '1000.00',
    totalFee: '60.00',
    installmentCount: 6,
    firstDate: todayStr,
    feeMode: 'once',
    feeHandling: 'manual_last',
    accountId: savings.id,
    debtAccountId: credit.id,
    categoryId: phone.id,
  },
});
const schedsManual = (await call('GET', `${base}/${manual.json.data.plan.id}/schedules`, { token })).json.data;
check('手动尾款：每期不带手续费', schedsManual.every((s) => centsOf(s.fee) === 0), String(schedsManual.reduce((a, s) => a + centsOf(s.fee), 0)));
check('手动尾款：Σ principal 仍等于总额', schedsManual.reduce((a, s) => a + centsOf(s.principal), 0) === 100000, String(schedsManual.reduce((a, s) => a + centsOf(s.principal), 0)));

/* ================= 10. 隔离 ================= */
console.log('\n— 10. 隔离与 404');
const other = (await call('POST', '/ledgers', { token, body: { name: '别的账本', currency: 'CNY' } })).json.data;
check('别的账本取不到（404）', (await call('GET', `/ledgers/${ledgerId}/installment-plans/${other.id}/schedules`, { token })).status === 404, '');
check('别的账本还不掉（404）', (await call('POST', `/ledgers/${ledgerId}/installment-plans/${other.id}/settle-early`, { token, body: {} })).status === 404, '');
check('不存在的计划 404', (await call('GET', `${base}/ipl_没有`, { token })).status === 404, '');
check('不存在的明细 404', (await call('POST', `/ledgers/${ledgerId}/installment-schedules/ipl_none/pay`, { token, body: {} })).status === 404, '');

/* ================= 11. 列表与进度 ================= */
console.log('\n— 11. 列表');
const all = (await call('GET', base, { token })).json.data;
check('列出全部计划', all.length >= 5, `${all.length} 个`);
const active = (await call('GET', `${base}?status=active`, { token })).json.data;
check('按状态过滤可用', active.every((p) => p.status === 'active'), active.map((p) => p.status).join(','));
check('进行中的计划有「下一期」信息', active.every((p) => p.progress.nextDue !== null || p.status !== 'active'), 'ok');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}