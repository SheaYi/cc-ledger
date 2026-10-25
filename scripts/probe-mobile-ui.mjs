/**
 * 手机端 UI 探针（390 × 844）
 *
 * 断言的是**外观层面**的四个硬要求（都是真机上一眼能看出的毛病，
 * 静态审计查不到）：
 *
 *   1. 底部 dock 切换页面时**不重建** —— 重建会重播 `tabbar-in` 入场动画，
 *      表现为切页时底栏「被推出去又滑回来」闪一下。
 *   2. 顶栏头像在圆形底内**精确居中**（中心偏差 ≤ 0.5px）。桌面那颗
 *      「头像+昵称」胶囊在手机上会被昵称挤偏。
 *   3. 记账页类型 / 分类横滑带里的 pill **互不重叠**。
 *   4. 账单页「支出 / 收入 / 结余」**同一行**（三列等分）。
 *
 * 外加通用护栏：横向不溢出、触控目标 ≥44px、名称→日期间距不过宽。
 *
 * 用法：node scripts/probe-mobile-ui.mjs [light|dark]
 */
import { join } from 'node:path';
import { connect } from './lib/cdp.mjs';
import { seed } from './lib/mobile-seed.mjs';

const W = 390;
const H = 844;
const THEME = process.argv[2] === 'dark' ? 'dark' : 'light';

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log('  ✓', name, detail ? `· ${detail}` : '');
  } else {
    fails.push({ name, detail });
    console.log('  ✗', name, detail ? `· ${detail}` : '');
  }
}

const s = await seed();
const probe = await connect({ base: 'http://127.0.0.1:3000' });
const { ev, wipe, authInjector, open, shot } = probe;
const auth = authInjector({ token: s.token });
await wipe();

const OUT = join(process.cwd(), 'screenshots', `probe-${THEME}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const go = (path, sel) => open(path, { wait: sel, width: W, height: H, mobile: true, theme: THEME, arm: auth.arm });

/* ================= 1. dock 不重建 ================= */
console.log('\n── 底部 dock ──');
await go('/accounts', '.tabbar');
await wait(600);
// 打标记：若切页后标记还在，说明是同一个 DOM 节点
await ev(`(() => { const d = document.getElementById('cc-dock'); if (d) d.__probeMark = 'k1'; return !!d; })()`);
check('dock 挂在 body 上（不在页面 shell 内）', (await ev(`!!document.getElementById('cc-dock')`)) === true);
check(
  'dock 是 body 的直接子节点（切页不会被 shell 重建带走）',
  (await ev(`document.getElementById('cc-dock')?.parentElement?.tagName`)) === 'BODY',
);

// 点 dock 上的「账单」切页，检查节点是否被换掉
await ev(`(() => { document.querySelector('[data-tab=transactions]')?.click(); return true; })()`);
await wait(1200);
const mark = await ev(`document.getElementById('cc-dock')?.__probeMark ?? 'LOST'`);
check('切页后仍是同一个 dock 节点（不重播入场动画）', mark === 'k1', `标记=${mark}`);
check(
  '切页后选中态跟到了「账单」',
  (await ev(`document.querySelector('[data-tab=transactions]')?.getAttribute('aria-current')`)) === 'page',
);
check(
  '旧选中态已移除（不会两个都亮）',
  (await ev(`[...document.querySelectorAll('[data-tab][aria-current]')].length`)) === 1,
);

await go('/transactions/new', '.compose__card');
await wait(700);
check('记账页不显示 dock（全屏页）', (await ev(`(() => { const d = document.getElementById('cc-dock'); return !d || d.hidden; })()`)) === true);

/* ================= 2. 顶栏头像居中 ================= */
console.log('\n── 顶栏头像 ──');
await go('/accounts', '.app-bar');
await wait(700);
const chip = JSON.parse(
  await ev(`(() => {
  const c = document.querySelector('.app-bar .user-chip');
  if (!c) return 'null';
  const b = c.getBoundingClientRect();
  const a = c.querySelector('.avatar');
  if (!a) return 'null';
  const ab = a.getBoundingClientRect();
  const cs = getComputedStyle(c);
  return JSON.stringify({
    dx: +(ab.left + ab.width / 2 - (b.left + b.width / 2)).toFixed(2),
    dy: +(ab.top + ab.height / 2 - (b.top + b.height / 2)).toFixed(2),
    box: [Math.round(b.width), Math.round(b.height)],
    radius: cs.borderRadius,
    nameVisible: !!c.querySelector('.user-chip__name')?.offsetParent,
  });
})()`),
);
if (chip === 'null') {
  check('顶栏头像存在', false, '未找到 .app-bar .user-chip 或 .avatar');
} else {
  check('头像在圆内水平居中（|dx| ≤ 0.5px）', Math.abs(chip.dx) <= 0.5, `dx=${chip.dx}`);
  check('头像在圆内垂直居中（|dy| ≤ 0.5px）', Math.abs(chip.dy) <= 0.5, `dy=${chip.dy}`);
  check('顶栏头像是正圆容器（44×44）', chip.box[0] === 44 && chip.box[1] === 44, `${chip.box.join('×')}`);
  check('顶栏不重复显示昵称（昵称在设置页）', chip.nameVisible === false);
  check('圆形容器的圆角是 pill/full', /9999|50%/.test(chip.radius), chip.radius);
}

/* ================= 3. 记账页：类型/分类不重叠 + 间距 ================= */
console.log('\n── 记账页 ──');
await go('/transactions/new', '.compose__card');
await wait(900);
await ev(`(() => { document.querySelector('[data-role=pick-trigger]')?.click(); return true; })()`);
await wait(900);
const panel = JSON.parse(
  await ev(`(() => {
  const items = [...document.querySelectorAll('.mega__col--type .mega__item')].map((el) => {
    const b = el.getBoundingClientRect();
    return { t: el.textContent.trim().split('\\n')[0], l: b.left, r: b.right, t0: b.top, b0: b.bottom };
  });
  const ov = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b0, b.b0) - Math.max(a.t0, b.t0);
      if (ox > 1 && oy > 1) ov.push(a.t + '×' + b.t + ' ' + Math.round(ox) + 'x' + Math.round(oy));
    }
  const parents = [...document.querySelectorAll('.mega__col--parent .mega__navitem')].map((el) => {
    const b = el.getBoundingClientRect();
    return { t: el.textContent.trim().split('\\n')[0], l: b.left, r: b.right, t0: b.top, b0: b.bottom };
  });
  const pov = [];
  for (let i = 0; i < parents.length; i++)
    for (let j = i + 1; j < parents.length; j++) {
      const a = parents[i], b = parents[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b0, b.b0) - Math.max(a.t0, b.t0);
      if (ox > 1 && oy > 1) pov.push(a.t + '×' + b.t);
    }
  return JSON.stringify({ count: items.length, labels: items.map((x) => x.t), overlaps: ov, pov });
})()`),
);
check('类型带 5 个类型全部渲染', panel.count === 5, panel.labels.join('/'));
check('类型 pill 互不重叠', panel.overlaps.length === 0, panel.overlaps.join('；') || '无重叠');
check('一级分类 pill 互不重叠', panel.pov.length === 0, panel.pov.join('；') || '无重叠');
await shot('compose-panel', { dir: OUT });

// 关面板，量名称 → 日期间距
await ev(`(() => { document.querySelector('[data-role=pick-trigger]')?.click(); return true; })()`);
await wait(500);
const gap = JSON.parse(
  await ev(`(() => {
  const n = document.querySelector('[data-field=name]');
  const d = document.querySelector('[data-field=txDate]');
  if (!n || !d) return 'null';
  return JSON.stringify({ gap: Math.round(d.getBoundingClientRect().top - n.getBoundingClientRect().bottom) });
})()`),
);
if (gap === 'null') check('名称 / 日期字段存在', false);
else
  check(
    '名称 → 日期间距 ≤ 32px（spacing.xl 上限；夹着一条 hairline 分隔）',
    gap.gap <= 32 && gap.gap >= 4,
    `${gap.gap}px`,
  );

/* ================= 4. 账单页：三统计同行 ================= */
console.log('\n── 账单页 ──');
await go('/transactions', '.tx-sum');
await wait(900);
const sum = JSON.parse(
  await ev(`(() => {
  const s = document.querySelector('.tx-sum');
  if (!s) return 'null';
  const cells = [...s.children].map((c) => {
    const b = c.getBoundingClientRect();
    return { t: c.textContent.trim().split('\\n')[0].slice(0, 6), top: Math.round(b.top), w: Math.round(b.width) };
  });
  return JSON.stringify({ n: cells.length, tops: cells.map((c) => c.top), cells: cells.map((c) => c.t), ws: cells.map((c) => c.w) });
})()`),
);
if (sum === 'null') check('账单页统计区存在', false);
else {
  check('统计区 3 项', sum.n === 3, sum.cells.join('/'));
  check('三项在同一行（top 去重剩 1 个值）', new Set(sum.tops).size === 1, sum.tops.join(','));
  check('三列等宽（差值 ≤ 1px）', Math.max(...sum.ws) - Math.min(...sum.ws) <= 1, sum.ws.join('/'));
}
console.log('  →', await shot('transactions', { dir: OUT }));

/* ================= 通用护栏 ================= */
console.log('\n── 通用护栏 ──');
for (const [name, path, sel] of [
  ['账户', '/accounts', '.page__hero'],
  ['账单', '/transactions', '.page__hero'],
  ['统计', '/stats', '.page__hero'],
  ['设置', '/settings', '.page__hero'],
]) {
  await go(path, sel);
  await wait(800);
  const r = JSON.parse(
    await ev(`(() => {
    const cw = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('*')].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && (b.right > cw + 0.5 || b.left < -0.5);
    }).length;
    /* 复选框 / 单选本体是系统控件（16px，CSS 改不动），
       触控目标是**包裹它的 label 整行**，所以只对这类控件改判祖先。 */
    const small = [...document.querySelectorAll('button, a.btn, .btn, input, select')]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        if (!(b.width > 0 && b.height > 0 && b.height < 44)) return false;
        if (/^(checkbox|radio)$/.test(el.type)) {
          const host = el.closest('label');
          const hb = host?.getBoundingClientRect();
          return !(hb && hb.height >= 44);
        }
        return true;
      })
      .map((el) => (el.className || el.tagName).toString().slice(0, 26));
    return JSON.stringify({ over, small: [...new Set(small)].slice(0, 5), docW: document.documentElement.scrollWidth });
  })()`),
  );
  check(`${name}页无横向溢出`, r.over === 0, `溢出元素 ${r.over} 个 / scrollWidth=${r.docW}`);
  check(`${name}页触控目标 ≥44px`, r.small.length === 0, r.small.join(',') || '全部达标');
}

probe.close();
console.log(`\n结果 ==== ${pass} / ${pass + fails.length}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ✗', f.name, f.detail ? `· ${f.detail}` : '');
}
process.exit(fails.length ? 1 : 0);
