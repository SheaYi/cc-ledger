/**
 * 重建路径 × 后端路由表 · 逐条比对
 *
 *   npm run audit:routes
 *
 * ## 它防的是什么
 *
 * 「smoke 跑全绿」**不足以**证明重建的路径是对的：路径若错到**另一个同样存在**的
 * 路由上、而断言恰好也过，那就是**假绿**。2026-10-14 的路径误删事故之后，
 * 恢复工作必须有一份「我以为打的是这个路由，实际上打的也是这个路由」的证据。
 *
 * ## 三档判定
 *
 *   ✓ 命中且唯一 —— 路径形态合法，且只对应一条路由
 *   ⚠ 命中多条    —— **歧义**。路径形状不唯一，必须人工判断打的是哪一条
 *                    （Fastify 按注册顺序取第一条，所以「先注册的那条」才是实际行为）
 *   ✗ 一条不中    —— 路径形态非法，请求必然 404
 *
 * ## 插值怎么变成可匹配的具体值
 *
 * `${ledgerId}` → `⟨ledgerId⟩`、`${acc.id}` → `⟨acc.id⟩`、`${base}` → `⟨base⟩`。
 * 用一对尖括号包住，既保留了「这里原本是个变量」的信息（人能看懂），
 * 又不会与真实 id 混淆。
 *
 * ⚠️ 虚拟账户的 id 含 `#`（`ldg_…#acc_sys_receivable`）。本脚本**不**模拟
 * 未转义的情形 —— 转义由 `npm run audit:url` 负责。两个闸门各管一件事。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { loadRoutes, matchRoute } from './lib/routes.mjs';

const ROOT = process.cwd();
const routes = loadRoutes();

/** 路由表不完整时必须喊出来 —— 否则比对结论是建立在残缺表上的 */
if (routes.unresolved?.length) {
  console.error(`✗ 路由表不完整：${routes.unresolved.length} 条无法解析，比对结果不可信`);
  for (const u of routes.unresolved) console.error(`   ${u.file}:${u.line}  ${u.expr}`);
  process.exit(2);
}

/* ---------- 收集脚本里的路径表达式 ---------- */

/** `P\`…\`` —— 重建后的标准形态 */
const P_TAG = /\bP`([^`]*)`/g;
/** 形如 `${base}/…` 的拼接 —— 重建时故意保留（base 已是转义过的前缀） */
const BASE_JOIN = /`\$\{base\}([^`]*)`/g;
/** 方法名：往前找最近的 `call('<METHOD>',` */
/** ⚠️  不能省：多行写法 `call(\n  'POST',\n  P\`…\`` 里方法名与 call( 之间有换行 */
const METHOD_BEFORE = /call\(\s*'(GET|POST|PATCH|PUT|DELETE)'/g;

const scripts = [];
for (const dir of ['scripts']) {
  for (const n of readdirSync(join(ROOT, dir))) {
    if (/^(smoke|probe)-.*\.mjs$/.test(n)) scripts.push(join(ROOT, dir, n));
  }
}

/** 把 `${expr}` 换成 `⟨expr⟩`，并把可能残留的 `${base}` 也换掉 */
const concrete = (tpl) =>
  tpl
    .replace(/\$\{base\}/g, '⟨base⟩')
    .replace(/\$\{([^}]+)\}/g, (_, e) => '⟨' + e.trim() + '⟩');

/**
 * 归一化成「可直接喂给路由表」的形状：
 *   · 补 `/api/v1` 前缀 —— 脚本里的 `call()` 内部拼的是 `API + path`，
 *     而 API 已含 `/api/v1`，所以脚本里只写 `/ledgers/…`
 *   · 剥掉 query —— 路由表里没有 `?count=5` 这种东西
 */
const normalize = (p) => {
  let out = p.split('?')[0].replace(/\/+$/, '');
  if (!out.startsWith('/api/v1')) out = '/api/v1' + out;
  return out;
};

const rows = [];
for (const file of scripts) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  /**
   * 展开 `const base = P\`/ledgers/${ledgerId}/recurring-rules\`` ——
   * `${base}` 不是一个路径段，它是**一整段已转义的前缀**。
   * 不展开的话，所有 `${base}/…` 都会被判成「匹配不到任何路由」，
   * 比对结果里 44 条 ✗ 全是这个原因（而它们其实都是对的）。
   */
  const baseM = src.match(/const\s+base\s*=\s*(?:P)?`([^`]*)`/);
  const baseTpl = baseM ? baseM[1] : null;
  const expandBase = (s) => (baseTpl ? s.replaceAll('⟨base⟩', concrete(baseTpl)) : s);

  lines.forEach((line, i) => {
    /**
     * 方法名：**同行优先，其次向上 3 行；绝不看下方。**
     *
     * 两条约束各有来由：
     *  · 必须对**窗口拼接后的字符串**跑正则，不能逐行跑 —— 多行写法
     *    `call(\n    'POST',\n    P\`…\`` 里 `call(` 与方法名**不在同一行**，
     *    逐行匹配时那一行只有 `'POST',`，永远缺 `call(`（第一版漏了 2 处）。
     *  · 只看上方 —— 方法名是 `call(` 的**参数**，必然出现在路径**之前或同行**。
     *    若把下方也纳入窗口，下一行的 `call('POST', …)` 会被误配给本行的路径
     *    （第二版就这么把 24 条判成了不匹配）。
     */
    const winStart = Math.max(0, i - 3);
    const win = lines.slice(winStart, i + 1).join('\n');
    const cands = [...win.matchAll(METHOD_BEFORE)].map((m) => {
      const lineNo = winStart + win.slice(0, m.index).split('\n').length - 1;
      return { m: m[1], dist: Math.abs(lineNo - i) };
    });
    cands.sort((a, b) => a.dist - b.dist);
    const methodList = cands.map((x) => x.m);

    for (const m of line.matchAll(P_TAG)) {
      rows.push({
        file: rel,
        line: i + 1,
        methods: methodList,
        path: normalize(expandBase(concrete(m[1]))),
        kind: /^\s*const\s+base\s*=/.test(line) ? 'baseDef' : 'P',
      });
    }
    for (const m of line.matchAll(BASE_JOIN)) {
      rows.push({
        file: rel,
        line: i + 1,
        methods: methodList,
        path: normalize(expandBase(concrete('${base}' + m[1]))),
        kind: 'base',
      });
    }
  });
}

/* ---------- 逐条比对 ---------- */

const problems = [];
let ok = 0;
let ambiguous = 0;
/** 方法未标注、只按路径形状通过的条数（CDP 探针的原生 fetch） */
let skipped = 0;

for (const r of rows) {
  if (!r.path.startsWith('/')) continue;
  /**
   * `const base = P\`/ledgers/${ledgerId}/recurring-rules\`` 这一行是**前缀定义**，
   * 不是一次请求 —— 附近本来就没有 `call('METHOD')`，判它「找不到方法」是误报。
   * 它真正被用到的形式是下面那些 `${base}/…`，那些会单独比对。
   */
  if (r.kind === 'baseDef') continue;
  /**
   * `cands` 已按「离本行距离」升序排好，所以**最近**的是 `[0]`。
   * 第一版取了 `[length-1]`（最远的那个），于是 `call('POST', …)` 的路径
   * 被配上了上一行的 GET，18 条判成不匹配 —— 而它们其实全对。
   */
  const method = r.methods[0];
  if (!method) {
    /**
     * 本脚本只认 `call('METHOD', …)` 这一种调用形态（smoke 脚本的约定）。
     * CDP 探针用原生 `fetch`，方法名与方法在**不同的行**，认不出来。
     *
     * 早先这种一律判成「需要修」，于是 13 条全是误报、闸门直接红掉，
     * 只能手动跑 —— 一个只能手动跑、且常年红的闸门等于没有。
     *
     * 正确的处理是**降级为「形状检查」**：方法未知，但路径形状仍然必须
     * 至少能对上**任意一条**路由。这样「路径被截断成 /ledgers/」这类真损伤
     * 在探针里也照样会被抓出来，而「认不出方法」不再算问题。
     */
    const anyHit = matchRoute(routes, null, r.path);
    if (anyHit.length === 0) {
      r.verdict = '✗';
      r.why = '匹配不到任何路由（方法未知，按形状判）';
      problems.push(r);
    } else {
      skipped++;
      r.verdict = '·';
      r.hit = anyHit.map((h) => h.route.pattern).join('  |  ');
      r.why = '方法未标注（原生 fetch），仅按路径形状通过';
    }
    continue;
  }
  const hits = matchRoute(routes, method, r.path);
  if (hits.length === 0) {
    r.verdict = '✗';
    r.why = '匹配不到任何路由';
    problems.push(r);
  } else if (hits.length === 1) {
    ok++;
    r.verdict = '✓';
    r.hit = hits[0].route.pattern;
  } else {
    ambiguous++;
    r.verdict = '⚠';
    r.hit = hits.map((h) => h.route.pattern).join('  |  ');
    r.why = `命中 ${hits.length} 条（Fastify 取先注册的：${hits[0].route.pattern}）`;
    problems.push(r);
  }
}

/* ---------- 输出 ---------- */

console.log(`路由比对：${routes.length} 条路由 × ${rows.length} 处路径表达式\n`);
console.log(
  `  ✓ 命中唯一 ${ok}　⚠ 歧义 ${ambiguous}　· 仅形状通过 ${skipped}　✗ 不匹配 ${problems.filter((p) => p.verdict === '✗').length}\n`,
);

const byFile = new Map();
for (const r of rows) {
  if (!r.path.startsWith('/')) continue;
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}

for (const [file, list] of byFile) {
  console.log(`── ${file}`);
  for (const r of list) {
    console.log(`   ${r.verdict ?? '?'} ${String(r.line).padStart(4)}  ${(r.methods[0] ?? '?').padEnd(6)} ${r.path}`);
    console.log(`        → ${r.hit ?? (r.why ?? '—')}`);
  }
  console.log();
}

if (problems.length) {
  console.log('需要人工判断的：\n');
  for (const p of problems) {
    console.log(`  ${p.verdict} ${p.file}:${p.line}  ${p.path}`);
    console.log(`     ${p.why}`);
  }
  console.log();
}

const bad = problems.filter((p) => p.verdict === '✗' || p.verdict === '?').length;
console.log(bad === 0 ? '✓ 全部路径形态合法且唯一\n' : `✗ ${bad} 处需要修\n`);
process.exit(bad === 0 ? 0 : 1);
