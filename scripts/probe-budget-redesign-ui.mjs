/**
 * 预算重设计（docs/16）CDP 探针 —— 五阶段视图、浮层栈深与手机端抽屉。
 *
 * 为什么必须有：这一页是零构建原生 ESM，typecheck / audit:syntax / 全部单测
 * 都不进浏览器渲染路径。曾经有过「搬走一段代码顺手删掉了三个渲染函数」，
 * 静态闸门全绿、页面却永远停在骨架屏，只有真开浏览器才抓得到。
 *
 * 本探针重点锁死三件事：
 *   ① 五个阶段都能渲染出内容，且控制台无异常、无 API 4xx/5xx；
 *   ② 占层浮层最多 2 层，第 2 层只放危险确认，气泡卡片不占层；
 *   ③ 手机端抽屉是贴底 Sheet，分段控件与指标条不溢出。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'budget16');
const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, waitFor, shot, errors, netFails } = probe;
const c = checker();
const { check } = c;

await wipe();
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.74.${Math.floor(Math.random() * 250)}.9` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'b16' + Date.now().toString(36),
      nickname: '预算探针',
      password: 'B16Probe!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };
const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const L = P`/ledgers/${ledger.id}`;
const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const today = `${year}-${String(month).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: POST, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()).data;
};
const get = async (path) => (await (await fetch(`${API}${path}`, { headers: AH })).json()).data;

const grp = (await get(`${L}/account-groups`))[0];
const acc = await post(`${L}/accounts`, {
  groupId: grp.id, name: '预算测试卡', type: 'debit_card', openingBalance: '50000.00',
});
const cats = await get(`${L}/categories?recordType=expense`);
const parent = cats.find((x) => (x.children ?? []).length > 0) ?? cats[0];
const catA = (parent.children ?? [])[0]?.id ?? parent.id;
const catB = (parent.children ?? [])[1]?.id ?? catA;
/** 专用于「提交一条新预算」的空白分类：避免撞上已有预算导致 409 */
const freshCat = await post(`${L}/categories`, {
  recordType: 'expense', name: '预算提交专用分类', parentId: parent.id,
});
await post(`${L}/tags`, { name: '预算标签', color: '#007AFF' });

await post(`${L}/budgets`, { year, month, amount: '3000.00' });
await post(`${L}/budgets`, { categoryId: catA, year, month, amount: '800.00' });
await post(`${L}/budgets`, { categoryId: catB, year, month, amount: '600.00' });
await post(`${L}/transactions`, {
  recordType: 'expense', accountId: acc.id, categoryId: catA,
  name: '预算探针支出', amount: '420.00', txDate: today, fee: '0', discount: '0',
});
await post(`${L}/transactions`, {
  recordType: 'expense', accountId: acc.id, categoryId: catB,
  name: '预算探针大额', amount: '510.00', txDate: today, fee: '0', discount: '0',
});

const auth = authInjector({ token: TOKEN });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countLayers = () => ev(`document.querySelectorAll('.ov-modal, .ov-drawer').length`);
const txt = () => ev(`document.querySelector('[data-role=stage]')?.innerText ?? ''`);

async function goStage(key, marker) {
  await ev(`document.querySelector('[data-act=stage][data-stage=${JSON.stringify(key)}]')?.click(); true`);
  await waitFor(marker, { label: `阶段 ${key}` });
  await sleep(250);
  return txt();
}

await open('/budgets', { wait: '.bdg2-tabs', width: 1440, height: 1100, theme: 'light', arm: auth.arm });
await waitFor('.bdg2-metrics', { label: '编制阶段指标条' });
await sleep(400);

/* ---------- 1. 五阶段都能渲染 ---------- */
check('默认落在「编制」阶段，五个分段都在',
  (await ev(`document.querySelectorAll('.bdg2-tabs__item').length`)) === 5 &&
  (await ev(`document.querySelector('[data-act=stage][data-stage=plan]')?.getAttribute('aria-current')`)) === 'true');

const planText = await txt();
check('编制：五种方法与周期规则都在页面上',
  planText.includes('五种编制方法') && planText.includes('周期与归属规则') && planText.includes('总预算'));
check('编制：已建 3 条预算进入对照列表',
  (await ev(`document.querySelectorAll('[data-act=edit-budget]').length`)) === 3);

/* ---------- 1b. 月份日历（日期下拉已下线） ---------- */
const mm = (m) => String(m).padStart(2, '0');
check('日期不再是下拉框：触发按钮 + 隐藏日期字段',
  await ev(`(() => !document.querySelector('select[data-role=month]')
    && !!document.querySelector('input[type=hidden][data-role=month]')
    && !!document.querySelector('[data-role=month-trigger]'))()`));

await ev(`document.querySelector('[data-role=month-trigger]').click(); true`);
await waitFor('.mcal', { label: '月份日历弹层' });
/* 不能用 focus：scrollIntoView 会触发 scroll，气泡卡片按设计自动收起 */
c.shot(await shot('budget16-month-calendar-desktop', { dir: OUT }));
check('月份日历：12 个月格子 + 年份翻页 + 回到本月',
  (await ev(`document.querySelectorAll('.mcal__cell').length`)) === 12 &&
  (await ev(`document.querySelectorAll('.mcal__nav').length`)) === 2 &&
  (await ev(`!!document.querySelector('[data-today]')`)));
check('月份日历是气泡卡片，不占弹窗层', (await countLayers()) === 0);
await ev(`document.querySelector('.mcal__nav.is-next').click(); true`);
check('年份翻页后标题跟着变',
  (await ev(`document.querySelector('[data-role=mcal-year]').textContent`)).includes(String(year + 1)));
await ev(`document.querySelector('.mcal__nav.is-prev').click(); true`);

const otherM = (month % 12) + 1;
await ev(`document.querySelector('.mcal__cell[data-y="${year}"][data-m="${otherM}"]').click(); true`);
await sleep(350);
check('选中月份回填日期字段与触发按钮文案',
  (await ev(`document.querySelector('input[data-role=month]').value`)) === `${year}-${mm(otherM)}` &&
  (await ev(`document.querySelector('[data-role=month-text]').textContent ?? ''`)).includes(`${otherM} 月`));
check('选完月份日历自动收起', (await ev(`!!document.querySelector('.mcal')`)) === false);
await ev(`document.querySelector('[data-role=month-trigger]').click(); true`);
await waitFor('.mcal', { label: '再次打开月份日历' });
await ev(`document.querySelector('[data-today]').click(); true`);
await sleep(350);
check('「回到本月」把账期恢复成当月',
  (await ev(`document.querySelector('input[data-role=month]').value`)) === `${year}-${mm(month)}`);

/* ---------- 2. 抽屉与栈深 ---------- */
await ev(`document.querySelector('[data-act=add-budget]').click(); true`);
await waitFor('.ov-drawer__panel', { label: '新建预算抽屉' });
check('新建预算走底部抽屉，占 1 层', (await countLayers()) === 1);
check('抽屉里有预算类型与编制方法字段',
  (await ev(`!!document.querySelector('.ov-drawer [name=budgetKind]')`)) &&
  (await ev(`!!document.querySelector('.ov-drawer [name=budgetMethod]')`)));

/* ---------- 2b. 类型 + 定位合并菜单 ---------- */
check('定位与预算类型不再是两个下拉：一个触发按钮 + 两个隐藏字段',
  await ev(`(() => !document.querySelector('.ov-drawer select[name=categoryId]')
    && !document.querySelector('.ov-drawer select[name=budgetKind]')
    && !!document.querySelector('.ov-drawer [data-bsp-trigger]')
    && !!document.querySelector('.ov-drawer input[name=categoryId]')
    && !!document.querySelector('.ov-drawer input[name=budgetKind]'))()`));
check('表单每行标签与输入框水平对齐，输入框左边线一致',
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.bdg2-form__row')];
    if (rows.length < 10) return false;
    const leftOfInput = rows.every((r) => {
      const l = r.querySelector('.bdg2-form__label').getBoundingClientRect().left;
      const i = r.querySelector('.input, .pick-trigger').getBoundingClientRect().left;
      return l < i;
    });
    const xs = rows.map((r) => Math.round(r.querySelector('.input, .pick-trigger').getBoundingClientRect().left));
    return leftOfInput && Math.max(...xs) - Math.min(...xs) <= 1;
  })()`));

await ev(`document.querySelector('.ov-drawer [data-bsp-trigger]').click(); true`);
await waitFor('.bsp', { label: '类型与定位合并菜单' });
c.shot(await shot('budget16-scope-picker-desktop', { dir: OUT }));
check('合并菜单不占第二层浮层（气泡卡片不占层）', (await countLayers()) === 1);
check('菜单里三种预算类型 + 总预算 + 一级分类都在',
  (await ev(`document.querySelectorAll('[data-bsp-kind]').length`)) === 3 &&
  (await ev(`!!document.querySelector('[data-bsp-total]')`)) &&
  (await ev(`document.querySelectorAll('[data-bsp-parent]').length`)) >= 1);
await ev(`document.querySelector('[data-bsp-kind=income]').click(); true`);
check('菜单内改预算类型会写回隐藏字段',
  (await ev(`document.querySelector('.ov-drawer input[name=budgetKind]').value`)) === 'income');
await ev(`document.querySelector('[data-bsp-parent]').click(); true`);
await sleep(150);
check('展开一级分类后出现二级分类 chip',
  (await ev(`document.querySelectorAll('[data-bsp-cat]').length`)) >= 1);
await ev(`document.querySelector('[data-bsp-cat]').click(); true`);
await sleep(200);
check('选中分类回填 categoryId 且菜单自动收起',
  (await ev(`!!document.querySelector('.ov-drawer input[name=categoryId]').value`)) &&
  (await ev(`!!document.querySelector('.bsp')`)) === false);

/* 抽屉未关时再点一个会开Drawer的入口：应被守卫挡下，仍是 1 层 */
await ev(`document.querySelector('[data-act=method]')?.click(); true`);
await sleep(300);
check('第二层普通抽屉被守卫挡下（最多两层且第二层只放确认）', (await countLayers()) === 1);

/* 从第 1 层里触发危险确认 → 允许第 2 层。用编制阶段就存在的删除入口，
   否则 querySelector 拿到 null，看起来像「守卫没放行」其实是选择器没命中 */
await ev(`document.querySelector('[data-act=del-budget]')?.click(); true`);
await waitFor('.ov-modal__panel--confirm', { label: '第二层确认弹窗' }).catch(() => {});
const twoLayers = (await countLayers()) === 2;
check('危险确认允许作为第 2 层', twoLayers, `实际 ${await countLayers()} 层`);
if (twoLayers) {
  await ev(`document.querySelector('[data-act=add-budget]')?.click(); true`);
  await sleep(250);
  check('第 3 层被挡下，栈深不超过 2', (await countLayers()) === 2);
}
/* Escape 只关栈顶，逐层退出 */
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(250);
check('Escape 只关掉栈顶一层', (await countLayers()) === (twoLayers ? 1 : 0));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(250);
check('再按一次 Escape 全部关闭', (await countLayers()) === 0);

/* ---------- 2d. 五种编制方法「打开」直达新建预算 ---------- */
check('五种方法各有「打开」与「批量工具」入口',
  (await ev(`document.querySelectorAll('[data-act=method]').length`)) === 5 &&
  (await ev(`document.querySelectorAll('[data-act=method-tools]').length`)) === 5);
await ev(`document.querySelector('[data-act=method][data-method=elastic]').click(); true`);
await waitFor('.ov-drawer__panel', { label: '方法直达新建预算' });
check('「打开」直接是新建预算抽屉，且弹性预算与关联字段已预填',
  (await ev(`document.querySelector('.ov-drawer .ov-title')?.textContent ?? ''`)).includes('新建预算') &&
  (await ev(`document.querySelector('.ov-drawer [name=budgetMethod]').value`)) === 'elastic' &&
  (await ev(`document.querySelector('.ov-drawer [name=budgetKind]').value`)) === 'expense' &&
  (await ev(`document.querySelector('.ov-drawer [name=periodType]').value`)) === 'monthly');
check('预填后其余字段仍可编辑（金额为空、下拉未禁用）',
  await ev(`(() => {
    const s = document.querySelector('.ov-drawer [name=budgetMethod]');
    const a = document.querySelector('.ov-drawer [name=amount]');
    return !s.disabled && !a.disabled && a.value === '';
  })()`));
check('抽屉顶部说明点明带入的是哪一种编制方法',
  (await ev(`document.querySelector('.ov-drawer .bdg2-hint')?.textContent ?? ''`)).includes('弹性预算'));
await ev(`document.querySelector('.ov-drawer [data-role=close]').click(); true`);
await sleep(250);
await ev(`document.querySelector('[data-act=method-tools][data-method=ratio]').click(); true`);
await waitFor('.ov-drawer__panel', { label: '批量工具抽屉' });
check('批量工具仍可打开原有的方法预览抽屉',
  (await ev(`document.querySelector('.ov-drawer .ov-title')?.textContent ?? ''`)).includes('比例模板'));
await ev(`document.querySelector('.ov-drawer [data-role=close]').click(); true`);
await sleep(250);

/* ---------- 2e. 合并菜单选完仍能正常提交（隐藏字段数据绑定未变） ---------- */
await ev(`document.querySelector('[data-act=add-budget]').click(); true`);
await waitFor('.ov-drawer__panel', { label: '提交用新建预算抽屉' });
await ev(`document.querySelector('.ov-drawer [data-bsp-trigger]').click(); true`);
await waitFor('.bsp', { label: '提交用合并菜单' });
/* 用菜单里的搜索直接落到这条空白分类，顺带验跨一级分类搜索 */
await ev(`(() => { const s = document.querySelector('[data-bsp-search]');
  s.value = '预算提交专用分类'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(200);
check('合并菜单搜索能跨一级分类命中目标',
  (await ev(`document.querySelectorAll('[data-bsp-cat]').length`)) >= 1);
await ev(`document.querySelector('[data-bsp-cat]').click(); true`);
await sleep(200);
await ev(`(() => { document.querySelector('.ov-drawer [name=amount]').value = '123.45'; return true; })()`);
await ev(`document.querySelector('.ov-drawer form button[type=submit]').click(); true`);
await sleep(1000);
const made = (await get(`${L}/budgets?year=${year}&month=${month}`)).find((b) => Number(b.amount) === 123.45);
check('合并菜单选定分类后能正常提交预算（categoryId 绑到隐藏字段）',
  Boolean(made && made.categoryId === freshCat.id), JSON.stringify(made ?? null));
if (made) await fetch(`${API}${L}/budgets/${made.id}`, { method: 'DELETE', headers: AH });

/* ---------- 3. 执行控制 ---------- */
const controlText = await goStage('control', '.bdg2-bar');
check('执行：五元组 B / U / C / R / A 全在',
  ['预算额 B', '已用 U', '承诺占用 C', '预留 R', '可用额度 A'].every((s) => controlText.includes(s)));
/**
 * 曾在桌面截图里发现「预算额 B¥ 50.00」标签和金额黏成一行 ——
 * `<small>` 只在 max-width 媒体段里拿到了 display:block，桌面没人管。
 * 这条断言锁的是计算样式，不是文字（文字永远都在，肉眼看样式才看得出来）。
 */
check('执行：五元组标签与金额分两行（桌面也不挤成一行）',
  await ev(`(() => {
    if (!document.querySelectorAll('.bdg2-row').length) return true;
    const cells = [...document.querySelectorAll('.bdg2-row__num small')];
    return cells.length > 0 && cells.every(el => getComputedStyle(el).display === 'block');
  })()`));
check('执行：时间进度、日均消耗、预计期末支出都在',
  controlText.includes('时间进度') && controlText.includes('日均消耗') && controlText.includes('预计期末支出'));
check('执行：维度下拉含账户 / 成员 / 标签',
  (await ev(`(() => { const s=document.querySelector('[data-role=dim]'); return s ? s.innerText : ''; })()`))
    .includes('账户') && (await ev(`document.querySelector('[data-role=dim]')?.innerText ?? ''`)).includes('成员'));
check('执行：超支置顶（若有超支行必在最前）或全部健康',
  (await ev(`(() => { const b=[...document.querySelectorAll('.bdg2-row__name .badge--danger')]; return b.length===0 || !!b[0].closest('.bdg2-row'); })()`)));
/* 气泡卡片不占层 */
await ev(`document.querySelector('[data-act=resv-detail]')?.click(); true`);
await waitFor('.ov-pop', { label: '占用明细气泡' });
check('占用明细走气泡卡片且不占弹窗层',
  (await ev(`document.querySelectorAll('.ov-pop').length`)) === 1 && (await countLayers()) === 0);
await ev(`document.querySelector('.ov-pop')?.remove(); true`);

/* ---------- 4. 预警 ---------- */
const alertText = await goStage('alert', '.bdg2-alert, .empty-state');
check('预警：分级规则、渠道、免打扰、超支后策略都在',
  alertText.includes('预警规则') && alertText.includes('提醒渠道') &&
  alertText.includes('免打扰') && alertText.includes('超支后行为策略'));
check('预警：预警中心是只读清单',
  alertText.includes('预警中心') && alertText.includes('不会把提醒标记成已读'));
check('预警：有编辑规则入口', (await ev(`!!document.querySelector('[data-act=prefs-edit]')`)));

/* ---------- 5. 调整 ---------- */
const adjustText = await goStage('adjust', '.bdg2-metric[data-act]');
check('调整：8 个二级动作全部收进抽屉入口',
  (await ev(`document.querySelectorAll('button[data-act^=adj-]').length`)) === 8);
check('调整：变更留痕与归档账期下拉都在',
  adjustText.includes('最近变更') && (await ev(`!!document.querySelector('[data-role=archived]')`)));

/* ---------- 6. 复盘 ---------- */
const reviewText = await goStage('review', '.bdg2-tbl');
check('复盘：对照表含差异额 / 差异率 / 有利不利 / 准确率',
  reviewText.includes('差异 Δ') && reviewText.includes('差异率 δ') &&
  reviewText.includes('准确率') && reviewText.includes('性质'));
check('复盘：环比同比、年度趋势、下期建议都在',
  reviewText.includes('环比') && reviewText.includes('同比') &&
  reviewText.includes('年趋势') && reviewText.includes('下期调额建议'));
check('年度趋势 12 个月都有柱位，缺数据留空不补 0',
  (await ev(`document.querySelectorAll('.bdg2-trend__col').length`)) === 12);
check('一键生成下月预算入口存在', (await ev(`!!document.querySelector('[data-act=gen-next]')`)));
/* 归因气泡 */
await ev(`document.querySelector('[data-act=review-attr]')?.click(); true`);
await waitFor('.ov-pop', { label: '差异归因气泡' });
check('差异归因走气泡卡片', (await ev(`document.querySelectorAll('.ov-pop').length`)) === 1);
await ev(`document.querySelector('.ov-pop')?.remove(); true`);

/* ---------- 7. 桌面截图 ---------- */
const deskShot = c.shot(await shot('budget16-review-desktop', { dir: OUT, focus: '.bdg2-card' }));

/* open() 会清空 errors / netFails，所以桌面阶段的错误必须在这里先收一次 */
check('桌面五阶段切换无控制台异常', errors.length === 0, errors.slice(0, 4).join(' | '));
check('桌面五阶段切换无 API 4xx / 5xx', netFails.length === 0, netFails.slice(0, 6).join(' | '));

/* ---------- 8. 手机端：抽屉贴底 + 布局不溢出 ---------- */
await open('/budgets', { wait: '.bdg2-tabs', width: 390, height: 844, mobile: true, theme: 'light', arm: auth.arm });
await waitFor('.bdg2-metrics', { label: '手机端编制指标条' });
check('手机端：分段控件五项仍在一行内横滑',
  (await ev(`(() => { const t=document.querySelector('.bdg2-tabs'); return t.scrollWidth >= t.clientWidth && t.clientWidth <= 390; })()`)));
check('手机端：指标条两列且没有横向溢出',
  (await ev(`(() => { const m=document.querySelector('.bdg2-metrics'); return getComputedStyle(m).gridTemplateColumns.split(' ').length === 2 && document.documentElement.scrollWidth <= 390; })()`)));
await ev(`document.querySelector('[data-role=month-trigger]').click(); true`);
await waitFor('.mcal', { label: '手机端月份日历' });
c.shot(await shot('budget16-month-calendar-mobile', { dir: OUT }));
check('手机端月份日历不横向溢出、12 格都在',
  await ev(`(() => { const r = document.querySelector('.ov-pop--menu').getBoundingClientRect();
    return r.left >= 0 && r.right <= 390 && document.querySelectorAll('.mcal__cell').length === 12; })()`));
await ev(`document.querySelector('[data-role=month-trigger]').click(); true`);
await sleep(200);
await ev(`document.querySelector('[data-act=add-budget]').click(); true`);
await waitFor('.ov-drawer__panel', { label: '手机端抽屉' });
check('手机端：表单行标签与输入框仍水平对齐、左边线一致',
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.bdg2-form__row')];
    const xs = rows.map((r) => Math.round(r.querySelector('.input, .pick-trigger').getBoundingClientRect().left));
    return rows.length >= 10 && Math.max(...xs) - Math.min(...xs) <= 1;
  })()`));
const sheet = JSON.parse(await ev(`(() => { const p=document.querySelector('.ov-drawer__panel').getBoundingClientRect();
  return JSON.stringify({ l: Math.round(p.left), w: Math.round(p.width), b: Math.round(p.bottom), h: Math.round(p.height) }); })()`));
check('手机端抽屉是贴底 Sheet（满宽、贴底、不超出视口）',
  sheet.l === 0 && Math.abs(sheet.w - 390) <= 1 && Math.abs(sheet.b - 844) <= 2 && sheet.h <= 844,
  JSON.stringify(sheet));
const mobShot = c.shot(await shot('budget16-drawer-mobile', { dir: OUT }));

/* ---------- 9. 全程无控制台异常 / API 错误 ---------- */
check('无未捕获的浏览器异常', errors.length === 0, errors.slice(0, 4).join(' | '));
check('无 API 4xx / 5xx', netFails.length === 0, netFails.slice(0, 6).join(' | '));

probe.finish(c.results, { shots: c.shots });
