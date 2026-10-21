/** 标签路由（docs/04 §7.1）挂载在 /api/v1/ledgers/:ledgerId 下。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { TAG_COLORS } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import { createTag, deleteTag, listTags, reorderTags, updateTag } from './service.js';

const createSchema = z.object({
  name: z.string().trim().min(1, '标签名不能为空').max(12, '标签名最多 12 字'),
  color: z.enum(TAG_COLORS).nullish(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(12).optional(),
    color: z.enum(TAG_COLORS).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

const reorderSchema = z.object({ ids: z.array(z.string().min(1)).max(500) });

export async function registerTagRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get('/api/v1/ledgers/:ledgerId/tags', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { includeArchived?: string };
    return ok(listTags(ctx, m.ledgerId, q.includeArchived === 'true'));
  });

  app.post('/api/v1/ledgers/:ledgerId/tags', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(createSchema, req.body);
    return reply.code(201).send(ok(createTag(ctx, m.userId, m.ledgerId, body)));
  });

  app.post('/api/v1/ledgers/:ledgerId/tags/reorder', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ids } = parseOrThrow(reorderSchema, req.body);
    reorderTags(ctx, m.ledgerId, ids);
    return ok(listTags(ctx, m.ledgerId));
  });

  app.patch('/api/v1/ledgers/:ledgerId/tags/:tagId', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { tagId } = req.params as { tagId: string };
    const body = parseOrThrow(updateSchema, req.body);
    return ok(updateTag(ctx, m.userId, m.ledgerId, tagId, body));
  });

  app.delete('/api/v1/ledgers/:ledgerId/tags/:tagId', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { tagId } = req.params as { tagId: string };
    return ok(deleteTag(ctx, m.userId, m.ledgerId, tagId));
  });
}
