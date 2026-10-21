/**
 * 受损路径的**自动推断**（smoke4 这类大文件的手工重建替代方案）
 *
 *   node scripts/rebuild-infer.mjs scripts/smoke-stage4.mjs            # 只报告
 *   node scripts/rebuild-infer.mjs scripts/smoke-stage4.mjs --apply    # 真改
 *
 * ## 为什么需要它
 *
 * smoke4 有 92 处受损路径。手工逐行精读 + 迭代修正，实测 smoke8 用 64 处花了 16 轮，
 * 且中途多次因**行号漂移**返工。按这个速率，92 处需要 15+ 轮。
 *
 * 这里的做法是把「人脑做的事」显式化：
 *   每处受损行 → ① HTTP 方法 ② **紧邻的 check() 描述文本** ③ 代码特征（body 字段/变量名）
 *   → 规则映射到「某条后端路由」→ 生成重建计划。
 *
 * ## 判据强度
 *
 * 推断结果分三档，**只用前两档自动落笔**：
 *   ✓ 确定 —— check 文本里的资源词与动词**唯一**对应一条路由，且方法一致
 *   ⚠ 存疑 —— 命中多条候选，或动词与资源词指向不同方法（需人工给映射）
 *   ✗ 无从推断 —— check 文本缺失/无关键词，只能人工填
 *
 * 第三档一律**留空并报告**，绝不猜 —— 猜出来的路径若碰巧存在且断言恰好也过，
 * 就是**假绿**，那比坏掉更难发现。
 *
 * 落笔后仍须跑 `npm run audit:routes`（路径形态必须命中唯一路由）
 * 与该文件的 smoke（断言必须成立）。本脚本只负责**省掉精读**，不负责判对错。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const target = process.argv[2] ?? 'scripts/smoke-stage4.mjs';

/* ---------- 资源词 → 路由路径片段 ---------- */
/** 顺序有意义：先匹配更具体的（invitations / account-groups），再匹配通用的 */
const RESOURCE = [
  [/邀请/, '/invitations'],
  [/成员/, '/members'],
  [/角色|权限/, '/members/{userId}/role'],
  [/归档/, ''],
  [/分组/, '/account-groups'],
  [/分类/, '/categories'],
  [/标签/, '/tags'],
  [/对账|差异|实际余额/, ''],
  [/账户|余额|储蓄卡|信用卡|零钱|钱包/, '/accounts'],
  [/账单|记账|流水|交易/, '/transactions'],
];

const VERB = {
  get: /列表|取|拉|筛|查|搜索|排序|预览|详情|看/,
  post: /创建|新建|建|生成|写入|加|增|保存|复制|恢复|重复|补录/,
  patch: /更新|改名|修改|改|置顶|锁定|解锁/,
  delete: /删除|删|移入回收|清空|停用/,
};

/** check 文本里的金额/措辞线索，用来区分同名的不同路由 */
/**
 * 从**后续代码**里读字段访问 —— 比 check 文本可靠得多。
 *
 * 实测：`insertTx({...})` 是直接写库（不走 API），紧随其后的 GET 读 `.data.balance`。
 * check 文本写的是「期初 10000 − 支出 5000 = 5000」，从文本看不出打的是余额接口；
 * 而 `.data.balance` 一眼就锁定 `/accounts/{id}/balance`。
 * 所以**代码特征优先于 check 文本**。
 */
function guessFromCode(after, checkText) {
  if (/\.data\.(balance|inflow|outflow)\b/.test(after)) return '/accounts/{id}/balance';
  if (/\.json\.data\.(inflow|outflow|delta)\b/.test(after)) return '/accounts/{id}/balance';
  if (/\.meta\.summary\b/.test(after)) return '/transactions'; // 列表与账单流水的汇总
  if (/\.meta\.total\b/.test(after)) return '/transactions';
  if (/\.data\.(netBalance|assetTotal|liabilityTotal|accountCount)\b/.test(after))
    return '/accounts/summary';
  if (/\.data\.isBalanced\b/.test(after)) return '/accounts/{id}/reconcile/preview';
  if (/\.data\.(openCount|items)\b|\.summary\.totalReceivable/.test(after)) return '/debts';
  return null;
}

function guessPath(checkText, codeHint) {
  // ① 代码特征优先
  if (codeHint) return codeHint;

  const t = checkText ?? '';

  // ② 无令牌 / 鉴权类：沿用上文资源（此处只标「需人工」，不猜）
  if (/无令牌|未登录|401/.test(t)) return null;

  // ③ 账单子动作（都含「账单」，必须先判，否则会掉进 /transactions 兜底）
  if (/账单|记账|流水|交易/.test(t)) {
    if (/回收站|已删除/.test(t)) return '/transactions/trash';
    if (/永久删除/.test(t)) return '/transactions/{id}/permanent';
    if (/恢复/.test(t)) return '/transactions/{id}/restore';
    if (/复制/.test(t)) return '/transactions/{id}/duplicate';
    if (/批量打标签/.test(t)) return '/transactions/batch-tag';
    if (/批量删除/.test(t)) return '/transactions/batch-delete';
    if (/预览|试算/.test(t)) return '/transactions/preview';
    if (/汇总|小计|按日/.test(t)) return '/transactions/daily-totals';
    if (/补全|联想|候选/.test(t)) return '/suggest/{field}';
    if (/初始|默认账户|表单默认/.test(t)) return '/transactions/new-defaults';
    if (/锁定/.test(t)) return '/transactions';
    return '/transactions';
  }

  // ④ 「分组」必须**先于**「账户」判 —— 「预置账户分组 6 个」两者都含，
  //    早先账户分支先命中就把它判成了 /accounts（错）
  if (/分组/.test(t)) {
    if (/恢复/.test(t)) return '/account-groups/{id}/restore';
    if (/排序/.test(t)) return '/account-groups/reorder';
    if (/不存在|删除不存在的/.test(t)) return '/account-groups/{id}';
    return '/account-groups';
  }

  // ⑤ 分类（含「子类别」「同级重名」这类不点「分类」字的）
  if (/分类|子类别|主类别|父类|同级重名/.test(t)) {
    if (/恢复/.test(t)) return '/categories/{id}/restore';
    if (/排序/.test(t)) return '/categories/reorder';
    if (/停用|归档|删除/.test(t)) return '/categories/{id}';
    if (/改名|换展示图标|更新/.test(t)) return '/categories/{id}';
    if (/统计字段|txCount/.test(t)) return '/categories';
    return '/categories';
  }

  // ⑥ 标签（含 useCount / 色值）
  if (/标签|useCount|色值|配色/.test(t)) {
    if (/恢复/.test(t)) return '/tags/{id}';
    if (/排序/.test(t)) return '/tags/reorder';
    if (/删除/.test(t)) return '/tags/{id}';
    if (/更新|改名/.test(t)) return '/tags/{id}';
    return '/tags';
  }

  // ⑦ 对账
  if (/对账|差异|账实/.test(t)) {
    if (/历史/.test(t)) return '/reconciliations';
    if (/健康度/.test(t)) return '/reconciliation-summary';
    if (/预览/.test(t)) return '/accounts/{id}/reconcile/preview';
    if (/GET/.test(t) || /lastReconciledAt/.test(t)) return '/accounts';
    return '/accounts/{id}/reconcile';
  }

  // ⑧ 汇总 / 健康度（不带「对账」二字时）
  if (/汇总接口|assetTotal|逐账户求和/.test(t)) return '/accounts/summary';
  if (/健康度/.test(t)) return '/reconciliation-summary';

  // ⑨ 账户
  if (/账户|余额|卡|分组下/.test(t)) {
    if (/includeArchived/.test(t)) return '/accounts';
    if (/归档|停用|删除/.test(t)) return '/accounts/{id}';
    if (/更新|改名/.test(t)) return '/accounts/{id}';
    if (/排序/.test(t)) return '/accounts/reorder';
    return '/accounts';
  }
  return null;
}

/* ---------- 逐行分析 ---------- */
const src = readFileSync(target, 'utf8');
const lines = src.split('\n');
const items = [];

lines.forEach((line, i) => {
  const idx = line.indexOf('P`/ledgers/');
  if (idx < 0) return;

  // 方法：往前 4 行找最近的 call('METHOD'
  let method = null;
  for (let k = i; k >= Math.max(0, i - 4); k--) {
    const m = lines[k].match(/call\(\s*'(GET|POST|PATCH|PUT|DELETE)'/);
    if (m) {
      method = m[1];
      break;
    }
  }

  // 紧邻的 check()：向下 8 行内最近的
  let checkText = null;
  for (let k = i; k <= Math.min(lines.length - 1, i + 8); k++) {
    const m = lines[k].match(/check\(\s*'([^']*)'/);
    if (m) {
      checkText = m[1];
      break;
    }
  }

  // 代码特征：往后 6 行的 body 字段名 / 变量名
  const ctx = lines.slice(i, i + 7).join(' ');
  const vars = [...new Set([...ctx.matchAll(/\$\{([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]))];
  const bodyFields = [...new Set([...ctx.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]))];

  // 代码特征：往后 8 行（覆盖紧随其后的 check 与字段访问）
  const after = lines.slice(i, i + 9).join('\n');
  const guess = guessPath(checkText, guessFromCode(after, checkText));
  items.push({ line: i + 1, method, checkText, guess, vars, bodyFields: bodyFields.slice(0, 6) });
});

/* ---------- 分档 ---------- */
const certain = [];
const unsure = [];
const unknown = [];

/** 鉴权类用例（无令牌 → 401）沿用**上一处**已推断的资源 —— 它们本来就是同一资源的负向测试 */
let lastGuess = null;

for (const it of items) {
  const t = it.checkText ?? '';

  if (/无令牌|未登录|凭证|401/.test(t) && !it.guess) {
    if (lastGuess) {
      it.guess = lastGuess;
      it.inherited = true;
      certain.push(it);
      continue;
    }
  }
  if (!it.checkText) {
    unknown.push(it);
    continue;
  }
  // 方法与动词是否一致
  const v = Object.entries(VERB).find(([, re]) => re.test(t));
  const vMethod = v ? v[0].toUpperCase() : null;
  if (!it.guess) unknown.push(it);
  else if (vMethod && vMethod !== it.method) unsure.push({ ...it, verb: vMethod });
  else certain.push(it);

  if (it.guess && !it.inherited) lastGuess = it.guess;
}

console.log(`推断 ${target}：受损 ${items.length} 处`);
console.log(`  ✓ 确定 ${certain.length}　⚠ 存疑 ${unsure.length}　✗ 无从推断 ${unknown.length}\n`);

const dump = (title, arr) => {
  if (!arr.length) return;
  console.log(`── ${title}`);
  for (const it of arr) {
    console.log(
      `  L${String(it.line).padStart(4)} ${(it.method ?? '?').padEnd(6)} ${(it.guess ?? '(需人工)').padEnd(34)} ${(it.checkText ?? '(无 check)').slice(0, 30)}`,
    );
  }
  console.log();
};
dump('✓ 确定（可直接落笔）', certain);
dump('⚠ 动词与路由方法不一致（需人工）', unsure);
dump('✗ 无关键词（需人工）', unknown);

/* ---------- 落笔 ---------- */
if (APPLY) {
  const blocked = [...unsure, ...unknown];
  if (blocked.length) {
    console.log(
      `⚠️ 有 ${blocked.length} 处未确定，**本次只落笔已确定的 ${certain.length} 处**。\n` +
        `   未确定项：${blocked.map((b) => 'L' + b.line).join(' ')}\n` +
        `   猜出来的路径若碰巧存在且断言恰好也过，就是假绿 —— 比坏掉更难发现。\n`,
    );
  }

  const lines2 = src.split('\n');

  /**
   * 先从**全文件**学出账本变量的出现序列。
   *
   * 不能只看受损行的上下文 —— 受损行里 `${ledgerA}` 正是被删掉的部分，
   * 上下文窗口自然找不到。正确做法是扫全文件记录每个 `ledgerXxx` 标识符
   * 出现的行号，再对每个受损行取「它之前最后一次出现的那个」。
   * 冒烟脚本里账本变量基本是按 A / B / C 顺序推进的，这样取最准。
   */
  const ledgerSeq = [];
  lines2.forEach((l, i) => {
    // 只认「出现在 URL 里的」—— const ledgerB = B.ledger.id 这种**声明**不算，
    // 否则 112 行（明明在用 ledgerA）会被判成 ledgerB。
    for (const m of l.matchAll(/ledgers[/]\$\{(ledger[A-Za-z0-9_]*)\}/g))
      ledgerSeq.push({ name: m[1], line: i });
  });
  /**
   * 该行用哪个账本？
   *
   * 直接扫全文件的 `ledgers/${ledgerX}` 行不通 —— smoke4 里这些用法**恰好都在受损行内**，
   * 而 `${ledgerX}` 正是被删掉的部分。可靠的线索是**同行的 token**：
   * 冒烟脚本里 `tokenA` ↔ `ledgerA`、`tokenB` ↔ `ledgerB` 是一一对应的，
   * 而 `token: tokenA` 那一段**没有受损**。所以从 token 反推账本最准。
   */
  const ledgerBefore = (lineNo) => {
    const line = lines2[lineNo - 1] ?? '';
    // 多行 call('POST', P`/ledgers/…`,\n  //   token: tokenA) 的写法里 token 在**下一行**，故向后看 3 行
    const near = lines2.slice(lineNo - 1, lineNo + 3).join('\n');
    const byToken = near.match(/token([A-Z])\b/);
    if (byToken) return 'ledger' + byToken[1];
    // 退化：取该行之前最后一个出现在 URL 里的账本变量
    let best = null;
    for (const s of ledgerSeq) {
      if (s.line >= lineNo) break;
      best = s.name;
    }
    return best;
  };

  /**
   * `{id}` 占位符绑定：取该行**之前最后一次出现**的 `${xxx.id}`。
   *
   * 为什么不能只看邻近窗口：冒烟脚本里 `acc` / `acc2` / `card` 这类变量
   * 在文件前部定义一次，之后几十行都不再出现 —— 邻近 20 行里根本没有它。
   * 和 ledgerBefore 同一个道理：**受损行丢的不只是路径，还有变量名**，
   * 只能从全文件的出现序列里按位置回推。
   */
  const idSeq = [];
  lines2.forEach((l, i) => {
    for (const m of l.matchAll(/(?:\$)?\{?([A-Za-z_$][\w$]*\.(?:id|user\.id))\}?/g))
      idSeq.push({ expr: m[1], line: i });
  });

  let applied = 0;
  const failed = [];

  for (const it of certain) {
    const led = ledgerBefore(it.line);
    if (!led) {
      failed.push({ ...it, why: '该行之前未出现任何账本变量' });
      continue;
    }

    // ② 路径里的占位符 → 实际插值
    let path = it.guess;
    const need = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

    /**
     * 找 `.id` 变量：受损行里 `${acc.id}` **和** `${ledgerA}` 一样是被删掉的部分，
     * 所以本行找不到 —— 必须去**邻近窗口**按「距离最近」取。
     * 距离优先而不是取第一个：同一段里常同时出现 `acc.id` / `card.id` / `g.id`，
     * 离得近的那个才是这次调用真正用的。
     */
    const win = [];
    for (let k = Math.max(0, it.line - 20); k <= Math.min(lines2.length - 1, it.line + 2); k++) {
      for (const m of lines2[k].matchAll(/\$\{([A-Za-z_$][\w$]*\.(?:id|user\.id))\}/g)) {
        win.push({ expr: m[1], dist: Math.abs(k + 1 - it.line) });
      }
    }
    win.sort((a, b) => a.dist - b.dist);

    for (const key of need) {
      let expr = null;
      if (key === 'id') {
        expr =
          win.find((w) => !/^ledger/.test(w.expr) && !/^T\./.test(w.expr))?.expr ??
          win.find((w) => !/^ledger/.test(w.expr))?.expr;
      } else if (key === 'userId') {
        expr = win.find((w) => /user\.id$/.test(w.expr))?.expr ?? it.vars.find((v) => /user/i.test(v));
      } else if (key === 'field') {
        expr = 'field';
      }
      if (!expr && key === 'id') {
        // 邻近窗口没有 → 取该行之前最后一次出现的 .id（排除账本与 T.* ）
        let bestExpr = null;
        for (const q of idSeq) {
          if (q.line >= it.line) break;
          if (/^ledger/.test(q.expr) || /^T\./.test(q.expr)) continue;
          bestExpr = q.expr;
        }
        expr = bestExpr;
      }
      if (!expr) {
        failed.push({ ...it, why: `无法绑定占位符 {${key}}` });
        path = null;
        break;
      }
      path = path.replace(`{${key}}`, '${' + expr + '}');
    }
    if (!path) continue;
    if (path.includes('{field}')) {
      failed.push({ ...it, why: 'suggest 字段名需人工' });
      continue;
    }

    // ③ **只替换路径片段**，不做整行反引号定位 ——
    //    整行替换依赖 `line.indexOf('`', at)`，一旦该行有第二个反引号就会吞掉尾部
    //    （第一版就这么把 `/ledgers/,` 留在行尾，语法直接坏掉）。
    const OLD = 'P`/ledgers/';
    const line = lines2[it.line - 1];
    if (!line.includes(OLD)) {
      failed.push({ ...it, why: '未找到待替换片段' });
      continue;
    }
    lines2[it.line - 1] = line.replace(OLD, '`/ledgers/${' + led + '}' + path + '`');
    applied++;
  }

  writeFileSync(target, lines2.join('\n'), 'utf8');
  console.log(`已落笔 ${applied} / ${certain.length} 处（${target}）`);
  if (failed.length) {
    console.log(`\n未落笔 ${failed.length} 处：`);
    for (const f of failed) console.log(`  L${f.line}  ${f.why}  ${f.checkText ?? ''}`);
  }
  console.log();
}
