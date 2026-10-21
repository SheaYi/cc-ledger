/**
 * 债权债务的「结清关联」与「未结清」口径（docs/12 §六 D9 / D10）。
 *
 * ## 为什么需要这张关联表
 *
 * 在此之前，「借出 800」与「还 300」是两笔各自独立的账单，**没有任何东西把它们
 * 关联起来**。后果是三个问题在数据模型里根本无法回答：
 *   · 那 800 现在还剩 500 没还？
 *   · 这笔 300 还的是哪一笔？（事后无法追溯）
 *   · 哪些债还没还？（只能靠人肉翻流水）
 *
 * `transaction_settlements` 就是这个关联：一笔结算 / 核销笔可以同时冲抵多笔产生笔，
 * 一笔产生笔也可以被多次部分结清，每次冲抵的金额都留痕。
 *
 * ## 权威口径与归属口径的关系
 *
 * * **权威（总额）** = 两个虚拟台账（债权 / 债务）的余额，即 `Σ产生 − Σ结算/核销`。
 *   它一直是正确的（`docs/03 §1.3`），界面上的「待收 / 待付」两张卡直接读它。
 * * **归属（逐笔）** = 本表的关联。用于回答「这一笔还差多少」。
 *
 * 二者不是两套账：软删除一笔结算笔后，本表里对应的行会因 `st.deleted_at IS NOT NULL`
 * 被排除，**未结清自动回涨** —— 这正是「撤销还款 → 这笔债又欠回来了」的期望行为。
 *
 * **允许不关联**：结算 / 核销笔的 `settles` 可以为空（记账时不该被强迫先想清楚
 * 「还的是哪一笔」）。这部分金额不归属到任何产生笔，在视图里单列为「未归属冲销」，
 * 保证恒等式 `Σ逐笔未结清 + 未归属冲销 = 台账余额` 永远成立。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  ORIGIN_DIRECTIONS,
  SETTLE_DIRECTIONS,
  type RecordType,
  type TxDirection,
} from '../../config/constants.js';
import { formatCents, parseAmountToCents } from '../../utils/money.js';
import { HttpError } from '../../utils/errors.js';
import { transactions, transactionSettlements } from '../../db/schema.js';
import { newId, ID_PREFIX } from '../../utils/id.js';

/** 「产生」阶段：债权 / 债务台账因它而增加 */
export function isOriginPhase(recordType: string, direction: string): boolean {
  return (ORIGIN_DIRECTIONS[recordType as RecordType] ?? []).includes(direction as TxDirection);
}

/** 「结算 / 核销」阶段：债权 / 债务台账因它而减少 */
export function isSettlePhase(recordType: string, direction: string): boolean {
  return (
    (recordType === 'receivable' || recordType === 'payable') &&
    SETTLE_DIRECTIONS.includes(direction as TxDirection)
  );
}

export interface SettleInput {
  transactionId: string;
  amount: string | number;
}

export interface SettleLink {
  transactionId: string;
  amount: number;
}

/**
 * 金额 → 分。
 *
 * ⚠️ 原本这里是 `Number.parseFloat(v) * 100` 再 `Math.round()`，是全站**第三份**
 * 元→分实现（另外两份是 `utils/money.ts` 的 `parseAmountToCents()` 与
 * `installment/index.ts` 里的 `Math.round(n * 100)`）。
 *
 * 三份实现的差别不是风格问题：
 *  · `parseFloat('8.29') * 100 = 828.9999999999999`，靠 `Math.round` 救回来；
 *    但 `parseFloat('1.005') * 100 = 100.49999999999999` → 100 分，
 *    而 `parseAmountToCents('1.005')` 直接**拒绝**（正则只允许 ≤2 位小数）。
 *    同一个输入在两条路径上得到「通过但取 1.00」与「400 报错」两种结果。
 *  · 浮点乘法在金额很大时会越过 `Number.isSafeInteger`。
 *
 * 所以这里改为调用唯一出口，并额外做「必须为正」的校验。
 */
function toCents(v: string | number, field: string): number {
  const cents = parseAmountToCents(v);
  if (cents <= 0) {
    throw HttpError.validation([{ field, message: '结清金额必须大于 0' }]);
  }
  return cents;
}

/**
 * 某笔「产生」账单已被结清掉多少。
 *
 * `st.deleted_at IS NULL` 是这里的关键：结算笔被软删除（撤销）后，
 * 这笔钱就不再算「已结清」，未结清自动回涨。
 */
export function settledOf(ctx: AppCtx, ledgerId: string, originalTxIds: string[]): Map<string, number> {
  const map = new Map<string, number>();
  if (originalTxIds.length === 0) return map;
  const rows = ctx.db
    .select({
      originalTxId: transactionSettlements.originalTxId,
      total: sql<number>`coalesce(sum(${transactionSettlements.amount}), 0)`,
    })
    .from(transactionSettlements)
    .innerJoin(transactions, eq(transactions.id, transactionSettlements.settleTxId))
    .where(
      and(
        eq(transactionSettlements.ledgerId, ledgerId),
        inArray(transactionSettlements.originalTxId, originalTxIds),
        isNull(transactions.deletedAt),
      ),
    )
    .groupBy(transactionSettlements.originalTxId)
    .all();
  for (const r of rows) map.set(r.originalTxId, Number(r.total ?? 0));
  return map;
}

/** 已被**删除的结算笔** 关联到各产生笔的金额（用于「更新这笔结算笔」时扣掉它自己） */
function settledExcluding(ctx: AppCtx, ledgerId: string, excludeSettleTxId: string | null) {
  const rows = ctx.db
    .select({
      originalTxId: transactionSettlements.originalTxId,
      settleTxId: transactionSettlements.settleTxId,
      amount: transactionSettlements.amount,
    })
    .from(transactionSettlements)
    .innerJoin(transactions, eq(transactions.id, transactionSettlements.settleTxId))
    .where(
      and(
        eq(transactionSettlements.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        excludeSettleTxId ? sql`${transactionSettlements.settleTxId} <> ${excludeSettleTxId}` : sql`1=1`,
      ),
    )
    .all();
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.originalTxId, (map.get(r.originalTxId) ?? 0) + r.amount);
  }
  return map;
}

/**
 * 校验并归一化 `settles` 输入。
 *
 * 六道闸门，缺一不可：
 *  ① 阶段合法：只有结算 / 核销笔才能关联（产生笔挂 link 是无意义的反向引用）；
 *  ② 被关联的账单存在、同一账本、未软删；
 *  ③ 被关联的必须是**产生**阶段（不能拿一笔还款去冲另一笔还款）；
 *  ④ 同账本内 record_type 一致（应收只能冲应收）；
 *  ⑤ 不得超过该笔的**未结清余额**（否则台账会被冲成负数 —— 语义上等于凭空负债）；
 *  ⑥ 本笔 Σlink ≤ 本笔 amount（多关联的那部分没有台账依据）。
 */
export function validateSettlements(
  ctx: AppCtx,
  ledgerId: string,
  params: {
    recordType: string;
    direction: string;
    amountCents: number;
    settles: SettleInput[] | null | undefined;
    /** 编辑场景：把这一笔自己已有的 link 排除后再算余额 */
    excludeSettleTxId?: string | null;
  },
): SettleLink[] {
  const raw = params.settles ?? [];
  const { recordType, direction, amountCents } = params;

  // ① 阶段
  if (raw.length && !isSettlePhase(recordType, direction)) {
    throw HttpError.validation([
      { field: 'settles', message: '只有「收回 / 还款 / 核销」这类结算阶段才能关联结清' },
    ]);
  }
  if (!raw.length) return [];

  const ids = raw.map((r) => r.transactionId);
  const found = ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.ledgerId, ledgerId), inArray(transactions.id, ids)))
    .all();
  const byId = new Map(found.map((r) => [r.id, r]));
  const issues: Array<{ field: string; message: string }> = [];

  // ②③④
  for (const r of raw) {
    const t = byId.get(r.transactionId);
    if (!t) {
      issues.push({ field: 'settles', message: `要结清的账单不存在：${r.transactionId}` });
      continue;
    }
    if (t.deletedAt) {
      issues.push({ field: 'settles', message: `「${t.name ?? t.id}」已在回收站，无法结清` });
      continue;
    }
    if (!isOriginPhase(t.recordType, t.direction)) {
      issues.push({
        field: 'settles',
        message: `「${t.name ?? t.id}」不是一笔债权 / 债务的发生记录，不能被结清`,
      });
      continue;
    }
    if (t.recordType !== recordType) {
      issues.push({
        field: 'settles',
        message: `「${t.name ?? t.id}」是${t.recordType === 'receivable' ? '应收' : '应付'}，与本次的${
          recordType === 'receivable' ? '应收' : '应付'
        }对不上`,
      });
    }
  }
  if (issues.length) throw HttpError.validation(issues);

  // 去重：同一笔产生只能在本笔里出现一次
  const seen = new Set<string>();
  const links: SettleLink[] = [];
  for (const r of raw) {
    if (seen.has(r.transactionId)) {
      throw HttpError.validation([{ field: 'settles', message: '同一条待结清账单被重复关联' }]);
    }
    seen.add(r.transactionId);
    links.push({ transactionId: r.transactionId, amount: toCents(r.amount, 'settles') });
  }

  // ⑤ 逐笔未结清余额
  const settledMap = settledExcluding(ctx, ledgerId, params.excludeSettleTxId ?? null);
  for (const link of links) {
    const origin = byId.get(link.transactionId)!;
    const remaining = origin.amount - (settledMap.get(link.transactionId) ?? 0);
    if (link.amount > remaining) {
      issues.push({
        field: 'settles',
        message: `「${origin.name ?? '未命名'}」还剩 ${formatCents(remaining)} 未结清，无法结清 ${formatCents(
          link.amount,
        )}`,
      });
    }
  }
  // ⑥ Σlink ≤ 本笔 amount
  const sum = links.reduce((s, l) => s + l.amount, 0);
  if (sum > amountCents) {
    issues.push({
      field: 'settles',
      message: `关联的结清金额合计 ${formatCents(sum)} 超过本笔金额 ${formatCents(amountCents)}`,
    });
  }
  if (issues.length) throw HttpError.validation(issues);

  return links;
}

/** 写入关联（创建与更新共用；更新时先清空本笔的旧关联） */
export function syncSettlements(
  ctx: AppCtx,
  ledgerId: string,
  settleTxId: string,
  links: SettleLink[],
  actorId: string,
) {
  ctx.db.delete(transactionSettlements).where(eq(transactionSettlements.settleTxId, settleTxId)).run();
  if (links.length === 0) return;
  ctx.db
    .insert(transactionSettlements)
    .values(
      links.map((l) => ({
        id: newId(ID_PREFIX.transactionSettlement),
        ledgerId,
        settleTxId,
        originalTxId: l.transactionId,
        amount: l.amount,
        createdBy: actorId,
        createdAt: new Date().toISOString(),
      })),
    )
    .run();
}
