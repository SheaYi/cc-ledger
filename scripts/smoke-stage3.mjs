import { P } from './lib/url.mjs';
/**
 * Stage 3 端到端冒烟测试（真实 HTTP，不使用任何 mock）
 * 用法：node scripts/smoke-stage3.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name} ${extra}`);
  }
}

/**
 * 每次调用默认使用不同来源 IP，避免被限流互相干扰（trustProxy 已开启）。
 *
 * ⚠️ 起点**必须随机**。写死 0 时，连跑两遍会重放同一串 IP ——
 * 注册限流是「每 IP 每小时 N 次」，于是第二遍开头就 429、要等几十分钟。
 * 这是纯工程噪声：它红的时候，被测的其实是限流器而不是账务。
 */
let ipSeq = Math.floor(Math.random() * 60000);
function nextIp() {
  ipSeq++;
  return `10.66.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

async function call(method, path, { body, token, ip } = {}) {
  const headers = { 'X-Forwarded-For': ip ?? nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

const uniq = Date.now().toString(36);

async function main() {
  console.log(`\n=== 1) 健康检查 ${BASE}/healthz ===`);
  const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
  check('healthz 返回 200 且 status=ok', health.status === 'ok', JSON.stringify(health));
  check('WAL 模式已启用', health.database?.walMode === true);

  console.log('\n=== 2) 注册（含个人账本 + 预置数据） ===');
  const aliceName = `alice_${uniq}`;
  const r1 = await call('POST', '/auth/register', {
    body: { username: aliceName, password: 'Str0ngPass!2026', nickname: '小艾', email: `a_${uniq}@example.com` },
  });
  check('注册返回 201', r1.status === 201, `got ${r1.status}`);
  const alice = r1.json?.data;
  check('返回 accessToken', typeof alice?.accessToken === 'string' && alice.accessToken.split('.').length === 3);
  check('返回 refreshToken（rt_ 前缀）', typeof alice?.refreshToken === 'string' && alice.refreshToken.startsWith('rt_'));
  check('expiresIn=900', alice?.expiresIn === 900, String(alice?.expiresIn));
  check('自动创建个人账本「我的账本」', alice?.ledger?.name === '我的账本', JSON.stringify(alice?.ledger));

  const dup = await call('POST', '/auth/register', {
    body: { username: aliceName, password: 'Str0ngPass!2026', nickname: '重复' },
  });
  check('重复用户名 → 409 DUPLICATE_RESOURCE', dup.status === 409 && dup.json?.error?.code === 'DUPLICATE_RESOURCE', JSON.stringify(dup.json));

  const weak = await call('POST', '/auth/register', {
    body: { username: `weak_${uniq}`, password: 'abcdefgh', nickname: '弱密码' },
  });
  check('弱密码 → 400 VALIDATION_ERROR', weak.status === 400 && weak.json?.error?.code === 'VALIDATION_ERROR', JSON.stringify(weak.json));

  console.log('\n=== 3) 预置数据落库核对 ===');
  const me1 = await call('GET', '/users/me', { token: alice.accessToken });
  check('GET /users/me 200', me1.status === 200, `got ${me1.status}`);
  check('currentLedgerId 指向个人账本', me1.json?.data?.currentLedgerId === alice.ledger.id);
  check('ledgers 列表含 1 个账本且 role=owner', me1.json?.data?.ledgers?.[0]?.role === 'owner');

  console.log('\n=== 4) 未授权访问 ===');
  const noAuth = await call('GET', '/users/me');
  check('无 token → 401 UNAUTHORIZED', noAuth.status === 401 && noAuth.json?.error?.code === 'UNAUTHORIZED', JSON.stringify(noAuth.json));
  const badAuth = await call('GET', '/users/me', { token: 'not-a-real-token' });
  check('伪造 token → 401', badAuth.status === 401);

  console.log('\n=== 5) 登录 ===');
  const login = await call('POST', '/auth/login', {
    body: { identifier: aliceName, password: 'Str0ngPass!2026' },
  });
  check('用户名登录 200', login.status === 200, `got ${login.status}`);
  const loginByEmail = await call('POST', '/auth/login', {
    body: { identifier: `a_${uniq}@example.com`, password: 'Str0ngPass!2026' },
  });
  check('邮箱登录 200', loginByEmail.status === 200, `got ${loginByEmail.status}`);
  const wrongPass = await call('POST', '/auth/login', {
    body: { identifier: aliceName, password: 'WrongPass123' },
  });
  check('错误密码 → 401 且不泄露用户是否存在', wrongPass.status === 401 && wrongPass.json?.error?.message === '用户名或密码错误', JSON.stringify(wrongPass.json));
  const ghost = await call('POST', '/auth/login', { body: { identifier: 'no_such_user_xyz', password: 'Abcd1234' } });
  check('不存在的用户 → 401 相同文案', ghost.status === 401 && ghost.json?.error?.message === '用户名或密码错误');

  console.log('\n=== 6) 刷新令牌轮换 ===');
  const rt = login.json.data.refreshToken;
  const ref1 = await call('POST', '/auth/refresh', { body: { refreshToken: rt } });
  check('刷新成功 200', ref1.status === 200, `got ${ref1.status}`);
  check('返回新的 refreshToken', ref1.json?.data?.refreshToken !== rt);
  const reuse = await call('POST', '/auth/refresh', { body: { refreshToken: rt } });
  check('旧 refreshToken 立即失效（轮换生效）', reuse.status === 401, `got ${reuse.status}`);

  const aliceTok = ref1.json.data.accessToken;

  console.log('\n=== 7) 账本协作 ===');
  const mk = await call('POST', '/ledgers', {
    token: aliceTok,
    body: { name: '家庭共同账本', type: 'shared', currency: 'CNY' },
  });
  check('创建账本 201', mk.status === 201, `got ${mk.status}`);
  const sharedId = mk.json?.data?.id;
  check('创建者角色为 owner', mk.json?.data?.role === 'owner');

  const inv = await call('POST', P`/ledgers/${sharedId}/invitations`, {
    token: aliceTok,
    body: { role: 'member', maxUses: 1, expiresInHours: 24 },
  });
  check('生成邀请码 201', inv.status === 201, `got ${inv.status}`);
  const code = inv.json?.data?.code;
  check('邀请码为 6 位且不含易混字符 I/O/0/1', typeof code === 'string' && code.length === 6 && !/[IO01]/.test(code), String(code));
  check('inviteUrl 使用 PUBLIC_BASE_URL', String(inv.json?.data?.inviteUrl).includes(`/invite/${code}`));

  const prev = await call('GET', `/invitations/${code}`);
  check('未登录可预览邀请（公开接口）', prev.status === 200 && prev.json?.data?.valid === true, JSON.stringify(prev.json));
  check('预览含账本名与邀请人', prev.json?.data?.ledger?.name === '家庭共同账本' && !!prev.json?.data?.inviter?.nickname);

  const bobR = await call('POST', '/auth/register', {
    body: { username: `bob_${uniq}`, password: 'Str0ngPass!2026', nickname: '小博' },
  });
  const bob = bobR.json.data;

  const redeem = await call('POST', `/invitations/${code}/redeem`, { token: bob.accessToken });
  check('兑换邀请成功', redeem.status === 200 && redeem.json?.data?.alreadyMember === false, JSON.stringify(redeem.json));
  check('兑换后自动切换为当前账本', redeem.json?.data?.currentLedgerId === sharedId);

  const redeemAgain = await call('POST', `/invitations/${code}/redeem`, { token: bob.accessToken });
  check('重复兑换幂等（alreadyMember=true）', redeemAgain.status === 200 && redeemAgain.json?.data?.alreadyMember === true);

  const bobMe = await call('GET', '/users/me', { token: bob.accessToken });
  const bobShared = bobMe.json.data.ledgers.find((l) => l.id === sharedId);
  check('bob 账本列表含邀请加入的账本', !!bobShared && bobShared.role === 'member' && bobShared.memberCount === 2, JSON.stringify(bobShared));

  const members = await call('GET', P`/ledgers/${sharedId}/members`, { token: aliceTok });
  check('成员列表 2 人', members.json?.data?.length === 2, JSON.stringify(members.json?.data?.length));

  console.log('\n=== 8) 权限矩阵 ===');
  const crossLedger = await call('GET', P`/ledgers/${alice.ledger.id}`, { token: bobTokSafe(bob) });
  check('跨账本访问 → 404（不泄露存在性）', crossLedger.status === 404, `got ${crossLedger.status}`);

  const bobInvite = await call('POST', P`/ledgers/${sharedId}/invitations`, {
    token: bob.accessToken,
    body: { role: 'member' },
  });
  check('member 无权邀请 → 403', bobInvite.status === 403, `got ${bobInvite.status}`);

  const bobArchive = await call('DELETE', P`/ledgers/${sharedId}`, { token: bob.accessToken });
  check('member 无权归档 → 403', bobArchive.status === 403, `got ${bobArchive.status}`);

  const bobRemoveOwner = await call('DELETE', P`/ledgers/${sharedId}/members/${alice.user.id}`, {
    token: bob.accessToken,
  });
  check('member 无权移除成员 → 403', bobRemoveOwner.status === 403, `got ${bobRemoveOwner.status}`);

  const promote = await call('POST', P`/ledgers/${sharedId}/members/${bob.user.id}/role`, {
    token: aliceTok,
    body: { role: 'admin' },
  });
  check('owner 可提升成员为 admin', promote.status === 200 && promote.json.data.find((m) => m.userId === bob.user.id).role === 'admin');

  const adminArchive = await call('DELETE', P`/ledgers/${sharedId}`, { token: bob.accessToken });
  check('admin 仍无权归档（仅 owner） → 403', adminArchive.status === 403, `got ${adminArchive.status}`);

  const selfDemote = await call('POST', P`/ledgers/${sharedId}/members/${alice.user.id}/role`, {
    token: aliceTok,
    body: { role: 'admin' },
  });
  check('不能直接变更 owner 角色 → 400', selfDemote.status === 400, `got ${selfDemote.status}`);

  const transfer = await call('POST', P`/ledgers/${sharedId}/transfer-ownership`, {
    token: aliceTok,
    body: { newOwnerId: bob.user.id },
  });
  check('转让所有权成功', transfer.status === 200 && transfer.json?.data?.role === 'admin', JSON.stringify(transfer.json?.data?.role));
  const afterTransfer = await call('GET', P`/ledgers/${sharedId}/members`, { token: bob.accessToken });
  check('转让后 bob 成为 owner', afterTransfer.json.data.find((m) => m.userId === bob.user.id).role === 'owner');

  console.log('\n=== 9) 资料与密码 ===');
  const patch = await call('PATCH', '/users/me', { token: bob.accessToken, body: { nickname: '小博改名' } });
  check('更新昵称 200', patch.status === 200 && patch.json.data.nickname === '小博改名', JSON.stringify(patch.json?.data?.nickname));

  const dupEmail = await call('PATCH', '/users/me', { token: bob.accessToken, body: { email: `a_${uniq}@example.com` } });
  check('占用已存在邮箱 → 409', dupEmail.status === 409, `got ${dupEmail.status}`);

  const pwd = await call('PATCH', '/users/me/password', {
    token: bob.accessToken,
    body: { oldPassword: 'Str0ngPass!2026', newPassword: 'N3wPass!2026' },
  });
  check('修改密码 200', pwd.status === 200, JSON.stringify(pwd.json));
  const reuseBobRt = await call('POST', '/auth/refresh', { body: { refreshToken: bob.refreshToken } });
  check('改密后旧 refreshToken 全部失效', reuseBobRt.status === 401, `got ${reuseBobRt.status}`);
  const relogin = await call('POST', '/auth/login', { body: { identifier: `bob_${uniq}`, password: 'N3wPass!2026' } });
  check('新密码可登录', relogin.status === 200, `got ${relogin.status}`);

  console.log('\n=== 10) 登出 ===');
  const logout = await call('POST', '/auth/logout', { token: aliceTok, body: { allDevices: true } });
  check('登出返回 204', logout.status === 204, `got ${logout.status}`);
  const logoutRtTry = await call('POST', '/auth/refresh', { body: { refreshToken: ref1.json.data.refreshToken } });
  check('登出后 refreshToken 失效', logoutRtTry.status === 401);

  console.log('\n=== 11) 静态资源与 SPA 回退 ===');
  const home = await fetch(`${BASE}/`);
  check('首页 200 text/html', home.status === 200 && String(home.headers.get('content-type')).includes('text/html'));
  const css = await fetch(`${BASE}/assets/app.css`);
  check('样式表可访问', css.status === 200);
  const assets = await fetch(`${BASE}/assets/app.js`);
  check('入口脚本可访问', assets.status === 200);
  const spa = await fetch(`${BASE}/invite/ABC123`);
  check('深链接回退到前端外壳 200', spa.status === 200);
  const notFound = await call('GET', '/not-a-real-endpoint-xyz');
  check('未知 API → 404 JSON', notFound.status === 404 && notFound.json?.error?.code === 'NOT_FOUND', JSON.stringify(notFound.json));
  const traversal = await fetch(`${BASE}/uploads/..%2f..%2fpackage.json`);
  check('上传目录路径穿越被拦截', [400, 403, 404].includes(traversal.status), `got ${traversal.status}`);

  console.log('\n=== 12) 限流（独立来源 IP 验证） ===');
  const rateIp = '203.0.113.9';
  let loginLimited = 0;
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/auth/login', { ip: rateIp, body: { identifier: 'nobody_rate', password: 'Abcd1234' } });
    if (r.status === 429) loginLimited++;
  }
  check('登录接口触发限流（429）', loginLimited > 0, `429 次数=${loginLimited}`);
  const rlBody = await call('POST', '/auth/login', { ip: rateIp, body: { identifier: 'x', password: 'y' } });
  check('限流响应体符合错误包装', rlBody.json?.error?.code === 'RATE_LIMITED', JSON.stringify(rlBody.json));

  const regIp = '203.0.113.77';
  let regLimited = 0;
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/auth/register', {
      ip: regIp,
      body: { username: `rl_${uniq}_${i}`, password: 'Str0ngPass!2026', nickname: '限流' },
    });
    if (r.status === 429) regLimited++;
  }
  check('注册接口触发限流（429）', regLimited > 0, `429 次数=${regLimited}`);

  console.log('\n=== 13) 头像上传（multipart + 服务端裁剪 512×512） ===');
  const carolR = await call('POST', '/auth/register', {
    body: { username: `carol_${uniq}`, password: 'Str0ngPass!2026', nickname: '小卡' },
  });
  const carol = carolR.json.data;
  const { Jimp } = await import('jimp');
  const src = new Jimp({ width: 900, height: 600, color: 0x3366ccff });
  const pngBuffer = await src.getBuffer('image/png');

  const fd = new FormData();
  fd.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'avatar.png');
  const upRes = await fetch(`${API}/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${carol.accessToken}`, 'X-Forwarded-For': nextIp() },
    body: fd,
  });
  const upJson = await upRes.json();
  check('头像上传 200', upRes.status === 200, JSON.stringify(upJson));
  check('服务端裁剪为 512×512', upJson?.data?.width === 512 && upJson?.data?.height === 512, JSON.stringify(upJson?.data));
  check('avatarPath 落库为 /uploads/...', String(upJson?.data?.avatarPath).startsWith('/uploads/avatars/'));

  const avatarFetch = await fetch(`${BASE}${upJson.data.avatarPath}`);
  check('头像可被静态服务读取', avatarFetch.status === 200 && String(avatarFetch.headers.get('content-type')).includes('image/png'), `got ${avatarFetch.status}`);

  const badType = new FormData();
  badType.append('file', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'x.txt');
  const badRes = await fetch(`${API}/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${carol.accessToken}`, 'X-Forwarded-For': nextIp() },
    body: badType,
  });
  check('非图片类型被拒绝 400', badRes.status === 400, `got ${badRes.status}`);

  const carolMe = await call('GET', '/users/me', { token: carol.accessToken });
  check('GET /users/me 返回头像路径', carolMe.json?.data?.avatarPath === upJson.data.avatarPath);

  console.log('\n=== 14) 数据库落库核对 ===');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database('./data/cc-ledger.db', { readonly: true });
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const many = (sql, ...params) => db.prepare(sql).all(...params);

  const aliceRow = one('SELECT id, status FROM users WHERE username = ?', aliceName);
  check('users 表已写入新用户', !!aliceRow && aliceRow.status === 'active');
  check('密码以 argon2id 存储', String(one('SELECT password_hash h FROM users WHERE username = ?', aliceName).h).startsWith('$argon2id$'));

  const personalLedger = one('SELECT id, type, current_ledger FROM ledgers WHERE id = ?', alice.ledger.id);
  check('个人账本已创建且为 personal', personalLedger?.type === 'personal');

  const seeded = {
    groups: one('SELECT count(*) c FROM account_groups WHERE ledger_id = ?', sharedId).c,
    virtual: one("SELECT count(*) c FROM accounts WHERE ledger_id = ? AND kind='virtual'", sharedId).c,
    mainCat: one('SELECT count(*) c FROM categories WHERE ledger_id = ? AND level = 1', sharedId).c,
    subCat: one('SELECT count(*) c FROM categories WHERE ledger_id = ? AND level = 2', sharedId).c,
    tags: one('SELECT count(*) c FROM tags WHERE ledger_id = ?', sharedId).c,
    templates: one('SELECT count(*) c FROM templates WHERE ledger_id = ?', sharedId).c,
  };
  console.log('     新建账本预置数据：', JSON.stringify(seeded));
  check('账户分组 6 个', seeded.groups === 6, String(seeded.groups));
  check('系统虚拟账户 3 个', seeded.virtual === 3, String(seeded.virtual));
  check('主类别 ≥ 20', seeded.mainCat >= 20, String(seeded.mainCat));
  check('子类别 ≥ 100', seeded.subCat >= 100, String(seeded.subCat));
  check('标签 8 个', seeded.tags === 8, String(seeded.tags));
  check('模板 8 个', seeded.templates === 8, String(seeded.templates));

  const memberRows = many('SELECT user_id, role FROM ledger_members WHERE ledger_id = ?', sharedId);
  check('账本成员表写入 2 条', memberRows.length === 2, String(memberRows.length));

  const invRow = one('SELECT used_count, max_uses FROM ledger_invitations WHERE code = ?', code);
  check('邀请码使用计数 +1', invRow?.used_count === 1, JSON.stringify(invRow));

  const logActions = many('SELECT DISTINCT action FROM ledger_logs WHERE ledger_id = ?', sharedId).map((r) => r.action);
  check('审计日志记录了 create/invite/join 等动作', ['create', 'invite', 'join'].every((a) => logActions.includes(a)), JSON.stringify(logActions));

  const rtRows = many('SELECT token_hash FROM refresh_tokens WHERE user_id = ?', alice.user.id);
  check('refresh token 只存哈希（非明文）', rtRows.length > 0 && rtRows.every((r) => !String(r.token_hash).startsWith('rt_')));
  db.close();

  console.log(`\n================ 结果 ================`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

function bobTokSafe(bob) {
  return bob.accessToken;
}

main().catch((e) => {
  console.error('冒烟测试异常终止：', e);
  process.exit(1);
});
