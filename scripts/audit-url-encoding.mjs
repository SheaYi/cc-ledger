/**
 * URL 路径段转义审计闸门
 *
 *   npm run audit:url
 *
 * ## 为什么需要它
 *
 * **虚拟账户（债权 / 债务 / 手续费）的 id 是复合形式**：
 *   `ldg_01M4...#acc_sys_receivable`
 * 这个形态是**刻意的** —— 它让系统账户在每个账本里可以被**确定性重建**
 * （同一个账本 + 同一个 key → 同一个 id，不需要额外存映射），且天然跨账本唯一。
 * 所以 id 不能改成纯 ULID。
 *
 * 但 `#` 在 URL 里是**片段分隔符**（RFC 3986 §3.5）。不转义就拼进路径：
 *
 *   /ledgers/L/accounts/ldg_01M4...#acc_sys_receivable/balance
 *                     └──────────── 服务端只收到这段 ────────────┘
 *
 * 后果有两种，**都很隐蔽**：
 *   · `#` 在**中间** → 路由仍匹配到 `:accountId`（值被截断），
 *     然后查库查不到 → **404「账户不存在」**。错误信息把人引向
 *     「账户被删了」，而不是「URL 没转义」。这一种最坑。
 *   · `#` 后面**还有多段路径**（如 `/reconcile/preview`）→ 整段不发到服务端
 *     → **404「接口不存在」**。
 *
 * 靠"人记得转义"必然漏 —— `public/assets/api.js` 有 71 处 `seg()` 守着，
 * 但 `scripts/` 下 10 个冒烟脚本是各自手拼的。所以用静态检查兜住。
 *
 * ## 规则
 *
 * 扫描 `scripts/**\*.mjs` 与 `public/assets/**\*.js`，找出**路径模板字面量**
 * （含 `/ledgers/` 的模板字符串）里的 `${...}` 插值：
 *
 *   · 被 `encodeURIComponent(...)` / `seg(...)` 包裹 → 放行
 *   · 表达式里**出现 `id` 这个词**（`acc.id` / `ledgerId` / `firstId` / `tx.id`）
 *     且未转义 → **高危，报出来**
 *   · 其余（`day(-6)`、`query`、`${API}`、`ledgerA`…）→ 放过
 *
 * **⚠️ 先分流：本项目有两套转义机制，不能一刀切**
 *
 *   · 一部分 smoke 脚本的 call() 内部有 encodePath(path) —— 它**已经**逐段
 *     encodeURIComponent 了。这类脚本里写普通模板字符串就是对的，
 *     再加 P 标签或手工转义会造成**双重转义**（%23 → %2523，请求必然 404）。
 *   · 另一部分没有 encodePath，才需要 P 标签兜着。
 *
 * 一度没做这个分流，给已自带 encodePath 的脚本也加了 P —— smoke10 因此全挂
 * （预置模板 id 形如 ldg_…#tpl_breakfast，含 #）。而 smoke11/12 同样双重转义，
 * 却因为它们的 id 不含特殊字符而**碰巧没炸**。这种「碰巧对」比「确定错」更危险：
 * 它会让人以为闸门在起作用。所以闸门必须**先读该文件的 call() 实现**再定判据。
 *
 * 为什么只拦「含 id 词」：账本 id 一律是 ldg_ULID 形态，**不含特殊字符**，
 * 所以  这类插值天然安全；而**唯一**会带 # 的是 accounts.id
 * （虚拟账户）与 templates.id（预置模板）—— 都是复合 id。
 * 把闸门对准这一个危险源，噪声才能压到能被人读完的量级 ——
 * 一个报 361 条的闸门等于没有闸门。
 *
 * 确认无害的行用 // url-ok: <理由> 显式豁免。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIRS = ['scripts', 'public/assets'];

/** 路径模板字面量的起点 —— 必须含 `/ledgers/`，否则不是路径 */
const TEMPLATE_RE = /`[^`]*\/ledgers\/[^`]*`/g;
/** 其中所有 ${...} 插值 */
const INTERP_RE = /\$\{([^}]+)\}/g;
/**
 * 已转义的两种形态，**要分开判**：
 *   · `WRAPPED_TAG_RE` —— `P` 标签，出现在**模板前缀**（`P\`/ledgers/…\``），
 *     不在插值内部。漏了它会把所有用 P 保护的路径全判成违规。
 *   · `WRAPPED_FN_RE` —— 函数包裹，出现在**插值内部**（`seg(x)` / `qs(x)`）。
 */
const WRAPPED_TAG_RE = /(^|[^\w$])P`/;
const WRAPPED_FN_RE = /(encodeURIComponent|seg|qs)\s*\(/;
/** 显式豁免注释 */
const ALLOW_RE = /\/\/\s*url-ok:.*$/;
/**
 * 高危判据：插值表达式里出现 `id` 这个词。
 *
 * 这是**唯一**会带特殊字符的路径参数（虚拟账户复合 id 含 `#`）。
 * 账本 id 恒为 `ldg_ULID`，分类 / 标签 / 计划 / 规则的 id 都是 `xxx_ULID`，
 * 都不含 URL 保留字符 —— 所以只盯 id 不会漏，也不会淹。
 */
const HIGH_RISK_RE = /\bid\b/i;

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(name)) files.push(p);
  }
};
for (const d of DIRS) {
  try {
    walk(join(ROOT, d));
  } catch {
    /* 目录不存在，跳过 */
  }
}

const violations = [];
const skippedBySelfEscape = [];
let scanned = 0;

/**
 * 这个脚本的 `call()` 是否**自带**路径转义？
 *
 * 有的话它已经逐段 `encodeURIComponent` 了，插值不需要（也不该）再被包一层 ——
 * 双重转义会把 `%23` 变成 `%2523`，复合 id（虚拟账户 / 预置模板）必然 404。
 */
const selfEscapes = (src) => /encodePath\s*\(\s*path\s*\)/.test(src);

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const selfEscape = selfEscapes(src);
  const lines = src.split('\n');
  scanned++;

  if (selfEscape) {
    // 仍扫一遍，只为记账「这个文件有多少处插值是靠 call() 兜着的」
    let n = 0;
    for (const line of lines) {
      for (const tm of line.matchAll(TEMPLATE_RE)) {
        for (const im of tm[0].matchAll(INTERP_RE)) {
          if (HIGH_RISK_RE.test(im[1])) n++;
        }
      }
    }
    if (n) skippedBySelfEscape.push({ rel, n });
    continue;
  }

  lines.forEach((line, i) => {
    if (ALLOW_RE.test(line)) return;
    for (const tm of line.matchAll(TEMPLATE_RE)) {
      const template = tm[0];
      /**
       * `P` 标签出现在**模板前缀**（`P\`/ledgers/…\`），不在插值内部 ——
       * 所以必须按模板本身判断，不能对 `${expr}` 测 `P`（第一版就这么写的，
       * 结果所有用 P 保护的路径全被误报）。
       */
      if (/(^|[^\w$.])P$/.test(line.slice(0, tm.index))) continue;
      for (const im of template.matchAll(INTERP_RE)) {
        const expr = im[1].trim();
        if (WRAPPED_FN_RE.test(expr)) continue;
        if (!HIGH_RISK_RE.test(expr)) continue;
        violations.push({
          file: rel,
          line: i + 1,
          expr,
          text: line.trim().slice(0, 110),
        });
      }
    }
  });
}

console.log(`URL 转义审计：扫描 ${scanned} 个文件`);

if (violations.length === 0) {
  console.log('  ✓ 所有路径插值都已转义（或显式豁免）\n');
  if (skippedBySelfEscape.length) {
    const total = skippedBySelfEscape.reduce((s, x) => s + x.n, 0);
    console.log(
      `  · ${skippedBySelfEscape.length} 个脚本的 call() 自带 encodePath，` +
        `由它负责转义、不要求逐处包 P（共 ${total} 处插值）：\n`,
    );
    for (const x of skippedBySelfEscape) console.log(`      ${x.rel}  ${x.n} 处`);
    console.log();
  }
  process.exit(0);
}

// 按文件归组输出，逐条给出修法
const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

console.log(`  ✗ ${violations.length} 处未转义的路径插值：\n`);
for (const [file, list] of byFile) {
  console.log(`  ${file}  （${list.length} 处）`);
  const exprs = [...new Set(list.map((v) => v.expr))];
  console.log(`    涉及变量：${exprs.map((e) => '`' + e + '`').join('、')}`);
  console.log(
    `    修法：把 path 模板整体交给一个做转义的构造器` +
      `（\`scripts/lib/url.mjs\` 的 \`apiPath()\`），别再手拼。\n`,
  );
}

console.log(
  `  确实无害的行（插值不是 id、不会出现在真实请求里）可加注释豁免：\n` +
    `    // url-ok: <理由>\n`,
);
process.exit(1);
