/**
 * 模板页（/templates）CDP 探针 —— 桌面与窄屏的视觉与交互验证。
 *
 * 为什么要它：这一页连着出过两次只有肉眼能看见的错 ——
 * 图标字段是英文 `<select>`（option 的文案就是 `coffee`），
 * 以及「类型」「分类」被拆成两个下拉（记账页是合并入口）。
 * 而 typecheck / audit:syntax / 全部 smoke 都照过：它们不进浏览器渲染页面。
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'templates');
const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, errors, netFails } = probe;
const c = checker();
const { check } = c;

await wipe();
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.73.${Math.floor(Math.random() * 250)}.9` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'tp' + Date.now().toString(36),
      nickname: '模板探针',
      password: 'TplProbe!2026',
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
await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({ name: '招行卡', type: 'debit_card', groupId: grp.id, openingBalance: '50000.00' }),
});
await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({ name: '现金', type: 'cash', groupId: grp.id, openingBalance: '1000.00' }),
});
await fetch(`${API}${P`/ledgers/${ledger.id}/tags`}`, {
  method: 'POST',
  headers: POST,
  body: JSON.stringify({ name: '常用', color: '#007AFF' }),
});
/** 三个模板：支出 / 应收（会显出方向分段）/ 转账（会显出转入账户） */
const seed = [
  ['楼下便利店', 'store', { recordType: 'expense', direction: 'decrease', defaultAmount: '30.00' }],
  ['借给小王', 'hand-coins', { recordType: 'receivable', direction: 'decrease', defaultAmount: '100.00' }],
  ['转到备用金', 'arrow-left-right', { recordType: 'transfer', defaultAmount: '200.00' }],
];
for (const [name, icon, payload] of seed) {
  await fetch(`${API}${P`/ledgers/${ledger.id}/templates`}`, {
    method: 'POST',
    headers: POST,
    body: JSON.stringify({ name, icon, payload }),
  });
}

const auth = authInjector({ token: TOKEN });
const r = (sel) => `
  (() => {
    const e = document.querySelector('${sel}');
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
  })()`;

await open('/templates', { wait: '.tplm-list', width: 1440, height: 1200, theme: 'light', arm: auth.arm });
await new Promise((res) => setTimeout(res, 700));

/* ---------- 1. 卡片同宽 ---------- */
await ev(`document.querySelector('[data-action=add]').click()`);
await new Promise((res) => setTimeout(res, 900));
const wF = JSON.parse(await ev(`JSON.stringify(${r('.tpl-form .compose__card')})`));
const wL = JSON.parse(await ev(`JSON.stringify(${r('.tplm-list')})`));
check(
  '新建表单卡片与已建模板卡片同宽',
  wF && wL && wF.w === wL.w && wF.l === wL.l && wF.r === wL.r,
  `表单 ${wF?.l}–${wF?.r}(${wF?.w}) / 列表 ${wL?.l}–${wL?.r}(${wL?.w})`,
);
const wRow = JSON.parse(await ev(`JSON.stringify(${r('.tplm-row')})`));
check('列表行与卡片同宽', wRow && wRow.w === wL?.w, `行 ${wRow?.w} / 卡片 ${wL?.w}`);
c.shot(await probe.shot('templates-form-1440', { dir: OUT, focus: '.tpl-form' }));

/* ---------- 2. 控件等高 ---------- */
const ctl = JSON.parse(
  await ev(`JSON.stringify((() => {
    const f = document.querySelector('.tpl-form');
    const vis = (e) => e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0;
    const list = [...f.querySelectorAll('.input, .icon-trigger, .pick-trigger, .segmented')].filter(vis);
    return {
      hs: [...new Set(list.map((e) => Math.round(e.getBoundingClientRect().height)))],
      n: list.length,
    };
  })())`),
);
check('表单内所有控件同一高度（44px）', ctl.hs.length === 1 && ctl.hs[0] === 44, `${ctl.n} 个 → ${ctl.hs.join('/')}`);

const rowW = JSON.parse(
  await ev(`JSON.stringify((() => {
    const f = document.querySelector('.tpl-form');
    return [...f.querySelectorAll('.field-row')].map((row) =>
      [...row.children].filter((k) => !k.hidden).map((k) => Math.round(k.getBoundingClientRect().width)),
    );
  })())`),
);
check(
  '同一行内两格等宽',
  rowW.length > 0 && rowW.every((ws) => ws.length === 2 && ws[0] === ws[1]),
  JSON.stringify(rowW),
);

/* ---------- 3. 图标：进弹层，不是平铺网格 ---------- */
const flat = await ev(`document.querySelectorAll('.tpl-form .icon-pick').length`);
check('图标不再平铺成网格（.icon-pick 已废弃）', Number(flat) === 0, `${flat} 个`);
check(
  '图标是单行触发器',
  Boolean(await ev(`!!document.querySelector('.tpl-form .icon-trigger')`)),
  '',
);

await ev(`document.querySelector('.tpl-form .icon-trigger').click()`);
await new Promise((res) => setTimeout(res, 500));
const pop = JSON.parse(
  await ev(`JSON.stringify((() => {
    const p = document.querySelector('.tpl-form .mega--icon');
    if (!p || p.hidden) return { missing: true };
    const b = p.getBoundingClientRect();
    return {
      w: Math.round(b.width),
      inViewport: b.left >= 0 && b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1,
      tiles: p.querySelectorAll('[data-icon]').length,
      cats: p.querySelectorAll('[data-cat]').length,
      hasSearch: !!p.querySelector('[data-role=icon-search]'),
      catsOverflow: (() => { const cc = p.querySelector('[data-role=icon-cats]'); return cc.scrollWidth - cc.clientWidth; })(),
      gridScrollable: (() => { const g = p.querySelector('[data-role=icon-grid]'); return g.scrollHeight > g.clientHeight; })(),
    };
  })())`),
);
check('图标弹层已打开', !pop.missing, JSON.stringify(pop));
check('弹层在视口内', pop.inViewport === true, `w=${pop.w}`);
check('弹层有搜索框', pop.hasSearch === true, '');
check('弹层有分组标签', pop.cats >= 8, `${pop.cats} 组`);
check('弹层有 100+ 个图标', pop.tiles >= 100, `${pop.tiles} 个`);
check('分组标签不横向溢出（换行而不是被裁）', pop.catsOverflow <= 1, `溢出 ${pop.catsOverflow}px`);
check('图标网格可滚动（高度被弹层约束）', pop.gridScrollable === true, '');
c.shot(await probe.shot('templates-iconpop-1440', { dir: OUT, focus: '.tpl-form' }));

/* ---------- 4. 搜索 ---------- */
await ev(`(() => { const s = document.querySelector('.tpl-form [data-role=icon-search]'); s.value = '咖啡'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await new Promise((res) => setTimeout(res, 400));
const hit = await ev(`(() => {
  const tiles = [...document.querySelectorAll('.tpl-form .mega--icon [data-icon]')];
  return JSON.stringify({ n: tiles.length, names: tiles.map((t) => t.getAttribute('title')).join(',') });
})()`);
const hitJ = JSON.parse(hit);
check('中文搜「咖啡」命中 coffee', hitJ.n === 1 && hitJ.names === '咖啡', `${hitJ.n} 个 → ${hitJ.names}`);

/* ---------- 5. 选中 → 回填 + 收起 ---------- */
await ev(`document.querySelector('.tpl-form .mega--icon [data-icon]').click()`);
await new Promise((res) => setTimeout(res, 500));
const picked = JSON.parse(
  await ev(`JSON.stringify({
    closed: document.querySelector('.tpl-form .mega--icon').hidden,
    text: (document.querySelector('.tpl-form [data-role=icon-text]') || {}).textContent,
    value: document.querySelector('.tpl-form [name=icon]').value,
    preview: document.querySelectorAll('.tpl-form [data-role=icon-preview] svg').length,
    clearShown: !document.querySelector('.tpl-form [data-role=icon-clear]').hidden,
  })`),
);
check('选中后弹层收起', picked.closed === true, '');
check('选中后触发器回显示中文名', picked.text === '咖啡', picked.text);
check('选中后隐藏字段拿到图标名', picked.value === 'coffee', picked.value);
check('选中后触发器有图标预览', picked.preview === 1, `${picked.preview} 个 svg`);
check('选中后「清除图标」可用', picked.clearShown === true, '');
c.shot(await probe.shot('templates-iconpicked-1440', { dir: OUT, focus: '.tpl-form' }));

/* ---------- 6. 清除 ---------- */
await ev(`document.querySelector('.tpl-form .icon-trigger').click()`);
await new Promise((res) => setTimeout(res, 400));
await ev(`document.querySelector('.tpl-form [data-role=icon-clear]').click()`);
await new Promise((res) => setTimeout(res, 400));
const cleared = JSON.parse(
  await ev(`JSON.stringify({
    closed: document.querySelector('.tpl-form .mega--icon').hidden,
    text: (document.querySelector('.tpl-form [data-role=icon-text]') || {}).textContent,
    value: document.querySelector('.tpl-form [name=icon]').value,
  })`),
);
check('清除后弹层收起', cleared.closed === true, '');
check('清除后回到「不指定」', cleared.text === '不指定' && cleared.value === '', `${cleared.text} / "${cleared.value}"`);

/* ---------- 7. 类型联动：转账显出转入账户 ---------- */
// 转账没有二三列，点到它本身就是「选完了」（type-cat-picker 的规矩）
await ev(`document.querySelector('.tpl-form .pick-trigger').click()`);
await new Promise((res) => setTimeout(res, 500));
await ev(`(() => {
  const t = [...document.querySelectorAll('.tpl-form .mega--pick [data-type]')].find((x) => x.dataset.type === 'transfer');
  t && t.click();
})()`);
await new Promise((res) => setTimeout(res, 700));
const transfer = JSON.parse(
  await ev(`JSON.stringify({
    toShown: !document.querySelector('.tpl-form [data-role=to-field]').hidden,
    toH: Math.round((document.querySelector('.tpl-form [name=toAccountId]') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
    pickText: (document.querySelector('.tpl-form .pick-trigger__text') || {}).textContent?.trim(),
  })`),
);
check('选「转账」后显出转入账户', transfer.toShown === true, JSON.stringify(transfer));
check('转入账户与其它控件同高', transfer.toH === 44, `${transfer.toH}px`);

/* ---------- 8. 类型联动：应收显出方向分段 ---------- */
// 应收有分类，光点类型只是走到第二列 —— 还要再点一个二级分类才算选完
await ev(`document.querySelector('.tpl-form .pick-trigger').click()`);
await new Promise((res) => setTimeout(res, 500));
await ev(`(() => {
  const t = [...document.querySelectorAll('.tpl-form .mega--pick [data-type]')].find((x) => x.dataset.type === 'receivable');
  t && t.click();
})()`);
await new Promise((res) => setTimeout(res, 500));
await ev(`(() => {
  const only = document.querySelector('.tpl-form .mega--pick [data-role=type-only]');
  if (only) { only.click(); return; }
  const leaf = document.querySelector('.tpl-form .mega--pick [data-role=col-leaf] [data-cat]');
  leaf && leaf.click();
})()`);
await new Promise((res) => setTimeout(res, 700));
const recv = JSON.parse(
  await ev(`JSON.stringify({
    segShown: !document.querySelector('.tpl-form [data-role=dir-field]').hidden,
    segH: Math.round((document.querySelector('.tpl-form .segmented') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
    items: document.querySelectorAll('.tpl-form .segmented__item').length,
  })`),
);
check('选「应收」后显出收付方向', recv.segShown === true && recv.items === 3, JSON.stringify(recv));
check('方向分段与输入框同高（44px，不是 50）', recv.segH === 44, `${recv.segH}px`);

/* ---------- 9. 字段齐全 + 无附件卡 ---------- */
const fields = await ev(`(() => {
  const f = document.querySelector('.tpl-form');
  const names = [...f.querySelectorAll('[name]')].map((e) => e.name);
  return JSON.stringify({
    names,
    hasAttach: !!f.querySelector('[data-role=attach], .attach-card, [name=attachment]'),
  });
})()`);
const fj = JSON.parse(fields);
const want = ['name', 'icon', 'accountId', 'defaultAmount', 'fee', 'discount', 'txName', 'merchant', 'counterparty', 'note'];
const missing = want.filter((w) => !fj.names.includes(w));
check('记账页的字段一个不漏', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : `${fj.names.length} 个字段`);
check('附件卡已删除', fj.hasAttach === false, '');

/* ---------- 10. 窄屏 ---------- */
await open('/templates', { wait: '.tplm-list', width: 390, height: 900, mobile: true, theme: 'light', arm: auth.arm });
await ev(`document.querySelector('[data-action=add]').click()`);
await new Promise((res) => setTimeout(res, 900));
const m = JSON.parse(
  await ev(`JSON.stringify((() => {
    const f = document.querySelector('.tpl-form');
    const vis = (e) => e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0;
    const list = [...f.querySelectorAll('.input, .icon-trigger, .pick-trigger')].filter(vis);
    // 一格一行的判据不是「每行只有一个子元素」，而是**两个子元素的 top 不相同** ——
    // .field-row 靠 flex-wrap 换行，DOM 里仍是两个兄弟。
    const rows = [...f.querySelectorAll('.field-row')].map((row) => {
      const kids = [...row.children].filter((k) => !k.hidden);
      const bs = kids.map((k) => k.getBoundingClientRect());
      return {
        w: bs.map((b) => Math.round(b.width)),
        tops: bs.map((b) => Math.round(b.top)),
      };
    });
    return {
      hs: [...new Set(list.map((e) => Math.round(e.getBoundingClientRect().height)))],
      rows,
      ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })())`),
);
check('390px 无横向溢出', Number(m.ovf) <= 1, `${m.ovf}px`);
check('390px 控件仍是 44px', m.hs.length === 1 && m.hs[0] === 44, m.hs.join('/'));
check(
  '390px 一格一行（并排的两格各自换行、宽度一致）',
  m.rows.every(
    (row) =>
      new Set(row.tops).size === row.tops.length &&
      new Set(row.w).size === 1,
  ),
  JSON.stringify(m.rows),
);
c.shot(await probe.shot('templates-form-390', { dir: OUT, focus: '.tpl-form' }));

await ev(`document.querySelector('.tpl-form .icon-trigger').click()`);
await new Promise((res) => setTimeout(res, 500));
const mPop = JSON.parse(
  await ev(`JSON.stringify((() => {
    const b = document.querySelector('.tpl-form .mega--icon').getBoundingClientRect();
    return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), vw: window.innerWidth };
  })())`),
);
check('390px 图标弹层是满宽底部 Sheet 且不溢出', mPop.l >= -1 && mPop.r <= mPop.vw + 1, `${mPop.l}–${mPop.r} / 屏宽 ${mPop.vw}`);
c.shot(await probe.shot('templates-iconpop-390', { dir: OUT, focus: '.tpl-form' }));

/* ---------- 11. 暗色 ---------- */
await open('/templates', { wait: '.tplm-list', width: 1440, height: 1200, theme: 'dark', arm: auth.arm });
await ev(`document.querySelector('[data-action=add]').click()`);
await new Promise((res) => setTimeout(res, 900));
await ev(`document.querySelector('.tpl-form .icon-trigger').click()`);
await new Promise((res) => setTimeout(res, 500));
c.shot(await probe.shot('templates-iconpop-dark', { dir: OUT, focus: '.tpl-form' }));

check('无控制台错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('无失败请求', netFails.length === 0, JSON.stringify(netFails.slice(0, 3)));
probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });
