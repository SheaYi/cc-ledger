/**
 * 用户路由（docs/04 §三）
 *   GET    /api/v1/users/me
 *   PATCH  /api/v1/users/me
 *   PATCH  /api/v1/users/me/password
 *   POST   /api/v1/users/me/avatar   （multipart/form-data，字段名 file）
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { users } from '../../db/schema.js';
import { LIMITS } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { emailSchema, nicknameSchema, parseOrThrow, passwordSchema, phoneSchema } from '../../utils/validate.js';
import {
  activateLedger,
  changePassword,
  currentLedgerId,
  listUserLedgers,
  saveAvatar,
  updateProfile,
} from './service.js';

const updateProfileSchema = z
  .object({
    nickname: nicknameSchema.optional(),
    email: emailSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入原密码'),
  newPassword: passwordSchema,
});

const activateSchema = z.object({ ledgerId: z.string().min(1) });

function userPayload(ctx: AppCtx, userId: string) {
  const u = ctx.db.select().from(users).where(eq(users.id, userId)).get()!;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    nickname: u.nickname,
    avatarPath: u.avatarPath,
    status: u.status,
    currentLedgerId: currentLedgerId(ctx, userId),
    ledgers: listUserLedgers(ctx, userId),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export async function registerUserRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get('/api/v1/users/me', { preHandler: app.requireAuth }, async (req) => {
    return ok(userPayload(ctx, req.authUser!.id));
  });

  app.patch('/api/v1/users/me', { preHandler: app.requireAuth }, async (req) => {
    const body = parseOrThrow(updateProfileSchema, req.body);
    updateProfile(ctx, req.authUser!.id, body);
    return ok(userPayload(ctx, req.authUser!.id));
  });

  app.patch(
    '/api/v1/users/me/password',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req) => {
      const body = parseOrThrow(changePasswordSchema, req.body);
      const revoked = await changePassword(ctx, req.authUser!.id, body.oldPassword, body.newPassword);
      // 副作用：吊销全部 refresh token，其他设备需重新登录
      return ok({ changed: true, revokedSessions: revoked });
    },
  );

  app.post(
    '/api/v1/users/me/avatar',
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const file = await req.file({ limits: { fileSize: LIMITS.AVATAR_MAX_BYTES } });
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
      const result = await saveAvatar(ctx, req.authUser!.id, {
        buffer,
        mimetype: file.mimetype,
        filename: file.filename,
      });
      return ok(result);
    },
  );

  // 辅助端点（前端切账本用；docs 未定义，属实现补充）
  app.post('/api/v1/users/me/current-ledger', { preHandler: app.requireAuth }, async (req) => {
    const body = parseOrThrow(activateSchema, req.body);
    activateLedger(ctx, req.authUser!.id, body.ledgerId);
    return ok(userPayload(ctx, req.authUser!.id));
  });
}
