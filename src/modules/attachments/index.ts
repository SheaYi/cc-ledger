/**
 * 附件路由（`docs/04 §8.8`）。
 *
 * `POST` 走 multipart（字段名 `file`），其余是普通 REST。
 * 上传限流对齐头像那一档：20 次/分钟，附件比头像更容易被脚本刷。
 */
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../../context.js';
import { LIMITS } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { membershipFromRequest } from '../ledgers/access.js';
import { listAttachments, removeAttachment, saveAttachment } from './service.js';

export async function registerAttachmentRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/transactions/:transactionId/attachments';

  app.get(base, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { transactionId } = req.params as { transactionId: string };
    return ok(listAttachments(ctx, m.ledgerId, transactionId));
  });

  app.post(
    base,
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const m = membershipFromRequest(ctx, req);
      const { transactionId } = req.params as { transactionId: string };
      const file = await req.file({ limits: { fileSize: LIMITS.ATTACHMENT_MAX_BYTES } });
      if (!file) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: '请求参数校验失败',
            details: [{ field: 'file', message: '缺少文件字段 file' }],
            requestId: req.id,
          },
        });
      }
      const buffer = await file.toBuffer();
      const saved = saveAttachment(ctx, m.userId, m.ledgerId, transactionId, {
        buffer,
        mimetype: file.mimetype,
        filename: file.filename,
      });
      return reply.code(201).send(ok(saved));
    },
  );

  app.delete(
    '/api/v1/ledgers/:ledgerId/attachments/:id',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { id } = req.params as { id: string };
      return ok(removeAttachment(ctx, m.ledgerId, id));
    },
  );
}
