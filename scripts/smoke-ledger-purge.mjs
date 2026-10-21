/**
 * 活体验证：账本里「有数据」时能否物理删除（POST /ledgers/:id/purge）。
 *
 * 为什么还要跑一遍：smoke-ledger-manage 的 purge 打的是刚建的空账本，
 * 覆盖不到本次缺陷（transactions.account_id → accounts 是 NO ACTION，
 * 有账目时删账户会被 FK 拦下）。这里必须先造出真实数据再删。
 */
import { randomBytes } from 'node:crypto';

const API = 'http://127.0.0.1:3000/api/v1';
const seg = (s) => encodeURIComponent(String(s ?? ''));
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.9`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : `  ${detail}`}`);
};

async function call(path, token, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function register(tag) {
  const uname = `${tag}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const r = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': randIp() },
    body: JSON.stringify({ username: uname, nickname: `${tag}探针`, password: `Probe1234!${tag}`, platform: 'web' }),
  });
  const j = await r.json();
  if (r.status !== 201 || !j?.data?.accessToken) throw new Error(`注册失败：${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
}

async function main() {
  const A = await register('lpx');

  /* 1. 建一本新账本（自带的默认账本要留着，用于验证「至少保留一本」） */
  const created = await call('/ledgers', A.accessToken, 'POST', { name: '待删除-有数据', type: 'personal', currency: 'CNY' });
  const L = created.data?.data;
  check('创建待删账本 201', created.status === 201 && !!L?.id, JSON.stringify(created.data).slice(0, 200));

  /* 2. 取默认账户组 + 建账户 */
  const groups = await call(`/ledgers/${seg(L.id)}/account-groups`, A.accessToken);
  const g = (groups.data?.data ?? [])[0];
  check('默认账户组可读', !!g?.id, JSON.stringify(groups.data?.data ?? []).slice(0, 160));

  const acc = await call(`/ledgers/${seg(L.id)}/accounts`, A.accessToken, 'POST', {
    groupId: g.id,
    name: '测试现金',
    type: 'cash',
    openingBalance: '1000.00',
    includeInTotal: true,
  });
  const A1 = acc.data?.data;
  check('建账户 201', acc.status === 201 && !!A1?.id, JSON.stringify(acc.data).slice(0, 200));

  const acc2 = await call(`/ledgers/${seg(L.id)}/accounts`, A.accessToken, 'POST', {
    groupId: g.id,
    name: '测试银行卡',
    type: 'debit_card',
    openingBalance: '0',
    includeInTotal: true,
  });
  const A2 = acc2.data?.data;
  check('建第二账户 201', !!A2?.id, JSON.stringify(acc2.data).slice(0, 160));

  /* 3. 建分类（含二级，覆盖 categories.parent_id 自引用） */
  const c1 = await call(`/ledgers/${seg(L.id)}/categories`, A.accessToken, 'POST', { recordType: 'expense', name: '测试餐饮' });
  const C1 = c1.data?.data;
  check('建分类 201', !!C1?.id, JSON.stringify(c1.data).slice(0, 160));
  const c2 = await call(`/ledgers/${seg(L.id)}/categories`, A.accessToken, 'POST', { recordType: 'expense', name: '测试外卖', parentId: C1.id });
  const C2 = c2.data?.data;
  check('建二级分类 201', !!C2?.id, JSON.stringify(c2.data).slice(0, 160));

  /* 4. 造账目：支出 / 转账（覆盖 to_account_id） */
  const tx1 = await call(`/ledgers/${seg(L.id)}/transactions`, A.accessToken, 'POST', {
    recordType: 'expense',
    direction: 'decrease',
    accountId: A1.id,
    categoryId: C2.id,
    amount: '38.50',
    fee: '1.00',
    discount: '2.00',
    note: '活体探针-支出',
    txDate: '2026-10-10',
  });
  check('建支出 201', tx1.status === 201, JSON.stringify(tx1.data).slice(0, 200));

  const tx2 = await call(`/ledgers/${seg(L.id)}/transactions`, A.accessToken, 'POST', {
    recordType: 'transfer',
    direction: 'decrease',
    accountId: A1.id,
    toAccountId: A2.id,
    amount: '500.00',
    note: '活体探针-转账',
    txDate: '2026-10-11',
  });
  check('建转账 201', tx2.status === 201, JSON.stringify(tx2.data).slice(0, 200));

  /* 5. 造一条对账记录（覆盖 reconciliation_records.account_id NO ACTION） */
  const preview = await call(`/ledgers/${seg(L.id)}/accounts/${seg(A1.id)}/reconcile/preview`, A.accessToken, 'POST', {
    actualBalance: '900.00',
    reconcileDate: '2026-10-12',
  });
  check('对账预览 200', preview.status === 200, `${preview.status} ${JSON.stringify(preview.data).slice(0, 200)}`);

  const recon = await call(`/ledgers/${seg(L.id)}/accounts/${seg(A1.id)}/reconcile`, A.accessToken, 'POST', {
    actualBalance: '900.00',
    reconcileDate: '2026-10-12',
    createAdjustment: false,
  });
  check('提交对账 200', recon.status === 200, `${recon.status} ${JSON.stringify(recon.data).slice(0, 200)}`);

  /* 6. 删除影响预览：必须能看到非零计数 */
  const impact = await call(`/ledgers/${seg(L.id)}/deletion-impact`, A.accessToken);
  const imp = impact.data?.data ?? {};
  check('影响预览 200', impact.status === 200, JSON.stringify(impact.data).slice(0, 240));
  check('账目计数 > 0', Number(imp.counts?.transactions ?? 0) > 0, `transactions=${imp.counts?.transactions}`);
  check('账户计数 > 0', Number(imp.counts?.accounts ?? 0) > 0, `accounts=${imp.counts?.accounts}`);
  check('剩余账本 >= 1', Number(imp.remainingLedgers ?? 0) >= 1, `remaining=${imp.remainingLedgers}`);

  /* 7. 真正的目标断言：有数据也能删 */
  const purge = await call(`/ledgers/${seg(L.id)}/purge`, A.accessToken, 'POST');
  check('有数据时物理删除 200', purge.status === 200, `${purge.status} ${JSON.stringify(purge.data).slice(0, 300)}`);

  /* 8. 删除后：列表里没了，且默认账本还在、数据完好 */
  const after = await call('/ledgers', A.accessToken);
  const list = after.data?.data ?? [];
  check('删除后列表不含该账本', !list.some((l) => l.id === L.id), `剩余 ${list.length} 本`);
  check('默认账本仍存在', list.length >= 1, `剩余 ${list.length} 本`);

  const d = list.find((l) => l.isCurrent) ?? list[0];
  const txs = await call(`/ledgers/${seg(d.id)}/transactions?limit=5`, A.accessToken);
  check('其他账本账目接口仍正常', txs.status === 200, `${txs.status}`);

  /* 9. 边界：只剩一本账本时，purge 必须被拒（否则账号无处记账） */
  const only = await call(`/ledgers/${seg(d.id)}/deletion-impact`, A.accessToken);
  const onlyImp = only.data?.data ?? {};
  check('末本账本 remainingLedgers = 0', Number(onlyImp.remainingLedgers ?? -1) === 0, `remaining=${onlyImp.remainingLedgers}`);
  const refuse = await call(`/ledgers/${seg(d.id)}/purge`, A.accessToken, 'POST');
  check(
    '末本账本删除被拒',
    refuse.status === 400 || refuse.status === 409,
    `${refuse.status} ${JSON.stringify(refuse.data).slice(0, 200)}`,
  );
  const kept = await call('/ledgers', A.accessToken);
  check('被拒后账本仍在', (kept.data?.data ?? []).some((l) => l.id === d.id));

  /* 10. 边界：删掉「当前账本」后，剩下的账本里必须有一本接任当前 */
  const l3 = await call('/ledgers', A.accessToken, 'POST', { name: '接任账本', type: 'personal', currency: 'CNY' });
  check('建第三本账本 201', l3.status === 201, JSON.stringify(l3.data).slice(0, 160));
  const cur = await call(`/ledgers/${seg(d.id)}/deletion-impact`, A.accessToken);
  check('当前账本被识别 isCurrent', (cur.data?.data ?? {}).isCurrent === true, JSON.stringify(cur.data?.data ?? {}).slice(0, 160));
  const delCur = await call(`/ledgers/${seg(d.id)}/purge`, A.accessToken, 'POST');
  check('删当前账本 200', delCur.status === 200, `${delCur.status} ${JSON.stringify(delCur.data).slice(0, 200)}`);
  const final = await call('/ledgers', A.accessToken);
  const finalList = final.data?.data ?? [];
  check(
    '删后仍有且仅有一本当前账本',
    finalList.filter((l) => l.isCurrent).length === 1,
    `current=${finalList.filter((l) => l.isCurrent).map((l) => l.name).join(',') || '无'}`,
  );

  /* 10. 边界：账本 id 不存在 → 404，不 500 */
  const ghost = await call(`/ledgers/${seg('ldg_notexist')}/purge`, A.accessToken, 'POST');
  check('不存在账本 → 404/403', ghost.status === 404 || ghost.status === 403, `${ghost.status}`);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果 ==== ${pass} / ${results.length}`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exitCode = 1;
});
