/**
 * 账本路由（docs/04 §四）
 *   账本：GET/POST /ledgers、GET/PATCH/DELETE /ledgers/:id
 *   成员：GET /ledgers/:id/members、POST /ledgers/:id/members/:userId/role、DELETE ...
 *   邀请：POST/GET /ledgers/:id/invitations、GET /invitations/:code、POST /invitations/:code/redeem
 *   转让：POST /ledgers/:id/transfer-ownership
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { MEMBER_ROLES, type MemberRole } from '../../config/constants.js';
import { ledgers } from '../../db/schema.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { listUserLedgers } from '../users/service.js';
import { getMembership, requireRole, type Membership } from './access.js';
import {
  archiveLedger,
  changeMemberRole,
  createInvitation,
  createLedger,
  deleteLedger,
  deletionImpact,
  ledgerPayload,
  listInvitations,
  listMembers,
  previewInvitation,
  redeemInvitation,
  removeMember,
  transferOwnership,
  updateLedger,
} from './service.js';

const roleSchema = z.enum(MEMBER_ROLES);

const createLedgerSchema = z.object({
  name: z.string().trim().min(1, '账本名不能为空').max(40, '账本名最多 40 字'),
  type: z.enum(['personal', 'shared']).default('shared'),
  currency: z.string().trim().min(1).max(8).default('CNY'),
});

const updateLedgerSchema = z
  .object({
    name: z.string().trim().min(1, '账本名不能为空').max(40, '账本名最多 40 字').optional(),
    currency: z.string().trim().min(1).max(8).optional(),
    /**
     * 图标与备注用 `nullable()` 而不是 `nullish()` —— 允许**显式传 null 清空**。
     *
     * ⚠️ 若写成 `nullish()`，「清空备注」与「本次不改动备注」无法区分：
     *    两者都会让 key 消失或被忽略，用户点了保存却清不掉旧备注。
     *    `nullable()` 让 null 成为一个有明确意图的值。
     */
    icon: z.string().trim().max(40).nullable().optional(),
    note: z.string().trim().max(140, '备注最多 140 字').nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

const inviteSchema = z.object({
  role: z.enum(['admin', 'member']).default('member'),
  maxUses: z.coerce.number().int().min(1).max(100).default(1),
  expiresInHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});

const transferSchema = z.object({ newOwnerId: z.string().min(1) });

/** 从 path 取 ledgerId 并校验成员身份（跨账本 → 404） */
function resolveMembership(ctx: AppCtx, req: FastifyRequest): Membership {
  const params = req.params as { ledgerId?: string };
  const ledgerId = params.ledgerId;
  if (!ledgerId) throw new Error('缺少 ledgerId 路由参数');
  return getMembership(ctx, req.authUser!.id, ledgerId);
}

/** 读取账本币种 */
function ledgerCurrency(ctx: AppCtx, ledgerId: string): string {
  const row = ctx.db
    .select({ currency: ledgers.currency })
    .from(ledgers)
    .where(eq(ledgers.id, ledgerId))
    .get();
  return row?.currency ?? 'CNY';
}

export async function registerLedgerRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  // ---------- 账本 ----------
  app.get('/api/v1/ledgers', { preHandler: app.requireAuth }, async (req) => {
    const q = req.query as { includeArchived?: string };
    const includeArchived = q.includeArchived === 'true' || q.includeArchived === '1';
    return ok(listUserLedgers(ctx, req.authUser!.id, includeArchived));
  });

  app.post('/api/v1/ledgers', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = parseOrThrow(createLedgerSchema, req.body);
    const ledger = createLedger(ctx, req.authUser!.id, body);
    const m = getMembership(ctx, req.authUser!.id, ledger.id);
    return reply.code(201).send(ok(ledgerPayload(ctx, m)));
  });

  app.get('/api/v1/ledgers/:ledgerId', { preHandler: app.requireAuth }, async (req) => {
    const m = resolveMembership(ctx, req);
    return ok({
      ...ledgerPayload(ctx, m),
      currency: ledgerCurrency(ctx, m.ledgerId),
      members: listMembers(ctx, m.ledgerId),
    });
  });

  app.patch('/api/v1/ledgers/:ledgerId', { preHandler: app.requireAuth }, async (req) => {
    const m = resolveMembership(ctx, req);
    requireRole(m, 'owner', 'admin');
    const body = parseOrThrow(updateLedgerSchema, req.body);
    const updated = updateLedger(ctx, m, body);
    const fresh = getMembership(ctx, m.userId, m.ledgerId);
    return ok({ ...ledgerPayload(ctx, fresh), currency: updated.currency });
  });

  /**
   * `DELETE /ledgers/:id` = **归档**（docs/04 §4.4，软删，可再切回来）。
   *
   * ⚠️ 语义不要动 —— 既有冒烟与探针按「DELETE 后账本从列表消失、数据还在」写的。
   * 真正的物理删除走下面的 `POST /ledgers/:id/purge`，两者分开，避免一个接口
   * 承载两种不可逆程度完全不同的操作。
   */
  app.delete('/api/v1/ledgers/:ledgerId', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = resolveMembership(ctx, req);
    requireRole(m, 'owner');
    archiveLedger(ctx, m);
    return reply.code(204).send();
  });

  /**
   * 删除影响预览：确认弹窗要显示「这一删会带走 N 笔账目、M 位成员」，
 *   而这个数**只能由服务端给** —— 前端不持有账本级表的行数。
   */
  app.get('/api/v1/ledgers/:ledgerId/deletion-impact', { preHandler: app.requireAuth }, async (req) => {
    const m = resolveMembership(ctx, req);
    return ok(deletionImpact(ctx, m));
  });

  /**
   * 物理删除账本（级联，不可恢复，仅 owner）。
   *
   * 二次确认由**前端弹窗**负责 —— 服务端只保证：
   *   ① 只有 owner 能删；② 级联可用（外键开着）；③ 不会删掉最后一本账。
   */
  app.post('/api/v1/ledgers/:ledgerId/purge', { preHandler: app.requireAuth }, async (req) => {
    const m = resolveMembership(ctx, req);
    return ok(deleteLedger(ctx, m));
  });

  // ---------- 成员 ----------
  app.get('/api/v1/ledgers/:ledgerId/members', { preHandler: app.requireAuth }, async (req) => {
    const m = resolveMembership(ctx, req);
    return ok(listMembers(ctx, m.ledgerId));
  });

  app.post(
    '/api/v1/ledgers/:ledgerId/members/:userId/role',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = resolveMembership(ctx, req);
      requireRole(m, 'owner', 'admin');
      const { userId } = req.params as { userId: string };
      const body = parseOrThrow(z.object({ role: roleSchema }), req.body);
      changeMemberRole(ctx, m, userId, body.role as MemberRole);
      return ok(listMembers(ctx, m.ledgerId));
    },
  );

  app.delete(
    '/api/v1/ledgers/:ledgerId/members/:userId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const m = resolveMembership(ctx, req);
      const { userId } = req.params as { userId: string };
      removeMember(ctx, m, userId);
      return reply.code(204).send();
    },
  );

  // ---------- 邀请 ----------
  app.post('/api/v1/ledgers/:ledgerId/invitations', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = resolveMembership(ctx, req);
    requireRole(m, 'owner', 'admin');
    const body = parseOrThrow(inviteSchema, req.body);
    const inv = createInvitation(ctx, m, body);
    return reply.code(201).send(
      ok({
        ...inv,
        ledgerId: m.ledgerId,
        inviteUrl: `${ctx.env.PUBLIC_BASE_URL}/invite/${inv.code}`,
        invitePath: `/invite/${inv.code}`,
      }),
    );
  });

  app.get('/api/v1/ledgers/:ledgerId/invitations', { preHandler: app.requireAuth }, async (req) => {
    const m = resolveMembership(ctx, req);
    requireRole(m, 'owner', 'admin');
    return ok(listInvitations(ctx, m.ledgerId));
  });

  app.get('/api/v1/invitations/:code', async (req) => {
    const { code } = req.params as { code: string };
    return ok(previewInvitation(ctx, code));
  });

  app.post('/api/v1/invitations/:code/redeem', { preHandler: app.requireAuth }, async (req) => {
    const { code } = req.params as { code: string };
    return ok(redeemInvitation(ctx, req.authUser!.id, code));
  });

  // ---------- 转让 ----------
  app.post(
    '/api/v1/ledgers/:ledgerId/transfer-ownership',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = resolveMembership(ctx, req);
      requireRole(m, 'owner');
      const body = parseOrThrow(transferSchema, req.body);
      transferOwnership(ctx, m, body.newOwnerId);
      const fresh = getMembership(ctx, m.userId, m.ledgerId);
      return ok({ ...ledgerPayload(ctx, fresh), members: listMembers(ctx, m.ledgerId) });
    },
  );
}
