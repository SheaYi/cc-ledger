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
import { or, sql, type SQL } from 'drizzle-orm';
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
