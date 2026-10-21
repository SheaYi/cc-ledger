/**
 * 跨模块协同路由（`docs/15` 的 X-01 / X-02 / X-04 / X-07）。
 *
 * X-03（月度锁定）在 `periodClosures`，X-05 / X-06 在 `stats`，
 * 这里只挂真正横跨预算 / 统计 / 对账三方的端点。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import { closedPeriodsOf } from '../periodClosures/service.js';
import {
  backdatedWarnings,
  incrementalRefresh,
  internalFlowAudit,
  listBackdated,
  recordBackdated,
  subscriptionDigest,
} from './service.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

const backdatedBody = z.object({
  txId: z.string().min(1),
  source: z.enum(['reconcile', 'import', 'manual', 'amend']),
  reconRecordId: z.string().min(1).nullish(),
  note: z.string().trim().max(200).nullish(),
});

export async function registerCollabRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId';
  const opts = { preHandler: app.requireAuth };

  /** X-01 记账后增量刷新：只重算受影响期间，返回受影响的预算行与本期汇总 */
  app.post(`${base}/incremental-refresh`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(z.object({ txDate: dateStr.nullish() }), req.body ?? {});
    return ok(incrementalRefresh(ctx, m.ledgerId, body.txDate ?? undefined));
  });

  /** X-02 登记跨期修订 */
  app.post(`${base}/backdated-adjustments`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(backdatedBody, req.body);
    return ok(recordBackdated(ctx, m.ledgerId, m.userId, body));
  });

  app.get(`${base}/backdated-adjustments`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { from?: string; to?: string };
    return ok(listBackdated(ctx, m.ledgerId, q.from, q.to));
  });

  /** X-02 跨期修订提示（只提示已结账期间被改的情形） */
  app.get(`${base}/backdated-warnings`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(backdatedWarnings(ctx, m.ledgerId, closedPeriodsOf(ctx, m.ledgerId)));
  });

  /** X-04 内部转账不计收支 —— 可执行的口径自检 */
  app.get(`${base}/internal-flow-audit`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { from?: string; to?: string };
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const from = q.from ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const to = q.to ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return ok(internalFlowAudit(ctx, m.ledgerId, from, to));
  });

  /** X-07 异常订阅汇总（对账识别 + 统计年化 + 预算预提建议） */
  app.get(`${base}/subscription-digest`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(subscriptionDigest(ctx, m.ledgerId));
  });
}
