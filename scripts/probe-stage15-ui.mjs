/**
 * Stage 15 前端探针：**统计进阶卡片 / 对账排期与工具 / 预算比例法**。
 *
 * 这一组页面新增的都是「后端算好、前端只呈现」的区块，所以探针要验的是
 * **呈现是否完整、是否会拖垮整页**，而不是重算数字：
 *   · 统计页出现「本期结论 / 净资产 / 现金流 / 订阅 / 支出强度 / 导出」六块
 *   · 洞察区块排在趋势图**之上**（结论先行，埋在底部等于没做）
 *   · 对账页出现排期，且「从未对账」是自成一档而不是混在「未到期」里
 *   · 预算页「比例法 / 历史推荐」能打开且不报错
 *   · 全程无控制台错误、无失败请求
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'stage15');

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, errors, netFails } = probe;
const c = checker();
const { check } = c;

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = iso(new Date());
const y = new Date().getFullYear();
const m = new Date().getMonth() + 1;

/* ══════════════ 数据准备 ══════════════ */
await wipe();

const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.88.${Math.floor(Math.random() * 250)}.7` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 's15' + Date.now().toString(36),
      nickname: 'Stage15 探针',
      password: 'Stage15Probe!2026',
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
const acc = (
  await (
    await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ name: '探针卡', type: 'debit_card', groupId: grp.id, openingBalance: '30000.00' }),
    })
  ).json()
).data;

const expTree = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=expense`, { headers: AH })).json()).data;
const incTree = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=income`, { headers: AH })).json()).data;
const expParent = expTree.find((p) => (p.children ?? []).length >= 2) ?? expTree[0];
const catA = expParent.children[0];
const incCat = (incTree.find((p) => (p.children ?? []).length) ?? incTree[0]).children[0];

async function tx(body) {
  return (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
        method: 'POST',
        headers: POST,
        body: JSON.stringify({ accountId: acc.id, txDate: todayStr, fee: '0', discount: '0', ...body }),
      })
    ).json()
  ).data;
}

await tx({ recordType: 'income', categoryId: incCat.id, name: '工资', amount: '12000.00' });
await tx({ recordType: 'expense', categoryId: catA.id, name: '吃饭', amount: '180.00' });
await tx({ recordType: 'expense', categoryId: catA.id, name: '吃饭2', amount: '220.00' });

const auth = authInjector({ token: TOKEN, ledgerId: ledger.id });

/* ══════════════ 1. 报表页与导出能力 ══════════════ */
console.log('\n── 1. 报表页与导出能力 ──');
await open('/stats', { wait: '.kpi-card', theme: 'light', arm: auth.arm });
await new Promise((r) => setTimeout(r, 2200));

/**
 * Stage 15 曾在报表页底部挂 6 张进阶卡片（本期结论 / 净资产 / 现金流三分类 /
 * 订阅与固定扣款 / 支出强度 / 导出）。报表页改成 11 模块 Bento 栅格后，
 * 这几张卡**按需求整体下线** —— 它们回答的是「结论」而不是「数字」，
 * 混在报表里会把「看数」变成「读结论」。
 *
 * ⚠️ 但**能力不能跟着一起消失**：
 *   · 导出 CSV 是刚需 → 迁到筛选栏右端（与「导出报表」并列）
 *   · 其余五项的后端接口仍在（`smoke-stage15` 覆盖，已进 verify）
 *
 * 所以这里断言的是「旧区块不再出现」+「导出能力仍在且可用」。
 * 断言「某个东西不存在」看着奇怪，但它是**防回潮**的 ——
 * 将来有人「顺手」把这 6 张卡加回来，这条会红。
 */
const titles = await ev(
  `Array.from(document.querySelectorAll('.section__head h2')).map((x) => x.textContent.trim())`,
);
check(
  '旧进阶卡片已下线（报表页不再出现）',
  ['本期结论', '现金流三分类', '订阅与固定扣款', '支出强度'].every((t) => !titles.includes(t)),
  JSON.stringify(titles),
);
check('报表页由报表模块组成（≥9 块）', titles.length >= 9, `${titles.length} 块`);

/**
 * ⚠️ 导出入口的**位置以当前实现为准**：它在 `.page__hero` 里，与「导入账目」
 * 并列（早先在 `.st-filter__acts` 中，后随报表页改版迁到页头）。
 * 探针写死旧容器 = 元素找不到 → 断言读到 null，紧接着的 `.click()` 还会抛
 * 「Cannot read properties of null」，整份探针在第 3 条就断掉 ——
 * 表现像是页面坏了，其实是探针自己过期了。
 */
const exportBtn = await ev(`(() => {
  const b = document.querySelector('.page__hero [data-role=export]');
  return b ? {
    text: b.textContent.trim(),
    disabled: b.disabled,
    inFilterBar: !!b.closest('.st-filter__bar'),
    besideImport: !!b.parentElement.querySelector('a[href="/import"]'),
  } : null;
})()`);
check(
  '导出报表入口在页头（与「导入账目」并列）',
  Boolean(exportBtn) && exportBtn.disabled === false && exportBtn.text.includes('导出')
    && exportBtn.besideImport === true && exportBtn.inFilterBar === false,
  JSON.stringify(exportBtn),
);

/**
 * 真点一次：确认导出**真的发得出去**，且按钮不会卡在「导出中」。
 * 后者是有意测的 —— 导出是先禁用按钮、再在 finally 里恢复，
 * 任何一步抛出（比如 queryOf 里取了个不存在的字段）都会让按钮永久变灰，
 * 而用户看到的只是「导出点了没反应」。
 */
await ev(`document.querySelector('.page__hero [data-role=export]').click()`);
await new Promise((r) => setTimeout(r, 2200));
check(
  '导出按钮不会卡在「导出中」',
  (await ev(`!document.querySelector('.page__hero [data-role=export]').disabled`)) === true,
);
check('导出过程无控制台报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));

c.shot(await probe.shot('report-after-removal-1440', { dir: OUT, focus: '.st-filter' }));

/* ══════════════ 2. 对账页排期与工具 ══════════════ */
console.log('\n── 2. 对账页排期与工具 ──');
await open('/reconciliations', { wait: '.recon-hist, .card', theme: 'light', arm: auth.arm });
const reconTitles = await ev(
  `Array.from(document.querySelectorAll('.section__head h2')).map((x) => x.textContent.trim())`,
);
check('出现「对账排期」', reconTitles.includes('对账排期'), JSON.stringify(reconTitles));
check('出现「记账完整度」', reconTitles.includes('记账完整度'), '');
check('出现「重复扣费」', reconTitles.includes('重复扣费'), '');
check('出现「缺凭证」', reconTitles.includes('缺凭证'), '');
check('出现「银行自动同步」', reconTitles.includes('银行自动同步'), '');

const badges = await ev(
  `Array.from(document.querySelectorAll('[data-role=schedule] .badge')).map((x) => x.textContent.trim())`,
);
check('「从未对账」单独成档', badges.includes('从未对账'), JSON.stringify(badges.slice(0, 6)));

c.shot(await probe.shot('reconciliations-advanced-1440', { dir: OUT, focus: '[data-role=schedule]' }));

/* ══════════════ 3. 预算页比例法 ══════════════ */
console.log('\n── 3. 预算页比例法 / 历史推荐 ──');
await open('/budgets', { wait: '.bdg__summary', theme: 'light', arm: auth.arm });
await ev(`document.querySelector('[data-action=ratio]').click()`);
await new Promise((r) => setTimeout(r, 1200));
const ratioText = await ev(
  `(document.querySelector('[data-role=plan-slot]') || {}).textContent || ''`,
);
check('比例法面板打开且有内容', String(ratioText).includes('比例法'), String(ratioText).slice(0, 60));
c.shot(await probe.shot('budgets-ratio-1440', { dir: OUT, focus: '[data-role=plan-slot]' }));

await ev(`document.querySelector('[data-action=suggest]').click()`);
await new Promise((r) => setTimeout(r, 1200));
const sugText = await ev(`(document.querySelector('[data-role=plan-slot]') || {}).textContent || ''`);
check('历史推荐面板打开且有内容', String(sugText).includes('历史推荐'), String(sugText).slice(0, 60));
c.shot(await probe.shot('budgets-suggest-1440', { dir: OUT, focus: '[data-role=plan-slot]' }));

/* ══════════════ 4. 暗色与窄屏 ══════════════ */
console.log('\n── 4. 暗色 / 窄屏 ──');
await open('/stats', { wait: '.kpi-card', theme: 'dark', arm: auth.arm });
c.shot(await probe.shot('stats-dark-1440', { dir: OUT, focus: '.kpi-grid' }));

await open('/stats', { wait: '.kpi-card', theme: 'light', width: 390, height: 900, arm: auth.arm });
const ov = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('统计页 390px 无横向溢出', Number(ov) <= 1, `溢出 ${ov}px`);
c.shot(await probe.shot('stats-mobile-390', { dir: OUT, focus: '.kpi-grid' }));

/* ══════════════ 收尾 ══════════════ */
console.log('\n── 收尾 ──');
check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));
const missing = await ev(`document.querySelectorAll('[data-missing-icon]').length`);
check('没有取不到图形的图标', Number(missing) === 0, String(missing));

probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
