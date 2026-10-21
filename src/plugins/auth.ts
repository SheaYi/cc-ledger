/**
 * 认证插件（docs/04 §二、§三）。
 *
 * - access token 用 @fastify/jwt（HS256）签发校验
 * - 提供 `requireAuth` preHandler：校验签名 + 过期，并确认用户仍存在且为 active
 * - 提供 `clientIp`：限流与审计用
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { users } from '../db/schema.js';
import { HttpError } from '../utils/errors.js';
import { parseDurationSeconds } from '../utils/token.js';

export interface AuthUser {
  id: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; uname: string };
    user: { sub: string; uname: string; iat?: number; exp?: number };
  }
}

/** 当前请求的客户端 IP（trustProxy 已开启，优先 X-Forwarded-For） */
export function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip;
}

export async function registerAuth(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  await app.register(fastifyJwt, {
    secret: ctx.env.JWT_SECRET,
    sign: { expiresIn: ctx.env.JWT_ACCESS_EXPIRES },
  });

  app.decorateRequest('authUser', undefined);

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code.includes('EXPIRED')) throw HttpError.tokenExpired();
      throw HttpError.unauthorized();
    }

    const sub = req.user?.sub;
    if (!sub) throw HttpError.unauthorized();

    const row = ctx.db
      .select({ id: users.id, username: users.username, status: users.status })
      .from(users)
      .where(eq(users.id, sub))
      .get();

    if (!row) throw HttpError.unauthorized('账号不存在');
    if (row.status !== 'active') throw HttpError.forbidden('账号已被停用');

    req.authUser = { id: row.id, username: row.username };
  });
}

/** 签发 access token；expiresIn 同时以秒数回传（docs/04 §2.1 的 expiresIn 字段） */
export function issueAccessToken(
  app: FastifyInstance,
  user: { id: string; username: string },
  expiresInStr: string,
): { token: string; expiresIn: number } {
  const token = app.jwt.sign({ sub: user.id, uname: user.username });
  return { token, expiresIn: parseDurationSeconds(expiresInStr, 900) };
}
