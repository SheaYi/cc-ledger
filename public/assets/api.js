/**
 * API 客户端（对齐 docs/04 §1.1 响应包装与 §1.5 错误码）
 * - 自动附加 Bearer access token
 * - 命中 401 时自动用 refresh token 换新令牌并重放一次请求
 * - 所有动态路径参数一律 encodeURIComponent
 *   ⚠️ 预置数据的主键是复合 ID（形如 `ldg_xxx#acc_sys_receivable`），
 *      其中 `#` 在 URL 里是片段分隔符，不编码会被服务端截断导致 404。
 */
import { auth, device } from './store.js';

const BASE = '/api/v1';

/** 路径段编码：任何来自服务端的 ID 进 URL 前都要过这一层 */
const seg = (v) => encodeURIComponent(String(v ?? ''));

/** 查询串：剔除 undefined / null */
function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export class ApiError extends Error {
  constructor({ code, message, details, status }) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.code = code || 'INTERNAL_ERROR';
    this.details = details || [];
    this.status = status;
  }
  /** 字段级错误 → { field: message } */
  get fieldErrors() {
    const map = {};
    for (const d of this.details) if (d?.field) map[d.field] = d.message;
    return map;
  }
}

let refreshing = null;

async function doRefresh() {
  const rt = auth.refreshToken;
  if (!rt) return false;
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const json = await res.json();
        auth.save(json.data);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/**
 * 单请求超时（毫秒）。
 *
 * ⚠️ 这一层**必须有**。keep-alive 连接偶发失效时（服务端刚好在客户端复用前
 * 关掉那条连接），`fetch` 的 Promise 既不 resolve 也不 reject ——
 * 界面就无限期转圈，用户既看不到结果也看不到任何错误提示。
 * 实测过：本地 127.0.0.1 也能复现（连跑多轮导入时偶发），
 * 所以这不是「网络差的环境才会遇到」，而是必须默认打开的护栏。
 *
 * 30 秒对一次导入 20000 行来说偏短 —— 导入用的是 `commitImport`，
 * 它显式传了 `timeoutMs: 180000`。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

async function request(
  method,
  path,
  /**
   * @param {object}   [opts.raw] 返回**原始文本**而不是 JSON。
   *   只有 CSV 导出（S-13）需要它：报表导出本来就不是 JSON 接口，
   *   而让调用方自己再 fetch 一遍会重复实现鉴权、刷新与超时三件事。
   */
  { body, form, raw = false, auth: withAuth = true, retry = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const headers = {};
  if (withAuth && auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;

  let payload;
  if (form) {
    payload = form; // FormData：不设置 Content-Type，交给浏览器带 boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    payload = JSON.stringify(body);
  }

  /**
   * 超时用 `AbortController` 而不是 `Promise.race([fetch, timeout])`：
   * 后者只是让调用方不再等待，**底层连接并没有被断开** ——
   * 请求仍在跑、仍在占着服务端资源与连接槽。大量超时之后连接池会被
   * 这些「已经没人要的结果」占满，然后所有新请求一起变慢。
   */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: payload, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new ApiError({
        code: 'TIMEOUT',
        message: `请求超时（${Math.round(timeoutMs / 1000)} 秒无响应），请检查网络后重试`,
        status: 0,
      });
    }
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: '网络异常，请检查连接后重试',
      status: 0,
    });
  }
  clearTimeout(timer);

  if (res.status === 401 && withAuth && retry) {
    const refreshed = await doRefresh();
    if (refreshed) return request(method, path, { body, form, auth: withAuth, retry: false, timeoutMs });
    auth.clear();
  }

  if (res.status === 204) return null;

  const text = await res.text();
  if (raw) {
    if (!res.ok) throw new ApiError({ code: 'EXPORT_FAILED', message: '导出失败', status: res.status });
    return text;
  }

  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError({
      code: err.code,
      message: err.message,
      details: err.details,
      status: res.status,
    });
  }
  return json;
}

export const Api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { ...o, body }),
  patch: (p, body, o) => request('PATCH', p, { ...o, body }),
  del: (p, o) => request('DELETE', p, o),
  upload: (p, form) => request('POST', p, { form }),

  // ---- 认证 ----
  register: (payload) =>
    request('POST', '/auth/register', { body: { ...payload, platform: device.platform }, auth: false }),
  login: (payload) =>
    request('POST', '/auth/login', { body: { ...payload, platform: device.platform }, auth: false }),
  logout: (payload = {}) => request('POST', '/auth/logout', { body: payload }),

  // ---- 用户 ----
  me: () => request('GET', '/users/me'),
  updateProfile: (patch) => request('PATCH', '/users/me', { body: patch }),
  changePassword: (payload) => request('PATCH', '/users/me/password', { body: payload }),
  setCurrentLedger: (ledgerId) =>
    request('POST', '/users/me/current-ledger', { body: { ledgerId } }),

  // ---- 账本 ----
  listLedgers: (includeArchived = false) =>
    request('GET', `/ledgers${qs({ includeArchived })}`),
  createLedger: (payload) => request('POST', '/ledgers', { body: payload }),
  getLedger: (id) => request('GET', `/ledgers/${seg(id)}`),
  archiveLedger: (id) => request('DELETE', `/ledgers/${seg(id)}`),
  listMembers: (id) => request('GET', `/ledgers/${seg(id)}/members`),
  createInvitation: (id, payload) =>
    request('POST', `/ledgers/${seg(id)}/invitations`, { body: payload }),
  previewInvitation: (code) => request('GET', `/invitations/${seg(code)}`, { auth: false }),
  redeemInvitation: (code) => request('POST', `/invitations/${seg(code)}/redeem`),
  updateLedger: (id, patch) => request('PATCH', `/ledgers/${seg(id)}`, { body: patch }),
  /** 删除影响预览：确认弹窗要显示会带走多少账目 / 成员 */
  ledgerDeletionImpact: (id) =>
    request('GET', `/ledgers/${seg(id)}/deletion-impact`),
  /** 物理删除账本（级联，不可恢复） */
  purgeLedger: (id) => request('POST', `/ledgers/${seg(id)}/purge`),

  // ---- 账户分组 ----
  listAccountGroups: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/account-groups${qs(query)}`),
  createAccountGroup: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/account-groups`, { body: payload }),
  updateAccountGroup: (ledgerId, groupId, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/account-groups/${seg(groupId)}`, { body: payload }),
  /** 删除：返回 { mode: 'removed' | 'archived', accountCount } */
  deleteAccountGroup: (ledgerId, groupId) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/account-groups/${seg(groupId)}`),
  restoreAccountGroup: (ledgerId, groupId) =>
    request('POST', `/ledgers/${seg(ledgerId)}/account-groups/${seg(groupId)}/restore`),
  reorderAccountGroups: (ledgerId, ids) =>
    request('POST', `/ledgers/${seg(ledgerId)}/account-groups/reorder`, { body: { ids } }),

  // ---- 账户 ----
  accountSummary: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/accounts/summary`),
  listAccounts: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/accounts${qs(query)}`),
  createAccount: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/accounts`, { body: payload }),
  getAccount: (ledgerId, accountId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}`),
  accountBalance: (ledgerId, accountId, date) =>
    request('GET', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/balance${qs({ date })}`),
  updateAccount: (ledgerId, accountId, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}`, { body: payload }),
  archiveAccount: (ledgerId, accountId) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}`),
  reorderAccounts: (ledgerId, ids) =>
    request('POST', `/ledgers/${seg(ledgerId)}/accounts/reorder`, { body: { ids } }),

  // ---- 分类 ----
  listCategories: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/categories${qs(query)}`),
  createCategory: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/categories`, { body: payload }),
  updateCategory: (ledgerId, categoryId, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/categories/${seg(categoryId)}`, { body: payload }),
  deleteCategory: (ledgerId, categoryId) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/categories/${seg(categoryId)}`),
  restoreCategory: (ledgerId, categoryId) =>
    request('POST', `/ledgers/${seg(ledgerId)}/categories/${seg(categoryId)}/restore`),

  // ---- 标签 ----
  listTags: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/tags${qs(query)}`),
  createTag: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/tags`, { body: payload }),
  updateTag: (ledgerId, tagId, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/tags/${seg(tagId)}`, { body: payload }),
  deleteTag: (ledgerId, tagId) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/tags/${seg(tagId)}`),

  // ---- 账单（docs/04 §八） ----
  /** 表单初始态：{recordType, direction, accountId, lastUsedAt, txDate, txTime, hasAccounts} */
  txNewDefaults: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions/new-defaults`),
  /** 字段历史补全：field = merchant | counterparty | name */
  suggestField: (ledgerId, field, keyword, limit) =>
    request('GET', `/ledgers/${seg(ledgerId)}/suggest/${seg(field)}${qs({ keyword, limit })}`),

  // ---- 模板（docs/04 §九 / docs/05 §十）----
  /** 模板列表。payload 已解析成「可直接喂给记账表单」的形态，warnings 说明失效引用 */
  listTemplates: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/templates${qs(query)}`),
  getTemplate: (ledgerId, id) => request('GET', `/ledgers/${seg(ledgerId)}/templates/${seg(id)}`),
  createTemplate: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/templates`, { body: payload }),
  updateTemplate: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/templates/${seg(id)}`, { body: payload }),
  deleteTemplate: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/templates/${seg(id)}`),
  /** 使用模板：计数 +1，返回带预填 payload 的模板 */
  useTemplate: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/templates/${seg(id)}/use`),
  reorderTemplates: (ledgerId, ids) =>
    request('POST', `/ledgers/${seg(ledgerId)}/templates/reorder`, { body: { ids } }),
  /** 从一笔已存在的账单存为模板（金额只作建议值，不固化） */
  saveAsTemplate: (ledgerId, txId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/${seg(txId)}/save-as-template`, {
      body: payload,
    }),

  // ---- 周期账单（docs/04 §十 / docs/05 §11）----
  /** 周期规则列表。每条自带 nextDueDate（尚未到期的那一期）与 warnings */
  listRecurringRules: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/recurring-rules${qs(query)}`),
  getRecurringRule: (ledgerId, id) =>
    request('GET', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}`),
  createRecurringRule: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recurring-rules`, { body: payload }),
  updateRecurringRule: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}`, { body: payload }),
  deleteRecurringRule: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}`),
  pauseRecurringRule: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/pause`),
  resumeRecurringRule: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/resume`),
  /** 预览未来 N 期。响应即 docs/04 §十 的形状：[{seq,dueDate,amount,status}] */
  previewRecurringRule: (ledgerId, id, count = 5) =>
    request('GET', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/preview${qs({ count })}`),
  /** 立即生成一期（只出下一期，不补历史） */
  runRecurringRuleNow: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/run-now`),
  /** 已生成的账单列表（按 recurring_rule_id 溯源查） */
  generatedByRecurringRule: (ledgerId, id, limit = 50) =>
    request('GET', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/generated${qs({ limit })}`),
  /** 跳过单期（docs/05 §11.3）：某期不生成，例如春节那期 */
  skipRecurringDate: (ledgerId, id, dueDate) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/skip`, {
      body: { dueDate },
    }),
  unskipRecurringDate: (ledgerId, id, dueDate) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/recurring-rules/${seg(id)}/skip/${seg(dueDate)}`),
  /** 服务端校正计算（只传金额相关字段，doc 13 §6.2 的双算） */
  previewTransaction: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/preview`, { body: payload }),
  listTransactions: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions${qs(query)}`),
  dailyTotals: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions/daily-totals${qs(query)}`),
  createTransaction: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions`, { body: payload }),
  getTransaction: (ledgerId, id) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions/${seg(id)}`),
  updateTransaction: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/transactions/${seg(id)}`, { body: payload }),
  /** 软删除（回收站保留 30 天，docs/03 §8.3） */
  deleteTransaction: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/transactions/${seg(id)}`),
  /** 未结清视图（docs/04 §8.12）：summary 直接取虚拟台账，items 是逐笔归属 */
  listDebts: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/debts${qs(query)}`),
  /** 记账页「结清哪一笔」的候选项（只给仍未结清的产生笔） */
  listSettleable: (ledgerId, recordType) =>
    request('GET', `/ledgers/${seg(ledgerId)}/debts/settleable${qs({ recordType })}`),
  restoreTransaction: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/${seg(id)}/restore`),
  permanentDeleteTransaction: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/transactions/${seg(id)}/permanent`),
  listTrash: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions/trash${qs(query)}`),
  emptyTrash: (ledgerId) => request('DELETE', `/ledgers/${seg(ledgerId)}/transactions/trash`),
  duplicateTransaction: (ledgerId, id, payload = {}) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/${seg(id)}/duplicate`, { body: payload }),
  batchDeleteTransactions: (ledgerId, ids) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/batch-delete`, { body: { ids } }),
  batchTagTransactions: (ledgerId, ids, tagIds, mode = 'add') =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/batch-tag`, {
      body: { ids, tagIds, mode },
    }),
  /** 附件（docs/04 §8.8）：尚无对应后端路由，待附件阶段接入后再补
   *  `POST /ledgers/:id/transactions/:id/attachments`（multipart，字段 file） */

  // ---- 对账 ----
  previewReconcile: (ledgerId, accountId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/reconcile/preview`, {
      body: payload,
    }),
  submitReconcile: (ledgerId, accountId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/reconcile`, {
      body: payload,
    }),
  listReconciliations: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/reconciliations${qs(query)}`),
  reconciliationSummary: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/reconciliation-summary`),

  // ---- 分期账单（docs/04 §十一） ----
  listInstallmentPlans: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/installment-plans${qs(query)}`),
  getInstallmentPlan: (ledgerId, id) =>
    request('GET', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}`),
  createInstallmentPlan: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/installment-plans`, { body: payload }),
  updateInstallmentPlan: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}`, { body: payload }),
  deleteInstallmentPlan: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}`),
  /** 期明细：[{id,seq,dueDate,principal,fee,totalDue,status,paidAt,repayTxId}] */
  listInstallmentSchedules: (ledgerId, id) =>
    request('GET', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}/schedules`),
  /** 唯一那笔支出 —— 详情页要回答「这笔钱记在哪」 */
  installmentStartTransaction: (ledgerId, id) =>
    request('GET', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}/start-transaction`),
  /** 标记某期已还。幂等：已还过返回 200 + reused=true */
  payInstallmentSchedule: (ledgerId, scheduleId, payload = {}) =>
    request('POST', `/ledgers/${seg(ledgerId)}/installment-schedules/${seg(scheduleId)}/pay`, {
      body: payload,
    }),
  settleInstallmentEarly: (ledgerId, id, payload = {}) =>
    request('POST', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}/settle-early`, {
      body: payload,
    }),
  cancelInstallmentPlan: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/installment-plans/${seg(id)}/cancel`),

  // ---- 统计（docs/04 §十三） ----
  statsSummary: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/summary${qs(query)}`),
  statsTrend: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/trend${qs(query)}`),
  statsByCategory: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/by-category${qs(query)}`),
  statsByAccount: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/by-account${qs(query)}`),
  statsByMerchant: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/by-merchant${qs(query)}`),
  statsByCounterparty: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/by-counterparty${qs(query)}`),
  statsByTag: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/by-tag${qs(query)}`),
  statsOutstandingReceivables: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/outstanding-receivables`),
  statsOutstandingPayables: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/outstanding-payables`),

  /* ---- 统计进阶（`docs/15` S-05 ~ S-17） ---- */
  statsBudgetExecution: (ledgerId, year, month) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/budget-execution${qs({ year, month })}`),
  /** S-06 下钻：图 → 分类 → 明细 → 单笔 */
  statsDrilldown: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/drilldown${qs(query)}`),
  /** S-07 多周期报表：period = week | month | year */
  statsReport: (ledgerId, period, anchor) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/report${qs({ period, anchor })}`),
  /** S-08 环比（含日均校准） */
  statsComparison: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/comparison${qs(query)}`),
  /** S-09 净资产序列 */
  statsNetWorth: (ledgerId, limit) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/net-worth${qs({ limit })}`),
  captureNetWorthSnapshot: (ledgerId, snapshotDate) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/net-worth/snapshots`, {
      body: { snapshotDate },
    }),
  /** S-09 补拍历史快照（最近 12 个已结束月份，幂等） */
  backfillNetWorthSnapshots: (ledgerId) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/net-worth/snapshots/backfill`),
  /** S-11 同比 */
  statsYearOverYear: (ledgerId, year, month) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/year-over-year${qs({ year, month })}`),
  listStatEvents: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/events${qs(query)}`),
  createStatEvent: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/events`, { body: payload }),
  deleteStatEvent: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/stats/events/${seg(id)}`),
  /** S-12 自定义报表（列表里同时返回内置预设） */
  listSavedReports: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/stats/reports`),
  createSavedReport: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/reports`, { body: payload }),
  updateSavedReport: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/stats/reports/${seg(id)}`, { body: payload }),
  deleteSavedReport: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/stats/reports/${seg(id)}`),
  runSavedReport: (ledgerId, config) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/reports/run`, { body: config }),
  /** S-13 导出（返回 CSV 文本，不走 JSON） */
  exportStatsCsv: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/export.csv${qs(query)}`, { raw: true }),
  /** S-14 日历热力图 */
  statsHeatmap: (ledgerId, year, month) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/heatmap${qs({ year, month })}`),
  /** S-15 结论式洞察 */
  statsInsights: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/insights${qs(query)}`),
  /** S-16 订阅识别 */
  detectSubscriptions: (ledgerId, limit) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/subscriptions${qs({ limit })}`),
  confirmSubscription: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/subscriptions/confirm`, { body: payload }),
  ignoreSubscription: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/subscriptions/ignore`, { body: payload }),
  /** S-17 现金流三分类 */
  statsCashFlow: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/cash-flow${qs(query)}`),
  /** X-05 口径版本 */
  listPolicyVersions: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/stats/policies`),
  createPolicyVersion: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/policies`, { body: payload }),
  /** X-06 报销冲减 */
  listReimbursements: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/reimbursements${qs(query)}`),
  createReimbursement: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/reimbursements`, { body: payload }),
  voidReimbursement: (ledgerId, id) =>
    request('POST', `/ledgers/${seg(ledgerId)}/stats/reimbursements/${seg(id)}/void`),
  /** X-06 消费出口：分类支出（已扣报销） */
  statsCategoryExpenseNet: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/category-expense-net${qs(query)}`),

  /* ---- 报表页（主流记账 App 对标）新增的三个维度 ---- */
  /** 成员收支。⚠️ 口径是**记录人**（created_by），不是消费人 —— 界面必须标注 */
  statsByMember: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/by-member${qs(query)}`),
  /** 星期分布：周日~周六，含 0 支出日 */
  statsWeekday: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/weekday${qs(query)}`),
  /** 账户期初 / 期末 / 结余 */
  statsAccountsBalance: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/stats/accounts-balance${qs(query)}`),

  /* ---- 对账进阶（`docs/15` R-03 ~ R-14） ---- */
  correctionGuide: (ledgerId, txId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions/${seg(txId)}/correction-guide`),
  amendTransaction: (ledgerId, txId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/${seg(txId)}/amend`, { body: payload }),
  reverseTransaction: (ledgerId, txId, reason) =>
    request('POST', `/ledgers/${seg(ledgerId)}/transactions/${seg(txId)}/reverse`, {
      body: { reason },
    }),
  reconHistory: (ledgerId, accountId, limit) =>
    request('GET', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/reconciliations${qs({ limit })}`),
  /** R-05 排期 */
  reconSchedule: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/recon-schedule`),
  setReconSchedule: (ledgerId, accountId, payload) =>
    request('PUT', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/recon-schedule`, {
      body: payload,
    }),
  /** R-06 导入（预检不落业务库） */
  importBankStatement: (ledgerId, accountId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/statements/import`, {
      body: payload,
    }),
  listBankStatements: (ledgerId, accountId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/statements${qs({ accountId })}`),
  listStatementLines: (ledgerId, statementId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/statements/${seg(statementId)}/lines`),
  /** R-07 自动匹配 */
  autoMatchStatement: (ledgerId, statementId, windowDays) =>
    request('POST', `/ledgers/${seg(ledgerId)}/statements/${seg(statementId)}/match`, {
      body: { windowDays },
    }),
  /** R-08 人工勾兑（txId 传 null = 排除该行） */
  manualMatchLine: (ledgerId, lineId, txId, reason) =>
    request('POST', `/ledgers/${seg(ledgerId)}/statement-lines/${seg(lineId)}/match`, {
      body: { txId, reason },
    }),
  /** R-09 余额调节表 */
  reconStatement: (ledgerId, accountId, statementBalance, asOf) =>
    request(
      'GET',
      `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/recon-statement${qs({ statementBalance, asOf })}`,
    ),
  addAdjustingItem: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recon-adjusting-items`, { body: payload }),
  clearAdjustingItem: (ledgerId, id, txId) =>
    request('POST', `/ledgers/${seg(ledgerId)}/recon-adjusting-items/${seg(id)}/clear`, {
      body: { txId },
    }),
  /** R-10 信用卡账单日 */
  creditBilling: (ledgerId, accountId, year, month) =>
    request(
      'GET',
      `/ledgers/${seg(ledgerId)}/accounts/${seg(accountId)}/credit-billing${qs({ year, month })}`,
    ),
  /** R-11 匹配率 */
  reconMatchRate: (ledgerId, accountId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/recon-match-rate${qs({ accountId })}`),
  /** R-12 重复扣费 */
  duplicateCharges: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/duplicate-charges`),
  /** R-13 缺凭证的大额支出 */
  missingReceipts: (ledgerId, minAmount) =>
    request('GET', `/ledgers/${seg(ledgerId)}/missing-receipts${qs({ minAmount })}`),
  /** R-14：明确返回「不支持」，前端据此显示说明而不是空白 */
  bankSyncStatus: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/bank-sync`),

  /* ---- 跨模块协同（`docs/15` X-01 ~ X-07） ---- */
  incrementalRefresh: (ledgerId, txDate) =>
    request('POST', `/ledgers/${seg(ledgerId)}/incremental-refresh`, { body: { txDate } }),
  recordBackdated: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/backdated-adjustments`, { body: payload }),
  listBackdated: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/backdated-adjustments${qs(query)}`),
  backdatedWarnings: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/backdated-warnings`),
  internalFlowAudit: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/internal-flow-audit${qs(query)}`),
  subscriptionDigest: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/subscription-digest`),

  // ---- 预算（docs/04 §十四） ----
  listBudgets: (ledgerId, query = {}) => request('GET', `/ledgers/${seg(ledgerId)}/budgets${qs(query)}`),
  /** 预算进度 = 「预算 vs 实际」的差异分析，这一页真正要读的数据 */
  budgetProgress: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/progress${qs(query)}`),
  createBudget: (ledgerId, payload) => request('POST', `/ledgers/${seg(ledgerId)}/budgets`, { body: payload }),
  updateBudget: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/budgets/${seg(id)}`, { body: payload }),
  deleteBudget: (ledgerId, id) => request('DELETE', `/ledgers/${seg(ledgerId)}/budgets/${seg(id)}`),
  copyBudgetFromPrevious: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/copy-from-previous`, { body: payload }),
  /** 调拨历史（B-06，对标 YNAB 的 move money） */
  listBudgetTransfers: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/transfers${qs(query)}`),
  /** 调拨：把额度从 A 挪到 B。**不产生账单**，账户余额不动 */
  transferBudget: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/transfers`, { body: payload }),
  /** 撤销一次调拨（额度原路还回，历史不留抵消记录） */
  revokeBudgetTransfer: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/budgets/transfers/${seg(id)}`),
  /* ---- 预算进阶（`docs/15` B-01/B-07/B-08/B-09/B-11） ---- */
  budgetRatioPresets: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/ratio-presets`),
  /** B-01 比例法：给「必要/想要」两组分类，返回按比例拆出的建议额度 */
  planBudgetByRatio: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/plan-by-ratio`, { body: payload }),
  /** B-11 历史推荐：近 3 个月 P50（不是月均 —— 月均会被一次旅行带偏） */
  budgetSuggestions: (ledgerId, year, month) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/suggestions${qs({ year, month })}`),
  /** B-07 按发薪日切分账期 */
  budgetPeriodsByPayday: (ledgerId, payDay, fromYear, toYear) =>
    request(
      'GET',
      `/ledgers/${seg(ledgerId)}/budgets/periods${qs({ payDay, fromYear, toYear })}`,
    ),
  /** B-08 周期结转 */
  rolloverBudget: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/rollover`, { body: payload }),
  /** B-09 专项预算池（年缴类支出月度预提） */
  listBudgetPools: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/budgets/pools`),
  createBudgetPool: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/pools`, { body: payload }),
  listBudgetPoolEntries: (ledgerId, poolId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/pools/${seg(poolId)}/entries`),
  addBudgetPoolEntry: (ledgerId, poolId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/pools/${seg(poolId)}/entries`, {
      body: payload,
    }),
  /** B-11 模板 */
  listBudgetTemplates: (ledgerId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/templates`),
  saveBudgetTemplate: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/templates`, { body: payload }),
  /** B-04 记账事前校验 */
  precheckBudget: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/budgets/precheck`, { body: payload }),
  /** B-06 调整留痕 */
  listBudgetChanges: (ledgerId, query = {}) =>
    request('GET', `/ledgers/${seg(ledgerId)}/budgets/changes${qs(query)}`),

  // ---- 自动分类规则（docs/04 §十五） ----
  listCategoryRules: (ledgerId) => request('GET', `/ledgers/${seg(ledgerId)}/category-rules`),
  /** 试运行：不落库，让用户在建规则前看到会命中哪些 */
  previewCategoryRules: (ledgerId, limit = 100) =>
    request('GET', `/ledgers/${seg(ledgerId)}/category-rules/preview${qs({ limit })}`),
  createCategoryRule: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/category-rules`, { body: payload }),
  updateCategoryRule: (ledgerId, id, payload) =>
    request('PATCH', `/ledgers/${seg(ledgerId)}/category-rules/${seg(id)}`, { body: payload }),
  deleteCategoryRule: (ledgerId, id) =>
    request('DELETE', `/ledgers/${seg(ledgerId)}/category-rules/${seg(id)}`),
  reorderCategoryRules: (ledgerId, ids) =>
    request('POST', `/ledgers/${seg(ledgerId)}/category-rules/reorder`, { body: { ids } }),

  // ---- 期间关闭（docs/04 §十六） ----
  listPeriodClosures: (ledgerId, year) =>
    request('GET', `/ledgers/${seg(ledgerId)}/period-closures${qs({ year })}`),
  periodClosureStatus: (ledgerId, year, month) =>
    request('GET', `/ledgers/${seg(ledgerId)}/period-closures/status${qs({ year, month })}`),
  closePeriod: (ledgerId, payload) =>
    request('POST', `/ledgers/${seg(ledgerId)}/period-closures`, { body: payload }),
  reopenPeriod: (ledgerId, id) => request('DELETE', `/ledgers/${seg(ledgerId)}/period-closures/${seg(id)}`),

  // ---- 附件（docs/04 §8.8） ----
  listAttachments: (ledgerId, transactionId) =>
    request('GET', `/ledgers/${seg(ledgerId)}/transactions/${seg(transactionId)}/attachments`),
  /** multipart 上传，字段名固定 `file` */
  uploadAttachment: (ledgerId, transactionId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    // ⚠️ 传的是 `form` 不是 `body`：`body` 会被 JSON.stringify，
    // FormData 被字符串化后浏览器就发不出正确的 multipart 边界了。
    return request('POST', `/ledgers/${seg(ledgerId)}/transactions/${seg(transactionId)}/attachments`, { form: fd });
  },
  deleteAttachment: (ledgerId, id) => request('DELETE', `/ledgers/${seg(ledgerId)}/attachments/${seg(id)}`),

  // ---- 数据导入（docs/04 §8.9） ----
  /** 预览：不落库。`mapping` 可为 null —— 服务端会按表头猜。 */
  previewImport: (ledgerId, file, mapping = null) => {
    const fd = new FormData();
    fd.append('file', file);
    if (mapping) fd.append('mapping', JSON.stringify(mapping));
    return request('POST', `/ledgers/${seg(ledgerId)}/transactions/import/preview`, { form: fd, timeoutMs: 120_000 });
  },
  commitImport: (ledgerId, file, mapping, allowDuplicate = false) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mapping', JSON.stringify(mapping));
    fd.append('allowDuplicate', String(allowDuplicate));
    // 20000 行要逐笔走 createTransaction（过完整账务校验），慢是必然的
    return request('POST', `/ledgers/${seg(ledgerId)}/transactions/import/commit`, { form: fd, timeoutMs: 300_000 });
  },
};
