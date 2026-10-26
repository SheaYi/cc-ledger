/**
 * 记账页 `/transactions/new`（docs/13 §4–§8）
 *
 * 这一页要做的事只有一件：**把 `03 §1` 的账务规约翻译成用户看得懂的一次录入**。
 * 因此它的三个技术要点都与「让规约可见」有关：
 *  ① 金额的**本地双算**（`lib/amounts.js` 是 `amounts.ts` 的同构实现）——
 *     打字即出预览；失焦 / 停顿 400ms / 提交前各用 `POST /transactions/preview` 校正一次，
 *     两者数字不一致就以后端为准并上报（docs/13 §6.2）。
 *  ② **六类型 × 阶段**的字段显隐由 `direction` 驱动，而不是靠 `to_account_id` 猜
 *     （docs/12 §7.1 定案：`to_account_id` 语义收敛为「本笔要动的第二个账户」）。
 *  ③ 校验文案每条都给出**怎么改**，且不用 Toast 报字段错误（Toast 会消失，用户来不及看）。
 *
 * 有意为之、勿当 bug 修（docs/13 §4.4 / §7.3）：
 *  · 「余额调整」不在本页 —— 它只由对账流程生成（余额修正的唯一合法途径）。
 *  · 切换类型时分类「暂存并恢复」，转入账户「清空且不恢复」，收付方向「重置为产生」。
 *  · 「再记一笔」保留账户/类型/日期/方向，清空金额/分类/名称/商家/对象/备注。
 */
import { Api } from '../api.js';
import { appFrame } from '../chrome.js';
import { composeSource, currentLedger, loadSession } from '../session.js';
import {
  actionToast,
  applyFieldErrors,
  esc,
  h,
  icon,
  lucide,
  money,
  setLoading,
  toast,
  todayStr,
} from '../ui.js';
import {
  DEFAULT_DIRECTION,
  DIRECTION_BY_RECORD_TYPE,
  DISCOUNT_APPLICABLE,
  FEE_APPLICABLE,
  LIMITS,
  RECORD_TYPE_LABEL,
  amountsMismatch,
  formatCents,
  groupMoneyInText,
  normalizeAmountInput,
  parseAmountToCents,
  sanitizeAmountInput,
  tryCalculateFromStrings,
} from '../lib/amounts.js';
/** 记录类型的语义图标与列表页/详情页共用一份，保证同一类型在三处图形一致 */
import { TYPE_ICON, dayLabel } from '../lib/tx-format.js';
/** 本地草稿：填一半离开后回访能接着填（docs/13 §10.1） */
import { clearDraft, describeDraft, draftHasContent, readDraft, writeDraft } from '../lib/tx-draft.js';
import { writeTemplateSeed } from '../lib/template-panel.js';
import { attachAmountPad } from '../lib/amount-pad.js';

/** 「再记一笔」传递保留字段的一次性种子（不污染 URL，docs/13 §7.2 的同类做法） */
const SEED_KEY = 'cc-ledger.compose-seed.v1';

/* ------------------------------------------------------------------ *
 * 类型与阶段（docs/13 §4.4）
 * ------------------------------------------------------------------ */

/**
 * 类型 Mega Menu 的内容（`docs/13 §4.4` 改版）。
 *
 * 旧的「一级分段 [支出][收入][转账] + 更多 ▾」把 6 个类型切成两组，
 * 用户得先点「更多」才知道还有应收应付；而且分段控件只能放得下两三个字，
 * 「应收款项」被压缩成「应收」，语义丢了。Mega Menu 一次摊开全部六种，
 * 用分组标题说明两类语义差别，每一项都带上「这笔到底动谁的钱」的大白话 ——
 * 记账新手卡住的地方几乎都是这一句。
 */
const TYPE_GROUPS = [
  { label: '常用', types: ['expense', 'income', 'transfer'] },
  { label: '债权债务', types: ['receivable', 'payable'] },
];
const TYPE_META = {
  expense: { label: '支出', hint: '钱从账户花出去' },
  income: { label: '收入', hint: '钱进到账户里' },
  transfer: { label: '转账', hint: '账户之间挪钱' },
  receivable: { label: '应收款项', hint: '借出，或收回对方还的钱' },
  payable: { label: '应付款项', hint: '欠了钱，或把欠的还掉' },
};
/** 有分类的类型（= 除转账外全部；docs/03 §8.1 的 ✓ 项） */
const TYPE_WITH_CATEGORY = new Set(['expense', 'income', 'receivable', 'payable']);
/** 需要用户选第二个账户的类型 */
const TYPE_WITH_TO_ACCOUNT = new Set(['transfer']);

/** 记账页就地新建标签用的 8 色盘（与后端 `src/config/constants.ts` 的 TAG_COLORS 一致） */
const TAG_COLORS = [
  '#FF3B30',
  '#FF9500',
  '#FFCC00',
  '#34C759',
  '#007AFF',
  '#AF52DE',
  '#8E8E93',
  '#636366',
];

/**
 * 面板顶部「建议」的条数 = **最近 9 笔支出的二级分类**（用户指定）。
 * 取 9 是因为三列面板里建议条占一行，9 个 chip 恰好铺满且不满溢；
 * 再多就要换行，把三列挤下去 —— 建议是入口不是主体。
 */
const SUGGEST_MAX = 9;

/** 收付方向选项（只有应收 / 应付有阶段之分） */
const DIRECTION_CHOICES = {
  receivable: [
    { value: 'decrease', label: '借出', sub: '产生' },
    { value: 'increase', label: '收回', sub: '结算' },
    { value: 'write_off', label: '坏账核销', sub: '终态' },
  ],
  payable: [
    { value: 'none', label: '登记欠款', sub: '产生' },
    { value: 'decrease', label: '还款', sub: '结算' },
    { value: 'write_off', label: '债务免除', sub: '终态' },
  ],
};

/** 操作栏里那一行「这次到底动了多少钱」的标签 */
const SUMMARY_LABEL = {
  'expense:decrease': '实际支出',
  'income:increase': '实际收入',
  'transfer:decrease': '转出合计',
  'receivable:decrease': '借出金额',
  'receivable:increase': '收回金额',
  'payable:none': '登记债务',
  'payable:decrease': '还款金额',
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function option(value, label, selected, { disabled = false } = {}) {
  return `<option value="${esc(value)}"${selected === value ? ' selected' : ''}${
    disabled ? ' disabled' : ''
  }>${esc(label)}</option>`;
}

function yesterday(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayStr(d);
}

function nowHm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 客户端幂等键（docs/18.1：重复提交命中即返回原记录，不重复记账） */
function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 双算不一致的上报（docs/13 §6.2）。没有埋点后端时先落在控制台 + 会话计数。 */
function reportAmountMismatch(payload) {
  const w = /** @type {any} */ (window);
  w.__ccLedgerAmountMismatch = (w.__ccLedgerAmountMismatch ?? 0) + 1;
  console.warn('[双算不一致] 本地与后端口径出现分歧，已以后端为准', payload);
}

/* ================================================================== *
 * 页面
 * ================================================================== */

/**
 * 记账页入口。三种进入方式共用同一套表单与状态机（docs/13 §4.1「两端一套」的延伸）：
 *  · `/transactions/new`                建一笔（可带 `?copyFrom={id}` 复制预填）
 *  · `/transactions/:id/edit`           改一笔（`editId`，走 PATCH + 乐观锁）
 *
 * 三者**字段与顺序完全一致**，差异只有：标题、提交按钮文案、保存后的落点、
 * 以及「复制」的那条预填规则（清空金额、日期改今天 —— 见 §11）。
 * 两条会分叉状态的入口（再记一笔 / 撤销）在编辑态一律不出现。
 */
export async function renderTransactionForm(container, { go, query, editId = null } = {}) {
  const loading = appFrame({
    active: 'compose',
    hideCompose: true,
    inner: `<div class="card"><div class="skeleton" style="width:32%"></div>
            <div class="skeleton" style="width:58%;height:48px;margin-top:20px"></div></div>`,
  });
  loading.querySelector('main')?.classList.add('page--compose');
  container.replaceChildren(loading);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return loading;
  }

  const copyFrom = editId ? null : (query?.('copyFrom') ?? null);
  /**
   * `?template={id}`：扫码 / 外部链接直接进某个模板（`docs/13 §3.5` 的二维码入口）。
   * 拉到后写成一次性种子，交给 createState 消费 —— 与模板面板点选走**同一条路径**，
   * 不在这里单独拼一份预填逻辑（两份预填逻辑必然会漂移）。
   */
  const templateId = editId ? null : (query?.('template') ?? null);
  if (templateId) {
    try {
      const tpl = (await Api.getTemplate(ledger.id, templateId)).data;
      writeTemplateSeed(tpl);
    } catch {
      // 模板被删了不该把人堵在门外：按普通空表单继续，只是没预填
      toast('这个模板已不存在，已按空白表单开始');
    }
  }
  /**
   * 「建议」的口径是**最近 9 笔支出的二级分类**，所以建账时要多拉一次列表。
   * 塞进同一个 `Promise.all` 并发，不额外增加一次往返等待；编辑态用不上就不发。
   */
  const [defaults, accounts, groups, catTrees, tags, recentExpense] = await Promise.all([
    Api.txNewDefaults(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id, { includeArchived: true }).then((r) => r.data),
    Api.listCategories(ledger.id).then((r) => r.data),
    Api.listTags(ledger.id).then((r) => r.data),
    editId
      ? Promise.resolve([])
      : Api.listTransactions(ledger.id, { recordType: 'expense', pageSize: SUGGEST_MAX })
          .then((r) => r.data)
          // 建议是锦上添花：拉不到就当没有，绝不能让一次失败拖垮整个记账页
          .catch(() => []),
  ]);

  /* ---------------- 编辑 / 复制：先把源账单取回来 ---------------- */
  let sourceTx = null;
  if (editId || copyFrom) {
    try {
      sourceTx = (await Api.getTransaction(ledger.id, editId ?? copyFrom)).data;
    } catch (err) {
      container.replaceChildren(
        appFrame({
          active: 'compose',
          user: me,
          ledger,
          hideCompose: true,
          inner: `
            <div class="card empty-state">
              <span class="empty-state__icon">${icon('info', 22)}</span>
              <p class="tt-body-strong">找不到这笔账单</p>
              <p class="tt-caption text-muted">${esc(err?.message ?? '它可能已被永久删除。')}</p>
              <a class="btn btn--sm" href="/transactions" data-link>回到账单列表</a>
            </div>`,
        }),
      );
      return null;
    }
  }

  const mode = editId ? 'edit' : 'create';
  const copying = mode === 'create' && !!sourceTx;

  /* ---------------- 余额调整不在本页可编辑（docs/05 §9.5） ---------------- */
  if (mode === 'edit' && sourceTx.recordType === 'adjustment') {
    container.replaceChildren(
      appFrame({
        active: 'compose',
        user: me,
        ledger,
        hideCompose: true,
        inner: `
          <div class="card empty-state">
            <span class="empty-state__icon">${icon('scale', 22)}</span>
            <p class="tt-body-strong">余额调整不能在这里修改</p>
            <p class="tt-caption text-muted">
              余额调整是「对账」的产物，改它会绕开「账可被证明」这条底线。
              要修正余额，请到账户页做一次对账 —— 系统会生成一条可追溯的调整记录。
            </p>
            <div class="row">
              <a class="btn btn--sm" href="/transactions/${encodeURIComponent(editId)}" data-link>查看这笔账单</a>
              <a class="btn btn--quiet btn--sm" href="/accounts" data-link>去对账</a>
            </div>
          </div>`,
      }),
    );
    return null;
  }

  /* ---------------- 骨架 ---------------- */

  const frame = appFrame({
    active: 'compose',
    user: me,
    ledger,
    hideCompose: true,
    inner: `
      <div class="compose">
        <div class="compose__head">
          <h1>${mode === 'edit' ? '编辑账单' : '记一笔'}</h1>
          <button class="btn btn--quiet btn--sm" type="button" data-role="back">返回</button>
        </div>
        <div data-role="body"></div>
      </div>
    `,
  });
  mountCompose(frame, {
    go,
    ledger,
    defaults,
    accounts,
    groups,
    catTrees,
    tags,
    recentExpense,
    mode,
    sourceTx,
    copying,
  });
  // 记账页是全屏页：不挂 TabBar，也就不该给底部导航留位（docs/13 §4.1）
  frame.querySelector('main')?.classList.add('page--compose');
  container.replaceChildren(frame);

  /* ---------------- 无账户：不进入表单（docs/13 §13 场景 12） ---------------- */
  const realAccounts = accounts.filter((a) => a.kind !== 'virtual' && !a.archivedAt);
  if (mode === 'create' && (!defaults.hasAccounts || realAccounts.length === 0)) {
    frame.querySelector('[data-role=body]').replaceChildren(
      h(`
        <div class="card compose-empty">
          <span class="empty-state__icon">${icon('wallet', 22)}</span>
          <p class="tt-body-strong">先建一个账户才能记账</p>
          <p class="tt-caption text-muted">
            账单总是记在某个账户上。建一张银行卡或现金账户，再回来记第一笔。
          </p>
          <a class="btn btn--sm" href="/accounts" data-link>去添加账户</a>
        </div>
      `),
    );
  }

  frame
    .querySelector('[data-role=back]')
    ?.addEventListener('click', () => (mode === 'edit' ? go('/transactions') : go(sourcePage())));
  return frame;
}

/* ================================================================== *
 * 表单
 * ================================================================== */

/**
 * 表单状态。**唯一事实来源**：任何字段的读写都走这里，
 * 视图只负责把它画出来 —— 这样「切换类型时的字段保留策略」才有一处可审。
 *
 * 初始态按优先级：`源账单`（编辑 / 复制）> `new-defaults`（服务端给的最近使用账户）> 空。
 * 其中「再记一笔」的一次性种子只作用于**建账**路径（`docs/13 §7.3`），
 * 编辑态绝不能被上一笔的种子污染 —— 那会把 B 笔的账户写进 A 笔的修改里。
 *
 * @param {object} defaults `GET /transactions/new-defaults`
 * @param {{tx?: object|null, copying?: boolean, mode?: string}} [source]
 */
function createState(defaults, source = {}) {
  const state = {
    recordType: defaults.recordType ?? 'expense',
    direction: defaults.direction ?? DEFAULT_DIRECTION[defaults.recordType ?? 'expense'],
    accountId: defaults.accountId ?? null,
    toAccountId: null,
    categoryId: null,
    amount: '',
    fee: '',
    discount: '',
    name: '',
    merchant: '',
    counterparty: '',
    note: '',
    txDate: defaults.txDate ?? todayStr(),
    txTime: nowHm(), // docs/13 §5：默认当前时刻，可一键清空
    tags: new Set(),
    /** 结清关联（docs/12 §六 D9）：这笔结算/核销冲抵了哪些产生笔、各多少 */
    settles: [],
  };

  const tx = source.tx ?? null;
  if (tx) {
    const rt = DEFAULT_DIRECTION[tx.recordType] ? tx.recordType : state.recordType;
    state.recordType = rt;
    state.direction = (DIRECTION_BY_RECORD_TYPE[rt] ?? []).includes(tx.direction)
      ? tx.direction
      : DEFAULT_DIRECTION[rt];
    state.accountId = tx.account?.id ?? state.accountId;
    state.toAccountId = tx.toAccount?.id ?? null;
    state.categoryId = tx.category?.id ?? null;
    state.name = tx.name ?? '';
    state.merchant = tx.merchant ?? '';
    state.counterparty = tx.counterparty ?? '';
    state.note = tx.note ?? '';
    state.tags = new Set((tx.tags ?? []).map((t) => t.id));
    state.settles = (tx.settlements ?? []).map((s) => ({
      transactionId: s.transactionId,
      amount: s.amount,
    }));
    state.txDate = tx.txDate ?? state.txDate;
    state.txTime = tx.txTime ? String(tx.txTime).slice(0, 5) : '';

    // 「复制」的字段策略（docs/13 §11）：金额是变化量最大的字段，带出来极易误提交
    if (source.copying) {
      state.txDate = todayStr();
      state.txTime = nowHm();
    } else {
      state.amount = tx.amount ?? '';
      state.fee = Number(tx.fee) ? tx.fee : '';
      state.discount = Number(tx.discount) ? tx.discount : '';
    }
    return state;
  }

  let seed = null;
  try {
    const raw = sessionStorage.getItem(SEED_KEY);
    if (raw) seed = JSON.parse(raw);
    sessionStorage.removeItem(SEED_KEY); // 种子是一次性的，读掉即焚
  } catch {
    seed = null;
  }
  if (seed) {
    // 保留：类型、账户、日期、收付方向、标签（docs/13 §7.3）
    const rt = DEFAULT_DIRECTION[seed.recordType] ? seed.recordType : state.recordType;
    state.recordType = rt;
    state.direction = (DIRECTION_BY_RECORD_TYPE[rt] ?? []).includes(seed.direction)
      ? seed.direction
      : DEFAULT_DIRECTION[rt];
    state.accountId = seed.accountId ?? state.accountId;
    state.txDate = seed.txDate ?? state.txDate;
    state.tags = new Set(Array.isArray(seed.tags) ? seed.tags : []);
    // 清空：金额、手续费、折扣、分类、名称、商家、对象、备注（默认值已是空）

    /**
     * 「往来」页发起的结清 / 核销种子是**另一种意图**，不能按「再记一笔」的规则清空。
     *
     * 再记一笔要清金额，是因为「再买一次同样的东西但价格不同」才是主场景；
     * 而「结清」的主场景恰恰是**把这笔还差多少填进去**（用户十有八九就是一次还清，
     * 真要部分结清再手动改小）。所以这里带上金额/对象/名称与结清关联。
     */
    if (seed.purpose === 'settle') {
      state.amount = seed.amount ?? state.amount;
      state.counterparty = seed.counterparty ?? state.counterparty;
      state.name = seed.name ?? state.name;
      /**
       * 分类与账户跟着原笔走（往来页的任务 2 需求）。
       *
       * ⚠️ 必须**显式读这两个字段**，不能用上面通用分支的
       * `state.accountId = seed.accountId ?? state.accountId` ——
       * 那个写法在 settle 分支之前执行，所以这里再写一次是为**覆盖**默认值
       * （默认账户是「上次用的那张卡」，对结清来说通常是错的：
       *  用户在「往来」页点结清，期望钱回到**原来借出去的那张卡**）。
       *
       * 分类同理：结清的分类必须与原笔一致，否则台账口径会分叉
       * （「借出借款」被结到「货款」上，分类维度的统计就错了）。
       *
       * 两者都**允许用户改** —— 钱确实可能还到另一张卡（信用卡还款）。
       */
      if (seed.accountId) state.accountId = seed.accountId;
      if (seed.categoryId) state.categoryId = seed.categoryId;
      if (seed.txDate) state.txDate = seed.txDate;
      state.settles = Array.isArray(seed.settles)
        ? seed.settles.map((s) => ({ transactionId: s.transactionId, amount: s.amount }))
        : [];
    }

    /**
     * 模板种子（`docs/05 §10.2`）：固化「这笔账长什么样」，**不固化「多少钱、什么时候」**。
     *
     * 所以这里带分类/账户/名称/商家/对象/备注/手续费/折扣/标签，**并清掉日期时间**
     * （模板不该把「上次记在周一」带到今天）。
     *
     * 金额是个规格内部矛盾点：`§10.2` 表格写「✗ 预填建议值」、`§10.5` 流程图写
     * 「用户只需输入金额」。两种读法都成立的做法是**预填并聚焦全选** ——
     * 用户不打算改就直接提交，打算改的一打字就替换掉，不用先清空。
     */
    if (seed.purpose === 'template') {
      state.amount = seed.defaultAmount ?? '';
      // 时间与账户不能只靠上面的通用分支：通用分支按 `seed.accountId ?? state.accountId`
      // 取值，但模板要**以模板为准** —— 默认账户（new-defaults 给的是上次用的那张卡）
      // 优先级低于模板，否则「早餐模板」会被记到上次用的信用卡上。
      state.accountId = seed.accountId ?? state.accountId;
      state.txTime = '';
      state.categoryId = seed.categoryId ?? null;
      state.toAccountId = seed.toAccountId ?? null;
      state.name = seed.name ?? '';
      state.merchant = seed.merchant ?? '';
      state.counterparty = seed.counterparty ?? '';
      state.note = seed.note ?? '';
      state.fee = seed.fee ?? '';
      state.discount = seed.discount ?? '';
      if (Array.isArray(seed.tagIds)) state.tags = new Set(seed.tagIds);
      /**
       * `catStash` 在 mountCompose 内部（模块级函数 createState 够不着），
       * 所以分类与提示信息先挂在 state 上，由 mountCompose 取走。
       */
      state.templateHint = {
        categoryId: seed.categoryId ?? null,
        warnings: Array.isArray(seed.warnings) ? seed.warnings : [],
        name: seed.templateName ?? '',
      };
    }
  }
  return state;
}

function mountCompose(
  frame,
  {
    go,
    ledger,
    defaults,
    accounts,
    groups,
    catTrees,
    tags,
    /** 最近 9 笔支出（建账时拉取，供面板顶部的「建议」用；编辑态为空数组） */
    recentExpense = [],
    mode = 'create',
    sourceTx = null,
    copying = false,
  },
) {
  const state = createState(defaults, { tx: sourceTx, copying, mode });
  /** 分类的「暂存并恢复」：recordType → 上次选中的 categoryId */
  const catStash = new Map();
  /**
   * 模板预填的分类必须先登记进 stash：paintCategories 会校验「当前分类是否属于本类型」，
   * 不在 stash 里的分类 id 会被当成无效选择清掉（预置模板的分类是 expense 的，
   * 而模板会把 recordType 也一起带过来，两者刚好一致，但顺序不能反）。
   */
  if (state.templateHint?.categoryId) catStash.set(state.recordType, state.templateHint.categoryId);

  const realAccounts = accounts.filter((a) => a.kind !== 'virtual');
  const activeAccounts = realAccounts.filter((a) => !a.archivedAt);
  const archivedAccounts = realAccounts.filter((a) => a.archivedAt);
  const activeGroups = groups.filter((g) => !g.archivedAt);
  const activeTags = tags.filter((t) => !t.archivedAt);
  /**
   * 分类按 recordType 分桶。`GET /categories` 返回的是**主类别扁平数组**（每项带
   * `children`），不是按类型分好组的对象 —— 这里做一次分桶，后续选择器只认这个 Map。
   */
  const catByType = new Map();
  for (const p of catTrees) {
    const bucket = catByType.get(p.recordType) ?? [];
    bucket.push(p);
    catByType.set(p.recordType, bucket);
  }

  /** 该类型下可选子类别（扁平，按使用频次降序） */
  const flatCats = (recordType) => {
    const trees = catByType.get(recordType) ?? [];
    const out = [];
    for (const p of trees) {
      if (p.archivedAt) continue;
      for (const c of p.children ?? []) {
        if (c.archivedAt) continue;
        out.push({ id: c.id, name: c.name, icon: c.icon, parentId: p.id, parentName: p.name, count: c.txCount ?? 0 });
      }
    }
    return out;
  };

  let localResult = null;
  let remoteCorrection = null;
  let idleTimer = null;

  /* ---------------- 骨架 DOM ---------------- */
  const form = h(`
    <form class="compose__form" novalidate>
      <!--
        回访横幅（docs/13 §10.1）。**刻意不复用** .form-banner：那条是错误语义
        （danger 底 + danger 字），而「上次没记完」是邀请不是报错，用红色会把
        用户吓一跳以为出了什么错事。两条横幅可以同时出现，各自独立。
      -->
      <div class="form-draft" data-role="draft" data-visible="false">
        <span class="form-draft__icon">${lucide('history', 15)}</span>
        <span class="form-draft__msg" data-role="draft-msg"></span>
        <span class="form-draft__act">
          <button class="btn btn--sm" type="button" data-role="draft-use">继续</button>
          <button class="btn btn--quiet btn--sm" type="button" data-role="draft-drop">丢弃</button>
        </span>
      </div>

      <div class="form-banner" data-role="banner">
        <span class="form-banner__msg" data-role="banner-msg"></span>
        <span data-role="banner-act"></span>
      </div>

      <!--
        模板提示（docs/05 §10.6）：模板引用的分类被停用、账户被删时，
        **仍可预填但必须说清楚**。与上面两条都不同 —— 前者是邀请、那条是错误，
        这条是「提醒但不妨碍你继续」，所以单独一条，不复用 danger 也不复用 draft。
      -->
      <div class="form-note" data-role="tpl-note" data-visible="false">
        <span class="form-note__icon">${lucide('info', 15)}</span>
        <span class="form-note__body">
          <span class="form-note__title" data-role="tpl-note-title"></span>
          <span class="form-note__list" data-role="tpl-note-list"></span>
        </span>
        <button class="btn btn--quiet btn--sm" type="button" data-role="tpl-note-x"
                aria-label="关闭提示">${lucide('x', 14)}</button>
      </div>
      <div class="form-summary" data-role="summary">
        <span data-role="summary-title"></span>
        <span class="form-summary__links" data-role="summary-links"></span>
      </div>

      <!--
        浮层遮罩：桌面端是一层「点哪儿都关」的透明捕获层（不挡视线），
        ≤833px 时变成半透明底 + 底部 Sheet 的背景（见 app.css 十四·补充四）。
      -->
      <div class="scrim" data-role="scrim" hidden></div>

      <section class="card compose__card">
        <div class="compose__block">
          <!--
            记账形态选择（任务 5）：单次 / 周期 / 分期 —— **三个入口合并成这一个表单**。

            ## 为什么合并
            早先是三个入口（记一笔 / 添加周期 / 添加分期），各自一个页面、各自一套表单，
            结果是三份**几乎相同**的单次记账字段（类型、账户、分类、金额、日期）
            抄了三遍。抄一次就多一个不一致的地方 —— 已经出现过
            「分期页不显示手续费因为过期、记账页显示」这种分歧。

            合并后单次字段**只写一遍**，周期/分期在 modal 里**追加**自己的字段，
            语义上也更对：分期的首笔就是一笔普通支出 + 一条还款计划，
            它们本来就是同一件事的两个部分，而不是两件事。

            ## 编辑态不显示
            编辑是「改一笔已存在的账单」，而周期/分期是**建一条规则」。
            改一笔账不能变成「改一条规则」—— 那是另一个对象、另一个页面。
            所以这个选择器只在建账时渲染。

            ⚠️ 这段注释整体在**模板字符串内**：绝对不能出现反引号 ——
               一个反引号就把整个 form 模板提前闭合，报错还指向后面几十行处
               （第 3 次踩同一个坑，见 MEMORY「视图文件里的注释不要用反引号」）。
          -->

          <!--
            类型 + 一级分类 + 二级分类 = **一个** 三级 Mega Menu（docs/13 §4.4 改版二）。
            三者本来是一条决策链（定了类型才有分类树，定了大类才有子类），
            拆成两个控件时用户要在两个浮层之间来回跳；合并后一次展开即可从
            「支出」一路点到「餐饮 › 午餐」，中间状态全部在一个面板里可见。
          -->
          <div class="field" data-field="recordType">
            <span class="field__label" id="tx-pick-label">类型与分类</span>
            <div class="mega-host" data-role="pick-host">
              <button class="pick-trigger" type="button" data-role="pick-trigger"
                      aria-haspopup="menu" aria-expanded="false" aria-labelledby="tx-pick-label">
                <span class="pick-trigger__icon" data-role="pick-icon"></span>
                <span class="pick-trigger__text">
                  <span class="pick-trigger__label" data-role="pick-label"></span>
                  <span class="pick-trigger__sub" data-role="pick-sub"></span>
                </span>
                <span class="pick-trigger__chev">${icon('chevron-down', 16)}</span>
              </button>

              <div class="mega mega--pick" data-role="pick-panel" role="menu"
                   aria-labelledby="tx-pick-label" hidden>
                <!-- 建议：最近 9 笔支出的二级分类（用户指定，放在面板最前） -->
                <div class="mega__suggest" data-role="suggest" hidden>
                  <span class="mega__suggest-badge">${lucide('sparkles', 13)}<span>建议</span></span>
                  <div class="mega__suggest-chips" data-role="suggest-chips"></div>
                </div>

                <div class="mega__head">
                  <span class="mega__search-icon">${lucide('search', 15)}</span>
                  <input class="mega__search" type="search" data-role="cat-search"
                         placeholder="搜索分类（跨全部类型）" autocomplete="off" enterkeyhint="search" />
                </div>

                <div class="mega__panes" data-role="panes">
                  <div class="mega__col mega__col--type" data-role="col-type"></div>
                  <div class="mega__col mega__col--parent" data-role="col-parent"></div>
                  <div class="mega__col mega__col--leaf" data-role="col-leaf"></div>
                </div>

                <div class="mega__foot">
                  <span class="mega__hint" data-role="pick-hint">分类记在子类别上，一级只是分组</span>
                  <button class="mega__clear" type="button" data-role="cat-clear" hidden>清除分类</button>
                </div>
              </div>
            </div>
            <span class="field__error"></span>
            <span class="field__error" data-error-for="categoryId"></span>
            <span class="char-count" data-role="cat-none" hidden>
              该类型下暂无可用分类，请先到「分类」建一个
            </span>
          </div>

          <div class="direction-row" data-role="direction" role="radiogroup" aria-label="收付方向"></div>

          <!--
            「结清哪一笔」（docs/12 §六 D9）。**刻意不设成必填**：
            记账时不该被强迫先想清楚「还的是哪一笔」；不选也能存，那部分金额
            会进「未归属冲销」（往来页单列显示，不藏）。
            选了才谈得上「这笔还差多少」。
          -->
          <div class="field" data-role="settle-block" data-field="settles" hidden>
            <label class="field__label" for="tx-settle">结清哪一笔</label>
            <select class="input select" id="tx-settle" data-role="settle-select"></select>
            <p class="tt-fine-print" data-role="settle-hint" hidden></p>
            <!--
              「本次冲抵」：只有真的选了某一笔才出现（任务 2）。

              它与上面的「金额」是**两个不同的数**：
                金额       = 这一笔账单本身发生额（钱进/出多少）
                本次冲抵   = 这次冲掉那笔待结清里的多少（归属多少）
              两者相等是「一次结清」，小于是「部分结清」。
              混成一个字段就表达不了部分结清 —— 早先正是这么做的，
              于是部分结清在界面上不可达（选中时把冲抵写死成全部待结清）。
            -->
            <div class="field" data-field="settle-amount-wrap" data-role="settle-amount-wrap" hidden>
              <label class="field__label" for="tx-settle-amount">本次冲抵</label>
              <input class="input tnum" id="tx-settle-amount"
                     inputmode="decimal" placeholder="0.00" data-settle-money data-role="settle-amount"
                     aria-describedby="tx-settle-hint" autocomplete="off" />
            </div>
            <p class="tt-fine-print" id="tx-settle-hint" hidden></p>
            <span class="field__error" data-error-for="settles"></span>
          </div>
        </div>

        <div class="compose__block">
          <div class="field-row field-row--money">
            <div class="field" data-field="accountId">
              <label class="field__label" for="tx-account">账户</label>
              <select class="input select" id="tx-account" name="accountId"></select>
              <span class="field__error"></span>
            </div>
            <div class="field amount-field" data-field="amount">
              <label class="field__label" for="tx-amount">金额</label>
              <div class="amount-wrap">
                <span class="amount-wrap__sign">¥</span>
                <input class="amount-input" id="tx-amount" name="amount" type="text"
                       inputmode="decimal" autocomplete="off" enterkeyhint="done"
                       placeholder="0.00" aria-describedby="tx-preview" data-money />
              </div>
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field" data-field="toAccountId" data-role="to-account-field" hidden>
            <label class="field__label" for="tx-to-account">转入账户</label>
            <select class="input select" id="tx-to-account" name="toAccountId"></select>
            <span class="field__error"></span>
          </div>

          <p class="tt-fine-print" data-role="account-hint" hidden>
            登记欠款只是把债务记上账，这一刻不动任何账户余额；等真正还款时再记一笔「还款」。
          </p>

          <div class="field-row field-row--fee" data-role="fee-discount-row">
            <div class="field" data-field="fee" data-role="fee-field">
              <label class="field__label" for="tx-fee">手续费</label>
              <div class="suffix-wrap">
                <input class="input" id="tx-fee" name="fee" type="text" inputmode="decimal"
                       placeholder="选填" autocomplete="off" data-money />
                <span class="suffix-wrap__unit">元</span>
              </div>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="discount" data-role="discount-field">
              <label class="field__label" for="tx-discount">折扣</label>
              <div class="suffix-wrap">
                <input class="input" id="tx-discount" name="discount" type="text" inputmode="decimal"
                       placeholder="选填" autocomplete="off" data-money />
                <span class="suffix-wrap__unit">元</span>
              </div>
              <span class="field__error"></span>
            </div>
          </div>

          <!-- 记账形态（单次 / 周期 / 分期）：建账时才显示，下移到「手续费 / 折扣」下方，与「名称」同一行 -->
          <div class="field-row">
            <div class="field" data-field="entryMode" data-role="entry-mode-block"${
              mode === 'create' ? '' : ' hidden'
            }>
              <label class="field__label" for="tx-entry-mode">账期</label>
              <select class="input select" id="tx-entry-mode" data-role="entry-mode">
                <option value="single">单次（记一笔）</option>
                <option value="recurring">周期（每月自动记）</option>
                <option value="installment">分期（一次消费分 N 期还）</option>
              </select>
            </div>
            <div class="field field--wide" data-field="name">
              <label class="field__label" for="tx-name">名称</label>
              <input class="input" id="tx-name" name="name" list="tx-suggest-name"
                     placeholder="例如：公司楼下快餐" maxlength="${LIMITS.NAME_MAX_LEN}" autocomplete="off" />
              <span class="char-count" data-count-for="name"></span>
              <span class="field__error"></span>
            </div>
          </div>
          <div class="preview" id="tx-preview" data-role="preview" role="status" aria-live="polite"></div>
        </div>

        <div class="compose__block">
          <div class="field-row field-row--when">
            <div class="field" data-field="txDate">
              <label class="field__label" for="tx-date">日期</label>
              <input class="input" id="tx-date" name="txDate" type="date" />
              <!-- 快捷 chips 放在输入框**下面**而不是上面：两个格子的「标签+输入框」
                   必须等高，否则「日期」和「时间」的标签会一高一低（实测踩过） -->
              <div class="date-quick" data-role="date-quick"></div>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="txTime">
              <label class="field__label" for="tx-time">时间</label>
              <div class="suffix-wrap">
                <input class="input" id="tx-time" name="txTime" type="time" />
                <button class="suffix-x" type="button" data-role="clear-time"
                        aria-label="清空时间" title="清空时间（同日按录入先后排序）">
                  ${lucide('x', 15)}
                </button>
              </div>
              <span class="field__error"></span>
            </div>
          </div>
        </div>
      </section>


      <section class="card compose__card">
        <div class="compose__block">
          <div class="field-row">
            <div class="field" data-field="merchant">
              <label class="field__label" for="tx-merchant">商家</label>
              <input class="input" id="tx-merchant" name="merchant" list="tx-suggest-merchant"
                     placeholder="真功夫" maxlength="${LIMITS.MERCHANT_MAX_LEN}" autocomplete="off" />
              <span class="char-count" data-count-for="merchant"></span>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="counterparty">
              <label class="field__label" for="tx-counterparty">对象</label>
              <input class="input" id="tx-counterparty" name="counterparty" list="tx-suggest-counterparty"
                     placeholder="这笔钱和谁有关（借给谁 / 向谁买的）"
                     maxlength="${LIMITS.COUNTERPARTY_MAX_LEN}" autocomplete="off" />
              <span class="char-count" data-count-for="counterparty"></span>
              <span class="field__error"></span>
            </div>
          </div>
        </div>

        <div class="compose__block" data-role="tag-block">
          <span class="field__label">标签</span>
          <div class="mega-host" data-role="tag-host">
            <div class="cat-pick__row" data-role="tag-row"></div>
            <div class="mega mega--tag" data-role="tag-panel" hidden>
              <div class="tag-new" data-role="tag-creator">
                <label class="field__label" for="tx-new-tag">新标签</label>
                <input class="input" id="tx-new-tag" name="newTag" type="text" maxlength="12"
                       placeholder="例如：可报销" autocomplete="off" data-role="tag-name" />
                <div class="swatch-row" role="radiogroup" aria-label="标签颜色"
                     data-role="tag-colors"></div>
                <p class="tag-new__err" data-role="tag-err" hidden></p>
                <div class="tag-new__foot">
                  <button class="btn btn--quiet btn--sm" type="button" data-role="tag-cancel">取消</button>
                  <button class="btn btn--sm" type="button" data-role="tag-submit">创建</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="compose__block">
          <div class="field" data-field="note">
            <label class="field__label" for="tx-note">备注</label>
            <input class="input" id="tx-note" name="note" placeholder="补充说明"
                   maxlength="${LIMITS.NOTE_MAX_LEN}" autocomplete="off" />
            <span class="char-count" data-count-for="note"></span>
            <span class="field__error"></span>
          </div>
        </div>

        <div class="compose__block" data-role="attach-block">
          <span class="field__label">附件</span>
          <label class="btn btn--quiet btn--sm attach-pick" data-role="attach-pick">
            ${icon('camera', 16)}<span>添加附件（发票 / 凭证）</span>
            <input class="visually-hidden" type="file" data-role="attach-input"
                   accept="image/*,.pdf" multiple />
          </label>
          <div class="attach-staged" data-role="attach-list"></div>
        </div>
      </section>

      <div class="action-bar">
        <div class="action-bar__summary">
          <span class="action-bar__label" data-role="sum-label"></span>
          <span class="action-bar__value tnum" data-role="sum-value">¥ 0.00</span>
        </div>
        <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">${
          mode === 'edit' ? '放弃修改' : '取消'
        }</button>
        <button class="btn" type="submit" data-role="submit">${
          mode === 'edit' ? '保存修改' : '保存'
        }</button>
      </div>
    </form>
  `);

  /** 历史补全用的 datalist（docs/04 §8.11） */
  const suggestHost = h('<span></span>');
  ['name', 'merchant', 'counterparty'].forEach((f) => {
    suggestHost.insertAdjacentHTML(
      'beforeend',
      `<datalist id="tx-suggest-${esc(f)}"></datalist>`,
    );
  });
  form.prepend(suggestHost);

  const $ = (sel) => form.querySelector(sel);
  const body = /** @type {HTMLElement} */ (frame.querySelector('[data-role=body]'));
  /** 周期/分期的追加参数（modal 里填的）。null = 单次记账。必须与 modal 同在 mountCompose 内。 */
  let planPayload = null;

  /**
   * 周期 / 分期的补充表单（居中 modal + 暗色遮罩，任务 5）。
   *
   * ## 为什么用 modal 而不是把字段塞进主表单
   *
   * 单次记账有 8 个字段，已经占满一屏。周期再加 7 个、分期再加 8 个 ——
   * 全部平铺会让 90% 的用户（只记单次）每次都要滚过一屏用不上的字段。
   *
   * modal 的语义正好对：**主表单 = 这一笔是什么**（类型、账户、分类、金额、日期），
   * **modal = 这笔还附带什么规则**（周期规则 / 分期期数）。用户改完规则立刻
   * 回到主表单，能立刻确认「这笔本身填对了吗」。
   *
   * ## 为什么不用原生 dialog
   *
   * dialog.showModal() 的顶层渲染与 z-index 在各浏览器上不一致，
   * 且它会把**整个文档**变成 inert —— 侧栏 TabBar 也一起失效，
   * 而本项目的导航在侧栏 / 底部 TabBar，不在 modal 内部。
   * 自己实现能精确控制「只压暗、只关这一个」。
   *
   * ## 字段与既有页面的关系
   *
   * 字段与 /recurring、/installments 的表单**同源**（同一套参数名），
   * 但**不共用那两页的代码** —— 抽公共组件要跨三个视图文件，
   * 而这里只需要「读主表单的状态 + 追加几个字段」。
   * 参数名一致才是关键：后端 schema 只有一份。
   */
  const modalHost = document.createElement('div');
  let modalCleanup = null;

  function openPlanModal(kind) {
    closePlanModal();
    const isInst = kind === 'installment';
    const title = isInst ? '分期补充' : '周期补充';
    const accOpts = (selected) =>
      groups
        .map((g) => {
          const list = activeAccounts.filter((a) => a.groupId === g.id);
          if (!list.length) return '';
          return `<optgroup label="${esc(g.name)}">${list
            .map(
              (a) =>
                `<option value="${esc(a.id)}"${selected === a.id ? ' selected' : ''}>${esc(a.name)}</option>`,
            )
            .join('')}</optgroup>`;
        })
        .join('');

    /**
     * 周期表单的频率决定哪两个字段要显示（与 `/recurring` 同一套逻辑）：
     * 月度要「几号」，周度要「周几」，日/年不需要。
     */
    const fDated = kind === 'recurring';
    const dlg = h(`
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-role="plan-modal">
        <div class="modal__scrim" data-role="modal-scrim"></div>
        <div class="modal__panel">
          <div class="modal__head">
            <h2 class="modal__title" id="modal-title">${esc(title)}</h2>
            <button class="btn btn--quiet btn--icon" type="button" data-role="modal-x"
                    aria-label="关闭">${icon('close', 18)}</button>
          </div>
          <div class="modal__body">
            <p class="tt-caption text-muted">
              ${isInst
                ? '这笔消费会一次记全额，然后生成还款计划 —— 不会按期重复记支出。'
                : '到日子会自动记一笔，金额与分类沿用这里填的。'}
            </p>
            ${
              isInst
                ? `
            <div class="grid grid--two">
              <div class="field">
                <label class="field__label" for="ins-count">分期期数</label>
                <input class="input" id="ins-count" name="installmentCount" type="number"
                       inputmode="numeric" min="1" max="60" value="12" />
                <span class="field__hint">1~60 期。每期本金由总额均分，尾差归最后一期。</span>
              </div>
              <div class="field">
                <label class="field__label" for="ins-freq">还款频率</label>
                <select class="input select" id="ins-freq" name="frequency">
                  <option value="monthly">每月</option>
                  <option value="weekly">每周</option>
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="ins-debt">记在哪张卡（负债账户）</label>
                <select class="input select" id="ins-debt" name="debtAccountId">
                  ${accOpts(state.accountId)}
                </select>
                <span class="field__hint">首笔全额支出记在它头上，还款时它是收款方。</span>
              </div>
              <div class="field">
                <label class="field__label" for="ins-fm">手续费方式</label>
                <select class="input select" id="ins-fm" name="feeMode">
                  <option value="once">一次性收取</option>
                  <option value="per_period">每期收取</option>
                </select>
              </div>
              <div class="field" data-role="ins-total-fee">
                <label class="field__label" for="ins-total-fee-i">手续费总额</label>
                <input class="input tnum" id="ins-total-fee-i" name="totalFee" inputmode="decimal"
                       placeholder="0.00" data-plan-money />
              </div>
              <div class="field" data-role="ins-per-fee" hidden>
                <label class="field__label" for="ins-per-fee-i">每期手续费</label>
                <input class="input tnum" id="ins-per-fee-i" name="perPeriodFee" inputmode="decimal"
                       placeholder="0.00" data-plan-money />
              </div>
              <div class="field">
                <label class="field__label" for="ins-fh">手续费摊法</label>
                <select class="input select" id="ins-fh" name="feeHandling">
                  <option value="first_period">首期收齐</option>
                  <option value="per_period">每期均摊</option>
                  <option value="manual_last">最后一期收齐</option>
                </select>
              </div>
            </div>`
                : `
            <div class="grid grid--two">
              <div class="field">
                <label class="field__label" for="rc-freq">频率</label>
                <select class="input select" id="rc-freq" name="frequency">
                  <option value="monthly">每月</option>
                  <option value="weekly">每周</option>
                  <option value="daily">每天</option>
                  <option value="yearly">每年</option>
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="rc-interval">间隔</label>
                <input class="input" id="rc-interval" name="intervalCount" type="number"
                       inputmode="numeric" min="1" max="365" value="1" />
                <span class="field__hint">「频率=每周、间隔=2」= 每两周一次。</span>
              </div>
              <div class="field" data-role="f-monthly">
                <label class="field__label" for="rc-dom">每月第几日</label>
                <input class="input" id="rc-dom" name="dayOfMonth" type="number"
                       inputmode="numeric" min="1" max="31" value="${esc(String(Number(state.txDate?.slice(8, 10) ?? 1)))}" />
              </div>
              <div class="field" data-role="f-weekly" hidden>
                <label class="field__label" for="rc-wd">星期几</label>
                <select class="input select" id="rc-wd" name="weekDay">
                  ${['日', '一', '二', '三', '四', '五', '六']
                    .map((w, i) => {
                      const cur = new Date(state.txDate ?? todayStr()).getDay();
                      return `<option value="${i}"${cur === i ? ' selected' : ''}>周${w}</option>`;
                    })
                    .join('')}
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="rc-end">结束日期（选填）</label>
                <input class="input" id="rc-end" name="endDate" type="date" value="" />
              </div>
              <div class="field">
                <label class="field__label" for="rc-ahead">提前几天生成</label>
                <input class="input" id="rc-ahead" name="generateAheadDays" type="number"
                       inputmode="numeric" min="0" max="30" value="3" />
                <span class="field__hint">0 表示当天生成。提前生成能让账单列表里先看到。</span>
              </div>
            </div>`
            }
          </div>
          <div class="modal__foot">
            <button class="btn btn--quiet" type="button" data-role="modal-cancel">取消</button>
            <button class="btn" type="button" data-role="modal-ok">确定</button>
          </div>
        </div>
      </div>
    `);

    document.body.appendChild(modalHost);
    modalHost.replaceChildren(dlg);
    // 锁背景滚动：modal 打开时页面还能滚会让「点空白关掉」变得不可靠
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      modalHost.replaceChildren();
      document.body.style.overflow = prevOverflow;
      modalCleanup = null;
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    dlg.querySelector('[data-role=modal-scrim]').addEventListener('click', close);
    dlg.querySelector('[data-role=modal-x]').addEventListener('click', close);
    dlg.querySelector('[data-role=modal-cancel]').addEventListener('click', close);
    dlg.querySelector('[data-role=modal-ok]').addEventListener('click', () => {
      const plan = readPlanFields(dlg, kind);
      close();
      if (plan) {
        planPayload = plan;
        toast(isInst ? '分期参数已填，保存后会生成还款计划' : '周期规则已填，保存后按规则自动记');
      }
    });

    /* ---- modal 内的联动 ---- */
    if (!fDated) {
      const fm = dlg.querySelector('#ins-fm');
      const syncFee = () => {
        const per = fm.value === 'per_period';
        dlg.querySelector('[data-role=ins-total-fee]').hidden = per;
        dlg.querySelector('[data-role=ins-per-fee]').hidden = !per;
      };
      fm.addEventListener('change', syncFee);
      syncFee();
    } else {
      const freq = dlg.querySelector('#rc-freq');
      const syncFreq = () => {
        dlg.querySelector('[data-role=f-monthly]').hidden = freq.value !== 'monthly';
        dlg.querySelector('[data-role=f-weekly]').hidden = freq.value !== 'weekly';
      };
      freq.addEventListener('change', syncFreq);
      syncFreq();
    }
    dlg.querySelectorAll('[data-plan-money]').forEach((i) =>
      i.addEventListener('input', () => {
        i.value = sanitizeAmountInput(i.value);
      }),
    );

    // 焦点进 modal（键盘用户不会「焦点还在背景里，按什么键都没反应」）
    dlg.querySelector('[data-role=modal-x]').focus();
    modalCleanup = close;
  }

  function closePlanModal() {
    if (modalCleanup) modalCleanup();
  }

  /** modal 字段 → 后端 payload 片段（字段名与 /recurring、/installments 一致） */
  function readPlanFields(dlg, kind) {
    const v = (sel) => dlg.querySelector(sel)?.value ?? '';
    if (kind === 'installment') {
      const count = Number(v('#ins-count') || 0);
      if (count < 1 || count > 60) {
        toast('分期期数要在 1~60 之间', 'error');
        return null;
      }
      const per = v('#ins-fm') === 'per_period';
      return {
        kind: 'installment',
        installmentCount: count,
        frequency: v('#ins-freq') || 'monthly',
        feeMode: per ? 'per_period' : 'once',
        totalFee: per ? undefined : normalizeAmountInput(v('#ins-total-fee')) || '0',
        perPeriodFee: per ? normalizeAmountInput(v('#ins-per-fee')) || '0' : undefined,
        feeHandling: v('#ins-fh') || 'first_period',
        debtAccountId: v('#ins-debt'),
      };
    }
    return {
      kind: 'recurring',
      frequency: v('#rc-freq') || 'monthly',
      intervalCount: Math.max(1, Number(v('#rc-interval') || 1)),
      dayOfMonth: v('#rc-freq') === 'monthly' ? Number(v('#rc-dom') || 1) : undefined,
      weekDay: v('#rc-freq') === 'weekly' ? Number(v('#rc-wd') || 1) : undefined,
      endDate: v('#rc-end') || undefined,
      generateAheadDays: Math.max(0, Number(v('#rc-ahead') || 0)),
    };
  }

  /**
   * 记账形态选择器的接线放在 `$` 定义之后（见下方 `wireEntryMode` 调用）。
   *
   * ⚠️ 不要把它写成模块顶层的立即执行：这里的 `$` 是在 `form = h(...)`
   *    **之后**才定义的箭头函数，提前调用 = TDZ 的 ReferenceError，
   *    而报错点在函数首行、完全指不到真正的调用位置（实测过一次）。
   */
  function wireEntryMode() {
    $('[data-role=entry-mode]')?.addEventListener('change', (e) => {
      const kind = e.target.value;
      if (kind === 'single') {
        planPayload = null;
        closePlanModal();
        return;
      }
      openPlanModal(kind);
    });
  }

  // modal 闭包与 state 同在 mountCompose 内，依赖才成立（见剪出说明）
  body.replaceChildren(form);

  // `$` 与 `activeAccounts` 都已就绪，此刻接线才安全（见 wireEntryMode 的注释）
  wireEntryMode();

  /* ================================================================== *
   * 渲染：类型 / 方向 / 账户 / 分类 / 日期 / 标签
   * ================================================================== */

  /* ------------------------------------------------------------------ *
   * 浮层控制器（三级选择面板 / 新建标签两个 Mega Menu 共用）
   *
   * 同一时刻只允许一个浮层：两个浮层都压在同一个表单上，允许并存会出现
   * 「标签面板盖着分类面板」这种用户无法推理的叠加。`scrim` 既承担移动端
   * 的暗底，也承担桌面端「点别处就收起来」的点击捕获。
   * ------------------------------------------------------------------ */

  const PANELS = {
    pick: { panel: '[data-role=pick-panel]', trigger: '[data-role=pick-trigger]' },
    tag: { panel: '[data-role=tag-panel]', trigger: '[data-role=tag-add]' },
  };
  /** 当前打开的浮层；`null` = 全关 */
  let openKind = null;

  const closePanels = ({ focus = false } = {}) => {
    if (!openKind) return;
    const was = openKind;
    openKind = null;
    for (const { panel, trigger } of Object.values(PANELS)) {
      const p = $(panel);
      if (p) p.hidden = true;
      const t = $(trigger);
      t?.setAttribute('aria-expanded', 'false');
      t?.closest('.mega-host')?.classList.remove('is-open');
    }
    $('[data-role=scrim]').hidden = true;
    if (focus) $(PANELS[was].trigger)?.focus();
  };

  const openPanel = (kind, { focusSearch = false, focusFirst = null } = {}) => {
    closePanels();
    openKind = kind;
    const { panel, trigger } = PANELS[kind];
    $(panel).hidden = false;
    $(trigger)?.setAttribute('aria-expanded', 'true');
    $(trigger)?.closest('.mega-host')?.classList.add('is-open');
    $('[data-role=scrim]').hidden = false;
    if (focusSearch) $(panel).querySelector('[data-role=cat-search]')?.focus();
    if (focusFirst) $(focusFirst)?.focus();
  };

  const togglePanel = (kind, opts) => {
    if (openKind === kind) closePanels({ focus: true });
    else openPanel(kind, opts);
  };

  /* ================================================================== *
   * ① 类型 + 分类：**一个** 三级 Mega Menu（docs/13 §4.4 改版二）
   *
   * 三级 = 类型 → 一级分类 → 二级分类，桌面同屏三列，移动端同屏三段（竖排）。
   * 「点了类型但还没点分类」是一个**中间态**：它只活在面板内部的 `pickDraft`，
   * 不回写 `state` —— 否则用户点开面板看一眼「应收款项」又关掉，表单里的
   * 类型就被悄悄改掉了，而且信用卡账目会莫名多出一笔债权。
   * 只有落到「二级分类」上（或选无分类的转账）才算一次完整选择。
   * ================================================================== */

  /** 触发按钮上的副标题：应收/应付显示当前阶段，其余显示该类型的一句话解释 */
  const directionLabelOf = (t, d) =>
    (DIRECTION_CHOICES[t] ?? []).find((c) => c.value === d)?.label ?? null;

  /** 面板内的草稿（类型 + 当前展开的一级分类），只在提交时写回 state */
  const pickDraft = { type: state.recordType, parentId: null };
  let catQuery = '';

  const catTreesOf = (t) =>
    (catByType.get(t) ?? []).filter(
      (p) => !p.archivedAt && (p.children ?? []).some((c) => !c.archivedAt),
    );

  const currentCat = () =>
    flatCats(state.recordType).find((c) => c.id === state.categoryId) ?? null;

  /** 把草稿对齐到表单当前值：每次展开面板都从「现在的选择」重新出发 */
  const resetPickDraft = () => {
    pickDraft.type = state.recordType;
    const trees = catTreesOf(state.recordType);
    const cur = currentCat();
    pickDraft.parentId =
      (cur && trees.some((p) => p.id === cur.parentId) ? cur.parentId : null) ??
      trees[0]?.id ??
      null;
    catQuery = '';
    $('[data-role=cat-search]').value = '';
  };

  const paintPickTrigger = () => {
    const meta = TYPE_META[state.recordType] ?? TYPE_META.expense;
    const c = currentCat();
    const dir = directionLabelOf(state.recordType, state.direction);
    $('[data-role=pick-icon]').innerHTML = lucide(
      c?.icon || TYPE_ICON[state.recordType] || 'tag',
      18,
    );
    $('[data-role=pick-label]').textContent = c ? c.name : meta.label;
    // 副值把「这笔是什么性质」写全：类型 · 阶段 · 一级分类
    $('[data-role=pick-sub]').textContent = c
      ? [meta.label, dir, c.parentName].filter(Boolean).join(' · ')
      : (dir ?? meta.hint);
    $('[data-role=pick-trigger]').classList.toggle(
      'is-empty',
      !c && TYPE_WITH_CATEGORY.has(state.recordType),
    );
    $('[data-role=cat-none]').hidden =
      !TYPE_WITH_CATEGORY.has(state.recordType) || catTreesOf(state.recordType).length > 0;
  };

  /**
   * 建议 = **最近 9 笔支出的二级分类**（用户本轮指定，放在面板最前面）。
   *
   * 与上一版的「按时段猜分类」相比，这个口径是可验证的：它就是用户自己刚记过的
   * 东西，猜错的概率极低。去重按「最近一笔在前」保留，最多 9 个；
   * 取不到对应分类（已归档 / 已删）的直接跳过 —— 建议里出现一个点了没反应的
   * 死项，比整条建议不出现更伤信任。
   */
  const suggestCats = (() => {
    if (mode !== 'create') return [];
    const index = new Map(flatCats('expense').map((c) => [c.id, c]));
    const out = [];
    const seen = new Set();
    for (const tx of recentExpense) {
      const id = tx.category?.id;
      if (!id || seen.has(id)) continue;
      const c = index.get(id);
      if (!c) continue;
      seen.add(id);
      out.push(c);
      if (out.length >= SUGGEST_MAX) break;
    }
    return out;
  })();

  const paintSuggest = () => {
    const host = $('[data-role=suggest]');
    // 搜索态下建议让位：用户已经在主动找某个分类，再推「最近的」只会碍事
    const show = suggestCats.length > 0 && !catQuery.trim();
    host.hidden = !show;
    if (!show) return;
    $('[data-role=suggest-chips]').innerHTML = suggestCats
      .map(
        (c) => `
        <button class="suggest-chip" type="button" role="menuitem"
                data-sug="${esc(c.id)}" title="${esc(`${c.parentName} › ${c.name}`)}">
          <span class="suggest-chip__icon">${lucide(c.icon || 'tag', 14)}</span>
          <span class="suggest-chip__name">${esc(c.name)}</span>
        </button>`,
      )
      .join('');
    $('[data-role=suggest-chips]')
      .querySelectorAll('[data-sug]')
      .forEach((el) =>
        el.addEventListener('click', () => applyPick('expense', el.dataset.sug)),
      );
  };

  const paintDirection = () => {
    const choices = DIRECTION_CHOICES[state.recordType];
    const host = $('[data-role=direction]');
    if (!choices) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = `
      <span class="field__label">收付方向</span>
      <div class="segmented" role="radiogroup" aria-label="收付方向">
        ${choices
          .map(
            (c) => `
          <button class="segmented__item" type="button" role="radio"
                  data-dir="${esc(c.value)}" aria-selected="${state.direction === c.value}">
            ${esc(c.label)}<span class="chip__sub">${esc(c.sub)}</span>
          </button>`,
          )
          .join('')}
      </div>
    `;
    host.querySelectorAll('[data-dir]').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (state.direction === btn.dataset.dir) return;
        state.direction = btn.dataset.dir;
        paintDirection();
        /**
         * 收付方向是**第二个驱动字段显隐的输入**（第一个是类型）：
         * 借出允许手续费、收回允许折扣，两者互换。少了这两行，
         * 方向切了但手续费/折扣框还停在上一阶段的可见性上 ——
         * 用户会在「收回」这一笔上填一个后端必然丢弃的手续费。
         */
        paintPickTrigger(); // 触发器的副值也要从「借出」变成「收回」
        paintMoneyFields();
        // 离开结算/核销阶段就别留着关联了：一个挂在「借出」笔上的关联
        // 是无意义的悬空引用，后端也会拒。
        if (!isSettlePhase()) state.settles = [];
        paintSettleBlock();
        refreshMoney({ server: true });
      }),
    );
  };

  /** 主账户 select：按分组 optgroup，已归档单独置底且不可选（docs/13 §4.5） */
  const paintAccounts = () => {
    const sel = $('[name=accountId]');
    /**
     * 编辑/复制一条挂在**已归档账户**上的历史账单时，这个账户必须仍然可选 ——
     * 否则一进表单就被静默换到别的账户，用户按「保存」就把余额记到错账户上了。
     * 归档只禁止「新账单」，不禁止「继续指向它」。
     */
    const pinned = realAccounts.some((a) => a.id === state.accountId)
      ? realAccounts.find((a) => a.id === state.accountId)
      : null;
    const usable = pinned && pinned.archivedAt ? [...activeAccounts, pinned] : activeAccounts;
    /**
     * 只有**已归档**的 pinned 才需要从所属分组里剔除 —— 它会被单独渲染成
     * 「当前账单的账户（已归档）」那一组，跳过是为了不重复。
     *
     * ⚠️ 这里曾经无条件写 `a.id !== pinned.id`，于是**任何被选中的活跃账户都会从下拉里消失**，
     * 浏览器只能静默改选第一项：新建时看着「碰巧正常」（默认值恰好就是排序第一个），
     * 但编辑/模板预填指定别的账户时就会**无声地换账户** —— 用户按下保存，
     * 余额就记到了另一个账上。模板预填这条链路把它逼出来了。
     */
    const skipPinnedInGroups = !!pinned?.archivedAt;
    if (!usable.some((a) => a.id === state.accountId)) {
      state.accountId = usable.find((a) => a.kind === 'asset')?.id ?? usable[0]?.id ?? null;
    }
    const opts = [];
    for (const g of activeGroups) {
      const inGroup = usable.filter(
        (a) => a.groupId === g.id && !(skipPinnedInGroups && a.id === pinned.id),
      );
      if (!inGroup.length) continue;
      opts.push(
        `<optgroup label="${esc(g.name)}">${inGroup
          .map((a) => option(a.id, `${a.name} · ${money(a.balance)}`, state.accountId))
          .join('')}</optgroup>`,
      );
    }
    if (pinned?.archivedAt) {
      // 当前账单所在的账户已归档：单独成组并置顶可见（否则用户找不到为什么账户"变了"）
      opts.unshift(
        `<optgroup label="当前账单的账户（已归档）">${option(
          pinned.id,
          `${pinned.name} · 已归档`,
          state.accountId,
        )}</optgroup>`,
      );
    }
    const orphan = usable.filter(
      (a) =>
        !(skipPinnedInGroups && a.id === pinned.id) &&
        !activeGroups.some((g) => g.id === a.groupId),
    );
    if (orphan.length) {
      opts.push(
        `<optgroup label="其它">${orphan
          .map((a) => option(a.id, `${a.name} · ${money(a.balance)}`, state.accountId))
          .join('')}</optgroup>`,
      );
    }
    const archivedRest = archivedAccounts.filter((a) => a.id !== pinned?.id);
    if (archivedRest.length) {
      opts.push(
        `<optgroup label="已归档（不可用于新账单）">${archivedRest
          .map((a) => option(a.id, a.name, state.accountId, { disabled: true }))
          .join('')}</optgroup>`,
      );
    }
    sel.innerHTML = opts.join('');
    sel.disabled = TYPE_WITH_TO_ACCOUNT.has(state.recordType)
      ? false
      : state.recordType === 'payable' && state.direction === 'none';
    // 应付·产生：账户不参与选择（登记欠款不动余额），但仍按保留值提交
    sel.setAttribute('aria-disabled', String(sel.disabled));
    $('[data-role=account-hint]').hidden = !sel.disabled;
  };

  /** 转入账户 select：过滤主账户自身与手续费账户（docs/13 §4.5） */
  const paintToAccounts = () => {
    const field = $('[data-role=to-account-field]');
    const need = TYPE_WITH_TO_ACCOUNT.has(state.recordType);
    field.hidden = !need;
    if (!need) {
      // 应收/应付的第二账户由后端按 kind 解析，前端不参与选择（docs/13 §4.3）
      return;
    }
    const pinned = realAccounts.find((a) => a.id === state.toAccountId) ?? null;
    const base = pinned && pinned.archivedAt ? [...activeAccounts, pinned] : activeAccounts;
    const usable = base.filter((a) => a.id !== state.accountId && a.type !== 'fee');
    if (!usable.some((a) => a.id === state.toAccountId)) {
      state.toAccountId = usable[0]?.id ?? null;
    }
    $('[name=toAccountId]').innerHTML = usable
      .map((a) =>
        option(
          a.id,
          `${a.name} · ${money(a.balance)}${a.archivedAt ? ' · 已归档' : ''}`,
          state.toAccountId,
        ),
      )
      .join('');
  };

  /* ================================================================== *
   * ② 二级 / 三级：一级分类 → 二级分类（与 ① 同属一个浮层）
   *
   * 一列只干一件事：左列改「性质」，中列改「大类」，右列落「子类」。
   * 点类型的动作**不会**立刻写回表单（见 `pickDraft` 的注释）：
   * 它只把中/右两列换成本类型的分类树，等右列被点中才提交。
   * ================================================================== */

  /** 二级分类 chip。`typeTag` 只在「搜索态跨类型」时出现，标明这个子类属于哪种类型 */
  const catChip = (c, typeTag = null) => {
    const on = !typeTag && pickDraft.type === state.recordType && c.id === state.categoryId;
    return `
      <button class="option-chip${typeTag ? ' option-chip--tagged' : ''}" type="button"
              role="menuitemradio" aria-checked="${on}"
              data-cat="${esc(c.id)}"${typeTag ? ` data-cat-type="${esc(typeTag)}"` : ''}
              title="${esc(`${c.parentName} › ${c.name}`)}">
        ${c.icon ? lucide(c.icon, 14) : ''}<span>${esc(c.name)}</span>
        ${typeTag ? `<span class="option-chip__type">${esc(TYPE_META[typeTag]?.label ?? '')}</span>` : ''}
      </button>`;
  };

  const paintPickPanel = () => {
    const panes = $('[data-role=panes]');
    const colType = $('[data-role=col-type]');
    const colParent = $('[data-role=col-parent]');
    const colLeaf = $('[data-role=col-leaf]');
    const q = catQuery.trim().toLowerCase();

    $('[data-role=cat-clear]').hidden = !state.categoryId;
    paintSuggest();

    /* ---- 搜索态：三列让位，整幅宽度交给命中结果（跨全部类型） ---- */
    if (q) {
      panes.dataset.mode = 'search';
      colType.hidden = true;
      colParent.hidden = true;
      colLeaf.hidden = false;
      const hits = [];
      for (const t of TYPE_WITH_CATEGORY) {
        for (const c of flatCats(t)) {
          if (c.name.toLowerCase().includes(q) || c.parentName.toLowerCase().includes(q)) {
            hits.push({ ...c, recordType: t });
          }
        }
      }
      hits.sort((a, b) => b.count - a.count);
      colLeaf.innerHTML = hits.length
        ? `<p class="mega__col-title">命中 ${hits.length} 个</p>
           <div class="mega__grid">${hits.map((c) => catChip(c, c.recordType)).join('')}</div>`
        : `<p class="mega__empty">没有匹配的分类</p>`;
      colLeaf.querySelectorAll('[data-cat]').forEach((el) =>
        el.addEventListener('click', () => applyPick(el.dataset.catType, el.dataset.cat)),
      );
      return;
    }

    colType.hidden = false;
    colParent.hidden = false;

    /* ---- 第一级：类型（五种，一次摊开） ---- */
    colType.innerHTML = TYPE_GROUPS.map(
      (g) => `
      <div class="mega__group">
        <p class="mega__col-title">${esc(g.label)}</p>
        ${g.types
          .map((t) => {
            const m = TYPE_META[t];
            const on = t === pickDraft.type;
            return `
            <button class="mega__item${on ? ' is-on' : ''}" type="button"
                    role="menuitemradio" aria-checked="${on}" data-type="${esc(t)}">
              <span class="mega__item-icon">${lucide(TYPE_ICON[t] ?? 'circle-help', 17)}</span>
              <span class="mega__item-text">
                <span class="mega__item-name">${esc(m.label)}</span>
                <span class="mega__item-hint">${esc(m.hint)}</span>
              </span>
              ${on ? `<span class="mega__item-mark">${lucide('check', 16)}</span>` : ''}
            </button>`;
          })
          .join('')}
      </div>`,
    ).join('');
    colType.querySelectorAll('[data-type]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const next = btn.dataset.type;
        // 转账没有分类：点到它本身就是「选完了」
        if (!TYPE_WITH_CATEGORY.has(next)) {
          applyPick(next, null);
          return;
        }
        pickDraft.type = next;
        pickDraft.parentId = catTreesOf(next)[0]?.id ?? null;
        paintPickPanel();
      }),
    );

    /* ---- 转账：没有第二、三级，把剩下的宽度换成一句解释 ---- */
    if (!TYPE_WITH_CATEGORY.has(pickDraft.type)) {
      panes.dataset.mode = 'leaf-less';
      colLeaf.hidden = true;
      colLeaf.innerHTML = '';
      colParent.innerHTML = `
        <p class="mega__col-title">分类</p>
        <p class="mega__empty">转账不记分类 —— 选好下面的「转入账户」就行。</p>`;
      return;
    }
    panes.dataset.mode = 'cascade';
    colLeaf.hidden = false;

    /* ---- 第二级：一级分类 ---- */
    const trees = catTreesOf(pickDraft.type);
    // 分类被删空的类型：没有第二、三级可走，只留「只改类型」的出口（同转账的排布）
    if (!trees.length) {
      panes.dataset.mode = 'leaf-less';
      colLeaf.hidden = true;
      colLeaf.innerHTML = '';
      colParent.innerHTML = `
        <p class="mega__col-title">一级分类</p>
        <p class="mega__empty">该类型下还没有分类。</p>
        <button class="btn btn--quiet btn--sm" type="button" data-role="type-only">
          只用「${esc(TYPE_META[pickDraft.type].label)}」，先不选分类
        </button>`;
      colParent
        .querySelector('[data-role=type-only]')
        ?.addEventListener('click', () => applyPick(pickDraft.type, null));
      return;
    }
    if (!trees.some((p) => p.id === pickDraft.parentId)) {
      pickDraft.parentId = trees[0]?.id ?? null;
    }
    colParent.innerHTML = `<p class="mega__col-title">一级分类</p>
         <div class="mega__list">${trees
           .map((p) => {
             const kids = (p.children ?? []).filter((c) => !c.archivedAt);
             const on = p.id === pickDraft.parentId;
             // 该支下已有选中项 → 留一个点，收起面板后也知道「选在哪一支」
             const hasPick =
               pickDraft.type === state.recordType && kids.some((c) => c.id === state.categoryId);
             return `
             <button class="mega__navitem${on ? ' is-on' : ''}${hasPick ? ' has-pick' : ''}"
                     type="button" role="menuitem" aria-checked="${on}" data-parent="${esc(p.id)}">
               <span class="mega__navitem-icon">${p.icon ? lucide(p.icon, 16) : ''}</span>
               <span class="mega__navitem-name">${esc(p.name)}</span>
               <span class="mega__navitem-count">${kids.length}</span>
             </button>`;
           })
           .join('')}</div>`;
    colParent.querySelectorAll('[data-parent]').forEach((el) =>
      el.addEventListener('click', () => {
        pickDraft.parentId = el.dataset.parent;
        paintPickPanel();
      }),
    );

    /* ---- 第三级：二级分类 ---- */
    const pane = trees.find((p) => p.id === pickDraft.parentId);
    const kids = (pane?.children ?? [])
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        parentId: pane.id,
        parentName: pane.name,
        count: c.txCount ?? 0,
      }))
      // 频次优先：记账是重复动作，常用分类应该伸手就够得到（docs/05 §3.4）
      .sort((a, b) => b.count - a.count);
    colLeaf.innerHTML = pane
      ? `<p class="mega__col-title">${esc(pane.name)}</p>
         <div class="mega__grid">${kids.map((c) => catChip(c)).join('')}</div>`
      : `<p class="mega__empty">选一个一级分类</p>`;
    colLeaf.querySelectorAll('[data-cat]').forEach((el) =>
      el.addEventListener('click', () => applyPick(pickDraft.type, el.dataset.cat)),
    );
  };

  /**
   * 提交一次完整选择：类型（必要时）+ 二级分类 → 写回 state 并收起面板。
   *
   * 复刻 `setRecordType` 的字段保留策略（分类按类型暂存、转入账户从转账切走即弃、
   * 方向重置为「产生」），所以先把新分类塞进 stash、再走 `setRecordType`，
   * 让它顺手把分类恢复成刚点的那个 —— 免得走「先恢复旧值再覆盖」的两跳。
   */
  function applyPick(type, categoryId) {
    if (categoryId) catStash.set(type, categoryId);
    if (TYPE_WITH_CATEGORY.has(state.recordType)) catStash.set(state.recordType, state.categoryId);
    if (type !== state.recordType) setRecordType(type);
    if (categoryId) state.categoryId = categoryId;
    paintAll();
    clearFieldError('categoryId');
    closePanels({ focus: true });
    // 金额还没填时才抢焦点：用户已经填过就别把他从原来的输入框拽走
    if (!state.amount) $('[name=amount]')?.focus();
  }

  const paintTags = () => {
    $('[data-role=tag-row]').innerHTML =
      activeTags
        .map(
          (t) => `
        <button class="option-chip" type="button" role="checkbox"
                aria-checked="${state.tags.has(t.id)}" data-tag="${esc(t.id)}">
          <span class="option-chip__dot" style="--tag-color:${esc(t.color ?? '')}"></span>
          <span>${esc(t.name)}</span>
        </button>`,
        )
        .join('') +
      // 「+ 新建标签」常驻在行尾（docs/13 §4.5「支持即时新建」）。
      // 记账当场想打一个新标记时，不应该被迫先离开这一页去标签页建好再回来。
      `<button class="option-chip option-chip--new" type="button" data-role="tag-add"
               aria-haspopup="menu" aria-expanded="false">
         ${lucide('plus', 14)}<span>新建标签</span>
       </button>`;
    $('[data-role=tag-row]').querySelectorAll('[data-tag]').forEach((el) =>
      el.addEventListener('click', () => {
        const id = el.dataset.tag;
        if (state.tags.has(id)) state.tags.delete(id);
        else state.tags.add(id);
        paintTags();
      }),
    );
    $('[data-role=tag-add]').addEventListener('click', () => {
      togglePanel('tag', { focusFirst: '[data-role=tag-name]' });
    });
  };

  /* ---------------- ③ 就地新建标签 ---------------- */

  let newTagColor = TAG_COLORS[4];

  const paintTagColors = () => {
    $('[data-role=tag-colors]').innerHTML = TAG_COLORS.map(
      (c) => `
      <button class="swatch" type="button" role="radio" aria-checked="${c === newTagColor}"
              data-color="${esc(c)}" title="${esc(c)}" style="--swatch:${esc(c)}">
        <span class="swatch__fill"></span>
      </button>`,
    ).join('');
    $('[data-role=tag-colors]').querySelectorAll('[data-color]').forEach((el) =>
      el.addEventListener('click', () => {
        newTagColor = el.dataset.color;
        paintTagColors();
      }),
    );
  };

  const showTagError = (message) => {
    const el = $('[data-role=tag-err]');
    el.textContent = message ?? '';
    el.hidden = !message;
  };

  const resetTagCreator = () => {
    $('[data-role=tag-name]').value = '';
    newTagColor = TAG_COLORS[4];
    paintTagColors();
    showTagError('');
  };

  const createTag = async () => {
    const name = $('[data-role=tag-name]').value.trim();
    if (!name) {
      showTagError('标签名不能为空');
      $('[data-role=tag-name]').focus();
      return;
    }
    const btn = $('[data-role=tag-submit]');
    setLoading(btn, true, '创建中');
    showTagError('');
    try {
      const res = await Api.createTag(ledger.id, { name, color: newTagColor });
      const tag = res.data;
      activeTags.push(tag);
      state.tags.add(tag.id);
      paintTags();
      closePanels();
      resetTagCreator();
      toast(`已新建标签「${tag.name}」`, 'success');
    } catch (err) {
      // 同名冲突（409）等留在浮层内报错：改一个字就能重试，不该把输入丢掉
      showTagError(err?.message ?? '创建失败，请重试');
      $('[data-role=tag-name]').focus();
    } finally {
      setLoading(btn, false);
    }
  };

  const paintDateQuick = () => {
    const quick = [
      { label: '今天', value: todayStr() },
      { label: '昨天', value: yesterday(1) },
      { label: '前天', value: yesterday(2) },
    ];
    $('[data-role=date-quick]').innerHTML = quick
      .map(
        (q) => `
        <button class="option-chip" type="button" role="radio"
                aria-checked="${state.txDate === q.value}" data-date="${esc(q.value)}">
          ${esc(q.label)}
        </button>`,
      )
      .join('');
    $('[data-role=date-quick]').querySelectorAll('[data-date]').forEach((el) =>
      el.addEventListener('click', () => {
        state.txDate = el.dataset.date;
        $('[name=txDate]').value = state.txDate;
        paintDateQuick();
      }),
    );
  };

  /**
   * 字段显隐总表（docs/13 §4.3）—— 手续费/折扣的可用性随类型与阶段变化，
   * 该阶段不适用的输入框直接隐藏，而不是让用户填完再被拒（G6 的「选择器层拦截」哲学）。
   */
  /**
   * 手续费 / 折扣的显隐 —— **直接取 `lib/amounts.js` 的适用性矩阵**，不再自己判断。
   *
   * 这不是「顺手重构」：原来的写法是一串否定式硬编码
   * （`!(t==='payable' && d==='none')` 之类），新增 `write_off` 阶段时漏了一处，
   * 结果核销时手续费框还显示、后端却会 400 拒掉 —— 前端与后端两个信源各说各话。
   * 改成同源之后，这类漂移在结构上就不可能再发生。
   */
  const paintMoneyFields = () => {
    const feeOk = FEE_APPLICABLE[state.recordType]?.includes(state.direction) ?? false;
    const discountOk =
      DISCOUNT_APPLICABLE[state.recordType]?.includes(state.direction) ?? false;
    $('[data-role=fee-field]').hidden = !feeOk;
    $('[data-role=discount-field]').hidden = !discountOk;
    if (!feeOk) {
      state.fee = '';
      $('[name=fee]').value = '';
    }
    if (!discountOk) {
      state.discount = '';
      $('[data-role=discount-field] [name=discount]').value = '';
    }
    // 两个都不适用时整行收起：留一个空行会在「账户+金额」与预览之间多出一道 12px 的缝
    $('[data-role=fee-discount-row]').hidden = !feeOk && !discountOk;
  };

  /* ================================================================== *
   * 预览（本地双算 + 服务端校正）
   * ================================================================== */

  function localCompute() {
    const r = tryCalculateFromStrings({
      recordType: state.recordType,
      direction: state.direction,
      amount: state.amount,
      fee: state.fee,
      discount: state.discount,
    });
    localResult = r.ok ? r.result : null;
    return r;
  }

  /** 预览文案的着色：靠符号判断，不靠记类型（行内已写明「增加 / 减少」） */
  function toneOfLine(line) {
    if (line.includes('−')) return 'is-neg';
    if (line.includes('+')) return 'is-pos';
    return '';
  }

  function paintPreview(r) {
    const host = $('[data-role=preview]');
    if (!r.ok && r.silent) {
      host.dataset.hidden = 'true';
      host.innerHTML = '<p class="preview__line">填入金额后，这里会显示这笔账会怎么动账户</p>';
      return;
    }
    host.dataset.hidden = 'false';
    if (!r.ok) {
      host.innerHTML = `<p class="preview__line is-neg">${esc(r.message)}</p>`;
      return;
    }
    const lines = (remoteCorrection ?? r.result).previewLines.map(groupMoneyInText);
    host.innerHTML = lines
      .map((line, i) =>
        i === 0
          ? `<p class="preview__line preview__line--lead ${toneOfLine(line)}">${esc(line)}</p>`
          : `<p class="preview__line ${toneOfLine(line)}">${esc(line)}</p>`,
      )
      .join('');
    if (remoteCorrection) {
      host.insertAdjacentHTML(
        'beforeend',
        '<p class="preview__note">口径已由服务端校正</p>',
      );
    }
  }

  function paintSummary() {
    const key = `${state.recordType}:${state.direction}`;
    $('[data-role=sum-label]').textContent = SUMMARY_LABEL[key] ?? '本次金额';
    const cents = localResult?.actualAmount ?? 0;
    $('[data-role=sum-value]').textContent = money(cents / 100);
  }

  /** 本地即时预览：零防抖，打字即出（docs/13 §6.2） */
  function refreshMoney() {
    const r = localCompute();
    paintPreview(r);
    paintSummary();
    // 预览区直接标红的第 3 条校验：`A + F − D ≥ 0`
    const amountWrap = $('[data-field=amount]');
    const err = amountWrap.querySelector('.field__error');
    if (!r.ok && !r.silent) {
      err.textContent = r.message;
      $('[name=amount]').setAttribute('aria-invalid', 'true');
    } else {
      err.textContent = '';
      $('[name=amount]').removeAttribute('aria-invalid');
    }
  }

  /** 服务端校正：失焦 / 停顿 400ms / 提交前各一次 */
  async function correctFromServer() {
    const r = localCompute();
    if (!r.ok) return;
    try {
      const res = await Api.previewTransaction(ledger.id, {
        recordType: state.recordType,
        direction: state.direction,
        amount: formatCents(r.amountCents),
        fee: formatCents(r.feeCents),
        discount: formatCents(r.discountCents),
      });
      const d = res.data;
      const remote = {
        actualAmount: parseAmountToCents(d.actualAmount),
        accountDelta: parseAmountToCents(d.accountDelta),
        toAccountDelta: d.toAccountDelta === null ? null : parseAmountToCents(d.toAccountDelta),
        feeAccountDelta: d.feeAccountDelta === null ? null : parseAmountToCents(d.feeAccountDelta),
        previewLines: d.previewLines ?? [],
      };
      if (amountsMismatch(localResult, remote)) {
        reportAmountMismatch({
          recordType: state.recordType,
          direction: state.direction,
          local: localResult,
          remote,
        });
        remoteCorrection = remote;
      } else {
        remoteCorrection = null;
      }
      paintPreview(r);
    } catch (err) {
      // 校正失败不阻断录入：本地口径继续显示，提交时后端仍会强制重算
      console.warn('[preview 校正失败]', err?.message);
    }
  }

  const scheduleServerCorrect = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      correctFromServer();
    }, 400);
  };

  /* ================================================================== *
   * 字段读写 / 计数 / 错误
   * ================================================================== */

  const updateCounter = (field) => {
    const el = form.querySelector(`[data-count-for=${field}]`);
    if (!el) return;
    const max = field === 'note' ? LIMITS.NOTE_MAX_LEN : LIMITS.NAME_MAX_LEN;
    const len = [...String(state[field] ?? '')].length;
    el.textContent = `${len} / ${max}`;
    el.dataset.over = String(len > max);
  };

  const clearFieldError = (field) => {
    const wrap = form.querySelector(`[data-field="${CSS.escape(field)}"]`);
    wrap?.querySelector('.field__error')?.replaceChildren();
    wrap?.querySelector('.input')?.removeAttribute('aria-invalid');
    form.querySelector(`[data-error-for="${CSS.escape(field)}"]`)?.replaceChildren();
  };

  const collectFieldErrors = () => {
    const map = {};
    form.querySelectorAll('.field__error').forEach((el) => {
      if (el.textContent.trim()) {
        const key = el.closest('[data-field]')?.dataset.field ?? el.dataset.errorFor;
        if (key) map[key] = el.textContent.trim();
      }
    });
    const catErr = form.querySelector('[data-error-for=categoryId]')?.textContent.trim();
    if (catErr) map.categoryId = catErr;
    return map;
  };

  const setFieldError = (field, message) => {
    const wrap = form.querySelector(`[data-field="${CSS.escape(field)}"]`);
    const err =
      wrap?.querySelector('.field__error') ?? form.querySelector(`[data-error-for="${CSS.escape(field)}"]`);
    if (err) err.textContent = message;
    wrap?.querySelector('.input, .amount-input')?.setAttribute('aria-invalid', 'true');
  };

  /** 校验汇总条：≥3 个字段出错时出现，逐条可点跳（docs/13 §8） */
  const paintSummaryBar = () => {
    const map = collectFieldErrors();
    const keys = Object.keys(map);
    const bar = $('[data-role=summary]');
    if (keys.length < 3) {
      bar.dataset.visible = 'false';
      return;
    }
    bar.dataset.visible = 'true';
    $('[data-role=summary-title]').textContent = `有 ${keys.length} 处需要修改`;
    $('[data-role=summary-links]').innerHTML = keys
      .map((k) => `<button class="form-summary__link" type="button" data-goto="${esc(k)}">${esc(map[k])}</button>`)
      .join('');
    $('[data-role=summary-links]').querySelectorAll('[data-goto]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const wrap = form.querySelector(`[data-field="${CSS.escape(btn.dataset.goto)}"]`);
        const focusable = wrap?.querySelector('input, select, button');
        focusable?.focus();
        focusable?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }),
    );
  };

  const showBanner = (message, { action = null } = {}) => {
    $('[data-role=banner-msg]').textContent = message;
    const host = $('[data-role=banner-act]');
    host.replaceChildren();
    if (action) {
      const btn = h(`<button class="btn btn--danger btn--sm" type="button">${esc(action.label)}</button>`);
      btn.addEventListener('click', action.onClick);
      host.appendChild(btn);
    }
    $('[data-role=banner]').dataset.visible = 'true';
    $('[data-role=banner]').scrollIntoView({ block: 'nearest' });
  };

  const hideBanner = () => {
    $('[data-role=banner]').dataset.visible = 'false';
  };

  /**
   * 模板提示（`docs/05 §10.6`）：模板引用的分类被停用、账户被删时，
   * **照常预填**（规格明写「标注『分类已停用』并仍可用」），但把问题说清楚。
   * 所以这里只提示、不阻断 —— 阻断会让一个高频模板直接报废。
   */
  const showTemplateNote = (name, warnings) => {
    const host = $('[data-role=tpl-note]');
    if (!Array.isArray(warnings) || !warnings.length) {
      host.dataset.visible = 'false';
      return;
    }
    $('[data-role=tpl-note-title]').textContent = name
      ? `已按模板「${name}」预填`
      : '已按模板预填';
    $('[data-role=tpl-note-list]').innerHTML = warnings
      .map((w) => `<span class="form-note__item">${esc(w.message)}</span>`)
      .join('');
    host.dataset.visible = 'true';
  };

  /* ================================================================== *
   * 类型切换（字段保留策略：docs/13 §4.4）
   * ================================================================== */

  function setRecordType(next) {
    if (!next || next === state.recordType) return;
    const prev = state.recordType;
    // ① 分类「暂存并恢复」：切走时记住，切回时还原（避免误触类型丢输入）
    if (TYPE_WITH_CATEGORY.has(prev)) catStash.set(prev, state.categoryId);
    // ② 转入账户从「转账」切走时清空，切回时**不恢复**
    if (prev === 'transfer') state.toAccountId = null;

    state.recordType = next;
    // ③ 收付方向每次切换类型都重置为「产生」（结算低频且语义重，绝不做记忆）
    state.direction = DEFAULT_DIRECTION[next];
    // ④ 标签/金额/日期/名称/商家/对象/备注/附件与类型无关 → 全部保留
    //    分类恢复本类型上次的选择（stash），没有就空着
    state.categoryId = TYPE_WITH_CATEGORY.has(next) ? (catStash.get(next) ?? null) : null;
    // 结清关联只在结算/核销阶段成立，切到别的类型就作废
    state.settles = [];

    paintAll();
    refreshMoney();
    clearFieldError('categoryId');
    scheduleServerCorrect();
  }

  /**
   * 文本 / 金额类输入框的**回填**（state → DOM）。
   *
   * 新建模式 state 一开始就是空串，这一步从来「看不见」；编辑 / 复制模式
   * `createState` 把源账单预载进 state，若不回填就会出现「预览算得出 ¥30.00、
   * 输入框却是空的」的劈叉 —— 用户一保存就会把空金额提交上去（G6 会拦，
   * 但拦住的理由是「金额必填」而不是「你没改」，体验是错的）。
   *
   * 放进 `paintAll()` 里随类型切换一起重放是安全的：输入事件始终先把
   * `input.value` 写回 state，重放只会写入同一个值，不会打断正在打字的用户。
   * 手续费 / 折扣交由其后的 `paintMoneyFields()` 处置 —— 该阶段不适用的字段
   * 会被它清空并隐藏，所以这里先回填、它后清理，顺序不能反。
   */
  const paintTextFields = () => {
    for (const key of ['amount', 'name', 'merchant', 'counterparty', 'note', 'fee', 'discount']) {
      const input = form.querySelector(`[name=${key}]`);
      if (input && input.value !== state[key]) input.value = state[key] ?? '';
    }
  };

  const paintAll = () => {
    paintPickTrigger();
    paintDirection();
    paintAccounts();
    paintToAccounts();
    paintPickPanel();
    paintTextFields();
    paintMoneyFields();
    paintTags();
    paintDateQuick();
    paintSettleBlock();
    // 非输入类的字段变更（类型 / 分类 / 账户 / 方向 / 标签 / 日期快捷）都经过这里
    scheduleDraftSave();
  };

  /* ================================================================== *
   * 「结清哪一笔」（docs/12 §六 D9）
   *
   * 候选项来自 `GET /debts/settleable?recordType=` —— 只给**仍未结清**的产生笔。
   * 按 recordType 缓存：切来切去不会反复发请求。
   * ================================================================== */

  const settleableCache = new Map();

  async function loadSettleable(recordType) {
    if (settleableCache.has(recordType)) return settleableCache.get(recordType);
    let rows = [];
    try {
      rows = (await Api.listSettleable(ledger.id, recordType)).data ?? [];
    } catch {
      rows = [];
    }
    settleableCache.set(recordType, rows);
    return rows;
  }

  /** 结清 / 核销阶段：收回 · 还款 · 坏账核销 · 债务免除 */
  const isSettlePhase = () =>
    (state.recordType === 'receivable' || state.recordType === 'payable') &&
    (state.direction === 'increase' || state.direction === 'decrease' || state.direction === 'write_off');

  const paintSettleBlock = async () => {
    const block = $('[data-role=settle-block]');
    const show = isSettlePhase();
    block.hidden = !show;
    if (!show) return;
    const recordType = state.recordType;
    const rows = await loadSettleable(recordType);
    /**
     * `await` 之后表单可能已经被卸载（`go()` 跳走、路由切页），此时再写 DOM 就是
     * 往已脱离文档的节点上赋值 —— 无害但毫无意义；更糟的是 `sel` 为 null 时抛出的
     * **未捕获 Promise 拒绝**（`paintAll()` 不会 await 这个 async 函数），
     * 页面上表现为「结清哪一笔」永远是空的但看不出原因（真踩过）。
     */
    const sel = $('[data-role=settle-select]');
    const hint = $('[data-role=settle-hint]');
    const amtWrap = $('[data-field=settle-amount-wrap]');
    const amtInput = $('[data-role=settle-amount]');
    if (!block.isConnected || !sel || !hint) return;
    // 等待期间用户可能已经换过类型/阶段，候选项就不是同一个了
    if (state.recordType !== recordType || !isSettlePhase()) return;
    const current = state.settles[0]?.transactionId ?? '';
    const keep = rows.some((r) => r.transactionId === current) ? current : '';
    // 关联的那笔已经被别处结清了（候选集变了）→ 丢掉，不要留一个悬空引用
    if (current && !keep) state.settles = [];
    sel.innerHTML =
      `<option value="">不关联（记为一笔未归属冲销）</option>` +
      rows
        .map(
          (r) =>
            `<option value="${esc(r.transactionId)}"${keep === r.transactionId ? ' selected' : ''}>${
              esc(
                `${r.counterparty || r.name || '未命名'} · ${dayLabel(r.txDate)} · 还差 ${r.outstanding}`,
              )
            }</option>`,
        )
        .join('');
    const picked = rows.find((r) => r.transactionId === state.settles[0]?.transactionId);
    // 只有真的关联了某一笔，「关联金额」才有意义 —— 不关联时它是空气
    if (amtWrap) amtWrap.hidden = !picked;
    if (picked && amtInput && !amtInput.value && state.settles[0]) {
      amtInput.value = state.settles[0].amount;
    }
    if (amtInput) amtInput.max = picked ? picked.outstanding : '';
    hint.hidden = !picked;
    if (picked) {
      const linked = state.settles[0] ? parseAmountToCents(state.settles[0].amount) ?? 0 : 0;
      const rest = (parseAmountToCents(picked.outstanding) ?? 0) - linked;
      hint.textContent =
        rest > 0
          ? `这一笔还差 ${picked.outstanding}。在下面填本次冲抵多少就是「部分结清」；不选则计入未归属冲销。`
          : '本次已把这一笔全部冲抵。留空则一次结清。';
    }
  };

  $('[data-role=settle-select]')?.addEventListener('change', (e) => {
    const id = e.target.value;
    const rows = settleableCache.get(state.recordType) ?? [];
    if (!id) {
      state.settles = [];
    } else {
      const row = rows.find((r) => r.transactionId === id);
      if (row) {
        state.settles = [{ transactionId: id, amount: row.outstanding }];
        // 顺手把金额填上「还差多少」：结清的主场景就是一次还清；
        // 想部分结清的用户在下面的「本次冲抵」里改小即可
        if (!state.amount) {
          state.amount = row.outstanding;
          $('[name=amount]').value = row.outstanding;
          refreshMoney();
        }
      }
    }
    // 换一笔就清掉上一次填的冲抵金额 —— 留着就是上笔的金额，静默算错账
    const amtInput = $('[data-role=settle-amount]');
    if (amtInput) amtInput.value = state.settles[0]?.amount ?? '';
    paintSettleBlock();
    scheduleDraftSave();
  });

  /**
   * 「本次冲抵」金额输入。
   *
   * ## 为什么不用通用的 `[data-money]` 管道
   *
   * 通用管道会做 `state[input.name] = input.value` 并在每次输入后跑
   * `refreshMoney()` + `scheduleServerCorrect()`。这对「本笔金额」是对的，
   * 对「本次冲抵」全是错的：
   *   · 它会往 `state` 上挂一个**不参与账务**的字段（草稿/复制都会带上它）；
   *   · 它会触发一次 `POST /transactions/preview` —— 而 preview 的 schema
   *     **显式 omit 了 `settles`**（预览与结清无关），于是每次敲一个数字
   *     就白白发一个必然无用的请求。
   * 所以这里自己绑：清洗照抄（光标逻辑一样），但只更新 `settles[0].amount`。
   */
  $('[data-role=settle-amount]')?.addEventListener('input', (e) => {
    const input = e.target;
    const link = state.settles[0];
    // 输入期清洗（与主金额同一套规则，光标按数字个数回位）
    const raw = input.value;
    const clean = sanitizeAmountInput(raw);
    if (clean !== raw) {
      const pos = input.selectionStart ?? raw.length;
      const wanted = raw.slice(0, pos).replace(/[^\d.]/g, '').length;
      input.value = clean;
      let newPos = 0;
      let seen = 0;
      while (newPos < clean.length && seen < wanted) {
        newPos += 1;
        if (/[\d.]/.test(clean[newPos - 1])) seen += 1;
      }
      input.setSelectionRange(newPos, newPos);
    }
    if (!link) return;
    const cents = parseAmountToCents(input.value);
    if (cents === null) return; // 输入中途（如 "1."）不打断，交给失焦/提交时报错
    if (cents <= 0) {
      state.settles = [];
      paintSettleBlock();
      return;
    }
    link.amount = formatCents(cents);
    // 结清阶段：主金额跟随「本次冲抵」，二者口径一致（用户改小冲抵即部分结清）
    if (isSettlePhase()) {
      state.amount = link.amount;
      const amtEl = $('[name=amount]');
      if (amtEl) amtEl.value = link.amount;
      refreshMoney();
    }
    syncSettleAmount();
    scheduleDraftSave();
  });

  /** 失焦时规整格式（与主金额一致的时机：失焦才纠正，不在打字途中打断） */
  $('[data-role=settle-amount]')?.addEventListener('blur', (e) => {
    const link = state.settles[0];
    if (!link) return;
    const normalized = normalizeAmountInput(e.target.value);
    e.target.value = normalized;
    const cents = parseAmountToCents(normalized);
    if (cents !== null && cents > 0) {
      link.amount = formatCents(cents);
      syncSettleAmount();
    }
    paintSettleBlock();
  });

  /**
   * 把「本次冲抵」夹到两个上限之内：
   *   上限 A = 该笔剩余待结清（不能超额，超了后端会拒）
   *   上限 B = 本笔金额（Σ关联 ≤ 本笔金额，是台账口径的硬约束）
   *
   * 取 `min(A, B)`。**静默收敛**而不是报错：用户在「本次冲抵」里打 800，
   * 而本笔金额只有 500，这时把冲抵改成 500 是唯一合理解释
   * （他要么想全结、要么想部分结），报错只会让他猜该填哪个数。
   */
  function syncSettleAmount() {
    const link = state.settles[0];
    const amtInput = $('[data-role=settle-amount]');
    if (!link || !amtInput) return;
    const rows = settleableCache.get(state.recordType) ?? [];
    const row = rows.find((r) => r.transactionId === link.transactionId);
    const remain = row ? parseAmountToCents(row.outstanding) ?? 0 : Infinity;
    const txCents = parseAmountToCents(state.amount) ?? 0;
    /**
     * 结清阶段只关联一笔：主金额与本次冲抵互为镜像，二者本应相等。
     * 主金额变动（含部分结清）时让「本次冲抵」跟随，且不超过该笔剩余待结清，
     * 这样无论用户改的是「金额」还是「本次冲抵」，结清记录都反映实际录入值。
     */
    if (txCents > 0) {
      const synced = formatCents(Math.min(remain, txCents));
      if (synced !== link.amount) {
        link.amount = synced;
        amtInput.value = synced;
        clearFieldError('settles');
      }
    }
  }

  /* ================================================================== *
   * 本地草稿（docs/13 §10.1）
   *
   * `§10.1` 写的是「任一字段有值且**离开路由**时写入」。实现改成**防抖自动保存**
   * （500ms）：事件式要同时拦「返回键 / 取消键 / 侧栏跳转 / 浏览器后退 / 关标签页」
   * 五条出口，漏一条就是一次静默丢数据；防抖只要一个钩子，顺带覆盖了浏览器崩溃、
   * 断电这类根本没机会写的情况 —— 草稿的语义本来就是「随时可恢复」，不是「离开时快照」。
   *
   * 只在**建账**路径启用：
   *   · 编辑态的每个字段都对应一条已存在的账单，存草稿等于凭空造一笔改过的记录；
   *   · 「复制」（`?copyFrom=`）本身就是一个恢复机制，进页面就带着预填，
   *     让它去覆盖用户中断的那一笔是净损失。
   * ================================================================== */

  const draftOn = mode === 'create' && !copying;
  /** 提交成功 / 丢弃后置位：pending 的防抖不能再把草稿写回去 */
  let draftFrozen = false;
  let draftTimer = null;
  let pendingDraft = null;

  /** 「用户真的填过东西吗」—— 类型/方向/账户/日期/时间天生有值，不参与判定 */
  function draftContentNow() {
    return draftHasContent({
      fields: {
        categoryId: state.categoryId,
        amount: state.amount,
        fee: state.fee,
        discount: state.discount,
        name: state.name,
        merchant: state.merchant,
        counterparty: state.counterparty,
        note: state.note,
        tags: [...state.tags],
        settles: state.settles,
      },
    });
  }

  /** 展示快照：分类可能在 24 小时内被归档/删除，横幅文案不能跟着变空 */
  function draftSnap() {
    const c = currentCat();
    return { typeLabel: TYPE_META[state.recordType]?.label ?? '', categoryLabel: c?.name ?? '' };
  }

  function scheduleDraftSave() {
    if (!draftOn || draftFrozen) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      writeDraft({ ...state, ledgerId: ledger.id }, draftSnap(), draftContentNow());
    }, 500);
  }

  const hideDraft = () => {
    $('[data-role=draft]').dataset.visible = 'false';
  };

  /**
   * 把草稿灌回 state。**只接受当前数据里仍存在的 ID**，不存在的丢弃：
   * 账户被归档是 `paintAccounts` 会 pinned 处理的「软丢失」（仍可选、仍显示），
   * 而被删除的账户 / 分类 / 标签只能丢掉 —— 硬塞一个失效 ID，后端会 400，
   * 用户看到的是一句他完全无法理解的报错。
   */
  function applyDraft(draft) {
    const f = draft.fields ?? {};
    const rt = DEFAULT_DIRECTION[f.recordType] ? f.recordType : state.recordType;
    state.recordType = rt;
    state.direction = (DIRECTION_BY_RECORD_TYPE[rt] ?? []).includes(f.direction)
      ? f.direction
      : DEFAULT_DIRECTION[rt];
    state.accountId = realAccounts.some((a) => a.id === f.accountId)
      ? f.accountId
      : state.accountId;
    state.toAccountId = realAccounts.some((a) => a.id === f.toAccountId) ? f.toAccountId : null;
    state.categoryId = flatCats(rt).some((c) => c.id === f.categoryId) ? f.categoryId : null;
    for (const k of ['amount', 'fee', 'discount', 'name', 'merchant', 'counterparty', 'note']) {
      if (f[k] !== null && f[k] !== undefined && String(f[k]) !== '') state[k] = f[k];
    }
    for (const k of ['txDate', 'txTime']) {
      if (typeof f[k] === 'string' && f[k]) state[k] = f[k];
    }
    state.tags = new Set((f.tags ?? []).filter((id) => activeTags.some((t) => t.id === id)));
    state.settles = Array.isArray(f.settles)
      ? f.settles
          .filter((x) => x && typeof x.transactionId === 'string')
          .map((x) => ({ transactionId: x.transactionId, amount: String(x.amount ?? '') }))
      : [];
    if (state.categoryId) catStash.set(rt, state.categoryId);
  }

  // ---- 回访横幅 ----
  if (draftOn) {
    pendingDraft = readDraft(ledger.id);
    if (pendingDraft && draftHasContent(pendingDraft)) {
      $('[data-role=draft-msg]').textContent = `上次有一笔没记完${describeDraft(pendingDraft)}`;
      $('[data-role=draft]').dataset.visible = 'true';
    }
  }
  $('[data-role=draft-use]').addEventListener('click', () => {
    if (!pendingDraft) return;
    applyDraft(pendingDraft);
    pendingDraft = null;
    clearTimeout(draftTimer);
    draftFrozen = false;
    hideDraft();
    paintAll();
    refreshMoney();
    clearFieldError('categoryId');
    $('[name=amount]')?.focus({ preventScroll: true });
  });
  $('[data-role=draft-drop]').addEventListener('click', () => {
    clearDraft();
    pendingDraft = null;
    clearTimeout(draftTimer);
    draftFrozen = false;
    hideDraft();
  });

  // 关标签页 / 切后台时兜底一次（防抖窗口里就退出的话，上面那次还没来得及写）
  window.addEventListener('pagehide', () => {
    if (!draftOn || draftFrozen) return;
    writeDraft({ ...state, ledgerId: ledger.id }, draftSnap(), draftContentNow());
  });

  /* ================================================================== *
   * 事件接线
   * ================================================================== */

  // ---- 两个 Mega Menu 的开合 ----
  /**
   * 展开三级面板前先把草稿对齐到表单当前值 —— 用户上次点开面板看到一半就关掉的
   * 中间态（比如草稿停在「应收款项」而表单其实是「支出」）绝不能留到下一次。
   * 不自动聚焦搜索框：多数人是来「浏览」的，一开面板就弹键盘反而挡住了三列。
   */
  $('[data-role=pick-trigger]').addEventListener('click', () => {
    if (openKind === 'pick') {
      closePanels({ focus: true });
      return;
    }
    resetPickDraft();
    openPanel('pick');
    paintPickPanel();
  });
  $('[data-role=cat-search]').addEventListener('input', (e) => {
    catQuery = e.target.value;
    paintPickPanel();
  });
  $('[data-role=cat-clear]').addEventListener('click', () => {
    state.categoryId = null;
    catStash.set(state.recordType, null);
    paintAll();
    closePanels();
  });
  $('[data-role=scrim]').addEventListener('click', () => closePanels({ focus: true }));

  // ---- 新建标签浮层 ----
  paintTagColors();
  $('[data-role=tag-submit]').addEventListener('click', createTag);
  $('[data-role=tag-cancel]').addEventListener('click', () => {
    closePanels({ focus: true });
    resetTagCreator();
  });
  $('[data-role=tag-name]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createTag();
    }
  });

  // ---- 收起浮层：Esc / 点浮层之外 ----
  document.addEventListener('keydown', (e) => {
    if (!frame.isConnected) return;
    if (e.key === 'Escape' && openKind) {
      e.preventDefault();
      closePanels({ focus: true });
    }
  });
  document.addEventListener(
    'click',
    (e) => {
      if (!frame.isConnected || !openKind) return;
      if (!/** @type {Element} */ (e.target)?.closest?.('.mega-host')) closePanels();
    },
    true,
  );

  // ---- 金额类输入 ----
  /**
   * 输入期清洗：只保留「数字 + 一个点 + 两位小数」。
   * 光标按「已输入的数字个数」回位，避免在中间插入时跳到末尾。
   */
  form.querySelectorAll('[data-money]').forEach((input) => {
    input.addEventListener('input', () => {
      const raw = input.value;
      const clean = sanitizeAmountInput(raw);
      if (clean !== raw) {
        const pos = input.selectionStart ?? raw.length;
        const wanted = raw.slice(0, pos).replace(/[^\d.]/g, '').length;
        input.value = clean;
        let newPos = 0;
        let seen = 0;
        while (newPos < clean.length && seen < wanted) {
          newPos += 1;
          if (/[\d.]/.test(clean[newPos - 1])) seen += 1;
        }
        input.setSelectionRange(newPos, newPos);
      }
      state[input.name] = input.value;
      remoteCorrection = null;
      /**
       * 本笔金额变小 → 已填的「本次冲抵」跟着收敛。
       *
       * 不做的话，用户把「金额」从 500 改成 300 想部分结清，
       * 而冲抵仍是 500，提交时被「关联的结清金额不能超过本笔金额」拦下 ——
       * 而他**从没碰过**那个关联字段，报错会指向一个他不知道存在的输入框。
       */
      if (input.name === 'amount') syncSettleAmount();
      scheduleDraftSave();
      refreshMoney();
      scheduleServerCorrect();
    });
    input.addEventListener('blur', async () => {
      const normalized = normalizeAmountInput(input.value);
      input.value = normalized;
      state[input.name] = normalized;
      refreshMoney();
      await correctFromServer();
    });
  });

  // 金额框回车 = 收起键盘（不做提交，避免误触）
  $('[name=amount]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('[name=amount]').blur();
    }
  });

  /**
   * 金额类输入挂上 App 内计算器键盘（**仅紧凑形态**）。
   *
   * 为什么要它：系统数字键盘一次只能录入一个最终数值，而记账的高频动作是
   * 「38+6+12」这种连加；每次都先心算或切去计算器再切回来，是这个场景最大的摩擦。
   * 桌面端不挂 —— 实体键盘比任何自绘键盘都快，替换是倒退。
   *
   * 只给**三个**金额框挂，不给「本次冲抵」：后者有自己的一套联动
   * （主金额变小时它要跟着收敛、=0 时要撤掉关联），
   * 多一个浮层只会让结清这块更难推理，而它一次填一个数的频率本来就低。
   * 不需要拆监听器：记账页离开时整棵表单 DOM 被替换，监听器随元素回收。
   */
  for (const name of ['amount', 'fee', 'discount']) {
    attachAmountPad(form.querySelector(`[name=${name}]`));
  }

  // ---- 账户 ----
  $('[name=accountId]').addEventListener('change', (e) => {
    state.accountId = e.target.value;
    paintToAccounts(); // 转入账户要重新过滤掉新的主账户
    clearFieldError('accountId');
  });
  $('[name=toAccountId]').addEventListener('change', (e) => {
    state.toAccountId = e.target.value;
    clearFieldError('toAccountId');
  });

  // ---- 日期 ----
  $('[name=txDate]').addEventListener('change', (e) => {
    state.txDate = e.target.value;
    paintDateQuick();
    clearFieldError('txDate');
  });

  // ---- 文本字段 ----
  /**
   * 历史补全只覆盖这三个字段（docs/04 §8.11）。
   * 刻意**不含备注**：后端 `/suggest/:field` 只接受 name/merchant/counterparty，
   * 备注既没有 `<datalist>` 也没有可补全的取值集合 —— 早先把 note 也塞进下面这个
   * 列表，结果每次聚焦备注框都白拿一个 404，数据回来还无处可放（探针抓到）。
   */
  const SUGGEST_FIELDS = new Set(['name', 'merchant', 'counterparty']);
  ['name', 'merchant', 'counterparty', 'note'].forEach((field) => {
    const el = form.querySelector(`[name=${field}]`);
    el.addEventListener('input', () => {
      state[field] = el.value;
      updateCounter(field);
      clearFieldError(field);
    });
    // 历史补全：首次聚焦时拉一次
    el.addEventListener('focus', async () => {
      if (!SUGGEST_FIELDS.has(field)) return;
      if (el.dataset.suggested) return;
      el.dataset.suggested = '1';
      try {
        const res = await Api.suggestField(ledger.id, field, undefined, 20);
        const dl = form.querySelector(`#tx-suggest-${field}`);
        if (dl) {
          dl.innerHTML = (res.data ?? [])
            .map((s) => `<option value="${esc(s.value)}"></option>`)
            .join('');
        }
      } catch {
        /* 补全失败不影响录入 */
      }
    });
  });

  // ---- 时间 ----
  $('[name=txTime]').addEventListener('input', (e) => {
    state.txTime = e.target.value;
  });
  $('[data-role=clear-time]').addEventListener('click', () => {
    state.txTime = '';
    $('[name=txTime]').value = '';
    toast('时间已清空，同日排序按录入先后');
  });

  // ---- 分类面板开合已由上面的 Mega Menu 控制器接管 ----

  // ---- 取消 ----
  $('[data-role=cancel]').addEventListener('click', () => {
    if (mode === 'edit') {
      go('/transactions');
      return;
    }
    go(sourcePage());
  });

  /* ================================================================== *
   * 提交
   * ================================================================== */

  /** 本地校验：只查「不查库就能查的」，跨表约束交给后端（G6 的矩阵） */
  function validateLocally() {
    form.querySelectorAll('.field__error').forEach((el) => el.replaceChildren());
    form.querySelectorAll('.input, .amount-input').forEach((el) => el.removeAttribute('aria-invalid'));
    form.querySelector('[data-error-for=categoryId]')?.replaceChildren();

    const amountCents = parseAmountToCents(state.amount);
    if (amountCents === null || amountCents <= 0) {
      setFieldError('amount', state.amount ? '金额必须大于 0' : '请填写金额');
      return { field: 'amount' };
    }
    const r = localCompute();
    if (!r.ok) {
      setFieldError(r.field, r.message);
      return { field: r.field };
    }
    if (TYPE_WITH_CATEGORY.has(state.recordType) && flatCats(state.recordType).length > 0 && !state.categoryId) {
      const err = form.querySelector('[data-error-for=categoryId]');
      if (err) err.textContent = '请选择分类';
      return { field: 'categoryId' };
    }
    /**
     * 结清关联的两条本地闸（后端也会再校验一遍，这里是为了**即时反馈**）。
     *
     * ① `本次冲抵 ≤ 该笔剩余待结清`：超过就是「还的比欠的多」，语义上凭空负债。
     * ② `Σ关联 ≤ 本笔金额`：多关联的那部分在台账上没有依据。
     *
     * ⚠️ 文案必须写清**该改哪个字段**。早先统一写「把金额改小」，
     *    而「金额」指的是本笔金额 —— 用户改小它并不能让 ① 通过
     *    （该改的是「本次冲抵」），于是反复试错。
     */
    if (state.settles.length) {
      const sumCents = state.settles.reduce((s, x) => s + (parseAmountToCents(x.amount) ?? 0), 0);
      if (sumCents > amountCents) {
        setFieldError(
          'settles',
          `本次冲抵 ${formatCents(sumCents)} 超过本笔金额 ${formatCents(amountCents)}。` +
            '请把「本次冲抵」改到不超过本笔金额。',
        );
        return { field: 'settles' };
      }
      const rows = settleableCache.get(state.recordType) ?? [];
      for (const link of state.settles) {
        const row = rows.find((r) => r.transactionId === link.transactionId);
        if (!row) continue;
        const remainCents = parseAmountToCents(row.outstanding) ?? 0;
        const linkCents = parseAmountToCents(link.amount) ?? 0;
        if (linkCents > remainCents) {
          setFieldError(
            'settles',
            `「${row.counterparty || row.name || '那笔'}」只剩 ${row.outstanding} 未结清，` +
              `本次冲抵不能超过它。`,
          );
          return { field: 'settles' };
        }
      }
    }
    if (!state.accountId) {
      setFieldError('accountId', '请选择账户');
      return { field: 'accountId' };
    }
    if (TYPE_WITH_TO_ACCOUNT.has(state.recordType)) {
      if (!state.toAccountId) {
        setFieldError('toAccountId', '转账必须选择转入账户');
        return { field: 'toAccountId' };
      }
      if (state.toAccountId === state.accountId) {
        setFieldError('toAccountId', '转入账户不能与转出账户相同');
        return { field: 'toAccountId' };
      }
    }
    if (!state.txDate) {
      setFieldError('txDate', '请选择日期');
      return { field: 'txDate' };
    }
    return null;
  }

  const buildPayload = () => {
    const feeCents = parseAmountToCents(state.fee) ?? 0;
    const discountCents = parseAmountToCents(state.discount) ?? 0;
    /**
     * 结清 / 核销阶段：本笔金额必须以「实际冲抵之和」为准（docs/12 §六 D9 修正）。
     * 种子把主金额带成「还差多少」，用户改小「本次冲抵」做部分结清时，若主金额仍停在
     * 应结清值，账单 / 详情页会把这笔结算记成原应结清金额，与结清记录（取关联金额）对不上。
     * 这里在提交前把主金额收敛到关联金额之和，与后端 `settles` 里的实际录入值保持单一口径。
     */
    const sumLinkCents = state.settles.reduce(
      (s, x) => s + (parseAmountToCents(x.amount) ?? 0),
      0,
    );
    const settlePhase = isSettlePhase() && state.settles.length > 0;
    const amountCents = settlePhase ? sumLinkCents : parseAmountToCents(state.amount) ?? 0;
    return {
      recordType: state.recordType,
      direction: state.direction,
      accountId: state.accountId,
      ...(TYPE_WITH_TO_ACCOUNT.has(state.recordType) ? { toAccountId: state.toAccountId } : {}),
      ...(TYPE_WITH_CATEGORY.has(state.recordType) && state.categoryId
        ? { categoryId: state.categoryId }
        : {}),
      amount: formatCents(amountCents),
      // 手续费/折扣只在适用阶段出现；不适用的阶段显式送 0（用户可能是从适用的阶段改过来的）
      fee: formatCents(feeCents),
      discount: formatCents(discountCents),
      name: state.name.trim() || null,
      merchant: state.merchant.trim() || null,
      counterparty: state.counterparty.trim() || null,
      note: state.note.trim() || null,
      tags: [...state.tags],
      txDate: state.txDate,
      txTime: state.txTime || null,
      /**
       * 结清关联（docs/12 §六 D9）。只在结算 / 核销阶段送，且金额必须是**元字符串**
       * （API 层十进制、内部整数分 —— 与 amount 同一约定）。
       * 编辑态也带上：后端按「整笔重写」处理，传空数组就等于解除了全部关联。
       */
      ...(state.settles.length
        ? {
            settles: state.settles.map((s) => ({
              transactionId: s.transactionId,
              amount: formatCents(parseAmountToCents(s.amount) ?? 0),
            })),
          }
        : mode === 'edit'
          ? { settles: [] }
          : {}),
      // 幂等键只对「创建」有意义；编辑带上它会误导后端把一次修改当成一次新提交
      ...(mode === 'edit'
        ? { expectedUpdatedAt: sourceTx?.updatedAt ?? null }
        : { clientRequestId: uuid() }),
    };
  };

  /* ---------------- 凭证附件（记账页暂存 -> 保存后上传） ---------------- */
  /**
   * 记账页在创建时没有账单 id，无法立即上传。这里把选中的文件**暂存**在内存里，
   * 等账单创建 / 更新成功拿到 id 后，再在提交流程里逐个上传（见 submit 成功分支）。
   * 编辑态同样复用这套暂存：保存时按 `tx.id` 上传即可。
   */
  const stagedFiles = [];
  const attachInput = form.querySelector('[data-role=attach-input]');
  const attachList = form.querySelector('[data-role=attach-list]');
  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  function paintStaged() {
    if (!attachList) return;
    attachList.replaceChildren();
    if (!stagedFiles.length) {
      const empty = document.createElement('p');
      empty.className = 'tt-caption text-muted';
      empty.textContent = '没有附件。发票、合同、截图都可以附在这笔账上。';
      attachList.appendChild(empty);
      return;
    }
    stagedFiles.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'recon-line';
      const iconEl = document.createElement('span');
      iconEl.className = 'txd__fileicon';
      iconEl.innerHTML = lucide('file-text', 16);
      const nameEl = document.createElement('span');
      nameEl.className = 'tt-caption';
      nameEl.textContent = s.name;
      const sizeEl = document.createElement('span');
      sizeEl.className = 'tt-fine-print text-muted';
      sizeEl.textContent = formatFileSize(s.size);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--quiet btn--sm';
      btn.textContent = '移除';
      btn.addEventListener('click', () => {
        stagedFiles.splice(i, 1);
        paintStaged();
      });
      row.append(iconEl, nameEl, sizeEl, btn);
      attachList.appendChild(row);
    });
  }
  attachInput?.addEventListener('change', () => {
    for (const file of Array.from(attachInput.files ?? [])) {
      stagedFiles.push({ file, name: file.name, size: file.size });
    }
    attachInput.value = '';
    paintStaged();
  });
  paintStaged();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideBanner();
    const bad = validateLocally();
    paintSummaryBar();
    if (bad) {
      const wrap = form.querySelector(`[data-field="${CSS.escape(bad.field)}"]`);
      (wrap?.querySelector('input, select') ?? wrap)?.focus();
      wrap?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    const submit = $('[data-role=submit]');
    setLoading(submit, true, '保存中');
    try {
      // 提交前最后一次服务端校正（双算的第三道时机）
      await correctFromServer();

      /**
       * 记账形态分派（任务 5）。
       *
       * ## 为什么周期/分期**不**走 `POST /transactions`
       *
       * 两者都不是「多记一笔账」，而是「记一笔 + 建一条规则」：
       *   · 周期：`POST /recurring-rules` 建规则。规则**自己**在到日子时生成账单，
       *     如果这里先记一笔、规则再记一笔，用户会被扣两次钱。
       *   · 分期：`POST /installment-plans` **在服务端**一次性完成「记全额支出 + 建还款计划」。
       *     前端若先 `POST /transactions` 再建计划，就成了两次请求 ——
       *     中间失败会留下一笔**没有计划的支出**（用户以为在分期，实际是一笔整付）。
       *
       * 所以：**单次**才建账单，周期/分期交给各自的后端入口，
       * 它们内部保证原子性。这也让「保存」按钮的行为与用户的心智模型一致。
       *
       * ## 失败处理
       * 统一走 `handleSubmitError`：两个后端接口的错误结构相同（都是
       * `{ error: { message, details[] } }`），所以字段级报错能同样定位到表单上。
       */
      if (mode === 'create' && planPayload) {
        if (planPayload.kind === 'recurring') {
          const payload = {
            name: buildPayload().name || `${RECORD_TYPE_LABEL[state.recordType] ?? '记账'}周期`,
            recordType: state.recordType,
            accountId: buildPayload().accountId,
            toAccountId: buildPayload().toAccountId ?? undefined,
            categoryId: buildPayload().categoryId ?? null,
            merchant: state.merchant.trim() || null,
            counterparty: state.counterparty.trim() || null,
            note: state.note.trim() || null,
            amount: buildPayload().amount,
            fee: buildPayload().fee,
            discount: buildPayload().discount,
            startDate: buildPayload().txDate,
            frequency: planPayload.frequency,
            intervalCount: planPayload.intervalCount,
            dayOfMonth: planPayload.dayOfMonth,
            weekDay: planPayload.weekDay,
            endDate: planPayload.endDate ?? null,
            generateAheadDays: planPayload.generateAheadDays,
          };
          await Api.createRecurringRule(ledger.id, payload);
          setLoading(submit, false);
          draftFrozen = true;
          clearTimeout(draftTimer);
          clearDraft();
          closePlanModal();
          toast('周期规则已创建，到日子会自动记账', 'success');
          go('/recurring');
          return;
        }

        const base = buildPayload();
        const payload = {
          title: base.name || `${RECORD_TYPE_LABEL[state.recordType] ?? ''}分期`.trim() || '分期计划',
          totalAmount: base.amount,
          totalFee: undefined,
          perPeriodFee: undefined,
          feeMode: planPayload.feeMode,
          feeHandling: planPayload.feeHandling,
          installmentCount: planPayload.installmentCount,
          frequency: planPayload.frequency,
          firstDate: base.txDate,
          accountId: planPayload.debtAccountId || base.accountId,
          debtAccountId: planPayload.debtAccountId || base.accountId,
          recordType: state.recordType,
          categoryId: base.categoryId ?? null,
          merchant: state.merchant.trim() || null,
          note: state.note.trim() || null,
        };
        if (planPayload.feeMode === 'per_period') payload.perPeriodFee = planPayload.perPeriodFee;
        else payload.totalFee = planPayload.totalFee;
        await Api.createInstallmentPlan(ledger.id, payload);
        setLoading(submit, false);
        draftFrozen = true;
        clearTimeout(draftTimer);
        clearDraft();
        closePlanModal();
        toast(`分期计划已创建，并已记一笔全额支出 ${base.amount}`, 'success');
        go('/installments');
        return;
      }

      const res =
        mode === 'edit'
          ? await Api.updateTransaction(ledger.id, sourceTx.id, buildPayload())
          : await Api.createTransaction(ledger.id, buildPayload());
      const tx = res.data;
      // 记账页附件：拿到账单 id 后把暂存的文件逐个上传（在跳走之前完成）
      if (stagedFiles.length && tx?.id) {
        try {
          for (const s of stagedFiles) {
            await Api.uploadAttachment(ledger.id, tx.id, s.file);
          }
          toast(`已上传 ${stagedFiles.length} 个附件`, 'success');
          stagedFiles.length = 0;
          paintStaged();
        } catch (e) {
          toast(`部分附件上传失败：${e.message ?? '未知错误'}`, 'error');
        }
      }
      setLoading(submit, false);
      // 冻结并清掉草稿：pending 的防抖不能把刚记完的这一笔又写回草稿箱
      draftFrozen = true;
      clearTimeout(draftTimer);
      clearDraft();
      if (mode === 'edit') onEdited(tx, { go });
      else onSaved(tx, { go, ledger, state, summarize: summarizeOf(tx) });
    } catch (err) {
      setLoading(submit, false);
      handleSubmitError(err);
    }
  });

  /** 失败路径（docs/13 §7.5）：留在记账页、保留全部输入，且给出下一步动作 */
  function handleSubmitError(err) {
    const code = err?.code ?? '';
    if (err?.details?.length) {
      applyFieldErrors(form, err.fieldErrors ?? {});
      paintSummaryBar();
    }
    if (code === 'PERIOD_CLOSED' || /结账/.test(err?.message ?? '')) {
      showBanner(`${state.txDate.slice(0, 7)} 已结账，无法记入该日期。改个日期，或先去解除结账。`);
      return;
    }
    if (code === 'CONFLICT') {
      showBanner(err.message ?? '该账单已被他人修改');
      return;
    }
    if (err?.status === 0 || /Failed to fetch|NetworkError/i.test(err?.message ?? '')) {
      showBanner('网络不可用，已保留你填的内容。恢复网络后重新保存即可。');
      return;
    }
    // 其它 400：字段级错误已就地标出；没有 details 的才用横幅兜底
    if (!err?.details?.length) showBanner(err?.message ?? '保存失败，请稍后重试');
    else showBanner(`有 ${err.details.length} 处需要修改，已在表单中标出`);
  }

  /* ================================================================== *
   * 初始化
   * ================================================================== */

  $('[name=txDate]').value = state.txDate;
  $('[name=txTime]').value = state.txTime;
  paintAll();
  refreshMoney();

  // 模板预填的收尾：说清失效引用 + 金额建议值聚焦全选（docs/05 §10.2 / §10.6）
  const tplHint = state.templateHint;
  if (tplHint) {
    showTemplateNote(tplHint.name, tplHint.warnings);
    $('[data-role=tpl-note-x]').addEventListener('click', () => {
      $('[data-role=tpl-note]').dataset.visible = 'false';
    });
    requestAnimationFrame(() => {
      const amt = $('[name=amount]');
      if (!amt) return;
      amt.focus({ preventScroll: true });
      // 全选：预置模板的建议金额多半要改，一打字就替换，不用先手动清空
      if (state.amount) amt.select();
    });
  } else {
    // 首次进入不必请求校正（金额还没填）
    requestAnimationFrame(() => $('[name=amount]')?.focus({ preventScroll: true }));
  }
}

/* ================================================================== *
 * 保存之后（docs/13 §7）
 * ================================================================== */

/**
 * 「来源页」：没有来源时回落（docs/13 §7.2）。
 *
 * 步骤 8（列表页 `/transactions`）已交付，这里按 §7.2 收口 ——
 * 之前临时指向 `/`（概览）只是为了避免落到不存在的路由触发兜底跳转。
 */
function sourcePage() {
  return composeSource('/transactions');
}

function summarizeOf(tx) {
  const cat = tx.category ? (tx.category.parent ? `${tx.category.parent.name}·${tx.category.name}` : tx.category.name) : null;
  const label = cat ?? tx.name ?? RECORD_TYPE_LABEL[tx.recordType] ?? '';
  const amount = tx.recordType === 'payable' && tx.direction === 'none' ? tx.amount : tx.actualAmount;
  return { label, amount, text: `${money(Number(amount))}${label ? ` · ${label}` : ''}` };
}

/**
 * 提交成功后的统一行为（docs/13 §7.1）：
 *   关闭记账页 → 回来源页 → Toast 5 秒：已记 ¥30.00 · 餐饮·午餐　[再记一笔][撤销]
 * 「再记一笔」的保留/清空清单是 §7.3 定的，**分类清空是有意的**：
 * 连续记的通常是不同类别（午饭 → 打车 → 咖啡），但账户几乎不变。
 */
function onSaved(tx, { go, ledger, state, summarize }) {
  const kind = tx.recordType === 'payable' && tx.direction === 'none' ? '登记' : '已记';
  go(sourcePage());

  actionToast(`${kind} ${summarize.text}`, [
    {
      label: '再记一笔',
      primary: true,
      onClick: () => {
        // 保留：类型、账户、日期、收付方向、标签
        const next = {
          recordType: tx.recordType,
          direction: tx.direction,
          accountId: tx.account?.id ?? state.accountId,
          txDate: tx.txDate,
          tags: (tx.tags ?? []).map((t) => t.id),
        };
        try {
          sessionStorage.setItem(SEED_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        go('/transactions/new');
      },
    },
    {
      label: '撤销',
      onClick: async () => {
        try {
          await Api.deleteTransaction(tx.ledgerId ?? ledger.id, tx.id);
          toast('已撤销，余额已回滚', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
  ]);
}

/**
 * 编辑保存后的行为（与新建**刻意不同**）：
 *   · 不出现「再记一笔」—— 编辑不是连续录入的场景；
 *   · 不出现「撤销」—— 修改前的内容后端不保留快照，给一个假的撤销入口只会误导；
 *   · 落回账单列表（`§7.2` 的统一落点），让用户立刻在列表里看到改完的样子。
 */
function onEdited(tx, { go }) {
  toast(`已保存修改 · ${summarizeOf(tx).text}`, 'success');
  go('/transactions');
}
