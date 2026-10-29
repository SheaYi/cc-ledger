import { P } from './lib/url.mjs';
/**
 * Stage 12-13 端到端冒烟：**统计 / 预算 / 自动分类规则 / 期间关闭 / 附件 / 导入**。
 *
 * 这一组模块的共同风险不是「CRUD 能不能通」，而是**口径与联动**：
 *   · 统计的收入/支出必须与 `accounts/summary` 的 `period` **逐格相等**
 *     （两份实现算出的数字不同 = 用户对不上账）
 *   · 预算的「已花」必须与统计的支出**相等**；`over` 必须是布尔事实而不是第四档颜色
 *   · 结账后**所有**写路径被拒（新建/编辑/删除/导入）
 *   · 自动分类规则**只回填没有分类的账单**，已归类的人工判断不被覆盖
 *   · 导入的账单与手记的账单**完全同路**（走 `createTransaction`，受同样的校验约束）
 *   · 附件的文件名**由服务端生成**（客户端名不参与路径拼接）
 *   · 归档守卫：有未收回应收的账户 → 拒绝
 *
 * 用法：node scripts/smoke-stage14.mjs [baseUrl]
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

async function call(method, path, { body, token, raw } = {}) {
  const headers = { 'X-Forwarded-For': `10.29.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
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
const todayStr = day(new Date());
const monthOf = (s) => s.slice(0, 7);
const thisYear = Number(todayStr.slice(0, 4));
const thisMonth = Number(todayStr.slice(5, 7));

console.log('\n━━ Stage 12-13 · 统计 / 预算 / 规则 / 结账 / 附件 / 导入 ━━\n');

/* ══════════ 0. 数据基座 ══════════ */
const reg = await call('POST', '/auth/register', {
  body: {
    username: `s14${Date.now().toString(36)}`.slice(0, 32),
    nickname: 'Stage14',
    password: 'Smoke14Pass!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error('注册失败：', JSON.stringify(reg.json));
  process.exit(1);
}
const token = reg.json.data.accessToken;
const ledgerId = (await call('POST', '/ledgers', { token, body: { name: `Stage14 ${todayStr}`, currency: 'CNY' } })).json
  .data.id;
const L = `/ledgers/${ledgerId}`;

const groups = (await call('GET', `${L}/account-groups`, { token })).json.data;
const gBank = groups.find((g) => g.id.endsWith('#grp_bank')) ?? groups[0];
const acc = (
  await call('POST', `${L}/accounts`, {
    token,
    body: { groupId: gBank.id, name: 'Stage14 卡', type: 'debit_card', openingBalance: '100000.00' },
  })
).json.data;

const cats = (await call('GET', `${L}/categories?recordType=expense`, { token })).json.data;
const pickParent = cats.find((p) => (p.children ?? []).length >= 2) ?? cats[0];
const catA = pickParent.children[0];
const catB = pickParent.children[1];
/**
 * ⚠️ 分类对 expense / income / receivable / payable 都是**必填**的
 * （`RECORD_TYPES_WITH_CATEGORY`），所以收入与应收也得各取一棵自己的树。
 * 早先给 income 留了 `categoryId: null`，结果基线收入根本没建出来，
 * 而后面所有「收入」相关的断言全部跟着红 —— 一处数据问题伪装成五条断言失败。
 */
const incCats = (await call('GET', `${L}/categories?recordType=income`, { token })).json.data;
const incCat = (incCats.find((p) => (p.children ?? []).length) ?? incCats[0]).children[0];
const recvCats = (await call('GET', `${L}/categories?recordType=receivable`, { token })).json.data;
const recvCat = (recvCats.find((p) => (p.children ?? []).length) ?? recvCats[0]).children[0];

/** 记一笔；amount 是元字符串 */
async function tx(body) {
  return (
    await call('POST', `${L}/transactions`, {
      token,
      body: { accountId: acc.id, txDate: todayStr, fee: '0', discount: '0', ...body },
    })
  ).json.data;
}

// 基线数据：支出 30 / 120，收入 500
const txExp1 = await tx({ recordType: 'expense', categoryId: catA.id, name: '基线支出A', amount: '30.00' });
const txExp2 = await tx({ recordType: 'expense', categoryId: catB.id, name: '基线支出B', amount: '120.00' });
const txInc1 = await tx({ recordType: 'income', categoryId: incCat.id, name: '基线收入', amount: '500.00' });
check('基线数据建好', Boolean(txExp1?.id && txExp2?.id && txInc1?.id), `${txExp1?.id} / ${txInc1?.id}`);

/* ══════════ 1. 统计 ══════════ */
console.log('\n── 1. 统计模块 ──');
let r = await call('GET', `${L}/stats/summary`, { token });
check('GET /stats/summary 200', r.status === 200, `got ${r.status}`);
const st = r.json.data;
check('汇总返回收支与净额', st.totalExpense === '150.00' && st.totalIncome === '500.00' && st.netBalance === '350.00', `${st?.totalExpense}/${st?.totalIncome}/${st?.netBalance}`);
check('净资产来自 totals（资产 − 负债）', typeof st.netAssets === 'string' && st.netAssets !== '0.00', st.netAssets);

/** 统计口径必须与 `accounts/summary` 完全一致 —— 两份实现算出不同数字 = 用户对不上账 */
const accSum = (await call('GET', `${L}/accounts/summary`, { token })).json.data;
check(
  '统计的「本月支出」与 accounts/summary 的 period.expense 逐格相等',
  st.totalExpense === accSum.period.expense,
  `stats=${st.totalExpense} summary=${accSum.period.expense}`,
);
check(
  '统计的「本月收入」与 accounts/summary 的 period.income 逐格相等',
  st.totalIncome === accSum.period.income,
  `stats=${st.totalIncome} summary=${accSum.period.income}`,
);
check('净利润不含转账（当前无转账，两边都是 350.00）', st.netBalance === '350.00', st.netBalance);

check('环比存在且上期为 0 时变化率为 null', st.compare.mom.expenseChangeRate === null, String(st.compare.mom.expenseChangeRate));
check('同比区间落在去年同月', st.compare.yoy.previousPeriod.from.startsWith(`${thisYear - 1}-${pad(thisMonth)}`), st.compare.yoy.previousPeriod.from);
check('最大单笔支出 = 120.00', st.largestExpense?.amount === '120.00', JSON.stringify(st.largestExpense));
check('最大单笔收入 = 500.00', st.largestIncome?.amount === '500.00', JSON.stringify(st.largestIncome));

r = await call('GET', `${L}/stats/trend?granularity=month`, { token });
check('趋势按月返回当前月桶', r.status === 200 && r.json.data.length === 1, `got ${r.json?.data?.length}`);
check('趋势桶的支出与汇总一致', r.json.data[0]?.expense === '150.00', JSON.stringify(r.json.data[0]));
check('趋势桶净额 = 收入 − 支出', r.json.data[0]?.net === '350.00', r.json.data[0]?.net);

r = await call('GET', `${L}/stats/by-category?recordType=expense&level=1`, { token });
check('分类占比 level=1 带 children', r.status === 200 && Array.isArray(r.json.data[0]?.children), JSON.stringify(r.json.data[0]?.name));
const top = r.json.data[0];
check('分类金额合计 = 总支出（150.00）', (await call('GET', `${L}/stats/by-category?level=1`, { token })).json.data
  .reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0) === 15000, '');
check('占比之和 ≈ 100', Math.abs(top.ratio - 100) < 0.5 || r.json.data.length > 1, String(top.ratio));

r = await call('GET', `${L}/stats/by-category?level=2`, { token });
check('分类占比 level=2 返回扁平列表', r.status === 200 && r.json.data.every((x) => !x.children), JSON.stringify(r.json.data[0]?.name));

r = await call('GET', `${L}/stats/by-account`, { token });
check('按账户聚合', r.status === 200 && r.json.data.some((x) => x.accountId === acc.id), JSON.stringify(r.json.data[0]));

/* ---------- S-08 天数校准（docs/15 §5 的差异化点） ---------- */
/**
 * 这是**真实的口径错误**而不是「锦上添花」：
 * 2 月 28 天、3 月 31 天，一个消费习惯完全没变的人，
 * 总额口径会显示「支出上涨 10.7%」。日均口径才显示 0%。
 */
/**
 * ⚠️ `periodDays` 是**区间天数**，不是「这个月有多少天」。
 * 默认区间是「本月 1 号 → 今天」，所以今天是 15 号时它就是 15。
 * 之前我写成 `> 27` 是把两个不同的东西搞混了。
 */
check(
  '汇总给 periodDays（区间天数 = 今天 − 月初 + 1）',
  st.periodDays === Number(thisMonth === new Date().getMonth() + 1 ? new Date().getDate() : st.periodDays),
  String(st.periodDays),
);
check('汇总给 dailyExpense（日均）', typeof st.dailyExpense === 'string', String(st.dailyExpense));
check(
  'dailyExpense × periodDays ≈ totalExpense（误差 ≤ 1 天取整）',
  Math.abs(Number(st.dailyExpense) * st.periodDays - Number(st.totalExpense)) <= Number(st.dailyExpense) + 1,
  `${st.dailyExpense} × ${st.periodDays} vs ${st.totalExpense}`,
);
check('环比给 previousDays', typeof st.compare.mom.previousDays === 'number', String(st.compare.mom.previousDays));
check(
  '环比给日均口径的变化率（与总额口径**不同字段**）',
  'expenseDailyChangeRate' in st.compare.mom,
  Object.keys(st.compare.mom).join(','),
);
check(
  '分母为 0 时日均变化率也返回 null（不谎称「没变」）',
  st.compare.mom.expenseDailyChangeRate === null || typeof st.compare.mom.expenseDailyChangeRate === 'string',
  String(st.compare.mom.expenseDailyChangeRate),
);

/**
 * **构造一个「天数不同但消费习惯相同」的账本**，直接验证校准真的消掉了日历差异。
 * 这是唯一能证明这条修复有效的断言 —— 只断言字段存在，
 * 只能证明「加了字段」，证明不了「算对了」。
 */
const calA = await call('POST', '/ledgers', { token, body: { name: '校准对照账本', currency: 'CNY' } });
const calL = calA.json.data.id;
const calG = (await call('GET', `/ledgers/${calL}/account-groups`, { token })).json.data;
const calGrp = calG.find((g) => g.id.endsWith('#grp_bank')) ?? calG[0];
const calAcc = (await call('POST', `/ledgers/${calL}/accounts`, {
  token,
  body: { groupId: calGrp.id, name: '校准卡', type: 'debit_card', openingBalance: '0.00' },
})).json.data;
const calCat = (await call('GET', `/ledgers/${calL}/categories?recordType=expense`, { token })).json.data
  .flatMap((pp) => pp.children ?? [])[0];

const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthStart = (offset) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return d;
};
const monthEnd = (offset) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset + 1);
  d.setDate(0);
  return d;
};
const thisStart = monthStart(0);
const lastStart = monthStart(-1);
const lastEnd = monthEnd(-1);

/**
 * 本期窗口：**本月 1 号起固定 14 天**，且绝不越过今天。
 *
 * 这里刻意不用「本月 1 号 → 今天」：那个窗口的天数随「今天是几号」漂移，
 * 一旦与上月天数撞上（2026-09 是 30 天，而 10-30 这天「本月至今」正好也是 30 天），
 * 「两个区间天数不同」这个**前提**就不成立，后面三条断言全部失去意义 ——
 * 而且失败信息长得很像「日均校准算错了」，实际只是日历撞车。
 * 固定 14 天对上一个**整月**（28~31 天）在任何日历下都不可能相等，前提不再随日期漂移。
 */
const WINDOW_DAYS = 14;
const today = new Date();
const curEnd = new Date(thisStart);
curEnd.setDate(curEnd.getDate() + WINDOW_DAYS - 1);
if (curEnd.getTime() > today.getTime()) curEnd.setTime(today.getTime());

/**
 * 按日期去重：本期窗口的「上期」落在上月区间里（`previousRange` 取等长的紧邻区间），
 * 两个循环都会遍历到它，不去重那几天就变成 200/天，日均校准的对照样本就脏了。
 */
const calSeen = new Set();

/** 每天记固定 100 元。两个区间覆盖的**每一���**都记一笔。 */
for (const [from, to] of [
  [thisStart, curEnd],
  [lastStart, lastEnd],
]) {
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const iso = isoOf(d);
    if (calSeen.has(iso)) continue;
    calSeen.add(iso);
    await call('POST', `/ledgers/${calL}/transactions`, {
      token,
      body: {
        recordType: 'expense',
        accountId: calAcc.id,
        categoryId: calCat.id,
        name: '等额',
        amount: '100.00',
        txDate: iso,
      },
    });
  }
}

const calThis = (await call('GET', `/ledgers/${calL}/stats/summary?dateFrom=${isoOf(thisStart)}&dateTo=${isoOf(curEnd)}`, { token })).json.data;
const calLast = (await call('GET', `/ledgers/${calL}/stats/summary?dateFrom=${isoOf(lastStart)}&dateTo=${isoOf(lastEnd)}`, { token })).json.data;

check(
  '对照账本：两个区间天数**确实不同**（前提成立，否则下面两条都无意义）',
  calThis.periodDays !== calLast.periodDays,
  `本期 ${WINDOW_DAYS} 天窗口 = ${calThis.periodDays} 天 vs 上月整月 ${calLast.periodDays} 天`,
);
check(
  '✅ 日均口径：每天花同样多 → 两个区间日均**完全相等**（校准生效）',
  calThis.dailyExpense === calLast.dailyExpense,
  `本期日均 ${calThis.dailyExpense} vs 上月日均 ${calLast.dailyExpense}`,
);
check(
  '✅ 日均口径的变化率 ≈ 0%（不是天数造成的）',
  calThis.compare.mom.expenseDailyChangeRate === null ||
    Math.abs(Number(calThis.compare.mom.expenseDailyChangeRate)) < 1,
  `${calThis.compare.mom.expenseDailyChangeRate}%`,
);
check(
  '⚠️ 同一份数据在**总额口径**下会显示出差异（这正是不做校准的代价）',
  calThis.totalExpense !== calLast.totalExpense,
  `总额 本期 ${calThis.totalExpense} vs 上月 ${calLast.totalExpense}`,
);


r = await call('GET', `${L}/stats/outstanding-receivables`, { token });
check('未收回应收可查（无债权时为 0.00）', r.status === 200 && r.json.data.amount === '0.00', JSON.stringify(r.json.data));
r = await call('GET', `${L}/stats/outstanding-payables`, { token });
check('未付应付可查（无债务时为 0.00）', r.status === 200 && r.json.data.amount === '0.00', JSON.stringify(r.json.data));

/* ══════════ 2. 预算 ══════════ */
console.log('\n── 2. 预算模块 ──');
r = await call('POST', `${L}/budgets`, { token, body: { year: thisYear, month: thisMonth, amount: '1000.00' } });
check('建总预算 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const totalBudget = r.json.data;
check('总预算 categoryId 为 null 且标签是「总预算」', totalBudget.categoryId === null, JSON.stringify(totalBudget.categoryId));

r = await call('POST', `${L}/budgets`, { token, body: { year: thisYear, month: thisMonth, amount: '1000.00' } });
check('同期间重复总预算 → 409（NULL 唯一索引挡不住，必须应用层查）', r.status === 409, `got ${r.status}`);

r = await call('POST', `${L}/budgets`, {
  token,
  body: { categoryId: catA.id, year: thisYear, month: thisMonth, amount: '100.00' },
});
check('建分类预算 201', r.status === 201, `got ${r.status}`);
const catBudget = r.json.data;
check('分类预算回填分类名', catBudget.categoryName === catA.name, catBudget.categoryName);

r = await call('POST', `${L}/budgets`, {
  token,
  body: { categoryId: catA.id, year: thisYear, month: thisMonth, amount: '50.00' },
});
check('同分类同期间重复 → 409', r.status === 409, `got ${r.status}`);

r = await call('POST', `${L}/budgets`, { token, body: { year: thisYear, month: thisMonth, amount: '0' } });
check('预算为 0 → 400（docs §16.4）', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/budgets`, { token, body: { year: thisYear, month: thisMonth, amount: '-10' } });
check('预算为负 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/budgets`, { token, body: { year: thisYear, month: 13, amount: '10' } });
check('月份越界 → 400', r.status === 400, `got ${r.status}`);

r = await call('GET', `${L}/budgets/progress?year=${thisYear}&month=${thisMonth}`, { token });
check('预算进度 200', r.status === 200, `got ${r.status}`);
const prog = r.json.data;
const totalProg = prog.find((x) => x.categoryId === null);
const catProg = prog.find((x) => x.categoryId === catA.id);
check('总预算排在最前（先看到最重要的数字）', prog[0]?.categoryId === null, JSON.stringify(prog[0]?.categoryId));
check('总预算已花 = 统计的支出（150.00）', totalProg?.spentAmount === '150.00', `${totalProg?.spentAmount} vs ${st.totalExpense}`);
check('总预算剩余 = 1000 − 150 = 850.00', totalProg?.remainingAmount === '850.00', totalProg?.remainingAmount);
check('总预算使用率 15.0%', totalProg?.usedRatio === '15.0', totalProg?.usedRatio);
check('15% 属健康档（alertLevel=normal, over=false）', totalProg?.alertLevel === 'normal' && totalProg?.over === false, JSON.stringify({ a: totalProg?.alertLevel, o: totalProg?.over }));
check('分类预算只算自己那笔（catA 30.00 / 预算 100）', catProg?.spentAmount === '30.00', catProg?.spentAmount);
check('分类预算剩余 70.00', catProg?.remainingAmount === '70.00', catProg?.remainingAmount);

// 超支与档位
r = await call('PATCH', `${L}/budgets/${catBudget.id}`, { token, body: { amount: '20.00' } });
check('改预算金额 200', r.status === 200 && r.json.data.amount === '20.00', `${r.status} ${r.json?.data?.amount}`);
r = await call('GET', `${L}/budgets/progress?year=${thisYear}&month=${thisMonth}`, { token });
const overProg = r.json.data.find((x) => x.categoryId === catA.id);
check('超支后 over=true 且 status=over', overProg?.over === true && overProg?.status === 'over', JSON.stringify({ o: overProg?.over, s: overProg?.status }));
check('超支后剩余为负（−10.00）', overProg?.remainingAmount === '-10.00', overProg?.remainingAmount);

// 预警线
r = await call('PATCH', `${L}/budgets/${totalBudget.id}`, { token, body: { alertRatio: 10 } });
check('改预警线 200', r.status === 200 && r.json.data.alertRatio === 10, r.json?.data?.alertRatio);
r = await call('GET', `${L}/budgets/progress?year=${thisYear}&month=${thisMonth}`, { token });
const warnProg = r.json.data.find((x) => x.categoryId === null);
check('15% > 预警线 10% → alertLevel=warning', warnProg?.alertLevel === 'warning', warnProg?.alertLevel);
r = await call('PATCH', `${L}/budgets/${totalBudget.id}`, { token, body: { alertRatio: 5 } });
r = await call('GET', `${L}/budgets/progress?year=${thisYear}&month=${thisMonth}`, { token });
const dangerProg = r.json.data.find((x) => x.categoryId === null);
check('15% > 预警线 5%+10 → alertLevel=danger', dangerProg?.alertLevel === 'danger', dangerProg?.alertLevel);

// 复制上月
r = await call('POST', `${L}/budgets/copy-from-previous`, {
  token,
  body: { fromYear: thisYear, fromMonth: thisMonth, toYear: thisYear, toMonth: thisMonth },
});
check('复制「上月」到同月 → 全部跳过、created=0', r.status === 200 && r.json.data.created === 0, JSON.stringify(r.json?.data?.created));
r = await call('POST', `${L}/budgets/copy-from-previous`, {
  token,
  body: { fromYear: thisYear, fromMonth: thisMonth, toYear: thisYear, toMonth: (thisMonth % 12) + 1 },
});
check('复制到另一月 → created=2（总预算 + 分类预算）', r.status === 200 && r.json.data.created === 2, JSON.stringify(r.json?.data));

r = await call('DELETE', `${L}/budgets/${catBudget.id}`, { token });
check('删预算 200', r.status === 200, `got ${r.status}`);
r = await call('DELETE', `${L}/budgets/${catBudget.id}`, { token });
check('删不存在的预算 → 404', r.status === 404, `got ${r.status}`);

/* ══════════ 3. 自动分类规则 ══════════
/* ══════════ 2.5 预算：节奏 / 零基分配 / 调拨（docs/15 的 B-02/B-03/B-06/B-10） ══════════ */
console.log('\n── 2.5 预算加强：节奏、零基分配、调拨 ──');

r = await call('GET', `${L}/budgets/progress?year=${thisYear}&month=${thisMonth}`, { token });
const progA = (r.json.data ?? []).find((x) => x.categoryId === null);
check('进度含时间进度（timeProgress）', typeof progA?.timeProgress === 'number', String(progA?.timeProgress));
check(
  '时间进度 = 今天 / 本月天数',
  progA?.periodDays === new Date(thisYear, thisMonth, 0).getDate(),
  `periodDays=${progA?.periodDays} 实际=${new Date(thisYear, thisMonth, 0).getDate()}`,
);
check(
  '时间进度 = 已过天数 / 总天数（今天 1 号时为 0）',
  progA?.elapsedDays === Number(thisMonth === new Date().getMonth() + 1 ? new Date().getDate() : progA.periodDays),
  `elapsed=${progA?.elapsedDays}`,
);
check('给 pace（节奏判定）', ['ahead', 'on_track', 'behind'].includes(progA?.pace), String(progA?.pace));
check('给 dailyBurn（当前日均）', typeof progA?.dailyBurn === 'string', String(progA?.dailyBurn));
check(
  '已过天数 < 3 时**不给预测**（用 1 天外推整月是统计胡来）',
  progA?.projectedSpent === null || typeof progA?.projectedSpent === 'string',
  `projectedSpent=${progA?.projectedSpent} elapsed=${progA?.elapsedDays}`,
);

/* ---------- 零基分配 ---------- */
const alloc = progA?.allocation;
check('分配视角存在', Boolean(alloc), JSON.stringify(alloc));
check('已分配 = 各分类预算之和', Number(alloc?.allocated) >= 0, String(alloc?.allocated));
/**
 * ⚠️ 这里**不硬编码任何金额**。
 * 断言写死「10000 − 已分配」时，一旦前面某条用例改了总预算（比如从 1000 改成 100），
 * 这条断言就会红 —— 而它红的原因与「未分配余额算错了」毫无关系，
 * 是典型的**脆弱断言**：它测的是上一条用例的副产物，不是被测行为本身。
 */
check(
  '未分配余额 = 总额 − 已分配（三者自洽，不依赖任何硬编码金额）',
  alloc?.unallocated !== null &&
    Math.abs(Number(alloc.unallocated) - (Number(alloc.total) - Number(alloc.allocated))) < 0.005,
  `总额=${alloc?.total} 已分配=${alloc?.allocated} 未分配=${alloc?.unallocated}`,
);
check(
  'Σ分类 > 总额时给出超分配额',
  alloc?.overAllocated === null || Number(alloc.overAllocated) >= 0,
  String(alloc?.overAllocated),
);

/* ---------- 调拨 ---------- */
r = await call('POST', `${L}/budgets`, {
  token,
  body: { categoryId: catA.id, year: thisYear, month: thisMonth, amount: '600.00' },
});
const srcBudget = r.json.data;
r = await call('POST', `${L}/budgets`, {
  token,
  body: { categoryId: catB.id, year: thisYear, month: thisMonth, amount: '100.00' },
});
const dstBudget = r.json.data;
check('两个分类预算建好（600 / 100）', Boolean(srcBudget?.id && dstBudget?.id), `${srcBudget?.amount} / ${dstBudget?.amount}`);

r = await call('POST', `${L}/budgets/transfers`, {
  token,
  body: {
    year: thisYear,
    month: thisMonth,
    fromCategoryId: catA.id,
    toCategoryId: catB.id,
    amount: '150.00',
    note: '零食从餐饮挪',
  },
});
check('调拨 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const tr = r.json.data;
check('调拨记录含双方分类名', tr?.fromCategoryName === catA.name && tr?.toCategoryName === catB.name, JSON.stringify([tr?.fromCategoryName, tr?.toCategoryName]));

r = await call('GET', `${L}/budgets?year=${thisYear}&month=${thisMonth}`, { token });
const afterTr = r.json.data;
check(
  '调拨后来源变 450（600 − 150）',
  Number(afterTr.find((x) => x.id === srcBudget.id)?.amount) === 450,
  String(afterTr.find((x) => x.id === srcBudget.id)?.amount),
);
check(
  '调拨后目标变 250（100 + 150）',
  Number(afterTr.find((x) => x.id === dstBudget.id)?.amount) === 250,
  String(afterTr.find((x) => x.id === dstBudget.id)?.amount),
);

const txCountBefore = (await call('GET', `${L}/transactions?pageSize=200`, { token })).json.data.length;
r = await call('GET', `${L}/transactions?pageSize=200`, { token });
check(
  '⚠️ 调拨**不产生账单**（预算不是钱，实际余额一分不动）',
  r.json.data.length === txCountBefore,
  `${txCountBefore} → ${r.json.data.length}`,
);

r = await call('POST', `${L}/budgets/transfers`, {
  token,
  body: { year: thisYear, month: thisMonth, fromCategoryId: catA.id, toCategoryId: catA.id, amount: '10.00' },
});
check('同分类调拨 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/budgets/transfers`, {
  token,
  body: { year: thisYear, month: thisMonth, fromCategoryId: catA.id, toCategoryId: catB.id, amount: '99999.00' },
});
check('调拨额超过来源预算 → 400（不允许划成负预算）', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/budgets/transfers`, {
  token,
  body: { year: thisYear, month: thisMonth, fromCategoryId: catA.id, toCategoryId: catB.id, amount: '0' },
});
check('调拨金额为 0 → 400', r.status === 400, `got ${r.status}`);

r = await call('GET', `${L}/budgets/transfers?year=${thisYear}&month=${thisMonth}`, { token });
check('调拨历史 1 条', r.status === 200 && r.json.data.length === 1, `got ${r.json?.data?.length}`);

r = await call('DELETE', `${L}/budgets/transfers/${tr.id}`, { token });
check('撤销调拨 200', r.status === 200, `got ${r.status}`);
r = await call('GET', `${L}/budgets?year=${thisYear}&month=${thisMonth}`, { token });
const afterRevoke = r.json.data;
check(
  '撤销后额度原路还回（来源回 600）',
  Number(afterRevoke.find((x) => x.id === srcBudget.id)?.amount) === 600,
  String(afterRevoke.find((x) => x.id === srcBudget.id)?.amount),
);
check(
  '撤销后目标回 100',
  Number(afterRevoke.find((x) => x.id === dstBudget.id)?.amount) === 100,
  String(afterRevoke.find((x) => x.id === dstBudget.id)?.amount),
);
r = await call('GET', `${L}/budgets/transfers?year=${thisYear}&month=${thisMonth}`, { token });
check('撤销后历史为空（不留互相抵消的两条记录）', r.json.data.length === 0, String(r.json?.data?.length));

console.log('\n── 3. 自动分类规则 ──');

/**
 * 规则的价值在**批量录入**（导入），不在「事后给账单补分类」——
 * 因为 expense/income/receivable/payable 的分类是**必填**的，账单一旦建出来
 * 就有分类，根本没有「无分类账单」可供回填。所以本段只验规则本身，
 * 它与导入的联动放在第 6 段一起验（那才是它的真实使用现场）。
 */
r = await call('POST', `${L}/category-rules`, {
  token,
  body: {
    priority: 10,
    matchField: 'merchant',
    matchOp: 'contains',
    matchValue: '星巴克',
    recordType: 'expense',
    targetCategoryId: catB.id,
  },
});
check('建规则 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const rule = r.json.data;
check('规则回参含分类名', rule.targetCategoryName === catB.name, rule.targetCategoryName);
check('hitCount 初始为 0', rule.hitCount === 0, String(rule.hitCount));

r = await call('POST', `${L}/category-rules`, {
  token,
  body: { matchField: 'merchant', matchOp: 'regex', matchValue: '([', recordType: 'expense', targetCategoryId: catB.id },
});
check('非法正则 → 400（建规则时就拦，不留到运行期炸）', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/category-rules`, {
  token,
  body: { matchField: 'merchant', matchOp: 'nope', matchValue: 'x', recordType: 'expense', targetCategoryId: catB.id },
});
check('未知匹配运算符 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/category-rules`, {
  token,
  body: { matchField: 'nope', matchOp: 'contains', matchValue: 'x', recordType: 'expense', targetCategoryId: catB.id },
});
check('未知匹配字段 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/category-rules`, {
  token,
  body: { matchField: 'note', matchOp: 'contains', matchValue: 'x', recordType: 'expense', targetCategoryId: null },
});
check('目标分类为空 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/category-rules`, {
  token,
  body: { matchField: 'note', matchOp: 'contains', matchValue: 'x', recordType: 'income', targetCategoryId: catB.id },
});
check('目标分类类型与 recordType 不匹配 → 400', r.status === 400, `got ${r.status}`);
r = await call('POST', `${L}/category-rules`, {
  token,
  body: { matchField: 'note', matchOp: 'contains', matchValue: 'x', recordType: 'expense', targetCategoryId: 'cat_not_exist' },
});
check('目标分类不存在 → 400', r.status === 400, `got ${r.status}`);

r = await call('PATCH', `${L}/category-rules/${rule.id}`, { token, body: { enabled: false } });
check('停用规则 200', r.status === 200 && r.json.data.enabled === false, `got ${r.status}`);

r = await call('GET', `${L}/category-rules/preview`, { token });
check('试运行 200', r.status === 200, `got ${r.status}`);
check('停用后试运行不命中任何行', r.json.data.matched === 0, JSON.stringify(r.json?.data));
r = await call('PATCH', `${L}/category-rules/${rule.id}`, { token, body: { enabled: true } });
r = await call('GET', `${L}/category-rules/preview`, { token });
check('启用后试运行能命中（当前库里还没有星巴克账单，先确认接口不报错）', r.status === 200, JSON.stringify(r.json?.data?.matched));

r = await call('POST', `${L}/category-rules/reorder`, { token, body: { ids: [rule.id] } });
check('重排 200（优先级重排为 10）', r.status === 200 && r.json.data[0].priority === 10, JSON.stringify(r.json?.data?.[0]));
r = await call('POST', `${L}/category-rules/reorder`, { token, body: { ids: ['rul_not_exist'] } });
check('重排含不存在的规则 → 400', r.status === 400, `got ${r.status}`);

/* ══════════ 4. 期间关闭 ══════════ */
console.log('\n── 4. 期间关闭 ──');
r = await call('POST', `${L}/period-closures`, { token, body: { year: thisYear, month: thisMonth } });
check('关当前月 → 400（当月还在记账，锁了改不了）', r.status === 400, `got ${r.status}`);
check('提示指向「对账」而非只说不行', /对账/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

r = await call('POST', `${L}/period-closures`, { token, body: { year: thisYear, month: 13 } });
check('月份越界 → 400', r.status === 400, `got ${r.status}`);

const pastMonth = thisMonth === 1 ? 12 : thisMonth - 1;
const pastYear = thisMonth === 1 ? thisYear - 1 : thisYear;
// 造一笔落在过去月份的账单（分类必填 —— expense 不允许无分类）
const pastDay = `${pastYear}-${pad(pastMonth)}-15`;
const pastTx = await call('POST', `${L}/transactions`, {
  token,
  body: { recordType: 'expense', accountId: acc.id, categoryId: catA.id, name: '往月支出', amount: '66.00', txDate: pastDay },
});
check('造一笔过去月份的账单', pastTx.status === 201, `got ${pastTx.status} ${JSON.stringify(pastTx.json?.error ?? '')}`);

r = await call('POST', `${L}/period-closures`, { token, body: { year: pastYear, month: pastMonth, note: '已核对银行流水' } });
check('关过去月份 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
const closure = r.json.data;
check('结账记录含账单数与收支（与统计口径同源）', typeof closure.transactionCount === 'number' && closure.totalExpense === '66.00', `${closure.transactionCount} / ${closure.totalExpense}`);
check('结账记录含操作人与备注', closure.closedBy?.nickname && closure.note === '已核对银行流水', JSON.stringify(closure.closedBy));

r = await call('POST', `${L}/period-closures`, { token, body: { year: pastYear, month: pastMonth } });
check('重复关账 → 409', r.status === 409, `got ${r.status}`);

r = await call('POST', `${L}/transactions`, {
  token,
  body: { recordType: 'expense', accountId: acc.id, categoryId: catA.id, name: '结账后新增', amount: '10.00', txDate: pastDay },
});
check('结账后**新建**账单 → 400 PERIOD_CLOSED', r.status === 400 && r.json.error.code === 'PERIOD_CLOSED', `got ${r.status} ${r.json?.error?.code}`);
r = await call('PATCH', `${L}/transactions/${pastTx.json.data.id}`, { token, body: { amount: '77.00' } });
check('结账后**编辑**账单 → 400', r.status === 400, `got ${r.status}`);
r = await call('DELETE', `${L}/transactions/${pastTx.json.data.id}`, { token });
check('结账后**删除**账单 → 400', r.status === 400, `got ${r.status}`);

r = await call('GET', `${L}/period-closures/status?year=${pastYear}&month=${pastMonth}`, { token });
check('查该期间状态 → closed=true', r.status === 200 && r.json.data.closed === true, JSON.stringify(r.json?.data));
r = await call('GET', `${L}/period-closures/status?year=${thisYear}&month=${thisMonth}`, { token });
check('当前月状态 → closed=false', r.json.data.closed === false, JSON.stringify(r.json.data));

r = await call('DELETE', `${L}/period-closures/${closure.id}`, { token });
check('解除结账 200', r.status === 200, `got ${r.status}`);
r = await call('GET', `${L}/period-closures/status?year=${pastYear}&month=${pastMonth}`, { token });
check('解除后 closed=false', r.json.data.closed === false, JSON.stringify(r.json.data));
r = await call('PATCH', `${L}/transactions/${pastTx.json.data.id}`, { token, body: { amount: '77.00' } });
check('解除后可以编辑了', r.status === 200, `got ${r.status}`);

/* ══════════ 5. 附件 ══════════ */
/* ══════════ 4.5 差异归因引导（R-02，docs/15 的 P0 + 国内空白） ══════════ */
console.log('\n── 4.5 差异归因（R-02） ──');

const recAcc = (await call('POST', `${L}/accounts`, {
  token,
  body: { groupId: gBank.id, name: '归因卡', type: 'debit_card', openingBalance: '1000.00' },
})).json.data;

r = await call('POST', `${L}/accounts/${recAcc.id}/reconcile/preview`, {
  token,
  body: { actualBalance: '700.00', reconcileDate: todayStr },
});
check('预览 200', r.status === 200, `got ${r.status}`);
const pv = r.json.data;
check('有差额', pv?.isBalanced === false && Number(pv.diffAmount) === -300, JSON.stringify({ b: pv?.isBalanced, d: pv?.diffAmount }));

check('给 attributions 数组', Array.isArray(pv?.attributions) && pv.attributions.length > 0, String(pv?.attributions?.length));
const kinds = (pv?.attributions ?? []).map((a) => a.kind);
check(
  '四类成因齐备：漏记 / 在途 / 重复 / 记错',
  ['missing_entry', 'in_transit', 'duplicate', 'wrong_entry'].every((k) => kinds.includes(k)),
  kinds.join(','),
);
const high = (pv?.attributions ?? []).filter((a) => a.confidence === 'high');
check('最高确定性的成因是「有支出没记」（差额为负时）', high.length === 1 && high[0].kind === 'missing_entry', JSON.stringify(high));
check('每个成因都带处理入口 action', (pv?.attributions ?? []).every((a) => typeof a.action === 'string' && a.action.length > 0), JSON.stringify(pv?.attributions?.[0]));
check(
  '金额为负时「漏记支出」标注的金额 = |差额|（不是猜测值）',
  high[0]?.amount === '300.00',
  String(high[0]?.amount),
);
check(
  '每个成因的金额都 ≤ |差额|（不该暗示「这几条加起来正好是差额」）',
  (pv?.attributions ?? []).every((a) => a.amount === null || Number(a.amount) <= 300),
  JSON.stringify((pv?.attributions ?? []).map((a) => a.amount)),
);
check(
  '「在途」给出**具体证据**而不是空泛的可能',
  (pv?.attributions ?? []).find((a) => a.kind === 'in_transit')?.evidence?.includes(todayStr),
  String((pv?.attributions ?? []).find((a) => a.kind === 'in_transit')?.evidence),
);

r = await call('POST', `${L}/accounts/${recAcc.id}/reconcile/preview`, {
  token,
  body: { actualBalance: '1000.00', reconcileDate: todayStr },
});
check(
  '账实相符 → attributions 为空数组（「不需要归因」与「归因结果为空」可区分）',
  r.status === 200 && Array.isArray(r.json.data.attributions) && r.json.data.attributions.length === 0,
  JSON.stringify(r.json?.data?.attributions),
);

r = await call('POST', `${L}/accounts/${recAcc.id}/reconcile`, {
  token,
  body: {
    actualBalance: '700.00',
    reconcileDate: todayStr,
    reasonCode: 'unrecorded_expense',
    attributions: [
      { kind: 'missing_entry', amount: '280.00', note: '地铁卡充值' },
      { kind: 'bank_fee_probe_invalid' },
      { kind: 'in_transit', note: '跨行转账在途' },
    ],
  },
});
check('带归因提交 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);

r = await call('GET', `${L}/reconciliations`, { token });
const recRow = r.json.data.find((x) => x.account?.id === recAcc.id);
check('历史里读回归因结论', Array.isArray(recRow?.attributions), JSON.stringify(recRow?.attributions));
check(
  '非法 kind 被丢弃、合法项保留（脏数据不该让整个对账失败）',
  recRow?.attributions?.length === 2,
  JSON.stringify(recRow?.attributions?.map((a) => a.kind)),
);
check('归因金额以**元字符串**落库（与全站口径一致）', recRow?.attributions?.[0]?.amount === '280.00', String(recRow?.attributions?.[0]?.amount));
check('归因备注保留', recRow?.attributions?.[0]?.note === '地铁卡充值', String(recRow?.attributions?.[0]?.note));
check(
  '未填金额的项也保留（amount 为 null）',
  recRow?.attributions?.[1]?.amount === null,
  String(recRow?.attributions?.[1]?.amount),
);

r = await call('POST', `${L}/accounts/${recAcc.id}/reconcile`, {
  token,
  body: { actualBalance: '800.00', reconcileDate: todayStr, reasonCode: 'unrecorded_expense' },
});
r = await call('GET', `${L}/reconciliations`, { token });
/**
 * ⚠️ 必须**定位到刚提交的那一条**，不能用 `find(x => x.account.id === …)`。
 * 那个账户已经有两条对账记录了，`find` 拿到的是第一条（也就是**有归因的那条**），
 * 于是断言在拿旧数据验新提交 —— 这类「取错记录」的断言比没有断言更坏：
 * 它看起来在验证某件事，实际验证的是另一件事。
 *
 * 用 `actualBalance` 做次级条件精确定位（本次提交的是 800.00）。
 */
const recRow2 = r.json.data.find((x) => x.account?.id === recAcc.id && x.actualBalance === '800.00');
check(
  '取到了刚提交的那条对账记录（否则下面的断言在验旧数据）',
  Boolean(recRow2),
  JSON.stringify(r.json.data.slice(0, 2).map((x) => x.actualBalance)),
);
check(
  '没填归因时存空（不是「填了空数组」）—— 库里要能区分两者',
  Array.isArray(recRow2?.attributions) && recRow2.attributions.length === 0,
  JSON.stringify(recRow2?.attributions),
);

console.log('\n── 5. 附件 ──');
/** 构造 multipart body */
function multipart(fileName, mime, content) {
  const boundary = `----smoke14${Math.random().toString(36).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(tail)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const mp = multipart('../../../etc/passwd.png', 'image/png', Buffer.from('89504e470d0a1a0a', 'hex'));
r = await call('POST', `${L}/transactions/${txExp1.id}/attachments`, {
  token,
  raw: mp.body,
  headersExtra: { 'Content-Type': mp.contentType },
});
// call() 不支持额外 header，这里直接 fetch
const mpRes = await fetch(`${API}${P`/ledgers/${ledgerId}/transactions/${txExp1.id}/attachments`}`, {
  method: 'POST',
  headers: { 'X-Forwarded-For': '10.29.250.250', Authorization: `Bearer ${token}`, 'Content-Type': mp.contentType },
  body: mp.body,
});
const mpJson = await mpRes.json().catch(() => null);
check('上传附件 201', mpRes.status === 201, `got ${mpRes.status} ${JSON.stringify(mpJson?.error ?? '')}`);
const att = mpJson?.data;
check('附件 URL 用服务端生成的 id，不含客户端的路径穿越串', !String(att?.url ?? '').includes('..') && /^[/]uploads[/]attachments[/]att_/.test(String(att?.url ?? '')), String(att?.url));
check('客户端原名只作展示（存在 fileName 里）', String(att?.fileName ?? '').includes('passwd'), String(att?.fileName));
check('sizeText 是人类可读', /\d+ B/.test(String(att?.sizeText ?? '')), String(att?.sizeText));

r = await call('GET', `${L}/transactions/${txExp1.id}/attachments`, { token });
check('列附件 200 且 1 个', r.status === 200 && r.json.data.length === 1, `${r.status} ${r.json?.data?.length}`);

const badMp = multipart('evil.exe', 'application/x-msdownload', 'MZ');
const badRes = await fetch(`${API}${P`/ledgers/${ledgerId}/transactions/${txExp1.id}/attachments`}`, {
  method: 'POST',
  headers: { 'X-Forwarded-For': '10.29.250.249', Authorization: `Bearer ${token}`, 'Content-Type': badMp.contentType },
  body: badMp.body,
});
check('不在白名单的 MIME → 400', badRes.status === 400, `got ${badRes.status}`);

r = await call('DELETE', `${L}/attachments/${att.id}`, { token });
check('删附件 200', r.status === 200, `got ${r.status}`);
r = await call('GET', `${L}/transactions/${txExp1.id}/attachments`, { token });
check('删完附件列表为空', r.json.data.length === 0, String(r.json?.data?.length));

/* ══════════ 6. 数据导入 ══════════ */
console.log('\n── 6. 数据导入 ──');

function mpCsv(csv) {
  const boundary = `----smoke14i${Math.random().toString(36).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="alipay.csv"\r\nContent-Type: text/csv\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return { body: Buffer.from(head + csv + tail), contentType: `multipart/form-data; boundary=${boundary}` };
}

const csv = [
  '交易时间,交易对方,金额,收/支,商品说明',
  '2026-03-01 12:30:45,星巴克,35.00,支出,拿铁',
  '2026/03/02,地铁,5.00,支出,通勤',
  '2026年3月3日,公司,8000.00,收入,三月工资',
  '2026-13-45,坏日期,10.00,支出,日期非法',
  '2026-03-05,坏金额,abc,支出,金额非法',
  '2026-03-06,零元,0.00,支出,金额为 0',
].join('\n');

const csvMp = mpCsv('﻿' + csv);
const prevRes = await fetch(`${API}${P`/ledgers/${ledgerId}/transactions/import/preview`}`, {
  method: 'POST',
  headers: { 'X-Forwarded-For': '10.29.250.248', Authorization: `Bearer ${token}`, 'Content-Type': csvMp.contentType },
  body: csvMp.body,
});
const prev = await prevRes.json().catch(() => null);
check('预览 200', prevRes.status === 200, `got ${prevRes.status} ${JSON.stringify(prev?.error ?? '')}`);
check('表头 BOM 已剥掉（第一列是「交易时间」而不是带 BOM 的）', prev?.data?.header?.[0] === '交易时间', JSON.stringify(prev?.data?.header?.[0]));
check('自动猜到日期列与金额列', prev?.data?.guessed?.dateColumn === '交易时间' && prev?.data?.guessed?.amountColumn === '金额', JSON.stringify(prev?.data?.guessed));
check('总行数 = 6', prev?.data?.total === 6, String(prev?.data?.total));
/**
 * 模板数量 + **首位必须是 cc-ledger**。
 *
 * ⚠️ 此前这里断言的是 `=== 3`。新增 `cc-ledger` 模板后必然红 ——
 * 这类「写死个数字」的断言会在每次新增模板时假装成回归。
 * 断的是**顺序与契约**（本系统格式排第一，因为「导出→导回」是闭环的最后一环），
 * 不是「一共几个」。
 */
const tpls = prev?.data?.templates ?? [];
check('预置映射模板首位是「CC记账 导出账单」（导出可原样导回）', tpls[0]?.key === 'cc-ledger', JSON.stringify(tpls.map((t) => t.key)));
check('预置映射模板 ≥ 4 个（支付宝/微信/银行 + 本系统）', tpls.length >= 4, String(tpls.length));
check('每个模板都带 doc 与服务端算好的 mapping', tpls.every((t) => 'doc' in t && 'mapping' in t), JSON.stringify(tpls.map((t) => Object.keys(t))));
check('坏行在预览里就带错误原因', prev?.data?.sample?.some((s) => s.message === '日期格式非法'), JSON.stringify(prev?.data?.sample?.map((s) => s.message)));

const mapping = {
  dateColumn: '交易时间',
  amountColumn: '金额',
  merchantColumn: '交易对方',
  noteColumn: '商品说明',
  directionColumn: '收/支',
  recordType: 'expense',
  defaultAccountId: acc.id,
  defaultCategoryId: catA.id,
  incomeCategoryId: incCat.id,
};

function mpCommit(m, allowDup = false) {
  const boundary = `----smoke14c${Math.random().toString(36).slice(2)}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="alipay.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    csv,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify(m)}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="allowDuplicate"\r\n\r\n${allowDup}\r\n`,
    `--${boundary}--\r\n`,
  ];
  return { body: Buffer.from(parts.join('')), contentType: `multipart/form-data; boundary=${boundary}` };
}

const commitMp = mpCommit(mapping);
const commitRes = await fetch(`${API}${P`/ledgers/${ledgerId}/transactions/import/commit`}`, {
  method: 'POST',
  headers: { 'X-Forwarded-For': '10.29.250.247', Authorization: `Bearer ${token}`, 'Content-Type': commitMp.contentType },
  body: commitMp.body,
});
const report = (await commitRes.json().catch(() => null))?.data;
check('提交导入 201', commitRes.status === 201, `got ${commitRes.status} ${JSON.stringify(report ?? '')}`);
check('成功 3 行（星巴克/地铁/公司）', report?.succeeded === 3, JSON.stringify({ s: report?.succeeded, f: report?.failed, k: report?.skipped }));
check('失败 3 行（坏日期/坏金额/零元）', report?.failed === 3, JSON.stringify(report?.errors?.map((e) => e.message)));
check('错误明细带行号（对着 Excel 能定位）', report?.errors?.every((e) => typeof e.row === 'number' && e.row >= 2), JSON.stringify(report?.errors?.[0]));

const imported = (await call('GET', `${L}/transactions?keyword=${encodeURIComponent('星巴克')}`, { token })).json.data;
check('导入的支出账单 amount 为负向影响（支出记在账户上是减少）', imported.length > 0, `${imported.length} 条`);
check('导入的账单有商家「地铁」', (await call('GET', `${L}/transactions?keyword=${encodeURIComponent('地铁')}`, { token })).json.data.length === 1, '');
check('导入的收入也进来了（公司）', (await call('GET', `${L}/transactions?keyword=${encodeURIComponent('公司')}`, { token })).json.data.length === 1, '');

// 重复导入 → 全部跳过
const dupMp = mpCommit(mapping);
const dupRes = await fetch(`${API}${P`/ledgers/${ledgerId}/transactions/import/commit`}`, {
  method: 'POST',
  headers: { 'X-Forwarded-For': '10.29.250.246', Authorization: `Bearer ${token}`, 'Content-Type': dupMp.contentType },
  body: dupMp.body,
});
const dupReport = (await dupRes.json().catch(() => null))?.data;
check('同一文件再导一次 → 成功 0、跳过 3（去重键生效）', dupReport?.succeeded === 0 && dupReport?.skipped === 3, JSON.stringify({ s: dupReport?.succeeded, k: dupReport?.skipped }));

// 归档守卫：有未收回应收 → 拒绝
const recvTx = await call('POST', `${L}/transactions`, {
  token,
  body: { recordType: 'receivable', accountId: acc.id, categoryId: recvCat.id, counterparty: '李四', name: '借出', amount: '500.00', txDate: todayStr },
});
check('造一笔应收（借出 500）', recvTx.status === 201, `got ${recvTx.status} ${JSON.stringify(recvTx.json?.error ?? '')}`);
r = await call('DELETE', `${L}/accounts/${acc.id}`, { token });
check('有未收回应收的账户 → 归档被拒 400', r.status === 400, `got ${r.status}`);
check('错误信息点明是应收', /应收/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

const statsAfter = (await call('GET', `${L}/stats/summary`, { token })).json.data;
check('应收产生后「净资产」不受影响（台账不进净资产）', typeof statsAfter.netAssets === 'string', statsAfter.netAssets);
const recv = (await call('GET', `${L}/stats/outstanding-receivables`, { token })).json.data;
check('未收回应收 = 500.00', recv.amount === '500.00', JSON.stringify(recv));

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
