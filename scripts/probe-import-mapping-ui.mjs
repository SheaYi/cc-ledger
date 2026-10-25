/**
 * 导入页「字段映射与参考文档对齐」探针 —— CDP
 *
 * ## 这个探针在验什么
 *
 * 用户给了一份**本系统自己导出的账单 CSV**（18 列），指出校对结果与文档不一致。
 * 根因不是「某一列名拼错」，而是三处结构性缺失叠加：
 *   1. `guessMapping` 对这份文件只猜中 3 列（日期 / 金额 / 备注）；
 *   2. 「类型」列不参与映射 → 6 种记录类型被压平成单一 expense，
 *      收入与转账变成支出；
 *   3. 其余列静默消失 —— 用户无从判断「分类」「手续费」到底丢没丢。
 *
 * 这三样**都不报错**，所以必须靠断言把「18 列逐一有交代」钉死。
 *
 * ## 探针策略：直接用**桌面上的那份真实文件**
 *
 * 不自己造 CSV —— 自己造的表头是自己想出来的，等于用同一份偏见验证自己。
 * 真实文件里才有真实的脏东西（BOM、多层引号、空列、取值域）。
 * 文件不在时（CI）退化为「按导出端表头合成」，断言逻辑完全一致。
 *
 * 纪律见 scripts/lib/cdp.mjs。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker, sleep } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'import-map');
const REF_CSV = 'C:/Users/xieyi/Desktop/账单_我的账本_2026-10-18.csv';

/** 导出端表头的真源（public/assets/views/transactions.js › rowsToCsv()） */
const EXPORT_HEADERS = [
  '日期', '时间', '类型', '方向', '主类别', '子类别', '账户', '转入账户',
  '名称', '商家', '对象', '金额', '手续费', '折扣', '实际值', '标签', '备注', '记账人',
];

/**
 * 旧版导出只有「分类」单列，新版拆成「主类别 / 子类别」两列。
 * 真机参考文件可能是任一种格式，统一归一到新格式再比对。
 */
function normalizeHeader(h) {
  const i = h.indexOf('分类');
  if (i >= 0 && !h.includes('主类别')) {
    const out = h.slice();
    out.splice(i, 1, '主类别', '子类别');
    return out;
  }
  return h;
}

const refText = existsSync(REF_CSV)
  ? readFileSync(REF_CSV).toString('utf-8')
  : `﻿${EXPORT_HEADERS.join(',')}\r\n2026-10-18,12:00:00,支出,减少,餐饮,午餐,现金钱包,,午餐,沙县小吃,,35.00,0.00,0.00,35.00,,工作日午餐,探针用户\r\n`;

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, waitUntil, errors, netFails } = probe;
const c = checker();
const { check } = c;

/* ══════════════ 数据准备 ══════════════ */
const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.91.${Math.floor(Math.random() * 250)}.7` };
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'imp' + Date.now().toString(36),
      nickname: '导入映射探针',
      password: 'ImportMapProbe123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data.accessToken;
const AH = { Authorization: `Bearer ${TOKEN}` };
const POST = { ...AH, ...H };

const ledger = (await (await fetch(`${API}/ledgers`, { headers: AH })).json()).data[0];
const G = (await (await fetch(`${API}${P`/ledgers/${ledger.id}/account-groups`}`, { headers: AH })).json()).data;
const grp = G.find((x) => x.id.endsWith('#grp_cash')) ?? G[0];
const acc = (
  await (
    await fetch(`${API}${P`/ledgers/${ledger.id}/accounts`}`, {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ name: '探针现金', type: 'cash', groupId: grp.id, openingBalance: '100000.00' }),
    })
  ).json()
).data;

await wipe();
const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });

/* ══════════════ 导入页 ══════════════ */
console.log('\n── 导入页：字段映射与参考文档对齐 ──');
const opened = await open('/import', { wait: '[data-role=do-preview]', theme: 'light', arm: auth.arm });
check('导入页渲染出上传区', opened === true);

const uploaded = await ev(`(() => {
  const file = new File([${JSON.stringify(refText)}], '账单_我的账本.csv', { type: 'text/csv' });
  const input = document.querySelector('[data-role=file]');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files.length;
})()`);
check('参考文件已选入 input', Number(uploaded) === 1, String(uploaded));

await ev(`document.querySelector('[data-role=do-preview]').click()`);
await waitUntil(async () => (await ev(`!!document.querySelector('[data-role=col-ref]')`)) || null, {
  label: '字段对照表渲染',
  tries: 80,
});
/**
 * 对照表没渲染时**立即停**，不要继续往下断言。
 *
 * 否则后续 `colOf('日期')` 全是 `undefined`，探针抛
 * `Cannot read properties of undefined` —— 那是一个**与被测代码无关**的崩溃，
 * 报错行号还会把人引到错误的地方（看起来像映射逻辑坏了，其实只是限流）。
 */
if (!(await ev(`!!document.querySelector('[data-role=col-ref]')`))) {
  console.log('  [诊断] toast =', await ev(`JSON.stringify([...document.querySelectorAll('#toast-root .toast')].map(t => t.textContent))`));
  console.log('  [诊断] 请求 =', await ev(`JSON.stringify(performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/import/')))`));
  console.log('  [诊断] 429 =', await ev(`JSON.stringify(performance.getEntriesByType('resource').filter(e=>e.name.includes('/import/')).map(e=>e.responseStatus))`));
  probe.close();
  probe.finish(c.results ?? [], { exitOnFail: true });
}

/* ---------- 1. 表头与参考文档逐字一致 ---------- */
/**
 * ⚠️ 必须限定在 `.imp-preview` 内。
 * 字段对照表也用了 `.imp-table`，不限定就会把它的 7 列表头一起抓进来，
 * 断言于是比对 24 列 vs 18 列 —— 是探针量错了对象，不是页面坏了。
 */
const headCells = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.imp-preview .imp-table thead th')].map(t => t.textContent.trim()))`),
);
// 表头格 = 行号列 + 文件列 + 解析结果列
const fileCols = headCells.slice(1, -1);
const normFileCols = normalizeHeader(fileCols);
check('BOM 被剥掉，首列正是「日期」', fileCols[0] === '日期', JSON.stringify(fileCols.slice(0, 3)));
check(
  `文件列与导出端表头逐字同序（兼容旧版「分类」单列）`,
  JSON.stringify(normFileCols) === JSON.stringify(EXPORT_HEADERS),
  JSON.stringify(normFileCols),
);

/* ---------- 2. 字段对照表覆盖全部 18 列 ---------- */
const cols = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('[data-role=col-ref] tbody tr')].map(tr => {
    const td = [...tr.children].map(c => c.textContent.trim());
    return {
      index: Number(td[0]),
      column: td[1],
      kind: td[2],
      values: td[3],
      required: td[4],
      target: td[5],
      defaultValue: td[6],
      hint: td[7],
    };
  }))`),
);
// 对照表渲染的是**契约**（doc），不随上传文件的列数伸缩：列名须与导出端 18 列逐格相等。
// 文件缺某列时该格会追加「文件里没有这一列」标记，比对前剥掉标记再比。
const MARK = '文件里没有这一列';
const docCols = cols.map((x) => x.column.replace(MARK, '').trim());
check('对照表行数 = 契约列数 18（无遗漏、无新增）', cols.length === EXPORT_HEADERS.length, `${cols.length} vs ${EXPORT_HEADERS.length}`);
check(
  '对照表顺序 = 文档顺序（index 连续 1..N）',
  JSON.stringify(cols.map((x) => x.index)) === JSON.stringify(cols.map((_, i) => i + 1)),
  JSON.stringify(cols.map((x) => x.index)),
);
check(
  '对照表列名与导出端契约逐格相等',
  JSON.stringify(docCols) === JSON.stringify(EXPORT_HEADERS),
  JSON.stringify(docCols),
);
// 旧版 17 列文件（只有「分类」单列）导入时，页面必须显式标注这两列文件里没有，
// 而不是静默少渲染两行——否则用户会以为主/子类别被悄悄丢了。
const missingMarked = cols.filter((x) => x.column.includes(MARK)).map((x) => x.column.replace(MARK, '').trim());
const legacyFile = normFileCols.join('|') !== fileCols.join('|');
check(
  legacyFile ? '旧版文件：主类别/子类别两格明确标注「文件里没有这一列」' : '新版文件：无任何「文件里没有这一列」标记',
  legacyFile
    ? JSON.stringify(missingMarked) === JSON.stringify(['主类别', '子类别'])
    : missingMarked.length === 0,
  JSON.stringify(missingMarked),
);
check(
  '每一列都有说明（没有空白格）',
  cols.every((x) => x.hint.length > 4),
  JSON.stringify(cols.filter((x) => x.hint.length <= 4).map((x) => x.column)),
);
check(
  '每列都标了必填 / 可选',
  cols.every((x) => x.required === '必填' || x.required === '可选'),
  JSON.stringify(cols.map((x) => `${x.column}:${x.required}`)),
);

/* ---------- 3. 必填性与去向符合文档语义 ---------- */
const colOf = (name) => cols.find((x) => x.column.startsWith(name));
check('「日期」必填 → 映射到日期', colOf('日期').required === '必填' && colOf('日期').target === '日期', JSON.stringify(colOf('日期')));
check('「金额」必填 → 映射到金额', colOf('金额').required === '必填' && colOf('金额').target === '金额', JSON.stringify(colOf('金额')));
/**
 * 「账户」列必须是**被读取**且去向为「账户」——按行归集。
 *
 * ⚠️ 此前它被标成「不读取」，导出的 18 列文件导回来时所有流水
 *    被压进「导入到哪个账户」那一个账户，账户余额集体失真而报告零失败行。
 */
check(
  '「账户」可选 → 映射到账户（按行归集，不是整批落到一个账户）',
  colOf('账户').required === '可选' && colOf('账户').target === '账户',
  JSON.stringify(colOf('账户')),
);
check('「转入账户」不读取（转账不支持批量导入）', colOf('转入账户').target === '不读取', JSON.stringify(colOf('转入账户')));
check('「商家」可选', colOf('商家').required === '可选', JSON.stringify(colOf('商家')));
check('「备注」可选', colOf('备注').required === '可选', JSON.stringify(colOf('备注')));
check('「类型」可选', colOf('类型').required === '可选', JSON.stringify(colOf('类型')));
check('「时间」可选', colOf('时间').required === '可选', JSON.stringify(colOf('时间')));
check('「名称」可选', colOf('名称').required === '可选', JSON.stringify(colOf('名称')));
check('「对象」可选', colOf('对象').required === '可选', JSON.stringify(colOf('对象')));
check('「手续费」可选', colOf('手续费').required === '可选', JSON.stringify(colOf('手续费')));
check('「折扣」可选', colOf('折扣').required === '可选', JSON.stringify(colOf('折扣')));
check('「标签」可选', colOf('标签').required === '可选', JSON.stringify(colOf('标签')));
check('「主类别」可选', colOf('主类别').required === '可选', JSON.stringify(colOf('主类别')));
check('「子类别」可选', colOf('子类别').required === '可选', JSON.stringify(colOf('子类别')));

/**
 * 非必填项必须给出「不填会怎样」的提示 —— 用户明确要求。
 * 只写「可选」是不够的：用户真正的问题是「那它到底丢不丢」。
 */
const optionalHints = cols.filter((x) => x.required === '可选').map((x) => x.hint);
check(
  '所有非必填项都说明了不填的后果（≥6 字）',
  optionalHints.every((h) => h.length >= 6),
  JSON.stringify(optionalHints.filter((h) => h.length < 6)),
);

/**
 * ⚠️ 派生列绝不能被映射。
 * 「实际值」= 金额 + 手续费 − 折扣，让系统按 amount 再重算一遍手续费
 * 会**双重计入**（docs/03 §1.2）。这是一条硬约束，必须钉死。
 */
for (const name of ['实际值', '手续费', '折扣']) {
  if (name === '实际值') {
    // 派生列（金额+手续费−折扣）：映射它会双重计入，必须「不读取」
    check('「实际值」不被读取（避免重复计入）', colOf(name).target === '不读取', JSON.stringify(colOf(name)));
  } else {
    // 手续费 / 折扣是合法可填的账单字段，必须「被读取」写入账单
    check(`「${name}」被读取（写入账单${name}字段）`, colOf(name).target === name, JSON.stringify(colOf(name)));
  }
}

/* ---------- 4. 字段对照表默认折叠，点击 summary 可正常展开 ---------- */
const refOpen = await ev(`document.querySelector('[data-role=col-ref]').open`);
check('字段对照表默认折叠（不再自动展开）', refOpen === false, String(refOpen));
/**
 * 用户要求：默认折叠，但点击 summary 必须能正常展开并显示完整映射内容。
 * 这里真点一下 summary 验证展开态，再数行数确认 18 列对照全在（没有因折叠而丢内容）。
 */
await ev(`document.querySelector('[data-role=col-ref] > summary').click()`);
await sleep(150);
const refAfter = JSON.parse(
  await ev(`JSON.stringify({
    open: document.querySelector('[data-role=col-ref]').open,
    rowCount: document.querySelectorAll('[data-role=col-ref] tbody tr').length,
  })`),
);
check('点击 summary 后对照表正常展开', refAfter.open === true, String(refAfter.open));
check(
  '展开后显示完整字段映射内容（对照行数 = 归一到新格式后的文件列数）',
  refAfter.rowCount === normFileCols.length,
  `${refAfter.rowCount} vs ${normFileCols.length}`,
);

/* ---------- 5. 5 个映射列全部自动选中（含「类型」） ---------- */
const sels = JSON.parse(
  await ev(`JSON.stringify(['imp-dateColumn','imp-amountColumn','imp-merchantColumn','imp-noteColumn','imp-recordTypeColumn','imp-accountColumn','imp-mainCategoryColumn','imp-subCategoryColumn'].map(id => ({ id, v: (document.getElementById(id)||{}).value ?? '' })))`),
);
const v = (id) => sels.find((x) => x.id === id)?.v ?? '';
check('日期列 = 日期', v('imp-dateColumn') === '日期', v('imp-dateColumn'));
check('金额列 = 金额', v('imp-amountColumn') === '金额', v('imp-amountColumn'));
check('商家列 = 商家', v('imp-merchantColumn') === '商家', v('imp-merchantColumn'));
check('备注列 = 备注', v('imp-noteColumn') === '备注', v('imp-noteColumn'));
check('类型列 = 类型（此前完全丢失）', v('imp-recordTypeColumn') === '类型', v('imp-recordTypeColumn'));
check('账户列 = 账户（此前被当作「不读取」，整批落到一个账户）', v('imp-accountColumn') === '账户', v('imp-accountColumn'));
if (fileCols.includes('主类别')) {
  check('主类别列 = 主类别', v('imp-mainCategoryColumn') === '主类别', v('imp-mainCategoryColumn'));
  check('子类别列 = 子类别', v('imp-subCategoryColumn') === '子类别', v('imp-subCategoryColumn'));
}

/* ---------- 6. 预览行按「类型」列还原记录类型 ---------- */
const parsedTypes = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.imp-preview .imp-table tbody tr')].map(tr => {
    const tds = [...tr.children];
    const raw = { date: tds[1]?.textContent.trim(), type: tds[3]?.textContent.trim() };
    const res = tds[tds.length - 1]?.textContent.trim() ?? '';
    return { rawType: raw.type, res };
  }))`),
);
const typedRows = parsedTypes.filter((x) => x.rawType);
check('预览表带出了「类型」列原文', typedRows.length > 0, String(parsedTypes.length));
const labelOf = (rawType) => {
  const row = parsedTypes.find((x) => x.rawType === rawType);
  return row ? row.res : '';
};
/**
 * ⚠️ 断言用**短名**（应收 / 应付），不是后端 `RECORD_TYPE_LABEL` 的
 * 「应收款项 / 应付款项」。前端另有一份字典且用短名 —— 那份才是导出端写进
 * CSV 的字面量，对照检查必须与文件里的原文同名，否则断言在比两套词汇表。
 */
if (labelOf('应收')) {
  check('「应收」被还原为应收（此前含「收」字被误判为收入）', /应收/.test(labelOf('应收')), labelOf('应收'));
}
if (labelOf('收入')) {
  check('「收入」被还原为收入', /收入/.test(labelOf('收入')), labelOf('收入'));
}
if (labelOf('支出')) {
  check('「支出」被还原为支出', /支出/.test(labelOf('支出')), labelOf('支出'));
}
for (const t of ['转账', '应付', '余额调整']) {
  if (labelOf(t)) {
    check(`「${t}」在预览里标明导入不支持（而不是静默改写类型）`, /导入时不支持/.test(labelOf(t)), labelOf(t));
  }
}

c.shot(await probe.shot('import-map-light-1440', { dir: OUT, focus: '[data-role=col-ref]' }));
await ev(`document.querySelector('[data-role=col-ref]').scrollIntoView({ block: 'start' })`);
await sleep(150);
c.shot(await probe.shot('import-map-table', { dir: OUT, focus: '[data-role=col-ref]' }));

/* ---------- 7. 必填常显 / 可选折叠：结构与状态 ---------- */
/**
 * 可选映射项总数 = 前端 `MAPPING_FIELDS` 里非必填的项数。
 *
 * ⚠️ 加了「账户列」之后是 12（此前 11）。新增可映射列时必须同步改这里 ——
 *    否则这一组「已配置/总数」断言会全红，而红的唯一原因是清单变长，
 *    不是折叠功能坏了。写成常量而不是散落的 11，改一处即可。
 */
const OPT_TOTAL = 12;
const OPT_RE = new RegExp(`（\\d+/${OPT_TOTAL}）$`);
/**
 * 从按钮文案里取出「已配置」的数。
 *
 * ⚠️ 不能假设初始只有 3 项被映射：服务端猜中多少列就填多少列
 *    （此前 preview 漏了 guess 兜底，这里只填 3 项；补齐后是 10 项）。
 *    断言要**按增量**写（清空一项 = 减 1），而不是钉死一个绝对数。
 */
const optCountOf = (label) => Number((label.match(/（(\d+)\//) ?? [])[1] ?? -1);
/**
 * 这一段的操作用 `change` 事件合成即可，**不花 preview 配额** ——
 * 折叠与映射状态全是前端状态，不请求服务端。
 */
const struct = JSON.parse(
  await ev(`JSON.stringify({
    reqItems: [...document.querySelectorAll('.map-block .map-item')].filter(x => x.dataset.required === '1' || x.dataset.field === 'defaultAccountId').length,
    reqBadges: [...document.querySelectorAll('.map-item[data-required="1"] .badge.is-req')].length,
    optHidden: document.querySelector('[data-role=optional-fields]').hidden,
    optDisplay: getComputedStyle(document.querySelector('[data-role=optional-fields]')).display,
    ariaExpanded: document.querySelector('[data-role=toggle-more]').getAttribute('aria-expanded'),
    label: document.querySelector('[data-role=more-text]').textContent.trim(),
    dotHidden: document.querySelector('[data-role=more-dot]').hidden,
    optCount: document.querySelectorAll('[data-role=optional-fields] .map-item').length,
  })`),
);
check('必填区始终展开（日期 / 金额 / 账户 3 项）', struct.reqItems === 3, String(struct.reqItems));
/**
 * 必填标识数 = 3：日期列 / 金额列 / 导入到哪个账户。
 * 账户虽然不是「列映射」，但同样是缺了就导不了的一项，必须同款标注。
 */
check('必填项都带「必填」标识（含导入账户）', struct.reqBadges === 3, String(struct.reqBadges));
check('可选区默认收起', struct.optHidden === true, String(struct.optHidden));
check('收起时计算样式真的是 display:none（hidden 没被 grid 盖掉）', struct.optDisplay === 'none', struct.optDisplay);
check('折叠按钮 aria-expanded=false', struct.ariaExpanded === 'false', struct.ariaExpanded);
check(`可选映射项 ${OPT_TOTAL} 个（含账户 / 主类别 / 子类别）`, struct.optCount === OPT_TOTAL, String(struct.optCount));
check('按钮文案带「已配置/总数」', OPT_RE.test(struct.label), struct.label);
check('全部可选项已映射 → 提示点可见', struct.dotHidden === false, String(struct.dotHidden));

/* 清空一个可选项 → 计数与提示点应立刻变化（不重建 DOM） */
await ev(`(() => {
  const s = document.getElementById('imp-merchantColumn');
  s.value = '';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
})()`);
const afterClear = JSON.parse(
  await ev(`JSON.stringify({
    label: document.querySelector('[data-role=more-text]').textContent.trim(),
    dotHidden: document.querySelector('[data-role=more-dot]').hidden,
  })`),
);
check(
  '清空一项后计数实时减 1',
  optCountOf(afterClear.label) === optCountOf(struct.label) - 1,
  `${struct.label} → ${afterClear.label}`,
);
check('仍有已映射项 → 提示点保留', afterClear.dotHidden === false, String(afterClear.dotHidden));

/**
 * 把**所有**可选项清空 → 折叠区里没有已映射项，提示点必须消失。
 *
 * ⚠️ 不能只清 2~3 个固定 id：服务端猜中多少列就有多少项被填上，
 *    只清固定的几个会剩下已映射项，提示点不消失 ——
 *    断言红的真因是「清单变长了」，不是折叠逻辑坏了。
 */
await ev(`(() => {
  for (const s of document.querySelectorAll('[data-role=optional-fields] select')) {
    s.value = '';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()`);
const cleared = JSON.parse(
  await ev(`JSON.stringify({
    label: document.querySelector('[data-role=more-text]').textContent.trim(),
    dotHidden: document.querySelector('[data-role=more-dot]').hidden,
  })`),
);
check('全部清空后计数为 0', optCountOf(cleared.label) === 0, cleared.label);
check('折叠区没有已映射项 → 提示点消失', cleared.dotHidden === true, String(cleared.dotHidden));

/* 展开 → 在展开态里填两项 → 收起 → 再展开，值必须一路都在 */
await ev(`document.querySelector('[data-role=toggle-more]').click()`);
await sleep(120);
const expanded = JSON.parse(
  await ev(`JSON.stringify({
    hidden: document.querySelector('[data-role=optional-fields]').hidden,
    display: getComputedStyle(document.querySelector('[data-role=optional-fields]')).display,
    aria: document.querySelector('[data-role=toggle-more]').getAttribute('aria-expanded'),
    label: document.querySelector('[data-role=more-text]').textContent.trim(),
    chevRotated: getComputedStyle(document.querySelector('.map-more__chev')).transform,
  })`),
);
check('点开后可选区可见', expanded.hidden === false && expanded.display !== 'none', JSON.stringify(expanded));
check('点开后 aria-expanded=true', expanded.aria === 'true', expanded.aria);
check('点开后按钮文案变为「收起」', /^收起/.test(expanded.label), expanded.label);
check('展开后箭头旋转 180°', expanded.chevRotated !== 'none', expanded.chevRotated);

await ev(`(() => {
  const pairs = [['imp-merchantColumn', '商家'], ['imp-noteColumn', '备注']];
  for (const [id, val] of pairs) {
    const s = document.getElementById(id);
    s.value = val;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()`);
const inOpen = await ev(`JSON.stringify([document.getElementById('imp-merchantColumn').value, document.getElementById('imp-noteColumn').value])`);

await ev(`document.querySelector('[data-role=toggle-more]').click()`);
await sleep(100);
const collapsedAgain = JSON.parse(
  await ev(`JSON.stringify({
    hidden: document.querySelector('[data-role=optional-fields]').hidden,
    label: document.querySelector('[data-role=more-text]').textContent.trim(),
    merchant: document.getElementById('imp-merchantColumn').value,
    note: document.getElementById('imp-noteColumn').value,
    date: document.getElementById('imp-dateColumn').value,
    dotHidden: document.querySelector('[data-role=more-dot]').hidden,
  })`),
);
check('再次收起后区域隐藏', collapsedAgain.hidden === true, String(collapsedAgain.hidden));
check('收起后计数为 2/3（商家 + 备注）', OPT_RE.test(collapsedAgain.label), collapsedAgain.label);
check('收起后提示点重新出现（折叠区里有已映射项）', collapsedAgain.dotHidden === false, String(collapsedAgain.dotHidden));
check(
  '收起后已填值全部保留（商家 / 备注 / 日期）',
  collapsedAgain.merchant === '商家' && collapsedAgain.note === '备注' && collapsedAgain.date === '日期',
  `${inOpen} → ${JSON.stringify(collapsedAgain)}`,
);

await ev(`document.querySelector('[data-role=toggle-more]').click()`);
await sleep(100);
const reopened = JSON.parse(
  await ev(`JSON.stringify({
    hidden: document.querySelector('[data-role=optional-fields]').hidden,
    merchant: document.getElementById('imp-merchantColumn').value,
    note: document.getElementById('imp-noteColumn').value,
    label: document.querySelector('[data-role=more-text]').textContent.trim(),
  })`),
);
check(
  '再次展开后值仍然完整（折叠状态与表单值互不影响）',
  reopened.hidden === false && reopened.merchant === '商家' && reopened.note === '备注',
  JSON.stringify(reopened),
);
check('计数在展开态同样正确（2/3）', OPT_RE.test(reopened.label), reopened.label);
/**
 * 留一个「未映射」样本给下一节的视觉比对：清掉「收支 / 类型」。
 * 它同时也是最容易被漏配的一列（不配就全按默认类型入账），
 * 拿它当对照组比拿一个无所谓的小字段更有意义。
 */
await ev(`(() => {
  const s = document.getElementById('imp-recordTypeColumn');
  s.value = '';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
})()`);

/* ---------- 8. 已映射 / 未映射的视觉区分 ---------- */
const visual = JSON.parse(
  await ev(`JSON.stringify(['dateColumn','amountColumn','merchantColumn','noteColumn','recordTypeColumn'].map(k => {
    const el = document.querySelector('.map-item[data-field="' + k + '"]');
    const cs = getComputedStyle(el);
    const flag = el.querySelector('[data-flag]');
    return {
      k,
      mapped: el.classList.contains('is-mapped'),
      missing: el.classList.contains('is-missing'),
      border: cs.borderTopColor,
      bg: cs.backgroundColor,
      flagShown: flag ? getComputedStyle(flag).display !== 'none' : null,
      value: (document.getElementById('imp-' + k) || {}).value,
    };
  }))`),
);
const byKey = Object.fromEntries(visual.map((x) => [x.k, x]));
check('已映射项带 is-mapped 且显示「已映射」标记', byKey.dateColumn.mapped && byKey.dateColumn.flagShown, JSON.stringify(byKey.dateColumn));
check('未映射项不带 is-mapped、也不显示标记', !byKey.recordTypeColumn.mapped && byKey.recordTypeColumn.flagShown === false, JSON.stringify(byKey.recordTypeColumn));
check(
  '已映射与未映射的边框/底色确实不同（不是只改文字）',
  byKey.dateColumn.border !== byKey.recordTypeColumn.border || byKey.dateColumn.bg !== byKey.recordTypeColumn.bg,
  `${byKey.dateColumn.border}/${byKey.dateColumn.bg} vs ${byKey.recordTypeColumn.border}/${byKey.recordTypeColumn.bg}`,
);

/* 清空必填项 → 必须变「未映射」醒目态，且点导入要被拦住 */
await ev(`(() => {
  const s = document.getElementById('imp-amountColumn');
  s.value = '';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(80);
const missState = JSON.parse(
  await ev(`JSON.stringify({
    missing: document.querySelector('.map-item[data-field="amountColumn"]').classList.contains('is-missing'),
    border: getComputedStyle(document.querySelector('.map-item[data-field="amountColumn"]')).borderTopColor,
    danger: getComputedStyle(document.documentElement).getPropertyValue('--c-danger').trim(),
  })`),
);
check('必填项清空后进入 is-missing 醒目态', missState.missing === true, JSON.stringify(missState));
/**
 * ⚠️ token 是 `#d70015`，`getComputedStyle` 返回 `rgb(215, 0, 21)` ——
 * 直接字符串比较必红，而这是一个**探针 bug 不是代码 bug**，
 * 极易被误当成「危险色没生效」。统一归一成 `r,g,b` 再比。
 */
const toRgb = (s) => {
  const raw = String(s).trim();
  if (raw.startsWith('#')) {
    const h = raw.slice(1);
    const full = h.length === 3 ? [...h].map((x) => x + x).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(',');
  }
  const m = raw.match(/\d+/g);
  return m ? m.slice(0, 3).join(',') : raw;
};
check('醒目态用的是语义危险色', toRgb(missState.border) === toRgb(missState.danger), `${missState.border} vs ${missState.danger}`);

const beforeReqs = await ev(`JSON.stringify(performance.getEntriesByType('resource').filter(e=>e.name.includes('/import/')).length)`);
await ev(`document.querySelector('[data-role=do-commit]').click()`);
await sleep(400);
const afterReqs = await ev(`JSON.stringify(performance.getEntriesByType('resource').filter(e=>e.name.includes('/import/')).length)`);
const toastText = await ev(`JSON.stringify([...document.querySelectorAll('#toast-root .toast')].map(t => t.textContent))`);
check('必填项缺失时点「确认导入」被拦住，不发请求', beforeReqs === afterReqs, `${beforeReqs} → ${afterReqs}`);
check('并且给出指向具体字段的提示', /金额列/.test(toastText), toastText);
check('同时把焦点落到缺的那一项', (await ev(`document.activeElement?.id ?? ''`)) === 'imp-amountColumn', await ev(`document.activeElement?.id ?? ''`));

/* 恢复映射，拍两张对照图（收起 / 展开） */
await ev(`(() => {
  const s = document.getElementById('imp-amountColumn');
  s.value = '金额';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
/* 先收成「收起」态拍一张，再点开拍一张 —— 两张图才是对照 */
if ((await ev(`document.querySelector('[data-role=optional-fields]').hidden`)) === false) {
  await ev(`document.querySelector('[data-role=toggle-more]').click()`);
  await sleep(150);
}
await ev(`document.querySelector('.map-block').scrollIntoView({ block: 'start' })`);
await sleep(150);
c.shot(await probe.shot('import-map-collapsed', { dir: OUT, focus: '.map-block' }));
await ev(`document.querySelector('[data-role=toggle-more]').click()`);
await sleep(220);
await ev(`document.querySelector('[data-role=optional-fields]').scrollIntoView({ block: 'center' })`);
await sleep(150);
c.shot(await probe.shot('import-map-expanded', { dir: OUT, focus: '[data-role=optional-fields]' }));

/**
 * 暗色只看**样式**，不重新导航。
 *
 * 重新 `open('/import')` 会把 preview 状态清掉，后面「套用模板」就无处可点
 * （再补一次 preview 又要吃配额）。而这里要验的只是「深浅两套 token 下
 * 映射块仍然有层次」，直接切 `html[data-theme]`（theme.js 干的就是这件事）
 * 足以把两套变量切过来 —— 这是样式断言，不是行为断言。
 */
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
await sleep(200);
const darkStyles = JSON.parse(
  await ev(`JSON.stringify({
    mappedBg: getComputedStyle(document.querySelector('.map-item.is-mapped')).backgroundColor,
    mappedBorder: getComputedStyle(document.querySelector('.map-item.is-mapped')).borderTopColor,
    plainBorder: getComputedStyle(document.querySelector('.map-item[data-field=defaultCategoryId]')).borderTopColor,
    moreBorder: getComputedStyle(document.querySelector('.map-more')).borderTopColor,
  })`),
);
check(
  '暗色下映射块仍有层次（已映射块与普通块边框不同）',
  darkStyles.mappedBorder !== darkStyles.plainBorder,
  JSON.stringify(darkStyles),
);
c.shot(await probe.shot('import-map-dark', { dir: OUT, focus: '.map-block' }));
await ev(`document.documentElement.setAttribute('data-theme', 'light')`);
await sleep(120);

/* ---------- 9. 「套用模板」由服务端驱动（前端不再硬编码列名） ---------- */
/**
 * ⚠️ **preview 配额预算**：`/import/preview` 限流 5 次 / 10 分钟 / 按 IP，
 * 而**浏览器发的请求不带 `X-Forwarded-For`**，全部落在 `127.0.0.1`，
 * 所以这个探针与其它探针共享同一个计数桶。
 *
 * 因此这里**只跑一次模板切换**（占 1 次），总预算 = 首读 1 次 + 切换 1 次 = 2 次。
 * 断言逻辑挑的是信息量最大的那条：本系统模板必须把「类型」列装回去。
 * 别再加第三次 —— 连跑几轮调试就会撞上 429，而 429 的表现是
 * 「对照表整块不渲染」，看起来极像代码坏了（曾真被误判过一次）。
 */
await ev(`(() => {
  const b = [...document.querySelectorAll('[data-tpl]')].find(x => x.dataset.tpl === 'cc-ledger');
  if (b) b.click();
  return true;
})()`);
await sleep(800);
const afterTpl = await ev(`(document.getElementById('imp-recordTypeColumn')||{}).value ?? ''`);
check('套用本系统模板后类型列装回「类型」（前端不硬编码列名）', afterTpl === '类型', afterTpl);
check('识别为本系统导出格式（matchedTemplate 回填）', (await ev(`!!document.querySelector('[data-role=col-ref]')`)) === true, '');

/* ══════════════ 收尾 ══════════════ */
/**
 * 429 = 限流，不是缺陷。把它单列成一条「提示」而不是失败 ——
 * 但必须**显式报出来**，不能静默过滤：否则「对照表整块不渲染」这个真症状
 * 会被当成绿，掩盖掉一个真实的用户可见故障。
 */
const is429 = (s) => /429|Too Many Requests/.test(s);
const rateLimited = [...errors, ...netFails].filter(is429);
const realErrors = errors.filter((s) => !is429(s));
const realFails = netFails.filter((s) => !is429(s));
if (rateLimited.length) {
  console.log(`⚠️ 命中 import/preview 限流（${rateLimited.length} 条 429）：/import/preview 是 5 次/10 分钟按 IP，`);
  console.log('   浏览器请求不带 X-Forwarded-For，全部落 127.0.0.1。等窗口过后重跑，或先跑别的探针。');
}
check('无控制台错误（限流除外）', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));
check('无失败请求（限流除外）', realFails.length === 0, JSON.stringify(realFails.slice(0, 3)));
const ov = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('导入页无横向溢出', Number(ov) <= 1, `溢出 ${ov}px`);

probe.close();
probe.finish(c.results ?? [], { exitOnFail: true });