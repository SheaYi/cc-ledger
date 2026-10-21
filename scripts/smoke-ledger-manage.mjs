/**
 * 账本管理（编辑 / 删除）与「加入他人账本」—— 接口层冒烟。
 *
 * 为什么放接口层而不是只靠 CDP：
 * 删除是**不可逆**操作，UI 点了之后没法自动验证「库里真的没了」，
 * 而这里可以直接断言级联结果与错误码。
 *
 * ## 纪律
 * ① 注册必须带随机 `X-Forwarded-For`：注册限流 3 次/小时按 IP，连跑几轮就会卡住。
 * ② **每个请求都要带 Authorization** —— 漏了会拿到 401，
 *    而断言若只比对「是不是 400」，就会把 401 当成业务错误放过（这次真踩了）。
 * ③ 错误信封是 `{ error: { code, message, details } }`，不是顶层 details。
 */
import { randomBytes } from 'node:crypto';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const seg = (s) => encodeURIComponent(String(s ?? ''));
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.9`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : `  ${detail}`}`);
};

/** 统一出口：token 必传，明确断言没被 401 挡掉 */
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
  if (r.status !== 201 || !j?.data?.accessToken) {
    throw new Error(`注册失败：${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  }
  return { ...j.data, ip: j.data.ip ?? null };
}

async function main() {
  const A = await register('lda');
  const B = await register('ldb');

  /* ---------- 1. 账本编辑 ---------- */
  const ledgersRes = await fetch(`${API}/ledgers`, {
    headers: { Authorization: `Bearer ${A.accessToken}` },
  });
  const ledgers = (await ledgersRes.json()).data;
  const l1 = ledgers[0];
  check('账本列表可读', ledgers.length > 0, `${ledgers.length} 本`);
  check('列表载荷含 icon / note 字段', 'icon' in l1 && 'note' in l1, JSON.stringify(Object.keys(l1)));

  const patch = await call(`/ledgers/${seg(l1.id)}`, A.accessToken, 'PATCH', {
    name: '家庭共同账本',
    icon: 'users',
    note: '一家人吃饭出行',
  });
  check('编辑账本 200', patch.status === 200, JSON.stringify(patch.data).slice(0, 200));
  const patched = patch.data?.data ?? {};
  check('名称已更新', patched.name === '家庭共同账本', String(patched.name));
  check('图标已更新', patched.icon === 'users', String(patched.icon));
  check('备注已更新', patched.note === '一家人吃饭出行', String(patched.note));

  /* 空名 → 400，且错误挂到 name 字段 */
  const bad = await call(`/ledgers/${seg(l1.id)}`, A.accessToken, 'PATCH', { name: '   ' });
  check('空名被拒 400', bad.status === 400, JSON.stringify(bad.data).slice(0, 240));
  check(
    '错误指向 name 字段',
    (bad.data?.error?.details ?? []).some((d) => d.field === 'name'),
    JSON.stringify(bad.data?.error?.details ?? bad.data),
  );

  /* 超长名 → 400 */
  const long = await call(`/ledgers/${seg(l1.id)}`, A.accessToken, 'PATCH', {
    name: 'x'.repeat(41),
  });
  check('超长名被拒 400', long.status === 400, JSON.stringify(long.data).slice(0, 240));

  /* 重名 → 400，且提示里说明原因 */
  const second = await fetch(`${API}/ledgers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${A.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '装修专用账', type: 'shared', currency: 'CNY' }),
  });
  const s1 = (await second.json()).data;
  const dup = await call(`/ledgers/${seg(s1.id)}`, A.accessToken, 'PATCH', {
    name: '家庭共同账本',
  });
  check('重名被拒 400', dup.status === 400, String(dup.status));
  check(
    '重名提示说明原因',
    /同名/.test(JSON.stringify(dup.data)),
    JSON.stringify(dup.data).slice(0, 240),
  );

  /* 非法字符被过滤掉（服务端收口，不靠前端） */
  const dirty = await call(`/ledgers/${seg(s1.id)}`, A.accessToken, 'PATCH', {
    name: '<家庭>',
  });
  check(
    '非法字符被过滤',
    dirty.data?.data?.name === '家庭',
    JSON.stringify(dirty.data?.data ?? dirty.data).slice(0, 240),
  );

  /* ---------- 2. 加入他人账本 ---------- */
  const invRes = await call(`/ledgers/${seg(l1.id)}/invitations`, A.accessToken, 'POST', {
    role: 'member',
    maxUses: 1,
    expiresInHours: 24,
  });
  const inv = invRes.data?.data ?? {};
  check('生成邀请码 201', invRes.status === 201, String(invRes.status));
  check('邀请码是 6 位', /^[A-Z0-9]{6}$/.test(String(inv.code ?? '')), String(inv.code));
  check('返回邀请链接与路径', Boolean(inv.inviteUrl && inv.invitePath), JSON.stringify(inv).slice(0, 240));

  const pv = await call(`/invitations/${seg(inv.code)}`, null, 'GET');
  check('未登录也能预览邀请', pv.status === 200, String(pv.status));
  const pvData = pv.data?.data ?? {};
  check('预览含目标账本名', Boolean(pvData.ledger?.name), JSON.stringify(pvData.ledger));
  check('预览含邀请人昵称', Boolean(pvData.inviter?.nickname), JSON.stringify(pvData.inviter));
  check('预览含待加入角色', Boolean(pvData.role), String(pvData.role));

  /* 空 / 格式错 / 不存在的码 → 非 200 */
  for (const [label, code] of [
    ['不存在的邀请码', 'ZZZZZZ'],
    ['格式错（过短）', 'AB1'],
  ]) {
    const r = await call(`/invitations/${seg(code)}`, null, 'GET');
    check(`${label} → 非 200`, r.status !== 200, `${r.status}`);
  }

  /* 首次兑换 200；再兑一次 → 幂等 alreadyMember */
  const rd1 = await call(`/invitations/${seg(inv.code)}/redeem`, B.accessToken, 'POST');
  check('首次兑换 200', rd1.status === 200, JSON.stringify(rd1.data).slice(0, 240));
  check('兑换写入成员关系', rd1.data?.data?.alreadyMember === false, JSON.stringify(rd1.data?.data).slice(0, 200));

  const rd2 = await call(`/invitations/${seg(inv.code)}/redeem`, B.accessToken, 'POST');
  check('重复加入被识别（alreadyMember）', rd2.data?.data?.alreadyMember === true, JSON.stringify(rd2.data).slice(0, 240));

  /* ---------- 3. 删除影响预览 + 物理删除 ---------- */
  const impact = await call(`/ledgers/${seg(l1.id)}/deletion-impact`, A.accessToken, 'GET');
  check('删除影响预览 200', impact.status === 200, String(impact.status));
  const counts = impact.data?.data?.counts ?? {};
  check(
    '影响统计含账目 / 成员计数',
    Number.isInteger(counts.transactions) && Number.isInteger(counts.members),
    JSON.stringify(counts),
  );
  check('影响统计含剩余账本数', Number.isInteger(impact.data?.data?.remainingLedgers), JSON.stringify(impact.data?.data));

  const purge = await call(`/ledgers/${seg(s1.id)}/purge`, A.accessToken, 'POST');
  check('物理删除 200', purge.status === 200, JSON.stringify(purge.data).slice(0, 240));

  const afterRes = await fetch(`${API}/ledgers`, {
    headers: { Authorization: `Bearer ${A.accessToken}` },
  });
  const after = (await afterRes.json()).data;
  check('删除后列表不含该账本', !after.some((x) => x.id === s1.id), after.map((x) => x.name).join('/'));

  /* 非 owner 不能删（B 只是一次性加入的成员，角色 member）*/
  const noPerm = await call(`/ledgers/${seg(after[0].id)}/purge`, B.accessToken, 'POST');
  check('非 owner 删除被拒（403）', noPerm.status === 403, JSON.stringify(noPerm.data).slice(0, 240));
}

main().then(
  () => {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n结果 ==== ${results.length - bad.length} / ${results.length}`);
    process.exit(bad.length ? 1 : 0);
  },
  (err) => {
    console.error('探针异常：', err);
    process.exit(1);
  },
);