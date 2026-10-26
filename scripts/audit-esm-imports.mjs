#!/usr/bin/env node
/**
 * ESM 导入 / 导出一致性闸门（前端零构建的"编译器"）
 *
 * 为什么必须有这个脚本：
 *   前端是**零构建**的原生 ES Module，由 Fastify 直接托管。`node --check` 只做语法解析、
 *   `tsc` 管不到 `public/` —— 一旦某个视图写错导入名（例如从 `lib/tx-format.js` 取一个
 *   它并不导出的 `RECORD_TYPE_LABEL`），浏览器会在**模块链接阶段**整个 SPA 抛
 *   `SyntaxError: The requested module '...' does not provide an export named '...'`，
 *   表现为**整页白屏、body 全空**，而所有既有闸门（tsc / vitest / smoke / 对比度）全绿。
 *   这个脚本就是为了让这一类错误在 CI 里当场现形。
 *
 * 覆盖：
 *   · `import { a, b as c } from './x.js'`  → 逐名核对被导入模块是否导出 a / b
 *   · `import * as ns from` / 默认导入    → 只核对模块可解析
 *   · `export { a, b }`（含 `as`）        → 计入本模块的导出集
 *   · `export { a } from './x.js'`        → 既核对来源、也计入本模块导出（转发）
 *   · `export * from './x.js'`            → 计入「通配来源」，命名解析时穿透一层
 *   · 可达性：从 `public/index.html` 的入口脚本出发做 BFS，报告**没有任何入口引用**的孤儿模块
 *
 * 用法：node scripts/audit-esm-imports.mjs [publicDir]
 * 退出码非 0 表示存在不一致。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PUBLIC_DIR = resolve(ROOT, process.argv[2] ?? 'public');

/** 递归收集 .js 文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 只剥注释、**保留字符串字面量**。
 *
 * 一开始写成"注释和字符串一起剥"，结果模块说明符 `from './x.js'` 也被剥掉，
 * 正则一条 import 都匹配不到、脚本假绿 —— 扫描到 0 条 import 就是它的症状。
 * 字符串必须留着（说明符在里面），但剥注释时要能识别"字符串里的 // 不是注释"，
 * 所以这里是有状态的单遍扫描，不能用简单的 replace。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === q) {
          i++;
          break;
        }
        if (src[i] === '\n' && q !== '`') break; // 未闭合的引号，别把后面整段吞掉
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 从源码提取 { imports, exports, reExports, exportStars } */
function analyze(path) {
  const raw = readFileSync(path, 'utf8');
  const code = stripComments(raw);
  const imports = []; // { spec, names: [string], kind }
  const exports = new Set();
  const reExports = []; // { spec, names }
  const exportStars = []; // spec

  const addExportList = (list, into) => {
    for (const part of list.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
      into.add(asMatch ? asMatch[2] : t);
    }
  };

  // import ... from '...'
  const importRe = /\bimport\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(code))) {
    const clause = m[1].trim();
    const spec = m[2];
    const named = /\{([\s\S]*?)\}/.exec(clause);
    const names = [];
    if (named) {
      for (const part of named[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
        names.push(asMatch ? asMatch[1] : t); // 核对**来源**导出的名字
      }
    }
    imports.push({ spec, names, kind: named ? 'named' : 'star-or-default' });
  }
  // 副作用导入 import './x.js'
  for (const s of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    imports.push({ spec: s[1], names: [], kind: 'side-effect' });
  }

  /**
   * 动态导入 `await import('./x.js')`。
   *
   * 不识别它的后果是**误报孤儿**：只在紧凑形态才加载的 `views/mobile-home.js`
   * 会被算成「没有任何入口引用」，而它其实被 `views/overview.js` 按需 import。
   * 名字照常核对（动态 import 也支持 `{ named }` 解构），因为这是对另一种用法
   * 的同一个不变式：「导入的名字必须真的存在」。
   */
  for (const s of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ spec: s[1], names: [], kind: 'dynamic' });
  }

  // export { a, b as c } [from '...']
  const exportRe = /\bexport\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
  while ((m = exportRe.exec(code))) {
    if (m[2]) {
      const names = [];
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
        names.push(asMatch ? asMatch[1] : t);
      }
      reExports.push({ spec: m[2], names });
    }
    addExportList(m[1], exports);
  }

  // export * from '...'
  for (const s of code.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) exportStars.push(s[1]);

  // export function/const/let/var/class/async function
  for (const s of code.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))
    exports.add(s[1]);
  // export default
  if (/\bexport\s+default\b/.test(code)) exports.add('default');

  return { path, imports, exports, reExports, exportStars, code };
}

const files = walk(PUBLIC_DIR);
const mods = new Map(); // absPath -> info
for (const f of files) mods.set(resolve(f), analyze(f));

const problems = [];
const resolvedSpec = (fromPath, spec) => {
  if (!spec.startsWith('.')) return null; // 远端 / 裸模块，跳过
  const base = resolve(dirname(fromPath), spec);
  const cands = [base];
  if (!base.endsWith('.js')) cands.push(base + '.js', join(base, 'index.js'));
  for (const c of cands) if (mods.has(resolve(c))) return resolve(c);
  return { missing: base };
};

/** 收集一个模块对外的全部可见名字（穿透 export * 一层，够用且避免环上死循环） */
function visibleNames(path, seen = new Set()) {
  if (seen.has(path)) return new Set();
  seen.add(path);
  const info = mods.get(path);
  if (!info) return new Set();
  const names = new Set(info.exports);
  for (const spec of info.exportStars) {
    const target = resolvedSpec(path, spec);
    if (target && target.missing === undefined) {
      for (const n of visibleNames(target, seen)) names.add(n);
    }
  }
  return names;
}

for (const [path, info] of mods) {
  const rel = relative(ROOT, path).replace(/\\/g, '/');

  for (const imp of info.imports) {
    const target = resolvedSpec(path, imp.spec);
    if (target === null) continue; // 裸模块
    if (target.missing !== undefined) {
      problems.push(`${rel}: 无法解析模块 '${imp.spec}'（找过 ${relative(ROOT, target.missing).replace(/\\/g, '/')}.js）`);
      continue;
    }
    if (!imp.names.length) continue;
    const avail = visibleNames(target);
    const lack = imp.names.filter((n) => !avail.has(n));
    if (lack.length) {
      problems.push(
        `${rel}: 从 '${imp.spec}' 导入了未导出的 ${lack.map((n) => `\`${n}\``).join('、')}`,
      );
    }
  }

  for (const re of info.reExports) {
    const target = resolvedSpec(path, re.spec);
    if (target === null) continue;
    if (target.missing !== undefined) {
      problems.push(`${rel}: export ... from '${re.spec}' 无法解析`);
      continue;
    }
    const avail = visibleNames(target);
    const lack = re.names.filter((n) => !avail.has(n));
    if (lack.length)
      problems.push(`${rel}: 转发导出了 '${re.spec}' 里没有的 ${lack.map((n) => `\`${n}\``).join('、')}`);
  }
}

/* --------- 可达性：从 index.html 的入口出发 BFS --------- */
const indexHtml = join(PUBLIC_DIR, 'index.html');
const entries = [];
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, 'utf8');
  for (const s of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
    const u = s[1];
    if (u.startsWith('http') || u.startsWith('//')) continue;
    const p = resolve(PUBLIC_DIR, u.replace(/^\//, ''));
    if (mods.has(p)) entries.push(p);
  }
}
const reachable = new Set();
const queue = [...entries];
while (queue.length) {
  const cur = queue.pop();
  if (reachable.has(cur) || !mods.has(cur)) continue;
  reachable.add(cur);
  for (const imp of mods.get(cur).imports) {
    const t = resolvedSpec(cur, imp.spec);
    if (t && t.missing === undefined) queue.push(t);
  }
}
const orphans = [...mods.keys()].filter((p) => !reachable.has(p)).map((p) => relative(ROOT, p).replace(/\\/g, '/'));

/* --------- 输出 --------- */
const totalImports = [...mods.values()].reduce((n, i) => n + i.imports.length, 0);
console.log(`扫描 ${mods.size} 个模块 · ${totalImports} 条 import · 入口 ${entries.length} 个`);

if (orphans.length) {
  console.log(`\n⚠ 无入口引用的模块（${orphans.length}）：`);
  for (const o of orphans) console.log('   ·', o);
} else {
  console.log('✓ 无孤儿模块');
}

if (problems.length) {
  console.log(`\n✗ 导入导出不一致 ${problems.length} 处：`);
  for (const p of problems) console.log('   ·', p);
  process.exit(1);
}
console.log('\n✓ 全部 import / export 名一致，且所有相对模块均可解析。');
