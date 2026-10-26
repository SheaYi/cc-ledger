/**
 * 账户路由（docs/04 §五）挂载在 /api/v1/ledgers/:ledgerId 下。
 * 权限：按 docs/02 §3.4 权限矩阵，维护主数据（账户/分类/标签）owner/admin/member 均可。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { ACCOUNT_TYPES } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  archiveAccount,
  archiveGroup,
  assertAccountType,
  balanceView,
  createAccount,
  createGroup,
  deleteAccount,
  deleteGroup,
  findAccount,
  listAccounts,
  listGroups,
  periodFlow,
  reorderAccounts,
  reorderGroups,
  restoreAccount,
  restoreGroup,
  totals,
  updateAccount,
  updateGroup,
} from './service.js';
import { BALANCE_MAX_DATE, ledgerDeltas } from './balance.js';
import { accountPayload } from './service.js';
import { formatCents, today } from '../../utils/money.js';

const amount = z.union([z.string(), z.number()]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const dayOfMonth = z.number().int().min(1).max(31);

const GROUP_KINDS = ['asset', 'liability', 'virtual'] as const;

const groupCreateSchema = z.object({
  name: z.string().trim().min(1, '分组名不能为空').max(20, '分组名最多 20 字'),
  kind: z.enum(GROUP_KINDS).default('asset'),
  icon: z.string().trim().max(32).nullish(),
});

const groupUpdateSchema = z
  .object({
    name: z.string().trim().min(1, '分组名不能为空').max(20, '分组名最多 20 字').optional(),
    kind: z.enum(GROUP_KINDS).optional(),
    icon: z.string().trim().max(32).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

const reorderSchema = z.object({ ids: z.array(z.string().min(1)).max(500) });

const accountCreateSchema = z.object({
  groupId: z.string().min(1),
  name: z.string().trim().min(1, '账户名不能为空').max(40, '账户名最多 40 字'),
  type: z.enum(ACCOUNT_TYPES),
  openingBalance: amount.optional(),
  openingDate: dateStr.optional(),
  creditLimit: amount.nullish(),
  billingDay: dayOfMonth.nullish(),
  dueDay: dayOfMonth.nullish(),
  includeInTotal: z.boolean().optional(),
  icon: z.string().trim().max(8).nullish(),
  note: z.string().trim().max(200).nullish(),
});

const accountUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    groupId: z.string().min(1).optional(),
    icon: z.string().trim().max(8).nullish(),
    note: z.string().trim().max(200).nullish(),
    includeInTotal: z.boolean().optional(),
    creditLimit: amount.nullish(),
    billingDay: dayOfMonth.nullish(),
    dueDay: dayOfMonth.nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' });

export async function registerAccountRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  /* ---------------- 账户分组 ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/account-groups', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { includeArchived?: string };
    return ok(
      listGroups(ctx, m.ledgerId, {
        includeArchived: q.includeArchived === 'true' || q.includeArchived === '1',
      }),
    );
  });

  app.post(
    '/api/v1/ledgers/:ledgerId/account-groups',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const m = membershipFromRequest(ctx, req);
      const body = parseOrThrow(groupCreateSchema, req.body);
      const group = createGroup(ctx, m.userId, m.ledgerId, body);
      return reply.code(201).send(ok(group));
    },
  );

  app.post(
    '/api/v1/ledgers/:ledgerId/account-groups/reorder',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { ids } = parseOrThrow(reorderSchema, req.body);
      reorderGroups(ctx, m.ledgerId, ids);
      return ok(listGroups(ctx, m.ledgerId));
    },
  );

  app.patch(
    '/api/v1/ledgers/:ledgerId/account-groups/:groupId',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { groupId } = req.params as { groupId: string };
      const body = parseOrThrow(groupUpdateSchema, req.body);
      updateGroup(ctx, m.userId, m.ledgerId, groupId, body);
      return ok(listGroups(ctx, m.ledgerId).find((g) => g.id === groupId)!);
    },
  );

  /** 停用分组（组内无活跃账户时；可恢复）。与「删除」的区别见 service.ts 的同名函数。 */
  app.post(
    '/api/v1/ledgers/:ledgerId/account-groups/:groupId/archive',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { groupId } = req.params as { groupId: string };
      return ok(archiveGroup(ctx, m.userId, m.ledgerId, groupId));
    },
  );

  /** 恢复停用分组（同名活跃分组已存在时 → 409） */
  app.post(
    '/api/v1/ledgers/:ledgerId/account-groups/:groupId/restore',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { groupId } = req.params as { groupId: string };
      return ok(restoreGroup(ctx, m.userId, m.ledgerId, groupId));
    },
  );

  app.delete(
    '/api/v1/ledgers/:ledgerId/account-groups/:groupId',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { groupId } = req.params as { groupId: string };
      return ok(deleteGroup(ctx, m.userId, m.ledgerId, groupId));
    },
  );

  /* ---------------- 概览：净资产 + 本月收支 ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/accounts/summary', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { dateFrom?: string; dateTo?: string };
    const list = listAccounts(ctx, m.ledgerId);
    const t = totals(ctx, m.ledgerId);

    // 默认统计区间：本月 1 号 → 今天
    const now = new Date();
    const from = q.dateFrom ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const to = q.dateTo ?? today();
    const flow = periodFlow(ctx, m.ledgerId, from, to);

    return ok({
      netWorth: formatCents(t.netWorth),
      assetTotal: formatCents(t.assetTotal),
      liabilityTotal: formatCents(t.liabilityTotal),
      accountCount: list.length,
      reconciledCount: list.filter((a) => a.lastReconciledAt).length,
      accountsWithDiff: list.filter((a) => a.unreconciledDiff !== null && a.unreconciledDiff !== '0.00')
        .length,
      period: {
        dateFrom: flow.dateFrom,
        dateTo: flow.dateTo,
        income: formatCents(flow.income),
        expense: formatCents(flow.expense),
        net: formatCents(flow.net),
        txCount: flow.txCount,
      },
    });
  });

  /* ---------------- 账户 ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/accounts', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { groupId?: string; kind?: string; includeArchived?: string };
    return ok(
      listAccounts(ctx, m.ledgerId, {
        groupId: q.groupId,
        kind: q.kind,
        includeArchived: q.includeArchived === 'true' || q.includeArchived === '1',
      }),
    );
  });

  app.post('/api/v1/ledgers/:ledgerId/accounts', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(accountCreateSchema, req.body);
    assertAccountType(body.type);
    const account = createAccount(ctx, m.userId, m.ledgerId, body);
    return reply.code(201).send(ok(account));
  });

  app.post(
    '/api/v1/ledgers/:ledgerId/accounts/reorder',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { ids } = parseOrThrow(reorderSchema, req.body);
      reorderAccounts(ctx, m.ledgerId, ids);
      return ok(listAccounts(ctx, m.ledgerId));
    },
  );

  app.get(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const acc = findAccount(ctx, m.ledgerId, accountId);
      const delta = ledgerDeltas(ctx, m.ledgerId, BALANCE_MAX_DATE).get(accountId);
      return ok(accountPayload(acc, { delta }));
    },
  );

  app.get(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/balance',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const q = req.query as { date?: string };
      return ok(balanceView(ctx, m.ledgerId, accountId, q.date));
    },
  );

  app.patch(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const body = parseOrThrow(accountUpdateSchema, req.body);
      return ok(updateAccount(ctx, m.userId, m.ledgerId, accountId, body));
    },
  );

  /** 归档（软删除）。DELETE 这个动词沿用了早期版本，归档与物理删除在语义上是两件事。 */
  app.delete(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      archiveAccount(ctx, m.userId, m.ledgerId, accountId);
      return reply.code(204).send();
    },
  );

  /** 取消归档：账户重新回到日常列表（与 `DELETE` 归档互为逆操作） */
  app.post(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/restore',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      return ok(restoreAccount(ctx, m.userId, m.ledgerId, accountId));
    },
  );

  /** 物理删除（不可恢复）。有账单或其它记录引用时拒绝 —— 那种情况应走归档。 */
  app.post(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/purge',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      return ok(deleteAccount(ctx, m.userId, m.ledgerId, accountId));
    },
  );
}
