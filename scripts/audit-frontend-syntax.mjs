/**
 * 前端模块语法闸门
 *
 *   npm run audit:syntax
 *
 * ## 为什么需要它（这是真实踩过的坑）
 *
 * 本项目前端**零构建**：public/assets 下的 js 由浏览器直接当 ES module 加载。
 * 于是一个语法错误的后果是：
 *
 *   · 浏览器在**模块链接阶段**就抛 SyntaxError → **整页白屏（body 全空）**
 *   · `tsc --noEmit` **不检查**它（这些文件不在 tsconfig 的 include 里）
 *   · `vitest` 不碰它（单测只跑 `src/` 的纯函数）
 *   · `scripts/audit-esm-imports.mjs` 只校验 **import/export 名字**一致，
 *     一份语法坏掉但导出名齐全的文件照样通过
 *   · 所有 smoke 都是 **API 层**，走不到前端渲染
 *
 * 换句话说：**从 build 到 14 道 smoke 全绿，中间没有任何一道会红**，
 * 而用户看到的是白屏。
 *
 * 实例：给 `views/reconciliations.js` 的模板字符串里写了一段 HTML 注释，
 * 注释里有反引号 → 模板字符串被提前闭合 → 文件语法错误。
 * 三个闸门全绿，只有 CDP 探针打开页面时才发现「等不到记录行」。
 *
 * ## 为什么用 `node --check` 的包装而不是直接 spawn
 *
 * `node --check` 只做**语法**解析，不执行、不解析 import —— 正好是我们要的：
 * 零构建前端无法被 Node 真正 import（`import './api.js'` 里的浏览器全局
 * 在 Node 下会炸），我们只要「这份文件是不是合法的 JavaScript」。
 *
 * @see scripts/audit-esm-imports.mjs —— 两者互补：那个查「名字对不对」，这个查「能不能解析」
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
/**
 * 扫描目录。
 *
 * · `public/assets` —— 零构建前端，语法错 = 白屏（本闸门的由来）。
 * · `scripts` —— 冒烟 / CDP 探针。它们**只被手动跑**，`tsc` 不看、
 *   `vitest` 不碰、`audit:imports` 也不解析 —— 于是语法错误只有在
 *   「手动跑探针」时才炸，而那次炸法往往很难一眼看出是脚本自己坏了
 *   （探针中途抛错，前面的用例照常打勾，看起来像「测试不稳定」）。
 *
 *   真实实例：给 `probe-task5-ui.mjs` 的 `ev()` 模板字符串里写了一段
 *   带反引号的注释 → 模板字符串被提前闭合 → 整个探针 SyntaxError。
 */
const DIRS = ['public/assets', 'scripts'];
/** `.js`（前端模块 / CommonJS 兼容）与 `.mjs`（本项目的探针与脚本） */
const EXTS = new Set(['.js', '.mjs']);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXTS.has(extname(p))) files.push(p);
  }
};
for (const d of DIRS) walk(join(ROOT, d));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`\n✗ ${relative(ROOT, f)}`);
    console.error(String(err.stderr ?? err.stdout ?? err.message).split('\n').slice(0, 6).join('\n'));
  }
}

if (failed) {
  console.error(
    `\n语法闸门：${failed} / ${files.length} 个文件无法被解析。` +
      `\n零构建前端里这等于白屏 —— 且 tsc / vitest / audit:imports 全都不会报。`,
  );
  process.exit(1);
}
console.log(`语法闸门：${files.length} 个模块（public/assets + scripts）全部可解析 ✓`);
