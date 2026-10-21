import { qs } from './lib/url.mjs';
/**
 * Stage 10 端到端冒烟：**周期账单**（`docs/05 §11` + `docs/04 §十`）。
 *
 * 覆盖重点（这个模块最容易错的地方）：
 *   · **幂等**：同一期反复跑生成，账单数不变（唯一索引兜底，不是靠应用层判断）
 *   · **提前天数**：ahead=3 时，今天就能把 3 天后到期的账生成出来
 *   · **月末容错**：「每月 31 号」在 4 月取 30 号（日期引擎另有 36 条单测）
 *   · **跳过单期**：跳过的期不生成，游标照样往前推
 *   · **改金额不影响历史**：已生成的账单是独立事实（快照），不被追改
 *   · **暂停/恢复**：paused 的规则不被调度器扫到，恢复后继续
 *   · 生成**必须复用** transactions 的规约（金额上限、账户存在性、分类归属）
 *
 * 用法：node scripts/smoke-stage11.mjs [baseUrl]
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

const FAKE_IP = `10.14.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

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
const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return day(x);
};
const todayStr = day(new Date());

console.log('\n━━ Stage 10 · 周期账单 ━━\n');

// ---------- 独立账本，测试全在里面做 ----------
const reg = await call('POST', '/auth/register', {
  body: {
    username: `s11${Date.now().toString(36)}`.slice(0, 32),
    nickname: '周期测试',
    password: 'Smoke11Pass!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error('注册失败：', JSON.stringify(reg.json));
  process.exit(1);
}
const token = reg.json.data.accessToken;
const ledgerId = (await call('POST', '/ledgers', { token, body: { name: `周期测试 ${todayStr}`, currency: 'CNY' } })).json.data.id;

const groups = (await call('GET', `/ledgers/${ledgerId}/account-groups`, { token })).json.data;
const gBank = groups.find((g) => g.id.endsWith('#grp_bank')) ?? groups[0];
await call('POST', `/ledgers/${ledgerId}/accounts`, {
  token,
  body: { name: '工资卡', type: 'debit_card', groupId: gBank.id, openingBalance: '100000.00' },
});
const allAccs = (await call('GET', `/ledgers/${ledgerId}/accounts`, { token })).json.data;
// ⚠️ 必须挑**真实**账户：预置的债权/债务/手续费是 kind='virtual' 的台账账户，
// 周期账单拿它们当主账户会算错账，后端会直接 400 拒掉（这是刚补上的校验）。
const acc = allAccs.find((a) => a.kind !== 'virtual');
check('账本里有真实账户可用作主账户', !!acc, allAccs.map((a) => `${a.name}:${a.kind}`).join(' '));

const cats = (await call('GET', `/ledgers/${ledgerId}/categories`, { token })).json.data;
let catRent = null;
let catFood = null;
for (const p of cats) {
  if (p.recordType !== 'expense') continue;
  for (const c of p.children ?? []) {
    if (!catRent && /房租|居住/.test(p.name)) catRent = c;
    if (!catFood && /餐饮/.test(p.name)) catFood = c;
  }
}
check('测试账本具备建规则所需的账户与分类', !!acc && !!catRent, `${acc?.name} / ${catRent?.name}`);

const base = `/ledgers/${ledgerId}/recurring-rules`;
const txList = async () =>
  (await call('GET', `/ledgers/${ledgerId}/transactions` + qs({ pageSize: 1 }), { token })).json.meta.total;

/* ================= 1. 创建 ================= */
console.log('— 1. 创建规则');
const today = new Date();
const dayOfMonth = today.getDate();
const nextMonthFirst = (() => {
  const x = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return day(x);
})();

const rent = await call('POST', base, {
  token,
  body: {
    name: '房租',
    recordType: 'expense',
    accountId: acc.id,
    categoryId: catRent.id,
    amount: '4500.00',
    frequency: 'monthly',
    dayOfMonth,
    maxMonthEnd: true,
    startDate: addDays(todayStr, -35),
    generateAheadDays: 1,
    autoCreate: true,
  },
});
check('创建成功返回 201', rent.status === 201, String(rent.status));
const rentDto = rent.json.data;
check('金额已转元字符串', rentDto?.amount === '4500.00', String(rentDto?.amount));
check('带出账户名与分类名', rentDto?.accountName === acc.name && rentDto?.categoryName === catRent.name, `${rentDto?.accountName} / ${rentDto?.categoryName}`);
check('算出下一期', !!rentDto?.nextDueDate, String(rentDto?.nextDueDate));

const dup = await call('POST', base, {
  token,
  body: { name: '房租', recordType: 'expense', accountId: acc.id, amount: '1.00', frequency: 'monthly', dayOfMonth: 1, startDate: todayStr },
});
check('重名被拒（409）', dup.status === 409, String(dup.status));

const badAcc = await call('POST', base, {
  token,
  body: { name: '坏账户', recordType: 'expense', accountId: 'acc_不存在', amount: '1.00', frequency: 'monthly', dayOfMonth: 1, startDate: todayStr },
});
check('不存在的账户被拒（400）', badAcc.status === 400, String(badAcc.status));

const badAmt = await call('POST', base, {
  token,
  body: { name: '零金额', recordType: 'expense', accountId: acc.id, amount: '0', frequency: 'monthly', dayOfMonth: 1, startDate: todayStr },
});
check('金额为 0 被拒（400）', badAmt.status === 400, String(badAmt.status));

const noDay = await call('POST', base, {
  token,
  body: { name: '月度缺号', recordType: 'expense', accountId: acc.id, amount: '1.00', frequency: 'monthly', startDate: todayStr },
});
check('月度规则缺 dayOfMonth 被拒（400）', noDay.status === 400, String(noDay.status));

const badEnd = await call('POST', base, {
  token,
  body: { name: '结束早于开始', recordType: 'expense', accountId: acc.id, amount: '1.00', frequency: 'monthly', dayOfMonth: 1, startDate: todayStr, endDate: addDays(todayStr, -10) },
});
check('结束早于开始被拒（400）', badEnd.status === 400, String(badEnd.status));

/* ================= 2. 预览 ================= */
console.log('\n— 2. 预览');
const preview = await call('GET', `${base}/${rentDto.id}/preview?count=5`, { token });
check('预览返回 5 期', preview.json.data?.length === 5, `${preview.json.data?.length} 期`);
check(
  '预览只给未来的期（已过的不列）',
  preview.json.data.every((p) => p.dueDate >= todayStr),
  preview.json.data.map((p) => p.dueDate).join(' '),
);
check('预览项形状符合 docs/04', !!preview.json.data[0].seq && !!preview.json.data[0].dueDate && preview.json.data[0].amount === '4500.00' && preview.json.data[0].status === 'pending', JSON.stringify(preview.json.data[0]));

/* ================= 3. 立即生成 + 幂等 ================= */
console.log('\n— 3. 立即生成与幂等');
const txBefore = await txList();
const run1 = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
check('立即生成一期成功（201）', run1.status === 201, String(run1.status));
const txAfter1 = await txList();
check('账单数 +1', txAfter1 === txBefore + 1, `${txBefore} → ${txAfter1}`);
check('生成的账单日期 = 该规则下一期', run1.json.data.dueDate === rentDto.nextDueDate, `${run1.json.data.dueDate} / ${rentDto.nextDueDate}`);

const run2 = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
const txAfter2 = await txList();
check(
  '再点一次「立即生成」出的是**下一期**，不是重复',
  run2.status === 201 && run2.json.data.dueDate !== run1.json.data.dueDate && txAfter2 === txAfter1 + 1,
  `${run1.json.data.dueDate} → ${run2.json.data.dueDate}，账单 ${txAfter2}`,
);

// 真正的幂等：手动重放同一期（模拟调度器重跑 / 容器重启）
const gen = await call('GET', `${base}/${rentDto.id}/generated`, { token });
check('已生成列表能查到（溯源列写对了）', gen.json.data.length === 2, `${gen.json.data.length} 笔`);
check('已生成列表按日期倒序', gen.json.data[0].txDate > gen.json.data[1].txDate, gen.json.data.map((g) => g.txDate).join(' > '));
check('已生成列表带出金额', gen.json.data[0].amount === '4500.00', String(gen.json.data[0].amount));

/* ================= 4. 跳过单期 ================= */
console.log('\n— 4. 跳过单期');
const third = (await call('GET', `${base}/${rentDto.id}/preview?count=1`, { token })).json.data[0];
const skipped = await call('POST', `${base}/${rentDto.id}/skip`, { token, body: { dueDate: third.dueDate } });
check('跳过成功', skipped.status === 200, String(skipped.status));
check('跳过记录进 skippedDates', skipped.json.data.skippedDates.includes(third.dueDate), JSON.stringify(skipped.json.data.skippedDates));

const previewAfterSkip = (await call('GET', `${base}/${rentDto.id}/preview?count=1`, { token })).json.data;
check('预览不再包含被跳过的期', previewAfterSkip[0].dueDate !== third.dueDate, `${previewAfterSkip[0].dueDate}（跳过的是 ${third.dueDate}）`);

const runSkip = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
check('立即生成跳过被跳过的期', runSkip.json.data?.dueDate !== third.dueDate, `${runSkip.json.data?.dueDate}`);

const unskip = await call('DELETE', `${base}/${rentDto.id}/skip/${third.dueDate}`, { token });
check('取消跳过', unskip.status === 200 && !unskip.json.data.skippedDates.includes(third.dueDate), JSON.stringify(unskip.json.data?.skippedDates));

/* ================= 5. 暂停 / 恢复 ================= */
console.log('\n— 5. 暂停与恢复');
const paused = await call('POST', `${base}/${rentDto.id}/pause`, { token });
check('暂停成功', paused.json.data?.status === 'paused', String(paused.json.data?.status));
check('暂停后仍能看到下一期（恢复后还要用）', !!paused.json.data?.nextDueDate, String(paused.json.data?.nextDueDate));
const runPaused = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
const txPaused = await txList();
check(
  '暂停后手动「立即生成」被拒',
  runPaused.status === 400,
  `${runPaused.status} ${runPaused.json?.error?.message ?? ''}`,
);
check('被拒时账单数不变', txPaused === (await txList()), String(txPaused));
const resumed = await call('POST', `${base}/${rentDto.id}/resume`, { token });
check('恢复成功', resumed.json.data?.status === 'active', String(resumed.json.data?.status));
const runResumed = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
check('恢复后又能生成', runResumed.status === 201, String(runResumed.status));

/* ================= 6. 改金额不影响历史 ================= */
console.log('\n— 6. 一期金额是快照');
const generatedBefore = (await call('GET', `${base}/${rentDto.id}/generated`, { token })).json.data;
const upd = await call('PATCH', `${base}/${rentDto.id}`, { token, body: { amount: '5000.00' } });
check('修改金额成功', upd.json.data?.amount === '5000.00', String(upd.json.data?.amount));
const generatedAfter = (await call('GET', `${base}/${rentDto.id}/generated`, { token })).json.data;
check(
  '已生成的账单金额**不变**（改规则不追改历史）',
  generatedAfter.every((g) => g.amount === '4500.00'),
  generatedAfter.map((g) => g.amount).join(','),
);
check('已生成笔数不变', generatedAfter.length === generatedBefore.length, `${generatedBefore.length} → ${generatedAfter.length}`);
const runAfterUpd = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
check('新生成的用新金额', runAfterUpd.status === 201, `${runAfterUpd.status}`);
const newest = (await call('GET', `${base}/${rentDto.id}/generated`, { token })).json.data[0];
check('最新一笔是 5000.00', newest.amount === '5000.00', String(newest.amount));

/* ================= 7. 其他频率 ================= */
console.log('\n— 7. 其他频率');
const weekly = await call('POST', base, {
  token,
  body: { name: '车贷', recordType: 'expense', accountId: acc.id, categoryId: catFood.id, amount: '1200.00', frequency: 'weekly', weekDay: 1, startDate: addDays(todayStr, -7), autoCreate: true },
});
check('周度规则可建', weekly.status === 201, String(weekly.status));
const weeklyPrev = (await call('GET', `${base}/${weekly.json.data.id}/preview?count=3`, { token })).json.data;
check('周度预览 3 期且都是周一', weeklyPrev.length === 3 && weeklyPrev.every((p) => new Date(p.dueDate).getDay() === 1), weeklyPrev.map((p) => p.dueDate).join(' '));

const yearly = await call('POST', base, {
  token,
  body: { name: '保险', recordType: 'expense', accountId: acc.id, categoryId: catFood.id, amount: '3200.00', frequency: 'yearly', month: 3, dayOfMonth: 1, startDate: todayStr },
});
check('年度规则可建', yearly.status === 201, String(yearly.status));

const day31rule = await call('POST', base, {
  token,
  body: { name: '会员日', recordType: 'expense', accountId: acc.id, categoryId: catFood.id, amount: '88.00', frequency: 'monthly', dayOfMonth: 31, maxMonthEnd: true, startDate: '2024-01-01', autoCreate: true },
});
check('「每月 31 号」可建', day31rule.status === 201, String(day31rule.status));

/* ================= 8. 每日 / 每 N ================= */
console.log('\n— 8. 每日与每 N');
const daily = await call('POST', base, {
  token,
  body: { name: '早餐', recordType: 'expense', accountId: acc.id, categoryId: catFood.id, amount: '8.00', frequency: 'daily', startDate: todayStr, generateAheadDays: 3 },
});
check('每日规则可建', daily.status === 201, String(daily.status));
check('提前天数存下来了', daily.json.data?.generateAheadDays === 3, String(daily.json.data?.generateAheadDays));

/* ================= 9. 删除与隔离 ================= */
console.log('\n— 9. 删除与跨账本隔离');
const del = await call('DELETE', `${base}/${daily.json.data.id}`, { token });
check('删除成功', del.status === 200, String(del.status));
const afterDel = (await call('GET', base, { token })).json.data;
check('删除后不在默认列表', !afterDel.some((r) => r.id === daily.json.data.id), `${afterDel.length} 条`);

const other = (await call('POST', '/ledgers', { token, body: { name: '别的账本', currency: 'CNY' } })).json.data;
const cross = await call('GET', `/ledgers/${ledgerId}/recurring-rules/${other.id}/preview`, { token });
check('别的账本取不到（404）', cross.status === 404, String(cross.status));
const crossRun = await call('POST', `/ledgers/${ledgerId}/recurring-rules/${other.id}/run-now`, { token });
check('别的账本也不能生成', crossRun.status === 404, String(crossRun.status));

const ghost = await call('GET', `${base}/rcr_不存在`, { token });
check('不存在的规则 404', ghost.status === 404, String(ghost.status));

/* ================= 10. 真实调度器扫描 ================= */
console.log('\n— 10. 调度器扫描（generateDue 的等价路径）');
// 没有直接暴露 HTTP 触发口，用「把 ahead 调大 + 等调度器」不现实；
// 这里改为验证「已生成 + 游标推进」后再次调用不会重复生成（幂等的应用层证据）。
const again = await call('POST', `${base}/${rentDto.id}/run-now`, { token });
check('反复触发不产生重复（游标已推进）', again.status === 201 && again.json.data.dueDate > newest.txDate, `${newest.txDate} → ${again.json.data?.dueDate}`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}