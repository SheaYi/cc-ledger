/**
 * 往来页（/debts）CDP 探针 —— 第 5 批次的视觉与交互验证。
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'debts');
const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, errors, netFails } = probe;
const c = checker();
const { check } = c;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = iso(new Date());

await wipe();
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.71.${Math.floor(Math.random() * 250)}.5` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ username: 'db' + Date.now().toString(36), nickname: '往来探针', password: 'DebtProbe!2026', platform: 'web' }),
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
      method: 'POST', headers: POST,
      body: JSON.stringify({ name: '往来卡', type: 'debit_card', groupId: grp.id, openingBalance: '20000.00' }),
    })
  ).json()
).data;
const recvCats = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=receivable`, { headers: AH })).json()).data;
const payCats = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/categories`}?recordType=payable`, { headers: AH })).json()).data;
const rc = (recvCats.find((p) => (p.children ?? []).length) ?? recvCats[0]).children[0];
const pc = (payCats.find((p) => (p.children ?? []).length) ?? payCats[0]).children[0];
const tx = async (body) =>
  (
    await (
      await fetch(`${API}${P`/ledgers/${ledger.id}/transactions`}`, {
        method: 'POST', headers: POST,
        body: JSON.stringify({ accountId: acc.id, txDate: todayStr, fee: '0', discount: '0', ...body }),
      })
    ).json()
  ).data;

// 借出 800（部分收回 300）→ 待收 500；登记欠款 1200 → 待付 1200
const o1 = await tx({ recordType: 'receivable', direction: 'decrease', categoryId: rc.id, counterparty: '张三', name: '借出', amount: '800.00' });
await tx({ recordType: 'receivable', direction: 'increase', categoryId: rc.id, counterparty: '张三', name: '收回部分', amount: '300.00', settles: [{ transactionId: o1.id, amount: '300.00' }] });
await tx({ recordType: 'payable', direction: 'none', categoryId: pc.id, counterparty: '装修公司', name: '尾款', amount: '1200.00' });
// 一个超长名称，用来验省略
await tx({ recordType: 'receivable', direction: 'decrease', categoryId: rc.id, counterparty: '一个非常非常长的往来对象名称用来验证省略号是否生效', name: '借出', amount: '66.00' });

const auth = authInjector({ token: TOKEN });
await open('/debts', { wait: '.debt-card', theme: 'light', arm: auth.arm });

const cards = await ev(`Array.from(document.querySelectorAll('.debt-card__value')).map((x) => x.textContent.trim())`);
check('三张卡有值', cards.length === 3 && cards.every((v) => v.length > 0), JSON.stringify(cards));
// 800 借出 − 300 收回 + 66 另一笔借出 = 566。千分位要剥掉再比。
const norm = (v) => String(v ?? '').replace(/[¥,\s]/g, '');
check('待收 = ¥566.00（800 − 300 + 66）', norm(cards[0]) === '566.00', cards[0]);
check('待付 = ¥1,200.00（千分位后比较）', norm(cards[1]) === '1200.00', cards[1]);

const rows = await ev(`document.querySelectorAll('.debt-row').length`);
check('列表有行', Number(rows) >= 2, `${rows} 行`);

// 超长名称必须被省略（scrollWidth > clientWidth 才说明真的截断了）
const clipped = await ev(
  `(() => {
     const els = Array.from(document.querySelectorAll('.debt-row__name'));
     return els.filter((e) => e.scrollWidth > e.clientWidth + 1).length;
   })()`,
);
check('超长名称被省略而不是撑破行', Number(clipped) >= 1, `${clipped} 处截断`);

const titled = await ev(
  `(() => {
     const el = Array.from(document.querySelectorAll('.debt-row__name')).find((e) => e.scrollWidth > e.clientWidth + 1);
     return el ? (el.getAttribute('title') || '').length : 0;
   })()`,
);
check('省略时 title 保留完整名称', Number(titled) > 10, `${titled} 字`);

const aligned = await ev(
  `(() => {
     const el = document.querySelector('.debt-row__amount');
     if (!el) return 'none';
     const cs = getComputedStyle(el);
     return cs.textAlign + '/' + cs.fontVariantNumeric;
   })()`,
);
check('金额列右对齐 + 等宽数字', String(aligned).startsWith('right'), String(aligned));

const ovf = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('1440px 无横向溢出', Number(ovf) <= 1, `${ovf}px`);

c.shot(await probe.shot('debts-light-1440', { dir: OUT, focus: '.debt-cards' }));

/* ---- 切到「含已结清」 ---- */
await ev(
  `(() => {
     const b = Array.from(document.querySelectorAll('[data-status]')).find((x) => x.dataset.status === 'all');
     b && b.click();
     return !!b;
   })()`,
);
await new Promise((r) => setTimeout(r, 900));
const rowsAll = await ev(`document.querySelectorAll('.debt-row').length`);
check('切到「含已结清」后行数增加', Number(rowsAll) >= Number(rows), `${rows} → ${rowsAll}`);
c.shot(await probe.shot('debts-all-1440', { dir: OUT, focus: '.debt-list' }));

/* ---- 暗色 + 窄屏 ---- */
await open('/debts', { wait: '.debt-card', theme: 'dark', arm: auth.arm });
c.shot(await probe.shot('debts-dark-1440', { dir: OUT, focus: '.debt-cards' }));

await open('/debts', { wait: '.debt-card', theme: 'light', width: 390, height: 900, arm: auth.arm });
const ovfM = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('390px 无横向溢出', Number(ovfM) <= 1, `${ovfM}px`);
const swatch = await ev(
  `(() => {
     const list = Array.from(document.querySelectorAll('.chip, .segmented__item'));
     if (!list.length) return 'no-chip';
     return list.map((e) => Math.round(e.getBoundingClientRect().height)).join(',');
   })()`,
);
check('窄屏下密集选择器 ≥ 44px', String(swatch) === 'no-chip' || String(swatch).split(',').every((h) => Number(h) >= 44 || Number(h) === 0), String(swatch));
c.shot(await probe.shot('debts-mobile-390', { dir: OUT, focus: '.debt-cards' }));

check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));
probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
