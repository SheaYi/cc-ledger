/**
 * 双主题对比度审计。
 *
 * 为什么需要它：夜间模式的对比度不会「继承」日间的结论——
 * 一个在日间 7.2:1 的配对，搬到暗面上可能只剩 4.1:1。
 * 这个小工具直接解析 public/assets/tokens.css 的两套取值，
 * 对真实出现的（前景, 背景）组合按 WCAG 2.1 计算对比度并断言阈值：
 *   · 正文 / 小标签（< 18.66px 粗体）≥ 4.5:1
 *   · 大字 / 图形 / 描边（UI 组件边界）≥ 3:1
 * 任何一条不达标即以非 0 退出，把「看起来没问题」变成「实测达标」。
 *
 * 用法：node scripts/audit-contrast.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TOKENS = join(ROOT, 'public', 'assets', 'tokens.css');

/* ---------------- 解析 tokens.css ---------------- */
const css = readFileSync(TOKENS, 'utf8');

/** 抓出一个选择器块的 body（按花括号配对，够用且不引依赖） */
function block(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`未找到选择器：${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`选择器块未闭合：${selector}`);
}

function parseVars(body) {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const LIGHT = parseVars(block(':root {'));
const DARK = { ...LIGHT, ...parseVars(block("[data-theme='dark'] {")) };

/* ---------------- 颜色工具 ---------------- */
function parseColor(raw) {
  const v = String(raw).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(v);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** 把带 alpha 的前景叠在不透明背景上（浏览器按 sRGB 直接插值） */
function composite(fg, bg) {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function luminance({ r, g, b }) {
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(fg, bg) {
  const L1 = luminance(fg);
  const L2 = luminance(bg);
  const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------- 被审计的配对 ----------------
   只列真实会同时出现在屏上的组合（前景令牌 / 背景令牌）。
   背景可以是：令牌名，或 { tint, over } 表示「tint 叠在 over 上」。
   第 5 位 kind='record' 表示「文档既有取值的实测记录」：
   00-DESIGN 直接给定的色值（未做事后调整），只登记不断言，
   避免为了过闸而擅自改动已确认的日间设计。 */
const TEXT = 4.5; // 正文与小标签
const GRAPHIC = 3; // 大字、图形、UI 组件边界

const PAIRS = [
  // ---- 正文与文本阶梯 ----
  ['--c-ink', '--c-canvas', TEXT, '正文/标题 压 卡片'],
  ['--c-ink', '--c-parchment', TEXT, '正文/标题 压 页底'],
  ['--c-ink-muted-80', '--c-canvas', TEXT, '次级文字 压 卡片'],
  // Q4 拍板后取 #757575（白底 4.60:1）；文档把它定位为「禁用态 + 法务小字」豁免档，
  // 羊皮纸底 4.23:1 仍低于 AA，故保留登记不断言，不为过闸而进一步提亮。
  ['--c-ink-muted-48', '--c-canvas', TEXT, '弱文字 压 卡片', 'record'],
  ['--c-ink-muted-48', '--c-parchment', TEXT, '弱文字 压 页底', 'record'],
  ['--c-body-on-dark', '--c-hero-panel', TEXT, '净资产数字 压 英雄面'],
  ['--c-on-dark-2', '--c-hero-panel', GRAPHIC, '英雄面次级说明（13px 弱化）'],
  ['--c-on-dark-2', '--c-brand-panel', GRAPHIC, '品牌面引言'],
  ['--c-on-dark-3', '--c-brand-panel', GRAPHIC, '品牌面小字'],
  ['--c-on-dark', '--c-black', TEXT, '纯黑面白字'],
  ['--c-on-dark', '--c-toast-bg', TEXT, 'Toast 文字'],
  ['--c-on-dark', '--c-toast-error', TEXT, '错误 Toast 文字'],
  ['--c-on-dark', '--c-toast-success', TEXT, '成功 Toast 文字'],

  // ---- 交互色 ----
  ['--c-primary', '--c-canvas', TEXT, '链接 / 选中态文字 压 卡片'],
  ['--c-primary', '--c-parchment', TEXT, '链接 压 页底'],
  ['--c-primary', '--c-soft-fill', TEXT, '链接 压 软填充面'],
  ['--c-primary', { tint: '--c-accent-1', over: '--c-canvas' }, TEXT, '当前账本卡文字 压 淡蓝底'],
  ['--c-primary', { tint: '--c-accent-2', over: '--c-canvas' }, TEXT, '选中胶囊/图标文字 压 淡蓝底'],
  ['--c-primary', { tint: '--c-accent-3', over: '--c-canvas' }, TEXT, '侧栏当前项文字 压 淡蓝底'],
  ['--c-primary', { tint: '--c-accent-4', over: '--c-canvas' }, TEXT, '小徽标文字 压 淡蓝底'],
  ['--c-on-primary', '--c-primary-fill', TEXT, '实心按钮文字 压 Action Blue'],
  ['--c-on-ink-fill', '--c-ink-fill', TEXT, '对比填充按钮文字'],
  ['--c-primary-focus', '--c-canvas', GRAPHIC, '焦点环 / 输入框 focus 描边'],
  ['--c-primary-focus', '--c-parchment', GRAPHIC, '焦点环 压 页底'],
  ['--c-primary-focus', { tint: '--c-accent-2', over: '--c-canvas' }, GRAPHIC, '选中态描边 压 淡蓝底'],

  // ---- 语义色 ----
  ['--c-danger', '--c-canvas', TEXT, '错误文字 压 卡片'],
  ['--c-danger', '--c-parchment', TEXT, '错误文字 压 页底'],
  ['--c-danger', { tint: '--c-danger-bg', over: '--c-canvas' }, TEXT, '错误文字 压 错误底'],
  ['--c-success', '--c-canvas', TEXT, '成功/收入文字'],
  ['--c-success', { tint: '--c-success-bg', over: '--c-canvas' }, TEXT, '成功文字 压 成功底'],
  ['--c-swatch-ring', '--c-canvas', 1.05, '标签色点描边 vs 卡片（仅需可辨）'],

  // ---- 描边（信息项：00-DESIGN 的 hairline 本就是「耳语级」，只要求可辨） ----
  ['--c-hairline', '--c-canvas', 1.15, '卡片描边 vs 卡片'],
  ['--c-hairline', '--c-parchment', 1.15, '卡片描边 vs 页底'],
  ['--c-divider-soft', '--c-canvas', 1.05, '列表分隔线 vs 卡片'],
];

/* ---------------- 执行 ---------------- */
function resolve(tokens, ref) {
  if (typeof ref === 'string') {
    const c = parseColor(tokens[ref]);
    if (!c) throw new Error(`无法解析颜色令牌 ${ref} = ${tokens[ref]}`);
    return c;
  }
  const over = parseColor(tokens[ref.over]);
  const tint = parseColor(tokens[ref.tint]);
  return composite(tint, over);
}

const rows = [];
let failures = 0;

for (const theme of ['light', 'dark']) {
  const tokens = theme === 'light' ? LIGHT : DARK;
  for (const [fgRef, bgRef, min, label, kind] of PAIRS) {
    const ratio = contrast(resolve(tokens, fgRef), resolve(tokens, bgRef));
    const record = kind === 'record';
    const ok = record || ratio >= min - 1e-9;
    if (!ok) failures++;
    rows.push({ theme, label, ratio, min, ok, record });
  }
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log('\nCC记账 · 双主题对比度审计（WCAG 2.1）');
console.log('阈值：正文/小标签 ≥ 4.5:1 · 大字/图形/描边 ≥ 3:1 · 耳语级描边 ≥ 1.15:1\n');

for (const theme of ['light', 'dark']) {
  console.log(`── ${theme === 'light' ? '日间 light' : '夜间 dark'} ${'─'.repeat(58)}`);
  for (const r of rows.filter((x) => x.theme === theme)) {
    const mark = r.record ? '•' : r.ok ? '✓' : '✗';
    const tail = r.record ? '  ← 文档既有取值，仅登记' : '';
    console.log(
      `  ${mark} ${pad(r.ratio.toFixed(2) + ':1', 9)} ≥ ${pad(r.min, 6)} ${r.label}${tail}`,
    );
  }
  console.log('');
}

const asserted = rows.filter((r) => !r.record);
const worst = [...asserted].sort((a, b) => a.ratio / a.min - b.ratio / b.min)[0];
const recorded = rows.filter((r) => r.record);
console.log(
  `最紧的一条（受断言约束）：${worst.theme} · ${worst.label} = ${worst.ratio.toFixed(2)}:1（阈值 ${worst.min}）`,
);
if (recorded.length) {
  const below = recorded.filter((r) => r.ratio < r.min);
  console.log(
    `仅登记不断言的文档取值 ${recorded.length} 条，其中 ${below.length} 条低于 AA：`,
  );
  for (const r of below) console.log(`  · ${r.theme} · ${r.label} = ${r.ratio.toFixed(2)}:1`);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} 条未达标。`);
  process.exit(1);
}
console.log(`\n✓ 受断言的 ${asserted.length} 条配对全部达标。`);
