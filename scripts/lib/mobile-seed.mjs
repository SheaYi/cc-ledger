/**
 * 手机端脚本用的种子用户（390×844 实拍 / 断言共用）。
 *
 * 注册限流 3 次/小时，所以种子缓存在系统临时目录，跨脚本复用。
 * 造的是**当前账本**里的真实数据 —— 探针若用另一个用户，页面会全空
 * （`authInjector` 只塞 token，改不了 `current_ledger`）。
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { P } from './url.mjs';

const API = 'http://127.0.0.1:3000/api/v1';
/** 伪造出口 IP：注册限流按 IP 计，本机所有请求都落在 127.0.0.1 上 */
const H0 = {
  'Content-Type': 'application/json',
  'X-Forwarded-For': `10.88.${Math.floor(Math.random() * 250)}.9`,
};

const pad = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ds(d);
};

export const SEED_FILE = join(tmpdir(), 'cc-mobile-seed.json');

export async function seed() {
  if (existsSync(SEED_FILE)) {
    try {
      const s = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
      const me = await (
        await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${s.token}` } })
      ).json();
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
    const cat =
      rt === 'expense' ? expCats[ci % Math.max(expCats.length, 1)] : incCats[ci % Math.max(incCats.length, 1)];
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

  const s = { token, ledgerId: ledger.id };
  writeFileSync(SEED_FILE, JSON.stringify(s, null, 2));
  return s;
}
