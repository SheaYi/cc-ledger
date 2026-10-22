/** 对账路由（docs/04 §十二）挂载在 /api/v1/ledgers/:ledgerId 下。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { RECONCILE_REASONS } from '../../config/constants.js';
import { HttpError, ok } from '../../utils/errors.js';
import { parseAmountToCents } from '../../utils/money.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  listReconciliations,
  previewReconcile,
  reconciliationSummary,
  submitReconcile,
} from './service.js';
import {
  BANK_SYNC_STATUS,
  addAdjustingItem,
  amendTransaction,
  autoMatch,
  clearAdjustingItem,
  correctionGuide,
  creditCardBilling,
  duplicateCharges,
  importStatement,
  listStatementLines,
  listStatements,
  manualMatch,
  matchRate,
  missingReceipts,
  reconHistory,
  reviewDuplicateGroup,
  reconSchedule,
  reconStatement,
  reverseTransaction,
  setReconSchedule,
} from './advanced.js';

const amount = z.union([z.string(), z.number()]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

/** 重复扣费人工判定：只有「确认是重复」和「忽略」两种结论，没有中间态 */
const duplicateReviewSchema = z.object({
  groupKey: z.string().min(1).max(200),
  status: z.enum(['confirmed', 'ignored']),
  note: z.string().max(200).optional(),
});

const amendBody = z.object({
  amount: amount.nullish(),
  txDate: dateStr.nullish(),
  categoryId: z.string().min(1).nullable().nullish(),
  name: z.string().trim().max(60).nullable().nullish(),
  merchant: z.string().trim().max(60).nullable().nullish(),
  note: z.string().trim().max(200).nullable().nullish(),
  reason: z.string().trim().min(1).max(200),
});

const scheduleBody = z.object({
  cycle: z.enum(['weekly', 'monthly']).nullable(),
  anchorDay: z.number().int().min(0).max(31).nullish(),
  remindDays: z.number().int().min(0).max(30).nullish(),
});

const importBody = z.object({
  filename: z.string().max(120).nullish(),
  content: z.string().min(1),
  mapping: z.object({
    date: z.string().min(1),
    amount: z.string().min(1),
    amountOut: z.string().nullish(),
    description: z.string().nullish(),
    merchant: z.string().nullish(),
    balance: z.string().nullish(),
  }),
  statementMonth: z.string().regex(/^\d{4}-\d{2}$/).nullish(),
});

const matchBody = z.object({
  txId: z.string().min(1).nullable(),
  reason: z.string().trim().max(120).nullish(),
});

const adjustingBody = z.object({
  accountId: z.string().min(1),
  side: z.enum(['positive', 'negative']),
  kind: z.enum([
    'in_transit',
    'deposit_in_transit',
    'outstanding_check',
    'bank_error',
    'our_error',
  ]),
  itemDate: dateStr,
  amount,
  note: z.string().trim().max(200).nullish(),
  relatedTxId: z.string().min(1).nullish(),
});

const baseSchema = z.object({
  actualBalance: amount,
  reconcileDate: dateStr.optional(),
});

/**
 * 用户确认的差异归因（R-02）。
 *
 * ⚠️ 这里**刻意用 `z.string()` 而不是 `z.enum`**：
 * `normalizeAttribution` 已经负责过滤非法 `kind`，而 zod 的默认行为是
 * **静默丢弃**未知字段（不是报错）。若这里写成 enum，
 * 一个前端传了稍新的 kind 就会让整个对账提交失败 ——
 * 而归因是**辅助信息**，它坏掉不该阻断「修正余额」这件正事。
 * 所以宽松接收、宽松过滤。
 */
const attributionSchema = z.object({
  kind: z.string().min(1).max(32),
  amount: amount.nullish(),
  note: z.string().trim().max(200).nullish(),
});

const submitSchema = baseSchema.extend({
  reasonCode: z.enum(RECONCILE_REASONS).nullish(),
  reasonNote: z.string().trim().max(200).nullish(),
  createAdjustment: z.boolean().optional(),
  lockBeforeDate: z.boolean().optional(),
  attributions: z.array(attributionSchema).max(20).nullish(),
});

export async function registerReconciliationRoutes(
  app: FastifyInstance,
  ctx: AppCtx,
): Promise<void> {
  app.post(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/reconcile/preview',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const body = parseOrThrow(baseSchema, req.body);
      return ok(previewReconcile(ctx, m.ledgerId, accountId, body));
    },
  );

  app.post(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/reconcile',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const body = parseOrThrow(submitSchema, req.body);
      return ok(submitReconcile(ctx, m.userId, m.ledgerId, accountId, body));
    },
  );

  app.get('/api/v1/ledgers/:ledgerId/reconciliations', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as {
      accountId?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: string;
    };
    return ok(
      listReconciliations(ctx, m.ledgerId, {
        accountId: q.accountId,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });

  app.get(
    '/api/v1/ledgers/:ledgerId/reconciliation-summary',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      return ok(reconciliationSummary(ctx, m.ledgerId));
    },
  );

  /* ================================================================ *
   * `docs/15` 进阶对账（R-03、R-05 ~ R-14）
   * ================================================================ */

  /** R-03 更正路径建议：这条账单该用哪种更正方式 */
  app.get(
    '/api/v1/ledgers/:ledgerId/transactions/:txId/correction-guide',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { txId } = req.params as { txId: string };
      return ok(correctionGuide(ctx, m.ledgerId, txId));
    },
  );

  /** R-03 划线更正（直接改，留痕） */
  app.post(
    '/api/v1/ledgers/:ledgerId/transactions/:txId/amend',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { txId } = req.params as { txId: string };
      const body = parseOrThrow(amendBody, req.body);
      return ok(amendTransaction(ctx, m.ledgerId, m.userId, { txId, ...body }));
    },
  );

  /** R-03 红字冲销（不自动重记 —— 撤销与重记是两个独立动作） */
  app.post(
    '/api/v1/ledgers/:ledgerId/transactions/:txId/reverse',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { txId } = req.params as { txId: string };
      const body = parseOrThrow(z.object({ reason: z.string().trim().min(1).max(200) }), req.body);
      return ok(reverseTransaction(ctx, m.ledgerId, m.userId, { txId, reason: body.reason }));
    },
  );

  /** R-04 单账户对账履历（含归因明细） */
  app.get(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/reconciliations',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const q = req.query as { limit?: string };
      return ok(reconHistory(ctx, m.ledgerId, accountId, q.limit ? Number(q.limit) : 12));
    },
  );

  /** R-05 对账排期总览 */
  app.get('/api/v1/ledgers/:ledgerId/recon-schedule', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(reconSchedule(ctx, m.ledgerId));
  });

  /** R-05 设置某个账户的对账周期 */
  app.put(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/recon-schedule',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const body = parseOrThrow(scheduleBody, req.body);
      return ok(setReconSchedule(ctx, m.ledgerId, m.userId, { accountId, ...body }));
    },
  );

  /** R-06 流水导入（编码探测 + 字段映射 + 预检去重，不落业务库） */
  app.post(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/statements/import',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const body = parseOrThrow(importBody, req.body);
      return ok(importStatement(ctx, m.ledgerId, m.userId, { accountId, ...body }));
    },
  );

  /** R-06 流水批次列表 */
  app.get('/api/v1/ledgers/:ledgerId/statements', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { accountId?: string };
    return ok(listStatements(ctx, m.ledgerId, q.accountId));
  });

  /** R-07 自动匹配（三态） */
  app.post(
    '/api/v1/ledgers/:ledgerId/statements/:statementId/match',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { statementId } = req.params as { statementId: string };
      const body = parseOrThrow(z.object({ windowDays: z.number().int().min(0).max(15).nullish() }), req.body ?? {});
      return ok(autoMatch(ctx, m.ledgerId, statementId, body.windowDays ?? undefined));
    },
  );

  /** R-08 人工勾兑 */
  app.post(
    '/api/v1/ledgers/:ledgerId/statement-lines/:lineId/match',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { lineId } = req.params as { lineId: string };
      const body = parseOrThrow(matchBody, req.body);
      return ok(manualMatch(ctx, m.ledgerId, { lineId, ...body }));
    },
  );

  /** R-08 流水行列表（匹配工作台） */
  app.get(
    '/api/v1/ledgers/:ledgerId/statements/:statementId/lines',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { statementId } = req.params as { statementId: string };
      return ok(listStatementLines(ctx, m.ledgerId, statementId));
    },
  );

  /** R-09 余额调节表（含等式验证） */
  app.get(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/recon-statement',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const q = req.query as { statementBalance?: string; asOf?: string };
      if (!q.statementBalance) {
        throw HttpError.validation([
          { field: 'statementBalance', message: '需要提供银行对账单余额' },
        ]);
      }
      return ok(
        reconStatement(ctx, m.ledgerId, accountId, parseAmountToCents(q.statementBalance), q.asOf),
      );
    },
  );

  /** R-09 未达账项 */
  app.post('/api/v1/ledgers/:ledgerId/recon-adjusting-items', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(adjustingBody, req.body);
    return ok(addAdjustingItem(ctx, m.ledgerId, m.userId, body));
  });

  app.post(
    '/api/v1/ledgers/:ledgerId/recon-adjusting-items/:id/clear',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { id } = req.params as { id: string };
      const body = parseOrThrow(z.object({ txId: z.string().min(1).nullish() }), req.body ?? {});
      return ok(clearAdjustingItem(ctx, m.ledgerId, id, body.txId ?? null));
    },
  );

  /** R-10 信用卡账单日对账 */
  app.get(
    '/api/v1/ledgers/:ledgerId/accounts/:accountId/credit-billing',
    { preHandler: app.requireAuth },
    async (req) => {
      const m = membershipFromRequest(ctx, req);
      const { accountId } = req.params as { accountId: string };
      const q = req.query as { year?: string; month?: string };
      return ok(
        creditCardBilling(
          ctx,
          m.ledgerId,
          accountId,
          q.year ? Number(q.year) : undefined,
          q.month ? Number(q.month) : undefined,
        ),
      );
    },
  );

  /** R-11 记账完整度（匹配率 + 缺失明细），支持时间范围与账单来源筛选 */
  app.get('/api/v1/ledgers/:ledgerId/recon-match-rate', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as {
      accountId?: string;
      from?: string;
      to?: string;
      statementId?: string;
      source?: string;
    };
    return ok(
      matchRate(ctx, m.ledgerId, q.accountId, {
        from: q.from,
        to: q.to,
        statementId: q.statementId,
        source: q.source,
      }),
    );
  });

  /** R-12 重复扣费：订阅线索 + 疑似重复交易（对账视角） */
  app.get('/api/v1/ledgers/:ledgerId/duplicate-charges', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { windowDays?: string; includeReviewed?: string };
    return ok(
      duplicateCharges(ctx, m.ledgerId, {
        windowDays: q.windowDays ? Number(q.windowDays) : undefined,
        includeReviewed: q.includeReviewed === '1' || q.includeReviewed === 'true',
      }),
    );
  });

  /**
   * R-12 重复扣费的人工判定：确认重复 / 忽略。
   * ⚠️ 只记录意见，不动账目 —— 删哪一笔由用户决定，自动删等于替他处置财务数据。
   */
  app.post('/api/v1/ledgers/:ledgerId/duplicate-reviews', { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(duplicateReviewSchema, req.body);
    return reply
      .code(201)
      .send(ok(reviewDuplicateGroup(ctx, m.ledgerId, body.groupKey, body.status, m.userId, body.note)));
  });

  /** R-13 缺凭证的大额支出 */
  app.get('/api/v1/ledgers/:ledgerId/missing-receipts', { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { minAmount?: string };
    return ok(missingReceipts(ctx, m.ledgerId, q.minAmount ? parseAmountToCents(q.minAmount) : 20_000));
  });

  /**
   * R-14 银行自动同步：**明确返回不支持**而不是静默缺失。
   * 国内个人银行账户数据对外提供受合规限制，与其做一个随时会被叫停的功能，
   * 不如把能力放在导入 + 自动匹配 + 调节表上。
   */
  app.get('/api/v1/ledgers/:ledgerId/bank-sync', { preHandler: app.requireAuth }, async () => {
    return ok(BANK_SYNC_STATUS);
  });
}
