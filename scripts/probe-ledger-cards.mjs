/**
 * 账本卡片视觉与布局 —— CDP 探针
 *
 * 验六件事（对应 00-DESIGN 对卡片的要求）：
 *   1. **图标与名称行中心对齐** —— 图标另起一列时它对着的不是名称行而是别的行，
 *      这类错位肉眼明显但静态检查发现不了，只能用几何量出来。
 *   2. **名字不截断** —— 后端允许 40 字，任何 ellipsis / line-clamp 都等于吃掉用户的名字。
 *   3. **信息层级三档** —— 名称 17/600 > 元信息 14/400 > 提示 12/400，字号字重各差一档。
 *   4. **同排卡片等高且操作行贴底对齐** —— 栅格拉齐后各卡的操作行要在同一基线。
 *   5. **不横向溢出** —— 窄卡片里名字换行而不是把卡片撑破。
 *   6. **暗色 / 窄屏** —— 换主题与换宽度后仍然成立。
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'ledger-cards');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, shot, waitUntil } = probe;
const c = checker();
const { check } = c;

/* ---------- 造数据：普通名 / 共享账本 / 20 字长名 ---------- */
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.66.${Math.floor(Math.random() * 250)}.3` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'lcard' + Date.now().toString(36),
      nickname: '卡片探针',
      password: 'LedgerCard123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

const tag = Math.random().toString(36).slice(2, 6);
const LONG = '家庭共同开支账本含房贷车贷水电燃气通信宽带保险医疗教育旅行'.slice(0, 20);

const created = [];
for (const [name, type] of [
  [`家庭账本${tag}`, 'personal'],
  [`${LONG}${tag}`, 'shared'],
  [`旅行计划${tag}`, 'personal'],
]) {
  const r = await (
    await fetch(`${API}/ledgers`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ name, type, currency: 'CNY' }),
    })
  ).json();
  if (r?.data?.id) created.push(r.data);
}
check('造出多本账本', created.length === 3, `${created.length} 本`);

/* ---------- 打开设置页 ---------- */
const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });
await wipe();
await open('/settings', { wait: '.ledger-card', theme: 'light', arm: auth.arm });

const cardCount = await ev(`document.querySelectorAll('.ledger-card').length`);
check('账本卡片已渲染', cardCount >= 3, `${cardCount} 张`);

/* ---------- 1. 图标与名称行中心对齐 ---------- */
const align = JSON.parse(
  await ev(`(() => {
    const out = [];
    for (const card of document.querySelectorAll('.ledger-card')) {
      const icon = card.querySelector('.ledger-card__icon');
      const name = card.querySelector('.ledger-card__name');
      if (!icon || !name) continue;
      const ir = icon.getBoundingClientRect();
      // 用 Range 量**第一行**的文字盒：元素盒中心会被多行文字拉低，量不到真实行心
      const range = document.createRange();
      range.selectNodeContents(name);
      const rects = [...range.getClientRects()];
      const first = rects[0];
      const nr = name.getBoundingClientRect();
      out.push({
        name: name.textContent.trim().slice(0, 12),
        iconMid: ir.top + ir.height / 2,
        lineMid: first ? first.top + first.height / 2 : nr.top + nr.height / 2,
        lineCount: new Set(rects.map(r => Math.round(r.top))).size,
        iconSize: ir.height,
        nameSize: getComputedStyle(name).fontSize,
      });
    }
    return JSON.stringify(out);
  })()`),
);

for (const a of align) {
  const d = Math.abs(a.iconMid - a.lineMid);
  check(`图标与名称行心对齐「${a.name}」`, d <= 2, `偏差 ${d.toFixed(1)}px（图标 ${a.iconSize}px）`);
}
check(
  '图标尺寸与文字行高同档（≤30px）',
  align.every((a) => a.iconSize <= 30),
  align.map((a) => a.iconSize).join(','),
);

/* ---------- 2. 名字不截断 ---------- */
const names = JSON.parse(
  await ev(`(() => {
    const out = [];
    for (const n of document.querySelectorAll('.ledger-card__name')) {
      out.push({
        text: n.textContent.trim(),
        scroll: n.scrollHeight,
        client: n.clientHeight,
        clipped: n.scrollHeight > n.clientHeight + 1,
        overflowX: n.scrollWidth > n.clientWidth + 1,
      });
    }
    return JSON.stringify(out);
  })()`),
);
for (const n of names) {
  check(`名字完整「${n.text.slice(0, 10)}」`, !n.clipped && !n.overflowX, `行高 ${n.client}px / 内容 ${n.scroll}px`);
}
const longOne = names.find((n) => n.text.length > 12);
check('长名占多行而非被省略', !!longOne && longOne.client > 24, longOne ? `${longOne.client}px` : '未找到长名');

/* ---------- 3. 信息层级三档 ---------- */
const ladder = JSON.parse(
  await ev(`(() => {
    // 取**非当前**账本：当前账本不再有 meta 行（状态已由徽标 + 描边 + 底色表达）
    const card = document.querySelector('.ledger-card:not(.is-current)') || document.querySelector('.ledger-card');
    const pick = (sel) => {
      const el = card.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { size: parseFloat(cs.fontSize), weight: cs.fontWeight, color: cs.color };
    };
    const cur = document.querySelector('.ledger-card.is-current');
    return JSON.stringify({
      name: pick('.ledger-card__name'),
      sub: pick('.ledger-card__sub'),
      meta: pick('.ledger-card__meta'),
      badge: pick('.ledger-card__current'),
      badgeInSub: !!document.querySelector('.ledger-card.is-current .ledger-card__sub .ledger-card__current'),
      currentHasMeta: cur ? !!cur.querySelector('.ledger-card__meta') : null,
    });
  })()`),
);
check('名称 17px/600', ladder.name.size === 17 && ladder.name.weight === '600', JSON.stringify(ladder.name));
check('元信息 14px/400', ladder.sub.size === 14 && ladder.sub.weight === '400', JSON.stringify(ladder.sub));
check('提示 12px/400', ladder.meta.size === 12 && ladder.meta.weight === '400', JSON.stringify(ladder.meta));
check('字号严格递减', ladder.name.size > ladder.sub.size && ladder.sub.size > ladder.meta.size, `${ladder.name.size} > ${ladder.sub.size} > ${ladder.meta.size}`);
check('徽标落在元信息行（不与名字争空间）', ladder.badgeInSub === true, String(ladder.badgeInSub));
check('当前账本不重复表达状态（无第二处提示行）', ladder.currentHasMeta === false, String(ladder.currentHasMeta));

/* ---------- 4. 同排卡片等高 + 操作行贴底 ---------- */
const geo = JSON.parse(
  await ev(`(() => {
    const cards = [...document.querySelectorAll('.ledger-card')];
    const row = cards.filter(c => Math.abs(c.getBoundingClientRect().top - cards[0].getBoundingClientRect().top) < 2);
    return JSON.stringify({
      heights: row.map(c => Math.round(c.getBoundingClientRect().height)),
      opsBottoms: row.map(c => {
        const ops = c.querySelector('.ledger-card__ops');
        return ops ? Math.round(ops.getBoundingClientRect().bottom) : null;
      }),
      cardWidths: row.map(c => Math.round(c.getBoundingClientRect().width)),
      overflow: row.map(c => {
        const r = c.getBoundingClientRect();
        return [...c.querySelectorAll('*')].some(el => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1);
        });
      }),
    });
  })()`),
);
check('同排卡片等高', new Set(geo.heights).size === 1, geo.heights.join(','));
check('操作行底边对齐', new Set(geo.opsBottoms).size === 1, geo.opsBottoms.join(','));
check('卡片内无元素溢出边界', geo.overflow.every((x) => !x), JSON.stringify(geo.overflow));

c.shot(await shot('ledger-cards-light-1440', { dir: OUT, focus: '.ledger-card' }));

/* ---------- 5. 暗色 ---------- */
await open('/settings', { wait: '.ledger-card', theme: 'dark', arm: auth.arm });
const darkBg = await ev(`getComputedStyle(document.querySelector('.ledger-card')).backgroundColor`);
check('暗色下卡片有底色', darkBg !== 'rgba(0, 0, 0, 0)' && darkBg !== 'transparent', darkBg);
c.shot(await shot('ledger-cards-dark-1440', { dir: OUT, focus: '.ledger-card' }));

/* ---------- 6. 窄屏（单列） ---------- */
await open('/settings', { wait: '.ledger-card', width: 390, height: 844, mobile: true, theme: 'light', arm: auth.arm });
const narrow = JSON.parse(
  await ev(`(() => {
    const cards = [...document.querySelectorAll('.ledger-card')];
    const r = cards[0].getBoundingClientRect();
    const name = cards[0].querySelector('.ledger-card__name');
    return JSON.stringify({
      cardWidth: Math.round(r.width),
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      nameClipped: name ? name.scrollHeight > name.clientHeight + 1 : true,
      pageScroll: document.documentElement.scrollWidth,
      pageClient: document.documentElement.clientWidth,
    });
  })()`),
);
check('窄屏无横向溢出', narrow.bodyOverflow === false, `${narrow.pageScroll} vs ${narrow.pageClient}`);
check('窄屏名字仍不截断', narrow.nameClipped === false, String(narrow.nameClipped));
c.shot(await shot('ledger-cards-light-390', { dir: OUT, focus: '.ledger-card' }));

const pass = c.results.filter((r) => r.ok).length;
console.log(`\n结果 ==== ${pass} / ${c.results.length}`);
console.log('截图：', c.shots.join('\n       '));
process.exit(pass === c.results.length ? 0 : 1);
