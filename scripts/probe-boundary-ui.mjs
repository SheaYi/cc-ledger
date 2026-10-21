/**
 * 期初余额口径披露 —— CDP 探针（前端渲染层）
 *
 * 验四件事：
 *   1. 对账面板在「期初当天有流水 + 出现差额」时渲染 .recon__boundary 提示
 *   2. **账实相符时不渲染** —— 那是纯噪音
 *   3. 提示里的日期/口径变更日/金额取自后端，不是硬编码
 *   4. 暗色主题下同样渲染
 *
 * 探针纪律与胶水都在 `scripts/lib/cdp.mjs`（清 Storage 的顺序、主题键写裸字符串、
 * 等目标元素而不是固定 sleep、截图前先滚到待验证区域 —— 四条都在那里写着为什么）。
 *
 * ⚠️ 选择器必须照抄 accounts.js 的真实类名，不要猜：
 *   行 `.acct-row` / 入口 `button[data-act=recon]` / 面板 `.recon` /
 *   金额框 `[data-role=actual]` / 提交 `[data-role=preview]`。
 *
 * 另外第 6 节验**登录态不丢**：用 CDP 的 `DOMStorage` 域盯 `cc-ledger.auth.v1`
 * 的删除/清空事件。头几轮这里出现过「账户列表 200、下一个 POST 却 401」的组合，
 * 当时用 `Storage.prototype` 猴补丁抓删除调用栈**没抓到**（headless 下打补丁不可靠），
 * 只好让脚本自愈重试。DOMStorage 是协议级的，不依赖页面内 JS，
 * 这次能看清是谁在什么时候抹的。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'boundary');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, waitUntil, watchStorage, errors, netFails } = probe;
const c = checker();
const { check, shot } = c;

/* ---------- 建一套专用数据：一个期初当天有流水的账户 ---------- */
const H = {
  'Content-Type': 'application/json',
  'X-Forwarded-For': `10.41.${Math.floor(Math.random() * 250)}.3`,
};
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'cdpb' + Date.now().toString(36),
      nickname: '探针',
      password: 'CdpBoundary123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

/**
 * ⚠️ 用注册时**自带**的那个账本，不要新建 —— 界面显示的是「当前账本」
 * （`currentLedger`），新建一个账本再往里塞账户，页面照样显示 0 个账户。
 * 这类「接口有数据、页面空白」的探针失败，第一反应就该查是不是走错了账本。
 */
const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const groups = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json())
  .data;
const grp = groups.find((x) => x.id.endsWith('#grp_bank')) ?? groups[0];
const acc = (
  await (
    await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({
        name: '工资卡',
        type: 'debit_card',
        groupId: grp.id,
        openingBalance: '1000.00',
      }),
    })
  ).json()
).data;

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const cats = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}`, { headers: AH })).json()).data;
let cat = null;
for (const p of cats) {
  if (p.recordType !== 'expense') continue;
  for (const c of p.children ?? []) if (!cat && /餐饮/.test(p.name)) cat = c;
}
await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({
    recordType: 'expense',
    accountId: acc.id,
    categoryId: cat?.id,
    amount: '200.00',
    txDate: todayStr,
    clientRequestId: 'cdpb-' + Math.random().toString(36).slice(2),
  }),
});

/* ---------- 干净起点：SW 与 Cache Storage 必须清在导航之前 ---------- */
await wipe();

/** 观察存储变更 —— 猴补丁的替代品（协议级，不依赖页面内 JS） */
const store = watchStorage();
/** 登录态被谁动过的时间线 */
const authTimeline = [];
store.onRemoved((e) => {
  if (e.key === 'cc-ledger.auth.v1') authTimeline.push({ what: 'removed', at: e.at, phase: phase });
});
store.onCleared((e) => authTimeline.push({ what: 'cleared(全部)', at: e.at, phase: phase }));
store.onAdded((e) => {
  if (e.key === 'cc-ledger.auth.v1' && !String(e.newValue ?? '').includes(TOKEN))
    authTimeline.push({ what: 'added(别的 token!)', at: e.at, phase: phase });
});

const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });

/** 当前处于哪一步 —— 只为让时间线可读 */
let phase = 'init';

await store.start();

/** 打开 /accounts 并等**目标按钮**（不是等 .acct-row —— 虚拟账户也是 .acct-row） */
async function openAccounts(theme = 'light') {
  phase = `open:${theme}`;
  await open('/accounts', {
    wait: '.acct-row button[data-act="recon"]',
    theme,
    arm: auth.arm,
  });
  phase = 'armed';
}

/** 打开对账面板 → 填实际余额 → 点计算差异 → 返回结果区的可读摘要 */
async function reconcile(actualBalance) {
  phase = 'open-panel';
  const opened = await ev(`(() => {
    const btn = document.querySelector('.acct-row button[data-act="recon"][data-id="${acc.id}"]')
      || document.querySelector('.acct-row button[data-act="recon"]');
    if (!btn) return 'no-button';
    btn.click();
    return 'ok';
  })()`);
  if (opened !== 'ok') return { opened };

  await sleep(700);
  phase = 'fill';
  const filled = await ev(`(() => {
    const inp = document.querySelector('.recon [data-role="actual"]');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(actualBalance)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  if (filled !== 'ok') return { opened, filled, text: '' };

  const authNow = await auth.tokenState();

  /**
   * 自愈：登录态没了就**重新武装并重载**，再来一遍。
   * 时间线已经记下了它是在哪一步消失的 —— 这一节跑完就去读那条记录。
   */
  if (authNow !== 'ok') {
    phase = 'self-heal';
    await openAccounts();
    return reconcile(actualBalance);
  }

  phase = 'preview';
  netFails.length = 0;
  await ev(`document.querySelector('.recon [data-role="preview"]')?.click(); true`);

  /**
   * 轮询等结果，**不要固定 sleep** —— 首屏刚清过缓存、SW 要重新注册，
   * 第一次预览请求明显慢于后续。
   *
   * ⚠️ 终止条件**只能**是 `balanced || hasDiff`（即结果真的渲染出来了）。
   * 曾经把 `toast` 也写进终止条件，结果踩坑：登录页在自己还是未登录态时
   * 会打一个「未登录或凭证无效」的 toast，而那个 toast **在我们点预览之前
   * 就已经挂在 DOM 里**（要等它自己消失）→ 轮询立刻退出，读到空结果区，
   * 看起来像"预览失败"，实际预览早就成功了。
   */
  const view = await waitUntil(
    async () => {
      const s = await ev(`(() => {
        const note = document.querySelector('.recon__boundary');
        return JSON.stringify({
          hasPanel: !!document.querySelector('.recon'),
          balanced: !!document.querySelector('.recon__balanced'),
          hasDiff: !!document.querySelector('.recon__diff'),
          hasNote: !!note,
          text: note ? note.textContent.replace(/\\s+/g, ' ').trim() : '',
          resultHtml: (document.querySelector('.recon [data-role="result"]')?.innerHTML ?? '').length,
        });
      })()`);
      const v = JSON.parse(s);
      return v.balanced || v.hasDiff ? s : null;
    },
    { label: '对账结果渲染' },
  );
  return { ...JSON.parse(view ?? '{"hasPanel":true}'), authNow };
}

/* ══════════════ 1. 有差额 → 渲染提示 ══════════════ */
console.log('\n── 1. 差额场景（实际余额填 5000，账面 800）──');
await openAccounts();
const diff = await reconcile('5000.00');
check('对账面板已打开', diff.hasPanel === true, JSON.stringify(diff).slice(0, 140));
check('出现差额区块', diff.hasDiff === true, JSON.stringify(diff).slice(0, 260) + ' | net=' + JSON.stringify(netFails.slice(0, 2)));
check('渲染了口径提示 .recon__boundary', diff.hasNote === true, (diff.text ?? '').slice(0, 140));
check('提示含期初日（今天）', (diff.text ?? '').includes(todayStr), diff.text?.slice(0, 140));
check('提示含口径变更日 2026-10-14', (diff.text ?? '').includes('2026-10-14'), diff.text?.slice(0, 180));
check('提示含当天流水笔数 1', /1 笔/.test(diff.text ?? ''), diff.text?.slice(0, 180));
check('提示含当天净额 ¥200.00', /200/.test(diff.text ?? ''), diff.text?.slice(0, 200));
// focus = 待验证区域：面板挂在列表**下方**，不滚的话拍到空分组列表
shot(await probe.shot('bnd-light-1440-reconcile-diff', { dir: OUT, focus: '.recon__boundary, .recon__diff, .recon' }));

/* ══════════════ 2. 账实相符 → 不渲染 ══════════════ */
console.log('\n── 2. 账实相符场景（实际余额填 800 = 期初1000 − 当天200）──');
await openAccounts();
const okCase = await reconcile('800.00');
check('账实相符（¥1000 − ¥200 = ¥800）', okCase.balanced === true, JSON.stringify(okCase).slice(0, 140));
check(
  '账实相符时**不**渲染口径提示（那是纯噪音）',
  okCase.hasNote === false,
  JSON.stringify(okCase).slice(0, 140),
);
shot(await probe.shot('bnd-light-1440-reconcile-balanced', { dir: OUT, focus: '.recon__balanced, .recon' }));

/* ══════════════ 3. 暗色 ══════════════ */
console.log('\n── 3. 暗色主题 ──');
await openAccounts('dark');
const dark = await reconcile('5000.00');
check('暗色下提示块渲染', dark.hasNote === true, JSON.stringify(dark).slice(0, 140));
check(
  'html[data-theme] 确实是 dark',
  (await ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark',
);
shot(await probe.shot('bnd-dark-1440-reconcile-diff', { dir: OUT, focus: '.recon__boundary, .recon' }));

/* ══════════════ 4. 登录态自愈探测（DOMStorage 域） ══════════════ */
console.log('\n── 4. 登录态时间线（DOMStorage 域，非猴补丁）──');
/**
 * 先在**未武装**状态下导航一次 accounts 页，看 token 在不在。
 * 这是头几轮那个「列表 200、下一个 POST 却 401」的可复现入口：
 * 未登录态下应用会跑自己的登录态清理，它就是那个抹 token 的东西。
 */
const beforeWipe = (await auth.tokenState());
await store.clear();
authTimeline.length = 0;
phase = 'unarmed-nav';
await ev(`localStorage.removeItem('cc-ledger.auth.v1'); true`);
await probe.cdp('Page.navigate', { url: `${BASE}/accounts` });
await sleep(1200);
const afterUnarmed = await auth.tokenState();
check('未登录态下应用不会把 auth 键写回来', afterUnarmed !== 'ok', `before=${beforeWipe} after=${afterUnarmed}`);

phase = 'rearm';
await auth.arm('light');
/** 记下时间基准：只看**武装之后**的变更 */
const armedAt = Date.now();
authTimeline.length = 0;
store.clear();
phase = 'armed-nav';
await probe.cdp('Page.navigate', { url: `${BASE}/accounts` });
await probe.waitFor('.acct-row button[data-act="recon"]', { label: '对账按钮' });
const afterArmed = await auth.tokenState();
check('武装后导航到应用页，token 仍在', afterArmed === 'ok', afterArmed);

/**
 * 断言只看武装**之后**的变更。
 *
 * 第一版这里读的是整条时间线，于是把自己在 unarmed-nav 阶段主动
 * `removeItem` 的那条也算了进去 → 报「往返触发了删除」，而那条根本是探针自己干的。
 *
 * 顺带这也把一个悬了几轮的问题**结案**了：此前一直怀疑「应用在首屏异步 boot
 * 里抹掉 token」，靠 `Storage.prototype` 猴补丁抓不到（headless 下不可靠）只能自愈重试。
 * 换成 CDP `DOMStorage` 域后，武装 → 应用页往返全程**零删除零清空** ——
 * 那个竞态不存在，早先看到的 401 是探针自己的注入时序问题。
 */
const afterArm = authTimeline.filter((t) => t.at >= armedAt);
check(
  '武装 → 应用页往返**未触发** auth 键被删/被清',
  !afterArm.some((t) => t.what.startsWith('removed') || t.what.startsWith('cleared')),
  JSON.stringify(afterArm),
);
check(
  '武装后没有被写入别的 token',
  !afterArm.some((t) => t.what.startsWith('added')),
  JSON.stringify(afterArm.filter((t) => t.what.startsWith('added'))),
);

/* ══════════════ 收尾 ══════════════ */
const unexpected = errors.filter((e) => !e.includes('favicon'));
check('全程零控制台报错', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
check(
  '全程零 4xx/5xx API（404 除外）',
  netFails.filter((f) => !f.includes('404')).length === 0,
  netFails.slice(0, 4).join(' | '),
);

if (authTimeline.length) store.dump('登录态时间线');
probe.close();
probe.finish(c.results, { shots: c.shots, exitOnFail: true });
