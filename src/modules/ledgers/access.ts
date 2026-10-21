/**
 * 账本访问控制（docs/01 §2.1、docs/02 §3.4）。
 *
 * 铁律：跨账本访问一律返回 404（而非 403），避免信息泄露。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppCtx } from '../../context.js';
import { ledgerMembers, ledgers } from '../../db/schema.js';
import type { MemberRole } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';

export interface Membership {
  membershipId: string;
  ledgerId: string;
  userId: string;
  role: MemberRole;
  nicknameOverride: string | null;
  joinedAt: string;
  ledgerName: string;
  ledgerType: string;
  ledgerArchivedAt: string | null;
  ownerId: string;
}

/** 取当前用户在目标账本中的成员身份；不存在或账本不存在 → 404 */
export function getMembership(ctx: AppCtx, userId: string, ledgerId: string): Membership {
  const row = ctx.db
    .select({
      membershipId: ledgerMembers.id,
      ledgerId: ledgerMembers.ledgerId,
      userId: ledgerMembers.userId,
      role: ledgerMembers.role,
      nicknameOverride: ledgerMembers.nicknameOverride,
      joinedAt: ledgerMembers.joinedAt,
      ledgerName: ledgers.name,
      ledgerType: ledgers.type,
      ledgerArchivedAt: ledgers.archivedAt,
      ownerId: ledgers.ownerId,
    })
    .from(ledgerMembers)
    .innerJoin(ledgers, eq(ledgers.id, ledgerMembers.ledgerId))
    .where(and(eq(ledgerMembers.userId, userId), eq(ledgerMembers.ledgerId, ledgerId)))
    .get();

  if (!row) throw HttpError.notFound('账本不存在');
  return { ...row, role: row.role as MemberRole };
}

/** 校验成员角色，不足则 403 */
export function requireRole(m: Membership, ...roles: MemberRole[]): void {
  if (!roles.includes(m.role)) {
    throw HttpError.forbidden('当前角色无权执行该操作');
  }
}

/** 从路由参数取 ledgerId 并校验成员身份（跨账本 → 404）。供各子模块复用。 */
export function membershipFromRequest(ctx: AppCtx, req: FastifyRequest): Membership {
  const params = req.params as { ledgerId?: string };
  if (!params.ledgerId) throw new Error('缺少 ledgerId 路由参数');
  return getMembership(ctx, req.authUser!.id, params.ledgerId);
}

/** 是否 owner */
export function isOwner(m: Membership): boolean {
  return m.role === 'owner';
}

/** 成员数量 */
export function memberCount(ctx: AppCtx, ledgerId: string): number {
  const row = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(ledgerMembers)
    .where(eq(ledgerMembers.ledgerId, ledgerId))
    .get();
  return Number(row?.c ?? 0);
}
