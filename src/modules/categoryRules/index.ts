/** 自动分类规则路由（`docs/04 §十五`），挂在 `/api/v1/ledgers/:ledgerId` 下。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECORD_TYPES } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  MATCH_FIELDS,
  MATCH_OPS,
  createRule,
  deleteRule,
  listRules,
  previewRules,
  reorderRules,
  updateRule,
} from './service.js';

const ruleBody = z.object({
  priority: z.number().int().min(0).max(100000).optional(),
  matchField: z.enum(MATCH_FIELDS),
  matchOp: z.enum(MATCH_OPS),
  matchValue: z.string().trim().min(1, '匹配内容不能为空').max(100),
  recordType: z.enum(RECORD_TYPES as unknown as [string, ...string[]]),
  targetCategoryId: z.string().min(1),
  enabled: z.boolean().optional(),
});

const reorderSchema = z.object({ ids: z.array(z.string().min(1)).max(200) });

export async function registerCategoryRuleRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/category-rules';

  app.get(base, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(listRules(ctx, m.ledgerId));
  });

  /** 试运行与「应用」是**两个**动作：前者不改数据，后者改。 */
  app.get(`${base}/preview`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { limit?: string };
    return ok(previewRules(ctx, m.ledgerId, q.limit ? Number(q.limit) : undefined));
  });

  app.post(base, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(ruleBody, req.body);
    return reply.code(201).send(ok(createRule(ctx, m.userId, m.ledgerId, body as never)));
  });

  app.post(`${base}/reorder`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ids } = parseOrThrow(reorderSchema, req.body);
    return ok(reorderRules(ctx, m.userId, m.ledgerId, ids));
  });

  app.patch(`${base}/:id`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    const body = parseOrThrow(ruleBody.partial(), req.body);
    return ok(updateRule(ctx, m.userId, m.ledgerId, id, body as never));
  });

  app.delete(`${base}/:id`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(deleteRule(ctx, m.userId, m.ledgerId, id));
  });
}
