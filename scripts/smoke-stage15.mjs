/**
 * Stage 15 端到端冒烟：**统计进阶（S-05~S-17）/ 对账进阶（R-03~R-14）/ 跨模块协同（X-01~X-07）**。
 *
 * 这一组模块的共同风险不是「接口通不通」，而是**口径与边界**：
 *   · 周报的账期是 7 天；月报按自然月；年报按整年
 *   · 环比必须同时给总额与日均两种口径
 *   · 净资产历史读快照、只有当月实时算
 *   · 银行流水**永不进业务库** —— 导入后业务账单数不变
 *   · 冲销只生成冲销笔，**不自动重记**
 *   · 内部转账不计收支 —— 转账后「支出」不变
 *   · 订阅识别结果必须能「确认/忽略」并持久化（否则每次刷新都重弹）
 *
 * 用法：node scripts/smoke-stage15.mjs [baseUrl]
 */
import { P } from './lib/url.mjs';

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

async function call(method, path, { body, token } = {}) {
  const headers = {
    'X-Forwarded-For': `10.31.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // 一次读字节，再解码 —— 不能先 text() 再 arrayBuffer()（body 只能读一次）
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __raw: text.slice(0, 200) };
  }
  return { status: res.status, json, text, buf };
}

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const todayStr = day(now);
const Y = now.getFullYear();
const M = now.getMonth() + 1;
const MP = pad(M);

console.log('\n━━ Stage 15 · 统计进阶 / 对账进阶 / 跨模块协同 ━━\n');

/* ══════════ 0. 数据基座 ══════════ */
const reg = await call('POST', '/auth/register', {
  body: {
    username: `s15${Date.now().toString(36)}`.slice(0, 32),
    nickname: 'Stage15',
    password: 'Smoke15Pass!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error('注册失败：', JSON.stringify(reg.json));
  process.exit(1);
}
const token = reg.json.data.accessToken;
const ledgerId = (await call('POST', '/ledgers', { token, body: { name: `Stage15 ${todayStr}`, currency: 'CNY' } }))
  .json.data.id;
const L = `/ledgers/${ledgerId}`;

const groups = (await call('GET', P`/ledgers/${ledgerId}/account-groups`, { token })).json.data;
const gBank = groups.find((g) => g.id.endsWith('#grp_bank')) ?? groups[0];
const acc = (
  await call('POST', P`/ledgers/${ledgerId}/accounts`, {
    token,
    body: { groupId: gBank.id, name: 'Stage15 卡', type: 'debit_card', openingBalance: '50000.00' },
  })
).json.data;
const acc2 = (
  await call('POST', P`/ledgers/${ledgerId}/accounts`, {
    token,
    body: { groupId: gBank.id, name: 'Stage15 现金', type: 'cash', openingBalance: '500.00' },
  })
).json.data;

const cats = (await call('GET', P`/ledgers/${ledgerId}/categories?recordType=expense`, { token })).json.data;
const parent = cats.find((p) => (p.children ?? []).length >= 2) ?? cats[0];
const catA = parent.children[0];
const catB = parent.children[1];
const incCats = (await call('GET', P`/ledgers/${ledgerId}/categories?recordType=income`, { token })).json.data;
const incCat = (incCats.find((p) => (p.children ?? []).length) ?? incCats[0]).children[0];

async function tx(body) {
  return await call('POST', P`/ledgers/${ledgerId}/transactions`, {
    token,
    body: { accountId: acc.id, txDate: todayStr, fee: '0', discount: '0', ...body },
  });
}

const txA = (await tx({ recordType: 'expense', categoryId: catA.id, name: '吃饭', amount: '200.00' })).json.data;
await tx({ recordType: 'expense', categoryId: catB.id, name: '打车', amount: '60.00' });
const txInc = (await tx({ recordType: 'income', categoryId: incCat.id, name: '工资', amount: '8000.00' })).json.data;
const lastMonth = day(new Date(Y, M - 2, 15));
await tx({ recordType: 'expense', categoryId: catA.id, name: '上月吃饭', amount: '100.00', txDate: lastMonth });

/* ══════════ S-05 预算执行视图 ══════════ */
console.log('\n── S-05 预算执行视图 ──');
await call('POST', P`/ledgers/${ledgerId}/budgets`, { token, body: { categoryId: catA.id, year: Y, month: M, amount: '500.00' } });
let r = await call('GET', P`/ledgers/${ledgerId}/stats/budget-execution?year=${Y}&month=${M}`, { token });
check('预算执行视图 200', r.status === 200, `got ${r.status}`);
check(
  '已花 200 / 预算 500 → 执行率 40、状态 safe',
  Math.round(Number(r.json.data.rows?.[0]?.usedRatio)) === 40 && r.json.data.rows?.[0]?.status === 'safe',
  JSON.stringify({ used: r.json.data.rows?.[0]?.usedRatio, st: r.json.data.rows?.[0]?.status }),
);

/* ══════════ S-06 / S-07 / S-08 ══════════ */
console.log('\n── S-06 下钻 / S-07 多周期 / S-08 环比 ──');
r = await call('GET', P`/ledgers/${ledgerId}/stats/drilldown?categoryId=${catA.id}`, { token });
check('下钻 200 且带合计栏', r.status === 200 && typeof r.json.data.totalAmount === 'string', r.json.data.totalAmount);
/**
 * 基线里 catA 有两笔：本月「吃饭 200」与上月「上月吃饭 100」。
 * 默认区间是本月 1 号 → 今天，所以**只有 1 笔**在区间内 ——
 * 断言写 2 是把「区间外那笔」也算进去了，属于断言错而不是代码错。
 */
check('下钻只返回该分类在区间内的账单', r.json.data.totalCount === 1, `count=${r.json.data.totalCount}`);
const wide2 = await call('GET', P`/ledgers/${ledgerId}/stats/drilldown` + `?categoryId=${encodeURIComponent(catA.id)}&dateFrom=${lastMonth}&dateTo=${todayStr}`, { token });
check('放宽区间到上月后同一分类变 2 笔（区间真的生效）', wide2.json.data.totalCount === 2, `count=${wide2.json.data.totalCount}`);

r = await call('GET', P`/ledgers/${ledgerId}/stats/report?period=month`, { token });
check('月报 200 且给出日均支出', r.status === 200 && typeof r.json.data.totals?.dailyExpense === 'string', r.json.data.totals?.dailyExpense);
r = await call('GET', P`/ledgers/${ledgerId}/stats/report?period=week`, { token });
check('周报区间是 7 天', r.json.data.period?.days === 7, JSON.stringify(r.json.data.period));
r = await call('GET', P`/ledgers/${ledgerId}/stats/report?period=year`, { token });
check('年报区间是整年', r.json.data.period?.from === `${Y}-01-01` && r.json.data.period?.to === `${Y}-12-31`);

r = await call('GET', P`/ledgers/${ledgerId}/stats/comparison?dateFrom=${Y}-${MP}-01&dateTo=${todayStr}`, { token });
check('环比同时给总额与日均口径', r.status === 200 && 'amountChangeRate' in r.json.data.expense && 'dailyChangeRate' in r.json.data.expense);

/* ══════════ S-09 净资产 ══════════ */
console.log('\n── S-09 净资产与快照 ──');
r = await call('GET', P`/ledgers/${ledgerId}/stats/net-worth?limit=6`, { token });
/**
 * 契约是「末尾裁掉开头连续『资产与负债都为 0』的月份，只保留当月实时点」。
 * 本基线账本是全新的，没有历史快照 →裁完只剩当月 1 期（len=1）。
 * 断言写死 6 是把「被裁掉的 5 个空月」也算进去了，属于断言错而不是代码错。
 * 真正要卡的是：条数在 1..limit 之间、末条是当月 live、且返回里没有空月头。
 */
check(
  '净资产序列只保留有值月份（≥1 且≤limit）',
  r.json.data.length >= 1 && r.json.data.length <= 6,
  `len=${r.json.data.length}`,
);
check('当期来源是 live', r.json.data[r.json.data.length - 1]?.source === 'live');
check(
  '首条不是空月（资产或负债非 0）',
  Number(r.json.data[0]?.assetTotal) !== 0 || Number(r.json.data[0]?.liabilityTotal) !== 0,
  `asset=${r.json.data[0]?.assetTotal} liability=${r.json.data[0]?.liabilityTotal}`,
);
const snap = await call('POST', P`/ledgers/${ledgerId}/stats/net-worth/snapshots`, { token, body: { snapshotDate: `${Y}-${MP}-01` } });
check('写快照 200', snap.status === 200 || snap.status === 201, `got ${snap.status}`);
const snapAgain = await call('POST', P`/ledgers/${ledgerId}/stats/net-worth/snapshots`, { token, body: { snapshotDate: `${Y}-${MP}-01` } });
check('同一天重复写快照是幂等更新', snapAgain.json?.data?.updated === true, JSON.stringify(snapAgain.json?.data));

/* ══════════ S-11 同比与事件 ══════════ */
console.log('\n── S-11 同比与事件标注 ──');
r = await call('GET', P`/ledgers/${ledgerId}/stats/year-over-year?year=${Y}&month=${M}`, { token });
check('同比 200 且给出分类同比', r.status === 200 && Array.isArray(r.json.data.categories));
const ev = await call('POST', P`/ledgers/${ledgerId}/stats/events`, { token, body: { eventDate: todayStr, title: '装修', note: '同比解释', expectedAmount: '5000' } });
check('建事件 200', ev.status === 200 || ev.status === 201, `got ${ev.status}`);
r = await call('GET', P`/ledgers/${ledgerId}/stats/events`, { token });
check('事件列表含刚建的事件', (r.json.data ?? []).some((e) => e.title === '装修'));
r = await call('DELETE', P`/ledgers/${ledgerId}/stats/events/${ev.json.data.id}`, { token });
check('删事件 200', r.status === 200, `got ${r.status}`);

/* ══════════ S-12 自定义报表 ══════════ */
console.log('\n── S-12 自定义报表 ──');
r = await call('GET', P`/ledgers/${ledgerId}/stats/reports`, { token });
check('报表列表含内置预设', r.status === 200 && (r.json.data.builtin ?? []).length >= 3);
const rep = await call('POST', P`/ledgers/${ledgerId}/stats/reports`, {
  token,
  body: { name: '我的分类报表', config: { groupBy: ['category'], metrics: ['expense', 'count'], recordType: 'expense' } },
});
check('建自定义报表 200', rep.status === 200 || rep.status === 201, `got ${rep.status}`);
r = await call('POST', P`/ledgers/${ledgerId}/stats/reports/run`, {
  token,
  body: { groupBy: ['category'], metrics: ['expense', 'count'], recordType: 'expense' },
});
check('执行报表 200 且有行', r.status === 200 && r.json.data.rows.length > 0, JSON.stringify(r.json.data.rows?.slice(0, 2)));
const noDim = await call('POST', P`/ledgers/${ledgerId}/stats/reports/run`, { token, body: { groupBy: [], metrics: ['expense'] } });
check('缺分组维度 → 400', noDim.status === 400, `got ${noDim.status}`);
if (rep.json?.data?.id) {
  await call('DELETE', P`/ledgers/${ledgerId}/stats/reports/${rep.json.data.id}`, { token });
}

/* ══════════ S-13 导出 ══════════ */
console.log('\n── S-13 报表导出 ──');
const csv = await call('GET', P`/ledgers/${ledgerId}/stats/export.csv`, { token });
check('导出 200', csv.status === 200, `got ${csv.status}`);
/**
 * ⚠️ 不能用 `res.text()` 验证 BOM：fetch 的 text() 按 WHATWG 规范
 * **会剥掉 BOM**，于是「服务端明明带了 BOM」也会被判成没带。
 * 必须看原始字节（EF BB BF）。
 */
check(
  'CSV 带 UTF-8 BOM（Excel 不乱码）',
  csv.buf[0] === 0xef && csv.buf[1] === 0xbb && csv.buf[2] === 0xbf,
  JSON.stringify([...csv.buf.slice(0, 3)]),
);
check('CSV 含合计行', /合计/.test(csv.text));

/* ══════════ S-14 / S-15 / S-16 / S-17 ══════════ */
console.log('\n── S-14 热力图 / S-15 洞察 / S-16 订阅 / S-17 现金流 ──');
r = await call('GET', P`/ledgers/${ledgerId}/stats/heatmap?year=${Y}&month=${M}`, { token });
check('热力图 200 且有分级', r.status === 200 && typeof r.json.data.days?.[0]?.level === 'number');
r = await call('GET', P`/ledgers/${ledgerId}/stats/insights`, { token });
check('洞察 200 且至少一条结论', r.status === 200 && r.json.data.insights.length > 0, JSON.stringify(r.json.data.insights?.[0]?.text ?? ''));
r = await call('GET', P`/ledgers/${ledgerId}/stats/subscriptions`, { token });
check('订阅识别 200', r.status === 200 && Array.isArray(r.json.data));
r = await call('GET', P`/ledgers/${ledgerId}/stats/cash-flow`, { token });
check('现金流三分类 200 且含三段', r.status === 200 && r.json.data.sections.length === 3, JSON.stringify(r.json.data.sections.map((s) => s.section)));
check('现金流给出归类覆盖率', typeof r.json.data.coverageRate === 'number', String(r.json.data.coverageRate));

/* ══════════ X-05 / X-06 ══════════ */
console.log('\n── X-05 口径版本 / X-06 报销冲减 ──');
r = await call('GET', P`/ledgers/${ledgerId}/stats/policies`, { token });
check('口径版本列表 200 且有默认版本', r.status === 200 && typeof r.json.data.current === 'string', r.json.data.current);
const pol = await call('POST', P`/ledgers/${ledgerId}/stats/policies`, {
  token,
  body: { version: 'v2', effectiveFrom: todayStr, changes: ['内部转账不计收支'], note: '测试' },
});
check('建口径版本 200', pol.status === 200 || pol.status === 201, `got ${pol.status}`);
const polDup = await call('POST', P`/ledgers/${ledgerId}/stats/policies`, {
  token,
  body: { version: 'v2', effectiveFrom: todayStr, changes: [] },
});
check('重复口径版本 → 409/400', polDup.status === 409 || polDup.status === 400, `got ${polDup.status}`);

const rebTx = (await tx({ recordType: 'expense', categoryId: catA.id, name: '垫付差旅', amount: '500.00' })).json.data;
const recvTx = (await tx({ recordType: 'income', categoryId: incCat.id, name: '报销到账', amount: '500.00' })).json.data;
const reb = await call('POST', P`/ledgers/${ledgerId}/stats/reimbursements`, {
  token,
  body: { originTxId: rebTx.id, receivedTxId: recvTx.id, amount: '500.00', claimDate: todayStr, receivedDate: todayStr, orgName: '公司' },
});
check('登记报销 200', reb.status === 200 || reb.status === 201, `got ${reb.status} ${JSON.stringify(reb.json?.error ?? '')}`);
const rebDup = await call('POST', P`/ledgers/${ledgerId}/stats/reimbursements`, {
  token,
  body: { originTxId: rebTx.id, receivedTxId: recvTx.id, amount: '100.00', claimDate: todayStr, receivedDate: todayStr },
});
check('同一笔重复报销 → 409/400', rebDup.status === 409 || rebDup.status === 400, `got ${rebDup.status}`);
const badReb = await call('POST', P`/ledgers/${ledgerId}/stats/reimbursements`, {
  token,
  body: { originTxId: txInc.id, receivedTxId: recvTx.id, amount: '100.00', claimDate: todayStr, receivedDate: todayStr },
});
check('拿收入当原始支出 → 400', badReb.status === 400, `got ${badReb.status}`);
r = await call('GET', P`/ledgers/${ledgerId}/stats/category-expense-net`, { token });
const rowA = (r.json.data ?? []).find((x) => x.categoryId === catA.id);
check('分类支出已扣报销（500 被冲减）', rowA?.reimbursed === '500.00', JSON.stringify({ gross: rowA?.amount, cut: rowA?.reimbursed, net: rowA?.netAmount }));

/* ══════════ R-03 更正三路径 ══════════ */
console.log('\n── R-03 更正三路径 ──');
r = await call('GET', P`/ledgers/${ledgerId}/transactions/${txA.id}/correction-guide`, { token });
check('更正建议 200 且给出推荐路径', r.status === 200 && r.json.data.recommended.length > 0, JSON.stringify(r.json.data.recommended));
const amend = await call('POST', P`/ledgers/${ledgerId}/transactions/${txA.id}/amend`, { token, body: { amount: '210.00', reason: '小票金额记错' } });
check('划线更正 200', amend.status === 200, `got ${amend.status} ${JSON.stringify(amend.json?.error ?? '')}`);
check('更正留痕含改前值', amend.json?.data?.before?.amount === '200.00', JSON.stringify(amend.json?.data?.before));
const noReason = await call('POST', P`/ledgers/${ledgerId}/transactions/${txA.id}/amend`, { token, body: { amount: '220.00' } });
check('更正未写理由 → 400（留痕要求）', noReason.status === 400, `got ${noReason.status}`);
const rev = await call('POST', P`/ledgers/${ledgerId}/transactions/${txA.id}/reverse`, { token, body: { reason: '重复入账' } });
check('红字冲销 200', rev.status === 200 || rev.status === 201, `got ${rev.status} ${JSON.stringify(rev.json?.error ?? '')}`);
const revDup = await call('POST', P`/ledgers/${ledgerId}/transactions/${txA.id}/reverse`, { token, body: { reason: '再来一次' } });
check('重复冲销 → 409/400（不产生第二笔冲销）', revDup.status === 409 || revDup.status === 400, `got ${revDup.status}`);
const txList = await call('GET', P`/ledgers/${ledgerId}/transactions?limit=100`, { token });
const revRow = (txList.json.data ?? []).find((t) => t.id === rev.json?.data?.reversalId);
check(
  '冲销笔的账户变动是反向的（+210，原笔 −210）',
  String(revRow?.accountDelta ?? '').replace(/[^\d.]/g, '') === '210.00',
  JSON.stringify({ delta: revRow?.accountDelta, name: revRow?.name }),
);
const txAAfter = (txList.json.data ?? []).find((t) => t.id === txA.id);
check(
  '划线更正后账户Δ同步重算（不是只改了名义金额）',
  String(txAAfter?.accountDelta ?? '').replace(/[^\d.-]/g, '') === '-210.00',
  JSON.stringify({ delta: txAAfter?.accountDelta }),
);

/* ══════════ R-05 排期 ══════════ */
console.log('\n── R-05 对账排期 ──');
r = await call('GET', P`/ledgers/${ledgerId}/recon-schedule`, { token });
check('排期列表 200', r.status === 200 && r.json.data.length >= 2);
check('从未对过账的账户单列 never', r.json.data.some((x) => x.dueState === 'never'), JSON.stringify(r.json.data.map((x) => x.dueState)));
const sch = await call('PUT', P`/ledgers/${ledgerId}/accounts/${acc.id}/recon-schedule`, { token, body: { cycle: 'weekly', anchorDay: 1, remindDays: 3 } });
check('设周结对账 200', sch.status === 200, `got ${sch.status}`);
const badSch = await call('PUT', P`/ledgers/${ledgerId}/accounts/${acc.id}/recon-schedule`, { token, body: { cycle: 'monthly', anchorDay: 40 } });
check('月结锚点 40 → 400', badSch.status === 400, `got ${badSch.status}`);
r = await call('GET', P`/ledgers/${ledgerId}/recon-schedule`, { token });
check('设置后周期生效', r.json.data.find((x) => x.accountId === acc.id)?.cycle === 'weekly');

/* ══════════ R-06 / R-07 / R-08 / R-11 ══════════ */
console.log('\n── R-06 导入 / R-07 匹配 / R-08 勾兑 / R-11 匹配率 ──');
const before = (await call('GET', P`/ledgers/${ledgerId}/transactions?limit=200`, { token })).json.data.length;
const csvText = ['日期,金额,摘要', `${todayStr},-30.00,便利店`, `${todayStr},-88.88,超市`, `${todayStr},-30.00,便利店`].join('\n');
const imp = await call('POST', P`/ledgers/${ledgerId}/accounts/${acc.id}/statements/import`, {
  token,
  body: { filename: 'stmt.csv', content: csvText, mapping: { date: '日期', amount: '金额', description: '摘要' } },
});
check('导入流水 200', imp.status === 200 || imp.status === 201, `got ${imp.status} ${JSON.stringify(imp.json?.error ?? '')}`);
check('导后业务账单数**不变**（流水不进业务库）', (await call('GET', P`/ledgers/${ledgerId}/transactions?limit=200`, { token })).json.data.length === before, `before=${before}`);
check('批内重复行被标记', imp.json?.data?.duplicateCount === 1, `dup=${imp.json?.data?.duplicateCount}`);
const stmtId = imp.json?.data?.statementId;
r = await call('GET', P`/ledgers/${ledgerId}/statements/${stmtId}/lines`, { token });
check('流水行列表 3 行', r.json.data.length === 3, `len=${r.json.data.length}`);
const line30 = r.json.data.find((l) => l.amount === '30.00' && !l.excludedReason);
// 先造一笔 30 元账单，再跑匹配
const tx30 = (await tx({ recordType: 'expense', categoryId: catB.id, name: '便利店', amount: '30.00' })).json.data;
r = await call('POST', P`/ledgers/${ledgerId}/statements/${stmtId}/match`, { token, body: { windowDays: 3 } });
check('自动匹配 200', r.status === 200, `got ${r.status}`);
check('匹配到 1 笔（唯一金额+同日）', r.json?.data?.summary?.matched === 1, JSON.stringify(r.json?.data?.summary));
const unmatchedLine = (await call('GET', P`/ledgers/${ledgerId}/statements/${stmtId}/lines`, { token })).json.data.find((l) => l.amount === '88.88');
r = await call('POST', P`/ledgers/${ledgerId}/statement-lines/${unmatchedLine.id}/match`, { token, body: { txId: tx30.id, reason: '人工确认' } });
check('人工勾兑 200 且标出金额不一致', r.status === 200 && r.json?.data?.amountConsistent === false, JSON.stringify(r.json?.data));
r = await call('GET', P`/ledgers/${ledgerId}/recon-match-rate`, { token });
check('匹配率 200 且给出阈值', r.status === 200 && r.json.data.threshold === 90, JSON.stringify({ rate: r.json.data.matchRate }));
check('样本不足 20 笔时不提示漏记风险', r.json.data.riskHint === null, String(r.json.data.riskHint));

/* ══════════ R-09 调节表 ══════════ */
console.log('\n── R-09 未达账项与调节表 ──');
const item = await call('POST', P`/ledgers/${ledgerId}/recon-adjusting-items`, {
  token,
  body: { accountId: acc.id, side: 'positive', kind: 'deposit_in_transit', itemDate: todayStr, amount: '100.00', note: '在途存款' },
});
check('建未达账项 200', item.status === 200 || item.status === 201, `got ${item.status} ${JSON.stringify(item.json?.error ?? '')}`);
r = await call('GET', P`/ledgers/${ledgerId}/accounts/${acc.id}/recon-statement?statementBalance=50500.00`, { token });
check('调节表 200', r.status === 200, `got ${r.status}`);
check('调节表给出调节后余额与差额', typeof r.json.data.adjustedBookBalance === 'string' && 'unexplainedDiff' in r.json.data, JSON.stringify({ book: r.json.data.bookBalance, adj: r.json.data.adjustedBookBalance, diff: r.json.data.unexplainedDiff }));
check('调节表含未达账项明细', (r.json.data.items ?? []).length === 1);
const clear = await call('POST', P`/ledgers/${ledgerId}/recon-adjusting-items/${item.json.data.id}/clear`, { token, body: {} });
check('核销未达账项 200', clear.status === 200, `got ${clear.status}`);
r = await call('GET', P`/ledgers/${ledgerId}/accounts/${acc.id}/recon-statement?statementBalance=50500.00`, { token });
check('核销后未达账项从调节表消失', (r.json.data.items ?? []).length === 0);

/* ══════════ R-10 / R-12 / R-13 / R-14 ══════════ */
console.log('\n── R-10 信用卡 / R-12 重复扣费 / R-13 凭证 / R-14 自动同步 ──');
r = await call('GET', P`/ledgers/${ledgerId}/accounts/${acc.id}/credit-billing`, { token });
check('信用卡账单日对账 200 且给出在途口径', r.status === 200 && 'pendingAmount' in r.json.data, JSON.stringify({ billed: r.json.data.billedAmount, pending: r.json.data.pendingAmount }));
r = await call('GET', P`/ledgers/${ledgerId}/duplicate-charges`, { token });
check('重复扣费清单 200', r.status === 200 && Array.isArray(r.json.data.items));
r = await call('GET', P`/ledgers/${ledgerId}/missing-receipts?minAmount=200`, { token });
check('缺凭证清单 200 且只列大额', r.status === 200 && (r.json.data.rows ?? []).every((x) => Number(x.amount.replace(/[^\d.]/g, '')) >= 200), `${r.json.data.count} 条`);
r = await call('GET', P`/ledgers/${ledgerId}/bank-sync`, { token });
check('R-14 明确返回不支持（不静默缺失）', r.status === 200 && r.json.data.supported === false && /合规/.test(r.json.data.reason));

/* ══════════ X-01 / X-02 / X-04 / X-07 ══════════ */
console.log('\n── X-01 增量刷新 / X-02 跨期修订 / X-04 口径自检 / X-07 订阅汇总 ──');
r = await call('POST', P`/ledgers/${ledgerId}/incremental-refresh`, { token, body: { txDate: todayStr } });
check('增量刷新 200 且只回受影响期间', r.status === 200 && typeof r.json.data.affectedPeriod === 'string', r.json.data.affectedPeriod);
check('增量刷新给出本期收支', typeof r.json.data.periodTotals?.expense === 'string', r.json.data.periodTotals?.expense);

const back = await call('POST', P`/ledgers/${ledgerId}/backdated-adjustments`, { token, body: { txId: tx30.id, source: 'manual', note: '补记上月' } });
check('登记跨期修订 200', back.status === 200 || back.status === 201, `got ${back.status} ${JSON.stringify(back.json?.error ?? '')}`);
check('同月补记不判为跨期', back.json?.data?.crossPeriod === false, JSON.stringify(back.json?.data));
r = await call('GET', P`/ledgers/${ledgerId}/backdated-adjustments`, { token });
check('跨期修订列表 200', r.status === 200 && r.json.data.length >= 1);
r = await call('GET', P`/ledgers/${ledgerId}/internal-flow-audit`, { token });
check('口径自检 200 且只把收支计入', r.status === 200 && typeof r.json.data.counted?.expense === 'string', JSON.stringify(r.json.data.counted));

// 内部转账不计收支：转 1000 后支出不变
const expBefore = (await call('GET', P`/ledgers/${ledgerId}/stats/summary`, { token })).json.data.totalExpense;
const tr = await call('POST', P`/ledgers/${ledgerId}/transactions`, {
  token,
  body: { recordType: 'transfer', accountId: acc.id, toAccountId: acc2.id, name: '卡转现金', amount: '1000.00', txDate: todayStr, fee: '0', discount: '0' },
});
check('建转账 201', tr.status === 201, `got ${tr.status} ${JSON.stringify(tr.json?.error ?? '')}`);
const expAfter = (await call('GET', P`/ledgers/${ledgerId}/stats/summary`, { token })).json.data.totalExpense;
check('内部转账后「支出」不变（X-04）', expBefore === expAfter, `${expBefore} → ${expAfter}`);
r = await call('GET', P`/ledgers/${ledgerId}/internal-flow-audit`, { token });
check('口径自检把转账列在「已排除」里', (r.json.data.excluded ?? []).some((x) => x.recordType === 'transfer'), JSON.stringify(r.json.data.excluded));

r = await call('GET', P`/ledgers/${ledgerId}/subscription-digest`, { token });
check('订阅汇总 200 且给出年化与建议预提', r.status === 200 && 'monthlyProvision' in r.json.data, JSON.stringify({ annual: r.json.data.confirmedAnnual, provision: r.json.data.monthlyProvision }));

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
