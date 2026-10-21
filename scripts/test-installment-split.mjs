/**
 * 分期的**金额拆分**单测（纯函数，不需要数据库）。
 *
 * 这套东西错起来不报错 —— 12 期每期少还 1 分，钱包就是错的。
 * 所以测的全部是**恒等式**，不是「某期等于某值」这种脆弱断言。
 *
 * 用法：npx tsx scripts/test-installment-split.mjs
 */
import {
  grandTotalOf,
  splitFee,
  splitPeriods,
  splitPrincipal,
} from '../src/modules/installment/split.ts';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`);
  }
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

console.log('\n━━ 分期 · 金额拆分 ━━\n');

/* ---------- 本金拆分 ---------- */
console.log('— 本金拆分（尾差）');
check('能整除时平均分', splitPrincipal(1200000, 12), new Array(12).fill(100000));
check(
  '不能整除时最后一期吃尾差（10000 元 / 3 期）',
  splitPrincipal(1000000, 3),
  [333333, 333333, 333334],
);
check('单期', splitPrincipal(50000, 1), [50000]);
check('零总额', splitPrincipal(0, 3), [0, 0, 0]);
check(
  '奇数尾巴：100 分 / 7 期',
  splitPrincipal(100, 7),
  [14, 14, 14, 14, 14, 14, 16],
);
check('Σprincipal 恒等于总额（7 期那组也成立）', sum(splitPrincipal(100, 7)) === 100, String(sum(splitPrincipal(100, 7))));

/* ---------- 手续费：首期多还 ---------- */
console.log('\n— 手续费 · 首期多还（first_period，默认）');
const onceFirst = splitFee({ totalFee: 60000, feeMode: 'once', feeHandling: 'first_period', count: 12 });
check('一次性 600 元 / 12 期：全进首期', onceFirst[0] === 60000 && sum(onceFirst.slice(1)) === 0, `${onceFirst[0]} + ${sum(onceFirst.slice(1))}`);
check('Σfee 恒等于总手续费', sum(onceFirst) === 60000, String(sum(onceFirst)));
const perFirst = splitFee({ totalFee: 0, perPeriodFee: 1000, feeMode: 'per_period', feeHandling: 'first_period', count: 12 });
check('每期收 10 元 / 12 期：首期收满 12000', perFirst[0] === 12000 && sum(perFirst.slice(1)) === 0, String(perFirst[0]));

/* ---------- 手续费：按期分摊 ---------- */
console.log('\n— 手续费 · 按期分摊（per_period）');
const amort = splitFee({ totalFee: 60000, feeMode: 'once', feeHandling: 'per_period', count: 12 });
check('一次性 600 元按期摊：每期 5000', amort.every((f) => f === 5000), amort.join(','));
const amortOdd = splitFee({ totalFee: 100, feeMode: 'once', feeHandling: 'per_period', count: 3 });
check('摊不开时最后一期吃尾差（100 分 / 3 期）', amortOdd, [33, 33, 34]);
check('Σfee 恒等于总手续费', sum(amortOdd) === 100, String(sum(amortOdd)));
const perAmort = splitFee({ totalFee: 0, perPeriodFee: 5000, feeMode: 'per_period', feeHandling: 'per_period', count: 12 });
check('每期收的按期摊：每期就是它自己', perAmort.every((f) => f === 5000) && sum(perAmort) === 60000, String(sum(perAmort)));

/* ---------- 手续费：手动尾款 ---------- */
console.log('\n— 手续费 · 手动尾款（manual_last）');
const manual = splitFee({ totalFee: 60000, feeMode: 'once', feeHandling: 'manual_last', count: 12 });
check('不自动带（每期 0）', manual.every((f) => f === 0) && manual.length === 12, String(sum(manual)));

/* ---------- 组合：完整期表 ---------- */
console.log('\n— 完整期表与恒等式');
const plan = splitPeriods({
  totalAmount: 1200000, // 12000 元
  totalFee: 60000, // 600 元
  feeMode: 'once',
  feeHandling: 'first_period',
  count: 12,
});
check('12 期', plan.length === 12, String(plan.length));
check('首期 = 1000 本金 + 600 手续费 = 1600', plan[0].principal === 100000 && plan[0].fee === 60000 && plan[0].totalDue === 160000, JSON.stringify(plan[0]));
check('其余各期各还 1000', plan.slice(1).every((p) => p.totalDue === 100000), String(plan[1].totalDue));
check('Σ principal === 总额', sum(plan.map((p) => p.principal)) === 1200000, String(sum(plan.map((p) => p.principal))));
check('Σ fee === 总手续费', sum(plan.map((p) => p.fee)) === 60000, String(sum(plan.map((p) => p.fee))));
check('Σ totalDue === 本金 + 手续费', sum(plan.map((p) => p.totalDue)) === 1260000, String(sum(plan.map((p) => p.totalDue))));
check('seq 从 1 连续', plan.every((p, i) => p.seq === i + 1), 'ok');
check('总额函数一致', grandTotalOf(1200000, 60000) === 1260000, String(grandTotalOf(1200000, 60000)));

/* ---------- 不能整除的组合（最容易出问题的那种） ---------- */
console.log('\n— 组合 · 不能整除');
const odd = splitPeriods({
  totalAmount: 1000001, // 10000.01 元
  totalFee: 1,
  feeMode: 'once',
  feeHandling: 'per_period',
  count: 7,
});
check('7 期不整除：Σ principal 仍等于总额', sum(odd.map((p) => p.principal)) === 1000001, String(sum(odd.map((p) => p.principal))));
check('7 期不整除：Σ fee 仍等于总手续费', sum(odd.map((p) => p.fee)) === 1, String(sum(odd.map((p) => p.fee))));
check('7 期不整除：Σ totalDue 仍等于两者之和', sum(odd.map((p) => p.totalDue)) === 1000002, String(sum(odd.map((p) => p.totalDue))));
check('每期都为正整数分', odd.every((p) => Number.isInteger(p.totalDue) && p.totalDue > 0), 'ok');

/* ---------- 边界 ---------- */
console.log('\n— 边界');
check('零手续费', splitPeriods({ totalAmount: 100000, totalFee: 0, feeMode: 'once', feeHandling: 'first_period', count: 2 }).every((p) => p.fee === 0), 'ok');
check('负数总额被拒', (() => { try { splitPrincipal(-1, 3); return false; } catch { return true; } })(), 'ok');
check('期数为 0 被拒', (() => { try { splitPrincipal(100, 0); return false; } catch { return true; } })(), 'ok');
check('1 期时全部进第一期', splitPeriods({ totalAmount: 100000, totalFee: 5000, feeMode: 'once', feeHandling: 'per_period', count: 1 })[0].totalDue === 105000, 'ok');
check('金额全为整数分（无浮点）', splitPrincipal(1234567, 3).every(Number.isInteger), 'ok');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}