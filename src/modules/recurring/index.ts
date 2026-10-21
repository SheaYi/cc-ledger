/**
 * 周期账单规则路由（`docs/04 §十`），挂载在 `/api/v1/ledgers/:ledgerId` 下。
 *
 * 与 `docs/04` 的差异只有一处：`skip` / `unskip` 两个动作路由是后加的
 * （`docs/05 §11.3` 的「跳过单期」需要一个存储位置，见 schema 的 `skipped_dates` 注释）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECORD_TYPES } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  createRule,
  deleteRule,
  generatedOf,
  getRule,
  listRules,
  previewRule,
  runNow,
  setPaused,
  skipDate,
  unskipDate,
  updateRule,
} from './service.js';

const cents = z.union([z.string(), z.number()]).transform((v) => {
  if (typeof v === 'number') return Math.trunc(v);
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
});

const dayStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须是 YYYY-MM-DD');

const ruleBody = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(30, '名称最多 30 字'),
  recordType: z.enum(RECORD_TYPES as unknown as [string, ...string[]]),
  accountId: z.string().min(1),
  toAccountId: z.string().min(1).nullish(),
  categoryId: z.string().min(1).nullish(),
  merchant: z.string().max(50).nullish(),
  counterparty: z.string().max(50).nullish(),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  intervalCount: z.number().int().min(1).max(365).optional(),
  startDate: dayStr,
  endDate: dayStr.nullish(),
  dayOfMonth: z.number().int().min(1).max(45).nullish(),
  weekDay: z.number().int().min(0).max(6).nullish(),
  month: z.number().int().min(1).max(12).nullish(),
  maxMonthEnd: z.boolean().optional(),
  amount: cents,
  fee: cents.optional(),
  discount: cents.optional(),
  title: z.string().max(50).nullish(),
  note: z.string().max(500).nullish(),
  tagIds: z.array(z.string().min(1)).max(20).nullish(),
  generateAheadDays: z.number().int().min(0).max(30).optional(),
  autoCreate: z.boolean().optional(),
});

export async function registerRecurringRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/recurring-rules';

  app.get(base, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { includeArchived?: string };
    return ok(listRules(ctx, m.ledgerId, q.includeArchived === 'true'));
  });

  app.post(base, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(ruleBody, req.body);
    return reply
      .code(201)
      .send(ok(createRule(ctx, m.userId, m.ledgerId, body as never)));
  });

  // 静态段先注册
  app.post(`${base}/reorder`, { preHandler: app.requireAuth }, async () =>
    ok({ unsupported: true, message: '周期规则暂不支持自定义排序' }),
  );

  app.get(`${base}/:ruleId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    return ok(getRule(ctx, m.ledgerId, ruleId));
  });

  app.patch(`${base}/:ruleId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    const body = parseOrThrow(ruleBody.partial(), req.body);
    return ok(updateRule(ctx, m.userId, m.ledgerId, ruleId, body as never));
  });

  app.delete(`${base}/:ruleId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    return ok(deleteRule(ctx, m.userId, m.ledgerId, ruleId));
  });

  app.post(`${base}/:ruleId/pause`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    return ok(setPaused(ctx, m.userId, m.ledgerId, ruleId, true));
  });

  app.post(`${base}/:ruleId/resume`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    return ok(setPaused(ctx, m.userId, m.ledgerId, ruleId, false));
  });

  app.get(`${base}/:ruleId/preview`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    const q = req.query as { count?: string };
    const count = Math.max(1, Math.min(Number(q.count ?? 5) || 5, 24));
    return ok(previewRule(ctx, m.ledgerId, ruleId, count));
  });

  app.post(`${base}/:ruleId/run-now`, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    const out = runNow(ctx, m.userId, m.ledgerId, ruleId);
    return reply.code(out.reused ? 200 : 201).send(ok(out));
  });

  app.get(`${base}/:ruleId/generated`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    const q = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(q.limit ?? 50) || 50, 200));
    return ok(generatedOf(ctx, m.ledgerId, ruleId, limit));
  });

  /** 跳过 / 取消跳过单期（docs/05 §11.3「某期不生成」） */
  app.post(`${base}/:ruleId/skip`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId } = req.params as { ruleId: string };
    const body = parseOrThrow(z.object({ dueDate: dayStr }), req.body);
    return ok(skipDate(ctx, m.ledgerId, ruleId, body.dueDate));
  });

  app.delete(`${base}/:ruleId/skip/:dueDate`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ruleId, dueDate } = req.params as { ruleId: string; dueDate: string };
    return ok(unskipDate(ctx, m.ledgerId, ruleId, dueDate));
  });
}