/** 把 probe:reports 的旧「概览条」断言改写为新的 KPI 卡断言（用完即删） */
import fs from 'node:fs';

const P = 'scripts/probe-reports-ui.mjs';
let s = fs.readFileSync(P, 'utf8');

const OLD_START = "const strip = JSON.parse(";
const OLD_END = "check(\n  \x27「净资产」= 后端 netAssets\x27,";
const i0 = s.indexOf(OLD_START);
const i1 = s.indexOf(OLD_END);
if (i0 < 0 || i1 < 0) {
  console.error('未命中概览条区间', i0, i1);
  process.exit(1);
}
// 找到该 check 的收尾（下一个 ");" 之后）
const tailIdx = s.indexOf(');', s.indexOf('`页面=${byLabel[\x27净资产\x27]} 后端=${sSummary.netAssets}`', i1));
const NEW = `/**
 * 报表页的概览区是 **4 张 KPI 卡**（不是旧的 .stat-strip 三行格）。
 * 卡面：总收入 / 净支出（含结余率）/ 笔数与平均每笔 / 期末现金。
 * 每张卡整体可点，跳到对应筛选下的流水明细。
 */
const strip = JSON.parse(
  await ev(\`JSON.stringify([...document.querySelectorAll('.kpi-card')].map(c => ({
    label: c.querySelector('.kpi-card__label').textContent.trim(),
    value: c.querySelector('.kpi-card__value').textContent.trim(),
    sub: c.querySelector('.kpi-card__sub')?.textContent.trim() ?? null,
    href: c.getAttribute('href'),
  })))\`),
);
const byLabel = Object.fromEntries(strip.map((x) => [x.label, x.value]));
check('KPI 卡 4 张', strip.length === 4, JSON.stringify(strip.map((x) => x.label)));
check(
  \x27「总收入」= 后端 totalIncome\x27,
  norm(byLabel['总收入']) === norm(sSummary.totalIncome),
  \`页面=\${byLabel['总收入']} 后端=\${sSummary.totalIncome}\`,
);
check(
  \x27「净支出」= 后端 totalExpense\x27,
  norm(byLabel['净支出']) === norm(sSummary.totalExpense),
  \`页面=\${byLabel['净支出']} 后端=\${sSummary.totalExpense}\`,
);
/**
 * 「净结余」不再单独占一张卡（它进了周期对比表的「总结余」行），
 * 所以改为断言对比表里真的有这一行，且数值与后端一致。
 */
const netRowVal = String(
  await ev(\`(() => {
    const rows = [...document.querySelectorAll('[data-role=compare] .cmp-row')];
    const r = rows.find((x) => x.textContent.includes('总结余'));
    return r ? r.children[1].textContent.trim() : '';
  })()\`),
);
check(
  \x27周期对比表「总结余」= 后端 netBalance\x27,
  norm(netRowVal) === norm(sSummary.netBalance),
  \`页面=\${netRowVal} 后端=\${sSummary.netBalance}\`,
);
check(
  \x27「期末现金」= 后端 netAssets\x27,
  norm(byLabel['期末现金']) === norm(sSummary.netAssets),
  \`页面=\${byLabel['期末现金']} 后端=\${sSummary.netAssets}\`,
);`;
s = s.slice(0, i0) + NEW + s.slice(tailIdx + 2);

/**
 * 「支出格第三行给日均」—— 新布局的日均挪到了 KPI 卡的副行（如果有）。
 * 改为断言每张卡都有副行说明（副行是卡面承诺的一部分，不能空）。
 */
const oldDaily = /check\(\s*\n?\s*'支出格第三行给出\*\*日均\*\*与\*\*区间天数\*\*[^;]*?\);/s;
s = s.replace(
  oldDaily,
  `check(
  '每张 KPI 卡都有副行说明（卡面承诺完整）',
  strip.every((x) => (x.sub ?? '').trim().length > 0),
  JSON.stringify(strip.map((x) => x.sub)),
);`,
);

/** 近三月断言：新设计下趋势图**固定**近 12 个月，切账期不影响它 */
s = s.replace(
  "check('近三月切到月粒度且桶数 = 后端', shownPeriods === last3Trend.length, `${shownPeriods} vs ${last3Trend.length}`);",
  `/**
   * 「近 12 个月收支趋势」**固定**取近 12 个月 —— 这是标题的承诺，
   * 切到「近三月」也不该让它变成 3 根柱（否则标题与图不符）。
   * 所以这里断言的是「**不随账期变**」，而不是「跟随账期」。
   */
check('趋势图固定 12 个月，不随账期切换而变', shownPeriods === 12, `${shownPeriods} 根`);`,
);

fs.writeFileSync(P, s);
console.log('已改写 · 残留 stat-strip:', (s.match(/stat-strip/g) || []).length);
