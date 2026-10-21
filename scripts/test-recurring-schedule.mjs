/**
 * 周期账单**日期引擎**的单测（纯函数，不需要数据库）。
 *
 * 为什么单独一个文件：这个模块是整套功能里唯一有真实算法难度的部分
 * （月末容错 / 闰年 / 每 N 周 / 锚点不漂移）。它出错的话 CRUD 全都是错的，
 * 而且错法很隐蔽 —— 「每月 31 号」在 2 月少生成一期，要等到真实月份才看得出。
 *
 * 用法：node scripts/test-recurring-schedule.mjs
 */
import {
  daysInMonth,
  dueDatesUntil,
  fmtDay,
  nextDueDate,
  parseDay,
  upcomingDueDates,
} from '../src/modules/recurring/schedule.ts';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}\n      实得 ${a}\n      期望 ${e}`);
  }
}

console.log('\n━━ 周期账单 · 日期引擎 ━━\n');

/* ---------- 基础工具 ---------- */
console.log('— 基础');
check('parseDay / fmtDay 往返', fmtDay(parseDay('2026-10-13')), '2026-10-13');
check('daysInMonth 2026-02（非闰）', daysInMonth(2026, 2), 28);
check('daysInMonth 2024-02（闰）', daysInMonth(2024, 2), 29);
check('daysInMonth 2026-01', daysInMonth(2026, 1), 31);

/* ---------- 月度 ---------- */
console.log('\n— 月度');
const rent = {
  frequency: 'monthly',
  intervalCount: 1,
  startDate: '2026-01-01',
  dayOfMonth: 1,
  maxMonthEnd: true,
};
check('每月 1 号：逐期推进', upcomingDueDates(rent, '2026-10-01', 3), [
  '2026-11-01',
  '2026-12-01',
  '2027-01-01',
]);
check('每月 1 号：next 严格晚于 from', nextDueDate(rent, '2026-11-01'), '2026-12-01');

const day31 = { ...rent, dayOfMonth: 31, maxMonthEnd: true };
// 闰年用例必须换起点：继承 rent 的 2026-01-01 会算不到 2024（起点之前的期被正确挡掉了）
const day31_2024 = { ...rent, startDate: '2024-01-01', dayOfMonth: 31, maxMonthEnd: true };
check(
  '每月 31 号 + 容错：4 月自动取 30 日（不漏生成）',
  upcomingDueDates(day31, '2026-01-31', 4),
  ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'],
);
const day31Strict = { ...rent, dayOfMonth: 31, maxMonthEnd: false };
check(
  '每月 31 号 + 不容错：跳过 2 月与 4 月',
  upcomingDueDates(day31Strict, '2026-01-31', 4),
  ['2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31'],
);
check('闰年 2 月取 29 日', nextDueDate(day31_2024, '2024-01-31'), '2024-02-29');
check('跨年不丢月', nextDueDate(rent, '2026-12-01'), '2027-01-01');

const every2 = { ...rent, intervalCount: 2 };
check(
  '每 2 月（锚定 start 所在月 2026-01 → 命中 01/03/05）',
  upcomingDueDates(every2, '2026-02-01', 3),
  ['2026-03-01', '2026-05-01', '2026-07-01'],
);
const monthEnd30 = { ...rent, dayOfMonth: 30, maxMonthEnd: false };
check(
  '每月 30 号 + 不容错：2 月跳过、3 月回 30',
  upcomingDueDates(monthEnd30, '2026-01-30', 3),
  ['2026-03-30', '2026-04-30', '2026-05-30'],
);

/* ---------- 结束日期 ---------- */
console.log('\n— 结束日期');
const bounded = { ...rent, endDate: '2026-12-31' };
check('有 endDate 时不越过', upcomingDueDates(bounded, '2026-10-01', 5), [
  '2026-11-01',
  '2026-12-01',
]);
check('过了 endDate 返回 null', nextDueDate(bounded, '2026-12-01'), null);

/* ---------- 周度 ---------- */
console.log('\n— 周度');
const monday = {
  frequency: 'weekly',
  intervalCount: 1,
  startDate: '2026-10-05', // 2026-10-05 是周一
  weekDay: 1,
  maxMonthEnd: true,
};
check('每周一', upcomingDueDates(monday, '2026-10-05', 3), [
  '2026-10-12',
  '2026-10-19',
  '2026-10-26',
]);
check('从周中起算也对齐到周一', nextDueDate(monday, '2026-10-07'), '2026-10-12');
const biweekly = { ...monday, intervalCount: 2 };
check(
  '每 2 周的周一（周数倍数）',
  upcomingDueDates(biweekly, '2026-10-05', 3),
  ['2026-10-19', '2026-11-02', '2026-11-16'],
);
const sunday = { ...monday, startDate: '2026-10-04', weekDay: 0 };
check('每周日', upcomingDueDates(sunday, '2026-10-04', 2), ['2026-10-11', '2026-10-18']);

/* ---------- 年度 ---------- */
console.log('\n— 年度');
const yearly = {
  frequency: 'yearly',
  intervalCount: 1,
  startDate: '2026-03-01',
  month: 3,
  dayOfMonth: 1,
  maxMonthEnd: true,
};
check('每年 3 月 1 日', upcomingDueDates(yearly, '2026-03-01', 3), [
  '2027-03-01',
  '2028-03-01',
  '2029-03-01',
]);
check('从年中起算对齐到明年', nextDueDate(yearly, '2026-06-01'), '2027-03-01');
// maxMonthEnd=true 的语义是「取月末」，所以平年 → 2/28、闰年 → 2/29，**不跳过**
// 起点也要换：yearly 的 start 是 2026-03-01，2026-02 那期早于起点会被正确挡掉
const yearlyLeap = { ...yearly, startDate: '2024-01-01', month: 2, dayOfMonth: 29 };
check('每年 2 月 29 日 + 容错：平年取 28、闰年取 29', upcomingDueDates(yearlyLeap, '2025-03-01', 3), [
  '2026-02-28',
  '2027-02-28',
  '2028-02-29',
]);
check(
  '每年 2 月 29 日 + 不容错：平年整年跳过',
  upcomingDueDates({ ...yearlyLeap, maxMonthEnd: false }, '2025-03-01', 2),
  ['2028-02-29', '2032-02-29'],
);
const every2Year = { ...yearly, intervalCount: 2 };
check('每 2 年', upcomingDueDates(every2Year, '2026-03-01', 3), [
  '2028-03-01',
  '2030-03-01',
  '2032-03-01',
]);

/* ---------- 每日 ---------- */
console.log('\n— 每日');
const daily = { frequency: 'daily', intervalCount: 1, startDate: '2026-10-01', maxMonthEnd: true };
check('每天', upcomingDueDates(daily, '2026-10-01', 3), ['2026-10-02', '2026-10-03', '2026-10-04']);
const every3 = { ...daily, intervalCount: 3 };
check(
  '每 3 天（锚定 start，重跑不漂移）',
  upcomingDueDates(every3, '2026-10-01', 4),
  ['2026-10-04', '2026-10-07', '2026-10-10', '2026-10-13'],
);
check(
  '每 3 天从中途起算仍对齐锚点（不是 from+N）',
  nextDueDate(every3, '2026-10-05'),
  '2026-10-07',
);
check(
  '每 3 天在同一天重复求值结果不变（幂等的前提）',
  nextDueDate(every3, '2026-10-06'),
  nextDueDate(every3, '2026-10-06'),
);

/* ---------- 生成区间 ---------- */
console.log('\n— 生成区间（调度器用）');
check(
  '推进到目标日为止',
  dueDatesUntil(rent, '2026-10-01', '2027-02-01'),
  ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'],
);
check('目标日之前无待生成', dueDatesUntil(rent, '2026-11-01', '2026-11-15'), []);
check(
  '跨闰年二月取月末',
  dueDatesUntil(day31_2024, '2024-01-31', '2024-04-30'),
  ['2024-02-29', '2024-03-31', '2024-04-30'],
);

/* ---------- 边界 ---------- */
console.log('\n— 边界');
check('startDate 当天不被重复计入（next 严格晚于）', nextDueDate(rent, '2026-01-01'), '2026-02-01');
// 早于 startDate 时返回 null 是**正确**行为：绝不能生成起点之前（5 年前）的账
check('from 早于 startDate 时返回 null（不生成起点之前的账）', nextDueDate(rent, '2020-01-01'), null);
check('intervalCount=0 视作 1（不崩、不死循环）', upcomingDueDates({ ...rent, intervalCount: 0 }, '2026-10-01', 2), [
  '2026-11-01',
  '2026-12-01',
]);
check('dayOfMonth 超界 + 不容错 → 跳过而非死循环', nextDueDate({ ...rent, dayOfMonth: 45, maxMonthEnd: false }, '2026-10-01'), null);
check('dayOfMonth 超界 + 容错 → 就是「每月最后一天」', nextDueDate({ ...rent, dayOfMonth: 45, maxMonthEnd: true }, '2026-10-01'), '2026-10-31');
check('越过当月末后取下月末', nextDueDate({ ...rent, dayOfMonth: 45, maxMonthEnd: true }, '2026-10-31'), '2026-11-30');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}