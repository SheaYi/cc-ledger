/**
 * 债权债务路由（docs/04 §8.12）：未结清视图 + 记账页「结清哪一笔」的候选项。
 *
 * 权限：与账单一致 —— 账本内 owner/admin/member 均可读（docs/02 §3.4）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECORD_TYPES } from '../../config/constants.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import { listSettleable, openDebts } from './service.js';

const listQuery = z.object({
  status: z.enum(['open', 'all']).optional(),
  counterparty: z.string().trim().min(1).max(50).optional(),
});

const settleableQuery = z.object({
  recordType: z.enum(['receivable', 'payable']),
});

export async function registerDebtRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  /**
   * 未结清视图。两张汇总卡直接读虚拟台账余额（权威总额），
   * `items` 是逐笔归属；`unallocated*` 是没归属到任何产生笔的结算 / 核销金额。
   */
  app.get('/api/v1/ledgers/:ledgerId/debts', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = parseOrThrow(listQuery, req.query);
    return ok(openDebts(ctx, m.ledgerId, q));
  });

  /** 记账页选了「收回 / 还款 / 核销」阶段后，这里给「结清哪一笔」的候选项 */
  app.get(
    '/api/v1/ledgers/:ledgerId/debts/settleable',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { recordType } = parseOrThrow(settleableQuery, req.query);
      return ok(listSettleable(ctx, m.ledgerId, recordType));
    },
  );
}

export { RECORD_TYPES };
