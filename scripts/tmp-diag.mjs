const B = 'http://127.0.0.1:3000/api/v1';
const rip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.9`;
const E = encodeURIComponent;

async function call(path, token, method = 'GET', body) {
  const r = await fetch(`${B}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  return { status: r.status, text: t.slice(0, 400) };
}

async function reg(t) {
  const u = t + Date.now().toString(36) + 'x';
  const r = await fetch(`${B}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': rip() },
    body: JSON.stringify({ username: u, nickname: t, password: 'Probe1234!x', platform: 'web' }),
  });
  const j = await r.json();
  if (!j?.data?.accessToken) throw new Error('注册失败: ' + JSON.stringify(j).slice(0, 300));
  return j.data.accessToken;
}

const A = await reg('la');
const U2 = await reg('lb');

const lr = await (await fetch(`${B}/ledgers`, { headers: { Authorization: `Bearer ${A}` } })).json();
const lid = lr.data[0].id;

const invRes = await fetch(`${B}/ledgers/${encodeURIComponent(lid)}/invitations`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${A}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ role: 'member', maxUses: 1, expiresInHours: 24 }),
});
const inv = (await invRes.json()).data;
console.log('invite:', invRes.status, JSON.stringify(inv));

const rd = await fetch(`${B}/invitations/${inv.code}/redeem`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${U2}` },
});
console.log('redeem:', rd.status, (await rd.text()).slice(0, 400));
