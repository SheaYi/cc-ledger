/**
 * 侧栏图标名闸门：`NAV_ICONS` 里每个名字都必须在 `ui.js` 的 `PATHS` 里有定义。
 *
 * ## 为什么需要它
 *
 * `icon(name)` 在名字不存在时**返回空字符串**（不是抛错、不回退问号）：
 * `const p = PATHS[name]; if (!p) return '';`
 *
 * 于是新增一个导航项时打错图标名（或用了 lucide 独有的名字），
 * 界面上的表现是「这一项没有图标」，而：
 *   · 没有任何报错
 *   · `audit:syntax` / `audit:imports` / `audit:routes` 全绿
 *   · `tsc --noEmit` 不看 public/
 *   · 甚至**已有测试也可能全绿**（除非恰好断言了图标存在）
 *
 * 本项目就被咬过：`handshake` / `copy` / `calendar` 三个名字在 `PATHS` 里不存在，
 * 「往来 / 模板 / 周期账单」三项**全都没有图标**，而十几道闸门一路放行。
 *
 * 与「两套图标库别混用」是同一条纪律的具体化 ——
 * 侧栏走 `icon()`（`PATHS`），别处走 `lucide()`（`LUCIDE`），两套表互不相通。
 */
import fs from 'node:fs';

const ui = fs.readFileSync('public/assets/ui.js', 'utf8');
const chrome = fs.readFileSync('public/assets/chrome.js', 'utf8');

/** 从 `const PATHS = {` 里取出所有 key（支持带引号的 kebab-case） */
const pathsBlock = ui.match(/const PATHS = \{([\s\S]*?)\n\};/);
if (!pathsBlock) {
  console.error('✗ 没能从 ui.js 找到 PATHS 定义');
  process.exit(1);
}
const available = new Set(
  [...pathsBlock[1].matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:/gm)].map((m) => m[1]),
);

/** 从 `const NAV_ICONS = {` 里取出所有 key → value */
const navBlock = chrome.match(/const NAV_ICONS = \{([\s\S]*?)\n\};/);
if (!navBlock) {
  console.error('✗ 没能从 chrome.js 找到 NAV_ICONS 定义');
  process.exit(1);
}
const used = [...navBlock[1].matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:\s*'([a-z][a-z0-9-]*)',/gm)].map(
  (m) => ({ key: m[1], icon: m[2] }),
);

/** 侧栏还直接用到几个不在 NAV_ICONS 里的名字（CTA 等） */
const inline = [...chrome.matchAll(/\bicon\('([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);

console.log(`侧栏图标闸门：PATHS ${available.size} 个名字 · 导航引用 ${used.length} 项`);

const missing = [];
for (const u of used) {
  if (!available.has(u.icon)) missing.push(`NAV_ICONS.${u.key} → '${u.icon}'`);
}
for (const i of new Set(inline)) {
  if (!available.has(i)) missing.push(`内联 icon('${i}')`);
}

if (!missing.length) {
  console.log('  ✓ 全部图标名都有定义（不会静默渲染成「没有图标」）');
  process.exit(0);
}
for (const m of missing) console.log(`  ✗ ${m} —— PATHS 里没有这个名字`);
console.log('\n修法：在 ui.js 的 PATHS 里补一份 SVG path（侧栏不用 lucide 的名字）。');
process.exit(1);
