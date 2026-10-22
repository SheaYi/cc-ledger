/**
 * 对账页「记账完整度」与「重复扣费」的后端契约冒烟
 *
 *   node scripts/smoke-recon-tools.mjs
 *
 * 覆盖用户提的四条：
 *   1. 完整度口径（已入账数 / 缺失数 / 匹配率）+ 时间范围 + 账单来源筛选
 *   2. 重复扣费识别 + 判定依据 + 确认/忽略入口
 *   3. 空数据不返回误导性结果（无流水 → matchRate 为 null 而不是 100）
 *   4. 既有字段语义不变（total/items/threshold/riskHint 仍可被既有消费方使用）
 */
import { P } from './lib/url.mjs';

const API = process.env.API ?? 'http://127.0.0.1:3000/api/v1';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const rnd = () => Math.random().toString(36).slice(2, 10);
const uniq = `smoke${Date.now().toString().slice(-6)}${rnd()}`;
/** 注册限流 3 次/小时按 IP —— 伪造来源 IP 绕开 */
const IP = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const REG = { 'X-Forwarded-For': IP() };

async function register(username) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...REG },
    body: JSON.stringify({ username, nickname: '冒烟', password: `Probe1234!x`, platform: 'web' }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 201 || !json?.data?.accessToken) {
    console.log(`     注册失败：${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json?.data ?? {};
}

async function main() {
  console.log('\n══ 准备：注册用户 + 建账本 + 造数据 ══');
  const A = await register(`${uniq}a`);
  check('注册成功', !!A.accessToken, JSON.stringify(A).slice(0, 120));
  if (!A.accessToken) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
  const T = A.accessToken;

  let r = await call('POST', '/ledgers', { token: T, body: { name: '对账工具冒烟', type: 'personal' } });
  const L = r.json?.data ?? {};
  check('建账本 201', r.status === 201 && !!L.id, `${r.status}`);

  const accGroups = (await call('GET', P`/ledgers/${L.id}/account-groups`, { token: T })).json?.data ?? [];
  const gBank = accGroups.find((g) => String(g.id).endsWith('#grp_bank')) ?? accGroups[0];
  check('取到账户组', !!gBank?.id, JSON.stringify(accGroups.map((g) => g.id)));

  const acc = await call('POST', P`/ledgers/${L.id}/accounts`, {
    token: T,
    body: { groupId: gBank?.id, name: '冒烟卡', type: 'debit_card', openingBalance: '1000.00' },
  });
  const A1 = acc.json?.data ?? {};
  check('建账户 201', !!A1.id, `${acc.status} ${JSON.stringify(acc.json).slice(0, 160)}`);

  const pc = await call('POST', P`/ledgers/${L.id}/categories`, {
    token: T, body: { recordType: 'expense', name: '冒烟支出' },
  });
  const sub = await call('POST', P`/ledgers/${L.id}/categories`, {
    token: T, body: { recordType: 'expense', name: '冒烟二级', parentId: pc.json?.data?.id },
  });
  check('建二级分类', !!sub.json?.data?.id, `${sub.status}`);

  /* ---------- 1. 空数据：不能给误导性的 100% ---------- */
  console.log('\n══ ① 空数据态 ══');
  r = await call('GET', P`/ledgers/${L.id}/recon-match-rate`, { token: T });
  const empty = r.json?.data ?? {};
  check('无流水时 total = 0', Number(empty.total ?? -1) === 0, `total=${empty.total}`);
  check('无流水时 matchRate 为 null（不是 100）', empty.matchRate === null, `matchRate=${empty.matchRate}`);
  check('无流水时 effectiveTotal = 0', Number(empty.effectiveTotal ?? -1) === 0, `${empty.effectiveTotal}`);
  check('无流水时 riskHint 为 null', empty.riskHint === null, String(empty.riskHint));
  check('缺失明细为空数组', Array.isArray(empty.missingLines) && empty.missingLines.length === 0);

  r = await call('GET', P`/ledgers/${L.id}/duplicate-charges`, { token: T });
  const dupEmpty = r.json?.data ?? {};
  check('无账目时重复分组为 0', Number(dupEmpty.duplicateGroupCount ?? -1) === 0, `${dupEmpty.duplicateGroupCount}`);
  check('既有字段 items 仍是数组（兼容）', Array.isArray(dupEmpty.items), typeof dupEmpty.items);

  /* ---------- 2. 导入流水 → 完整度口径 ---------- */
  console.log('\n══ ② 记账完整度口径 ══');
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = (n) => iso(new Date(today.getTime() - n * 86400000));

  /** 导入接口收的是 CSV 文本 + 列映射（不是行数组） */
  const csvText = ['日期,金额,摘要', `${day(1)},-10.00,甲商户`, `${day(2)},-22.22,乙商户`, `${day(3)},-33.33,丙商户`].join('\n');
  const stmt = await call('POST', P`/ledgers/${L.id}/accounts/${A1.id}/statements/import`, {
    token: T,
    body: {
      filename: 'smoke.csv',
      content: csvText,
      mapping: { date: '日期', amount: '金额', description: '摘要' },
    },
  });
  const stmtId = stmt.json?.data?.statementId ?? stmt.json?.data?.id;
  check('导入流水 200/201', stmt.status === 200 || stmt.status === 201, `${stmt.status} ${JSON.stringify(stmt.json).slice(0, 200)}`);

  // 让第 1 笔匹配上：建一笔同金额同日支出后自动匹配
  await call('POST', P`/ledgers/${L.id}/transactions`, {
    token: T,
    body: {
      recordType: 'expense', direction: 'decrease', accountId: A1.id,
      categoryId: sub.json?.data?.id, amount: '10.00', txDate: day(1), name: '甲商户',
    },
  });
  if (stmtId) {
    await call('POST', P`/ledgers/${L.id}/statements/${stmtId}/match`, { token: T, body: { windowDays: 3 } });
  }

  r = await call('GET', P`/ledgers/${L.id}/recon-match-rate`, { token: T });
  const m1 = r.json?.data ?? {};
  console.log(`     统计：total=${m1.total} matched=${m1.matched} ignored=${m1.ignored} unmatched=${m1.unmatched} effective=${m1.effectiveTotal}`);
  check('total 含全部流水（含 ignored）', Number(m1.total ?? 0) >= 1, `total=${m1.total}`);
  check(
    '有效分母 = matched + unmatched + suspected（剔除 ignored）',
    Number(m1.effectiveTotal) === Number(m1.matched) + Number(m1.unmatched) + Number(m1.suspected),
    `${m1.effectiveTotal} vs ${Number(m1.matched) + Number(m1.unmatched) + Number(m1.suspected)}`,
  );
  check(
    '已入账数 = matched',
    Number(m1.recordedCount ?? -1) === Number(m1.matched),
    `${m1.recordedCount} vs ${m1.matched}`,
  );
  check(
    '缺失数 = unmatched + suspected',
    Number(m1.missingCount ?? -1) === Number(m1.unmatched) + Number(m1.suspected),
    `${m1.missingCount}`,
  );
  check(
    '匹配率按有效分母算（不是按含 ignored 的总数）',
    Number(m1.effectiveTotal) > 0 &&
      Math.abs(Number(m1.matchRate) - Math.round((Number(m1.matched) / Number(m1.effectiveTotal)) * 1000) / 10) < 0.11,
    `matchRate=${m1.matchRate}`,
  );
  check('缺失明细带出 merchant / txDate / matchState', (m1.missingLines ?? []).every((l) => 'merchant' in l && 'txDate' in l && 'matchState' in l), JSON.stringify((m1.missingLines ?? [])[0] ?? {}));
  check('返回账单来源列表', Array.isArray(m1.sources), JSON.stringify(m1.sources));
  check('回显筛选条件', m1.filters && 'from' in m1.filters, JSON.stringify(m1.filters));

  /* ---------- 3. 筛选 ---------- */
  console.log('\n══ ③ 时间范围 / 账单来源筛选 ══');
  r = await call('GET', P`/ledgers/${L.id}/recon-match-rate?from=${day(0)}&to=${day(0)}`, { token: T });
  const narrow = r.json?.data ?? {};
  check('时间范围筛选生效（窗口内 ≤ 全量）', Number(narrow.total ?? -1) <= Number(m1.total ?? 0), `${narrow.total} <= ${m1.total}`);
  check('筛选条件被回显', narrow.filters?.from === day(0), JSON.stringify(narrow.filters));

  r = await call('GET', P`/ledgers/${L.id}/recon-match-rate?source=manual`, { token: T });
  const bySrc = r.json?.data ?? {};
  check('按来源筛选 200', r.status === 200, `${r.status}`);
  check('按来源筛选回显 source', bySrc.filters?.source === 'manual', JSON.stringify(bySrc.filters));

  if (stmtId) {
    r = await call('GET', P`/ledgers/${L.id}/recon-match-rate?statementId=${stmtId}`, { token: T });
    check('按账单筛选 200 且回显 statementId', r.status === 200 && r.json?.data?.filters?.statementId === stmtId, `${r.status}`);
  }

  /* ---------- 4. 重复扣费 ---------- */
  console.log('\n══ ④ 重复扣费识别 ══');
  /** 造两笔真正的「同一笔记两次」：同日 + 同金额 + 同商户 */
  const dupDate = day(5);
  for (let i = 0; i < 2; i += 1) {
    await call('POST', P`/ledgers/${L.id}/transactions`, {
      token: T,
      body: {
        recordType: 'expense', direction: 'decrease', accountId: A1.id,
        categoryId: sub.json?.data?.id, amount: '77.77', txDate: dupDate, name: '重复商户',
      },
    });
  }
  /** 再造两笔跨天同额（应判为 medium，不是 high） */
  await call('POST', P`/ledgers/${L.id}/transactions`, {
    token: T, body: { recordType: 'expense', direction: 'decrease', accountId: A1.id, categoryId: sub.json?.data?.id, amount: '55.55', txDate: day(20), name: '跨天商户' },
  });
  await call('POST', P`/ledgers/${L.id}/transactions`, {
    token: T, body: { recordType: 'expense', direction: 'decrease', accountId: A1.id, categoryId: sub.json?.data?.id, amount: '55.55', txDate: day(22), name: '跨天商户' },
  });

  r = await call('GET', P`/ledgers/${L.id}/duplicate-charges`, { token: T });
  const dup = r.json?.data ?? {};
  const groups = dup.duplicateGroups ?? [];
  console.log(`     分组数=${dup.duplicateGroupCount} 待判=${dup.pendingCount} 已确认=${dup.confirmedCount} 已忽略=${dup.ignoredCount}`);
  check('识别出疑似重复分组', groups.length >= 1, `${groups.length}`);
  check('默认时间窗 = 3 天', Number(dup.windowDays ?? -1) === 3, `${dup.windowDays}`);

  const sameDay = groups.find((g) => g.merchant === '重复商户');
  check('同日同额同商户被识别', !!sameDay, JSON.stringify(groups.map((g) => g.merchant)));
  if (sameDay) {
    check('组内 2 笔', Number(sameDay.count) === 2, `${sameDay.count}`);
    check('判定依据含「金额相同」「商户相同」「同一天」',
      ['金额相同', '商户相同', '同一天'].every((x) => (sameDay.reasons ?? []).includes(x)),
      JSON.stringify(sameDay.reasons));
    check('同日判为 high', sameDay.confidence === 'high', String(sameDay.confidence));
    check('明细含账目 id 与账户名', (sameDay.items ?? []).every((x) => x.id && 'accountName' in x), JSON.stringify((sameDay.items ?? [])[0] ?? {}));
    check('初始状态为 pending', sameDay.status === 'pending', String(sameDay.status));
  }

  const crossDay = groups.find((g) => g.merchant === '跨天商户');
  check('跨天 2 天同额也算一组（在 3 天窗内）', !!crossDay, JSON.stringify(groups.map((g) => `${g.merchant}/${g.spanDays}`)));
  if (crossDay) check('跨天判为 medium（可能是真买了两次）', crossDay.confidence === 'medium', String(crossDay.confidence));

  /* ---------- 5. 确认 / 忽略 ---------- */
  console.log('\n══ ⑤ 确认重复 / 忽略 ══');
  const target = sameDay ?? groups[0];
  check('有可操作的分组', !!target, `${groups.length}`);
  if (target) {
    r = await call('POST', P`/ledgers/${L.id}/duplicate-reviews`, {
      token: T, body: { groupKey: target.groupKey, status: 'ignored', note: '冒烟：不是重复' },
    });
    check('忽略 201', r.status === 201, `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);

    r = await call('GET', P`/ledgers/${L.id}/duplicate-charges`, { token: T });
    const afterIgnore = r.json?.data ?? {};
    check('忽略后默认不再出现', !(afterIgnore.duplicateGroups ?? []).some((g) => g.groupKey === target.groupKey), '仍在列表里');
    check('忽略计数 +1', Number(afterIgnore.ignoredCount ?? -1) >= 1, `${afterIgnore.ignoredCount}`);

    r = await call('GET', P`/ledgers/${L.id}/duplicate-charges?includeReviewed=1`, { token: T });
    const withIgnored = r.json?.data ?? {};
    const found = (withIgnored.duplicateGroups ?? []).find((g) => g.groupKey === target.groupKey);
    check('includeReviewed=1 时已忽略项可见', !!found, '查不到');
    check('已忽略项状态为 ignored', found?.status === 'ignored', String(found?.status));

    r = await call('POST', P`/ledgers/${L.id}/duplicate-reviews`, {
      token: T, body: { groupKey: target.groupKey, status: 'confirmed' },
    });
    check('改为确认重复 201', r.status === 201, `${r.status}`);
    r = await call('GET', P`/ledgers/${L.id}/duplicate-charges`, { token: T });
    const afterConfirm = r.json?.data ?? {};
    check('确认后状态为 confirmed', (afterConfirm.duplicateGroups ?? []).find((g) => g.groupKey === target.groupKey)?.status === 'confirmed', '状态不对');
    check('确认计数 +1', Number(afterConfirm.confirmedCount ?? -1) >= 1, `${afterConfirm.confirmedCount}`);
  }

  /* ---------- 6. 边界 ---------- */
  console.log('\n══ ⑥ 边界与错误处理 ══');
  r = await call('POST', P`/ledgers/${L.id}/duplicate-reviews`, { token: T, body: { groupKey: 'x', status: 'maybe' } });
  check('非法 status 被拒（400）', r.status === 400, `${r.status}`);
  r = await call('POST', P`/ledgers/${L.id}/duplicate-reviews`, { token: T, body: { status: 'confirmed' } });
  check('缺 groupKey 被拒（400）', r.status === 400, `${r.status}`);
  r = await call('GET', P`/ledgers/${L.id}/duplicate-charges?windowDays=999`, { token: T });
  check('超大 windowDays 被夹到 30', r.status === 200 && Number(r.json?.data?.windowDays) === 30, `${r.json?.data?.windowDays}`);
  r = await call('GET', P`/ledgers/${L.id}/recon-match-rate?from=not-a-date`, { token: T });
  check('非法日期不 500', r.status !== 500, `${r.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('崩了：', e);
  process.exit(1);
});
