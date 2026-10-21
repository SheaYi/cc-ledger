/**
 * 模板路由（`docs/04 §九`），挂载在 `/api/v1/ledgers/:ledgerId` 下。
 *
 * 与其它账本级主数据（标签/分类）一致的形状：GET 列表 / POST 创建 /
 * PATCH 更新 / DELETE 软删，外加两个动作型路由：
 *   · `POST /templates/reorder`             手动排序（`sort_order`）
 *   · `POST /templates/:id/use`             使用计数 +1 并返回预填 payload
 *   · `POST /transactions/:id/save-as-template`  存为模板（挂在账单路径下）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECORD_TYPES, TX_DIRECTIONS } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  reorderTemplates,
  updateTemplate,
  useTemplate,
  saveAsTemplate,
} from './service.js';

/**
 * 模板 payload 的入参校验刻意**宽松**：只约束类型与长度，引用合法性交给 service 层
 * 逐条查（它要报的错更具体，比如「分类与记录类型不匹配」）。
 * 金额字段同时接受 `"12.30"` 与整数分（表内存分，API 层用元字符串）。
 */
const payloadSchema = z
  .object({
    recordType: z.enum(RECORD_TYPES as unknown as [string, ...string[]]).optional(),
    direction: z.enum(TX_DIRECTIONS as unknown as [string, ...string[]]).nullish(),
    accountId: z.string().min(1).nullish(),
    accountGroupKey: z.string().min(1).nullish(),
    toAccountId: z.string().min(1).nullish(),
    categoryId: z.string().min(1).nullish(),
    merchant: z.string().max(50).nullish(),
    counterparty: z.string().max(50).nullish(),
    name: z.string().max(50).nullish(),
    note: z.string().max(500).nullish(),
    tagIds: z.array(z.string().min(1)).max(20).nullish(),
    fee: z.union([z.string(), z.number()]).nullish(),
    discount: z.union([z.string(), z.number()]).nullish(),
    defaultAmount: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const createSchema = z.object({
  name: z.string().trim().min(1, '模板名不能为空').max(20, '模板名最多 20 字'),
  icon: z.string().max(40).nullish(),
  payload: payloadSchema.default({}),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(20).optional(),
    icon: z.string().max(40).nullish(),
    pinned: z.boolean().optional(),
    payload: payloadSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

const reorderSchema = z.object({ ids: z.array(z.string().min(1)).max(200) });
const saveAsSchema = z.object({
  name: z.string().trim().min(1, '模板名不能为空').max(20, '模板名最多 20 字'),
  icon: z.string().max(40).nullish(),
});

export async function registerTemplateRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId';

  app.get(`${base}/templates`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { includeArchived?: string };
    return ok(listTemplates(ctx, m.ledgerId, q.includeArchived === 'true'));
  });

  app.post(`${base}/templates`, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(createSchema, req.body);
    return reply.code(201).send(ok(createTemplate(ctx, m.userId, m.ledgerId, body)));
  });

  // 静态段路由先注册（find-my-way 静态优先于参数，但显式在前更不容易被后来者踩坑）
  app.post(`${base}/templates/reorder`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ids } = parseOrThrow(reorderSchema, req.body);
    return ok(reorderTemplates(ctx, m.ledgerId, ids));
  });

  app.get(`${base}/templates/:templateId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { templateId } = req.params as { templateId: string };
    return ok(getTemplate(ctx, m.ledgerId, templateId));
  });

  app.patch(`${base}/templates/:templateId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { templateId } = req.params as { templateId: string };
    const body = parseOrThrow(updateSchema, req.body);
    return ok(updateTemplate(ctx, m.userId, m.ledgerId, templateId, body));
  });

  app.delete(`${base}/templates/:templateId`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { templateId } = req.params as { templateId: string };
    return ok(deleteTemplate(ctx, m.userId, m.ledgerId, templateId));
  });

  app.post(`${base}/templates/:templateId/use`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { templateId } = req.params as { templateId: string };
    return ok(useTemplate(ctx, m.ledgerId, templateId));
  });

  app.post(
    `${base}/transactions/:txId/save-as-template`,
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const m = membershipFromRequest(ctx, req);
      const { txId } = req.params as { txId: string };
      const body = parseOrThrow(saveAsSchema, req.body);
      return reply
        .code(201)
        .send(ok(saveAsTemplate(ctx, m.userId, m.ledgerId, txId, body.name, body.icon)));
    },
  );
}