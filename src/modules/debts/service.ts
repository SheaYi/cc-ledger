/**
 * 债权债务的「未结清」视图（docs/12 §六 D9 / D10）。
 *
 * 这是 `docs/07 §415` 路线图里一直没做的「未结清视图」，也是债权债务模块存在的
 * 唯一理由 —— 没有它，用户只能逐条翻流水去拼「我到底还欠谁多少」。
 *
 * ## 三层口径（docs/03 §1.3）
 *
 * 同一个事件对三层的影响完全不同，混在一起算必然错：
 *
 * | 事件 | 现金口径 | 台账口径 | 损益口径 |
 * |---|---|---|---|
 * | 产生（借出 / 登记欠款） | 借出 −A；登记 0 | +A | 0 |
 * | 结算（收回 / 偿还）    | ±A | −A | 0（本金不进损益） |
 * | 核销（坏账 / 免除）     | 0 | −A | 0 |
 *
 * 本模块的 `summary` 直接读两个**虚拟台账**（`kind='virtual'`，不进净资产）的余额 ——
 * 那是权威的总额口径；`items` 是逐笔归属。两者满足恒等式：
 *
 *   Σ(逐笔未结清) + 未归属冲销 = 台账余额
 *
 * 「未归属冲销」= 结算 / 核销笔里没有关联到任何产生笔的部分。允许它存在是刻意的：
 * 记账时不该被强迫先想清楚「还的是哪一笔」。UI 上单列出来，不藏。
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  DIRECTION_STAGE_LABEL,
  type RecordType,
  type TxDirection,
} from '../../config/constants.js';
import { formatCents } from '../../utils/money.js';
import { accounts, categories, transactions, transactionSettlements } from '../../db/schema.js';
import { ledgerDeltas } from '../accounts/balance.js';
import { isOriginPhase } from '../transactions/settlements.js';

export interface DebtItem {
  transactionId: string;
  recordType: RecordType;
  stage: string;
  /** 关联金额超过了本笔金额（数据异常，需人工核对） */
  overSettled?: boolean;
  txDate: string;
  /** 距今天数：最久未结清排最前（没有到期日字段时，这是最接近「逾期」的代理指标） */
  ageDays: number;
  name: string | null;
  counterparty: string | null;
  note: string | null;
  amount: string;
  settled: string;
  outstanding: string;
  account: { id: string; name: string } | null;
  category: { id: string; name: string; parentName: string | null } | null;
  settlements: Array<{
    transactionId: string;
    txDate: string;
    amount: string;
    stage: string;
    recordType: RecordType;
  }>;
  settledAt: string | null;
}

export interface DebtSummary {
  /** 待收 = 债权台账余额（权威总额） */
  totalReceivable: string;
  /** 待付 = 债务台账余额（权威总额） */
  totalPayable: string;
  /** 净头寸 = 待收 − 待付。正数表示「别人欠我的比我欠人的多」 */
  netPosition: string;
  /** 待收侧未结清笔数 */
  openReceivable: number;
  /** 待付侧未结清笔数 */
  openPayable: number;
  openCount: number;
  clearedCount: number;
  /** 没有归属到任何产生笔的结算 / 核销金额 */
  unallocatedReceivable: string;
  unallocatedPayable: string;
  /** 已归属到产生笔的金额合计（恒等式复核用） */
  linkedReceivable: string;
  linkedPayable: string;
  /** 超额结清笔数 */
  overSettledCount: number;
}

/**
 * 两个 `YYYY-MM-DD` 之间相差几天。
 *
 * ⚠️ 必须用**本地零点**解析，不能写 `T00:00:00Z`。
 *
 * `Date.parse('2026-10-15T00:00:00Z')` 得到的是 UTC 零点，在 UTC+8 的机器上
 * 它是本地时间 08:00；与另一个同样按 UTC 解析的日期相减，多数情况没错，
 * 但只要参与运算的任一端被换成「本地零点」（例如 `new Date()` 或别处的
 * `new Date(y, m-1, d)`），就会系统性差 ±1 天。
 *
 * 这个差一天在「最久未结清排最前」上只是排序抖动，
 * 但在跨月边界上会把「31 天前」读成「30 天前」 —— 账龄分档因此错位。
 * 全站凡是比较纯日期的，一律用本函数，不要各处自己拼 `T00:00:00`。
 */
function dayDiff(from: string, to: string): number {
  const parseLocal = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  };
  const a = parseLocal(from);
  const b = parseLocal(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function openDebts(
  ctx: AppCtx,
  ledgerId: string,
  q: { status?: string; counterparty?: string; today?: string } = {},
) {
  const today = q.today ?? new Date().toISOString().slice(0, 10);

  // ---- 权威总额：直接读两个虚拟台账 ----
  const ledgerAccs = ctx.db.select().from(accounts).where(eq(accounts.ledgerId, ledgerId)).all();
  const deltas = ledgerDeltas(ctx, ledgerId);
  const virtualBalance = (type: 'receivable' | 'payable') => {
    const a = ledgerAccs.find((x) => x.type === type && x.kind === 'virtual');
    if (!a) return 0;
    return a.openingBalance + (deltas.get(a.id)?.delta ?? 0);
  };
  const totalReceivable = virtualBalance('receivable');
  const totalPayable = virtualBalance('payable');

  // ---- 逐笔产生笔 ----
  const originRows = ctx.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        sql`((record_type = 'receivable' AND direction = 'decrease')
          OR (record_type = 'payable' AND direction = 'none'))`,
        q.counterparty ? eq(transactions.counterparty, q.counterparty) : undefined,
      ),
    )
    // 必须显式排序：SQLite 不保证无 ORDER BY 的行序，而下面的 JS sort 是**稳定**的 ——
    // 「最久未结清」排序遇到同天数并列时，输入顺序不定 = 页面每次刷新的行序可能不同。
    .orderBy(asc(transactions.txDate), asc(transactions.id))
    .all();

  /**
   * ⚠️ 「未归属冲销」必须用**全部**产生笔的关联来算，不能用当前筛选后的 `originIds`。
   *
   * 若按筛选后的集合统计，`linkedTotal` 会偏小、`unalloc` 会虚高 ——
   * 表现为「按对象筛选后，未归属冲销突然从 ¥0 变成 ¥800」。
   * 而它是**账本级的标量**，与「你正在看哪几行」无关。
   * 这正是用户报的「筛选后统计口径不一致」的那一类。
   */
  const allOriginIds = ctx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        sql`((record_type = 'receivable' AND direction = 'decrease')
          OR (record_type = 'payable' AND direction = 'none'))`,
      ),
    )
    .all()
    .map((r) => r.id);

  const originIds = originRows.map((r) => r.id);
  const linkRows = originIds.length
    ? ctx.db
        .select({
          settleTxId: transactionSettlements.settleTxId,
          originalTxId: transactionSettlements.originalTxId,
          amount: transactionSettlements.amount,
        })
        .from(transactionSettlements)
        .innerJoin(transactions, eq(transactions.id, transactionSettlements.settleTxId))
        .where(
          and(
            eq(transactionSettlements.ledgerId, ledgerId),
            inArray(transactionSettlements.originalTxId, originIds),
            isNull(transactions.deletedAt),
          ),
        )
        .all()
    : [];

  /** 账本级的全量关联：只为「未归属冲销」服务，不受 `counterparty` 筛选影响 */
  const linkRowsAll = allOriginIds.length
    ? ctx.db
        .select({
          settleTxId: transactionSettlements.settleTxId,
          originalTxId: transactionSettlements.originalTxId,
          amount: transactionSettlements.amount,
        })
        .from(transactionSettlements)
        .innerJoin(transactions, eq(transactions.id, transactionSettlements.settleTxId))
        .where(
          and(
            eq(transactionSettlements.ledgerId, ledgerId),
            inArray(transactionSettlements.originalTxId, allOriginIds),
            isNull(transactions.deletedAt),
          ),
        )
        .all()
    : [];

  const settleIds = [
    ...new Set([...linkRows.map((l) => l.settleTxId), ...linkRowsAll.map((l) => l.settleTxId)]),
  ];
  const settleRows = settleIds.length
    ? ctx.db
        .select()
        .from(transactions)
        .where(and(inArray(transactions.id, settleIds), isNull(transactions.deletedAt)))
        .all()
    : [];
  const settleById = new Map(settleRows.map((r) => [r.id, r]));

  const linksByOrigin = new Map<string, typeof linkRows>();
  for (const l of linkRows) {
    const list = linksByOrigin.get(l.originalTxId) ?? [];
    list.push(l);
    linksByOrigin.set(l.originalTxId, list);
  }

  const acctById = new Map(ledgerAccs.map((a) => [a.id, a]));
  const catRows = ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all();
  const catById = new Map(catRows.map((c) => [c.id, c]));

  const items: DebtItem[] = originRows.map((r) => {
    const links = linksByOrigin.get(r.id) ?? [];
    const settled = links.reduce((s, l) => s + l.amount, 0);
    const settlements = links
      .map((l) => {
        const st = settleById.get(l.settleTxId);
        if (!st) return null;
        return {
          transactionId: st.id,
          txDate: st.txDate,
          amount: formatCents(l.amount),
          stage:
            DIRECTION_STAGE_LABEL[st.recordType as RecordType]?.[st.direction as TxDirection] ?? '',
          recordType: st.recordType as RecordType,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.txDate.localeCompare(a.txDate));
    const cat = r.categoryId ? catById.get(r.categoryId) : null;
    return {
      transactionId: r.id,
      recordType: r.recordType as RecordType,
      stage: DIRECTION_STAGE_LABEL[r.recordType as RecordType]?.[r.direction as TxDirection] ?? '',
      txDate: r.txDate,
      ageDays: dayDiff(r.txDate, today),
      name: r.name,
      counterparty: r.counterparty,
      note: r.note,
      amount: formatCents(r.amount),
      settled: formatCents(settled),
      outstanding: formatCents(r.amount - settled),
      /**
       * 超额结清（`关联金额 > 本笔金额`）：outstanding 为负。
       *
       * ⚠️ 不能靠「默认只列 outstanding > 0」把它藏掉 ——
       * 藏掉之后 `Σ逐笔未结清` 就比真实值大，恒等式随之失效，
       * 用户看到的是「待收总额」与「明细加起来」对不上。
       * 所以这里显式标出来，让列表把它显示成一行待处理的异常。
       */
      overSettled: settled > r.amount,
      account: acctById.has(r.accountId)
        ? { id: r.accountId, name: acctById.get(r.accountId)!.name }
        : null,
      category: cat
        ? {
            id: cat.id,
            name: cat.name,
            parentName: cat.parentId ? (catById.get(cat.parentId)?.name ?? null) : null,
          }
        : null,
      settlements,
      settledAt: settlements.length ? (settlements[0]?.txDate ?? null) : null,
    };
  });

  // 默认只看待结清；`status=all` 才把已结清的也列出来（历史追溯用）
  const wantAll = q.status === 'all';
  /**
   * ⚠️ 过滤条件是 `!== 0` 而不是 `> 0`。
   * `> 0` 会把「超额结清」（outstanding 为负）的行**静默丢掉**，
   * 于是明细合计与待收总额对不上，而用户完全看不出少了什么。
   * 负数是异常，但它必须**显示在界面上**让人去修，而不是被过滤掉。
   */
  const visible = wantAll ? items : items.filter((i) => Number(i.outstanding) !== 0);
  // 排序：未结清优先 → 同为未结清时最久的排最前（最接近逾期）
  visible.sort((a, b) => {
    const ao = Number(a.outstanding) !== 0 ? 0 : 1;
    const bo = Number(b.outstanding) !== 0 ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (ao === 0) return b.ageDays - a.ageDays;
    return b.txDate.localeCompare(a.txDate);
  });

  // ---- 未归属冲销：总额口径减掉逐笔口径 ----
  //
  // ⚠️ 这里必须**按类型逐个约束 direction**，不能用 `direction IN ('increase','decrease','write_off')`
  // 一把梭：`decrease` 对 receivable 是「借出（产生）」而不是结算，写进合计里会把
  // 整笔未收回的钱误判成「未归属冲销」（实测踩过：借出 800 + 收回 300 显示成 800 未归属）。
  const settleAll = ctx.db
    .select({
      recordType: transactions.recordType,
      amount: sql<number>`coalesce(sum(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        sql`((record_type = 'receivable' AND direction IN ('increase','write_off'))
          OR (record_type = 'payable' AND direction IN ('decrease','write_off')))`,
      ),
    )
    .groupBy(transactions.recordType)
    .all();
  const settleTotal = new Map(settleAll.map((r) => [r.recordType, Number(r.amount ?? 0)]));
  const linkedTotal = new Map<string, number>();
  for (const l of linkRowsAll) {
    const st = settleById.get(l.settleTxId);
    if (!st) continue;
    linkedTotal.set(st.recordType, (linkedTotal.get(st.recordType) ?? 0) + l.amount);
  }

  /**
   * 恒等式的正确形式（推导见下，与 `docs/03 §1.3` / `docs/12 §8.4` 写的 `+` 不同）：
   *
   *   台账余额 = Σ产生 − Σ结算
   *   逐笔未结清合计 = Σ产生 − Σ已归属
   *   未归属冲销   = Σ结算 − Σ已归属
   *   ⇒ 台账余额 = Σ逐笔未结清 **−** 未归属冲销
   *
   * 文档与代码注释里写的是「+」，数值上只有在「全部结算都已归属」（Σ结算 = Σ已归属）
   * 时才碰巧成立。这里不改口径，只把推导写清楚，并在返回值里同时给出 `linkedTotal`
   * 便于前端做复核 —— **口径错了可以改，恒等式不成立却没人发现才是真风险**。
   */
  const unalloc = (rt: string) => (settleTotal.get(rt) ?? 0) - (linkedTotal.get(rt) ?? 0);
  const linkedTotalOut = {
    receivable: linkedTotal.get('receivable') ?? 0,
    payable: linkedTotal.get('payable') ?? 0,
  };

  const summary: DebtSummary = {
    totalReceivable: formatCents(totalReceivable),
    totalPayable: formatCents(totalPayable),
    netPosition: formatCents(totalReceivable - totalPayable),
    // 逐侧计数：两张卡各写各的笔数，不能都报总数（否则「待收 8 笔」会数到待付那几笔）
    openReceivable: items.filter((i) => i.recordType === 'receivable' && Number(i.outstanding) > 0).length,
    openPayable: items.filter((i) => i.recordType === 'payable' && Number(i.outstanding) > 0).length,
    openCount: items.filter((i) => Number(i.outstanding) > 0).length,
    clearedCount: items.filter((i) => Number(i.outstanding) <= 0).length,
    unallocatedReceivable: formatCents(unalloc('receivable')),
    unallocatedPayable: formatCents(unalloc('payable')),
    /** 已归属到产生笔的金额合计 —— 前端用它做「恒等式复核」，见 unalloc 的推导 */
    linkedReceivable: formatCents(linkedTotalOut.receivable),
    linkedPayable: formatCents(linkedTotalOut.payable),
    /** 超额结清的笔数（outstanding < 0），非 0 即为数据异常 */
    overSettledCount: items.filter((i) => i.overSettled).length,
  };

  return { summary, items: visible };
}

/** 记账页「结清哪一笔」的可选项：某类型下仍未结清的产生笔 */
export function listSettleable(ctx: AppCtx, ledgerId: string, recordType: string) {
  const originDirection = recordType === 'receivable' ? 'decrease' : 'none';
  const rows = ctx.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        isNull(transactions.deletedAt),
        eq(transactions.recordType, recordType),
        eq(transactions.direction, originDirection),
      ),
    )
    // 显式排序：SQLite 不保证无 ORDER BY 的行序；下面的 JS sort 是稳定的，
    // 输入顺序不定会让「同日两笔」在每次刷新后互换位置。
    .orderBy(asc(transactions.txDate), asc(transactions.id))
    .all();
  const links = rows.length
    ? ctx.db
        .select({
          originalTxId: transactionSettlements.originalTxId,
          amount: sql<number>`coalesce(sum(${transactionSettlements.amount}), 0)`,
        })
        .from(transactionSettlements)
        .innerJoin(transactions, eq(transactions.id, transactionSettlements.settleTxId))
        .where(
          and(
            eq(transactionSettlements.ledgerId, ledgerId),
            inArray(transactionSettlements.originalTxId, rows.map((r) => r.id)),
            isNull(transactions.deletedAt),
          ),
        )
        .groupBy(transactionSettlements.originalTxId)
        .all()
    : [];
  const settledMap = new Map(links.map((l) => [l.originalTxId, Number(l.amount ?? 0)]));
  return rows
    .map((r) => ({
      transactionId: r.id,
      txDate: r.txDate,
      name: r.name,
      counterparty: r.counterparty,
      amount: formatCents(r.amount),
      settled: formatCents(settledMap.get(r.id) ?? 0),
      outstanding: formatCents(r.amount - (settledMap.get(r.id) ?? 0)),
    }))
    .filter((r) => Number(r.outstanding) > 0)
    .sort((a, b) => a.txDate.localeCompare(b.txDate));
}

/** 复核用：某笔产生笔的阶段判断（供 service 之外的断言调用，避免各处重写） */
export { isOriginPhase };
