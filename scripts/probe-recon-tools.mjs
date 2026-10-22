/**
 * 对账页「记账完整度」「重复扣费」—— CDP 探针
 *
 *   node scripts/probe-recon-tools.mjs
 *
 * 前端是零构建原生 ESM，一个语法错就整页白屏，而 tsc 不查它、vitest 只跑 src。
 * 所以这两个功能改完必须真开一次浏览器：
 *   1. 指标卡口径展示（已入账 / 有效 / 匹配率），空数据给「—」不是「100%」
 *   2. 「查看明细」能展开缺失清单，时间范围与账单来源筛选可用
 *   3. 重复扣费列出判定依据，确认 / 忽略点了生效且状态回流
 *   4. 空态有说明文案（不是一片空白），加载态有骨架
 *   5. 「导入账单」入口在标题之后、筛选器之前，且能真的把一份 CSV 导进去
 *      （完整度读的是 `bank_statement_lines`，不真导一次等于没测）
 *   6. 无横向溢出（窄屏）
 *
 * 纪律与胶水都在 scripts/lib/cdp.mjs。
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P } from './lib/url.mjs';
import { connect, checker } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OUT = join(process.cwd(), 'screenshots', 'recon-tools');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, shot } = probe;
const c = checker();
const { check } = c;

/* ---------- 造数据 ---------- */
const H = {
  'Content-Type': 'application/json',
  'X-Forwarded-For': `10.77.${Math.floor(Math.random() * 250)}.9`,
};
const reg = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      username: 'rtool' + Date.now().toString(36),
      nickname: '对账工具探针',
      password: 'ReconTool123!2026',
      platform: 'web',
    }),
  })
).json();
const TOKEN = reg.data?.accessToken;
check('注册成功', !!TOKEN, JSON.stringify(reg).slice(0, 120));
if (!TOKEN) {
  console.log('\n没有 token，终止');
  process.exit(1);
}
const POST = { ...H, Authorization: `Bearer ${TOKEN}` };
const j = async (path, body) => {
  const r = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: POST,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json().catch(() => ({}));
};

/**
 * ⚠️ 页面读的是会话的「当前账本」，不是探针新建的那本 ——
 * 认证注入器只能塞 token，改不了服务端记录的 current_ledger。
 * 建一本新账本去造数据，页面那边查的还是注册时自动建的那本，
 * 结果就是「明明有数据，页面全空」。所以直接拿当前账本来造。
 */
const ledgerList = (await j('/ledgers'))?.data ?? [];
const L = ledgerList.find((x) => x.isCurrent) ?? ledgerList[0];
check('取到当前账本', !!L?.id, JSON.stringify(ledgerList.map((x) => `${x.name}:${x.isCurrent}`)).slice(0, 120));

const groups = (await j(P`/ledgers/${L.id}/account-groups`))?.data ?? [];
const gBank = groups.find((g) => String(g.id).endsWith('#grp_bank')) ?? groups[0];
const acc = (await j(P`/ledgers/${L.id}/accounts`, {
  groupId: gBank?.id,
  name: '探针卡',
  type: 'debit_card',
  openingBalance: '5000.00',
}))?.data;
check('建账户', !!acc?.id, JSON.stringify(acc).slice(0, 120));

const cats = (await j(P`/ledgers/${L.id}/categories?recordType=expense`))?.data ?? [];
const leaf = (cats.find((x) => Array.isArray(x.children) && x.children.length)?.children ?? cats)[0] ?? cats[0];
check('取到二级分类', !!leaf?.id, JSON.stringify(cats.map((x) => x.name)).slice(0, 100));

const d = (n) => {
  const t = new Date();
  t.setDate(t.getDate() - n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/* 导入 3 笔流水：1 笔能匹配、2 笔匹配不上 */
const csv = ['日期,金额,摘要', `${d(1)},-10.00,甲商户`, `${d(2)},-22.22,乙商户`, `${d(3)},-33.33,丙商户`].join('\n');
const imp = await j(P`/ledgers/${L.id}/accounts/${acc.id}/statements/import`, {
  filename: 'probe.csv',
  content: csv,
  mapping: { date: '日期', amount: '金额', description: '摘要' },
});
check('导入流水', !!imp?.data, JSON.stringify(imp).slice(0, 160));
const stmtId = imp?.data?.statementId ?? imp?.data?.id;
if (stmtId) await j(P`/ledgers/${L.id}/statements/${stmtId}/match`, { windowDays: 3 });

/* 造一笔能匹配上的支出 */
await j(P`/ledgers/${L.id}/transactions`, {
  recordType: 'expense',
  direction: 'decrease',
  accountId: acc.id,
  categoryId: leaf?.id,
  amount: '10.00',
  txDate: d(1),
  name: '甲商户',
});
if (stmtId) await j(P`/ledgers/${L.id}/statements/${stmtId}/match`, { windowDays: 3 });

/* 造两笔真重复（同日同额同商户）+ 两笔跨天同额 */
const dupDate = d(5);
for (let i = 0; i < 2; i += 1) {
  await j(P`/ledgers/${L.id}/transactions`, {
    recordType: 'expense',
    direction: 'decrease',
    accountId: acc.id,
    categoryId: leaf?.id,
    amount: '77.77',
    txDate: dupDate,
    name: '重复商户',
  });
}
for (const day of [20, 22]) {
  await j(P`/ledgers/${L.id}/transactions`, {
    recordType: 'expense',
    direction: 'decrease',
    accountId: acc.id,
    categoryId: leaf?.id,
    amount: '55.55',
    txDate: d(day),
    name: '跨天商户',
  });
}

/* ---------- 打开对账页 ---------- */
const auth = authInjector({ token: TOKEN, refreshToken: reg.data.refreshToken });
await wipe();
await open('/reconciliations', { wait: '.metric-grid', theme: 'light', arm: auth.arm });

const cards = await ev(`document.querySelectorAll('.metric').length`);
check('四张指标卡都渲染', cards === 4, `${cards} 张`);

/* ---------- 1. 完整度卡片口径 ---------- */
const comp = JSON.parse(
  await ev(`(() => {
    const card = [...document.querySelectorAll('.metric')].find(
      (x) => x.querySelector('.metric__title')?.textContent.trim() === '记账完整度',
    );
    if (!card) return JSON.stringify({ found: false });
    return JSON.stringify({
      found: true,
      value: card.querySelector('.metric__value')?.textContent.trim(),
      state: card.querySelector('.metric__state')?.textContent.trim(),
      badge: card.querySelector('.badge')?.textContent.trim(),
      hasMore: !!card.querySelector('[data-role=tab-completeness]'),
      moreText: card.querySelector('[data-role=tab-completeness]')?.textContent.trim(),
    });
  })()`),
);
check('完整度卡片存在', comp.found === true);
check('完整度给出百分比（不是空的）', /%$/.test(comp.value ?? ''), comp.value);
check('完整度说明写了「已入账 X / 有效 Y 笔」', /已入账/.test(comp.state ?? '') && /\//.test(comp.state ?? ''), comp.state);
check('完整度有「查看缺失」入口', comp.hasMore === true, comp.moreText);

/* ---------- 2. 展开完整度明细 ---------- */
await ev(`document.querySelector('[data-role=tab-completeness]').click()`);
await sleep(600);
const detail = JSON.parse(
  await ev(`(() => {
    const sec = document.querySelector('[data-role=tools-detail]');
    const rows = document.querySelectorAll('.recon-miss__row:not(.recon-miss__row--head)');
    return JSON.stringify({
      hasSection: !!sec?.querySelector('.section'),
      title: sec?.querySelector('.tt-body-strong')?.textContent.trim() ?? '',
      hasRange: !!sec?.querySelector('[data-role=t-range]'),
      hasSource: !!sec?.querySelector('[data-role=t-source]'),
      sourceOptions: [...(sec?.querySelectorAll('[data-role=t-source] option') ?? [])].map((o) => o.textContent.trim()),
      rowCount: rows.length,
      firstRow: rows[0] ? [...rows[0].children].map((x) => x.textContent.trim()) : null,
      caliber: sec?.querySelector('.metric__state')?.textContent.trim() ?? '',
      emptyTitle: sec?.querySelector('.empty-state .tt-body-strong')?.textContent.trim() ?? null,
    });
  })()`),
);
check('明细面板展开', detail.hasSection === true, detail.title);
check('有时间范围筛选', detail.hasRange === true);
check('有账单来源筛选', detail.hasSource === true);
check('来源下拉有真实选项', (detail.sourceOptions ?? []).length >= 2, JSON.stringify(detail.sourceOptions));
check('列出缺失流水', detail.rowCount >= 1, `${detail.rowCount} 行`);
check('缺失行含日期/商户/金额/状态', (detail.firstRow ?? []).length === 4, JSON.stringify(detail.firstRow));
check('写明口径（已忽略不计入分母）', /口径/.test(detail.caliber ?? ''), detail.caliber);

/* 切换时间范围 → 重新拉取 */
await ev(`(() => {
  const s = document.querySelector('[data-role=t-range]');
  s.value = '30';
  s.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(900);
const afterRange = await ev(`document.querySelectorAll('.recon-miss__row:not(.recon-miss__row--head)').length`);
check('切换时间范围后重新渲染（未卡死）', typeof afterRange === 'number', `${afterRange} 行`);

/* ---------- 2b. 导入账单入口：位置 + 真导入一次 ---------- */
/**
 * ⚠️ 光断言「按钮存在」等于没测：完整度读的是 `bank_statement_lines`，
 * 只有真的把一份 CSV 导进去、并且页面随后拿到新数字，才算这条链路通了。
 * 于是这里用 CDP 的 `DOM.setFileInputFiles` 塞一个真实文件走完整流程。
 */
const impOrder = JSON.parse(
  await ev(`(() => {
    const q = '[data-role=tools-detail]';
    const seq = [...document.querySelectorAll(q + ' .section__head h2, ' + q + ' [data-role=t-import], ' + q + ' [data-role=t-range]')];
    const h2 = document.querySelector(q + ' .section__head h2');
    const b = document.querySelector(q + ' [data-role=t-import]');
    const s = document.querySelector(q + ' [data-role=t-range]');
    if (!h2 || !b || !s) return JSON.stringify({ order: [], gap: -1, before: false });
    const r1 = h2.getBoundingClientRect(), r2 = b.getBoundingClientRect(), r3 = s.getBoundingClientRect();
    return JSON.stringify({
      order: seq.map((el) => el.getAttribute('data-role') ?? 'h2'),
      gap: Math.round(r2.left - r1.right),
      before: r2.right <= r3.left + 1,
    });
  })()`),
);
check('「导入账单」入口存在', (impOrder.order ?? []).includes('t-import'), JSON.stringify(impOrder.order));
check('入口排在标题之后、时间段之前', JSON.stringify(impOrder.order) === JSON.stringify(['h2', 't-import', 't-range']), JSON.stringify(impOrder.order));
check('入口紧贴标题（不是被推到最右）', impOrder.gap >= 0 && impOrder.gap <= 16, `间距 ${impOrder.gap}px`);
check('入口在时间范围筛选的左侧', impOrder.before === true);
c.shot(await shot('recon-tools-import-entry-1440', { dir: OUT, focus: '[data-role=tools-detail] .section__head' }));

await ev(`document.querySelector('[data-role=t-import]').click()`);
await sleep(400);
const impModal = JSON.parse(
  await ev(`(() => {
    const m = document.querySelector('.modal');
    const drop = m?.querySelector('.stmt-imp__drop');
    const r = drop?.getBoundingClientRect();
    return JSON.stringify({
      open: !!m,
      title: m?.querySelector('.modal__title')?.textContent.trim() ?? '',
      accounts: m?.querySelectorAll('[data-role=account] option').length ?? 0,
      hasFile: !!m?.querySelector('[data-role=file]'),
      submitDisabled: m?.querySelector('[data-role=submit]')?.disabled ?? null,
      hasMapping: !!m?.querySelector('[data-map=date]'),
      hasNote: !!m?.querySelector('.stmt-imp__note'),
      dropTag: drop?.tagName ?? '',
      dropH: Math.round(r?.height ?? 0),
      dropW: Math.round(r?.width ?? 0),
      accTop: Math.round(m?.querySelector('[data-role=account]')?.getBoundingClientRect().top ?? 0),
      monthTop: Math.round(m?.querySelector('[data-role=month]')?.getBoundingClientRect().top ?? 0),
    });
  })()`),
);
check('点击入口打开导入弹窗', impModal.open === true, impModal.title);
check('弹窗有待导入账户可选', (impModal.accounts ?? 0) >= 1, `${impModal.accounts} 个`);
check('弹窗有文件选择', impModal.hasFile === true);
check('未选文件时「导入」不可点（避免空提交报 400）', impModal.submitDisabled === true);
check('未选文件时不显示列映射', impModal.hasMapping === false);
c.shot(await shot('recon-tools-import-empty-1440', { dir: OUT, focus: '.modal__panel' }));
check('说明条讲清「不会生成账目」', impModal.hasNote === true);
check(
  '上传区是整块可点的 label（触控 ≥44px）',
  impModal.dropTag === 'LABEL' && impModal.dropH >= 44 && impModal.dropW >= 400,
  `${impModal.dropTag} ${impModal.dropW}×${impModal.dropH}`,
);
check(
  '账户与账单月份两个控件顶边对齐',
  Math.abs(impModal.accTop - impModal.monthTop) <= 1,
  `差 ${Math.abs(impModal.accTop - impModal.monthTop)}px`,
);

/* 造一份 CSV，用 CDP 塞进 file input（真走一次导入）—— 落在系统临时目录，不脏仓库 */
const csvPath = join(tmpdir(), `probe-statement-${process.pid}.csv`);
const dayAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
writeFileSync(
  csvPath,
  ['日期,金额,摘要,商户', ...[1, 2, 3, 4].map((i) => `${dayAgo(4 + i)},-${10 + i}.00,导入行${i},导入商户${i}`)].join('\n'),
  'utf8',
);
await probe.cdp('DOM.enable');
const fobj = await probe.cdp('Runtime.evaluate', {
  expression: `document.querySelector('.modal [data-role=file]')`,
  returnByValue: false,
});
await probe.cdp('DOM.setFileInputFiles', { files: [csvPath], objectId: fobj.result.objectId });
await sleep(700);
const impMap = JSON.parse(
  await ev(`(() => {
    const m = document.querySelector('.modal');
    const v = (k) => m?.querySelector('[data-map=' + k + ']')?.value ?? '';
    return JSON.stringify({
      date: v('date'),
      amount: v('amount'),
      merchant: v('merchant'),
      desc: v('description'),
      note: m?.querySelector('[data-role=mapping] .stmt-imp__parsed')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      submitDisabled: m?.querySelector('[data-role=submit]')?.disabled ?? null,
      filled: !!m?.querySelector('.stmt-imp__drop.is-filled'),
      dropMain: m?.querySelector('[data-role=drop-main]')?.textContent.trim() ?? '',
      reqCount: m?.querySelectorAll('.stmt-imp__req').length ?? 0,
      mapCols: (() => {
        const g = m?.querySelector('.stmt-imp__map');
        return g ? getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
      })(),
    });
  })()`),
);
check('读文件后列出列映射', !!impMap.date, `date=${impMap.date}`);
check('日期列自动命中表头', impMap.date === '日期', impMap.date);
check('金额列自动命中表头', impMap.amount === '金额', impMap.amount);
check('商户/摘要列自动命中', impMap.merchant === '商户' && impMap.desc === '摘要', `${impMap.merchant}/${impMap.desc}`);
check('解析结果条报出行列数', /已读取\s*4\s*行/.test(impMap.note ?? ''), impMap.note);
check(
  '选完文件后上传区转为已选态并回显文件名',
  impMap.filled === true && /probe-statement-.*\.csv/.test(impMap.dropMain ?? ''),
  impMap.dropMain,
);
check('列映射按两列栅格排布', impMap.mapCols === 2, `${impMap.mapCols} 列`);
check('两个必填列带「必填」标记', impMap.reqCount === 2, `${impMap.reqCount} 个`);
check('选好必填列后「导入」可点', impMap.submitDisabled === false);
c.shot(await shot('recon-tools-import-modal-1440', { dir: OUT, focus: '.modal__panel' }));

/* 指定账户 + 提交 */
await ev(
  `(() => {
    const s = document.querySelector('.modal [data-role=account]');
    s.value = ${JSON.stringify(acc?.id ?? '')};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.modal [data-role=submit]').click();
  })()`,
);
await sleep(1800);
const impDone = JSON.parse(
  await ev(`(() => JSON.stringify({
    modalGone: !document.querySelector('.modal'),
    toast: document.querySelector('.toast')?.textContent.trim() ?? '',
    rows: [...document.querySelectorAll('.recon-miss__row:not(.recon-miss__row--head)')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
    caliber: document.querySelector('[data-role=tools-detail] .metric__state')?.textContent.trim() ?? '',
  }))()`),
);
check('导入完成后弹窗关闭', impDone.modalGone === true);
check('导入结果给了反馈', /导入\s*4\s*行/.test(impDone.toast ?? ''), impDone.toast);
/**
 * 清单那列优先显示**商户**（`merchant || description`），CSV 里两列都给了，
 * 所以断言要落在商户上 —— 写成「导入行1」会红，而数据其实是对的。
 */
check('缺失清单里出现刚导入的流水', (impDone.rows ?? []).some((t) => /导入商户1/.test(t)), `${(impDone.rows ?? []).length} 行`);
check('完整度口径随之刷新', /已入账/.test(impDone.caliber ?? ''), impDone.caliber);

/* ---------- 3. 重复扣费 ---------- */
await ev(`document.querySelector('[data-role=tab-duplicates]').click()`);
await sleep(700);
const dup = JSON.parse(
  await ev(`(() => {
    const sec = document.querySelector('[data-role=tools-detail]');
    const gs = [...document.querySelectorAll('.dup-group')];
    return JSON.stringify({
      title: sec?.querySelector('.tt-body-strong')?.textContent.trim() ?? '',
      groupCount: gs.length,
      hasWindow: !!sec?.querySelector('[data-role=d-window]'),
      first: gs[0]
        ? {
            title: gs[0].querySelector('.dup-group__title')?.textContent.trim(),
            reasons: gs[0].querySelector('.dup-group__reasons')?.textContent.trim(),
            items: gs[0].querySelectorAll('.dup-item').length,
            hasOpen: !!gs[0].querySelector('[data-act=open]'),
            hasConfirm: !!gs[0].querySelector('[data-act=confirm]'),
            hasIgnore: !!gs[0].querySelector('[data-act=ignore]'),
          }
        : null,
    });
  })()`),
);
check('重复扣费明细展开', /疑似重复/.test(dup.title ?? ''), dup.title);
check('有时间窗筛选', dup.hasWindow === true);
check('列出疑似重复分组', dup.groupCount >= 1, `${dup.groupCount} 组`);
check('组标题含商户/金额/笔数', /重复商户|跨天商户/.test(dup.first?.title ?? ''), dup.first?.title);
check('列出判定依据', /判定依据/.test(dup.first?.reasons ?? '') && /金额相同/.test(dup.first?.reasons ?? ''), dup.first?.reasons);
check('每组有「查看详情」', dup.first?.hasOpen === true);
check('每组有「确认重复」与「忽略」', dup.first?.hasConfirm === true && dup.first?.hasIgnore === true);
check('组内列出成员账目', (dup.first?.items ?? 0) >= 2, `${dup.first?.items} 笔`);

c.shot(await shot('recon-tools-dup-light-1440', { dir: OUT, focus: '.dup-group' }));

/* ---------- 4. 忽略生效 ---------- */
const clicked = await ev(`(() => {
  const g = document.querySelector('.dup-group');
  const key = g?.getAttribute('data-group');
  g?.querySelector('[data-act=ignore]')?.click();
  return key ?? '';
})()`);
await sleep(1200);
const afterIgnore = await ev(
  `(() => [...document.querySelectorAll('.dup-group')].some((g) => g.getAttribute('data-group') === ${JSON.stringify(clicked)}))()`,
);
check('忽略后该组从列表消失', afterIgnore === false, `key=${clicked.slice(0, 30)}`);

/* 勾选「显示已忽略」→ 它回来且状态为已忽略 */
await ev(`(() => {
  const cb = document.querySelector('[data-role=d-reviewed]');
  if (!cb) return;
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(1200);
const back = await ev(
  `(() => {
    const g = [...document.querySelectorAll('.dup-group')].find((x) => x.getAttribute('data-group') === ${JSON.stringify(clicked)});
    return g ? g.querySelector('.badge')?.textContent.trim() : null;
  })()`,
);
check('勾选「显示已忽略」后重新可见', back !== null, String(back));
check('已忽略组标注为「已忽略」', back === '已忽略', String(back));

/* ---------- 5. 空态：换一个全新用户（它的当前账本必然是空的） ---------- */
const reg2 = await (
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { ...H, 'X-Forwarded-For': `10.88.${Math.floor(Math.random() * 250)}.4` },
    body: JSON.stringify({
      username: 'rempty' + Date.now().toString(36),
      nickname: '空态探针',
      password: 'ReconEmpty123!2026',
      platform: 'web',
    }),
  })
).json();
check('注册第二个用户（空态用）', !!reg2?.data?.accessToken, JSON.stringify(reg2).slice(0, 120));
const auth2 = authInjector({ token: reg2.data.accessToken, refreshToken: reg2.data.refreshToken });
await open('/reconciliations', { wait: '.metric-grid', theme: 'light', arm: auth2.arm });
await sleep(400);
const emptyState = JSON.parse(
  await ev(`(() => {
    const card = [...document.querySelectorAll('.metric')].find(
      (x) => x.querySelector('.metric__title')?.textContent.trim() === '记账完整度',
    );
    return JSON.stringify({
      value: card?.querySelector('.metric__value')?.textContent.trim(),
      state: card?.querySelector('.metric__state')?.textContent.trim(),
      badge: card?.querySelector('.badge')?.textContent.trim(),
    });
  })()`),
);
check('空账本完整度显示「—」而不是「100%」', emptyState.value === '—', String(emptyState.value));
check('空账本说明「还没有导入过流水」', /还没有导入过流水/.test(emptyState.state ?? ''), emptyState.state);
check('空账本徽标为「待开始」', emptyState.badge === '待开始', String(emptyState.badge));

await ev(`document.querySelector('[data-role=tab-completeness]')?.click()`);
await sleep(700);
const emptyDetail = await ev(
  `document.querySelector('[data-role=tools-detail] .empty-state .tt-body-strong')?.textContent.trim() ?? null`,
);
check('空账本明细给出空态说明（不是空白）', !!emptyDetail, String(emptyDetail));

/* ---------- 6. 窄屏不溢出 ---------- */
await open('/reconciliations', { wait: '.metric-grid', theme: 'light', width: 390, height: 844, mobile: true, arm: auth.arm });
await sleep(500);
/* 先看完整度头部：标题 + 导入入口 + 两个下拉在 390px 下必须能换行收住 */
await ev(`document.querySelector('[data-role=tab-completeness]')?.click()`);
await sleep(800);
const narrowHead = JSON.parse(
  await ev(`(() => {
    const b = document.querySelector('[data-role=t-import]');
    const r = b?.getBoundingClientRect();
    return JSON.stringify({ has: !!b, right: Math.round(r?.right ?? -1), vw: document.documentElement.clientWidth });
  })()`),
);
check('窄屏下「导入账单」入口仍在', narrowHead.has === true);
check('窄屏下入口未越界', narrowHead.right <= narrowHead.vw + 1, `${narrowHead.right} vs ${narrowHead.vw}`);
c.shot(await shot('recon-tools-import-entry-390', { dir: OUT, focus: '[data-role=tools-detail] .section__head' }));
await ev(`document.querySelector('[data-role=tab-duplicates]')?.click()`);
await sleep(800);
const overflow = JSON.parse(
  await ev(`(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll('[data-role=tools-detail] *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > de.clientWidth + 1;
    });
    return JSON.stringify({ scrollW: de.scrollWidth, clientW: de.clientWidth, wide: wide.length });
  })()`),
);
check('窄屏无横向溢出', overflow.scrollW <= overflow.clientW + 1, `${overflow.scrollW} vs ${overflow.clientW}`);
check('窄屏无元素越界', overflow.wide === 0, `${overflow.wide} 个`);

c.shot(await shot('recon-tools-390', { dir: OUT, focus: '.dup-group' }));

/* ---------- 7. 暗色：浮层不能在深页上白得发光 ---------- */
await open('/reconciliations', { wait: '.metric-grid', theme: 'dark', arm: auth.arm });
await sleep(500);
await ev(`document.querySelector('[data-role=tab-completeness]')?.click()`);
await sleep(700);
await ev(`document.querySelector('[data-role=t-import]')?.click()`);
await sleep(400);
const darkModal = JSON.parse(
  await ev(`(() => {
    const p = document.querySelector('.modal__panel');
    const title = document.querySelector('.modal__title');
    const note = document.querySelector('.stmt-imp__note');
    const drop = document.querySelector('.stmt-imp__drop');
    const avg = (s) => {
      const c = (s || '').match(/\\d+/g) || [];
      return c.length >= 3 ? Math.round((+c[0] + +c[1] + +c[2]) / 3) : -1;
    };
    return JSON.stringify({
      open: !!p,
      panelLum: p ? avg(getComputedStyle(p).backgroundColor) : -1,
      titleLum: title ? avg(getComputedStyle(title).color) : -1,
      noteBg: note ? getComputedStyle(note).backgroundColor : '',
      dropBg: drop ? getComputedStyle(drop).backgroundColor : '',
    });
  })()`),
);
check('暗色下导入弹窗可打开', darkModal.open === true);
check('暗色下弹窗面板不是白底（夜间必须换深面）', darkModal.panelLum >= 0 && darkModal.panelLum < 90, `亮度 ${darkModal.panelLum}`);
check('暗色下标题是浅色文字（不是深字压深底）', darkModal.titleLum - darkModal.panelLum > 60, `字 ${darkModal.titleLum} / 面 ${darkModal.panelLum}`);
check('暗色下说明条/上传区有面（不是透明）', /rgba?\(/.test(darkModal.noteBg) && /rgba?\(/.test(darkModal.dropBg), `${darkModal.noteBg} / ${darkModal.dropBg}`);
c.shot(await shot('recon-tools-import-dark-1440', { dir: OUT, focus: '.modal__panel' }));

console.log('\n截图：', c.shots.join('\n       '));
const bad = c.results.filter((r) => !r.ok);
console.log(`\n结果：${c.results.length - bad.length} 通过 / ${bad.length} 失败`);
process.exit(bad.length ? 1 : 0);
