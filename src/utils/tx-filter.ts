/**
 * 账单关键字过滤 —— **全站唯一的出口**。
 *
 * ## 为什么要抽出来
 *
 * 关键字筛选散落在多处时，最典型的失效方式是「**前端把参数发出去了，
 * 后端大多数接口都忘了接**」：页面不报错、参数也确实在 URL 上，
 * 但所有卡片数字纹丝不动 —— 用户只会得出「搜索框坏了」的结论。
 * （统计页的搜索框就是这样静默失效了很久：`stats/*` 里只有
 * `drilldown` 与 `export.csv` 认 `keyword`，`summary`/`trend`/`by-category`
 * 全部忽略它。）
 *
 * 所以口径只写一次，各处一律调它：新接一个筛选维度时不会再漏。
 *
 * ## 命中字段
 *
 * `name` / `merchant` / `counterparty` / `note` 四列，与**账单列表页**
 * （`transactions/service.ts: listTransactions`）完全一致 ——
 * 两处口径不同会让用户发现「卡片说 12 笔，点进列表只有 7 笔」。
 *
 * ## 大小写与空格
 *
 *   · **大小写**：SQLite 的 `LIKE` 对 ASCII 默认**不敏感**
 *     （除非 `PRAGMA case_sensitive_like=ON`），所以 `abc` 能命中 `ABC`；
 *     中文没有大小写，不受影响。这里**不要**再用 `lower()` 包一层，
 *     那会让中文查询走上 `lower()` 的 ASCII 折叠路径，白花开销。
 *   · **空格**：首尾空白由前端 `trim()` + 此处再 `trim()` 双重兜底。
 *     中间的空格是**用户输入的一部分**，必须原样保留 ——
 *     把 `'楼下 食堂'` 里的空格去掉再查，会命中另一笔账。
 *   · **空值**：空串/纯空白返回 `undefined`（= 不加条件），
 *     而不是 `%` 这个「匹配一切」的通配串 —— 否则「清空搜索框」
 *     会被当成「搜索 `%`」，看起来仍像筛选生效了。
 */
import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { transactions } from '../db/schema.js';

/**
 * 转义 LIKE 通配符。
 *
 * ⚠️ 用户搜索 `a_b` 时，`_` 是「任意单字符」，会连 `axb` 一起命中；
 * 搜 `50%` 时 `%` 会匹配整行 —— 结果是「搜一个词，出来一堆不相干的」。
 * 转义后统一用 `ESCAPE '\'` 还原成字面量。
 */
export function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 关键字条件：`name / merchant / counterparty / note` 任一命中即算。
 *
 * @param keyword 原始输入；空值或纯空白返回 `undefined`（不加条件）
 * @returns 可直接塞进 `and(...)` 的 SQL 条件，或 `undefined`
 */
export function keywordCondition(keyword?: string | null): SQL | undefined {
  const kw = (keyword ?? '').trim();
  if (!kw) return undefined;
  const like = `%${escapeLike(kw)}%`;
  return or(
    sql`${transactions.name} LIKE ${like} ESCAPE '\\'`,
    sql`${transactions.merchant} LIKE ${like} ESCAPE '\\'`,
    sql`${transactions.counterparty} LIKE ${like} ESCAPE '\\'`,
    sql`${transactions.note} LIKE ${like} ESCAPE '\\'`,
  );
}

/* ------------------------------------------------------------------ *
 * 账户 / 分类 / 类型 三维筛选 —— 全站唯一的出口
 * ------------------------------------------------------------------ */

/**
 * 筛选维度。所有统计接口共用同一份口径，避免「前端发了参数、后端漏接」的静默失效。
 *
 * - `accountId`：命中 source `accountId` **或** destination `toAccountId`
 *   （转账的对方账户也算「这笔账经过了这个账户」）。
 * - `parentCategoryId` / `categoryId`：命中子分类 `categoryId` **或** 一级 `parentCategoryId`
 *   （选「餐饮（全部）」= 看整个一级；选某个二级 = 只看那一个）。二者都给时优先 `categoryId`。
 * - `recordTypes`：类型集合，支持字符串（逗号拼接，如 `"expense,income"`）或数组。
 *   未提供的维度返回空数组，调用方一律 `...txFilterConds(x)` 拼进 `and(...)`，
 *   不传则与「加参数前」行为完全一致。
 */
export interface TxFilters {
  accountId?: string | null;
  parentCategoryId?: string | null;
  categoryId?: string | null;
  recordTypes?: string | string[] | null;
}

/**
 * 把「账户 / 分类 / 类型」翻译成 transactions 表的 WHERE 条件片段。
 *
 * 口径与 `advanced.ts` 的下钻 / 成员 / 账户余额严格一致（categoryId OR parentCategoryId；
 * accountId OR toAccountId；recordType in (...)）。
 *
 * @returns 可直接展开进 `and(...)` 的 SQL 条件数组（未提供任何维度时为空数组）
 */
export function txFilterConds(f?: TxFilters): SQL[] {
  if (!f) return [];
  const conds: SQL[] = [];

  if (f.accountId) {
    // or(...) 在至少一个实参下必返回 SQL；这里用非空断言收口类型
    conds.push(or(eq(transactions.accountId, f.accountId), eq(transactions.toAccountId, f.accountId))!);
  }

  if (f.categoryId) {
    conds.push(
      or(eq(transactions.categoryId, f.categoryId), eq(transactions.parentCategoryId, f.categoryId))!,
    );
  } else if (f.parentCategoryId) {
    conds.push(eq(transactions.parentCategoryId, f.parentCategoryId));
  }

  if (f.recordTypes) {
    const arr = Array.isArray(f.recordTypes)
      ? f.recordTypes.filter(Boolean)
      : String(f.recordTypes)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    if (arr.length === 1) {
      const one = arr[0];
      if (one) conds.push(eq(transactions.recordType, one));
    } else if (arr.length > 1) {
      conds.push(inArray(transactions.recordType, arr));
    }
  }

  return conds;
}
