/**
 * 分期账单页 —— CDP 探针
 *
 * 这一页最容易被做错的地方不是渲染，而是**口径**。所以探针优先验的是会计口径：
 *   1. **支出只记一次**：建 N 期计划 → 账户负债 −总额（含手续费），还 k 期 → 负债回收 k 期应还，
 *      而**支出总额不变**（`/installment-plans` 全程只有那一笔 expenses）。
 *      分期的错误实现会让支出随时间增长，这条断言专治那个。
 *   2. 页上的「待还」= 后端 remainingAmount，「下一期应还」= 后端 nextDue.totalDue —— 逐格相等。
 *   3. 卡片主数字是**总额**而非「累计已还」，避免读者把 Payments 当成支出。
 *   4. 进行中的账户不可归档（`assertAccountNotInActivePlan` 已接进 archiveAccount）。
 *   5. 期明细面板每行与 `GET /installment-plans/:id/schedules` 一致（序/日期/本金/费/应还）。
 *   6. 「≡ 分期也不能重复计收支」：每期还款的 record_type 全都是 transfer。
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'installments');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, waitUntil, errors, netFails } = probe;
const c = checker();
const { check } = c;

/**
 * `money()` 是**唯一**的金额出口，它带千分位（`¥ 12,600.00`）。
 * 逐格比对时先把「¥ / 逗号 / 空白」去掉再比数字串 —— 页面的格式化方式变了
 * 不该让「金额算得对不对」这条断言红掉，那是两件事。
 */
const norm = (s) => String(s ?? '').replace(/[¥,\s]/g, '');

/* ---------- 数据准备 ---------- */
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.71.${Math.floor(Math.random() * 250)}.7` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'inst' + Date.now().toString(36),
      nickname: '分期探针',
      password: 'InstProbe123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const G = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json()).data;
const grp = G.find((x) => x.id.endsWith('#grp_bank')) ?? G[0];

async function mkAccount(name, type, opening) {
  return (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
        method: 'POST',
        headers: POST,
        body: JSON.stringify({ name, type, groupId: grp.id, openingBalance: opening }),
      })
    ).json()
  ).data;
}

const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromToday = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ds(d);
};
const today = ds(new Date());

const card = await mkAccount('招行信用卡', 'credit_card', '0.00');
const sav = await mkAccount('工资卡', 'debit_card', '50000.00');
/** 一个**不参与任何分期**的账户，用来验「无关的账户照样能归档」 */
const spare = await mkAccount('备用卡', 'debit_card', '100.00');
/**
 * 第二笔分期必须挂在**另一张卡**上。
 * 两个计划共用一张负债账户时，那个卡余额是两者之和 ——
 * 想逐笔核对「−总额 + Σ已还」这条恒等式就得先把它们代数分离，
 * 否则探针里全是拼出来的合计数，看一眼就知道对不对的那条最重要断言反而没了。
 */
const card2 = await mkAccount('家电分期卡', 'credit_card', '0.00');

const cats = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories?recordType=expense`}`, { headers: AH })).json())
  .data;
let cat = null;
for (const p of cats) {
  if (cat) break;
  for (const ch of p.children ?? [])
    if (!cat) cat = ch;
}

const bal = async (id) =>
  (await (await fetch(`${API}${P`/ledgers/${ledger.id}/accounts/${id}/balance`}`, { headers: AH })).json()).data
    .balance;

async function mkPlan(payload) {
  return (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans`}`, {
        method: 'POST',
        headers: POST,
        body: JSON.stringify(payload),
      })
    ).json()
  ).data;
}

/* docs/05 §12.3 的场景：本金 12000，手续费 600 一次性，12 期，首期多还 */
const created = await mkPlan({
  title: 'iPhone 17 Pro',
  totalAmount: '12000.00',
  totalFee: '600.00',
  installmentCount: 12,
  frequency: 'monthly',
  firstDate: fromToday(1),
  feeMode: 'once',
  feeHandling: 'first_period',
  accountId: sav.id,
  debtAccountId: card.id,
  recordType: 'expense',
  categoryId: cat.id,
});
const plan = created.plan;
check('创建分期 201 且含首笔支出单据', Boolean(created.startTransaction?.id), JSON.stringify(created.startTransaction));
check('合计 = 本金 + 手续费 = 12600.00', plan.grandTotal === '12600.00', plan.grandTotal);
check(
  '费用独立于计划：信用卡负债 = −12600.00（一次记全额）',
  (await bal(card.id)) === '-12600.00',
  await bal(card.id),
);
check('nextDue 带 scheduleId（前端「还下一期」要用）', Boolean(plan.progress.nextDue?.scheduleId), JSON.stringify(plan.progress.nextDue));
check('首期应还 = 本金 1000 + 全手续费 600 = 1600.00', plan.progress.nextDue.totalDue === '1600.00', plan.progress.nextDue.totalDue);

/* 第二笔：无手续费的分期，用来验「列表区组合计」与「结清」两条路径 */
await mkPlan({
  title: '家电分期',
  totalAmount: '3600.00',
  installmentCount: 3,
  frequency: 'monthly',
  firstDate: fromToday(1),
  feeMode: 'once',
  feeHandling: 'first_period',
  accountId: sav.id,
  debtAccountId: card2.id,
  recordType: 'expense',
  categoryId: cat.id,
});

/* 还掉第一笔的第 1 期 —— 在页面加载前完成，好让 snapshots 有意义 */
await fetch(`${API}${P`/ledgers/${ledger.id}/installment-schedules/${plan.progress.nextDue.scheduleId}/pay`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({}),
});
const cardAfter1 = await bal(card.id);
check('还第 1 期后信用卡 = −11000.00（−12600 + 1600）', cardAfter1 === '-11000.00', cardAfter1);

/* 后端真值，逐格比对用 */
const serverPlans = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans`}`, { headers: AH })).json())
  .data;
const serverPhi = serverPlans.find((p) => p.id === plan.id);
const serverScheds = (
  await (await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans/${plan.id}/schedules`}`, { headers: AH })).json()
).data;
console.log(`后端：${serverPlans.length} 个计划，主计划进度 ${serverPhi.progress.paidCount}/${serverPhi.progress.totalCount}`);

/* ---------- 干净起点 ---------- */
await wipe();
const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });

/* ══════════════ 1. 页面渲染 ══════════════ */
console.log('\n── 1. 页面渲染 ──');
const opened = await open('/installments', { wait: '.inst-card', theme: 'light', arm: auth.arm });
check('页面渲染出分期卡片', opened === true);
check(
  '卡片数量 = 后端计划数',
  (await ev(`document.querySelectorAll('.inst-card').length`)) === serverPlans.length,
  `${await ev(`document.querySelectorAll('.inst-card').length`)} vs ${serverPlans.length}`,
);
c.shot(await probe.shot('inst-light-1440', { dir: OUT, focus: '.inst-card' }));

/* ══════════════ 2. 概览条 ══════════════ */
console.log('\n── 2. 概览条 ──');
const strip = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.inst__strip .stat-strip__cell')].map(c => ({
    label: c.querySelector('.stat-strip__label').textContent.trim(),
    value: c.querySelector('.stat-strip__value').textContent.replace(/\\s+/g,' ').trim(),
  })))`),
);
const byLabel = Object.fromEntries(strip.map((x) => [x.label, x.value]));
const activePlans = serverPlans.filter((p) => p.status === 'active');
const expectOutstanding = activePlans.reduce((a, p) => a + Math.round(Number(p.progress.remainingAmount) * 100), 0) / 100;
const expectNext = activePlans.reduce(
  (a, p) => a + (p.progress.nextDue ? Math.round(Number(p.progress.nextDue.totalDue) * 100) : 0),
  0,
) / 100;
check('概览条有 4 个指标', strip.length === 4, JSON.stringify(strip));
check('进行中 = 后端 active 数', byLabel['进行中'] === `${activePlans.length} 个`, `${byLabel['进行中']} vs ${activePlans.length}`);
check(
  '「待还总额」= Σ 后端 remainingAmount',
  norm(byLabel['待还总额']) === expectOutstanding.toFixed(2),
  `页面=${byLabel['待还总额']} 期望=¥${expectOutstanding.toFixed(2)}`,
);
check(
  '「近一期应还」= Σ 后端 nextDue.totalDue',
  norm(byLabel['近一期应还']) === expectNext.toFixed(2),
  `页面=${byLabel['近一期应还']} 期望=¥${expectNext.toFixed(2)}`,
);

/* ══════════════ 3. 卡片数字逐格比对 ══════════════ */
console.log('\n── 3. 卡片逐格比对 ──');
const cards = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.inst-card')].map(el => ({
    plan: el.dataset.plan,
    grand: el.querySelector('.inst-card__grand')?.textContent.trim(),
    lines: [...el.querySelectorAll('.recon-line')].map(x => x.textContent.replace(/\\s+/g,' ').trim()),
    barWidth: el.querySelector('.inst-card__bar-fill')?.style.width,
  })))`),
);
const phi = cards.find((x) => x.plan === plan.id);
check('卡片主数字 = 计划合计（12,600.00）', norm(phi.grand) === '12600.00', phi.grand);
check(
  '进度条宽度 = 已还/总期数',
  phi.barWidth === `${Math.round((serverPhi.progress.paidCount / serverPhi.progress.totalCount) * 100)}%`,
  `${phi.barWidth} vs ${serverPhi.progress.paidCount}/${serverPhi.progress.totalCount}`,
);
const joined = phi.lines.join(' | ');
check(
  '「N / 12 期已还」= 后端进度',
  joined.includes(`${serverPhi.progress.paidCount} / ${serverPhi.progress.totalCount} 期已还`),
  joined,
);
check('「待还」= 后端 remainingAmount', norm(joined).includes('待还'+norm(serverPhi.progress.remainingAmount)), joined);
check(
  '「下一期」= 后端 nextDue（日期 + 应还）',
  joined.includes(serverPhi.progress.nextDue.dueDate) &&
    norm(joined).includes('应还'+norm(serverPhi.progress.nextDue.totalDue)),
  joined,
);
const cardText = await ev(`document.querySelector('.inst-card').textContent.replace(/\\s+/g,' ')`);
check(
  '卡片写明了资金方向「<负债账户> 消费 → <储蓄账户> 还款」（不是两个无名账户）',
  cardText.includes(`${card.name} 消费`) && cardText.includes(`${sav.name} 还款`),
  cardText.slice(0, 200),
);

/* ══════════════ 4. 期明细面板 ══════════════ */
console.log('\n── 4. 期明细 ──');
await ev(`document.querySelector('[data-plan="${plan.id}"] [data-act=detail]').click()`);
const schedRows = await waitUntil(
  async () => {
    const n = await ev(`document.querySelectorAll('.inst-sched__row').length`);
    return n > 0 ? n : null;
  },
  { label: '期明细渲染' },
);
check('明细行数 = 后端期数（12）', schedRows === serverScheds.length, `${schedRows} vs ${serverScheds.length}`);

const rows = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.inst-sched__row')].map(el => ({
    seq: el.querySelector('.inst-sched__seq')?.textContent.trim(),
    cells: [...el.children].map(c => c.textContent.replace(/\\s+/g,' ').trim()),
    paid: el.classList.contains('is-paid'),
  })))`),
);
const first = rows[0];
const s1 = serverScheds[0];
check('第 1 期显示应还 1600.00', norm(first.cells.join(' ')).includes('1600.00'), first.cells.join(' | '));
check('第 1 期已还 → 带 is-paid 且是「已还」标签', first.paid === true && first.cells.join(' ').includes('已还'), JSON.stringify(first));
const second = rows[1];
check('第 2 期未还 → 有「标记已还」按钮', second.paid === false && second.cells.join(' ').includes('标记已还'), JSON.stringify(second));
check('第 2 期应还 1000.00（手续费只在首期）', norm(second.cells.join(' ')).includes('1000.00') && !norm(second.cells.join(' ')).includes('费'), second.cells.join(' | '));
check(
  '面板顶部标出那笔唯一的支出（日期 + 金额）',
  (await ev(`document.querySelector('[data-role=panel-slot]').textContent.replace(/\\s+/g,' ')`)).includes('消费记在'),
  (await ev(`document.querySelector('[data-role=panel-slot]').textContent.replace(/\\s+/g,' ')`)).slice(0, 180),
);
c.shot(await probe.shot('inst-detail-1440', { dir: OUT, focus: '.inst-sched' }));

/* ══════════════ 5. 核心口径：支出不因还款而增长 ══════════════ */
console.log('\n── 5. 口径 ──');
/*
 * 这是整个分期模块**唯一不可替代**的断言：
 * 「按 JournalEntry 的规矩，消费只在发生时确认一次；还款是资金划转，不是费用。」
 * 所以无论还了多少期，expense 类型的账单数都必须等于**计划数**（每计划一笔），
 * 一笔不多。错误实现会让支出随期数线性增长（`docs/05 §12.2` 明确列为反例）。
 */
const countByType = async (recordType) =>
  (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/transactions?recordType=${recordType}&pageSize=200`}`, {
        headers: AH,
      })
    ).json()
  ).data.length;
const expensesBefore = await countByType('expense');
const transfersBefore = await countByType('transfer');

await ev(`document.querySelectorAll('.inst-sched__row')[1].querySelector('[data-pay]').click()`);
await sleep(1500);

const after2 = await bal(card.id);
check(
  '再还一期 → 信用卡 = −10,000.00（−12,600 + 1600 + 1000）',
  after2 === '-10000.00',
  `${cardAfter1} → ${after2}`,
);

const expensesAfter = await countByType('expense');
const transfersAfter = await countByType('transfer');
check(
  `还了 2 期，支出账单数仍是 ${expensesBefore}（分期不得按周期重复计支出）`,
  expensesAfter === expensesBefore,
  `还前 ${expensesBefore} → 还后 ${expensesAfter}`,
);
check(
  '还款确实新增了 1 笔转账（+1，不是 +0）',
  transfersAfter === transfersBefore + 1,
  `还前 ${transfersBefore} → 还后 ${transfersAfter}`,
);

/* ══════════════ 6. 进行中的账户不可归档 ══════════════ */
console.log('\n── 6. 归档守卫 ──');
const arcCard = await fetch(`${API}${P`/ledgers/${ledger.id}/accounts/${card.id}`}`, {
  method: 'DELETE',
  headers: AH,
});
/* ⚠️ Response body 只能读一次，两处断言都要用就得先落地变量 */
const arcCardBody = await arcCard.json().catch(() => null);
check('参与进行中分期的账户 → 归档被拒 400', arcCard.status === 400, `got ${arcCard.status}`);
check(
  '错误信息点明了是哪个分期',
  /分期/.test(String(arcCardBody?.error?.message ?? '')),
  String(arcCardBody?.error?.message ?? ''),
);
const arcSpare = await fetch(`${API}${P`/ledgers/${ledger.id}/accounts/${spare.id}`}`, {
  method: 'DELETE',
  headers: AH,
});
check('无关账户照样能归档 204', arcSpare.status === 204, `got ${arcSpare.status}`);

/* ══════════════ 7. 提前结清与取消 ══════════════ */
console.log('\n── 7. 结清 / 取消 ──');
/** 用第二个计划（家电 3600 三期）验结清：它一期未还 */
const appliance = serverPlans.find((p) => p.title === '家电分期');
const settleRes = await (
  await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans/${appliance.id}/settle-early`}`, {
    method: 'POST',
    headers: POST,
    body: JSON.stringify({}),
  })
).json();
check('提前结清 200 且一次记 3600.00', settleRes.data?.amount === '3600.00', JSON.stringify(settleRes.data));
const settled = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans`}`, { headers: AH })).json()).data.find(
  (p) => p.id === appliance.id,
);
check('结清后状态 = settled 且无待还期', settled.status === 'settled' && settled.progress.nextDue === null, JSON.stringify(settled.progress));

const cancelRes = await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans/${plan.id}/cancel`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({}),
});
check('取消分期 200', cancelRes.status === 200, `got ${cancelRes.status}`);
const delRes = await fetch(`${API}${P`/ledgers/${ledger.id}/installment-plans/${plan.id}`}`, {
  method: 'DELETE',
  headers: AH,
});
const delBody = await delRes.json().catch(() => null);
check(
  '已还过期的计划不能删除（防止那些转账失去出处）',
  delRes.status === 400,
  `got ${delRes.status} ${String(delBody?.error?.message ?? '')}`,
);

/* ══════════════ 8. 刷新后页面仍然一致 ══════════════ */
console.log('\n── 8. 刷新一致性 ──');
await probe.cdp('Page.reload', { ignoreCache: true });
await waitUntil(async () => (await ev(`document.querySelectorAll('.inst-card').length`)) || null, { label: '刷新后渲染' });
const doneCount = await ev(`document.querySelectorAll('.inst-card.is-done').length`);
check('非进行中的计划带 is-done（视觉降级到次要层）', Number(doneCount) >= 1, String(doneCount));
c.shot(await probe.shot('inst-after-settle-1440', { dir: OUT, focus: '.inst-card' }));

/* ══════════════ 9. 空态与暗色 / 窄屏 ══════════════ */
console.log('\n── 9. 暗色 / 空态 / 窄屏 ──');
await open('/installments', { wait: '.inst-card', theme: 'dark', arm: auth.arm });
c.shot(await probe.shot('inst-dark-1440', { dir: OUT, focus: '.inst-card' }));

/* 窄屏：期明细是五列 grid，最容易在 390 宽度上挤爆 —— 必须单独看一眼 */
await open('/installments', { wait: '.inst-card', theme: 'light', width: 390, height: 900, arm: auth.arm });
await ev(`document.querySelector('[data-plan="${plan.id}"] [data-act=detail]').click()`);
await waitUntil(async () => (await ev(`document.querySelectorAll('.inst-sched__row').length`)) || null, {
  label: '窄屏期明细',
});
const overflow = await ev(
  `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
);
check('390px 宽度下无横向溢出', Number(overflow) <= 1, `溢出 ${overflow}px`);
c.shot(await probe.shot('inst-mobile-390', { dir: OUT, focus: '.inst-sched' }));

/* 新账本 → 真空态（比靠筛选时序碰出来的空态可靠） */
const H2 = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.72.${Math.floor(Math.random() * 250)}.9` };
const reg2 = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H2,
    body: JSON.stringify({
      username: 'instEmpty' + Date.now().toString(36),
      nickname: '空态探针',
      password: 'InstEmpty123!2026',
      platform: 'web',
    }),
  })
).json();
await wipe();
const auth2 = authInjector({ token: reg2.data.accessToken, refreshToken: reg2.data.refreshToken });
await open('/installments', { wait: '.empty-state', theme: 'light', arm: auth2.arm });
const emptyText = await ev(`document.querySelector('.empty-state').textContent.replace(/\\s+/g,' ').trim()`);
check('空态文案讲清「一次记全额，之后按期还」', /全额/.test(emptyText) && /还款转账/.test(emptyText), emptyText.slice(0, 140));
check('空态有「新建分期」入口', !!(await ev(`!!document.querySelector('[data-action=add]')`)));
c.shot(await probe.shot('inst-empty-1440', { dir: OUT, focus: '.empty-state' }));

/* ══════════════ 收尾 ══════════════ */
check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));
const missing = await ev(`document.querySelectorAll('[data-missing-icon]').length`);
check('没有取不到图形的图标（缺失会渲染成问号）', Number(missing) === 0, String(missing));

probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
