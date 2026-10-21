/** 期间关闭路由（`docs/04 §十六`），挂在 `/api/v1/ledgers/:ledgerId` 下。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest, requireRole } from '../ledgers/access.js';
import { closePeriod, closureStatus, listClosures, reopenPeriod } from './service.js';

const yearMonth = z.object({
  year: z.number().int().min(1970).max(9999),
  month: z.number().int().min(1).max(12),
});

/**
 * ⚠️ 查询串里的数字是**字符串**，必须 `z.coerce` 转成 number 才能过 `z.number()`。
 * 写成 `z.number()` 会得到一条「expected number, received string」——
 * 而这个错误信息里没有任何字段路径，用户完全看不出是自己传的 year 有问题。
 */
const yearMonthQuery = z.object({
  year: z.coerce.number().int().min(1970).max(9999),
  month: z.coerce.number().int().min(1).max(12),
});

const closeSchema = yearMonth.extend({ note: z.string().max(200).nullish() });

export async function registerPeriodClosureRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/period-closures';

  app.get(base, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { year?: string };
    return ok(listClosures(ctx, m.ledgerId, q.year ? Number(q.year) : undefined));
  });

  app.get(`${base}/status`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = parseOrThrow(yearMonthQuery, req.query);
    return ok(closureStatus(ctx, m.ledgerId, q.year, q.month));
  });

  /**
   * ⚠️ 路由形状说明：本模块**刻意没有** `GET /period-closures/:id`。
   * 单条记录直接包含在列表里，没有单独读的用例；而一旦加了它，
   * `GET /period-closures/status` 就会与它在 radix 树的同一深度上竞争 ——
   * Fastify 取先注册的那个，后注册的那个会**静默不可达**。
   * 所以要按单条查请用 `?year=` 过滤列表，不要新增 `GET /:id`。
   */
  app.post(base, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    // 结账是**不可逆的**历史操作：member 不该能做，限定 owner/admin
    requireRole(m, 'owner', 'admin');
    const body = parseOrThrow(closeSchema, req.body);
    return reply.code(201).send(ok(closePeriod(ctx, m.userId, m.ledgerId, body)));
  });

  app.delete(`${base}/:id`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    requireRole(m, 'owner', 'admin');
    const { id } = req.params as { id: string };
    // 解锁理由走 query（DELETE 不带 body 是本项目纪律：带 body 的 DELETE
    // 在部分代理与 CDN 上会被剥掉，而理由是可选信息，不值得为它破坏兼容性）
    const q = req.query as { reason?: string };
    return ok(reopenPeriod(ctx, m.userId, m.ledgerId, id, q.reason ?? null));
  });
}
