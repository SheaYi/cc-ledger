/**
 * 分类路由（docs/04 §六）挂载在 /api/v1/ledgers/:ledgerId 下。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECORD_TYPES, RECORD_TYPES_WITH_CATEGORY } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  createCategory,
  deleteCategory,
  listCategoryOptions,
  listCategoryTree,
  reorderCategories,
  restoreCategory,
  updateCategory,
} from './service.js';

const categoryCreateSchema = z.object({
  recordType: z.enum(RECORD_TYPES),
  parentId: z.string().min(1).nullish(),
  name: z.string().trim().min(1, '分类名不能为空').max(20, '分类名最多 20 字'),
  icon: z.string().trim().max(32, '图标名最长 32 字符').nullish(),
  color: z.string().trim().max(16).nullish(),
});

const categoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(20).optional(),
    icon: z.string().trim().max(32, '图标名最长 32 字符').nullish(),
    color: z.string().trim().max(16).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

const reorderSchema = z.object({ ids: z.array(z.string().min(1)).max(1000) });

export async function registerCategoryRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get('/api/v1/ledgers/:ledgerId/categories', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { recordType?: string; includeArchived?: string; flat?: string };
    const includeArchived = q.includeArchived === 'true' || q.includeArchived === '1';

    if (q.flat === 'true') {
      return ok(listCategoryOptions(ctx, m.ledgerId, q.recordType));
    }
    return ok(listCategoryTree(ctx, m.ledgerId, { recordType: q.recordType, includeArchived }));
  });

  app.post('/api/v1/ledgers/:ledgerId/categories', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(categoryCreateSchema, req.body);
    const created = createCategory(ctx, m.userId, m.ledgerId, {
      recordType: body.recordType,
      parentId: body.parentId ?? null,
      name: body.name,
      icon: body.icon ?? null,
      color: body.color ?? null,
    });
    return reply.code(201).send(ok(created));
  });

  app.post(
    '/api/v1/ledgers/:ledgerId/categories/reorder',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { ids } = parseOrThrow(reorderSchema, req.body);
      reorderCategories(ctx, m.ledgerId, ids);
      return ok(listCategoryTree(ctx, m.ledgerId));
    },
  );

  app.patch(
    '/api/v1/ledgers/:ledgerId/categories/:categoryId',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { categoryId } = req.params as { categoryId: string };
      const body = parseOrThrow(categoryUpdateSchema, req.body);
      return ok(updateCategory(ctx, m.userId, m.ledgerId, categoryId, body));
    },
  );

  app.post(
    '/api/v1/ledgers/:ledgerId/categories/:categoryId/restore',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { categoryId } = req.params as { categoryId: string };
      return ok(restoreCategory(ctx, m.userId, m.ledgerId, categoryId));
    },
  );

  app.delete(
    '/api/v1/ledgers/:ledgerId/categories/:categoryId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const m = membershipFromRequest(ctx, req);
      const { categoryId } = req.params as { categoryId: string };
      const result = deleteCategory(ctx, m.userId, m.ledgerId, categoryId);
      return reply.code(200).send(ok(result));
    },
  );
}

/** 供记账模块复用的记录类型常量 */
export const CATEGORY_RECORD_TYPES = RECORD_TYPES_WITH_CATEGORY;
