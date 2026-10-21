/**
 * 对账模块进阶能力（`docs/15` 的 R-03、R-05~R-14）。
 *
 * ## 与 `service.ts` 的分工
 *
 * `service.ts` 管「录入银行余额 → 比对 → 归因 → 落对账记录」这条主链路（R-01/R-02/R-04）。
 * 本文件管它**上下游**的：更正三路径、排期、流水导入与匹配、调节表、匹配率。
 *
 * ## 一条贯穿全局的红线：银行流水永不进业务库
 *
 * `bank_statement_lines` 只做暂存与匹配工作台，确认后由 `POST /transactions`
 * 落业务表。理由不是洁癖：流水里有大量用户**根本不打算记**的条目 ——
 * 信用卡还款本身、卡内定期转活期、同一笔消费的分期子项。
 * 直接入库会让账本在导入当天就多出几十条噪音，而清理它们的成本
 * 远高于逐条确认的成本。
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accounts,
  bankStatementLines,
  bankStatements,
  reconAdjustingItems,
  reconciliationRecords,
  recurringDetections,
  transactions,
} from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { ID_PREFIX, newId } from '../../utils/id.js';
import { formatCents, nowIso, parseAmountToCents, today as todayStr } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { calculateAmounts } from '../transactions/amounts.js';
import type { RecordType, TxDirection } from '../../config/constants.js';
import { balanceView } from '../accounts/service.js';

/** 账户当前账面余额（分）。全站余额只有一个出口 `balanceView()`，这里只做单位转换。 */
function balanceCents(ctx: AppCtx, ledgerId: string, accountId: string): number {
  return parseAmountToCents(balanceView(ctx, ledgerId, accountId).balance);
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / DAY);
}

function requireAccount(ctx: AppCtx, ledgerId: string, accountId: string) {
  const row = ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('账户不存在');
  return row;
}

/* ================================================================== *
 * R-03 专业更正三路径
 * ================================================================== */

export type CorrectionMode = 'supplement' | 'amend' | 'reverse';

/**
 * 三种更正路径的适用边界（`docs/15` R-03）。
 *
 * · `supplement` 补记 —— 账上**根本没有**这一笔（漏记）。新增一条账单。
 * · `amend`      修正 —— 账上**有**这一笔，但金额/日期/分类填错了。
 *                 直接改，但**必须留痕**（改前/改后都写进 audit）。
 *                 这就是会计上的划线更正法：原记录仍可辨认。
 * · `reverse`    冲销重记 —— 账上有这一笔且**已经对过账/已跨期**。
 *                 这时不能直接改（改了历史报表就变了），
 *                 要走红字冲销原笔 + 蓝字重记正确笔，两笔都留痕。
 *
 * 为什么必须区分 amend 与 reverse：直接改一条上月已对账的账单，
 * 会让「上月对账记录里的系统余额」与「现在的实际余额」对不上，
 * 而用户下次对账时会看到一个说不清的差额。
 */
export function correctionGuide(
  ctx: AppCtx,
  ledgerId: string,
  txId: string,
): { txId: string; recommended: CorrectionMode[]; reason: string; lockedBefore: string | null } {
  const tx = ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');

  const acc = tx.accountId
    ? ctx.db
        .select({ lockedBeforeDate: accounts.lockedBeforeDate })
        .from(accounts)
        .where(eq(accounts.id, tx.accountId))
        .get()
    : undefined;
  const lockedBefore = acc?.lockedBeforeDate ?? null;
  const isLocked = Boolean(lockedBefore && tx.txDate < lockedBefore!);

  const recommended: CorrectionMode[] = isLocked
    ? ['reverse']
    : ['amend', 'reverse'];
  return {
    txId,
    recommended,
    reason: isLocked
      ? `该账户 ${lockedBefore} 之前的账单已锁定，只能冲销重记`
      : '金额/日期/分类填错可直接修正；已对账或跨期的建议冲销重记',
    lockedBefore,
  };
}

/**
 * 划线更正（amend）。
 *
 * ⚠️ 只允许改**描述性字段**（金额、日期、分类、备注、商户），
 * 绝不许改 `recordType` 与 `accountDelta` 的派生关系 ——
 * 后者由 `amounts.ts` 统一算出，绕过它改会让借贷不平。
 */
export function amendTransaction(
  ctx: AppCtx,
  ledgerId: string,
  actorId: string,
  input: {
    txId: string;
    amount?: string | number | null;
    txDate?: string | null;
    categoryId?: string | null;
    name?: string | null;
    merchant?: string | null;
    note?: string | null;
    reason: string;
  },
) {
  const tx = ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, input.txId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');
  if (!input.reason?.trim()) {
    throw HttpError.validation([{ field: 'reason', message: '更正必须写明理由（留痕要求）' }]);
  }

  const before = {
    amount: formatCents(tx.amount),
    txDate: tx.txDate,
    categoryId: tx.categoryId,
    name: tx.name,
    note: tx.note,
  };

  const patch: Record<string, unknown> = {};
  if (input.amount !== undefined && input.amount !== null) {
    const cents = parseAmountToCents(input.amount);
    if (cents <= 0) throw HttpError.validation([{ field: 'amount', message: '金额必须大于 0' }]);
    patch.amount = cents;
    /**
     * ⚠️ 改金额必须**重算** `actualAmount` / `accountDelta` —— 只改 `amount`
     * 会让账户余额纹丝不动，而对账时用户看到的正是「余额没变但账面变了」。
     *
     * 更关键的是**不能自己算**：`accountDelta` 的符号与公式由
     * `calculateAmounts()` 独占（全系统唯一金额口径，docs/03 §1.2），
     * 手写 `−amount + fee` 会在 receivable/payable/transfer 上算错方向，
     * 而这些错误**不报错**，只会让净资产慢慢漂。
     */
    const calc = calculateAmounts({
      recordType: tx.recordType as RecordType,
      direction: tx.direction as TxDirection,
      amount: cents,
      fee: tx.fee,
      discount: tx.discount,
      // 更正一笔**冲减项**（冲销 / 退款）时仍走冲减判据（Δ 非零即可），不能用「同号」校验
      contra: (tx.adjustmentReason ?? '') === 'reversal' || (tx.adjustmentReason ?? '') === 'refund',
    });
    patch.actualAmount = calc.actualAmount;
    patch.accountDelta = calc.accountDelta;
    patch.toAccountDelta = calc.toAccountDelta;
  }
  if (input.txDate !== undefined && input.txDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.txDate)) {
      throw HttpError.validation([{ field: 'txDate', message: '日期格式应为 YYYY-MM-DD' }]);
    }
    patch.txDate = input.txDate;
  }
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
  if (input.name !== undefined) patch.name = input.name;
  if (input.merchant !== undefined) patch.merchant = input.merchant;
  if (input.note !== undefined) patch.note = input.note;
  if (!Object.keys(patch).length) {
    throw HttpError.validation([{ field: 'body', message: '没有需要更正的字段' }]);
  }

  ctx.db.update(transactions).set(patch).where(eq(transactions.id, input.txId)).run();

  // 划线更正的审计价值就在「改前什么样」—— 只记 after 等于没留痕
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'transaction',
    entityId: input.txId,
    summary: `划线更正：${input.reason}`,
    before,
    after: patch,
  });
  return { id: input.txId, mode: 'amend', before, after: patch };
}

/**
 * 红字冲销（reverse）。
 *
 * 冲销笔的 `note` 里必须写清「冲销 tx_xxx」，且**不生成新的对账差异** ——
 * 它只是把原笔归零。真正的正确数据由调用方紧接着用 `POST /transactions` 重记。
 *
 * ⚠️ 这里刻意**不自动重记**：冲销与重记必须是两个独立的用户动作，
 * 自动连做会让「我只想撤销」的用户被迫接受一条新账单。
 */
export function reverseTransaction(
  ctx: AppCtx,
  ledgerId: string,
  actorId: string,
  input: { txId: string; reason: string },
) {
  const tx = ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, input.txId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');
  if (!input.reason?.trim()) {
    throw HttpError.validation([{ field: 'reason', message: '冲销必须写明理由（留痕要求）' }]);
  }
  if (tx.deletedAt) throw HttpError.business('该账单已删除，无需冲销');

  const existingReversal = ctx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        sql`${transactions.note} like ${`%冲销 ${input.txId}%`}`,
        isNull(transactions.deletedAt),
      ),
    )
    .get();
  if (existingReversal) throw HttpError.duplicate('该账单已经冲销过');

  const id = newId(ID_PREFIX.transaction);
  const at = nowIso();
  ctx.db
    .insert(transactions)
    .values({
      id,
      ledgerId,
      recordType: tx.recordType,
      direction: tx.direction,
      accountId: tx.accountId,
      toAccountId: tx.toAccountId,
      categoryId: tx.categoryId,
      parentCategoryId: tx.parentCategoryId,
      amount: tx.amount,
      fee: tx.fee,
      discount: tx.discount,
      actualAmount: tx.actualAmount,
      // 冲销 = 账户变动取反。这是红字更正法的定义：金额为正数，方向为负。
      accountDelta: -tx.accountDelta,
      toAccountDelta: tx.toAccountDelta === null ? null : -tx.toAccountDelta,
      name: tx.name ? `（冲销）${tx.name}` : '（冲销）',
      merchant: tx.merchant,
      counterparty: tx.counterparty,
      note: `红字冲销 ${input.txId}：${input.reason}`,
      txDate: tx.txDate,
      txTime: tx.txTime,
      occurredAt: at,
      adjustmentReason: 'reversal',
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'transaction',
    entityId: id,
    summary: `红字冲销 ${input.txId}：${input.reason}`,
    before: { txId: input.txId, amount: formatCents(tx.actualAmount) },
    after: { reversalId: id },
  });
  return { reversalId: id, originalId: input.txId, amount: formatCents(tx.actualAmount) };
}

/* ================================================================== *
 * R-05 对账排期提醒
 * ================================================================== */

/**
 * 对账排期。
 *
 * 周期**按账户性质定**而不是用户偏好：现金/储蓄卡每周、信用卡按账单日。
 * 「现金每周对」不是勤快，是现金没有流水可追溯，一周之后谁也说不清。
 *
 * `dueState`:
 *   · `overdue` 逾期（已过应办日 + 宽限天数）
 *   · `due`     今天该办
 *   · `upcoming` 还没到
 *   · `never`   从没对过账 —— 这一类**必须单列**，
 *               `daysSince === null` 时 `null > 30` 与 `null ?? 0 > 30` 都为 false，
 *               它会从所有「超期」条件里漏掉（本项目在别处真踩过）。
 */
export function reconSchedule(ctx: AppCtx, ledgerId: string) {
  /**
   * ⚠️ **必须排除虚拟账户**（债权 / 债务 / 手续费台账）。
   *
   * 它们不是银行账户，没有「实际余额」可供核对 —— 把「债权（借出）」
   * 列进对账待办，用户永远做不完这件事，而做不完的待办等于没有待办。
   * `reconciliationSummary` 也是同一口径（只统计 `kind !== 'virtual'`），
   * 两处必须一致，否则「健康度说 1 个账户该对、排期列了 4 个」。
   */
  const rows = ctx.db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.ledgerId, ledgerId),
        isNull(accounts.archivedAt),
        sql`${accounts.kind} <> 'virtual'`,
      ),
    )
    .all();
  const today = todayStr();
  return rows.map((a) => {
    const cycle = a.reconcileCycle;
    const anchor = a.reconcileAnchorDay;
    const grace = a.reconcileRemindDays && a.reconcileRemindDays > 0 ? a.reconcileRemindDays : 3;
    const last = a.lastReconciledAt;
    const daysSince = last ? daysBetween(last.slice(0, 10), today) : null;

    let dueState: 'overdue' | 'due' | 'upcoming' | 'never' | 'off';
    let nextDue: string | null = null;
    /**
     * ⚠️ 判序是刻意的：**先判「从没对过账」**。
     *
     * 若先判 `!cycle → off`，一个没设周期也从没对过账的账户会落到 `off`，
     * 于是「这个账户从来没人核过」这件最该被看见的事**永远看不见** ——
     * 这正是 `lastReconciledAt is null` 的老陷阱：它不满足任何 `> N 天`
     * 的条件，会从所有「超期」筛选里两边都漏掉。
     */
    if (!last) {
      dueState = 'never';
      nextDue = today;
    } else if (!cycle) {
      dueState = 'off';
    } else {
      const expected = nextDueDate(last.slice(0, 10), cycle, anchor, a.billingDay);
      nextDue = expected;
      const delta = daysBetween(today, expected);
      if (delta < -grace) dueState = 'overdue';
      else if (delta <= 0) dueState = 'due';
      else dueState = 'upcoming';
    }
    return {
      accountId: a.id,
      accountName: a.name,
      accountType: a.type,
      cycle: cycle ?? null,
      anchorDay: anchor ?? a.billingDay ?? null,
      lastReconciledAt: last,
      daysSinceLast: daysSince,
      nextDue,
      dueState,
      graceDays: grace,
    };
  });
}

function nextDueDate(last: string, cycle: string, anchor: number | null, billingDay: number | null): string {
  const d = new Date(`${last}T00:00:00`);
  if (cycle === 'weekly') {
    const target = anchor ?? 1;
    d.setDate(d.getDate() + 7);
    while (d.getDay() !== target) d.setDate(d.getDate() + 1);
  } else {
    // monthly：锚定「几号」；信用卡用账单日
    const day = anchor ?? billingDay ?? 1;
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function setReconSchedule(
  ctx: AppCtx,
  ledgerId: string,
  actorId: string,
  input: {
    accountId: string;
    cycle: 'weekly' | 'monthly' | null;
    anchorDay?: number | null;
    remindDays?: number | null;
  },
) {
  const acc = requireAccount(ctx, ledgerId, input.accountId);
  if (input.cycle === 'weekly' && input.anchorDay !== undefined && input.anchorDay !== null) {
    if (input.anchorDay < 0 || input.anchorDay > 6) {
      throw HttpError.validation([{ field: 'anchorDay', message: '周结锚点应为 0-6（0=周日）' }]);
    }
  }
  if (input.cycle === 'monthly' && input.anchorDay !== undefined && input.anchorDay !== null) {
    if (input.anchorDay < 1 || input.anchorDay > 31) {
      throw HttpError.validation([{ field: 'anchorDay', message: '月结锚点应为 1-31' }]);
    }
  }
  if (input.remindDays !== undefined && input.remindDays !== null) {
    if (input.remindDays < 0 || input.remindDays > 30) {
      throw HttpError.validation([{ field: 'remindDays', message: '宽限天数应在 0-30 之间' }]);
    }
  }
  ctx.db
    .update(accounts)
    .set({
      reconcileCycle: input.cycle,
      reconcileAnchorDay: input.anchorDay ?? null,
      reconcileRemindDays: input.remindDays ?? null,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, input.accountId))
    .run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'account',
    entityId: input.accountId,
    summary: `设置对账排期：${input.cycle ?? '不提醒'}`,
  });
  return { accountId: acc.id, cycle: input.cycle };
}

/* ================================================================== *
 * R-06 流水导入
 * ================================================================== */

export interface ColumnMapping {
  date: string;
  /** 金额列。可以是单列（带正负号）或「支出/收入」双列 */
  amount: string;
  amountOut?: string | null;
  description?: string | null;
  merchant?: string | null;
  balance?: string | null;
}

/**
 * 解析 CSV 文本为流水行。
 *
 * 三件必须在这里做、不能推给前端的事：
 * ① **编码探测** —— 国内银行导出的 CSV 绝大多数是 GBK，
 *    直接按 UTF-8 读会得到一片乱码，而用户只会说「导入坏了」。
 *    判据是「UTF-8 解码是否出现替换字符」，够用且不引入依赖。
 * ② **预检不落业务库** —— 这一步只写 `bank_statement_lines`，
 *    用户确认前业务表一个字节都不动。
 * ③ **重复行标记** —— 同一 (账户, 日期, 金额, 摘要) 在同一批里出现两次，
 *    大概率是源文件本身重复，必须标出来让用户决定，不能静默去重
 *    （也可能人家那天真的消费了两笔一样的钱）。
 */
export function importStatement(
  ctx: AppCtx,
  ledgerId: string,
  actorId: string,
  input: {
    accountId: string;
    filename?: string | null;
    content: string | Uint8Array;
    mapping: ColumnMapping;
    statementMonth?: string | null;
  },
) {
  const acc = requireAccount(ctx, ledgerId, input.accountId);
  const text = decodeText(input.content);
  const rows = parseCsv(text);
  if (!rows.length) throw HttpError.validation([{ field: 'content', message: '文件内容为空' }]);
  const header = rows[0]!;
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx(input.mapping.date);
  const iAmount = idx(input.mapping.amount);
  if (iDate < 0) throw HttpError.validation([{ field: 'mapping.date', message: `找不到列「${input.mapping.date}」` }]);
  if (iAmount < 0) throw HttpError.validation([{ field: 'mapping.amount', message: `找不到列「${input.mapping.amount}」` }]);
  const iOut = input.mapping.amountOut ? idx(input.mapping.amountOut) : -1;
  const iDesc = input.mapping.description ? idx(input.mapping.description) : -1;
  const iMerchant = input.mapping.merchant ? idx(input.mapping.merchant) : -1;
  const iBalance = input.mapping.balance ? idx(input.mapping.balance) : -1;

  const month =
    input.statementMonth && /^\d{4}-\d{2}$/.test(input.statementMonth)
      ? input.statementMonth
      : (rows[1]?.[iDate] ?? todayStr()).slice(0, 7);

  const stmtId = newId(ID_PREFIX.bankStatement);
  const at = nowIso();
  ctx.db
    .insert(bankStatements)
    .values({
      id: stmtId,
      ledgerId,
      accountId: input.accountId,
      source: 'manual',
      statementMonth: month,
      filename: input.filename ?? null,
      rowCount: 0,
      matchedCount: 0,
      importedCount: 0,
      uploadedBy: actorId,
      createdAt: at,
    })
    .run();

  const seen = new Set<string>();
  let rowCount = 0;
  let dupCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const rawDate = (r[iDate] ?? '').trim();
    const date = normalizeDate(rawDate);
    if (!date) continue;
    const rawAmount = (r[iAmount] ?? '').trim();
    let cents = parseMoney(rawAmount);
    if (cents === null) continue;
    // 双列模式：支出列给出金额，方向恒为 debit
    if (iOut >= 0 && (r[iOut] ?? '').trim()) {
      const out = parseMoney((r[iOut] ?? '').trim());
      if (out !== null && out > 0) {
        cents = -out;
      }
    }
    const direction = cents < 0 ? 'debit' : 'credit';
    const abs = Math.abs(cents);
    const desc = iDesc >= 0 ? (r[iDesc] ?? '').trim() : '';
    const merchant = iMerchant >= 0 ? (r[iMerchant] ?? '').trim() : '';
    const balance = iBalance >= 0 ? parseMoney((r[iBalance] ?? '').trim()) : null;

    const key = `${date}|${abs}|${desc}|${merchant}`;
    const isDup = seen.has(key);
    if (isDup) dupCount++;
    seen.add(key);

    ctx.db
      .insert(bankStatementLines)
      .values({
        id: newId(ID_PREFIX.bankStatementLine),
        statementId: stmtId,
        ledgerId,
        accountId: input.accountId,
        txDate: date,
        direction,
        amount: abs,
        merchant: merchant || null,
        description: desc || null,
        balanceAfter: balance,
        matchState: isDup ? 'ignored' : 'unmatched',
        excludedReason: isDup ? '本批内重复行，请人工确认' : null,
        rowNo: i,
        rawJson: JSON.stringify(r),
        createdAt: at,
      })
      .run();
    rowCount++;
  }

  ctx.db
    .update(bankStatements)
    .set({ rowCount })
    .where(eq(bankStatements.id, stmtId))
    .run();

  /** 预检之后立刻跑一次自动匹配，让用户直接进入「确认」而不是「从头勾兑」 */
  const matched = autoMatch(ctx, ledgerId, stmtId);
  return {
    statementId: stmtId,
    accountId: acc.id,
    statementMonth: month,
    rowCount,
    duplicateCount: dupCount,
    matchSummary: matched.summary,
  };
}

/** 编码探测：UTF-8 解出替换字符就判定为 GBK。 */
function decodeText(input: string | Uint8Array): string {
  if (typeof input === 'string') return stripBom(input);
  const buf = Buffer.from(input);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8').slice(1);
  }
  const utf8 = buf.toString('utf8');
  if (utf8.includes('�')) {
    // Node 内置 TextDecoder 支持 GBK（ICU 完整数据时）
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 最小 CSV 解析（支持引号包裹与转义的引号） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

function parseMoney(raw: string): number | null {
  const s = raw.replace(/[¥￥,\s]/g, '');
  if (!s) return null;
  const neg = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  const n = Number(s.replace(/[()-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100);
}

function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  return null;
}

/* ================================================================== *
 * R-07 自动匹配 + R-08 人工勾兑
 * ================================================================== */

/**
 * 三态匹配（R-07）。
 *
 * 打分顺序即置信度顺序：金额 + 日期窗口 → 唯一金额 → 摘要关键词。
 * `matched` 与 `suspected` 的界限刻意保守：**只有唯一候选才自动匹配**，
 * 有多个同额候选时一律降为 `suspected` 交给人。
 * 自动匹配的代价是「用户以为对了」，这比让他多点一次严重得多。
 */
export function autoMatch(
  ctx: AppCtx,
  ledgerId: string,
  statementId: string,
  windowDays = 3,
) {
  const stmt = ctx.db
    .select()
    .from(bankStatements)
    .where(and(eq(bankStatements.id, statementId), eq(bankStatements.ledgerId, ledgerId)))
    .get();
  if (!stmt) throw HttpError.notFound('流水批次不存在');

  const lines = ctx.db
    .select()
    .from(bankStatementLines)
    .where(eq(bankStatementLines.statementId, statementId))
    .all();

  const cands = ctx.db
    .select({
      id: transactions.id,
      txDate: transactions.txDate,
      amount: transactions.actualAmount,
      recordType: transactions.recordType,
      name: transactions.name,
      merchant: transactions.merchant,
      accountDelta: transactions.accountDelta,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.accountId, stmt.accountId),
        isNull(transactions.deletedAt),
      ),
    )
    .all();

  let matched = 0;
  let suspected = 0;
  let unmatched = 0;

  for (const line of lines) {
    if (line.matchState === 'ignored') continue;
    const lineCents = line.direction === 'debit' ? -line.amount : line.amount;
    const near = cands.filter(
      (c) =>
        Math.abs(c.accountDelta) === Math.abs(lineCents) &&
        Math.sign(c.accountDelta) === Math.sign(lineCents) &&
        Math.abs(daysBetween(c.txDate, line.txDate)) <= windowDays,
    );
    const sameAmount = cands.filter(
      (c) =>
        Math.abs(c.accountDelta) === Math.abs(lineCents) &&
        Math.sign(c.accountDelta) === Math.sign(lineCents),
    );

    if (near.length === 1) {
      ctx.db
        .update(bankStatementLines)
        .set({
          matchState: 'matched',
          matchedTxId: near[0]!.id,
          matchScore: 100,
          matchReason: `金额一致 + 日期相差 ${Math.abs(daysBetween(near[0]!.txDate, line.txDate))} 天`,
        })
        .where(eq(bankStatementLines.id, line.id))
        .run();
      matched++;
      continue;
    }
    if (near.length > 1) {
      ctx.db
        .update(bankStatementLines)
        .set({
          matchState: 'suspected',
          matchScore: 70,
          matchReason: `同额候选 ${near.length} 笔，需人工确认`,
        })
        .where(eq(bankStatementLines.id, line.id))
        .run();
      suspected++;
      continue;
    }
    // 日期窗口外但金额唯一 → 疑似（金额唯一是强信号，但可能是记错日期）
    if (sameAmount.length === 1) {
      ctx.db
        .update(bankStatementLines)
        .set({
          matchState: 'suspected',
          matchScore: 50,
          matchReason: `金额唯一但日期相差 ${Math.abs(daysBetween(sameAmount[0]!.txDate, line.txDate))} 天（超过 ±${windowDays} 天）`,
        })
        .where(eq(bankStatementLines.id, line.id))
        .run();
      suspected++;
      continue;
    }
    unmatched++;
  }

  ctx.db
    .update(bankStatements)
    .set({ matchedCount: matched })
    .where(eq(bankStatements.id, statementId))
    .run();

  return {
    statementId,
    summary: { total: lines.length, matched, suspected, unmatched },
    // R-11：匹配率低于 90% 是「可能漏记」的信号，必须让前端看见
    matchRate: lines.length ? Math.round((matched / lines.length) * 1000) / 10 : 100,
  };
}

/** R-08 人工勾兑：把流水行与账单配对 */
export function manualMatch(
  ctx: AppCtx,
  ledgerId: string,
  input: { lineId: string; txId: string | null; reason?: string | null },
) {
  const line = ctx.db
    .select()
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.id, input.lineId), eq(bankStatementLines.ledgerId, ledgerId)))
    .get();
  if (!line) throw HttpError.notFound('流水行不存在');

  if (input.txId === null) {
    ctx.db
      .update(bankStatementLines)
      .set({
        matchState: 'ignored',
        matchedTxId: null,
        matchScore: null,
        matchReason: null,
        excludedReason: input.reason ?? '用户排除',
      })
      .where(eq(bankStatementLines.id, input.lineId))
      .run();
    return { lineId: input.lineId, state: 'ignored' };
  }

  const tx = ctx.db
    .select({ id: transactions.id, accountDelta: transactions.accountDelta })
    .from(transactions)
    .where(and(eq(transactions.id, input.txId), eq(transactions.ledgerId, ledgerId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');

  const lineCents = line.direction === 'debit' ? -line.amount : line.amount;
  const amountOk = Math.abs(tx.accountDelta) === Math.abs(lineCents);
  ctx.db
    .update(bankStatementLines)
    .set({
      matchState: 'matched',
      matchedTxId: input.txId,
      matchScore: 100,
      matchReason: input.reason ?? (amountOk ? '人工配对（金额一致）' : '人工配对（金额不一致，已按用户判断）'),
      excludedReason: null,
    })
    .where(eq(bankStatementLines.id, input.lineId))
    .run();
  return { lineId: input.lineId, txId: input.txId, state: 'matched', amountConsistent: amountOk };
}

export function listStatementLines(ctx: AppCtx, ledgerId: string, statementId: string) {
  return ctx.db
    .select()
    .from(bankStatementLines)
    .where(
      and(eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.ledgerId, ledgerId)),
    )
    .orderBy(asc(bankStatementLines.rowNo))
    .all()
    .map((l) => ({
      id: l.id,
      rowNo: l.rowNo,
      txDate: l.txDate,
      direction: l.direction,
      amount: formatCents(l.amount),
      merchant: l.merchant,
      description: l.description,
      matchState: l.matchState,
      matchedTxId: l.matchedTxId,
      matchReason: l.matchReason,
      excludedReason: l.excludedReason,
    }));
}

export function listStatements(ctx: AppCtx, ledgerId: string, accountId?: string) {
  const conds = [eq(bankStatements.ledgerId, ledgerId)];
  if (accountId) conds.push(eq(bankStatements.accountId, accountId));
  return ctx.db
    .select()
    .from(bankStatements)
    .where(and(...conds))
    .orderBy(desc(bankStatements.createdAt))
    .all()
    .map((s) => ({
      id: s.id,
      accountId: s.accountId,
      statementMonth: s.statementMonth,
      filename: s.filename,
      rowCount: s.rowCount,
      matchedCount: s.matchedCount,
      importedCount: s.importedCount,
      matchRate: s.rowCount ? Math.round((s.matchedCount / s.rowCount) * 1000) / 10 : 100,
      createdAt: s.createdAt,
    }));
}

/* ================================================================== *
 * R-09 未达账项与余额调节表
 * ================================================================== */

/**
 * 个人版银行存款余额调节表。
 *
 * 等式：`账面余额 + 银行已收我未记 − 银行已付我未记 = 银行对账单余额`
 *
 * 这两类不是自创的，是《会计基础工作规范》的标准分类：
 *   side='positive' 银行已记、我未记（在途存款）→ 调增账面
 *   side='negative' 我已记、银行未记（未兑现支票）→ 调减账面
 *
 * `balanced` 是**等式验证结果**，不是「对账成功」的判定 ——
 * 两边凑平也有可能凑错（记错一正一负），但它至少排除了绝大多数算术错误。
 */
export function reconStatement(
  ctx: AppCtx,
  ledgerId: string,
  accountId: string,
  statementBalance: number,
  asOf?: string,
) {
  const acc = requireAccount(ctx, ledgerId, accountId);
  const book = balanceCents(ctx, ledgerId, accountId);
  const date = asOf ?? todayStr();

  const items = ctx.db
    .select()
    .from(reconAdjustingItems)
    .where(
      and(
        eq(reconAdjustingItems.ledgerId, ledgerId),
        eq(reconAdjustingItems.accountId, accountId),
        isNull(reconAdjustingItems.clearedAt),
      ),
    )
    .orderBy(asc(reconAdjustingItems.itemDate))
    .all();

  let add = 0;
  let sub = 0;
  for (const it of items) {
    if (it.side === 'positive') add += it.amount;
    else sub += it.amount;
  }
  const adjusted = book + add - sub;
  const diff = statementBalance - adjusted;

  return {
    accountId,
    accountName: acc.name,
    asOf: date,
    bookBalance: formatCents(book),
    addItems: formatCents(add),
    subItems: formatCents(sub),
    adjustedBookBalance: formatCents(adjusted),
    statementBalance: formatCents(statementBalance),
    /** 调节后仍存在的差额。不为 0 说明还有未解释的部分 */
    unexplainedDiff: formatCents(diff),
    balanced: diff === 0,
    items: items.map((it) => ({
      id: it.id,
      itemDate: it.itemDate,
      side: it.side,
      kind: it.kind,
      amount: formatCents(it.amount),
      note: it.note,
      relatedTxId: it.relatedTxId,
    })),
  };
}

export function addAdjustingItem(
  ctx: AppCtx,
  ledgerId: string,
  userId: string,
  input: {
    accountId: string;
    side: 'positive' | 'negative';
    kind: 'in_transit' | 'deposit_in_transit' | 'outstanding_check' | 'bank_error' | 'our_error';
    itemDate: string;
    amount: string | number;
    note?: string | null;
    relatedTxId?: string | null;
  },
) {
  requireAccount(ctx, ledgerId, input.accountId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.itemDate)) {
    throw HttpError.validation([{ field: 'itemDate', message: '日期格式应为 YYYY-MM-DD' }]);
  }
  const cents = parseAmountToCents(input.amount);
  if (cents <= 0) throw HttpError.validation([{ field: 'amount', message: '金额必须大于 0' }]);
  const id = newId(ID_PREFIX.reconAdjustingItem);
  ctx.db
    .insert(reconAdjustingItems)
    .values({
      id,
      ledgerId,
      accountId: input.accountId,
      side: input.side,
      itemDate: input.itemDate,
      amount: cents,
      kind: input.kind,
      note: input.note ?? null,
      relatedTxId: input.relatedTxId ?? null,
      clearedAt: null,
      clearedTxId: null,
      createdBy: userId,
      createdAt: nowIso(),
    })
    .run();
  return { id, side: input.side, amount: formatCents(cents) };
}

/** 已达账：把未达账项销掉（钱真的到了/真的扣了） */
export function clearAdjustingItem(
  ctx: AppCtx,
  ledgerId: string,
  id: string,
  txId?: string | null,
) {
  const row = ctx.db
    .select()
    .from(reconAdjustingItems)
    .where(and(eq(reconAdjustingItems.id, id), eq(reconAdjustingItems.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('未达账项不存在');
  if (row.clearedAt) throw HttpError.business('该未达账项已核销');
  ctx.db
    .update(reconAdjustingItems)
    .set({ clearedAt: todayStr(), clearedTxId: txId ?? null })
    .where(eq(reconAdjustingItems.id, id))
    .run();
  return { id, clearedAt: todayStr() };
}

/* ================================================================== *
 * R-10 信用卡账单日对账
 * ================================================================== */

/**
 * 信用卡账单日对账。
 *
 * 与储蓄卡对账的本质区别：信用卡**没有「余额」可言**，只有「已出账金额」。
 * 所以对的是「账单金额 vs 本期已记支出」，未出账部分是**在途**而非差异。
 *
 * 额度使用率单独给 —— 它是信用卡用户真正关心的数字，
 * 且与预算是两回事（刷 8000 但下月全额还，不等于超支）。
 */
export function creditCardBilling(ctx: AppCtx, ledgerId: string, accountId: string, year?: number, month?: number) {
  const acc = requireAccount(ctx, ledgerId, accountId);
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  const billingDay = acc.billingDay ?? 1;

  // 账单周期：上月账单日+1 → 本月账单日
  const start = new Date(y, m - 2, billingDay + 1);
  const end = new Date(y, m - 1, billingDay);
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const from = fmt(start);
  const to = fmt(end);

  const rows = ctx.db
    .select({
      total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)`,
      cnt: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.accountId, accountId),
        eq(transactions.recordType, 'expense'),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, from),
        lte(transactions.txDate, to),
      ),
    )
    .get();
  const billed = Number(rows?.total ?? 0);

  // 未出账：本月账单日之后到今天
  const after = fmt(new Date(end.getTime() + DAY));
  const pending = ctx.db
    .select({ total: sql<number>`coalesce(sum(${transactions.actualAmount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.accountId, accountId),
        eq(transactions.recordType, 'expense'),
        isNull(transactions.deletedAt),
        gte(transactions.txDate, after),
        lte(transactions.txDate, todayStr()),
      ),
    )
    .get();
  const inTransit = Number(pending?.total ?? 0);

  const balance = balanceCents(ctx, ledgerId, accountId);
  const limit = acc.creditLimit ?? 0;

  return {
    accountId,
    accountName: acc.name,
    billingDay,
    statementPeriod: { from, to },
    billedAmount: formatCents(billed),
    billedCount: Number(rows?.cnt ?? 0),
    /** 未出账部分是在途，不是差异 —— 混淆二者会让用户以为对不上账 */
    pendingAmount: formatCents(inTransit),
    currentBalance: formatCents(balance),
    creditLimit: limit > 0 ? formatCents(limit) : null,
    usageRate: limit > 0 ? Math.round((Math.abs(balance) / limit) * 1000) / 10 : null,
    dueDate: acc.dueDay ? `${y}-${pad(m)}-${pad(acc.dueDay)}` : null,
  };
}

/* ================================================================== *
 * R-11 匹配率指标
 * ================================================================== */

/**
 * 匹配率 = 已匹配 ÷ 流水总笔数。
 *
 * 低于 90% 提示「可能存在漏记」—— 这是**记账完整度**的度量，
 * 国内没有任何产品做这件事。90% 这个阈值来自一木公开的
 * 「手动修正率 < 5%」的行业实践，取它的补集。
 */
export function matchRate(ctx: AppCtx, ledgerId: string, accountId?: string) {
  const conds = [eq(bankStatementLines.ledgerId, ledgerId)];
  if (accountId) conds.push(eq(bankStatementLines.accountId, accountId));
  const rows = ctx.db
    .select({
      state: bankStatementLines.matchState,
      cnt: sql<number>`count(*)`,
    })
    .from(bankStatementLines)
    .where(and(...conds))
    .groupBy(bankStatementLines.matchState)
    .all();
  const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
  const matched = Number(rows.find((r) => r.state === 'matched')?.cnt ?? 0);
  const suspected = Number(rows.find((r) => r.state === 'suspected')?.cnt ?? 0);
  const rate = total > 0 ? Math.round((matched / total) * 1000) / 10 : 100;
  return {
    total,
    matched,
    suspected,
    unmatched: Number(rows.find((r) => r.state === 'unmatched')?.cnt ?? 0),
    ignored: Number(rows.find((r) => r.state === 'ignored')?.cnt ?? 0),
    matchRate: rate,
    /** 只有样本量足够时提示才有意义 —— 3 笔里匹配 2 笔说不上「漏记风险」 */
    riskHint: total >= 20 && rate < 90 ? '匹配率偏低，可能存在漏记，建议核对未匹配流水' : null,
    threshold: 90,
  };
}

/* ================================================================== *
 * R-12 重复扣费识别（对账侧入口）
 * ================================================================== */

/**
 * 对账侧的重复扣费视角：只保留**已确认为订阅**的项，并按年支出倒序。
 * 检测算法在 `stats/advanced.ts` 的 `detectSubscriptions()` ——
 * 同一套识别逻辑不能在两个模块各写一份，否则「统计说有 3 个、
 * 对账说有 4 个」这种不一致迟早出现。
 */
export function duplicateCharges(ctx: AppCtx, ledgerId: string) {
  const rows = ctx.db
    .select()
    .from(recurringDetections)
    .where(and(eq(recurringDetections.ledgerId, ledgerId), eq(recurringDetections.status, 'confirmed')))
    .orderBy(desc(recurringDetections.amount))
    .all();
  const stale = rows.filter((r) => daysBetween(r.lastSeen, todayStr()) > 45);
  return {
    total: rows.length,
    /** 超过 45 天没再出现 —— 可能是「以为还在扣其实已经停了」，值得核一眼 */
    possiblyStale: stale.map((r) => ({
      id: r.id,
      merchant: r.merchant,
      amount: formatCents(r.amount),
      lastSeen: r.lastSeen,
      daysSince: daysBetween(r.lastSeen, todayStr()),
    })),
    items: rows.map((r) => ({
      id: r.id,
      merchant: r.merchant,
      periodType: r.periodType,
      amount: formatCents(r.amount),
      occurrenceCount: r.occurrenceCount,
      lastSeen: r.lastSeen,
      userLabel: r.userLabel,
    })),
  };
}

/* ================================================================== *
 * R-13 凭证附件（对账视角）
 * ================================================================== */

/**
 * 无凭证的大额支出清单。
 *
 * 「哪笔没有凭证」比「哪笔有凭证」有用得多 ——
 * 前者是可补的行动清单，后者只是展示。
 * 阈值默认 200 元：低于它要求贴票是负担，高于它没票说不清。
 */
export function missingReceipts(ctx: AppCtx, ledgerId: string, minAmountCents = 20_000) {
  const rows = ctx.db
    .select({
      id: transactions.id,
      txDate: transactions.txDate,
      amount: transactions.actualAmount,
      name: transactions.name,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        eq(transactions.recordType, 'expense'),
        isNull(transactions.deletedAt),
        gte(transactions.actualAmount, minAmountCents),
        // ⚠️ `attachments` 表**没有** `deleted_at` 列（删除是物理删）。
        // 照抄别的表的写法会直接 SQL 报错 500，而错误信息只说「no such column」。
        sql`not exists (select 1 from attachments a where a.transaction_id = ${transactions.id})`,
      ),
    )
    .orderBy(desc(transactions.txDate))
    .limit(200)
    .all();
  return {
    threshold: formatCents(minAmountCents),
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      txDate: r.txDate,
      amount: formatCents(r.amount),
      name: r.name,
      merchant: r.merchant,
    })),
  };
}

/* ================================================================== *
 * R-14 银行自动同步（国内不可行，显式声明）
 * ================================================================== */

/**
 * R-14 的落地结论：**不做**，并且把这个结论显式返回而不是静默缺失。
 *
 * 海外 Monarch / Copilot 经 Plaid 直连银行，是因为美国有开放银行法规
 * 与聚合器生态。国内个人银行账户数据的对外提供受严格限制，
 * 任何未经授权的聚合都是合规风险。
 *
 * 与其做一个「技术上能跑但随时会被叫停」的功能，
 * 不如把能力放在**导入 + 自动匹配 + 调节表**上 ——
 * 这三件已经覆盖了自动同步 90% 的用户价值（不用手打、不会漏记、差额可解释）。
 */
export const BANK_SYNC_STATUS = {
  supported: false,
  reason:
    '国内个人银行账户数据对外提供受合规限制，暂不支持聚合器直连。请使用流水导入（CSV）配合自动匹配完成对账。',
  alternative: '导入流水 → 自动匹配 → 人工勾兑 → 未达账项调节表',
} as const;

/* ================================================================== *
 * 对账历史的复查（R-04 的增强）
 * ================================================================== */

/** 某账户的对账履历（含归因明细），供「上次是怎么平的」复查 */
export function reconHistory(ctx: AppCtx, ledgerId: string, accountId: string, limit = 12) {
  return ctx.db
    .select()
    .from(reconciliationRecords)
    .where(
      and(eq(reconciliationRecords.ledgerId, ledgerId), eq(reconciliationRecords.accountId, accountId)),
    )
    .orderBy(desc(reconciliationRecords.reconcileDate), desc(reconciliationRecords.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      reconcileDate: r.reconcileDate,
      systemBalance: formatCents(r.systemBalance),
      actualBalance: formatCents(r.actualBalance),
      diffAmount: formatCents(r.diffAmount),
      reasonCode: r.reasonCode,
      reasonNote: r.reasonNote,
      attributionJson: r.attributionJson,
      createdAt: r.createdAt,
    }));
}
