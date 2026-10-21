/**
 * 认证路由（docs/04 §二）
 *   POST /api/v1/auth/register   注册（限流 3 次/小时/IP）
 *   POST /api/v1/auth/login      登录（限流 5 次/分钟/IP）
 *   POST /api/v1/auth/refresh    刷新（令牌轮换）
 *   POST /api/v1/auth/logout     登出
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { ok } from '../../utils/errors.js';
import {
  emailSchema,
  nicknameSchema,
  parseOrThrow,
  passwordSchema,
  phoneSchema,
  usernameSchema,
} from '../../utils/validate.js';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { nowIso } from '../../utils/money.js';
import {
  authenticate,
  createSession,
  publicUser,
  registerAccount,
  revokeSessions,
  rotateSession,
} from './service.js';

const platformSchema = z.enum(['web', 'mobile']).optional();

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  nickname: nicknameSchema,
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  platform: platformSchema,
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1, '请输入用户名 / 邮箱 / 手机号'),
  password: z.string().min(1, '请输入密码'),
  platform: platformSchema,
});

const refreshSchema = z.object({ refreshToken: z.string().min(1, '缺少 refreshToken') });

const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
  allDevices: z.boolean().optional(),
});

function deviceOf(req: FastifyRequest): string {
  return String(req.headers['user-agent'] ?? '');
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: { max: ctx.env.RATE_LIMIT_REGISTER_MAX, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = parseOrThrow(registerSchema, req.body);
      const { user, ledger } = await registerAccount(ctx, body);
      const tokens = createSession(ctx, app, user, {
        deviceInfo: deviceOf(req),
        platform: body.platform,
      });

      return reply.code(201).send(
        ok({
          user: publicUser(user),
          ledger: { id: ledger.id, name: ledger.name, type: ledger.type },
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenType: 'Bearer',
          expiresIn: tokens.expiresIn,
          refreshExpiresIn: tokens.refreshExpiresIn,
        }),
      );
    },
  );

  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: ctx.env.RATE_LIMIT_LOGIN_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseOrThrow(loginSchema, req.body);
      const user = await authenticate(ctx, body.identifier, body.password);

      const at = nowIso();
      ctx.db.update(users).set({ lastLoginAt: at, updatedAt: at }).where(eq(users.id, user.id)).run();

      const tokens = createSession(ctx, app, user, {
        deviceInfo: deviceOf(req),
        platform: body.platform,
      });

      return reply.code(200).send(
        ok({
          user: publicUser(user),
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenType: 'Bearer',
          expiresIn: tokens.expiresIn,
          refreshExpiresIn: tokens.refreshExpiresIn,
        }),
      );
    },
  );

  app.post(
    '/api/v1/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseOrThrow(refreshSchema, req.body);
      const { tokens } = rotateSession(ctx, app, body.refreshToken);
      return reply.code(200).send(
        ok({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenType: 'Bearer',
          expiresIn: tokens.expiresIn,
          refreshExpiresIn: tokens.refreshExpiresIn,
        }),
      );
    },
  );

  app.post(
    '/api/v1/auth/logout',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = parseOrThrow(logoutSchema, req.body ?? {});
      revokeSessions(ctx, req.authUser!.id, {
        refreshToken: body.refreshToken ?? null,
        allDevices: body.allDevices ?? false,
      });
      return reply.code(204).send();
    },
  );
}
