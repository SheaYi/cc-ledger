/**
 * 期间关闭（结账）—— `docs/05 §十七` / `docs/04 §十六`。
 *
 * ## 它解决什么问题
 *
 * 已完成的月份不应被随手改掉，否则历史报表不可重现。这里的机制是**软锁**：
 * 关账只往 `period_closures` 写一行，之后任何落在该期间的**写操作**被拒。
 * 账单本身永远不会被删除或改写 —— 修正只能新建反向调整单（`docs/05 §17.3`）。
 *
 * ## 为什么需要「一个模块」而不是散落在业务里
 *
 * 「某期间是否已关账」这个判定在记账侧已经存在（`transactions/service.ts` 的
 * `assertPeriodOpen`，以及 `updateTransaction` 里的同义内联查询）。本模块**复用**
 * 那一个出口，不另写一份 —— 口径出现第二份实现，就一定会出现「关账了但某条路径没拦住」。
 *
 * ## 关账本身的两条业务约束（文档未写，这里按记账业务补齐）
 *
 *  ① **不允许关闭当前月**。当月还在记账，关掉它等于自断手脚，且用户几乎无法自查
 *     （账单还在，但全都改不了了）。要表达「这个月差不多了」应该用**对账**而不是关账。
 *  ② **不允许关闭未来月份**。同上，且更明显是误操作。
 *
 * 两条都在 `closePeriod` 里校验并给出可操作的提示文案。
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { periodClosures, periodReopenLogs, users } from '../../db/schema.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { periodFlow } from '../accounts/service.js';

export interface ClosureDto {
  id: string;
  year: number;
  month: number;
  period: string;
  closedAt: string;
  closedBy: { id: string; nickname: string } | null;
  note: string | null;
  /** 该期间的账单规模（让用户关账前知道自己在关掉多少东西） */
  transactionCount: number;
  totalExpense: string;
  totalIncome: string;
}

function nicknameMap(ctx: AppCtx): Map<string, string> {
  const rows = ctx.db.select({ id: users.id, nickname: users.nickname }).from(users).all();
  return new Map(rows.map((r) => [r.id, r.nickname]));
}

function rangeOf(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  return { from, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** 该期间是否已关账（账本内精确匹配 year+month） */
export function isClosed(ctx: AppCtx, ledgerId: string, year: number, month: number): boolean {
  const row = ctx.db
    .select({ id: periodClosures.id })
    .from(periodClosures)
    .where(
      and(
        eq(periodClosures.ledgerId, ledgerId),
        eq(periodClosures.year, year),
        eq(periodClosures.month, month),
      ),
    )
    .get();
  return Boolean(row);
}

export function closureStatus(ctx: AppCtx, ledgerId: string, year: number, month: number) {
  const row = ctx.db
    .select()
    .from(periodClosures)
    .where(
      and(
        eq(periodClosures.ledgerId, ledgerId),
        eq(periodClosures.year, year),
        eq(periodClosures.month, month),
      ),
    )
    .get();
  return {
    year,
    month,
    period: `${year}-${String(month).padStart(2, '0')}`,
    closed: Boolean(row),
    closedAt: row?.closedAt ?? null,
  };
}

export function listClosures(ctx: AppCtx, ledgerId: string, year?: number): ClosureDto[] {
  const names = nicknameMap(ctx);
  const rows = ctx.db
    .select()
    .from(periodClosures)
    .where(year ? and(eq(periodClosures.ledgerId, ledgerId), eq(periodClosures.year, year)) : eq(periodClosures.ledgerId, ledgerId))
    .orderBy(desc(periodClosures.year), desc(periodClosures.month))
    .all();

  return rows.map((c) => {
    const { from, to } = rangeOf(c.year, c.month);
    /**
     * 用 `periodFlow` 而不是自己聚合：它是「统计口径」的单一出口
     * （金额取 `actual_amount`、排除转账与调整），关账页展示的数字
     * 必须与概览页的「该月收支」完全一致，否则用户会以为对不上账。
     * `flow.txCount` 同时充当该期间的账单数，无需再查一次。
     */
    const flow = periodFlow(ctx, ledgerId, from, to);
    return {
      id: c.id,
      year: c.year,
      month: c.month,
      period: `${c.year}-${String(c.month).padStart(2, '0')}`,
      closedAt: c.closedAt,
      closedBy: c.closedBy ? { id: c.closedBy, nickname: names.get(c.closedBy) ?? '—' } : null,
      note: c.note,
      transactionCount: flow.txCount,
      totalExpense: formatCents(flow.expense),
      totalIncome: formatCents(flow.income),
    };
  });
}

export interface CloseInput {
  year: number;
  month: number;
  note?: string | null;
}

export function closePeriod(ctx: AppCtx, actorId: string, ledgerId: string, input: CloseInput): ClosureDto {
  const { year, month } = input;
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw HttpError.validation([{ field: 'year', message: '年份不合法' }]);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw HttpError.validation([{ field: 'month', message: '月份需在 1-12 之间' }]);
  }

  // ① 不允许关闭当前月与未来月份
  const now = new Date();
  const curPeriod = now.getFullYear() * 12 + (now.getMonth() + 1);
  const target = year * 12 + month;
  if (target >= curPeriod) {
    throw HttpError.business(
      target === curPeriod
        ? '当前月不能结账 —— 本月还在记账，需要锁定请用「对账」确认余额'
        : '不能结账未来的月份',
    );
  }

  // ② 重复关账 → 409（幂等键是 year+month 上的唯一索引）
  if (isClosed(ctx, ledgerId, year, month)) {
    throw HttpError.duplicate(`${year}-${String(month).padStart(2, '0')} 已经结账过了`);
  }

  const id = newId(ID_PREFIX.periodClosure);
  const at = nowIso();
  ctx.db
    .insert(periodClosures)
    .values({
      id,
      ledgerId,
      year,
      month,
      closedAt: at,
      closedBy: actorId,
      note: input.note?.trim() || null,
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'close_period',
    entityType: 'period_closure',
    entityId: id,
    summary: `结账 ${year}-${String(month).padStart(2, '0')}`,
    after: { year, month, note: input.note ?? null },
  });

  return listClosures(ctx, ledgerId, year).find((c) => c.id === id)!;
}

/** 解除结账（`docs/05 §17.4`，仅 owner/admin —— 权限在路由层校验） */
/**
 * 解除结账（X-03 解锁留痕）。
 *
 * ⚠️ 解锁后可改历史数据，是**高风险动作**，必须记理由。
 * 光有 `writeAudit` 不够：审计日志是流水，回答不了「这个月一共解锁了几次、
 * 每次什么理由」；`period_reopen_logs` 是独立台账，按月一查就有。
 */
export function reopenPeriod(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  reason?: string | null,
): { id: string; logged: boolean } {
  const row = ctx.db
    .select()
    .from(periodClosures)
    .where(and(eq(periodClosures.ledgerId, ledgerId), eq(periodClosures.id, id)))
    .get();
  if (!row) throw HttpError.notFound('结账记录不存在');

  ctx.db.delete(periodClosures).where(eq(periodClosures.id, id)).run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'reopen_period',
    entityType: 'period_closure',
    entityId: id,
    summary: `解除结账 ${row.year}-${String(row.month).padStart(2, '0')}`,
    before: { year: row.year, month: row.month },
  });

  const reasonText = (reason ?? '').trim();
  ctx.db
    .insert(periodReopenLogs)
    .values({
      id: newId(ID_PREFIX.periodReopenLog),
      ledgerId,
      year: row.year,
      month: row.month,
      // 理由为空也允许落库，但内容写「未填写」—— 让「没写理由」这件事可见，
      // 而不是留一个空白让人以为系统没记录。
      reason: reasonText || '未填写',
      actorId,
      createdAt: nowIso(),
    })
    .run();

  return { id, logged: true };
}

/** 某期间是否落在「已结账的年份里」之前 —— 供设置页展示 */
export function closedPeriodsOf(ctx: AppCtx, ledgerId: string): string[] {
  return ctx.db
    .select({ year: periodClosures.year, month: periodClosures.month })
    .from(periodClosures)
    .where(eq(periodClosures.ledgerId, ledgerId))
    .all()
    .map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`);
}
