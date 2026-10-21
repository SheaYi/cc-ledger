/**
 * 双算一致性闸门（docs/13 §6.2 的机器化）
 *
 * 前端 `public/assets/lib/amounts.js` 是后端 `src/modules/transactions/amounts.ts`
 * 的同构实现。两者一旦漂移，线上表现是「预览与落库对不上」——最贵的一类 bug。
 * 这里穷举「六类型 × 全部合法方向 × 金额/手续费/折扣的边界组合」，
 * 逐格比对两侧的 actualAmount / accountDelta / toAccountDelta / feeAccountDelta
 * 以及 previewLines（文案也要求逐字一致，只有展示层才补千分位）。
 *
 * 运行：npx tsx scripts/check-amounts-parity.mts
 * 非 0 退出 = 公式已漂移，必须先修再提交。
 */
import { calculateAmounts as beCalculate } from '../src/modules/transactions/amounts.js';
import {
  calculateAmounts as feCalculate,
  DIRECTION_BY_RECORD_TYPE,
  RECORD_TYPES,
} from '../public/assets/lib/amounts.js';

/** 覆盖 0 / 有值 / 相等 / 越界前一刻 四类 */
const AMOUNTS = [1, 5, 199, 12345, 1_000_000, 9_999_999_999];
const FEES = [0, 1, 300, 5000];
const DISCOUNTS = [0, 1, 200, 5000];

let cases = 0;
let mismatches = 0;
const failures = [];

function run(fn, input) {
  try {
    return { ok: true, value: fn(input) };
  } catch (err) {
    return { ok: false, code: err?.code, field: err?.field ?? err?.details?.[0]?.field };
  }
}

function compare(input) {
  cases += 1;
  const be = run(beCalculate, input);
  const fe = run(feCalculate, input);

  if (be.ok !== fe.ok) {
    mismatches += 1;
    failures.push({ input, why: `成败不一致 be=${be.ok} fe=${fe.ok}` });
    return;
  }
  if (!be.ok) {
    // 报错也要报在同一个字段上，否则前端会高亮错输入框
    if (be.field !== fe.field) {
      mismatches += 1;
      failures.push({ input, why: `报错字段不一致 be=${be.field} fe=${fe.field}` });
    }
    if (!(be instanceof Error) && be.code !== fe.code) {
      mismatches += 1;
      failures.push({ input, why: `错误码不一致 be=${be.code} fe=${fe.code}` });
    }
    return;
  }

  for (const key of ['actualAmount', 'accountDelta', 'toAccountDelta', 'feeAccountDelta']) {
    if (be.value[key] !== fe.value[key]) {
      mismatches += 1;
      failures.push({ input, why: `${key} 不一致 be=${be.value[key]} fe=${fe.value[key]}` });
      return;
    }
  }
  if (be.value.previewLines.join('|') !== fe.value.previewLines.join('|')) {
    mismatches += 1;
    failures.push({
      input,
      why: `预览文案不一致\n    be=${JSON.stringify(be.value.previewLines)}\n    fe=${JSON.stringify(fe.value.previewLines)}`,
    });
    return;
  }
  if (be.value.explanation !== fe.value.explanation) {
    mismatches += 1;
    failures.push({ input, why: `explanation 不一致\n    be=${be.value.explanation}\n    fe=${fe.value.explanation}` });
  }
}

for (const recordType of RECORD_TYPES) {
  for (const direction of DIRECTION_BY_RECORD_TYPE[recordType] ?? []) {
    for (const amount of AMOUNTS) {
      for (const fee of FEES) {
        for (const discount of DISCOUNTS) {
          compare({ recordType, direction, amount, fee, discount });
        }
      }
    }
  }
}

// 非法组合（方向不属于该类型）也必须两侧一致地拒绝
for (const recordType of RECORD_TYPES) {
  for (const direction of ['increase', 'decrease', 'none']) {
    if ((DIRECTION_BY_RECORD_TYPE[recordType] ?? []).includes(direction)) continue;
    compare({ recordType, direction, amount: 1000, fee: 0, discount: 0 });
  }
}

// 类型本身非法
compare({ recordType: 'bogus', direction: 'decrease', amount: 1000, fee: 0, discount: 0 });

if (mismatches > 0) {
  console.error(`✗ 双算一致性闸门：${cases} 个用例，${mismatches} 处漂移\n`);
  for (const f of failures.slice(0, 20)) {
    console.error(`  · ${f.why}\n    input=${JSON.stringify(f.input)}\n`);
  }
  if (failures.length > 20) console.error(`  …… 另有 ${failures.length - 20} 处`);
  process.exit(1);
}

console.log(`✓ 双算一致性闸门：${cases} 个用例前后端逐格一致（含报错字段与预览文案）`);
