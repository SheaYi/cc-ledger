/**
 * 分期计划（`docs/05 §十二` + `docs/04 §十一`）。
 *
 * ## 一句话模型（`docs/05 §12.2`）
 *
 * > **分期 = 一次支出 + 多次转账还款。分期计划只负责调度还款，绝不生成支出账单。**
 *
 * 建计划时生成**唯一**一笔支出（记在负债账户上，`start_transaction_id`）；
 * 之后每一期生成的是**转账**（主账户 −X，负债账户 +X）。
 * 每期都生成支出的做法会让总支出虚增（12000 的手机记成 12×1000 = 12000 还算对，
 * 但预扣整期款再逐期「支出」就是 12000 + 12000 = 24000）。
 *
 * ## 校验纪律（上轮三个 bug 的教训）
 *
 * 规则层的校验**必须逐条对齐生成路径**（`transactions.createTransaction` 的要求）：
 * 分类必填且类型匹配、账户存在/未归档/非虚拟、转账两端不能相同。
 * 否则就是「计划建得出来、每期还款天天 400，而用户只在服务端日志里看得到」。
 * `assertGeneratable()` 就是这条纪律的落地 —— **每次生成前都再校验一次**，
 * 因为账户可能在计划存了半年之后才被归档。
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import {
  accounts,
  categories,
  installmentPlans,
  installmentSchedules,
  transactions,
} from '../../db/schema.js';
import { DEFAULT_DIRECTION, LIMITS, type RecordType } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { formatCents, nowIso, today as todayStr } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { createTransaction } from '../transactions/service.js';
import { nextDueDate, type Frequency } from '../recurring/schedule.js';
import {
  grandTotalOf,
  splitPeriods,
  type FeeHandling,
  type FeeMode,
} from './split.js';

export type PlanStatus = 'active' | 'settled' | 'cancelled';
export type ScheduleStatus = 'pending' | 'paid';

export interface PlanDto {
  id: string;
  title: string;
  status: PlanStatus;
  totalAmount: string;
  totalFee: string;
  /** 本金 + 手续费 —— 负债账户最终要还清的总额 */
  grandTotal: string;
  installmentCount: number;
  frequency: Frequency;
  firstDate: string;
  feeMode: FeeMode;
  feeHandling: FeeHandling;
  perPeriodFee: string;
  accountId: string;
  accountName: string | null;
  debtAccountId: string;
  debtAccountName: string | null;
  recordType: RecordType;
  categoryId: string | null;
  categoryName: string | null;
  merchant: string | null;
  note: string | null;
  startTransactionId: string | null;
  createdAt: string;
  /** 进度（`docs/04 §十一` 的响应形状） */
  progress: {
    paidCount: number;
    totalCount: number;
    paidAmount: string;
    remainingAmount: string;
    /** 下一期该还多少（`scheduleId` 供前端直接调 `/installment-schedules/:id/pay`） */
    nextDue: { scheduleId: string; seq: number; dueDate: string; totalDue: string } | null;
  };
  warnings: { field: string; level: 'warn' | 'error'; message: string }[];
}

const PLAN_COLUMNS = {
  id: installmentPlans.id,
  /** ⚠️ 必须显式选中：生成还款账单时要用它（见 recurring 踩过的同一个坑） */
  ledgerId: installmentPlans.ledgerId,
  title: installmentPlans.title,
  totalAmount: installmentPlans.totalAmount,
  totalFee: installmentPlans.totalFee,
  installmentCount: installmentPlans.installmentCount,
  frequency: installmentPlans.frequency,
  firstDate: installmentPlans.firstDate,
  feeMode: installmentPlans.feeMode,
  perPeriodFee: installmentPlans.perPeriodFee,
  feeHandling: installmentPlans.feeHandling,
  accountId: installmentPlans.accountId,
  debtAccountId: installmentPlans.debtAccountId,
  recordType: installmentPlans.recordType,
  categoryId: installmentPlans.categoryId,
  merchant: installmentPlans.merchant,
  note: installmentPlans.note,
  status: installmentPlans.status,
  startTransactionId: installmentPlans.startTransactionId,
  createdAt: installmentPlans.createdAt,
} as const;

type PlanRow = typeof installmentPlans.$inferSelect;
type SchedRow = typeof installmentSchedules.$inferSelect;

interface Refs {
  accountName: Map<string, string>;
  accountArchived: Set<string>;
  accountVirtual: Set<string>;
  categoryName: Map<string, string>;
  categoryArchived: Set<string>;
  categoryRecordType: Map<string, string>;
}

function loadRefs(ctx: AppCtx, ledgerId: string): Refs {
  const accs = ctx.db
    .select({
      id: accounts.id,
      name: accounts.name,
      archivedAt: accounts.archivedAt,
      kind: accounts.kind,
    })
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
  const cats = ctx.db
    .select({
      id: categories.id,
      name: categories.name,
      archivedAt: categories.archivedAt,
      recordType: categories.recordType,
    })
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .all();
  return {
    accountName: new Map(accs.map((a) => [a.id, a.name])),
    accountArchived: new Set(accs.filter((a) => a.archivedAt).map((a) => a.id)),
    accountVirtual: new Set(accs.filter((a) => a.kind === 'virtual').map((a) => a.id)),
    categoryName: new Map(cats.map((c) => [c.id, c.name])),
    categoryArchived: new Set(cats.filter((c) => c.archivedAt).map((c) => c.id)),
    categoryRecordType: new Map(cats.map((c) => [c.id, c.recordType])),
  };
}

function schedulesOf(ctx: AppCtx, planId: string): SchedRow[] {
  return ctx.db
    .select()
    .from(installmentSchedules)
    .where(eq(installmentSchedules.planId, planId))
    .orderBy(asc(installmentSchedules.seq))
    .all();
}

function toDto(p: PlanRow, refs: Refs, scheds: SchedRow[]): PlanDto {
  const warnings: PlanDto['warnings'] = [];
  for (const [field, id] of [
    ['accountId', p.accountId],
    ['debtAccountId', p.debtAccountId],
  ] as const) {
    if (!refs.accountName.has(id)) {
      warnings.push({ field, level: 'error', message: '账户已删除，本计划无法再生成还款' });
    } else if (refs.accountArchived.has(id)) {
      warnings.push({ field, level: 'error', message: '账户已停用，本计划无法再生成还款' });
    } else if (refs.accountVirtual.has(id)) {
      warnings.push({ field, level: 'error', message: '账户是虚拟账户（债权/债务/手续费），不能用于分期' });
    }
  }
  if (p.categoryId) {
    if (!refs.categoryName.has(p.categoryId)) {
      warnings.push({ field: 'categoryId', level: 'error', message: '分类已删除' });
    } else if (refs.categoryArchived.has(p.categoryId)) {
      warnings.push({ field: 'categoryId', level: 'warn', message: '分类已停用' });
    }
  }

  const paid = scheds.filter((s) => s.status === 'paid');
  const paidAmount = paid.reduce((a, s) => a + s.totalDue, 0);
  const grand = grandTotalOf(p.totalAmount, p.totalFee);
  const next = scheds.find((s) => s.status === 'pending') ?? null;

  return {
    id: p.id,
    title: p.title,
    status: p.status as PlanStatus,
    totalAmount: formatCents(p.totalAmount),
    totalFee: formatCents(p.totalFee),
    grandTotal: formatCents(grand),
    installmentCount: p.installmentCount,
    frequency: p.frequency as Frequency,
    firstDate: p.firstDate,
    feeMode: p.feeMode as FeeMode,
    feeHandling: p.feeHandling as FeeHandling,
    perPeriodFee: formatCents(p.perPeriodFee),
    accountId: p.accountId,
    accountName: refs.accountName.get(p.accountId) ?? null,
    debtAccountId: p.debtAccountId,
    debtAccountName: refs.accountName.get(p.debtAccountId) ?? null,
    recordType: p.recordType as RecordType,
    categoryId: p.categoryId,
    categoryName: p.categoryId ? refs.categoryName.get(p.categoryId) ?? null : null,
    merchant: p.merchant,
    note: p.note,
    startTransactionId: p.startTransactionId,
    createdAt: p.createdAt,
    progress: {
      paidCount: paid.length,
      totalCount: scheds.length,
      paidAmount: formatCents(paidAmount),
      remainingAmount: formatCents(Math.max(0, grand - paidAmount)),
    /**
     * 下一期该还多少。
     * ⚠️ `scheduleId` 是给前端「还下一期」用的 —— 还款接口的地址是
     *    `POST /installment-schedules/:scheduleId/pay`，只有 seq 的话前端得
     *    先拉一遍完整期表才能点这个按钮，白跑一趟而且是多余的状态。
     *    它对 `docs/04 §十一` 的形状是**纯增量**，不会打破既有消费方。
     */
    nextDue: next
      ? { scheduleId: next.id, seq: next.seq, dueDate: next.dueDate, totalDue: formatCents(next.totalDue) }
      : null,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

export function listPlans(ctx: AppCtx, ledgerId: string, status?: string): PlanDto[] {
  // installment_plans 没有 archived_at —— 它是**硬删**设计（schedules 级联删），
  // 所以这里不能像别的模块那样加 archivedAt IS NULL。
  const conditions = [eq(installmentPlans.ledgerId, ledgerId)];
  if (status === 'active') conditions.push(eq(installmentPlans.status, 'active'));
  else if (status) conditions.push(eq(installmentPlans.status, status));
  const rows = ctx.db
    .select(PLAN_COLUMNS)
    .from(installmentPlans)
    .where(and(...conditions))
    // 进行中在前；同类按到期日（= 第一期）升序 —— 最后一项 id 保证确定性
    .orderBy(desc(sql`coalesce(${installmentPlans.status}, 'active')`), asc(installmentPlans.firstDate), asc(installmentPlans.id))
    .all() as PlanRow[];
  const refs = loadRefs(ctx, ledgerId);
  return rows.map((p) => toDto(p, refs, schedulesOf(ctx, p.id)));
}

function requirePlan(ctx: AppCtx, ledgerId: string, id: string): PlanRow {
  const row = ctx.db
    .select(PLAN_COLUMNS)
    .from(installmentPlans)
    .where(and(eq(installmentPlans.id, id), eq(installmentPlans.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('分期计划不存在');
  return row as PlanRow;
}

export function getPlan(ctx: AppCtx, ledgerId: string, id: string): PlanDto {
  const p = requirePlan(ctx, ledgerId, id);
  return toDto(p, loadRefs(ctx, ledgerId), schedulesOf(ctx, id));
}

/* ------------------------------------------------------------------ *
 * 校验（上轮教训：必须逐条对齐 createTransaction 的要求）
 * ------------------------------------------------------------------ */

interface PlanInput {
  title: string;
  totalAmount: number;
  totalFee?: number;
  perPeriodFee?: number;
  installmentCount: number;
  frequency?: Frequency;
  firstDate: string;
  feeMode?: FeeMode;
  feeHandling?: FeeHandling;
  accountId: string;
  debtAccountId: string;
  recordType?: RecordType;
  categoryId?: string | null;
  merchant?: string | null;
  note?: string | null;
}

/**
 * 校验「这个计划**生成得出**账单」。
 * 在建计划时跑一次、每次生成前再跑一次 —— 账户可能半年后才被归档。
 */
function validate(ctx: AppCtx, ledgerId: string, input: PlanInput) {
  const issues: { field: string; message: string }[] = [];
  const refs = loadRefs(ctx, ledgerId);

  for (const [field, id] of [
    ['accountId', input.accountId],
    ['debtAccountId', input.debtAccountId],
  ] as const) {
    if (!refs.accountName.has(id)) {
      issues.push({ field, message: '账户不存在' });
    } else if (refs.accountArchived.has(id)) {
      issues.push({ field, message: '账户已停用，不能用于分期' });
    } else if (refs.accountVirtual.has(id)) {
      issues.push({ field, message: '不能使用虚拟账户（债权/债务/手续费）' });
    }
  }
  if (input.accountId === input.debtAccountId) {
    issues.push({ field: 'debtAccountId', message: '还款账户与负债账户不能相同' });
  }

  const rt: RecordType = input.recordType ?? 'expense';
  // 分类**必填**：首笔支出走 createTransaction，缺了直接 400「请选择分类」
  if (!input.categoryId) {
    issues.push({ field: 'categoryId', message: '分期必须指定分类（首笔支出要记）' });
  } else if (!refs.categoryName.has(input.categoryId)) {
    issues.push({ field: 'categoryId', message: '分类不存在' });
  } else if (refs.categoryArchived.has(input.categoryId)) {
    issues.push({ field: 'categoryId', message: '分类已停用' });
  } else if (refs.categoryRecordType.get(input.categoryId) !== rt) {
    issues.push({ field: 'categoryId', message: '分类与记录类型不匹配' });
  }

  if (!Number.isInteger(input.totalAmount) || input.totalAmount <= 0) {
    issues.push({ field: 'totalAmount', message: '分期总额必须大于 0' });
  }
  if (input.totalAmount > LIMITS.AMOUNT_MAX_CENTS) {
    issues.push({ field: 'totalAmount', message: '分期总额超出单笔上限' });
  }
  if (!Number.isInteger(input.installmentCount) || input.installmentCount < 1 || input.installmentCount > 60) {
    issues.push({ field: 'installmentCount', message: '期数需在 1-60 之间' });
  }
  const totalFee = input.totalFee ?? 0;
  if (totalFee < 0) {
    issues.push({ field: 'totalFee', message: '手续费不能为负' });
  }
  if (input.feeMode === 'per_period' && (input.perPeriodFee ?? 0) < 0) {
    issues.push({ field: 'perPeriodFee', message: '每期手续费不能为负' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstDate ?? '')) {
    issues.push({ field: 'firstDate', message: '首期日期格式必须是 YYYY-MM-DD' });
  }

  if (issues.length) throw HttpError.validation(issues);

  // 生成得出吗？先算一次期表（顺带验证拆分不抛）
  const feeMode: FeeMode = input.feeMode ?? 'once';
  const periods = splitPeriods({
    totalAmount: input.totalAmount,
    totalFee,
    perPeriodFee: input.perPeriodFee ?? 0,
    feeMode,
    feeHandling: input.feeHandling ?? 'first_period',
    count: input.installmentCount,
  });
  // 首笔支出也要生成得出来 —— 它是唯一一笔支出，失败等于整个计划白建
  const grand = grandTotalOf(input.totalAmount, totalFee);
  if (grand > LIMITS.AMOUNT_MAX_CENTS) {
    throw HttpError.validation([{ field: 'totalFee', message: '本金加手续费超出单笔上限' }]);
  }
  void periods;
}

/* ------------------------------------------------------------------ *
 * 创建（同时生成首笔支出与全部期表）
 * ------------------------------------------------------------------ */

/** 每期的应还日：首期用 firstDate，其余按频率顺推（月末容错由 schedule.ts 负责） */
function dueDatesOf(frequency: Frequency, firstDate: string, count: number): string[] {
  const out: string[] = [firstDate];
  let cursor = firstDate;
  const sched = {
    frequency,
    intervalCount: 1,
    startDate: firstDate,
    maxMonthEnd: true,
  } as const;
  for (let i = 1; i < count; i++) {
    const next = nextDueDate({ ...sched }, cursor);
    if (!next) {
      // 频率组合算不出下一期（理论上不会，见 validate）—— 保守按月末推进
      const parts = cursor.split('-').map(Number);
      const y = parts[0] ?? new Date().getFullYear();
      const m = parts[1] ?? 1;
      const d = parts[2] ?? 1;
      const dt = new Date(y, m, Math.min(d, new Date(y, m, 0).getDate()));
      const pad = (n: number) => String(n).padStart(2, '0');
      out.push(`${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`);
      cursor = out[out.length - 1] ?? cursor;
      continue;
    }
    out.push(next);
    cursor = next;
  }
  return out;
}

export function createPlan(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: PlanInput,
): { plan: PlanDto; startTransaction: { id: string; actualAmount: string } } {
  const dup = ctx.db
    .select({ id: installmentPlans.id })
    .from(installmentPlans)
    .where(
      and(
        eq(installmentPlans.ledgerId, ledgerId),
        eq(installmentPlans.title, input.title),
      ),
    )
    .get();
  if (dup) throw HttpError.duplicate('同名分期计划已存在');

  validate(ctx, ledgerId, input);

  const feeMode: FeeMode = input.feeMode ?? 'once';
  const feeHandling: FeeHandling = input.feeHandling ?? 'first_period';
  const recordType: RecordType = input.recordType ?? 'expense';
  // 每期收时，总手续费 = 每期 × 期数（totalFee 由它推导，免得两处打架）
  const totalFee =
    feeMode === 'per_period' ? (input.perPeriodFee ?? 0) * input.installmentCount : input.totalFee ?? 0;
  const perPeriodFee = feeMode === 'per_period' ? input.perPeriodFee ?? 0 : 0;
  const grand = grandTotalOf(input.totalAmount, totalFee);

  const periods = splitPeriods({
    totalAmount: input.totalAmount,
    totalFee,
    perPeriodFee,
    feeMode,
    feeHandling,
    count: input.installmentCount,
  });
  const dueDates = dueDatesOf((input.frequency ?? 'monthly') as Frequency, input.firstDate, input.installmentCount);

  /**
   * 首笔支出：**唯一**的一笔支出（`docs/05 §12.2`）。
   * 记在负债账户上 —— 消费是刷信用卡，支出属于那张卡。
   */
  const startTx = createTransaction(ctx, actorId, ledgerId, {
    recordType,
    direction: DEFAULT_DIRECTION[recordType],
    accountId: input.debtAccountId,
    categoryId: input.categoryId,
    name: input.title,
    merchant: input.merchant,
    note: input.note,
    /**
     * ⚠️ `createTransaction` 的 amount 语义是**元**（内部会 parseAmountToCents），
     * 而计划表里存的是**分**。直接传 `input.totalAmount` 等于把 1200000 分当成
     * 1200000 元再乘 100 = **1.2 亿元**。周期账单已经踩过一次，这里照抄修法。
     */
    amount: formatCents(input.totalAmount),
    fee: formatCents(totalFee),
    txDate: input.firstDate,
    // 幂等：同一计划只会有一笔首期支出
    clientRequestId: `plan:${ledgerId}:${input.title}:start`,
  });

  const id = newId(ID_PREFIX.installmentPlan);
  const at = nowIso();
  ctx.db.transaction((tx) => {
    tx.insert(installmentPlans)
      .values({
        id,
        ledgerId,
        title: input.title,
        totalAmount: input.totalAmount,
        totalFee,
        installmentCount: input.installmentCount,
        frequency: input.frequency ?? 'monthly',
        firstDate: input.firstDate,
        feeMode,
        perPeriodFee,
        feeHandling,
        accountId: input.accountId,
        debtAccountId: input.debtAccountId,
        recordType,
        categoryId: input.categoryId,
        merchant: input.merchant,
        note: input.note,
        status: 'active',
        startTransactionId: startTx.row.id,
        createdBy: actorId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    for (const p of periods) {
      tx.insert(installmentSchedules)
        .values({
          id: newId(ID_PREFIX.installmentSchedule),
          planId: id,
          ledgerId,
          seq: p.seq,
          // dueDates 与 periods 同长（都在 validate 里按 count 生成），取不到就退回首期
          dueDate: dueDates[p.seq - 1] ?? input.firstDate,
          principal: p.principal,
          fee: p.fee,
          totalDue: p.totalDue,
          status: 'pending',
        })
        .run();
    }
  });

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'installment_plan',
    entityId: id,
    summary: `新建分期计划 ${input.title}`,
    after: {
      title: input.title,
      totalAmount: input.totalAmount,
      totalFee,
      count: input.installmentCount,
      startTransactionId: startTx.row.id,
    },
  });

  return {
    plan: getPlan(ctx, ledgerId, id),
    startTransaction: { id: startTx.row.id, actualAmount: formatCents(grand) },
  };
}

/* ------------------------------------------------------------------ *
 * 更新（改了金额/期数会重建期表，已还的期保留）
 * ------------------------------------------------------------------ */

export function updatePlan(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  patch: Partial<PlanInput> & { status?: PlanStatus },
): PlanDto {
  const before = requirePlan(ctx, ledgerId, id);
  if (patch.title) {
    const dup = ctx.db
      .select({ id: installmentPlans.id })
      .from(installmentPlans)
      .where(
        and(
          eq(installmentPlans.ledgerId, ledgerId),
          eq(installmentPlans.title, patch.title),
          sql`${installmentPlans.id} <> ${id}`,
        ),
      )
      .get();
    if (dup) throw HttpError.duplicate('同名分期计划已存在');
  }

  /**
   * 合并后的形态：**必填字段都已是确定值**（PlanInput 里它们是 optional，因为创建时可选），
   * 后面按确定值用。逐处 ?? 会留一串类型错误，索性在类型上就说清楚。
   */
  type Resolved = PlanInput & {
    totalAmount: number;
    installmentCount: number;
    frequency: Frequency;
    firstDate: string;
    feeMode: FeeMode;
    feeHandling: FeeHandling;
    accountId: string;
    debtAccountId: string;
    recordType: RecordType;
  };
  const merged: Resolved = {
    title: patch.title ?? before.title,
    totalAmount: patch.totalAmount ?? before.totalAmount,
    totalFee: patch.totalFee ?? before.totalFee,
    perPeriodFee: patch.perPeriodFee ?? before.perPeriodFee,
    installmentCount: patch.installmentCount ?? before.installmentCount,
    // 合并后**必填字段全部补齐默认值** —— PlanInput 里它们是 optional（创建时可选），
    // 但 update 之后要当成确定值用，逐个 ?? 会留下一串 undefined 类型错误
    frequency: (patch.frequency ?? before.frequency ?? 'monthly') as Frequency,
    firstDate: patch.firstDate ?? before.firstDate ?? todayStr(),
    feeMode: (patch.feeMode ?? before.feeMode ?? 'once') as FeeMode,
    feeHandling: (patch.feeHandling ?? before.feeHandling ?? 'first_period') as FeeHandling,
    accountId: patch.accountId ?? before.accountId,
    debtAccountId: patch.debtAccountId ?? before.debtAccountId,
    recordType: (patch.recordType ?? before.recordType ?? 'expense') as RecordType,
    categoryId: patch.categoryId === undefined ? before.categoryId : patch.categoryId,
    merchant: patch.merchant === undefined ? before.merchant : patch.merchant,
    note: patch.note === undefined ? before.note : patch.note,
  };
  validate(ctx, ledgerId, merged);

  const set: Partial<typeof installmentPlans.$inferInsert> = { updatedAt: nowIso() };
  for (const k of [
    'title', 'totalAmount', 'totalFee', 'perPeriodFee', 'installmentCount',
    'frequency', 'firstDate', 'feeMode', 'feeHandling', 'accountId', 'debtAccountId',
    'recordType', 'categoryId', 'merchant', 'note',
  ] as const) {
    const v = patch[k as keyof PlanInput];
    if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  }
  if (patch.status !== undefined) set.status = patch.status;
  ctx.db.update(installmentPlans).set(set).where(eq(installmentPlans.id, id)).run();

  /**
   * 改了总额/期数/费率 → **未还的**期表必须重算，否则「12 期还完归零」的恒等式会破。
   * 已还的期**原样保留** —— 它们是已经发生的事实，不该被追改（同「一期金额是快照」）。
   */
  const moneyChanged =
    patch.totalAmount !== undefined ||
    patch.totalFee !== undefined ||
    patch.perPeriodFee !== undefined ||
    patch.installmentCount !== undefined ||
    patch.feeMode !== undefined ||
    patch.feeHandling !== undefined ||
    patch.firstDate !== undefined ||
    patch.frequency !== undefined;

  if (moneyChanged) {
    const paid = schedulesOf(ctx, id).filter((s) => s.status === 'paid');
    const paidPrincipal = paid.reduce((a, s) => a + s.principal, 0);
    const paidFee = paid.reduce((a, s) => a + s.fee, 0);
    // 未还部分的期数 = 总期数 − 已还期数
    const restCount = Math.max(0, merged.installmentCount - paid.length);
    ctx.db.transaction((tx) => {
      tx.delete(installmentSchedules)
        .where(eq(installmentSchedules.planId, id))
        .run();
      // 已还的先原样写回
      for (const s of paid) {
        tx.insert(installmentSchedules)
          .values({
            id: s.id,
            planId: id,
            ledgerId,
            seq: s.seq,
            dueDate: s.dueDate,
            principal: s.principal,
            fee: s.fee,
            totalDue: s.totalDue,
            status: 'paid',
            paidAt: s.paidAt,
            repayTxId: s.repayTxId,
          })
          .run();
      }
      if (restCount === 0) return;
      const periods = splitPeriods({
        totalAmount: Math.max(0, merged.totalAmount - paidPrincipal),
        totalFee: Math.max(0, (merged.totalFee ?? 0) - paidFee),
        perPeriodFee: merged.feeMode === 'per_period' ? merged.perPeriodFee ?? 0 : 0,
        feeMode: merged.feeMode,
        feeHandling: merged.feeHandling,
        count: restCount,
      });
      const lastDue = paid[paid.length - 1]?.dueDate;
      const lastPaid: string = lastDue ?? merged.firstDate;
      const dates = dueDatesOf(
        merged.frequency,
        lastPaid,
        restCount + paid.length,
      );
      for (const p of periods) {
        const seq = paid.length + p.seq;
        tx.insert(installmentSchedules)
          .values({
            id: newId(ID_PREFIX.installmentSchedule),
            planId: id,
            ledgerId,
            seq,
            dueDate: dates[seq - 1] ?? merged.firstDate,
            principal: p.principal,
            fee: p.fee,
            totalDue: p.totalDue,
            status: 'pending',
          })
          .run();
      }
    });
  }

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'installment_plan',
    entityId: id,
    summary: `修改分期计划 ${merged.title}`,
    before: { title: before.title, totalAmount: before.totalAmount, count: before.installmentCount },
    after: set,
  });
  return getPlan(ctx, ledgerId, id);
}

/* ------------------------------------------------------------------ *
 * 还款：每一期生成的是**转账**
 * ------------------------------------------------------------------ */

function requireSchedule(ctx: AppCtx, ledgerId: string, scheduleId: string) {
  const row = ctx.db
    .select()
    .from(installmentSchedules)
    .where(
      and(eq(installmentSchedules.id, scheduleId), eq(installmentSchedules.ledgerId, ledgerId)),
    )
    .get();
  if (!row) throw HttpError.notFound('分期明细不存在');
  return row as SchedRow;
}

/**
 * 标记某期已还：生成一笔**转账**（主账户 −X → 负债账户 +X）。
 *
 * ⚠️ 这里绝对不能生成支出（`docs/05 §12.2`）。转账两头都动，负债账户才会归零。
 * 幂等：同一期重复点，第二次直接返回原结果（`repay_tx_id` 已存在）。
 */
export function paySchedule(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  scheduleId: string,
  opts: { txDate?: string } = {},
) {
  const s = requireSchedule(ctx, ledgerId, scheduleId);
  const plan = requirePlan(ctx, ledgerId, s.planId);

  if (plan.status === 'cancelled') {
    throw HttpError.validation([{ field: 'status', message: '分期计划已取消，不能再还款' }]);
  }
  if (s.status === 'paid') {
    return {
      schedule: { ...s, totalDue: formatCents(s.totalDue) },
      transactionId: s.repayTxId,
      reused: true,
    };
  }

  // 生成前**再校验一次**：账户可能在这半年里被归档（validate 的纪律）
  validate(ctx, ledgerId, {
    title: plan.title,
    totalAmount: plan.totalAmount,
    totalFee: plan.totalFee,
    perPeriodFee: plan.perPeriodFee,
    installmentCount: plan.installmentCount,
    frequency: plan.frequency as Frequency,
    firstDate: plan.firstDate,
    feeMode: plan.feeMode as FeeMode,
    feeHandling: plan.feeHandling as FeeHandling,
    accountId: plan.accountId,
    debtAccountId: plan.debtAccountId,
    recordType: plan.recordType as RecordType,
    categoryId: plan.categoryId,
    merchant: plan.merchant,
    note: plan.note,
  });

  const txDate = opts.txDate ?? s.dueDate;
  const res = createTransaction(ctx, actorId, ledgerId, {
    recordType: 'transfer',
    direction: DEFAULT_DIRECTION.transfer,
    accountId: plan.accountId,
    toAccountId: plan.debtAccountId,
    name: plan.title,
    note: `第 ${s.seq}/${plan.installmentCount} 期`,
    // 同上：期表存的是分，传给 createTransaction 要先转元字符串
    amount: formatCents(s.totalDue),
    txDate,
    // 幂等：同一期永远同一个键，重复调用不会产生第二笔
    clientRequestId: `ins:${plan.id}:${s.seq}`,
  });

  ctx.db
    .update(installmentSchedules)
    .set({ status: 'paid', paidAt: nowIso(), repayTxId: res.row.id })
    .where(eq(installmentSchedules.id, scheduleId))
    .run();

  // 全部还完 → 计划结清
  const all = schedulesOf(ctx, plan.id);
  if (all.every((x) => x.status === 'paid') && plan.status === 'active') {
    ctx.db
      .update(installmentPlans)
      .set({ status: 'settled', updatedAt: nowIso() })
      .where(eq(installmentPlans.id, plan.id))
      .run();
  } else {
    ctx.db.update(installmentPlans).set({ updatedAt: nowIso() }).where(eq(installmentPlans.id, plan.id)).run();
  }

  return {
    schedule: {
      id: s.id,
      seq: s.seq,
      dueDate: s.dueDate,
      principal: formatCents(s.principal),
      fee: formatCents(s.fee),
      totalDue: formatCents(s.totalDue),
      status: 'paid' as const,
    },
    transactionId: res.row.id,
    reused: res.reused,
  };
}

/** 提前结清：把剩余未还的期合并成**一笔**转账，金额 = 剩余全部应还 */
export function settleEarly(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  opts: { txDate?: string } = {},
) {
  const plan = requirePlan(ctx, ledgerId, id);
  if (plan.status !== 'active') {
    throw HttpError.business(plan.status === 'settled' ? '该分期已还清' : '该分期已取消');
  }
  const pending = schedulesOf(ctx, id).filter((s) => s.status === 'pending');
  if (!pending.length) throw HttpError.business('没有未还的期');
  const remain = pending.reduce((a, s) => a + s.totalDue, 0);

  // 结清只生成**转账**，同样走 createTransaction；accountId 用第一期的（日期最早那期）
  const first = pending[0];
  const res = createTransaction(ctx, actorId, ledgerId, {
    recordType: 'transfer',
    direction: DEFAULT_DIRECTION.transfer,
    accountId: plan.accountId,
    toAccountId: plan.debtAccountId,
    name: plan.title,
    note: `提前结清（${pending.length} 期）`,
    amount: formatCents(remain),
    txDate: opts.txDate ?? todayStr(),
    clientRequestId: `ins:${plan.id}:settle-early`,
  });

  ctx.db.transaction((tx) => {
    for (const s of pending) {
      tx.update(installmentSchedules)
        .set({ status: 'paid', paidAt: nowIso(), repayTxId: res.row.id })
        .where(eq(installmentSchedules.id, s.id))
        .run();
    }
    tx.update(installmentPlans)
      .set({ status: 'settled', updatedAt: nowIso() })
      .where(eq(installmentPlans.id, id))
      .run();
  });

  void first;
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'installment_plan',
    entityId: id,
    summary: `提前结清 ${plan.title}`,
    after: { remaining: remain, periods: pending.length, transactionId: res.row.id },
  });
  return { transactionId: res.row.id, amount: formatCents(remain), periods: pending.length, reused: res.reused };
}

/**
 * 取消分期：**只取消未还的期**，已还的不动，首笔支出也不动。
 * 「取消」不等于「这笔消费没发生」—— 用户可能只是不想继续还了。
 */
export function cancelPlan(ctx: AppCtx, actorId: string, ledgerId: string, id: string) {
  const plan = requirePlan(ctx, ledgerId, id);
  if (plan.status === 'settled') throw HttpError.business('该分期已还清，无法取消');
  if (plan.status === 'cancelled') return { id, alreadyCancelled: true };

  ctx.db.transaction((tx) => {
    tx.update(installmentPlans)
      .set({ status: 'cancelled', updatedAt: nowIso() })
      .where(eq(installmentPlans.id, id))
      .run();
  });
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'installment_plan',
    entityId: id,
    summary: `取消分期 ${plan.title}（首笔支出与已还的期保留）`,
  });
  return getPlan(ctx, ledgerId, id);
}

export function deletePlan(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const plan = requirePlan(ctx, ledgerId, id);
  const paid = schedulesOf(ctx, id).filter((s) => s.status === 'paid');
  if (paid.length) {
    // 已经还过期的账还在，删掉计划会让那些转账失去出处 —— 用取消代替删除
    throw HttpError.business(
      `已还 ${paid.length} 期，不能删除（请用「取消分期」）`,
    );
  }
  ctx.db.transaction((tx) => {
    // 硬删：级联会带走未还的期（已还的不允许删，见上面的拦截）
    tx.delete(installmentSchedules).where(eq(installmentSchedules.planId, id)).run();
    tx.delete(installmentPlans).where(eq(installmentPlans.id, id)).run();
  });
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'installment_plan',
    entityId: id,
    summary: `删除分期计划 ${plan.title}`,
  });
  return { id };
}

export function schedulesOfPlan(ctx: AppCtx, ledgerId: string, id: string) {
  requirePlan(ctx, ledgerId, id);
  return schedulesOf(ctx, id).map((s) => ({
    id: s.id,
    seq: s.seq,
    dueDate: s.dueDate,
    principal: formatCents(s.principal),
    fee: formatCents(s.fee),
    totalDue: formatCents(s.totalDue),
    status: s.status,
    paidAt: s.paidAt,
    repayTxId: s.repayTxId,
  }));
}

/* ------------------------------------------------------------------ *
 * 调度器：到期的期自动还款（`docs/05 §12.3` 的步骤 2）
 * ------------------------------------------------------------------ */

export interface PayOutcome {
  planId: string;
  scheduleId: string;
  seq: number;
  paid: boolean;
  error?: string;
}

/** 扫全部 active 计划，把「到期且未还」的期还掉。返回明细供日志用。 */
export function payDueSchedules(ctx: AppCtx, opts: { today?: string } = {}) {
  const day = opts.today ?? todayStr();
  const plans = ctx.db
    .select(PLAN_COLUMNS)
    .from(installmentPlans)
    .where(eq(installmentPlans.status, 'active'))
    .all() as PlanRow[];

  const summary = { plans: plans.length, paid: 0, failed: 0 };
  const details: PayOutcome[] = [];

  for (const plan of plans) {
    const due = schedulesOf(ctx, plan.id).filter((s) => s.status === 'pending' && s.dueDate <= day);
    for (const s of due) {
      try {
        paySchedule(ctx, plan.createdBy, plan.ledgerId, s.id, { txDate: s.dueDate });
        summary.paid += 1;
        details.push({ planId: plan.id, scheduleId: s.id, seq: s.seq, paid: true });
      } catch (err) {
        summary.failed += 1;
        details.push({
          planId: plan.id,
          scheduleId: s.id,
          seq: s.seq,
          paid: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { today: day, summary, details };
}

/** 账户被归档前的守卫（`docs/05 §「删除有未结清分期的账户 → 拒绝」） */
export function assertAccountNotInActivePlan(ctx: AppCtx, ledgerId: string, accountId: string): void {
  const rows = ctx.db
    .select({ id: installmentPlans.id, title: installmentPlans.title })
    .from(installmentPlans)
    .where(
      and(
        eq(installmentPlans.ledgerId, ledgerId),
        eq(installmentPlans.status, 'active'),
        sql`(${installmentPlans.accountId} = ${accountId} OR ${installmentPlans.debtAccountId} = ${accountId})`,
      ),
    )
    .all();
  if (rows.length) {
    throw HttpError.business(`该账户有进行中的分期计划：${rows.map((r) => r.title).join('、')}`);
  }
}

/** 供其它模块复用：某计划的首笔支出（详情页要显示「这笔消费记在哪」） */
export function startTransactionOf(ctx: AppCtx, ledgerId: string, id: string) {
  const plan = requirePlan(ctx, ledgerId, id);
  if (!plan.startTransactionId) return null;
  const row = ctx.db
    .select({
      id: transactions.id,
      txDate: transactions.txDate,
      amount: transactions.amount,
      fee: transactions.fee,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(eq(transactions.id, plan.startTransactionId))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    txDate: row.txDate,
    amount: formatCents(row.amount),
    fee: formatCents(row.fee),
    deleted: !!row.deletedAt,
  };
}