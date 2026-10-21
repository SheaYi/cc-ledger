/**
 * 记账页本地草稿（docs/13 §10.1）。
 *
 * 存 localStorage 而不是内存 / sessionStorage：用户填一半可能直接关标签页、
 * 可能明天才想起来补，sessionStorage 一关就没了 —— 那就不叫草稿，叫遗失。
 *
 * 一条硬纪律：**只有用户真正输入过的字段才算「有内容」**。类型、方向、默认账户、
 * 日期、时间天生就有值，把它们算进去的话，空白表单也会存下一份草稿，
 * 下次进来弹一句「上次有一笔没记完」纯属噪音，用户会学会无视它。
 */
import { money } from '../ui.js';

/** 键名沿用既有风格：`cc-ledger.theme.v1` / `cc-ledger.auth.v1` */
const KEY = 'cc-ledger.tx-draft.v1';
/** 保留 24 小时，超期自动清除（§10.1） */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 参与「有内容」判定的字段。
 * 其余字段（类型 / 方向 / 账户 / 日期 / 时间）照存，只是不用来决定要不要存。
 */
const USER_FIELDS = [
  'categoryId',
  'amount',
  'fee',
  'discount',
  'name',
  'merchant',
  'counterparty',
  'note',
  'tags',
];

/** 会随账单一起走的全部字段（顺序即写入顺序，便于 diff） */
const FIELDS = [
  'recordType',
  'direction',
  'accountId',
  'toAccountId',
  'categoryId',
  'amount',
  'fee',
  'discount',
  'name',
  'merchant',
  'counterparty',
  'note',
  'txDate',
  'txTime',
];

function store() {
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / 存储被禁用：草稿是加分项，静默降级成「没有草稿」
    return null;
  }
}

/** 从表单 state 抽取可存字段（只留白名单，不把整个 state 序列化进去） */
function pickFields(state) {
  const out = {};
  for (const k of FIELDS) out[k] = state[k] ?? null;
  out.tags = [...(state.tags ?? [])];
  return out;
}

/** 草稿里有没有「用户真的填过的东西」 */
export function draftHasContent(draft) {
  const f = draft?.fields;
  if (!f) return false;
  for (const k of USER_FIELDS) {
    const v = f[k];
    if (Array.isArray(v)) {
      if (v.length) return true;
      continue;
    }
    if (v !== null && v !== undefined && String(v).trim() !== '') return true;
  }
  return false;
}

/**
 * 回访横幅上的一行摘要：`（¥32.00 · 午餐）`。
 *
 * 分类名与类型名在**写入时**存一份快照：分类或账户在 24 小时内被归档/删除是常事，
 * 横幅文案不该因为「查不到那个分类」就变成空。ID 仍然是权威，快照只负责显示。
 */
export function describeDraft(draft) {
  const f = draft?.fields ?? {};
  const cents = Number.parseFloat(f.amount);
  // `money()` 自带 `¥ ` 前缀与千分位，别再自己拼一个 —— 全站金额格式只有这一个出口
  const amount = Number.isFinite(cents) && cents > 0 ? money(String(cents)) : '未填金额';
  const what = draft?.snap?.categoryLabel || draft?.snap?.typeLabel || '未选分类';
  return `（${amount} · ${what}）`;
}

/**
 * 读草稿。不存在、解析失败、**换了账本**、超期，一律返回 null。
 *
 * 换账本必须当没有：账户 / 分类 ID 是账本内的，把 A 账本的 ID 套到 B 账本上
 * 会让用户把余额记到完全不相干的账户上。过期的不删 —— 换回原来那本账还捡得回来。
 */
export function readDraft(ledgerId) {
  const s = store();
  if (!s) return null;
  let raw = null;
  try {
    raw = s.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') throw new Error('bad shape');
    if (d.ledgerId !== ledgerId) return null;
    if (!Number.isFinite(d.savedAt) || Date.now() - d.savedAt > TTL_MS) return null;
    return d;
  } catch {
    // 存坏了就当没有，并顺手清掉（免得每次进来都重解析一次）
    try {
      s.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * 写草稿。`hasContent === false` 时**不写而是清掉**：
 * 用户把内容改回空白（「撤了一半」），继续留着一份空草稿只会让下次进来弹无意义的提示。
 */
export function writeDraft(state, snap, hasContent) {
  const s = store();
  if (!s) return;
  try {
    if (!hasContent) {
      s.removeItem(KEY);
      return;
    }
    s.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        ledgerId: state.ledgerId ?? null,
        fields: pickFields(state),
        snap: snap ?? null,
      }),
    );
  } catch {
    /* 配额满 / 被禁用：草稿写不进去不该打断记账 */
  }
}

/** 清草稿（提交成功、点「丢弃」、超期清理） */
export function clearDraft() {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
