#!/usr/bin/env node
/**
 * `audit:schema` —— 校验 `src/db/schema.ts` 与实际 SQLite 数据库一致。
 *
 * ## 为什么需要这道闸门
 *
 * 本项目**零构建**地跑 TypeScript 后端，schema 的唯一真实来源是 `schema.ts`，
 * 而迁移是**手工写的 SQL**。两者一旦漂移，后果不是编译错误而是运行期错误：
 * drizzle 生成的 `SELECT` 会引用一个库里不存在的列，SQLite 报
 * `no such column`，而这个错误出现在**用户点开页面时**，不在 CI 里。
 *
 * 更隐蔽的一类：**迁移加了列但 `schema.ts` 没声明**。
 * 应用跑得好好的（SQL 用 `db.prepare` 也能用），但**任何 `select()` 都读不到它** ——
 * 新功能会以为自己写好了，值永远是 undefined，而且没有任何报错。
 * 我在本次开发中就踩过一次：`credit_limit` / `billing_day` 早已存在于
 * `accounts`，我按 FRD 又加了一遍，属于同一语义两个列名。
 *
 * ## 查什么
 *
 * ① 每张 `sqliteTable` 声明的列，库里的 `PRAGMA table_info` 必须都有（少 → 迁移没跑）
 * ② 库里属于本项目表的列，`schema.ts` 必须声明（多 → 声明漏了，写代码会拿到 undefined）
 * ③ journal 里登记的迁移文件必须存在且 SQL 段无空段（否则迁移器会报
 *    "contains no statements"，错误信息完全指不到真正的原因）
 * ④ `__drizzle_migrations` 里**最后一条**的 created_at 必须 ≥ journal 最大的 when。
 *    Drizzle 只查 `ORDER BY created_at DESC LIMIT 1` 再比大小，**hash 不参与判重** ——
 *    这一条曾经让所有迁移被判为「未执行」而重跑 ALTER，报 duplicate column。
 *
 * 库路径取 `data/cc-ledger.db`；不存在时跳过（首次安装还没建库是正常的）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// 用 fileURLToPath + resolve(dirname, '..')，与既有 audit 脚本（audit-esm-imports）
// 保持一致。写成 `resolve(path.dirname(url), '..', '..')` 会多退一层，
// 报出来的错误是「所有表都缺失」—— 完全指不到真正的原因（路径多了一级）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, 'data', 'cc-ledger.db');

if (!existsSync(DB_PATH)) {
  console.log(`ℹ 数据库不存在（${DB_PATH}），跳过 schema 一致性校验`);
  process.exit(0);
}

/* ---------- 解析 schema.ts ---------- */
const schemaSrc = readFileSync(path.join(ROOT, 'src', 'db', 'schema.ts'), 'utf8');
const tableRe = /export const (\w+) = sqliteTable\(\s*'([a-z_]+)'/g;
const tables = [];
let m;
while ((m = tableRe.exec(schemaSrc))) tables.push({ const: m[1], table: m[2], at: m.index });

const problems = [];
const declaredCols = new Map();
/** 列类型：schema.ts 里的 \`text('x')\` / \`integer('x')\` 构造器名即 SQLite 类型 */
const declaredColTypes = new Map();
for (let i = 0; i < tables.length; i++) {
  const start = tables[i].at;
  const end = i + 1 < tables.length ? tables[i + 1].at : schemaSrc.length;
  const block = schemaSrc.slice(start, end);
  // 列定义形如 `fieldName: text('snake_name')`，**必须冒号开头**。
  // 只按 `\w+('x')` 匹配会一并抓到索引名（uniqueIndex('idx_xxx')）
  // 与外键指向的表名（references(() => users.id)），把真实列误报成缺失。
  //
  // 缩进要放宽到 2~4 空格：`budget_prefs` 用的是单行
  // `sqliteTable('budget_prefs', { ledgerId: ... })` 写法，缩进只有 2。
  // 写成 `^\s{4}` 会把整张表判成「一列都没声明」。
  const cols = new Set();
  const types = new Map();
  for (const c of block.matchAll(/^\s{2,4}(\w+):\s*(integer|text|real|blob)\(\s*'([a-z][a-z0-9_]*)'/gm)) {
    cols.add(c[3]);
    types.set(c[3], c[2]);
  }
  declaredCols.set(tables[i].table, cols);
  declaredColTypes.set(tables[i].table, types);
}

const db = new Database(DB_PATH, { readonly: true });
/**
 * ⚠️ `_` 在 LIKE 里是**单字符通配符**，不是字面下划线。
 * 所以 `name NOT LIKE '__%'` 匹配的是「任意以两个字符开头、长度 ≥2 的名字」，
 * 结果是**所有表都被排掉**（42 张表读成 0 张），
 * 而报错看起来完全合理：「所有表都缺失，迁移未执行」。
 *
 * `ESCAPE '\'` 让 `_` 与 `%` 恢复字面含义。
 */
const dbTables = new Set(
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite@_%' ESCAPE '@' " +
        "AND name NOT LIKE '@@%' ESCAPE '@'",
    )
    .all()
    .map((r) => r.name),
);
if (dbTables.size === 0) {
  console.error('✗ 读到 0 张表 —— 这几乎总是过滤条件把表全排掉了，而不是库真的空');
  process.exit(1);
}

/* ---------- ① 声明的列库里必须都有 ---------- */
/**
 * 列类型也一起比。
 * 只比「列在不在」不够：把 `scope text` 加成 `scope integer` 时列名全对，
 * 应用跑得好好的（SQLite 弱类型不报错），但字符串写进去会被存成 NULL ——
 * 症状是「筛选按 scope 过滤永远查不到东西」。
 */
const TYPE_OK = new Set(['integer', 'text', 'real', 'blob']);
for (const { table } of tables) {
  if (!dbTables.has(table)) {
    problems.push(`声明了表 ${table} 但库里没有 —— 迁移未执行`);
    continue;
  }
  const info = db.prepare(`PRAGMA table_info("${table}")`).all();
  const actual = new Map(info.map((r) => [r.name, r.type.toLowerCase()]));
  const declaredTypes = declaredColTypes.get(table) ?? new Map();
  for (const c of declaredCols.get(table) ?? []) {
    if (!actual.has(c)) {
      problems.push(`${table}.${c}：schema.ts 声明了但库里没有`);
      continue;
    }
    const want = declaredTypes.get(c);
    const got = actual.get(c);
    if (want && TYPE_OK.has(got) && want !== got) {
      problems.push(
        `${table}.${c}：类型不一致 —— schema.ts 声明 ${want}，库里是 ${got}。` +
          `SQLite 弱类型不会报错，但写进去的值会被默默转换`,
      );
    }
  }
}

/* ---------- ② 库里的列 schema.ts 必须声明 ---------- */
for (const table of dbTables) {
  if (!declaredCols.has(table)) continue; // 未在 schema.ts 声明的表不在本项目管辖内
  const actual = db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
  for (const c of actual) {
    if (!declaredCols.get(table).has(c)) {
      problems.push(`${table}.${c}：库里有但 schema.ts 没声明 —— 用 select() 读它永远是 undefined`);
    }
  }
}

/* ---------- ③ 迁移文件的段完整性 ---------- */
const journalPath = path.join(ROOT, 'drizzle', 'meta', '_journal.json');
if (existsSync(journalPath)) {
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  let maxWhen = 0;
  for (const e of journal.entries) {
    maxWhen = Math.max(maxWhen, e.when);
    const f = path.join(ROOT, 'drizzle', `${e.tag}.sql`);
    if (!existsSync(f)) {
      problems.push(`journal 登记了 ${e.tag} 但文件不存在`);
      continue;
    }
    const q = readFileSync(f, 'utf8');
    const segs = q.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    // 去掉纯注释行后仍应剩下可执行语句
    const empty = segs.filter((s) => !s.replace(/^(\s*--.*\n?)+/g, '').trim());
    if (empty.length) {
      problems.push(
        `${e.tag} 有 ${empty.length} 个空段（纯注释）—— 迁移器会报 "contains no statements"，` +
          `且报错完全不指向「注释放在了分隔符之后」`,
      );
    }
    // 第一段必须含可执行语句（文件必须以 SQL 开头）
    if (segs.length && !segs[0].replace(/^(\s*--.*\n?)+/g, '').trim()) {
      problems.push(`${e.tag} 第一段是纯注释 —— drizzle 按分隔符切段后它会单独被执行并失败`);
    }
    /**
     * ⑤ SQLite 的一个静默陷阱：`ALTER TABLE ADD COLUMN x NOT NULL DEFAULT v`
     * 对**已有行不生效**（它们的值是 NULL），而**新插入的行必须显式给值**。
     * 症状是「加列之后一切正常，直到某个不写该列的 INSERT 报
     * NOT NULL constraint failed」—— 本项目这次就撞上了：
     * `accounts.reconcile_remind_days NOT NULL DEFAULT 3` 让注册接口整体 500，
     * 而报错栈指向 seed 代码，完全看不出是迁移造成的。
     *
     * 规则：给已有表加列一律用可空列，默认值在应用层 `?? 兜底`。
     */
    for (const seg of segs) {
      const m = /^ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+`?(\w+)`?\s+[^;]*?\bNOT\s+NULL\b/i.exec(seg);
      if (m) {
        problems.push(
          `${e.tag} 给已有表 ${m[1]} 加的列 ${m[2]} 是 NOT NULL —— ` +
            `SQLite 不会给已有行填默认值，而新行必须显式给值；请改为可空列 + 应用层兜底`,
        );
      }
    }
  }

  /* ---------- ④ Drizzle 的判重只看最后一条的 created_at ---------- */
  const last = db.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get();
  if (!last) {
    problems.push('__drizzle_migrations 是空的 —— 迁移从未成功执行过');
  } else if (Number(last.created_at) < maxWhen) {
    problems.push(
      `__drizzle_migrations 最后一条 created_at=${last.created_at} < journal 最大 when=${maxWhen} —— ` +
        `Drizzle 只比对这两者（hash 不参与），会把所有迁移判为「未执行」并重跑 ALTER`,
    );
  }
} else {
  problems.push('drizzle/meta/_journal.json 不存在');
}

db.close();

if (!problems.length) {
  console.log(`✓ schema 一致性通过：${tables.length} 张表声明、${dbTables.size} 张表存在、迁移段完整且判重键有效`);
  process.exit(0);
}
console.error(`✗ schema 一致性发现 ${problems.length} 处问题：`);
for (const p of problems) console.error(`  · ${p}`);
process.exit(1);