/**
 * 手机端截图（390 × 844）
 *
 * 用途：只看「手机长什么样」。它不断言业务口径（那是各探针的事），
 * 只负责把五个 Tab 页在真实数据下拍出来，改样式前后各跑一次对比。
 *
 * 用法：
 *   node scripts/shot-mobile.mjs            # 亮色
 *   node scripts/shot-mobile.mjs dark       # 暗色
 *   node scripts/shot-mobile.mjs light out2 # 指定子目录
 *
 * 种子用户缓存在系统临时目录，避免每次注册（注册限流 3 次/小时）。
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { P } from './lib/url.mjs';
import { connect } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const THEME = process.argv[2] === 'dark' ? 'dark' : 'light';
const SUBDIR = process.argv[3] ?? 'mobile';
const OUT = join(process.cwd(), 'screenshots', SUBDIR);
const SEED = join(tmpdir(), 'cc-mobile-seed.json');

const W = 390;
const H = 844;

const H0 = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.88.${Math.floor(Math.random() * 250)}.9` };
const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ds(d);
};

async function seed() {
  if (existsSync(SEED)) {
    try {
      const s = JSON.parse(readFileSync(SEED, 'utf8'));
      const me = await (await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${s.token}` } })).json();
      if (me?.data?.id) return s;
    } catch {
      /* 缓存失效，重新注册 */
    }
  }
  const reg = await (
    await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: H0,
      body: JSON.stringify({
        username: 'mob' + Date.now().toString(36),
        nickname: '手机预览',
        password: 'MobileShot123!2026',
        platform: 'web',
      }),
    })
  ).json();
  const token = reg.data.accessToken;
  const AH = { Authorization: `Bearer ${token}` };
  const POST = { ...AH, ...H0 };
  const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
  const groups = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json())
    .data;

  async function mkAccount(name, type, opening, groupHint) {
    const grp = groups.find((g) => g.id.includes(groupHint)) ?? groups[0];
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

  const bank = await mkAccount('招商银行储蓄卡', 'debit_card', '26000.00', 'bank');
  const cash = await mkAccount('现金钱包', 'cash', '600.00', 'cash');
  const card = await mkAccount('招行信用卡', 'credit_card', '-1860.40', 'credit');

  async function pickCat(rt) {
    const cats = (
      await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories?recordType=${rt}`}`, { headers: AH })).json()
    ).data;
    const leaves = [];
    for (const p of cats) for (const ch of p.children ?? []) leaves.push(ch);
    return leaves;
  }
  const expCats = await pickCat('expense');
  const incCats = await pickCat('income');

  async function mkTx(payload) {
    const r = await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) console.log('  建账失败：', r.status, JSON.stringify(j).slice(0, 200));
    return j.data;
  }

  // 12 天流水：吃 / 交通 / 购物 / 居家 + 一笔工资
  const plan = [
    [0, 'expense', '早餐', '12.50', 0],
    [0, 'expense', '地铁通勤', '6.00', 1],
    [1, 'expense', '午餐外卖', '28.80', 0],
    [1, 'expense', '咖啡', '19.00', 0],
    [2, 'expense', '超市采购', '236.40', 2],
    [3, 'expense', '打车', '37.60', 1],
    [4, 'expense', '电影票', '78.00', 3],
    [5, 'expense', '话费充值', '50.00', 4],
    [6, 'income', '项目奖金', '1200.00', 0],
    [7, 'expense', '健身房月卡', '299.00', 3],
    [8, 'expense', '水果', '46.20', 2],
    [9, 'expense', '停车费', '15.00', 1],
    [10, 'expense', '网购图书', '128.00', 2],
    [11, 'income', '工资', '12800.00', 0],
  ];
  for (const [ago, rt, name, amount, ci] of plan) {
    const cat = rt === 'expense' ? expCats[ci % Math.max(expCats.length, 1)] : incCats[ci % Math.max(incCats.length, 1)];
    await mkTx({
      recordType: rt,
      accountId: rt === 'income' ? bank.id : ci % 3 === 0 ? card.id : ci % 3 === 1 ? cash.id : bank.id,
      categoryId: cat?.id ?? null,
      name,
      amount,
      txDate: dayAgo(ago),
      txTime: '12:20:00',
      merchant: rt === 'expense' ? name.slice(0, 6) : null,
    });
  }

  const s = { token, ledgerId: ledger.id, accounts: { bank: bank.id, cash: cash.id, card: card.id } };
  writeFileSync(SEED, JSON.stringify(s, null, 2));
  return s;
}

const s = await seed();
console.log(`种子就绪：账本 ${s.ledgerId}`);

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, shot } = probe;

await wipe();
/** `arm` 必须由 authInjector 提供：它自己会先落到同源静态页再注入，
 *  在 about:blank 上写 localStorage 会直接抛 SecurityError。 */
const auth = authInjector({ token: s.token });

/** [文件名, 路径, 等待选择器, 第二张：滚到哪个区域再拍] */
const PAGES = [
  ['accounts', '/accounts', '.page__hero', '.acct-row'],
  ['transactions', '/transactions', '.page__hero', '.tx-day'],
  ['compose', '/transactions/new', '.compose__card', '.action-bar'],
  ['stats', '/stats', '.page__hero', '.st-grid'],
  ['settings', '/settings', '.page__hero', '.section'],
];

for (const [name, path, wait, focus] of PAGES) {
  await open(path, { wait, width: W, height: H, mobile: true, theme: THEME, arm: auth.arm });
  const p = await shot(`${THEME}-${name}`, { dir: OUT });
  console.log('  →', p);
  if (focus) {
    const p2 = await shot(`${THEME}-${name}-2`, { dir: OUT, focus });
    console.log('  →', p2);
  }
}

// TabBar 特写（滚到底部拍一条）
await open('/transactions', { wait: '.tabbar', width: W, height: H, mobile: true, theme: THEME, arm: auth.arm });
await ev(`window.scrollTo(0, document.body.scrollHeight); true`);
await new Promise((r) => setTimeout(r, 600));
console.log('  →', await shot(`${THEME}-tabbar`, { dir: OUT }));

probe.close();
console.log('\n输出目录：', OUT);
