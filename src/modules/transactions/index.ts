/**
 * 账单路由（docs/04 §八）挂载在 /api/v1/ledgers/:ledgerId 下。
 *
 * 权限：账本内 owner/admin/member **均可**记账与修改（docs/02 §3.4）。
 * 唯一例外：永久删除与清空回收站仅 owner/admin（docs/04 §8.4）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { DIRECTION_BY_RECORD_TYPE, RECORD_TYPES, TX_DIRECTIONS } from '../../config/constants.js';
import { HttpError, ok, okList } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest, requireRole } from '../ledgers/access.js';
import {
  batchTag,
  createTransaction,
  dailyTotals,
  duplicateTransaction,
  emptyTrash,
  getTransaction,
  listTransactions,
  newDefaults,
  permanentDelete,
  previewAmounts,
  restoreTransaction,
  softDeleteTransaction,
  suggestValues,
  syncTags,
  updateTransaction,
  type ListQuery,
  type TxInput,
} from './service.js';
import { today } from '../../utils/money.js';

const amount = z.union([z.string(), z.number()]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const timeStr = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, '时间格式应为 HH:mm 或 HH:mm:ss');

const baseTx = {
  recordType: z.enum(RECORD_TYPES),
  direction: z.enum(TX_DIRECTIONS).optional(),
  accountId: z.string().min(1),
  toAccountId: z.string().min(1).nullish(),
  categoryId: z.string().min(1).nullish(),
  name: z.string().max(200).nullish(),
  amount,
  fee: amount.optional(),
  discount: amount.optional(),
  merchant: z.string().max(200).nullish(),
  counterparty: z.string().max(200).nullish(),
  tags: z.array(z.string().min(1)).max(20).nullish(),
  note: z.string().max(2000).nullish(),
  txDate: dateStr,
  txTime: timeStr.nullish(),
  adjustmentReason: z.string().max(40).nullish(),
  /**
   * 退款（docs/15 审查增补）：本笔是支出 / 收入的**冲减项**。
   * 传 true 等价于 `adjustmentReason: 'refund'`，二者给一个即可。
   *
   * 它不改变 record_type —— 退款仍然是 expense，只是现金流反向、
   * 统计侧按「Σ正常 − Σ冲减」汇总。这样部分退款、跨月退款、
   * 退款后统计回落三件事都自然成立，不需要任何回滚动作。
   */
  isRefund: z.boolean().nullish(),
  clientRequestId: z.string().min(8).max(64).nullish(),
  templateId: z.string().min(1).nullish(),
  /**
   * 结清关联（docs/12 §六 D9）：最多 20 条（一笔结算最多冲抵 20 笔产生，
   * 够用了；真要更多就该批量拆分结算笔而不是拉长一条）。
   */
  settles: z
    .array(
      z.object({
        transactionId: z.string().min(1),
        amount: amount,
      }),
    )
    .max(20)
    .nullish(),
};

const createSchema = z.object(baseTx);

/**
 * 预览 schema = **完整的**账单入参（`baseTx` 的全字段）。
 *
 * ⚠️ 早先这里只声明了 `recordType / direction / amount / fee / discount` 五个字段，
 *    其余（accountId / toAccountId / categoryId / txDate / …）被 **zod 静默丢弃** ——
 *    请求照样 200，但预览算出来的 Δ 是「拿一个没有账户的转账去算」的结果。
 *    它之所以长期没被发现，是因为 `smoke:8` 的断言只查 HTTP 状态码与返回体，
 *    而返回体里恰好还有 `accountDelta`（服务层自己查了账户）。
 *
 *    与 `createSchema` 的差别只有一处：**预览不落库，所以「定位字段」全都可选** ——
 *    缺 `txDate` 就按今天算，缺 `accountId` 就只算与账户无关的部分（净额、费用）。
 *    所以这里把 baseTx 的四个定位字段放宽成 `.optional()`，其余原样复用。
 */
const previewSchema = z
  .object({
    ...baseTx,
    accountId: z.string().min(1).optional(),
    toAccountId: z.string().min(1).nullish(),
    categoryId: z.string().min(1).nullish(),
    txDate: dateStr.optional(),
  })
  /**
   * `settles` 与 `clientRequestId` 对预览毫无意义（前者是结清关联、后者是幂等键），
   * 显式剔除而不是留着忽略 —— 留着会让调用方以为「预览也认这两个」。
   */
  .omit({ settles: true, clientRequestId: true, templateId: true });

const updateSchema = z
  .object({ ...baseTx, expectedUpdatedAt: z.string().nullish() })
  .partial()
  .extend({ accountId: z.string().min(1).optional(), txDate: dateStr.optional() })
  .refine((v) => Object.keys(v).length > 1 || !('expectedUpdatedAt' in v), {
    message: '至少提供一个待更新字段',
  });

const batchSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

/** 校验「类型 + 方向」组合合法，否则抛 400（与 DDL 的 ck_direction_by_type 同源） */
function assertDirectionPair(recordType: string, direction: string | undefined) {
  if (!direction) return;
  const allowed = DIRECTION_BY_RECORD_TYPE[recordType as keyof typeof DIRECTION_BY_RECORD_TYPE];
  if (!allowed || !allowed.includes(direction as never)) {
    throw HttpError.validation([{ field: 'direction', message: '该记录类型不支持此方向' }]);
  }
}

function asTxInput(b: z.infer<typeof createSchema>): TxInput {
  return { ...b } as TxInput;
}

export async function registerTransactionRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  /* ---------------- 表单初始态（docs/13 §5） ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/transactions/new-defaults', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(newDefaults(ctx, m.ledgerId, m.userId));
  });

  /* ---------------- 历史补全（docs/07 Stage 8） ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/suggest/:field', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { field } = req.params as { field: string };
    if (!['merchant', 'counterparty', 'name'].includes(field)) {
      throw HttpError.notFound('不支持的补全字段');
    }
    const q = req.query as { keyword?: string; limit?: string };
    return ok(
      suggestValues(
        ctx,
        m.ledgerId,
        field as 'merchant' | 'counterparty' | 'name',
        q.keyword,
        q.limit ? Number(q.limit) : 20,
      ),
    );
  });

  /* ---------------- 金额预览（docs/04 §8.7） ---------------- */
  app.post('/api/v1/ledgers/:ledgerId/transactions/preview', { preHandler: app.requireAuth }, async (req) => {
    membershipFromRequest(ctx, req);
    const body = parseOrThrow(previewSchema, req.body);
    assertDirectionPair(body.recordType, body.direction);
    const r = previewAmounts(asTxInput(body as z.infer<typeof createSchema>));
    return ok({
      recordType: r.recordType,
      direction: r.direction,
      amount: String(body.amount),
      fee: String(body.fee ?? '0'),
      discount: String(body.discount ?? '0'),
      actualAmount: fmt(r.actualAmount),
      accountDelta: fmt(r.accountDelta),
      toAccountDelta: r.toAccountDelta === null ? null : fmt(r.toAccountDelta),
      feeAccountDelta: r.feeAccountDelta === 0 ? null : fmt(r.feeAccountDelta),
      extraDeltas: r.extraDeltas.map((e) => ({ ...e, delta: fmt(e.delta) })),
      explanation: r.explanation,
      previewLines: r.previewLines,
    });
  });

  /* ---------------- 回收站（docs/04 §8.4） ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/transactions/trash', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as ListQuery;
    const r = listTransactions(ctx, m.ledgerId, {
      ...q,
      includeDeleted: true,
      sort: q.sort ?? '-occurredAt',
    });
    return okList(r.data, { ...r.meta, trash: true });
  });

  app.delete('/api/v1/ledgers/:ledgerId/transactions/trash', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    requireRole(m, 'owner', 'admin');
    emptyTrash(ctx, m.userId, m.ledgerId);
    return reply.code(204).send();
  });

  /* ---------------- 批量操作（docs/04 §8.6） ---------------- */
  app.post('/api/v1/ledgers/:ledgerId/transactions/batch-delete', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ids } = parseOrThrow(batchSchema, req.body);
    let n = 0;
    for (const id of ids) {
      softDeleteTransaction(ctx, m.userId, m.ledgerId, id);
      n += 1;
    }
    return ok({ deleted: n });
  });

  /**
   * 批量恢复（回收站）。
   *
   * 与 `batch-delete` 对称：回收站页要「勾选多条 → 一次性恢复」，
   * 没有它就得在前端循环调 `POST /:id/restore` —— N 次往返不说，
   * 中途失败会留下**恢复了一半**的状态，而回收站里剩下的那些
   * 用户会以为「没勾到」从而再点一次（重复恢复同一笔）。
   */
  app.post('/api/v1/ledgers/:ledgerId/transactions/batch-restore', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { ids } = parseOrThrow(batchSchema, req.body);
    let n = 0;
    for (const id of ids) {
      restoreTransaction(ctx, m.userId, m.ledgerId, id);
      n += 1;
    }
    return ok({ restored: n });
  });

  app.post('/api/v1/ledgers/:ledgerId/transactions/batch-tag', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(
      batchSchema.extend({
        tagIds: z.array(z.string().min(1)).max(20),
        mode: z.enum(['add', 'replace']).default('add'),
      }),
      req.body,
    );
    if (body.mode === 'replace') {
      for (const id of body.ids) syncTags(ctx, m.ledgerId, id, body.tagIds);
    } else {
      batchTag(ctx, m.ledgerId, body.ids, body.tagIds);
    }
    return ok({ updated: body.ids.length });
  });

  /* ---------------- 列表 / 创建 ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/transactions', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = listTransactions(ctx, m.ledgerId, req.query as ListQuery);
    return okList(r.data, r.meta);
  });

  app.get('/api/v1/ledgers/:ledgerId/transactions/daily-totals', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { dateFrom?: string; dateTo?: string };
    const now = new Date();
    const from = q.dateFrom ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const to = q.dateTo ?? today();
    return ok(dailyTotals(ctx, m.ledgerId, from, to));
  });

  app.post('/api/v1/ledgers/:ledgerId/transactions', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(createSchema, req.body);
    assertDirectionPair(body.recordType, body.direction);
    const { row, reused } = createTransaction(ctx, m.userId, m.ledgerId, asTxInput(body));
    const payload = getTransaction(ctx, m.ledgerId, row.id);
    if (reused) return reply.code(200).send(ok(payload));
    return reply.code(201).send(ok(payload));
  });

  /* ---------------- 单条 ---------------- */
  app.get('/api/v1/ledgers/:ledgerId/transactions/:id', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(getTransaction(ctx, m.ledgerId, id));
  });

  app.patch('/api/v1/ledgers/:ledgerId/transactions/:id', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    const header = req.headers['if-unmodified-since'];
    const body = parseOrThrow(updateSchema, req.body);
    if (body.recordType) assertDirectionPair(body.recordType, body.direction);
    const expected =
      body.expectedUpdatedAt ?? (typeof header === 'string' && header ? header : null);
    const row = updateTransaction(ctx, m.userId, m.ledgerId, id, {
      ...(body as Partial<TxInput>),
      expectedUpdatedAt: expected,
    });
    return ok(getTransaction(ctx, m.ledgerId, row.id));
  });

  app.delete('/api/v1/ledgers/:ledgerId/transactions/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    softDeleteTransaction(ctx, m.userId, m.ledgerId, id);
    return reply.code(204).send();
  });

  app.post('/api/v1/ledgers/:ledgerId/transactions/:id/restore', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    const row = restoreTransaction(ctx, m.userId, m.ledgerId, id);
    return ok(getTransaction(ctx, m.ledgerId, row.id));
  });

  app.delete(
    '/api/v1/ledgers/:ledgerId/transactions/:id/permanent',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const m = membershipFromRequest(ctx, req);
      requireRole(m, 'owner', 'admin');
      const { id } = req.params as { id: string };
      permanentDelete(ctx, m.userId, m.ledgerId, id);
      return reply.code(204).send();
    },
  );

  /* ---------------- 复制（docs/04 §8.5） ---------------- */
  app.post('/api/v1/ledgers/:ledgerId/transactions/:id/duplicate', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    const body = z
      .object({ amount: amount.optional(), txDate: dateStr.optional(), txTime: timeStr.nullish() })
      .parse(req.body ?? {});
    const row = duplicateTransaction(ctx, m.userId, m.ledgerId, id, body);
    return reply.code(201).send(ok(getTransaction(ctx, m.ledgerId, row.id)));
  });
}

/** 分 → 十进制字符串（与 utils/money 的 formatCents 同义，此处避免额外 import 噪音） */
function fmt(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
