/**
 * 预算账务口径单测（docs/03 §1.2/§1.5/§1.6/§10.2，docs/16 §3）
 *
 * 这一组测的是**最容易静默出错**的地方：数字看起来合理、不报错，
 * 但结论全错。尤其是 §1.6 的冲减项 —— 旧实现把退款当支出加进去，
 * 支出 210 + 退款 210 = 预算已花 420，而正确答案是 0。
 *
 * 用内存 SQLite + drizzle 直接跑产品代码 `budgetSpent()`，
 * 不复制 SQL 到测试里（复制出来的测试永远测不到产品改没改）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.js';
import { budgetSpent } from '../src/modules/budgets/service.js';
import type { AppCtx } from '../src/context.js';

const raw = new Database(':memory:');
raw.pragma('foreign_keys = OFF');
const db = drizzle(raw, { schema });

/** 只要产品 SQL 引用到的列，其余用 DEFAULT 兜底 —— 保持 fixture 最小 */
beforeAll(() => {
  raw.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      actual_amount INTEGER NOT NULL,
      adjustment_reason TEXT,
      budget_excluded TEXT,
      tx_date TEXT NOT NULL,
      category_id TEXT,
      parent_category_id TEXT,
      deleted_at TEXT
    );
    CREATE TABLE transaction_tags (
      transaction_id TEXT NOT NULL,
      tag_id TEXT NOT NULL
    );
  `);
});

afterAll(() => raw.close());

const LEDGER = 'ldg_test';
const FROM = '2026-10-01';
const TO = '2026-10-31';

let seq = 0;
function tx(fields: {
  type: string;
  amount: number;
  date?: string;
  categoryId?: string | null;
  parentId?: string | null;
  contra?: 'refund' | 'reversal';
  excluded?: string | null;
  deleted?: boolean;
  tags?: string[];
}) {
  const id = `tx_${++seq}`;
  raw.prepare(
    `INSERT INTO transactions
      (id, ledger_id, record_type, actual_amount, adjustment_reason, budget_excluded,
       tx_date, category_id, parent_category_id, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    LEDGER,
    fields.type,
    fields.amount,
    fields.contra ?? null,
    fields.excluded ?? null,
    fields.date ?? '2026-10-15',
    fields.categoryId ?? null,
    fields.parentId ?? null,
    fields.deleted ? '2026-10-20T00:00:00Z' : null,
  );
  for (const tag of fields.tags ?? []) {
    raw.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)').run(id, tag);
  }
  return id;
}

const ctx = { db } as unknown as AppCtx;
const spent = (spec: Parameters<typeof budgetSpent>[4] = {}, from = FROM, to = TO) =>
  budgetSpent(ctx, LEDGER, from, to, spec);

describe('docs/03 §1.6 冲减项必须相减', () => {
  it('支出 210 + 退款 210 → 已用 0（旧实现会算成 420）', () => {
    const before = spent();
    tx({ type: 'expense', amount: 21000 });
    tx({ type: 'expense', amount: 21000, contra: 'refund' });
    expect(spent() - before).toBe(0);
  });

  it('红字冲销同样相减；部分退款只冲退回来的那部分', () => {
    const before = spent();
    tx({ type: 'expense', amount: 10000 });
    tx({ type: 'expense', amount: 3000, contra: 'reversal' });
    expect(spent() - before).toBe(7000);
  });

  it('跨月退款落在退款所在月冲减，不回滚原月（§1.6 边界表）', () => {
    const beforeOct = spent({}, FROM, TO);
    const beforeNov = spent({}, '2026-11-01', '2026-11-30');
    tx({ type: 'expense', amount: 5000, date: '2026-10-05' });
    tx({ type: 'expense', amount: 5000, date: '2026-11-03', contra: 'refund' });
    expect(spent({}, FROM, TO) - beforeOct).toBe(5000);
    expect(spent({}, '2026-11-01', '2026-11-30') - beforeNov).toBe(-5000);
  });

  it('收入侧冲减同样相减（收入预算达成额）', () => {
    const before = spent({ recordType: 'income' });
    tx({ type: 'income', amount: 2000000 });
    tx({ type: 'income', amount: 20000, contra: 'refund' });
    expect(spent({ recordType: 'income' }) - before).toBe(1980000);
  });
});

describe('docs/03 §1.5 / §10.2 排除项', () => {
  it('转账 / 应收 / 应付 / 余额调整都不占预算', () => {
    const before = spent();
    tx({ type: 'transfer', amount: 999999 });
    tx({ type: 'receivable', amount: 999999 });
    tx({ type: 'payable', amount: 999999 });
    tx({ type: 'adjustment', amount: 999999 });
    expect(spent() - before).toBe(0);
  });

  it('软删账单不计入', () => {
    const before = spent();
    tx({ type: 'expense', amount: 8000, deleted: true });
    expect(spent() - before).toBe(0);
  });

  it('报销 / 内部往来（budget_excluded）不占预算，存量 NULL 仍占', () => {
    const before = spent();
    tx({ type: 'expense', amount: 6000, excluded: 'reimbursement' });
    tx({ type: 'expense', amount: 4000, excluded: 'internal' });
    tx({ type: 'expense', amount: 1000 }); // NULL → 正常计入
    expect(spent() - before).toBe(1000);
  });

  it('跨账本隔离：别的账本账单不进本账本预算', () => {
    const before = spent();
    raw.prepare(
      `INSERT INTO transactions (id, ledger_id, record_type, actual_amount, tx_date)
       VALUES ('tx_other', 'ldg_other', 'expense', 999999, '2026-10-10')`,
    ).run();
    expect(spent() - before).toBe(0);
  });
});

describe('docs/16 §3.5 按 tx_date 归期与补记', () => {
  it('晚录（补记）的历史账单落在 tx_date 所属月，不看录入时间', () => {
    const beforeSep = spent({}, '2026-09-01', '2026-09-30');
    tx({ type: 'expense', amount: 3300, date: '2026-09-28' });
    expect(spent({}, '2026-09-01', '2026-09-30') - beforeSep).toBe(3300);
  });

  it('账期是闭区间：起止两天都算', () => {
    const before = spent({}, '2026-12-01', '2026-12-03');
    tx({ type: 'expense', amount: 100, date: '2026-12-01' });
    tx({ type: 'expense', amount: 200, date: '2026-12-03' });
    tx({ type: 'expense', amount: 400, date: '2026-12-04' });
    expect(spent({}, '2026-12-01', '2026-12-03') - before).toBe(300);
  });
});

describe('分类 / 标签 / 手续费口径', () => {
  it('一级分类聚合子分类：parentCategoryId 命中也要算', () => {
    const before = spent({ categoryId: 'cat_food' });
    tx({ type: 'expense', amount: 1000, categoryId: 'cat_food' });
    tx({ type: 'expense', amount: 2000, categoryId: 'cat_lunch', parentId: 'cat_food' });
    expect(spent({ categoryId: 'cat_food' }) - before).toBe(3000);
  });

  it('标签预算同样冲减相减', () => {
    const before = spent({ tagId: 'tag_trip' });
    tx({ type: 'expense', amount: 9000, tags: ['tag_trip'] });
    tx({ type: 'expense', amount: 2000, contra: 'refund', tags: ['tag_trip'] });
    expect(spent({ tagId: 'tag_trip' }) - before).toBe(7000);
  });

  it('手续费与折扣已内含于 actual_amount，不重复扣减（§1.5 举例）', () => {
    // A=3000, F=2, D=100 → actual = 2902（分）；预算直接取 actual，不再减 F
    const before = spent();
    tx({ type: 'expense', amount: 290200 });
    expect(spent() - before).toBe(290200);
  });
});
