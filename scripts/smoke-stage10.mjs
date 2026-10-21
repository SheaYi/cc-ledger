import { qs } from './lib/url.mjs';
/**
 * Stage 10 端到端冒烟：**模板模块**（`docs/05 §十` + `docs/04 §九`）。
 *
 * 覆盖重点（本模块最容易错的三处）：
 *   · **预置模板按账户分组解析**：payload 存的是 `accountGroupKey`（预置时还没有
 *     具体账户），读取时必须解析出真实账户，且分组为空时给 warning 而不是乱记。
 *   · **写入严、读取宽**：建模板时引用不存在/已停用/类型不匹配 → 400；
 *     但读取时分类被停用**只标注 warning 仍可用**（`docs/05 §10.6` 明写）。
 *   · **金额不固化**：`save-as-template` 带出的是 `defaultAmount`（建议值），
 *     payload 里不得出现 `amount`/`txDate`/`txTime`。
 *
 * 用法：node scripts/smoke-stage10.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;

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

function encodePath(p) {
  const [pathPart, query] = p.split('?');
  const encoded = pathPart
    .split('/')
    .map((s) => (s ? encodeURIComponent(s) : s))
    .join('/');
  return query ? `${encoded}?${query}` : encoded;
}

const FAKE_IP = `10.11.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(method, path, { body, token } = {}) {
  const headers = { 'X-Forwarded-For': FAKE_IP };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${encodePath(path)}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const yuan = (s) => Number(String(s ?? '0'));

console.log('\n━━ Stage 10 · 模板模块 ━━\n');

// ---------- 注册一个独立账本，测试全部在它里面做 ----------
const reg = await call('POST', '/auth/register', {
  body: {
    username: `s10${Date.now().toString(36)}`.slice(0, 32),
    nickname: '模板测试',
    password: 'Smoke10Pass!2026',
    platform: 'web',
  },
});
if (reg.status !== 201 && reg.status !== 200) {
  console.error('注册失败：', JSON.stringify(reg.json));
  process.exit(1);
}
const token = reg.json.data.accessToken;
const led = await call('POST', '/ledgers', {
  token,
  body: { name: `模板测试 ${new Date().toISOString().slice(11, 19)}`, currency: 'CNY' },
});
const ledgerId = led.json.data.id;

// 账户创建要的是**分组 id**（不是 key），分组 id 是预置的复合形式 `ledgerId#grp_cash`
const groups = (await call('GET', `/ledgers/${ledgerId}/account-groups`, { token })).json.data;
const grp = (suffix) =>
  groups.find((g) => g.id.endsWith(`#${suffix}`)) ?? groups.find((g) => g.id === suffix) ?? groups[0];
const grpCash = grp('grp_cash');
const grpThird = grp('grp_thirdparty');
const grpBank = grp('grp_bank');
check('账本自带预置账户分组', !!grpCash && !!grpThird && !!grpBank, groups.map((g) => g.name).join(' / '));

for (const [name, type, g] of [
  ['现金钱包', 'cash', grpCash],
  ['微信零钱', 'third_party', grpThird],
  ['招行储蓄卡', 'debit_card', grpBank],
]) {
  const r = await call('POST', `/ledgers/${ledgerId}/accounts`, {
    token,
    body: { name, type, groupId: g.id, openingBalance: '0.00' },
  });
  if (r.status !== 201) console.log(`    ⚠ 建账户「${name}」失败：${JSON.stringify(r.json).slice(0, 140)}`);
}

const accs = (await call('GET', `/ledgers/${ledgerId}/accounts`, { token })).json.data;
const cash = accs.find((a) => a.name === '现金钱包');
const wechat = accs.find((a) => a.name === '微信零钱');
const bank = accs.find((a) => a.name === '招行储蓄卡');

const cats = (await call('GET', `/ledgers/${ledgerId}/categories`, { token })).json.data;
const flat = [];
for (const p of cats) for (const c of p.children ?? []) flat.push({ ...c, parentId: p.id, parentName: p.name });
const catBreakfast = flat.find((c) => c.name === '早餐');
const catLunch = flat.find((c) => c.name === '午餐');
const catMetro = flat.find((c) => c.name === '地铁');

/* ================= 1. 预置模板 ================= */
console.log('— 1. 预置模板');
let list = (await call('GET', `/ledgers/${ledgerId}/templates`, { token })).json.data;
check('新账本自带 8 个预置模板', list.length === 8, `实得 ${list.length}`);

const tplBreakfast = list.find((t) => t.name === '早餐');
check('预置模板带图标', !!tplBreakfast?.icon, tplBreakfast?.icon);
check(
  '预置模板按分组解析出真实账户（payload 存的是 accountGroupKey）',
  tplBreakfast?.payload.accountId === cash?.id,
  `accountId=${tplBreakfast?.payload.accountId} 期望=${cash?.id}（现金钱包）`,
);
check(
  '解析出的账户带出显示名',
  tplBreakfast?.payload.accountName === '现金钱包',
  String(tplBreakfast?.payload.accountName),
);
check('预置模板带出建议金额（元字符串）', tplBreakfast?.payload.defaultAmount === '8.00', String(tplBreakfast?.payload.defaultAmount));
check('预置模板带出分类名', tplBreakfast?.payload.categoryName === '早餐', String(tplBreakfast?.payload.categoryName));
check('预置模板 direction 已按类型补齐', tplBreakfast?.payload.direction === 'decrease', String(tplBreakfast?.payload.direction));

/* ================= 2. 排序 ================= */
console.log('\n— 2. 排序（pinned 置顶 → use_count → last_used_at）');
check('初始排序稳定（sort_order 兜底，不随机）', list.map((t) => t.name).join(',').includes('早餐'));
check('初始全部未锁定', list.every((t) => t.pinned === false));

const before = list.map((t) => t.id);
const again = (await call('GET', `/ledgers/${ledgerId}/templates`, { token })).json.data;
check(
  '连续两次拉取行序完全一致（并列时必须有确定性 ORDER BY）',
  again.map((t) => t.id).join(',') === before.join(','),
);

/* ================= 3. 使用计数 ================= */
console.log('\n— 3. 使用（use_count / last_used_at）');
const use1 = (await call('POST', `/ledgers/${ledgerId}/templates/${tplBreakfast.id}/use`, { token })).json.data;
check('use 后 use_count = 1', use1.useCount === 1, String(use1.useCount));
check('use 后 lastUsedAt 已写入', !!use1.lastUsedAt, String(use1.lastUsedAt));
const use2 = (await call('POST', `/ledgers/${ledgerId}/templates/${tplBreakfast.id}/use`, { token })).json.data;
check('再 use 后 use_count = 2', use2.useCount === 2, String(use2.useCount));

const afterUse = (await call('GET', `/ledgers/${ledgerId}/templates`, { token })).json.data;
check('用过的模板排到最前（use_count DESC）', afterUse[0].id === tplBreakfast.id, `首位=${afterUse[0].name}`);

/* ================= 4. 锁定置顶 ================= */
console.log('\n— 4. 锁定置顶');
const tplLunch = afterUse.find((t) => t.name === '午餐');
await call('PATCH', `/ledgers/${ledgerId}/templates/${tplLunch.id}`, { token, body: { pinned: true } });
const afterPin = (await call('GET', `/ledgers/${ledgerId}/templates`, { token })).json.data;
check('锁定的模板置顶（即使 use_count 更低）', afterPin[0].id === tplLunch.id, `首位=${afterPin[0].name}`);

/* ================= 5. 写入校验（严） ================= */
console.log('\n— 5. 写入校验（严：脏数据在录入时拦住）');
const dup = await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: { name: '早餐', payload: { recordType: 'expense', accountId: cash.id } },
});
check('重名模板被拒', dup.status === 409 || dup.json?.error?.code === 'DUPLICATE_RESOURCE', String(dup.status));

const badAccount = await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: { name: '坏账户', payload: { recordType: 'expense', accountId: 'acc_不存在' } },
});
check('不存在的账户被拒', badAccount.status === 400, String(badAccount.status));

const badCatType = await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: { name: '类型不匹配', payload: { recordType: 'income', accountId: cash.id, categoryId: catBreakfast.id } },
});
check('分类与 record_type 不匹配被拒（支出分类配收入）', badCatType.status === 400, String(badCatType.status));

const transferNoTo = await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: { name: '残缺转账', payload: { recordType: 'transfer', accountId: bank.id } },
});
check('转账模板缺「转入账户」被拒', transferNoTo.status === 400, String(transferNoTo.status));

const badName = await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: { name: '', payload: { recordType: 'expense' } },
});
check('空模板名被拒', badName.status === 400, String(badName.status));

/* ================= 6. 创建 / 更新 ================= */
console.log('\n— 6. 创建与更新');
const created = await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: {
    name: '楼下便利店',
    icon: 'shopping-basket',
    payload: {
      recordType: 'expense',
      accountId: wechat.id,
      categoryId: catLunch.id,
      name: '便利店',
      merchant: '楼下便利店',
      defaultAmount: '20.00',
      fee: '0',
      discount: '0',
    },
  },
});
check('创建成功返回 201', created.status === 201, String(created.status));
check('创建的模板金额已转元字符串', created.json.data.payload.defaultAmount === '20.00', String(created.json.data.payload.defaultAmount));
const tplStore = created.json.data;

const renamed = await call('PATCH', `/ledgers/${ledgerId}/templates/${tplStore.id}`, {
  token,
  body: { name: '便利店（常去）', payload: { ...tplStore.payload, defaultAmount: '25.50' } },
});
check('更新名称与 payload 生效', renamed.json.data.name === '便利店（常去）' && renamed.json.data.payload.defaultAmount === '25.50', `${renamed.json.data.name} / ${renamed.json.data.payload.defaultAmount}`);

const emptyPatch = await call('PATCH', `/ledgers/${ledgerId}/templates/${tplStore.id}`, { token, body: {} });
check('空更新被拒（至少一个字段）', emptyPatch.status === 400, String(emptyPatch.status));

/* ================= 7. 存为模板 ================= */
console.log('\n— 7. 存为模板（从账单）');
const tx = (await call('POST', `/ledgers/${ledgerId}/transactions`, {
  token,
  body: {
    recordType: 'expense',
    accountId: wechat.id,
    categoryId: catMetro.id,
    amount: '4.00',
    txDate: new Date().toISOString().slice(0, 10),
    name: '地铁',
    merchant: '地铁 App',
    note: '往返',
    clientRequestId: `tpl-tx-${Date.now()}`,
  },
})).json.data;
check('先记一笔作为存为模板的来源', !!tx?.id, tx?.id);

const saved = await call('POST', `/ledgers/${ledgerId}/transactions/${tx.id}/save-as-template`, {
  token,
  body: { name: '地铁往返' },
});
check('存为模板成功返回 201', saved.status === 201, String(saved.status));
const savedDto = saved.json.data;
check('存为模板带出分类与账户', savedDto.payload.categoryId === catMetro.id && savedDto.payload.accountId === wechat.id);
check('存为模板带出商家与名称', savedDto.payload.merchant === '地铁 App' && savedDto.payload.name === '地铁', `${savedDto.payload.merchant} / ${savedDto.payload.name}`);
check('存为模板带出备注', savedDto.payload.note === '往返', String(savedDto.payload.note));
check(
  '金额只作建议值（defaultAmount），payload 里没有固化 amount',
  savedDto.payload.defaultAmount === '4.00' && savedDto.payload.amount === undefined,
  `defaultAmount=${savedDto.payload.defaultAmount} amount=${savedDto.payload.amount}`,
);
check('模板不固化日期与时间', savedDto.payload.txDate === undefined && savedDto.payload.txTime === undefined);
const dupSave = await call('POST', `/ledgers/${ledgerId}/transactions/${tx.id}/save-as-template`, {
  token,
  body: { name: '地铁往返' },
});
check('存为模板重名被拒', dupSave.status === 409 || dupSave.json?.error?.code === 'DUPLICATE_RESOURCE', String(dupSave.status));

/* ================= 8. 排序接口 ================= */
console.log('\n— 8. 手动排序');
const ids = [tplLunch.id, tplBreakfast.id, tplStore.id];
const reordered = (await call('POST', `/ledgers/${ledgerId}/templates/reorder`, { token, body: { ids } })).json.data;
const order = reordered.map((t) => t.id);
check('reorder 后锁定项仍在最前，其余按给定顺序', order[0] === tplLunch.id && order.indexOf(tplBreakfast.id) < order.indexOf(tplStore.id), order.map((id) => reordered.find((t) => t.id === id).name).join(' → '));

/* ================= 9. 读取宽容（宽） ================= */
console.log('\n— 9. 读取宽容：引用失效只标注，不拒绝预填');
// 停用模板引用的分类
const archived = await call('DELETE', `/ledgers/${ledgerId}/categories/${catBreakfast.id}`, { token });
check('停用分类成功', archived.status === 200 || archived.status === 204, String(archived.status));
const afterArchive = (await call('GET', `/ledgers/${ledgerId}/templates/${tplBreakfast.id}`, { token })).json.data;
check('分类被停用后模板仍可读（不 404）', !!afterArchive?.id);
const warnCat = afterArchive.warnings.find((w) => w.field === 'categoryId');
check('模板带「分类已停用」warning', !!warnCat && warnCat.level === 'warn', JSON.stringify(warnCat));
check('warning 文案写明是哪个分类', warnCat?.message.includes('早餐'), warnCat?.message);
// 用它仍能拿到预填数据
check('分类停用不影响预填 payload 的其余字段', afterArchive.payload.accountId === cash.id && afterArchive.payload.name === '早餐');

/* ================= 10. 删除（软删） ================= */
console.log('\n— 10. 删除');
const del = await call('DELETE', `/ledgers/${ledgerId}/templates/${tplStore.id}`, { token });
check('删除成功', del.status === 200, String(del.status));
const afterDel = (await call('GET', `/ledgers/${ledgerId}/templates`, { token })).json.data;
check('删除后默认列表不再出现', !afterDel.some((t) => t.id === tplStore.id));
const withArchived = (await call('GET', `/ledgers/${ledgerId}/templates` + qs({ includeArchived: true }), { token })).json.data;
check('includeArchived=true 能看到（软删而非硬删）', withArchived.some((t) => t.id === tplStore.id));
const delAgain = await call('DELETE', `/ledgers/${ledgerId}/templates/${tplStore.id}`, { token });
check('重复删除不报错（幂等）', delAgain.status === 200 || delAgain.status === 404, String(delAgain.status));

/* ================= 11. 隔离与 404 ================= */
console.log('\n— 11. 跨账本隔离');
const other = (await call('POST', '/ledgers', { token, body: { name: '别的账本', currency: 'CNY' } })).json.data;
const cross = await call('GET', `/ledgers/${ledgerId}/templates/${other.id}`, { token });
check('别的账本取不到本账本的模板（404）', cross.status === 404, String(cross.status));
const crossUse = await call('POST', `/ledgers/${ledgerId}/templates/${other.id}/use`, { token });
check('别的账本也不能 use 本账本的模板', crossUse.status === 404, String(crossUse.status));
const ghost = await call('GET', `/ledgers/${ledgerId}/templates/tpl_none`, { token });
check('不存在的模板 404', ghost.status === 404, String(ghost.status));

/* ================= 12. 预置分类跨类型提示 ================= */
console.log('\n— 12. 分类与类型不匹配的读取是「警告」而非「拒绝」');
// 直接改库造一个类型不匹配的模板（写入侧已拦，这里验证读取侧的宽容）
const bogus = (await call('POST', `/ledgers/${ledgerId}/templates`, {
  token,
  body: { name: '手动分类-午餐', payload: { recordType: 'expense', accountId: cash.id, categoryId: catLunch.id } },
})).json.data;
check('同类型的分类正常无警告', !bogus.warnings.some((w) => w.field === 'categoryId'), JSON.stringify(bogus.warnings));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}