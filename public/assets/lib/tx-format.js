/**
 * 账单的**展示层格式化**（列表页 / 详情页共用）。
 *
 * 为什么要单独一个模块：账单的「显示什么、用什么色」在两页里必须完全一致，
 * 否则同一笔账在列表是红、在详情是灰，用户会怀疑数据本身有问题。
 * 这里只做纯函数，不碰 DOM、不请求接口 —— 与 `lib/amounts.js` 同级。
 *
 * 三条来自 `docs/13 §9.3` 的硬约定：
 *  ① 金额符号由 `accountDelta` 决定，**转账对主账户永远是负**（会计入 `is-neg`）；
 *  ② 支出/负向 = `--c-danger` 红、收入/正向 = `--c-success` 绿、零值中性
 *     （与股票涨跌**相反**，见 `app.css` 注释）；
 *  ③ 日期头是「10 月 13 日 · 周二」形态，今天/昨天用词替换星期。
 */
import { RECORD_TYPE_LABEL, money } from '../ui.js';

/* ---------------- 日期 ---------------- */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function ymd(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** 把 `YYYY-MM-DD` 拆成数字三元组（不用 `new Date(str)`：Safari 对 `YYYY-MM-DD` 会当 UTC 解析） */
function parts(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return { y, m, d };
}

/** 日期分组头的星期位：今天 / 昨天 优先于星期（信息密度更高） */
export function dayWeekday(dateStr) {
  if (dateStr === ymd()) return '今天';
  if (dateStr === shiftDays(-1)) return '昨天';
  const { y, m, d } = parts(dateStr);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? '';
}

/** 日期分组头：「2025 年 10 月 13 日」（非今年才带年份） */
export function dayLabel(dateStr) {
  const { y, m, d } = parts(dateStr);
  const year = y === new Date().getFullYear() ? '' : `${y} 年 `;
  return `${year}${m} 月 ${d} 日`;
}

/** 详情页用：`2026-10-13 12:30` */
export function stampLabel(tx) {
  const t = tx.txTime ? String(tx.txTime).slice(0, 5) : '';
  return t ? `${tx.txDate} ${t}` : `${tx.txDate}（未记时间）`;
}

/* ---------------- 金额 ---------------- */

/**
 * 带正负号的金额文本。零值**不写符号**（`+¥ 0.00` 会让人以为有钱进来）。
 * 用真正的减号 U+2212 而不是连字符：等宽字体下长度一致，纵列不会参差。
 */
export function amountText(value) {
  const n = Number(value ?? 0);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${money(Math.abs(n))}`;
}

/** 金额语义色类名（`is-pos` / `is-neg` / `is-zero`，既有类，勿新增） */
export function amountTone(value) {
  const n = Number(value ?? 0);
  if (n > 0) return 'is-pos';
  if (n < 0) return 'is-neg';
  return 'is-zero';
}

/* ---------------- 类型 / 分类文案 ---------------- */

/** 账单的「主语」文案：分类优先，没有分类时退到类型语义 */
export function subjectText(tx) {
  if (tx.category) {
    return tx.category.parent ? `${tx.category.parent.name} › ${tx.category.name}` : tx.category.name;
  }
  switch (tx.recordType) {
    case 'transfer':
      return tx.toAccount ? `转到 ${tx.toAccount.name}` : '转账';
    case 'adjustment':
      return '余额调整';
    case 'receivable':
    case 'payable':
      return `${RECORD_TYPE_LABEL[tx.recordType] ?? ''}${tx.stageLabel ? ` · ${tx.stageLabel}` : ''}`;
    default:
      return RECORD_TYPE_LABEL[tx.recordType] ?? '未分类';
  }
}

/**
 * 记录类型的语义图标。列表页的行图标、详情页的头部图标、记账页的类型
 * Mega Menu 都取这一份 —— 同一个类型在三处的图形必须一致，否则用户
 * 会以为它们是不同的东西。
 */
export const TYPE_ICON = {
  expense: 'receipt',
  income: 'banknote',
  transfer: 'arrow-left-right',
  receivable: 'hand-coins',
  payable: 'heart-handshake',
  adjustment: 'scale',
};

export function subjectIcon(tx) {
  return tx.category?.icon || TYPE_ICON[tx.recordType] || 'circle-help';
}

/** 第二行/次列的附加信息：商家优先，其次对象，再次标签数 */
export function extraText(tx) {
  return tx.merchant || tx.counterparty || '';
}

/** 标签点（移动端第二行的彩色点，最多 4 个，多的收成 `+N`） */
export function tagDots(tx, max = 4) {
  const tags = tx.tags ?? [];
  return {
    shown: tags.slice(0, max),
    more: Math.max(0, tags.length - max),
  };
}

/** 需要展示「类型徽标」的场景：非收支类型容易被误读成支出 */
const BADGE_TYPES = new Set(['transfer', 'receivable', 'payable', 'adjustment']);

export function typeBadge(tx) {
  if (!BADGE_TYPES.has(tx.recordType)) return null;
  const base = RECORD_TYPE_LABEL[tx.recordType] ?? '';
  return tx.stageLabel ? `${base} · ${tx.stageLabel}` : base;
}

/** 未渲染留白用的一致占位符 */
export const DASH = '—';

/** 空值统一显示为占位符（`—`），避免界面上出现「null」或空白 */
export function dashText(value, placeholder = DASH) {
  const v = String(value ?? '').trim();
  return v || placeholder;
}

export { ymd as todayIso, shiftDays as isoDaysAgo };
