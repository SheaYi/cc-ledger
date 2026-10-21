/**
 * 间距 / 布局对齐 —— CDP 探针
 *
 * 验两处用户点名的间距问题（00-DESIGN 结构间距落在 8/12/16/20/24）：
 *
 *   A. 账本卡片操作行 —— 「编辑 / 删除」的**视觉左距与右距**是否对称，
 *      且与卡片内容区（标题行）的 24px 内边距落在同一条基准上。
 *      ⚠️ 量的是**按钮内文字**的起点，不是按钮盒的起点：
 *      `.btn--quiet` 自带 0 12px 内边距，只量盒会得出「本来就对齐」的假结论。
 *
 *   B. 导入页 ① 选择文件 —— 「读取表头」按钮行与上方拖拽区的垂直间距。
 *      `.card` 不是 flex 容器，块级子元素之间**没有任何 gap**，
 *      这一处的间距完全取决于模板有没有写 margin / 父级有没有 stack 类。
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'spacing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, shot } = probe;
const c = checker();
const { check } = c;

/* ---------- 造一个用户 + 两本账本 ---------- */
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.71.${Math.floor(Math.random() * 250)}.7` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'spac' + Date.now().toString(36),
      nickname: '间距探针',
      password: 'SpacingProbe123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

const tag = Math.random().toString(36).slice(2, 6);
for (const [name, type] of [
  [`家庭账本${tag}`, 'personal'],
  [`共享账本${tag}`, 'shared'],
]) {
  await fetch(`${API}/ledgers`, { method: 'POST', headers: POST, body: JSON.stringify({ name, type, currency: 'CNY' }) });
}
check('造出两本账本', true, '');

const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });

/* ---------- A. 账本卡片操作行 ---------- */
await wipe();
await open('/settings', { wait: '.ledger-card', theme: 'light', arm: auth.arm });
await sleep(300);

const ops = JSON.parse(
  await ev(`(() => {
    const out = [];
    for (const card of document.querySelectorAll('.ledger-card')) {
      const cr = card.getBoundingClientRect();
      const sw = card.querySelector('.ledger-card__switch');
      const opsRow = card.querySelector('.ledger-card__ops');
      if (!sw || !opsRow) continue;
      const sr = sw.getBoundingClientRect();
      const or_ = opsRow.getBoundingClientRect();
      const btns = [...opsRow.querySelectorAll('.btn')].map((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        // 文字起点 = 盒起点 + 按钮自身 padding（quiet 按钮有 12px 内边距）
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        return {
          label: b.textContent.trim(),
          boxLeftGap: Math.round(r.left - cr.left),
          boxRightGap: Math.round(cr.right - r.right),
          textLeftGap: Math.round(r.left + padL - cr.left),
          textRightGap: Math.round(cr.right - (r.right - padR)),
          padL,
          padR,
          h: Math.round(r.height),
          top: Math.round(r.top - or_.top),
          bottom: Math.round(or_.bottom - r.bottom),
        };
      });
      const name = card.querySelector('.ledger-card__name');
      const nr = name ? name.getBoundingClientRect() : null;
      const opsCs = getComputedStyle(opsRow);
      out.push({
        name: card.querySelector('.ledger-card__name')?.textContent.trim().slice(0, 10) ?? '',
        switchPadL: Math.round(sr.left - cr.left + parseFloat(getComputedStyle(sw).paddingLeft)),
        switchPadR: Math.round(cr.right - sr.right + parseFloat(getComputedStyle(sw).paddingRight)),
        nameLeftGap: nr ? Math.round(nr.left - cr.left) : null,
        opsPadL: opsCs.paddingLeft,
        opsPadR: opsCs.paddingRight,
        opsPadT: opsCs.paddingTop,
        opsPadB: opsCs.paddingBottom,
        opsHeight: Math.round(or_.height),
        btns,
      });
    }
    return JSON.stringify(out);
  })()`),
);

for (const o of ops) {
  const first = o.btns[0];
  const last = o.btns[o.btns.length - 1];

  // 操作行是 justify-content:flex-end，**不能**断言「最左按钮盒左距 = 24」——
  // 那是内容总宽决定的，与内边距无关。要断言的是行内边距本身左右相等。
  check(
    `卡片「${o.name}」操作行左右内边距相等`,
    Math.abs(parseFloat(o.opsPadL) - parseFloat(o.opsPadR)) <= 0.5,
    `${o.opsPadL} / ${o.opsPadR}`,
  );
  check(
    `卡片「${o.name}」标题行左右内边距对称`,
    Math.abs(o.switchPadL - o.switchPadR) <= 1,
    `${o.switchPadL} / ${o.switchPadR}`,
  );

  // 真正的对齐基准：**最右按钮的文字右缘**必须与上方内容区右缘（24px）同线。
  // 之前是 41px（行 24 + 按钮 16 = 40，再加 1px 边框），比内容区多缩进一截。
  check(
    `卡片「${o.name}」最右按钮文字右缘 = 内容区基准`,
    Math.abs(last.textRightGap - 24) <= 1,
    `按钮文字 ${last.textRightGap} vs 基准 24`,
  );

  // 垂直居中：按钮上下留白必须相等（之前 13 / 24，贴住分隔线偏上）
  check(
    `卡片「${o.name}」按钮在操作行内垂直居中`,
    Math.abs(first.top - first.bottom) <= 1,
    `上 ${first.top} / 下 ${first.bottom}`,
  );
  check(
    `卡片「${o.name}」操作行上下内边距相等且为合法间距`,
    Math.abs(parseFloat(o.opsPadT) - parseFloat(o.opsPadB)) <= 0.5 && [8, 12, 16, 20, 24].includes(parseFloat(o.opsPadT)),
    `上 ${o.opsPadT} / 下 ${o.opsPadB}`,
  );

  // 触控底线不能因为收内边距而破：按钮高度必须仍是 44px
  check(
    `卡片「${o.name}」按钮保持 44px 触控高度`,
    o.btns.every((b) => b.h === 44),
    o.btns.map((b) => b.h).join(','),
  );
}
c.shot(await shot('ledger-ops-light-1440', { dir: OUT, focus: '.ledger-card' }));

/* ---------- B. 导入页 ① 选择文件 ---------- */
await open('/import', { wait: '.dropzone', theme: 'light', arm: auth.arm });
await sleep(300);

const imp = JSON.parse(
  await ev(`(() => {
    const card = document.querySelector('[data-role=step1] .card');
    if (!card) return JSON.stringify({ missing: true });
    const field = card.querySelector('.field');
    const row = card.querySelector('.row');
    const btns = [...(row ? row.querySelectorAll('.btn') : [])];
    const cr = card.getBoundingClientRect();
    const fr = field ? field.getBoundingClientRect() : null;
    const rr = row ? row.getBoundingClientRect() : null;
    const cardCs = getComputedStyle(card);
    const first = btns[0];
    const fr2 = first ? first.getBoundingClientRect() : null;
    return JSON.stringify({
      cardDisplay: cardCs.display,
      cardPad: cardCs.padding,
      hasStack: card.classList.contains('stack'),
      gap: fr && rr ? Math.round(rr.top - fr.bottom) : null,
      rowTopPad: rr && cr ? Math.round(rr.top - cr.top) : null,
      btnLeftGap: fr2 && cr ? Math.round(fr2.left - cr.left) : null,
      btnLabel: first ? first.textContent.trim() : null,
      btnTop: fr2 && rr ? Math.round(fr2.top - rr.top) : null,
      fieldPadB: field ? getComputedStyle(field).paddingBottom : null,
    });
  })()`),
);
check('导入页 step1 卡片已找到', imp.missing !== true, JSON.stringify(imp).slice(0, 120));
check('「读取表头」与上方内容有 ≥16px 垂直间距', Number(imp.gap) >= 16, `实测 ${imp.gap}px`);
check(
  '按钮行左距 = 卡片内边距基准 24px',
  Math.abs(Number(imp.btnLeftGap) - 24) <= 1,
  `${imp.btnLeftGap}px（card padding ${imp.cardPad}）`,
);
c.shot(await shot('import-step1-light-1440', { dir: OUT, focus: '[data-role=step1]' }));

const pass = c.results.filter((r) => r.ok).length;
console.log(`\n结果 ==== ${pass} / ${c.results.length}`);
console.log('失败项：');
for (const r of c.results.filter((x) => !x.ok)) console.log('  ✗', r.name, '|', r.detail);
console.log('截图：', c.shots.join('\n       '));
process.exit(pass === c.results.length ? 0 : 1);