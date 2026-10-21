/**
 * 后端路由表解析 + 路径匹配
 *
 * ## 为什么需要它
 *
 * 2026-10-14 的路径误删事故之后，重建工作不能只靠「跑 smoke 全绿」当证据 ——
 * 路径若错到**另一个同样存在**的路由上、断言又恰好过，就是**假绿**。
 * 所以必须能回答一个具体问题：
 *
 *   「这条路径实际命中了哪个路由？和我重建时以为的那个，是同一个吗？」
 *
 * 这要求先把后端路由表**完整**抽出来。注意 `recurring` / `installment` 的路由是
 * 多行注册的：
 *
 *     app.post(
 *       '/api/v1/ledgers/:ledgerId/recurring-rules/:id/run-now',
 *       { preHandler: ... }, async (req) => { ... });
 *
 * 单行正则会漏掉一半 —— 而漏掉的恰好是最近新增的模块，比漏掉老模块更危险。
 *
 * ## 用法
 *
 *     import { loadRoutes, matchRoute } from './routes.mjs';
 *     const routes = loadRoutes();
 *     const hit = matchRoute(routes, 'GET', '/api/v1/ledgers/L1/accounts/A1/balance');
 *     // → { route, params }
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** 只扫这些目录：路由都在模块的 index.ts 与 app.ts 里 */
const SCAN = ['src/modules', 'src'];

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 抓 `app.<method>(` 之后的**第一个参数表达式**（到逗号或换行为止）。
 *
 * ⚠️ 不能只匹配字符串字面量 —— `recurring` / `installment` 两个模块是
 * **用常量拼路径**注册的：
 *
 *     const base = '/api/v1/ledgers/:ledgerId/recurring-rules';
 *     app.get(base, …)
 *     app.post(`${base}/:ruleId/pause`, …)
 *
 * 只认字面量的话，这两个模块的路由**一条都抽不到**（我实测：71 条里 installment
 * 只有 1 条、recurring 是 0 条）。路由表不完整，后面「重建路径 vs 路由表」的
 * 比对就成了**假保证** —— 比对必须建立在完整的表上。
 */
const ROUTE_RE = /app\.(get|post|patch|put|delete)\(\s*([^,\n]+)/g;

/** 文件内的字符串常量绑定：`const base = '…'` 或反引号（可含 `${other}` 插值） */
const CONST_RE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'([^']*)'|`([^`]*)`)/g;

/**
 * 收齐文件内的字符串常量（多趟，处理常量引用常量）。
 *
 * ⚠️ 这里**不能**复用 `resolveExpr` —— 它接收的是「带引号的表达式」，
 * 而正则已经把钱引号剥掉了。把裸内容喂给它会三个分支全不匹配，
 * 结果一个常量都收不到（我踩过：71 条路由里 recurring 抽到 0 条，
 * 而 `unresolved` 悄悄涨到 30 —— 路由表不完整却没有任何报错）。
 */
function collectConsts(src) {
  const consts = {};
  for (let pass = 0; pass < 3; pass++) {
    CONST_RE.lastIndex = 0;
    const before = Object.keys(consts).length;
    let m;
    while ((m = CONST_RE.exec(src))) {
      const raw = m[2] ?? m[3];
      if (raw === undefined) continue;
      const val = raw.replace(/\$\{(\w+)\}/g, (_, n) => consts[n] ?? `\${${n}}`);
      // 解不干净（引用了未知常量）就不收，宁缺毋错
      if (!val.includes('${')) consts[m[1]] = val;
    }
    if (Object.keys(consts).length === before) break;
  }
  return consts;
}

/** 把 `app.x(<expr>)` 的 expr 求成字面路径（能解常量与 `${base}` 拼接） */
function resolveExpr(expr, consts) {
  let e = expr.trim().replace(/\s+/g, ' ');
  // 纯标识符
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return consts[e] ?? null;
  // 反引号模板：逐个替换 ${name}
  if (e.startsWith('`') && e.endsWith('`')) {
    let out = e.slice(1, -1);
    out = out.replace(/\$\{(\w+)\}/g, (_, n) => consts[n] ?? `\${${n}}`);
    // 解完后仍有未解析的插值 → 放弃（宁可少一条，也不要错的）
    return out.includes('${') ? null : out;
  }
  // 单引号字面量
  if (e.startsWith("'") && e.endsWith("'")) return e.slice(1, -1);
  return null;
}

export function loadRoutes() {
  const files = new Set([...walk(join(ROOT, 'src/modules')), ...walk(join(ROOT, 'src'))]);
  const routes = [];
  const unresolved = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (!/modules\/[^/]+\/index\.ts$|^src[\\/]app\.ts$/.test(rel)) continue;
    const src = readFileSync(file, 'utf8');
    const consts = collectConsts(src);

    ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = ROUTE_RE.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      const pattern = resolveExpr(m[2], consts);
      if (!pattern || !pattern.startsWith('/')) {
        unresolved.push({ file: rel, line, expr: m[2].trim().slice(0, 60) });
        continue;
      }
      routes.push({
        method: m[1].toUpperCase(),
        pattern,
        module: rel.match(/modules\/([^/]+)\//)?.[1] ?? 'app',
        file: rel,
        line,
      });
    }
  }
  routes.sort((a, b) => a.module.localeCompare(b.module) || a.pattern.localeCompare(b.pattern));
  // 未解析出来的路由表达式挂在表上，让调用方能看见「表不完整」而不是被蒙在鼓里
  routes.unresolved = unresolved;
  return routes;
}

/**
 * 把路由模板编译成匹配器。
 * `:param` 匹配单个路径段（不含 `/`）；`*` 匹配剩余全部。
 */
export function patternToRegExp(pattern) {
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '([^/]+)';
      if (seg === '*') return '(.*)';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp('^' + escaped + '$');
}

const cache = new Map();

/**
 * 在路由表里找出一条实际路径命中的路由。
 *
 * 返回**全部**命中项而不是第一个 —— 因为「同时匹配多条路由」本身就是危险信号
 * （Fastify 会按注册顺序取第一条，但我们重建时应该知道自己撞上了哪几条）。
 */
/**
 * 把一条实际路径配到路由表上。
 *
 * `method` 传 `null` = **不限方法**，只按路径形状匹配。
 * 这是给「认不出调用方法」的场合（CDP 探针用原生 fetch，方法与方法名不在同一行）
 * 留的降级通道：形状仍然必须至少对上一条路由，否则就是真损伤。
 */
export function matchRoute(routes, method, actualPath) {
  const want = method === null || method === undefined ? null : method.toUpperCase();
  const hits = [];
  for (const r of routes) {
    if (want !== null && r.method !== want) continue;
    if (!cache.has(r.pattern)) cache.set(r.pattern, patternToRegExp(r.pattern));
    const m = cache.get(r.pattern).exec(actualPath);
    if (!m) continue;
    const params = {};
    const names = r.pattern.split('/').filter((s) => s.startsWith(':'));
    names.forEach((n, i) => (params[n.slice(1)] = m[i + 1]));
    hits.push({ route: r, params });
  }
  return hits;
}

/* ---------- 直接执行时打印路由表（人工核对用） ---------- */
if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  const routes = loadRoutes();
  const byModule = new Map();
  for (const r of routes) {
    if (!byModule.has(r.module)) byModule.set(r.module, []);
    byModule.get(r.module).push(r);
  }
  console.log(`路由表：共 ${routes.length} 条\n`);
  for (const [mod, list] of byModule) {
    console.log(`── ${mod}（${list.length}）`);
    for (const r of list) console.log(`   ${r.method.padEnd(7)} ${r.pattern}`);
    console.log();
  }
}
