/**
 * 一次性批量改造：把脚本里的路径反引号模板换成 `P` 标签模板。
 *
 *   node scripts/migrate-to-P.mjs            # 试运行，只报告
 *   node scripts/migrate-to-P.mjs --write    # 真改
 *
 * 排除规则（宁可漏改也不能改错）：
 *   · 已经是 `P\`…\`` 的
 *   · 插值里已含 `encodeURIComponent(` / `seg(` 的（会变成双重转义）
 *   · 一行里有多个模板的（只处理单模板行，避免误伤）
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE = process.argv.includes('--write');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const files = [];
const walk = (dir) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/^smoke-.*\.mjs$/.test(n)) files.push(p);
  }
};
walk(join(ROOT, 'scripts'));

/** 匹配一个尚未被 P 前缀、且不含已转义插值的 /ledgers/ 模板 */
const TPL = /(?<!P)(?<!`)(`\/ledgers\/[^`]*`)/g;
const HAS_ESCAPED = /encodeURIComponent\s*\(|[^a-zA-Z]seg\s*\(/;

let totalChanged = 0;
const report = [];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let changed = 0;
  const skipped = [];

  const out = lines.map((line, i) => {
    const ms = [...line.matchAll(TPL)];
    if (ms.length === 0) return line;
    // 已有 P 前缀的（`` P`/ledgers/…` ``）在上面已被负向断言排除
    if (ms.length > 1) {
      skipped.push({ line: i + 1, why: '一行多个模板' });
      return line;
    }
    if (HAS_ESCAPED.test(ms[0][1])) {
      skipped.push({ line: i + 1, why: '已含转义函数，避免双重转义' });
      return line;
    }
    changed++;
    return line.replace(TPL, 'P`/ledgers/');
  });

  if (changed > 0) {
    // 加 import（放在文件首个 import 之后；没有 import 就放最前面）
    let next = out.join('\n');
    if (!/^import .*from '\.\/lib\/url\.mjs';$/m.test(next)) {
      const importLine = "import { P } from './lib/url.mjs';";
      const firstImport = next.search(/^import /m);
      if (firstImport >= 0) {
        // 插到最后一个顶层 import 之后
        const all = [...next.matchAll(/^import .*;$/gm)];
        const last = all[all.length - 1];
        next = next.slice(0, last.index + last[0].length) + '\n' + importLine + next.slice(last.index + last[0].length);
      } else {
        next = importLine + '\n' + next;
      }
    }
    if (WRITE) writeFileSync(file, next, 'utf8');
    report.push({ rel, changed, skipped });
    totalChanged += changed;
  } else if (skipped.length) {
    report.push({ rel, changed: 0, skipped });
  }
}

console.log(`${WRITE ? '已改写' : '试运行'}：${totalChanged} 处模板加了 P 前缀\n`);
for (const r of report) {
  console.log(`  ${r.rel}  改 ${r.changed} 处`);
  for (const s of r.skipped) console.log(`    ⚠️  第 ${s.line} 行未改：${s.why}`);
}
if (!WRITE) console.log('\n（加 --write 真改）');
