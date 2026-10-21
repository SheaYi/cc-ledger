/**
 * 分期计划路由（`docs/04 §十一`），挂在 `/api/v1/ledgers/:ledgerId` 下。
 *
 * 相比 `docs/04` 多两个补充：
 *   · `POST /installment-plans/:id/cancel` 文档里有，实现上额外允许「已还 0 期」时删除；
 *   · `GET /installment-plans/:id/start-transaction` —— 详情页要显示「这笔消费记在哪一笔」，
 *     那是**唯一**的一笔支出，没有它用户会以为分期凭空多了一笔钱。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECORD_TYPES } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  cancelPlan,
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  paySchedule,
  schedulesOfPlan,
  settleEarly,
  startTransactionOf,
  updatePlan,
} from './service.js';

/**
 * 金额 → 分。
 *
 * ⚠️ 修掉一处**差 100 倍**的资金错误：原实现是
 *   `typeof v === 'number' ? Math.trunc(v) : Math.round(Number(v) * 100)`
 * 即**数字按「分」、字符串按「元」**解释同一个字段。于是
 *   `totalAmount: 12000`  →  12000 分 = ¥120.00
 *   `totalAmount: "12000"` → 1200000 分 = ¥12000.00
 * 前端若某处忘了 `String()`，分期总额就会少两位，而**没有任何报错**。
 *
 * 全站统一口径（`README §核心原则 2` + `utils/money.ts`）：
 * 无论传数字还是字符串，**一律按「元」解释**，由 `parseAmountToCents()` 独占转换。
 */
const cents = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return parseAmountToCents(v);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : '金额格式不正确',
      });
      return z.NEVER;
    }
  });

const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须是 YYYY-MM-DD');

const planBody = z.object({
  title: z.string().trim().min(1, '名称不能为空').max(40, '名称最多 40 字'),
  totalAmount: cents,
  totalFee: cents.optional(),
  perPeriodFee: cents.optional(),
  installmentCount: z.number().int().min(1).max(60),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
  firstDate: dayStr,
  feeMode: z.enum(['once', 'per_period']).optional(),
  feeHandling: z.enum(['first_period', 'per_period', 'manual_last']).optional(),
  accountId: z.string().min(1),
  debtAccountId: z.string().min(1),
  recordType: z.enum(RECORD_TYPES as unknown as [string, ...string[]]).optional(),
  categoryId: z.string().min(1).nullish(),
  merchant: z.string().max(50).nullish(),
  note: z.string().max(500).nullish(),
});

export async function registerInstallmentRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/installment-plans';

  app.get(base, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { status?: string };
    return ok(listPlans(ctx, m.ledgerId, q.status));
  });

  app.post(base, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(planBody, req.body);
    return reply.code(201).send(ok(createPlan(ctx, m.userId, m.ledgerId, body as never)));
  });

  app.get(`${base}/:planId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    return ok(getPlan(ctx, m.ledgerId, planId));
  });

  app.patch(`${base}/:planId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    const body = parseOrThrow(planBody.partial(), req.body);
    return ok(updatePlan(ctx, m.userId, m.ledgerId, planId, body as never));
  });

  app.delete(`${base}/:planId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    return ok(deletePlan(ctx, m.userId, m.ledgerId, planId));
  });

  app.post(`${base}/:planId/settle-early`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    const body = req.body && typeof req.body === 'object' ? (req.body as { txDate?: string }) : {};
    return ok(settleEarly(ctx, m.userId, m.ledgerId, planId, { txDate: body.txDate }));
  });

  app.post(`${base}/:planId/cancel`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    return ok(cancelPlan(ctx, m.userId, m.ledgerId, planId));
  });

  app.get(`${base}/:planId/schedules`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    return ok(schedulesOfPlan(ctx, m.ledgerId, planId));
  });

  /** 唯一那笔支出（详情页显示「这笔消费记在哪一笔」） */
  app.get(`${base}/:planId/start-transaction`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { planId } = req.params as { planId: string };
    return ok(startTransactionOf(ctx, m.ledgerId, planId));
  });

  /** 标记某期已还（生成转账账单） */
  app.post('/api/v1/ledgers/:ledgerId/installment-schedules/:scheduleId/pay', {
    preHandler: app.requireAuth,
  }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const { scheduleId } = req.params as { scheduleId: string };
    const body = req.body && typeof req.body === 'object' ? (req.body as { txDate?: string }) : {};
    const out = paySchedule(ctx, m.userId, m.ledgerId, scheduleId, { txDate: body.txDate });
    // 幂等命中时返回 200（本来就还过了），不是新建 201
    return reply.code(out.reused ? 200 : 201).send(ok(out));
  });
}