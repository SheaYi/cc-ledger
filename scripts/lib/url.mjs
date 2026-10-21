/**
 * URL 路径构造器（脚本侧）
 *
 * ## 为什么需要它
 *
 * **虚拟账户（债权 / 债务 / 手续费）的 id 是复合形式**：
 *   `ldg_01M4...#acc_sys_receivable`
 * 这个形态是刻意的 —— 它让系统账户在每个账本里可被**确定性重建**
 * （同账本 + 同 key → 同 id，不必额外存映射），且天然跨账本唯一。
 * 所以 id 不能改成纯 ULID。
 *
 * 而 `#` 在 URL 里是**片段分隔符**（RFC 3986 §3.5）。不转义就拼进路径：
 *
 *   /ledgers/L/accounts/ldg_01M4...#acc_sys_receivable/balance
 *                     └────────── 服务端只收到这段 ──────────┘
 *
 * 两种失败模式，**都很隐蔽**：
 *   · `#` 在中间 → 路由仍匹配到 `:accountId`（值被截断），查库查不到 →
 *     **404「账户不存在」**。错误信息把人引向「账户被删了」而不是「没转义」。
 *   · `#` 后还有多段路径（如 `/reconcile/preview`）→ 整段不发到服务端 →
 *     **404「接口不存在」**。
 *
 * ## 用法
 *
 *   import { P } from './lib/url.mjs';
 *   await call('GET', P`/ledgers/${ledgerId}/accounts/${acc.id}/balance`);
 *
 * `P` 是 tagged template：**所有插值自动 `encodeURIComponent`**，
 * 静态部分原样保留。不可能忘记转义，也不需要逐处判断「这个 id 会不会含 `#`」。
 *
 * 与前端 `public/assets/api.js` 的 `seg()` 同一套思路 —— 那边是 71 处手写 `seg()`，
 * 这边用标签函数把它变成**语法强制**，因为脚本数量多、生命周期短、容易忘。
 *
 * ## 查询串不要塞进 P
 *
 * `P` 会把**每一个插值**都 `encodeURIComponent`，而 query 的值里常含 `&` / `=`：
 *
 *   P`/ledgers/${L}/debts?type=${'a&b'}`     ← 错，& 被编成 %26，参数分隔符没了
 *
 * 正确写法是**路径与查询分开**：
 *
 *   P`/ledgers/${L}/debts` + qs({ type: 'a&b' })
 *
 * `qs()` 交给 `URLSearchParams` 处理，语义与前端 `api.js` 的 `qs()` 一致。
 *
 * 忘了写 `P` 会被 `npm run audit:url` 抓到（它只报「插值里含 id 词且未转义」的行）。
 */

/** 转义单个路径段。保留 `,` 与 `=` —— 它们在 query 里常见，且 `encodeURIComponent` 会编掉。 */
const enc = (v) => encodeURIComponent(String(v ?? ''));

/**
 * 路径模板标签：静态段原样保留，所有插值转义。
 *
 * ⚠️ 它**不做**的事：不校验插值里有没有 `/`。若有人传进来一个含 `/` 的
 * 路径（而不是单个 id），转义成 `%2F` 会得到 404 —— 这是刻意的：
 * 让它响亮地坏掉，好过悄悄拼出一条语义不同的路径。
 */
export const P = (strings, ...values) =>
  strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? enc(values[i]) : ''), '');

/** 与 P 等价的对象式写法（不想用模板语法时） */
export const apiPath = (...segments) => '/api/v1' + segments.map(enc).join('/');

/**
 * 查询串构造：剔除 undefined / null / ''。
 * 与前端 `api.js` 的 `qs()` 同语义。
 */
export const qs = (params = {}) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
};
