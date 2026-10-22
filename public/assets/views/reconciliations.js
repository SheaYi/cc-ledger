/**
 * 对账历史与账本健康度（`docs/04 §12.3 / §12.4`，`docs/05 §9.7`）
 *
 * ## 为什么要有这一页
 *
 * 对账这个动作在 `/accounts` 里发生（每个账户一个「对账」按钮 → 面板），
 * 但**对完就结束了**：面板收起后，这次对账的账面/实际/差额/原因/操作人
 * 只留在 `reconciliation_records` 表里，前端没有任何入口能看到。
 *
 * 这不是锦上添花。口径变更（`docs/14`）之后尤其要紧：历史记录里的
 * `systemBalance` 是**当时按当时口径算出来的**，变更日之前的记录与之后的
 * 记录**不可直接比较**。用户看到余额跳变时的第一反应是「我的钱丢了」，
 * 而答案就在这些记录里 —— 他得能翻到它。
 *
 * ## 两个数据源，一页呈现
 *
 *   · `reconciliationSummary` → 账本健康度：对过几个账户、90 天对了几次、
 *     平均差额多大、**哪些账户该对了**。这是「现在该做什么」。
 *   · `listReconciliations` → 历史记录流。这是「过去发生了什么」。
 *
 * 后端两个接口早就存在且**前端从未调用过**，这一页是它们的第一个消费方。
 *
 * ## 口径标注必须挂在记录上，不能只写页脚
 *
 * 每条记录带 `legacyBoundary`（`createdAt` 早于口径变更日即 true）。
 * 用户翻历史通常是为了核对**某一条**，图省事只在页头写一句总说明等于没写。
 *
 * ## 版式：这一页自己管了三套列定义
 *
 * 复用既有排版类（`stat-strip` / `badge` / `empty-state` / `list-meta` /
 * `section` / `card`），但**不复用 `.recon-line`** —— 它是 flex 两端对齐，
 * 每一行独立算宽，同一列在上下行必然错位。本页的四处列表（排期、记录、
 * 该对账了、卡内明细）统一改成「列定义写进 `--*-cols` 变量、表头与数据行
 * 引用同一个变量」的栅格，详见 app.css「对账历史页」那一节。
 * 原则是**：同一套列的宽度定义只能存在一处**，改列只改一处。
 *
 * 新增的类只有 `.recon-sched*` / `.recon-hist*` / `.metric*` / `.recon-todo*`
 * 这四族（记录行的四列布局没有现成等价物）。不新造 `badge--success` 这类
 * 「看起来该有」的类：它们和既有阶梯差一档就等于把阶梯完整性打坏了
 * （见 MEMORY 的排版纪律）—— 三态一律用既有的 `.badge` / `.badge--accent` /
 * `.badge--danger`。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { esc, icon, money, setLoading, toast, todayStr, RECONCILE_REASON_LABEL } from '../ui.js';

/**
 * 收支配色。与股票相反 —— 本项目「负向 = 红、正向 = 绿」
 * （`.is-neg/.is-pos`，代码注释里已写明，别按 A 股直觉反过来）。
 *
 * ⚠️ 只能给**有符号含义**的数字用。差额有（多出来/少了），
 * 「平均差额」没有（它是 `avg(abs(...))`，恒正 —— 染绿等于在说「差得挺好」）。
 */
function toneClass(v) {
  const n = Number(v ?? 0);
  return n < 0 ? 'is-neg' : n > 0 ? 'is-pos' : 'is-zero';
}

/** `2026-10-01T20:00:00+08:00` → `10-01 20:00`；非法值原样返回 */
function shortStamp(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(iso ?? '');
}

/** 相对天数的自然说法。null = 从未对账，与「对过但很久」不是一回事 */
function daysText(days) {
  if (days === null || days === undefined) return '从未对账';
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function dateFromDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ================================================================== *
 * 银行流水导入 —— 记账完整度的数据来源
 * ================================================================== */

/**
 * 为什么要在这里做导入：完整度读的是 `bank_statement_lines`，
 * 而这张表**只有流水导入会写**。此前全站没有导入入口，于是完整度永远
 * 是「还没有导入过流水」—— 空态文案还让用户「到账户页导入」，
 * 可账户页也没有这个入口。指标本身没错，是它依赖的动作根本做不了。
 */

/**
 * 与服务端 `parseCsv` **同一套规则**：只认逗号、双引号转义、丢空行。
 *
 * ⚠️ 这不是「前端再实现一个 CSV 解析」：列清单必须与服务端解析出的列
 * **逐项同名**，服务端用 `header.indexOf(name)` 找列，两处规则不一致
 * 就会报「找不到列 X」，而用户看到的表头明明有那一列。
 */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** 表头 → 字段的猜测表。命不中就留空让用户选，绝不「猜一个装作对」 */
const COLUMN_HINTS = {
  date: ['日期', '交易日期', '交易时间', '记账日期', 'date'],
  amount: ['金额', '交易金额', '发生额', 'amount'],
  amountOut: ['支出', '支出金额', '借方', 'debit'],
  description: ['摘要', '商品说明', '备注', '交易类型', 'description'],
  merchant: ['商户', '商家', '交易对方', '对方账户', '收款方', '付款方', 'merchant'],
  balance: ['余额', '账户余额', 'balance'],
};

function guessColumn(header, field, used) {
  for (const kw of COLUMN_HINTS[field] ?? []) {
    const hit = header.find((h) => {
      const name = String(h ?? '').trim();
      return !used.has(name) && name.toLowerCase().includes(kw);
    });
    if (hit !== undefined) return hit;
  }
  return '';
}

/**
 * 整表一次猜完，且**一列只能被猜中一次**。
 *
 * ⚠️ 顺序是 `amountOut` 先于 `amount`：银行的「两列式」表头常写成
 * `收入金额 / 支出金额`，两列都含「金额」。若先猜 `amount`，它会拿走
 * 「支出金额」，`amountOut` 再拿走「收入金额」—— 于是每一笔收入都被当成支出。
 */
function guessMapping(header) {
  const used = new Set();
  const out = {};
  for (const key of ['date', 'amountOut', 'amount', 'description', 'merchant', 'balance']) {
    const hit = guessColumn(header, key, used);
    out[key] = hit;
    if (hit) used.add(hit);
  }
  return out;
}

/**
 * 读文件为文本。
 *
 * ⚠️ 国内银行导出的 CSV 多为 GBK，直接按 UTF-8 读会满屏乱码，
 * 而用户只会说「导入坏了」。判据与服务端 `decodeText` 一致：
 * UTF-8 解出替换字符（U+FFFD）就改用 GBK 解一遍。
 */
async function readCsvText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      /* 浏览器不支持 GBK 就沿用 UTF-8 的结果，不强改 */
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 导入弹窗的字段槽（键与服务端 `ColumnMapping` 一致） */
const IMPORT_FIELDS = [
  { key: 'date', label: '日期列', required: true, hint: '每行都得有日期，缺了这一列整行会被跳过' },
  { key: 'amount', label: '金额列', required: true, hint: '带正负号填这一列；分两列时这里填收入列' },
  { key: 'amountOut', label: '支出列', hint: '金额分成「收入/支出」两列时填这里' },
  { key: 'description', label: '摘要列', hint: '对不上时靠它人工核对' },
  { key: 'merchant', label: '商户列', hint: '商户相同的流水才能被判成疑似重复' },
  { key: 'balance', label: '余额列', hint: '只记录不参与匹配' },
];

/**
 * 打开导入弹窗。
 *
 * 做成弹窗而不是跳 `/import`：那一页导入的是**账目**（直接生成账单），
 * 跟这里要的「银行流水（只用来核对）」是两件事，混在一起会让用户以为
 * 导入完账目被记了两遍。
 */
function openStatementImport({ ledger, accounts, accountId, onDone }) {
  const usable = (accounts ?? []).filter((a) => a.kind !== 'virtual');
  if (!usable.length) {
    toast('还没有能对账的账户，先去账户页建一个', 'error');
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `
    <div class="modal__scrim" data-role="scrim"></div>
    <div class="modal__panel modal__panel--import" role="dialog" aria-modal="true" aria-labelledby="stmt-imp-title" tabindex="-1">
      <div class="modal__head">
        <h3 class="modal__title" id="stmt-imp-title">导入银行账单</h3>
        <button class="btn btn--icon" type="button" data-role="close" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      <div class="modal__body stack stack--md">
        <p class="stmt-imp__note">
          <span class="stmt-imp__note-icon" aria-hidden="true">${icon('info', 16)}</span>
          <span>导入的是<b>银行流水</b>，只用来核对账本有没有漏记 —— 不会生成任何账目。</span>
        </p>
        <div class="field-row stmt-imp__pair">
          <label class="field">
            <span class="field__label">账户</span>
            <select class="input" data-role="account">
              ${usable
                .map(
                  (a) =>
                    `<option value="${esc(a.id)}"${a.id === accountId ? ' selected' : ''}>${esc(a.name)}</option>`,
                )
                .join('')}
            </select>
          </label>
          <label class="field">
            <span class="field__label">账单月份</span>
            <input class="input" type="month" data-role="month" />
            <span class="field__hint">留空则取第一行的日期</span>
          </label>
        </div>
        <div class="field">
          <span class="field__label">CSV 文件</span>
          <label class="stmt-imp__drop" data-role="drop">
            <input class="stmt-imp__file" type="file" accept=".csv,.txt" data-role="file" />
            <span class="stmt-imp__drop-icon" data-role="drop-icon" aria-hidden="true">${icon('upload', 22)}</span>
            <span class="stmt-imp__drop-main" data-role="drop-main">选择 CSV 文件</span>
            <span class="stmt-imp__drop-sub" data-role="drop-sub"
              >逗号分隔，第一行为表头 · UTF-8 与 GBK 都能读</span
            >
          </label>
        </div>
        <div data-role="mapping"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--secondary btn--sm" type="button" data-role="cancel">取消</button>
        <button class="btn btn--sm" type="button" data-role="submit" disabled>导入</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const mappingSlot = wrap.querySelector('[data-role=mapping]');
  const submitBtn = wrap.querySelector('[data-role=submit]');
  const fileInput = wrap.querySelector('[data-role=file]');
  const dropEl = wrap.querySelector('[data-role=drop]');
  const dropIcon = wrap.querySelector('[data-role=drop-icon]');
  const dropMain = wrap.querySelector('[data-role=drop-main]');
  const dropSub = wrap.querySelector('[data-role=drop-sub]');
  let content = '';
  let filename = '';
  let header = [];
  /** 表头之外的行数 —— 只有表头没有数据时不该放行（会建出一个空批次） */
  let dataRows = 0;

  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-role=scrim],[data-role=close],[data-role=cancel]')) close();
  });

  /**
   * 上传区只有两种状态：空（上箭头 + 「选择 CSV 文件」）与已选（对勾 + 文件名）。
   * 只换图标与文案，不换结构 —— 两种状态的撑高一样，选完文件弹窗不会跳一下。
   */
  function paintDrop(name) {
    const filled = Boolean(name);
    dropEl.classList.toggle('is-filled', filled);
    dropIcon.innerHTML = icon(filled ? 'check' : 'upload', 22);
    dropMain.textContent = name || '选择 CSV 文件';
    dropSub.textContent = filled
      ? '文件已读取 · 点击可更换'
      : '逗号分隔，第一行为表头 · UTF-8 与 GBK 都能读';
  }

  /** 换成一个读不出来的文件时，把上一次的解析结果彻底清掉，别让「导入」还亮着 */
  function resetPicked() {
    content = '';
    filename = '';
    header = [];
    dataRows = 0;
    mappingSlot.innerHTML = '';
    paintDrop('');
    syncSubmit();
  }

  function currentMapping() {
    const val = (key) => wrap.querySelector(`[data-map=${key}]`)?.value ?? '';
    return {
      date: val('date'),
      amount: val('amount'),
      amountOut: val('amountOut') || null,
      description: val('description') || null,
      merchant: val('merchant') || null,
      balance: val('balance') || null,
    };
  }

  /**
   * 只有「选了文件 + 日期列 + 金额列」才允许提交。
   * 不这么做的话，用户点「导入」会拿到一个「找不到列」的 400，
   * 而他明明什么都没选 —— 错误里不会写「你还没选文件」。
   */
  function syncSubmit() {
    const m = currentMapping();
    submitBtn.disabled = !(content && dataRows > 0 && m.date && m.amount);
  }

  function paintMapping(rows) {
    dataRows = Math.max(rows.length - 1, 0);
    const dupNames = new Set(header).size !== header.length;
    const guess = guessMapping(header);
    /** 重名列与「只有表头」都不是错误，但都会让导入结果跟用户预期不一样，用警示色说清 */
    const warn = dupNames || dataRows === 0;
    const summary =
      dataRows === 0
        ? '只读到表头，没有数据行 —— 确认一下是不是选错了文件'
        : `已读取 <b class="tnum">${esc(String(dataRows))}</b> 行 · <b class="tnum">${esc(
            String(header.length),
          )}</b> 列${dupNames ? ' · 表头有重名列，只会取第一列' : ''}`;
    mappingSlot.innerHTML = `
      <div class="stack stack--sm">
        <p class="stmt-imp__parsed" data-tone="${warn ? 'warn' : 'ok'}">
          <span class="stmt-imp__parsed-icon" aria-hidden="true">${icon(warn ? 'info' : 'check', 14)}</span>
          <span>${summary}</span>
        </p>
        <div class="stmt-imp__maphead">
          <span class="tt-caption-strong">列映射</span>
          <span class="tt-caption text-muted">带「必填」的两列不选就不能导入</span>
        </div>
        <div class="stmt-imp__map">
          ${IMPORT_FIELDS.map(
            (f) => `<label class="field">
              <span class="field__label">${esc(f.label)}${
                f.required ? '<span class="stmt-imp__req">必填</span>' : ''
              }</span>
              <select class="input" data-map="${esc(f.key)}">
                ${f.required ? '<option value="">请选择</option>' : '<option value="">不使用</option>'}
                ${header
                  .map(
                    (h) =>
                      `<option value="${esc(h)}"${guess[f.key] === h ? ' selected' : ''}>${esc(h || '（空列名）')}</option>`,
                  )
                  .join('')}
              </select>
              ${f.hint ? `<span class="field__hint">${esc(f.hint)}</span>` : ''}
            </label>`,
          ).join('')}
        </div>
      </div>`;
    syncSubmit();
  }

  mappingSlot.addEventListener('change', syncSubmit);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      content = await readCsvText(file);
    } catch {
      resetPicked();
      toast('这个文件读不出来，换个 CSV 试试', 'error');
      return;
    }
    filename = file.name;
    const rows = parseCsvRows(content);
    header = rows[0] ?? [];
    if (!header.length) {
      resetPicked();
      toast('没读到表头，确认一下是不是逗号分隔的 CSV', 'error');
      return;
    }
    paintDrop(file.name);
    paintMapping(rows);
  });

  submitBtn.addEventListener('click', async () => {
    const mapping = currentMapping();
    const month = wrap.querySelector('[data-role=month]').value || null;
    const targetAccount = wrap.querySelector('[data-role=account]').value;
    setLoading(submitBtn, true, '导入中');
    try {
      const res = await Api.importBankStatement(ledger.id, targetAccount, {
        filename,
        content,
        mapping,
        statementMonth: month,
      });
      const d = res?.data ?? {};
      const s = d.matchSummary ?? {};
      /**
       * 结果要说清两件事：进了多少行、**有多少行已经对上账**。
       * 只报行数的话，用户看到「导入 100 行」会以为完整度该是 100%。
       */
      toast(
        `导入 ${d.rowCount ?? 0} 行，已自动对上 ${s.matched ?? 0} 笔${
          Number(d.duplicateCount ?? 0) ? `，${d.duplicateCount} 行本批内重复已标记待确认` : ''
        }`,
      );
      close();
      onDone?.();
    } catch (err) {
      setLoading(submitBtn, false);
      toast(err?.message ?? '导入失败', 'error');
    }
  });

  /**
   * 焦点移进 dialog（a11y），但别落在被视觉隐藏的文件 input 上 ——
   * 那会给上传区套一圈焦点环，看着像「已选中」，而用户其实还没选。
   */
  wrap.querySelector('.modal__panel')?.focus();
}

export async function renderReconciliations(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  /** 筛选初值取自 URL —— 分享/刷新能保持，但不必进 app.js 的路由表 */
  const params = new URLSearchParams(window.location.search);
  let accountFilter = params.get('accountId') ?? '';
  let range = params.get('range') ?? '90';

  const [summary, accRes] = await Promise.all([
    Api.reconciliationSummary(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
  ]);
  /** 虚拟账户是台账口径，从不对账，不进筛选项（否则选出来永远是空） */
  const accounts = accRes.filter((a) => a.kind !== 'virtual');

  const frame = appFrame({
    active: 'reconciliations',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">对账历史</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 每次对账的账面、实际与差额都留痕，可随时回查
            </p>
          </div>
          <button class="btn btn--secondary btn--sm" type="button" data-role="to-accounts">
            ${icon('wallet', 16)}<span>去对账</span>
          </button>
        </div>
      </div>

      <div class="stat-strip recon-hist__health" data-role="health"></div>
      <div data-role="todo"></div>
      <div data-role="schedule"></div>
      <div data-role="tools"></div>
      <div data-role="tools-detail"></div>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">对账记录</h2>
          <div class="row row--md row--wrap recon-hist__filters">
            <select class="input recon-hist__select" data-role="f-account" aria-label="按账户筛选">
              <option value="">全部账户</option>
              ${accounts
                .map(
                  (a) =>
                    `<option value="${esc(a.id)}"${a.id === accountFilter ? ' selected' : ''}>${esc(a.name)}</option>`,
                )
                .join('')}
            </select>
            <select class="input recon-hist__select" data-role="f-range" aria-label="时间范围">
              <option value="30"${range === '30' ? ' selected' : ''}>近 30 天</option>
              <option value="90"${range === '90' ? ' selected' : ''}>近 90 天</option>
              <option value="365"${range === '365' ? ' selected' : ''}>近一年</option>
              <option value=""${range === '' ? ' selected' : ''}>全部</option>
            </select>
          </div>
        </div>
        <div data-role="list"></div>
      </section>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'reconciliations', go, ledger });

  const healthSlot = frame.querySelector('[data-role=health]');
  const todoSlot = frame.querySelector('[data-role=todo]');
  const schedSlot = frame.querySelector('[data-role=schedule]');
  const toolsSlot = frame.querySelector('[data-role=tools]');
  const toolsDetailSlot = frame.querySelector('[data-role=tools-detail]');
  const listSlot = frame.querySelector('[data-role=list]');
  const accSelect = frame.querySelector('[data-role=f-account]');
  const rangeSelect = frame.querySelector('[data-role=f-range]');

  /* ---------------- 健康度 ---------------- */

  function paintHealth() {
    const need = summary.unreconciledList ?? [];
    /**
     * 「该对账了」里混着两种情况，权重完全不同：
     *   · 对过但**当前差额非零**（`currentDiff ≠ 0`）→ 更紧急，改完才算对过
     *   · 超过 30 天没对（`daysSinceReconcile` 大）
     * 混在一张列表里按同一句文案渲染，会让「从没对过」和「对完还差着」看起来一样重。
     */
    const drifted = need.filter((x) => Number(x.currentDiff ?? 0) !== 0);
    const stale = need.filter((x) => (x.daysSinceReconcile ?? 0) > 30);
    /**
     * ⚠️ **「从未对账」必须单列一类**。
     *
     * 后端把 `lastReconciledAt === null` 的账户也塞进 `unreconciledList`，
     * 但它的 `daysSinceReconcile` 是 **null**。而上面两个过滤条件是
     * `currentDiff !== 0` 和 `daysSinceReconcile > 30` —— `null > 30` 为 false，
     * `null ?? 0` 也不大于 30，于是这类账户**从两个条件里都漏出去**，
     * 待办清单里看不到它，兜底文案于是打印「所有账户都对过」。
     *
     * 那是**最坏的一种错**：新账户完全不存在于待办里，而用户被告知一切正常。
     * （第一版截图就是 2/3 已对账却写着「所有账户都对过」。）
     */
    const never = need.filter(
      (x) => x.lastReconciledAt === null || x.lastReconciledAt === undefined,
    );
    /** 只列真正需要动作的：从未对过 / 对完还差着 / 超过 30 天没对 */
    const pending = never.length + drifted.length + stale.length;

    healthSlot.innerHTML = `
      <div class="stat-strip__cell">
        <span class="stat-strip__label">已对账账户</span>
        <span class="stat-strip__value tnum">${summary.reconciledAccounts} / ${summary.totalAccounts}</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">当前有差额</span>
        <span class="stat-strip__value tnum ${summary.accountsWithDiff ? 'is-neg' : 'is-zero'}">${
          summary.accountsWithDiff
        }</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">近 90 天对账</span>
        <span class="stat-strip__value tnum">${summary.reconcileCount90d} 次</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">平均差额</span>
        <!--
          刻意**不**套 toneClass：avgAbsDiff 是 avg(abs(diff))，恒为正，
          按收支配色（正=绿）会把它染绿，读起来像「平均差 ¥33 挺好的」。
          平均差额的大小本身没有好坏，只有「比上次大/小」，这一版没有上期值可比。
          语义色只给**有符号含义**的数字用（差额有，avgAbsDiff 没有）。
        -->
        <span class="stat-strip__value tnum">${money(summary.avgAbsDiff)}</span>
      </div>
    `;

    todoSlot.innerHTML = pending
      ? `
      <div class="card stack stack--sm">
        <div class="recon-todo">
          <div class="recon-todo__row">
            <span class="tt-caption recon-todo__name text-muted">该对账了</span>
            <span class="tt-body-strong">${pending} 个账户</span>
          </div>
          ${never
            .map(
              (x) => `<div class="recon-todo__row">
              <span class="tt-caption recon-todo__name">${esc(x.accountName)}</span>
              <span class="tt-caption text-muted">从未对账</span>
            </div>`,
            )
            .join('')}
          ${drifted
            .map(
              (x) => `<div class="recon-todo__row">
              <span class="tt-caption recon-todo__name">${esc(x.accountName)}</span>
              <span class="tt-caption is-neg tnum">当前差额 ${money(x.currentDiff)}</span>
            </div>`,
            )
            .join('')}
          ${stale
            .map(
              (x) => `<div class="recon-todo__row">
              <span class="tt-caption recon-todo__name">${esc(x.accountName)}</span>
              <span class="tt-caption text-muted">${daysText(x.daysSinceReconcile)}没对了</span>
            </div>`,
            )
            .join('')}
        </div>
        <button class="btn btn--sm btn--secondary" type="button" data-role="go-recon">去账户页对账</button>
      </div>`
      : `
      <div class="card">
        <p class="tt-caption text-muted">所有账户都对过，且当前无差额。</p>
      </div>`;

    todoSlot.querySelector('[data-role=go-recon]')?.addEventListener('click', () => go('/accounts'));
  }

  /* ---------------- 记录列表 ---------------- */

  /**
   * 记录行 = 四列栅格：**标签 / 状态 / 金额 / 时间**（列定义见 app.css 的 `--hist-cols`）。
   *
   * 以前是「左叙述 + 右数字」两栏，右栏的起始 x 由左栏有多长决定 ——
   * 某一行多一行归因说明，右栏整体就被推走，账面与实际对不齐。
   * 现在是四列，金额与时间各自占固定的列，互相不再拉扯。
   *
   * ⚠️ 两个**取值锚点**不能动（探针与人工核对都依赖它）：
   *   · 行内**第一个** `.tt-body-strong` = 账户名 —— 所以 ① 列里
   *     不能出现第二个同类节点；
   *   · 行内**第一个** `.tt-fine-print` = 含 `reconcileDate` 的日期行 ——
   *     所以金额标签与归因说明都用自己的类（`.recon-hist__num-label` /
   *     `.recon-hist__reason` / `.recon-hist__sub`），不复用 tt-fine-print。
   *     这是「只要读错一个同类兄弟节点就静默取到别的句子」的那类错误，不报错。
   */
  function rowHtml(r) {
    const balanced = r.isBalanced;
    const reason = [
      r.reasonCode ? RECONCILE_REASON_LABEL[r.reasonCode] ?? r.reasonCode : '',
      r.reasonNote ?? '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `
      <div class="recon-hist__row">
        <div class="recon-hist__label">
          <span class="tt-body-strong recon-hist__acct">${esc(r.account?.name ?? '—')}</span>
          ${
            reason
              ? `<span class="recon-hist__reason" title="${esc(reason)}">${esc(reason)}</span>`
              : ''
          }
        </div>
        <div class="recon-hist__status">
          ${
            balanced
              ? `<span class="badge badge--dark">账实相符</span>`
              : `<span class="badge">差额 <span class="tnum ${toneClass(r.diffAmount)}">${money(
                  r.diffAmount,
                )}</span></span>`
          }
          ${
            r.legacyBoundary
              ? `<span class="badge" title="该记录录入于 ${esc(
                  (r.createdAt ?? '').slice(0, 10),
                )}，账面余额按旧口径计算（建账当天的流水不计入）">旧口径</span>`
              : ''
          }
        </div>
        <div class="recon-hist__nums">
          <span class="recon-hist__num"
            ><span class="recon-hist__num-label">账面</span
            ><span class="tnum recon-hist__amt">${money(r.systemBalance)}</span></span
          >
          <span class="recon-hist__num"
            ><span class="recon-hist__num-label">实际</span
            ><span class="tnum recon-hist__amt">${money(r.actualBalance)}</span></span
          >
          ${
            r.adjustmentTransactionId
              ? `<a class="recon-hist__adj" href="/transactions/${encodeURIComponent(
                  r.adjustmentTransactionId,
                )}" data-link>查看调整单</a>`
              : balanced
                ? ''
                : `<span class="recon-hist__sub">未生成调整单</span>`
          }
        </div>
        <div class="recon-hist__when">
          <span class="tt-fine-print recon-hist__date">对账日 ${esc(r.reconcileDate)}</span>
          <span class="recon-hist__sub"
            >录入 ${esc(shortStamp(r.createdAt))}${r.operator?.nickname ? ` · ${esc(r.operator.nickname)}` : ''}</span
          >
        </div>
      </div>`;
  }

  async function load() {
    /**
     * 加载态画**三根递减的骨架**，而不是一根。
     *
     * 一根孤立的条给不出「这是一个列表」的信息，用户读到的是「什么都没有」
     * 而不是「正在加载」—— 列表页的骨架屏必须像列表。
     * 三根宽度也刻意不同：等宽会读成三行同样的东西（不像记录行）。
     * 宽度写在 CSS 里：以前是这里写 `style="width:50%"`，把样式决策搬出样式层，
     * 是改造时最容易漏掉的一处。
     */
    listSlot.innerHTML = `<div class="card card--flush">
      <div class="recon-hist__loading">
        <span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span>
      </div>
    </div>`;
    const query = {};
    if (accountFilter) query.accountId = accountFilter;
    if (range) query.dateFrom = dateFromDaysAgo(Number(range));
    try {
      const rows = (await Api.listReconciliations(ledger.id, query)).data;

      if (!rows.length) {
        /**
         * 空态要说清**是哪一种空** —— 两件事对用户的下一步完全不同：
         *   · 这个账户**从没对过** → 该去对账（第一次）
         *   · 对过但**落在筛选范围外** → 该改筛选（去历史里翻）
         * 混成一句「暂无数据」，等于把该做的事也一起吞了。
         *
         * 判据用 `summary.unreconciledList` 里的 `lastReconciledAt === null`：
         * 后端已经算了「哪些账户从没对过」，不必在前端重新推断。
         */
        const sel = accounts.find((a) => a.id === accountFilter);
        const neverReconciled =
          !!sel && (summary.unreconciledList ?? []).some((x) => x.accountId === sel.id && !x.lastReconciledAt);
        const filtered = accountFilter || range;

        listSlot.innerHTML = `
          <div class="card">
            <div class="empty-state">
              <span class="empty-state__icon" aria-hidden="true">${icon('info', 20)}</span>
              <p class="tt-body-strong">${
                neverReconciled ? '还没有对账记录' : filtered ? '该范围内没有对账记录' : '还没有对账记录'
              }</p>
              <p class="tt-caption text-muted">
                ${
                  neverReconciled
                    ? `${sel.name} 还没有对过账。到账户页点它的「对账」，填入银行 App 里的实际余额即可。`
                    : filtered
                      ? '换个账户，或把时间范围放宽到「全部」。'
                      : '到账户页点某个账户的「对账」，填入银行 App 里的实际余额即可完成第一次对账。'
                }
              </p>
              ${
                neverReconciled || !filtered
                  ? '<button class="btn btn--sm btn--secondary" type="button" data-role="empty-go">去对账</button>'
                  : '<button class="btn btn--sm btn--quiet" type="button" data-role="empty-reset">看全部记录</button>'
              }
            </div>
          </div>`;
        listSlot.querySelector('[data-role=empty-go]')?.addEventListener('click', () => go('/accounts'));
        listSlot.querySelector('[data-role=empty-reset]')?.addEventListener('click', () => {
          accountFilter = '';
          range = '';
          accSelect.value = '';
          rangeSelect.value = '';
          load();
        });
        return;
      }

      const legacyCount = rows.filter((r) => r.legacyBoundary).length;
      listSlot.innerHTML = `
        <div class="card card--flush">
          ${
            legacyCount
              ? `<div class="recon-hist__legacy">
                   <span class="badge">旧口径</span>
                   <p class="tt-fine-print text-muted">
                     本页有 ${legacyCount} 条记录的账面余额是按<strong>旧口径</strong>算的
                     （建账当天的流水不计入余额），与其它记录不可直接比较 ——
                     若差额恰为期初日当天的净流水，说明当初的期初余额被填大了。
                   </p>
                 </div>`
              : ''
          }
          <div class="list-meta"><span class="tt-fine-print">共 ${rows.length} 条记录</span></div>
          <div class="recon-hist">${rows.map(rowHtml).join('')}</div>
        </div>`;
    } catch (err) {
      listSlot.innerHTML = `<div class="card"><p class="tt-caption text-muted">加载失败：${esc(err.message)}</p></div>`;
      toast(err.message, 'error');
    }
  }

  /* ================================================================== *
   * R-05 对账排期
   * ================================================================== */

  /**
   * 排期状态里 `never`（**从没对过账**）必须单独一档并排在前面。
   *
   * 它不是「逾期 999 天」：`daysSince` 为 null 时 `null > 30` 与
   * `null ?? 0 > 30` 都是 false，它会从所有「超期」条件里两边都漏掉。
   * 而「这个账户从来没人核过」恰恰是最该被看见的事。
   */
  const DUE_LABEL = {
    never: { text: '从未对账', cls: 'badge--danger' },
    overdue: { text: '已逾期', cls: 'badge--danger' },
    due: { text: '今天该对', cls: 'badge--accent' },
    upcoming: { text: '未到期', cls: '' },
    off: { text: '未设周期', cls: '' },
  };

  /**
   * 排期表：**表头与数据行引用同一条 `--sched-cols`**。
   *
   * 以前这里用 `.recon-line`（flex + justify-content: space-between），
   * 每一行是一条**独立**的 flex —— 行的列宽由该行自己的内容决定，
   * 于是「天府银行」和「招行信用卡」两行的同一列必然落在不同的 x 上。
   * 逐行校对宽度治不了本：下一行内容一变就复发。
   *
   * 现在的列定义只在 app.css 里存在一处（`.recon-sched` 的 `--sched-cols`），
   * 表头与行都 `var()` 引用它 —— 二者物理上无法错位，改列只需改一处。
   *
   * 列的角色也交给 CSS 判断（`> :nth-child(n+3)` 右对齐）：视图里不写任何
   * 对齐样式，因此不存在「写漏一个单元格」的可能。
   */
  async function renderSchedule() {
    const rows = (await Api.reconSchedule(ledger.id)).data ?? [];
    const order = { never: 0, overdue: 1, due: 2, upcoming: 3, off: 4 };
    const sorted = [...rows].sort((a, b) => (order[a.dueState] ?? 9) - (order[b.dueState] ?? 9));
    const pending = sorted.filter((r) => r.dueState === 'never' || r.dueState === 'overdue' || r.dueState === 'due');

    schedSlot.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">对账排期</h2>
          <span class="tt-fine-print">${pending.length ? `${esc(String(pending.length))} 个账户待办` : '都在节奏上'}</span>
        </div>
        <div class="card card--flush">
          ${
            sorted.length
              ? `<div class="recon-sched">
                  <div class="recon-sched__head">
                    <span>账户</span>
                    <span>状态</span>
                    <span>上次对账</span>
                    <span>下次到期</span>
                    <span>操作</span>
                  </div>
                  ${sorted
                    .map((r) => {
                      const b = DUE_LABEL[r.dueState] ?? { text: r.dueState, cls: '' };
                      return `
                  <div class="recon-sched__row">
                    <span class="recon-sched__acct">${esc(r.accountName)}</span>
                    <span class="recon-sched__state"
                      ><span class="badge ${b.cls}">${esc(b.text)}</span></span
                    >
                    <span class="recon-sched__num recon-sched__last"
                      >${r.daysSinceLast === null ? '—' : `${esc(String(r.daysSinceLast))} 天前`}</span
                    >
                    <span class="recon-sched__num recon-sched__next">${r.nextDue ? esc(r.nextDue) : '—'}</span>
                    <span class="recon-sched__act"
                      ><button class="btn btn--quiet btn--sm" type="button" data-cycle="${esc(r.accountId)}">设置周期</button></span
                    >
                  </div>`;
                    })
                    .join('')}
                </div>`
              : '<p class="recon-sched__empty tt-caption text-muted">还没有账户</p>'
          }
        </div>
      </section>`;

    schedSlot.querySelectorAll('[data-cycle]').forEach((btn) =>
      btn.addEventListener('click', () => setCycle(btn, btn.dataset.cycle)),
    );
  }

  async function setCycle(btn, accountId) {
    const cur = (btn.dataset.state ?? '');
    btn.disabled = true;
    try {
      /**
       * 三态轮换：不提醒 → 每周 → 每月 → 不提醒。
       * 用轮换而不是弹表单，是因为「多久对一次」这个决定
       * **不值得**一个表单 —— 账户性质决定了答案（现金周、卡月）。
       */
      const next = cur === 'weekly' ? 'monthly' : cur === 'monthly' ? null : 'weekly';
      await Api.setReconSchedule(ledger.id, accountId, {
        cycle: next,
        anchorDay: next === 'monthly' ? 1 : next === 'weekly' ? 1 : null,
        remindDays: 3,
      });
      await renderSchedule();
    } catch (err) {
      btn.disabled = false;
      toast(err?.message ?? '设置失败', 'error');
    }
  }

  /* ================================================================== *
   * R-11 匹配率 / R-12 重复扣费 / R-13 缺凭证 / R-14 自动同步
   * ================================================================== */

  /**
   * 四张指标卡统一成同一副骨架：**标题 + 状态徽标 / 数值 / 状态说明 / 辅助文案**。
   *
   * 以前这四块是直接堆裸 `<p>` 的 —— 有的有标题却没有数值、有的有数值却没有
   * 说明，卡片高度跟着内容伸缩，四张摆在一起并不像「一组」。
   *
   * 结构上的统一带来两个副作用，都是想要的：
   *   · **等高**：外层 `auto-fit` 网格 + `stretch`，辅助文案 `margin-top:auto`
   *     顶到卡底 —— 于是每行的 baseline 也对齐，而不只是边框对齐；
   *   · **状态可见**：每张卡右上必有一枚徽标，用户不用读完正文才知道有没有问题。
   *
   * ⚠️ 三态只用既有徽标变体（不新增第四档）：正常 → `.badge`、
   * 待处理 → `.badge--accent`、异常 → `.badge--danger`（这是最近补齐的一档，
   * 此前「从未对账 / 已逾期 / 已超支」都写着它而 CSS 里没有 —— 渲染成了灰色）。
   * 判定全部来自后端已经算好的字段，前端不重算阈值（否则两处结论会不一致）。
   */
  const PERIOD_LABEL = { monthly: '每月', weekly: '每周', quarterly: '每季', yearly: '每年' };
  /** 账单来源：后端只存代码，中文标签在这里映射一次（别在模板里散着写） */
  const SOURCE_LABEL = {
    manual: '手动导入',
    alipay: '支付宝',
    wechat: '微信',
    bank: '银行',
    csv: 'CSV 导入',
    unknown: '未标注',
  };
  const CONF_LABEL = { high: '高度疑似', medium: '需人工确认' };
  const MISS_STATE_LABEL = { unmatched: '账本没有', suspected: '对不上' };

  /**
   * 工具区的三个状态必须显式区分。
   *
   * 「空」与「加载中」不能共用一种渲染：空是**有结论**（确实没有），
   * 加载中是**没结论**。以前四个请求全 catch 成 null，任何一个失败都会
   * 静默渲染成「没有」—— 用户看到「0 项」不会想到是接口挂了。
   */
  let toolsState = 'loading'; // loading | ready | error
  let toolsError = '';
  let toolsData = { rate: null, dup: null, missing: null, sync: null };
  /** 展开的明细面板：null | 'completeness' | 'duplicates' */
  let toolsTab = null;
  /** 完整度筛选：range 为空表示全部；source 为空表示全部来源 */
  let rateFilter = { range: '90', source: '' };
  let dupFilter = { windowDays: 3, includeReviewed: false };
  /** 请求序号：筛选连点时「最后点的赢」，过期响应不覆盖新结果 */
  let toolsSeq = 0;

  function isoDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return todayStr(d);
  }

  async function renderTools() {
    const seq = ++toolsSeq;
    toolsState = 'loading';
    toolsError = '';
    paintTools();

    try {
      const [rate, dup, missing, sync] = await Promise.all([
        Api.reconMatchRate(ledger.id, {
          accountId: accountFilter || undefined,
          from: rateFilter.range ? isoDaysAgo(Number(rateFilter.range)) : undefined,
          source: rateFilter.source || undefined,
        }).then((r) => r.data),
        Api.duplicateCharges(ledger.id, {
          windowDays: dupFilter.windowDays,
          includeReviewed: dupFilter.includeReviewed,
        }).then((r) => r.data),
        Api.missingReceipts(ledger.id, '200').then((r) => r.data),
        Api.bankSyncStatus(ledger.id).then((r) => r.data),
      ]);
      if (seq !== toolsSeq) return; // 已有更新的请求，丢弃这次结果
      toolsData = { rate, dup, missing, sync };
      toolsState = 'ready';
    } catch (err) {
      if (seq !== toolsSeq) return;
      toolsState = 'error';
      toolsError = err?.message ?? '请求失败';
    }
    paintTools();
  }

  /** 指标卡 + 明细面板一起画：明细依赖同一份数据，分开画会出现两处结论不一致 */
  function paintTools() {
    if (toolsState === 'loading') {
      toolsSlot.innerHTML = `
        <section class="section">
          <div class="section__head">
            <h2 class="tt-body-strong">记账工具</h2>
            <span class="tt-fine-print">加载中</span>
          </div>
          <div class="card">
            <div class="recon-hist__loading">
              <div class="skeleton"></div>
              <div class="skeleton"></div>
              <div class="skeleton"></div>
            </div>
          </div>
        </section>`;
      toolsDetailSlot.innerHTML = '';
      return;
    }

    if (toolsState === 'error') {
      toolsSlot.innerHTML = `
        <section class="section">
          <div class="section__head">
            <h2 class="tt-body-strong">记账工具</h2>
            <span class="badge badge--danger">加载失败</span>
          </div>
          <div class="card">
            <div class="empty-state">
              <span class="empty-state__icon" aria-hidden="true">${icon('info', 20)}</span>
              <p class="tt-body-strong">记账工具没能加载出来</p>
              <p class="tt-caption text-muted">${esc(toolsError)}。这不是「没有问题」，是没能查到。</p>
              <button class="btn btn--sm btn--secondary" type="button" data-role="t-retry">重试</button>
            </div>
          </div>
        </section>`;
      toolsDetailSlot.innerHTML = '';
      return;
    }

    const { rate, dup, missing, sync } = toolsData;
    paintMetrics(rate, dup, missing, sync);
    paintToolsDetail(rate, dup);
  }

  function paintToolsDetail(rate, dup) {
    if (toolsTab === 'completeness') {
      toolsDetailSlot.innerHTML = completenessDetail(rate);
      return;
    }
    if (toolsTab === 'duplicates') {
      toolsDetailSlot.innerHTML = duplicatesDetail(dup);
      return;
    }
    toolsDetailSlot.innerHTML = '';
  }

  /* ---------- 记账完整度明细 ---------- */

  function completenessDetail(rate) {
    const lines = rate?.missingLines ?? [];
    const sources = rate?.sources ?? [];
    const effective = Number(rate?.effectiveTotal ?? 0);
    /** 总量（含已忽略）——「从未导入」与「当前范围没有」是两种空，得分开说 */
    const total = Number(rate?.total ?? 0);
    const rangeOptions = [
      ['30', '近 30 天'],
      ['90', '近 90 天'],
      ['365', '近一年'],
      ['', '全部'],
    ];

    return `
      <section class="section">
        <div class="section__head">
          <!--
            「导入账单」放在标题后、筛选器前：完整度读的是银行流水，
            而流水只能靠导入进来 —— 没有这个入口，这一整块永远是空的。
          -->
          <div class="recon-hist__title">
            <h2 class="tt-body-strong">缺失与对不上的流水</h2>
            <button class="btn btn--sm btn--secondary" type="button" data-role="t-import">
              ${icon('download', 16)}<span>导入账单</span>
            </button>
          </div>
          <div class="row row--md row--wrap recon-hist__filters">
            <select class="input recon-hist__select" data-role="t-range" aria-label="时间范围">
              ${rangeOptions
                .map(
                  ([v, label]) =>
                    `<option value="${esc(v)}"${rateFilter.range === v ? ' selected' : ''}>${esc(label)}</option>`,
                )
                .join('')}
            </select>
            <select class="input recon-hist__select" data-role="t-source" aria-label="账单来源">
              <option value=""${rateFilter.source === '' ? ' selected' : ''}>全部来源</option>
              ${sources
                .map(
                  (s) =>
                    `<option value="${esc(s.value)}"${rateFilter.source === s.value ? ' selected' : ''}>${esc(
                      SOURCE_LABEL[s.value] ?? s.value,
                    )}（${esc(String(s.count))}）</option>`,
                )
                .join('')}
            </select>
          </div>
        </div>
        <div class="card">
          <p class="metric__state">
            口径：已入账 <span class="tnum">${esc(String(rate?.recordedCount ?? 0))}</span> 笔 /
            有效 <span class="tnum">${esc(String(effective))}</span> 笔
            ${Number(rate?.ignoredCount ?? 0) > 0
              ? `（已忽略 <span class="tnum">${esc(String(rate.ignoredCount))}</span> 笔，不计入分母）`
              : ''}
          </p>
          ${
            lines.length
              ? `<div class="recon-miss">
                   <div class="recon-miss__row recon-miss__row--head">
                     <span>日期</span><span>商户 / 摘要</span><span class="recon-miss__num">金额</span><span>状态</span>
                   </div>
                   ${lines
                     .map(
                       (l) => `<div class="recon-miss__row">
                         <span class="recon-miss__date tnum">${esc(l.txDate ?? '—')}</span>
                         <span class="recon-miss__who">${esc(l.merchant || l.description || '—')}</span>
                         <span class="recon-miss__num tnum">${esc(money(l.amount))}</span>
                         <span class="recon-miss__state">
                           <span class="badge ${l.matchState === 'suspected' ? 'badge--accent' : 'badge--danger'}">${esc(
                             MISS_STATE_LABEL[l.matchState] ?? l.matchState,
                           )}</span>
                         </span>
                       </div>`,
                     )
                     .join('')}
                 </div>
                 <p class="metric__hint">${
                   lines.length >= 100
                     ? '只显示最近 100 笔，处理完再来核对'
                     : '「账本没有」= 银行有这笔、账本里没有；「对不上」= 有候选但金额或日期不一致'
                 }</p>`
              : `<div class="empty-state">
                   <span class="empty-state__icon" aria-hidden="true">${icon('check', 20)}</span>
                   <p class="tt-body-strong">${
                     total === 0
                       ? '还没有导入过银行账单'
                       : effective === 0
                         ? '这个范围内的流水都标记为忽略了'
                         : '流水都已入账，没有缺失'
                   }</p>
                   <p class="tt-caption text-muted">${
                     total === 0
                       ? '导入的是银行流水，只用来核对账本有没有漏记，不会生成账目。'
                       : effective === 0
                         ? '被忽略的流水不计入匹配率，换个时间范围或账户可以再查一次。'
                         : '银行流水里的每一笔都能在账本里找到对应记录。'
                   }</p>
                   ${
                     total === 0
                       ? `<button class="btn btn--sm" type="button" data-role="t-import">
                            ${icon('download', 16)}<span>导入账单</span>
                          </button>`
                       : ''
                   }
                 </div>`
          }
        </div>
      </section>`;
  }

  /* ---------- 重复扣费明细 ---------- */

  function duplicatesDetail(dup) {
    const groups = dup?.duplicateGroups ?? [];
    const windowOptions = [
      ['3', '3 天内'],
      ['7', '7 天内'],
      ['30', '30 天内'],
    ];

    return `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">疑似重复交易</h2>
          <div class="row row--md row--wrap recon-hist__filters">
            <select class="input recon-hist__select" data-role="d-window" aria-label="时间窗口">
              ${windowOptions
                .map(
                  ([v, label]) =>
                    `<option value="${esc(v)}"${String(dupFilter.windowDays) === v ? ' selected' : ''}>${esc(label)}</option>`,
                )
                .join('')}
            </select>
            <label class="row row--sm dup-toggle">
              <input type="checkbox" data-role="d-reviewed"${dupFilter.includeReviewed ? ' checked' : ''} />
              <span class="tt-caption">显示已忽略</span>
            </label>
          </div>
        </div>
        <div class="card">
          ${
            groups.length
              ? `<div class="dup-list">
                   ${groups
                     .map(
                       (g) => `<article class="dup-group" data-group="${esc(g.groupKey)}">
                         <div class="dup-group__head">
                           <span class="dup-group__title">${esc(g.merchant || '未填商户')} · ${esc(money(g.amount))} · ${
                             esc(String(g.count))
                           } 笔</span>
                           <span class="badge ${g.status === 'confirmed' ? 'badge--danger' : g.status === 'ignored' ? '' : 'badge--accent'}">${esc(
                             g.status === 'confirmed' ? '已确认重复' : g.status === 'ignored' ? '已忽略' : CONF_LABEL[g.confidence] ?? g.confidence,
                           )}</span>
                         </div>
                         <p class="dup-group__reasons">判定依据：${(g.reasons ?? []).map((x) => esc(x)).join(' · ')}</p>
                         <div class="dup-group__items">
                           ${(g.items ?? [])
                             .map(
                               (it) => `<div class="dup-item">
                                 <span class="dup-item__meta tnum">${esc(it.txDate ?? '—')} · ${esc(it.accountName ?? '—')}</span>
                                 <button class="btn btn--sm btn--quiet" type="button" data-act="open" data-id="${esc(it.id)}">查看详情</button>
                               </div>`,
                             )
                             .join('')}
                         </div>
                         <div class="dup-group__ops">
                           <button class="btn btn--sm" type="button" data-act="confirm"${g.status === 'confirmed' ? ' disabled' : ''}>确认重复</button>
                           <button class="btn btn--sm btn--secondary" type="button" data-act="ignore"${g.status === 'ignored' ? ' disabled' : ''}>忽略</button>
                         </div>
                       </article>`,
                     )
                     .join('')}
                 </div>
                 <p class="metric__hint">确认或忽略只记录你的判断，不会改动任何账目 —— 删哪一笔由你决定。</p>`
              : `<div class="empty-state">
                   <span class="empty-state__icon" aria-hidden="true">${icon('check', 20)}</span>
                   <p class="tt-body-strong">没有发现疑似重复</p>
                   <p class="tt-caption text-muted">
                     判据是「金额相同 + 商户相同 + ${esc(String(dup?.windowDays ?? 3))} 天内」，三者同时成立才会列出。
                     把时间窗口放宽可以查更久以前的。
                   </p>
                 </div>`
          }
        </div>
      </section>`;
  }

  function paintMetrics(rate, dup, missing, sync) {
    /**
     * 三档状态全部来自后端已算好的字段，前端不重算阈值 ——
     * 否则同一个指标在两个页面会给出两个结论。
     */
    const effective = Number(rate?.effectiveTotal ?? 0);
    const total = Number(rate?.total ?? 0);
    const rateValue = rate?.matchRate ?? null;
    const rateState =
      effective === 0
        ? { text: total > 0 ? '全部忽略' : '待开始', cls: 'badge--accent' }
        : rate?.riskHint
          ? { text: '异常', cls: 'badge--danger' }
          : { text: '正常', cls: '' };

    const dupTotal = Number(dup?.total ?? 0);
    const dupItems = dup?.items ?? [];
    const dupStale = Number(dup?.possiblyStale?.length ?? 0);
    const dupPending = Number(dup?.pendingCount ?? 0);
    const dupConfirmed = Number(dup?.confirmedCount ?? 0);
    /**
     * 徽标优先反映「有没有待判的重复」—— 那是需要人动手的事。
     * 以前这里只看订阅数（`dupTotal`），结果是：明明有疑似重复待确认，
     * 徽标却写「正常」，用户根本不会点开。
     */
    const dupState =
      dupPending > 0
        ? { text: `${dupPending} 组待判`, cls: 'badge--accent' }
        : dupConfirmed > 0
          ? { text: `${dupConfirmed} 组已确认`, cls: 'badge--danger' }
          : dupStale > 0
            ? { text: `${dupStale} 项待核`, cls: 'badge--accent' }
            : { text: '正常', cls: '' };

    const missCount = Number(missing?.count ?? 0);
    const missState = missCount > 0 ? { text: '待补', cls: 'badge--accent' } : { text: '正常', cls: '' };

    /** 银行同步是**恒定的能力边界**而不是待办事项 —— 用中性徽标，不用告警色 */
    const syncSupported = sync?.supported === true;
    const syncState = { text: syncSupported ? '已接入' : '暂不支持', cls: '' };

    toolsSlot.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">记账工具</h2>
          <span class="tt-fine-print">完整度 / 重复 / 凭证 / 同步</span>
        </div>
        <div class="metric-grid">
          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">记账完整度</h3>
              <span class="badge ${rateState.cls}">${esc(rateState.text)}</span>
            </div>
            ${
              /**
               * ⚠️ 没有有效样本时给「—」而不是「100%」。
               * 后端现在把这种情形的 `matchRate` 返回成 `null`（以前兜底成 100），
               * 直接渲染会让人以为「完整度满分」—— 而真实情况是「还没开始对」。
               * 分母只算有效流水（已忽略的不进分母），所以还要说清这个口径。
               */
              effective > 0 && rateValue !== null
                ? `<p class="metric__value tnum">${esc(String(rateValue))}%</p>
                   <p class="metric__state">已入账 <span class="tnum">${esc(String(rate?.recordedCount ?? 0))}</span> / <span class="tnum">${esc(String(effective))}</span> 笔</p>`
                : `<p class="metric__value">—</p>
                   <p class="metric__state">${total > 0 ? '流水都已标记为忽略' : '还没有导入过流水'}</p>`
            }
            ${
              rate?.riskHint
                ? `<p class="metric__hint is-neg">${esc(rate.riskHint)}</p>`
                : `<p class="metric__hint">阈值 ${esc(String(rate?.threshold ?? 90))}%，样本满 20 笔才提示风险</p>`
            }
            <button class="btn btn--sm btn--secondary metric__more" type="button" data-role="tab-completeness">
              ${effective > 0 ? `查看 ${esc(String(rate?.missingCount ?? 0))} 笔缺失` : '查看口径说明'}
            </button>
          </article>

          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">重复扣费</h3>
              <span class="badge ${dupState.cls}">${esc(dupState.text)}</span>
            </div>
            ${
              /**
               * 数值取「待判 + 已确认」的组数，而不是订阅数 ——
               * 用户看到这张卡想问的是「有没有被重复扣」，不是「我确认过几个订阅」。
               * 下面那行同时保留订阅线索，两条线索各说各的，不混成一个数。
               */
              dupPending + dupConfirmed > 0
                ? `<p class="metric__value tnum">${esc(String(dupPending + dupConfirmed))} 组</p>
                   <p class="metric__state">疑似同一笔记了两次</p>`
                : `<p class="metric__value tnum">0 组</p>
                   <p class="metric__state">没有发现疑似重复</p>`
            }
            ${
              dupItems.length
                ? `<div class="metric__list">
                     ${dupItems
                       .slice(0, 2)
                       .map(
                         (d) => `<div class="metric__item">
                           <span class="metric__item-label">订阅：${esc(d.userLabel || d.merchant)} · ${esc(
                             PERIOD_LABEL[d.periodType] ?? d.periodType,
                           )}</span>
                           <span class="metric__item-value tnum">${esc(money(d.amount))}</span>
                         </div>`,
                       )
                       .join('')}
                   </div>
                   <p class="metric__hint">另有 ${esc(String(dupTotal))} 项已确认订阅${dupItems.length > 2 ? '，显示金额最高的 2 项' : ''}</p>`
                : `<p class="metric__hint">订阅线索：在统计页确认订阅后会出现在这里</p>`
            }
            ${
              dupStale
                ? `<p class="metric__hint">${esc(String(dupStale))} 项已超过 45 天没再出现，可能已经停了</p>`
                : ''
            }
            <button class="btn btn--sm btn--secondary metric__more" type="button" data-role="tab-duplicates">
              ${dupPending + dupConfirmed > 0 ? '逐组核对' : '查看判定依据'}
            </button>
          </article>

          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">缺凭证</h3>
              <span class="badge ${missState.cls}">${esc(missState.text)}</span>
            </div>
            <p class="metric__value tnum">${esc(String(missCount))} 笔</p>
            <p class="metric__state">${esc(missing?.threshold ?? '¥200.00')} 以上的大额支出</p>
            <p class="metric__hint">${missCount ? '建议逐笔补一张回单或截图' : '大额支出都已经有凭证了'}</p>
          </article>

          <article class="metric">
            <div class="metric__head">
              <h3 class="metric__title">银行自动同步</h3>
              <span class="badge ${syncState.cls}">${esc(syncState.text)}</span>
            </div>
            <p class="metric__value">${syncSupported ? '已接入' : '—'}</p>
            <p class="metric__state">${esc(sync?.reason ?? '—')}</p>
            ${
              sync?.alternative
                ? `<p class="metric__hint">替代路径：${esc(sync.alternative)}</p>`
                : '<p class="metric__hint">用流水导入配合自动匹配完成对账</p>'
            }
          </article>
        </div>
      </section>`;
  }

  /* ---------------- 接线 ---------------- */

  frame.querySelector('[data-role=to-accounts]').addEventListener('click', () => go('/accounts'));

  /**
   * 「记账工具」区整体用事件委托。
   *
   * 明细面板每次筛选都会整块重绘，给按钮逐个挂监听等于每次重绘都要重新挂一遍 ——
   * 漏挂一处就是「点了没反应」，而这种问题在静态检查里完全看不出来。
   */
  toolsSlot.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-role]');
    if (!btn) return;
    const role = btn.getAttribute('data-role');
    if (role === 't-retry') {
      renderTools();
      return;
    }
    if (role === 'tab-completeness' || role === 'tab-duplicates') {
      const next = role === 'tab-completeness' ? 'completeness' : 'duplicates';
      toolsTab = toolsTab === next ? null : next;
      paintToolsDetail(toolsData.rate, toolsData.dup);
      paintMetrics(toolsData.rate, toolsData.dup, toolsData.missing, toolsData.sync);
    }
  });

  toolsDetailSlot.addEventListener('change', (e) => {
    const el = e.target;
    const role = el.getAttribute?.('data-role');
    if (role === 't-range') {
      rateFilter.range = el.value;
      renderTools();
    } else if (role === 't-source') {
      rateFilter.source = el.value;
      renderTools();
    } else if (role === 'd-window') {
      dupFilter.windowDays = Number(el.value);
      renderTools();
    } else if (role === 'd-reviewed') {
      dupFilter.includeReviewed = el.checked;
      renderTools();
    }
  });

  toolsDetailSlot.addEventListener('click', async (e) => {
    const importBtn = e.target.closest('button[data-role=t-import]');
    if (importBtn) {
      openStatementImport({
        ledger,
        accounts,
        accountId: accountFilter,
        /** 导入完立刻重算 —— 不然用户会看到「导入成功」而数字还是旧的 */
        onDone: () => renderTools().catch(() => {}),
      });
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const groupKey = btn.closest('[data-group]')?.getAttribute('data-group') ?? '';

    if (act === 'open') {
      const id = btn.getAttribute('data-id');
      if (id) go(`/transactions/${encodeURIComponent(id)}`);
      return;
    }
    if (act === 'confirm' || act === 'ignore') {
      const status = act === 'confirm' ? 'confirmed' : 'ignored';
      btn.disabled = true;
      try {
        await Api.reviewDuplicate(ledger.id, { groupKey, status });
        toast(status === 'confirmed' ? '已标记为重复' : '已忽略');
        renderTools();
      } catch (err) {
        btn.disabled = false;
        toast(err?.message ?? '操作失败', 'error');
      }
    }
  });

  accSelect.addEventListener('change', () => {
    accountFilter = accSelect.value;
    /** 账户同时影响完整度的统计范围，工具区要跟着重算 */
    renderTools();
    load();
  });
  rangeSelect.addEventListener('change', () => {
    range = rangeSelect.value;
    load();
  });

  paintHealth();
  renderSchedule().catch(() => {});
  renderTools().catch(() => {});
  await load();
  return frame;
}
