/**
 * 账务不变量的**只读**校验闸门。
 *
 *   npm run audit:ledger
 *
 * ## 为什么需要它（而不是在 DB 里加 CHECK）
 *
 * 两条最能兜住账务正确性的约束是：
 *   ① `actual_amount >= 0`（`docs/03 §8.2`）
 *   ② `account_delta = 0` 时 `direction` 不得为 `increase/decrease`（双源交叉校验）
 * 但 SQLite **加 CHECK 必须重建表**，而 `transaction_tags` /
 * `transaction_settlements` 对 `transactions.id` 是 `ON DELETE CASCADE` ——
 * `DROP TABLE transactions` 会级联删掉全部关联数据。
 * 为两条防御性约束冒全表数据丢失的风险不成比例。
 *
 * 所以把这两条做成**对存量的只读校验**：写入侧由 `calculateAmounts()` 保证
 * （它有 13 个必测用例），存量侧由本脚本兜住「历史数据被手工 SQL 改坏」。
 *
 * ## 为什么它**不**进 `verify`
 *
 * 见 `audit:migration` 的同一条理由：它的结论依赖库里的具体数据，
 * 而冒烟测试会不断制造新数据，进了闸门就会变成随机红。
 * 它是**运维巡检**工具，不是 CI 闸门 —— 每次迁移前后手动跑一次。
 */
import Database from 'better-sqlite3';

const db = new Database(process.env.CC_DB ?? 'data/cc-ledger.db', { readonly: true });

const checks = [];
const add = (name, rows, hint) => {
  checks.push({ name, count: rows.length, sample: rows.slice(0, 3), hint });
};

/* ---------- ① 实际值不得为负 ---------- */
add(
  '① actual_amount >= 0（docs/03 §8.2）',
  db.prepare('SELECT id, record_type, direction, amount, fee, discount, actual_amount FROM transactions WHERE actual_amount < 0').all(),
  '实付为负说明折扣超过了「金额 + 手续费」，账单会凭空增加账户余额',
);

/* ---------- ② 双源交叉校验：direction 与 accountDelta ---------- */
add(
  '② direction 与 account_delta 符号一致',
  db
    .prepare(
      `SELECT id, record_type, direction, account_delta FROM transactions
       WHERE ((direction = 'increase' AND account_delta < 0)
          OR  (direction = 'decrease' AND account_delta > 0))
         -- 冲减项（红字冲销 / 退款）是**唯一**合法的「direction 与 Δ 反号」：
         -- 它们沿用原类型（统计口径才能被冲减），而现金流方向相反。
         AND COALESCE(adjustment_reason, '') NOT IN ('reversal', 'refund')`,
    )
    .all(),
  'direction 是传进来的、account_delta 是算出来的，两者相反 = 数据被污染',
);

/* ---------- ③ 「主账户不动」只应出现在允许的场景 ---------- */
add(
  '③ account_delta = 0 只出现在 payable 产生 / 核销 / 零值',
  db
    .prepare(
      `SELECT id, record_type, direction, account_delta, actual_amount FROM transactions
       WHERE account_delta = 0
         AND NOT (
           (record_type = 'payable'   AND direction = 'none')
           OR (record_type IN ('receivable','payable') AND direction = 'write_off')
           OR actual_amount = 0
         )`,
    )
    .all(),
  '除登记欠款、核销、零值账单外，主账户不该纹丝不动',
);

/* ---------- ④ 虚拟账户每类唯一 ---------- */
add(
  '④ 每类虚拟账户账本内唯一（docs/03 §8.1 脚注 ¹²）',
  db
    .prepare("SELECT ledger_id, type, COUNT(*) c FROM accounts WHERE kind = 'virtual' GROUP BY 1, 2 HAVING c > 1")
    .all(),
  '出现两个同类虚拟账户时台账余额会随机取一个，且完全不报错',
);

/* ---------- ⑤ 单币种（V1 约束） ---------- */
const currencies = db.prepare('SELECT DISTINCT currency FROM ledgers').all().map((r) => r.currency);
checks.push({
  name: '⑤ V1 单币种（跨币种求和无意义）',
  count: currencies.length > 1 ? 1 : 0,
  sample: currencies,
  hint: 'docs/02 §3.3：currency 字段为预留。多币种需先加汇率快照，否则 SUM(actual_amount) 是错的',
});

/* ---------- ⑥ 借贷平衡：每笔的 ΣΔ ---------- */
add(
  '⑥ 转账 ΣΔ(主 + 第二) = −F（不变量 A，docs/03 §1.4）',
  db
    .prepare(
      `SELECT t.id, t.record_type, t.direction, t.amount, t.fee, t.discount,
              t.account_delta, t.to_account_delta
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.record_type = 'transfer'
         -- 排除手续费台账腿：它是**不变量 B**（Δ(费用账户) = −F）的单腿记录，
         -- 没有第二账户，不适用不变量 A。按普通转账判会误报（实测 7 条）。
         AND NOT (a.kind = 'virtual' AND a.type = 'fee')
         AND (t.account_delta + COALESCE(t.to_account_delta, 0)) <> -(t.fee)`,
    )
    .all(),
  '转出 −(A+F) 与转入 +A 相加后应只剩 −F，即净资产净减手续费',
);


/* ---------- ⑦ 冲减项：Δ 非零、actual 非负 ---------- */
add(
  '⑦ 冲减项（reversal / refund）的 Δ 必须非零',
  db.prepare("SELECT id, record_type, direction, account_delta, adjustment_reason FROM transactions WHERE adjustment_reason IN ('reversal','refund') AND account_delta = 0").all(),
  '冲减了却没动账户余额 = 等于没冲减，统计会凭空少一笔',
);

/* ---------- 输出 ---------- */
console.log('\n账务不变量巡检（只读）\n');
let bad = 0;
for (const c of checks) {
  const ok = c.count === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} ${c.name}${ok ? '' : `  ← ${c.count} 处`}`);
  if (!ok) {
    console.log(`       ${c.hint}`);
    console.log(`       样例：${JSON.stringify(c.sample)}`);
  }
}
console.log(`\n${bad === 0 ? '✓ 全部不变量成立' : `✗ ${bad} 条不变量被破坏`}\n`);
process.exit(bad === 0 ? 0 : 1);
