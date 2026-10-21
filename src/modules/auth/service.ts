/**
 * 认证服务（docs/04 §二）。
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { ledgerMembers, ledgers, refreshTokens, users } from '../../db/schema.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { nowIso } from '../../utils/money.js';
import {
  createRefreshToken,
  hashRefreshToken,
  isoAfterSeconds,
  parseDurationSeconds,
} from '../../utils/token.js';
import { HttpError } from '../../utils/errors.js';
import { issueAccessToken } from '../../plugins/auth.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { seedLedgerDefaults } from '../../db/seed.js';

export type UserRow = typeof users.$inferSelect;
export type LedgerRow = typeof ledgers.$inferSelect;

/** 用户公开字段（注册/登录响应用，docs/04 §2.1） */
export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatarPath: u.avatarPath,
    createdAt: u.createdAt,
  };
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

/** 移动端 refresh token 有效期延长至 90 天（docs/01 §7.1） */
export function refreshSecondsFor(ctx: AppCtx, platform: string): number {
  const isMobile = platform === 'mobile';
  const spec = isMobile ? ctx.env.JWT_REFRESH_EXPIRES_MOBILE : ctx.env.JWT_REFRESH_EXPIRES;
  return parseDurationSeconds(spec, isMobile ? 90 * 86400 : 30 * 86400);
}

/** 建立会话：签发 access token + 落库 refresh token（只存哈希） */
export function createSession(
  ctx: AppCtx,
  app: FastifyInstance,
  user: Pick<UserRow, 'id' | 'username'>,
  opts: { deviceInfo?: string | null; platform?: string },
): SessionTokens {
  const platform = opts.platform === 'mobile' ? 'mobile' : 'web';
  const { token: accessToken, expiresIn } = issueAccessToken(app, user, ctx.env.JWT_ACCESS_EXPIRES);

  const { id, token: refreshToken } = createRefreshToken();
  const refreshExpiresIn = refreshSecondsFor(ctx, platform);

  ctx.db
    .insert(refreshTokens)
    .values({
      id,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      deviceInfo: `${platform}: ${(opts.deviceInfo ?? '').slice(0, 200)}`,
      expiresAt: isoAfterSeconds(refreshExpiresIn),
      createdAt: nowIso(),
    })
    .run();

  return { accessToken, refreshToken, expiresIn, refreshExpiresIn };
}

/** 轮换：校验旧 refresh token → 立即吊销 → 签发新的一对（docs/04 §2.3） */
export function rotateSession(
  ctx: AppCtx,
  app: FastifyInstance,
  rawToken: string,
): { userId: string; tokens: SessionTokens } {
  const row = ctx.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(rawToken)))
    .get();

  if (!row || row.revokedAt) throw HttpError.unauthorized('刷新令牌无效或已被吊销');
  if (row.expiresAt < nowIso()) throw HttpError.unauthorized('刷新令牌已过期');

  const user = ctx.db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user) throw HttpError.unauthorized('账号不存在');
  if (user.status !== 'active') throw HttpError.forbidden('账号已被停用');

  ctx.db
    .update(refreshTokens)
    .set({ revokedAt: nowIso() })
    .where(eq(refreshTokens.id, row.id))
    .run();

  const platform = (row.deviceInfo ?? '').startsWith('mobile') ? 'mobile' : 'web';
  const tokens = createSession(ctx, app, user, {
    deviceInfo: row.deviceInfo ?? '',
    platform,
  });
  return { userId: user.id, tokens };
}

/** 登出：吊销指定令牌；allDevices=true 时吊销该用户全部有效令牌 */
export function revokeSessions(
  ctx: AppCtx,
  userId: string,
  opts: { refreshToken?: string | null; allDevices?: boolean },
): number {
  const at = nowIso();
  if (opts.allDevices) {
    const r = ctx.db
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .run();
    return r.changes;
  }
  if (opts.refreshToken) {
    const r = ctx.db
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.tokenHash, hashRefreshToken(opts.refreshToken)),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .run();
    return r.changes;
  }
  return 0;
}

/** 查找用户（用户名 / 邮箱 / 手机号任一命中，docs/04 §2.2） */
export function findUserByIdentifier(ctx: AppCtx, identifier: string): UserRow | undefined {
  const id = identifier.trim();
  return ctx.db
    .select()
    .from(users)
    .where(or(eq(users.username, id), eq(users.email, id.toLowerCase()), eq(users.phone, id)))
    .get();
}

export interface RegisterInput {
  username: string;
  password: string;
  nickname: string;
  email?: string | null;
  phone?: string | null;
}

export interface RegisterResult {
  user: UserRow;
  ledger: LedgerRow;
}

/**
 * 注册：创建用户 → 个人账本 → owner 成员 → 预置数据初始化（docs/04 §2.1 业务逻辑 1-4）。
 * 落库部分在单个事务内完成，任一步失败即回滚。
 * 密码哈希（CPU 密集）在事务外先算好，避免长时间占用 SQLite 写锁。
 */
export async function registerAccount(ctx: AppCtx, input: RegisterInput): Promise<RegisterResult> {
  const at = nowIso();
  const email = input.email ? input.email.toLowerCase() : null;
  const phone = input.phone ?? null;

  const conflict = ctx.db
    .select({ username: users.username, email: users.email, phone: users.phone })
    .from(users)
    .all()
    .find((r) => r.username === input.username || (email && r.email === email) || (phone && r.phone === phone));

  if (conflict) {
    if (conflict.username === input.username) throw HttpError.duplicate('用户名已被占用');
    if (email && conflict.email === email) throw HttpError.duplicate('邮箱已被注册');
    throw HttpError.duplicate('手机号已被注册');
  }

  const passwordHash = await hashPassword(input.password);

  const userId = newId(ID_PREFIX.user);
  const ledgerId = newId(ID_PREFIX.ledger);

  const result = ctx.db.transaction((tx) => {
    tx.insert(users)
      .values({
        id: userId,
        username: input.username,
        email,
        phone,
        passwordHash,
        nickname: input.nickname,
        avatarPath: null,
        status: 'active',
        isSystem: false,
        lastLoginAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    tx.insert(ledgers)
      .values({
        id: ledgerId,
        name: '我的账本',
        type: 'personal',
        currency: 'CNY',
        ownerId: userId,
        currentLedger: true,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    tx.insert(ledgerMembers)
      .values({
        id: newId(ID_PREFIX.ledgerMember),
        ledgerId,
        userId,
        role: 'owner',
        joinedAt: at,
      })
      .run();

    return {
      user: tx.select().from(users).where(eq(users.id, userId)).get()!,
      ledger: tx.select().from(ledgers).where(eq(ledgers.id, ledgerId)).get()!,
    };
  });

  // 预置数据（账户分组/虚拟账户/分类树/标签/模板）—— 幂等写入
  seedLedgerDefaults(ctx.db, ledgerId, userId);

  return result;
}

/** 校验登录凭据（防枚举：对外统一 401） */
export async function authenticate(
  ctx: AppCtx,
  identifier: string,
  password: string,
): Promise<UserRow> {
  const user = findUserByIdentifier(ctx, identifier);
  if (!user) {
    // 故意消耗等价时间，降低用户名枚举的信号差异
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000',
      password,
    );
    throw HttpError.unauthorized('用户名或密码错误');
  }
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw HttpError.unauthorized('用户名或密码错误');
  if (user.status !== 'active') throw HttpError.forbidden('账号已被停用');
  return user;
}
