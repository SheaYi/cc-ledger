/**
 * 期初余额口径迁移审计（docs/14-期初余额口径决策.md 步骤 1 + 步骤 2）
 *
 *   npm run audit:migration
 *
 * 背景：2026-10-14 起余额公式由 `opening_date < tx_date` 改为 `opening_date ≤ tx_date`。
 * 余额是**派生值**（没有存量可追溯），所以改动本身不需要数据迁移；
 * 但**必须先知道影响面**，否则会在用户毫不知情的情况下改变他们看到的历史余额。
 *
 * 本脚本**严格只读**：只开 `readonly: true` 的连接，绝不写库、绝不调平。
 *
 * 两步输出：
 *   步骤 1 · 影响面量化 —— 有多少账户的余额会变、变多少笔凭证
 *   步骤 2 · 重复计账候选 —— ⚠️ 真正的风险，见下方长注释
 *
 * ⚠️ **为什么绝不能自动调平**
 *
 * 旧口径下「建账当天的账不进余额」，用户发现余额不对时，`docs/03 §2.3` 禁止他
 * 直接编辑余额，于是**唯一**的补偿手段就是「把建账户时的期初余额填大一点」。
 *
 * 这些账户在新口径下会**双计**：漏掉的当天流水补回来了，用户填大的那部分还在。
 * 而系统**无法区分**这两种情况：
 *   · 「期初余额填大」+「当天有流水」 = 用户已自行补偿 → 再补当天流水 = 对
 *   · 「期初余额填大」+「当天有流水」 = 用户忘了当天有流水 → 补回来 = 也对
 * 两种解释导出同一个观测结果，任何自动规则都会在其中一种上出错。
 *
 * 所以本脚本只**报告**，处置交回给用户：去银行 App 看一眼实际余额。
 */
// better-sqlite3 是 CommonJS，具名导出在 ESM 下取不到；且它的 default 导出
// **本身就是构造函数**（不是包对象），所以直接 `new Database(...)`。
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const BOUNDARY_POLICY_CHANGE_DATE = '2026-10-14';

const DB = resolve(process.argv[2] ?? 'data/cc-ledger.db');

const db = new Database(DB, { readonly: true, fileMustExist: true });

/** 余额公式在改动瞬间的口径标记，界面披露用（docs/14 步骤 3） */
const fmt = (cents) => (cents / 100).toFixed(2);

/** 报表列宽按**终端显示宽度**算：CJK 字符占 2 列，按码元 pad 会整列错位。 */
const width = (s) =>
  [...String(s)].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));

let hardFail = 0;
const line = (s = '') => console.log(s);
const rule = (t) => line(`\n── ${t} ${'─'.repeat(Math.max(2, 64 - width(t)))}`);

/* ══════════════════════════════════════════════════════════════════
   步骤 1 · 影响面量化
   ══════════════════════════════════════════════════════════════════ */
rule('步骤 1 · 影响面量化');

const totals = db
  .prepare(
    `SELECT
       COUNT(*)                                                   AS all_accounts,
       SUM(CASE WHEN kind <> 'virtual' THEN 1 ELSE 0 END)         AS real_accounts,
       SUM(CASE WHEN kind =  'virtual' THEN 1 ELSE 0 END)         AS virtual_accounts
     FROM accounts`,
  )
  .get();

/**
 * 「期初当天有流水」的账户 —— 这些的余额会变。
 * 注意必须排除虚拟账户：它们的 opening_date = LEDGER_EPOCH = 1970-01-01，
 * 1970 年至今不会有账单，`>` 与 `≥` 结果**完全相同**（零影响）。
 */
const affected = db
  .prepare(
    `SELECT
       a.id, a.ledger_id, a.name, a.kind, a.opening_balance, a.opening_date,
       (SELECT COUNT(*) FROM transactions t
         WHERE (t.account_id = a.id OR t.to_account_id = a.id)
           AND t.tx_date = a.opening_date
           AND t.deleted_at IS NULL)                                AS same_day_cnt,
       (SELECT COALESCE(SUM(
          CASE WHEN t.account_id = a.id THEN t.account_delta
               WHEN t.to_account_id = a.id THEN t.to_account_delta END), 0)
        FROM transactions t
         WHERE (t.account_id = a.id OR t.to_account_id = a.id)
           AND t.tx_date = a.opening_date
           AND t.deleted_at IS NULL)                                AS same_day_delta,
       (SELECT COUNT(*) FROM transactions t
         WHERE (t.account_id = a.id OR t.to_account_id = a.id)
           AND t.deleted_at IS NULL)                                AS tx_total
     FROM accounts a
     WHERE a.kind <> 'virtual'
       AND EXISTS (SELECT 1 FROM transactions t
                    WHERE (t.account_id = a.id OR t.to_account_id = a.id)
                      AND t.tx_date = a.opening_date
                      AND t.deleted_at IS NULL)
     ORDER BY ABS(a.opening_balance) DESC, a.name`,
  )
  .all();

/** 年度边界账户：期初日为 1 月 1 日 —— 旧口径下元旦凭证永远进不了账 */
const yearStart = db
  .prepare(
    `SELECT opening_date, COUNT(*) AS c
       FROM accounts
      WHERE kind <> 'virtual' AND substr(opening_date, 6) = '01-01'
      GROUP BY opening_date ORDER BY opening_date`,
  )
  .all();

/** 对账快照：存的是当时的 system_balance，改口径不会自动重算 → 需要披露 */
const snapshots = db
  .prepare(
    `SELECT COUNT(*) AS c, MIN(reconcile_date) AS earliest, MAX(reconcile_date) AS latest
       FROM reconciliation_records`,
  )
  .get();

const pct =
  totals.real_accounts > 0
    ? ((affected.length / totals.real_accounts) * 100).toFixed(1)
    : '0.0';

line(`  账户总数            ${totals.all_accounts}`);
line(`  ├─ 真实账户        ${totals.real_accounts}`);
line(`  └─ 虚拟账户        ${totals.virtual_accounts}   （opening_date = 1970-01-01 → 零影响）`);
line('');
line(`  ▸ 余额会变的账户    ${affected.length} / ${totals.real_accounts}  = ${pct}%`);
line(`  ▸ 涉及凭证          ${affected.reduce((s, r) => s + r.same_day_cnt, 0)} 笔`);
/**
 * 刻意**不给"净额"**：A 账户的流出和 B 账户的流入在会计上不互相抵销，
 * 跨账户求和出来的数字没有业务含义。只报两侧各自合计。
 */
const inflow = affected.filter((r) => Number(r.same_day_delta) > 0);
const outflow = affected.filter((r) => Number(r.same_day_delta) < 0);
line(
  `  ▸ 位移方向          净流入 ${inflow.length} 个 / 净流出 ${outflow.length} 个` +
    `（流入 ${fmt(inflow.reduce((s, r) => s + Number(r.same_day_delta), 0))}，` +
    `流出 ${fmt(Math.abs(outflow.reduce((s, r) => s + Number(r.same_day_delta), 0)))}）`,
);
line('');
line('  年度边界账户（期初日 = 1 月 1 日，旧口径下元旦凭证永远进不了账）：');
if (yearStart.length === 0) line('    （无）');
for (const y of yearStart) line(`    ${y.opening_date}  ${y.c} 个账户`);
line('');
line(
  `  对账快照 reconciliation_records：${snapshots.c} 条` +
    `${snapshots.earliest ? `（${snapshots.earliest} ~ ${snapshots.latest}）` : ''}`,
);
line('    → 存的是当时的 system_balance，改口径**不会**自动重算，界面须标注口径变更时间。');

/* ══════════════════════════════════════════════════════════════════
   步骤 2 · 重复计账候选筛查
   ══════════════════════════════════════════════════════════════════ */
rule('步骤 2 · 重复计账候选（需要用户核对银行实际余额）');

/**
 * 候选条件（三个同时满足才报出来，避免淹没用户）：
 *   ① 期初当天有流水      —— 余额会变
 *   ② 期初余额显著大于 0  —— 用户可能已经自行补偿过（漏计的账值 < 期初余额量级）
 *   ③ 该账户有历史对账    —— 说明用户核对过真实余额，更可能踩到双计
 *
 * 只报候选，不判定、不调平。判定必须由用户对着银行 App 做。
 */
const candidates = db
  .prepare(
    `SELECT a.id, a.name, a.opening_balance, a.opening_date, a.ledger_id,
            (SELECT COUNT(*) FROM reconciliation_records r
              WHERE r.account_id = a.id) AS recon_cnt
       FROM accounts a
      WHERE a.kind <> 'virtual'
        AND a.opening_balance > 0
        AND EXISTS (SELECT 1 FROM transactions t
                     WHERE (t.account_id = a.id OR t.to_account_id = a.id)
                       AND t.tx_date = a.opening_date
                       AND t.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM reconciliation_records r WHERE r.account_id = a.id)
      ORDER BY a.opening_balance DESC`,
  )
  .all();

line(`  候选 ${candidates.length} 个（系统**不做任何判定或调平**）：`);
line('');

// 按「名称 + 期初余额 + 期初日」折叠：冒烟测试会造出几十个同形账户，
// 逐条列出来会把真正需要人看的少数几个埋掉。
const grouped = new Map();
for (const c of candidates) {
  const key = `${c.name}|${c.opening_balance}|${c.opening_date}`;
  if (!grouped.has(key)) grouped.set(key, { ...c, count: 0, sameDay: 0 });
  const g = grouped.get(key);
  g.count += 1;
  const hit = affected.find((a) => a.id === c.id);
  g.sameDay += hit ? hit.same_day_cnt : 0;
}
const rows = [...grouped.values()].sort((a, b) => b.count - a.count || b.opening_balance - a.opening_balance);

if (rows.length === 0) {
  line('    （无）');
} else {
  line(
    `    ${pad('账户', 18)}${pad('期初余额', 13)}${pad('期初日', 12)}` +
      `${pad('账户数', 8)}${pad('对账', 6)}当日日流水`,
  );
  for (const g of rows.slice(0, 15)) {
    line(
      `    ${pad(g.name, 18)}${pad(fmt(g.opening_balance), 13)}${pad(g.opening_date, 12)}` +
        `${pad(g.count, 8)}${pad(g.recon_cnt, 6)}${g.sameDay} 笔`,
    );
  }
  if (rows.length > 15) line(`    … 另有 ${rows.length - 15} 组`);
}

line('');
line('  处置建议（给用户的话术，不要由系统代劳）：');
line('    「期初余额口径已在 ' + BOUNDARY_POLICY_CHANGE_DATE + ' 修正，建账当天的流水现在计入余额了。');
line('      如果你当初把期初余额填大来迁就旧口径的错误，这批账户会**重复计一次**。');
line('      请打开银行 App 核对这些账户的实际余额：');
line('        · 实际余额 = 系统余额 → 无需处理；');
line('        · 实际余额 = 系统余额 − 期初日当天的净流水 → 期初余额被填大了。」');

/* ══════════════════════════════════════════════════════════════════
   断言：口径回归的守门
   ══════════════════════════════════════════════════════════════════ */
rule('自检');

// 虚拟账户若有 1970 当天的流水，说明数据异常（虚拟账户 opening_date 应为 LEDGER_EPOCH）
const virtualAnomaly = db
  .prepare(
    `SELECT COUNT(*) AS c FROM accounts a
      WHERE a.kind = 'virtual'
        AND EXISTS (SELECT 1 FROM transactions t
                     WHERE (t.account_id = a.id OR t.to_account_id = a.id)
                       AND t.tx_date <= a.opening_date AND t.deleted_at IS NULL)`,
  )
  .get().c;

if (virtualAnomaly > 0) {
  hardFail++;
  console.log(`  ❌ 有 ${virtualAnomaly} 个虚拟账户在期初日当天或之前就有流水，数据异常`);
} else {
  console.log('  ✅ 虚拟账户在期初日当天无流水 → `>` 改 `≤` 对它们零影响（已核实）');
}

if (snapshots.c > 0) {
  console.log(
    `  ⚠️  ${snapshots.c} 条对账快照按旧口径生成，需在界面标注口径变更时间（docs/14 步骤 3）`,
  );
}

db.close();

console.log(
  `\n${hardFail === 0 ? '审计完成' : `审计失败 ${hardFail} 项`}（只读，未修改任何数据）\n`,
);
process.exit(hardFail === 0 ? 0 : 1);
