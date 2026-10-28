/**
 * 统计路由（`docs/04 §十三`），挂在 `/api/v1/ledgers/:ledgerId/stats` 下。
 *
 * 全部 GET、全部只读 —— 统计永远不该有副作用。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  byAccount,
  byCategory,
  byCounterparty,
  byMerchant,
  byTag,
  outstanding,
  summary,
  trend,
  type Granularity,
} from './service.js';
import {
  BUILTIN_REPORTS,
  budgetExecution,
  backfillNetWorthSnapshots,
  captureNetWorthSnapshot,
  cashFlowStatement,
  categoryExpenseNetOfReimbursement,
  comparison,
  accountsBalance,
  byMember,
  confirmSubscription,
  createEvent,
  createPolicyVersion,
  createReimbursement,
  createReport,
  currentPolicy,
  DEFAULT_POLICY_VERSION,
  deleteEvent,
  deleteReport,
  detectSubscriptions,
  drilldown,
  exportCsv,
  heatmap,
  ignoreSubscription,
  insights,
  listEvents,
  listPolicyVersions,
  listReimbursements,
  listReports,
  netWorthSeries,
  periodOf,
  periodReport,
  runReport,
  updateReport,
  voidReimbursement,
  weekdaySpending,
  yearOverYear,
  type ReportConfig,
  type ReportPeriod,
} from './advanced.js';

interface RangeQuery {
  dateFrom?: string;
  dateTo?: string;
  recordType?: string;
  level?: string;
  granularity?: string;
  limit?: string;
  year?: string;
  month?: string;
  period?: string;
  anchor?: string;
  keyword?: string;
  categoryId?: string;
  parentCategoryId?: string;
  accountId?: string;
  tagId?: string;
  offset?: string;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const amountish = z.union([z.string(), z.number()]);

const eventBody = z.object({
  eventDate: dateStr,
  title: z.string().trim().min(1).max(60),
  note: z.string().trim().max(200).nullish(),
  expectedAmount: amountish.nullish(),
  tagId: z.string().min(1).nullish(),
});

const reportBody = z.object({
  name: z.string().trim().min(1).max(40),
  config: z.object({
    groupBy: z.array(z.enum(['category', 'account', 'tag', 'month', 'day'])).min(1),
    metrics: z.array(z.enum(['expense', 'income', 'net', 'count'])).min(1),
    range: z.object({ from: dateStr.nullish(), to: dateStr.nullish() }).nullish(),
    recordType: z.enum(['expense', 'income']).nullish(),
    filters: z
      .object({
        categoryIds: z.array(z.string()).nullish(),
        accountIds: z.array(z.string()).nullish(),
        tagIds: z.array(z.string()).nullish(),
      })
      .nullish(),
  }),
  sortOrder: z.number().int().nullish(),
});

const reportPatch = z.object({
  name: z.string().trim().min(1).max(40).nullish(),
  config: reportBody.shape.config.nullish(),
  sortOrder: z.number().int().nullish(),
});

const subBody = z.object({
  fingerprint: z.string().min(1).max(120),
  merchant: z.string().min(1).max(80),
  periodType: z.string().min(1).max(16),
  amount: amountish,
  firstSeen: dateStr,
  lastSeen: dateStr,
  occurrenceCount: z.number().int().min(2),
  userLabel: z.string().trim().max(40).nullish(),
});

const policyBody = z.object({
  version: z.string().trim().min(1).max(24),
  effectiveFrom: dateStr,
  changes: z.array(z.unknown()).max(50).default([]),
  note: z.string().trim().max(200).nullish(),
});

const reimbBody = z.object({
  originTxId: z.string().min(1),
  receivedTxId: z.string().min(1),
  amount: amountish,
  claimDate: dateStr,
  receivedDate: dateStr,
  orgName: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(200).nullish(),
});

/** 期初期末缺省：今年 1 号 → 今天 */
function rangeOf(q: RangeQuery): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const to = q.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(q.dateTo) ? q.dateTo : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const from =
    q.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(q.dateFrom)
      ? q.dateFrom
      : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  return { from, to };
}

export async function registerStatsRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/stats';
  const opts = { preHandler: app.requireAuth };

  app.get(`${base}/summary`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(
      summary(ctx, m.ledgerId, q.dateFrom, q.dateTo, q.keyword, {
        accountId: q.accountId,
        parentCategoryId: q.parentCategoryId,
        categoryId: q.categoryId,
        recordTypes: q.recordType,
      }),
    );
  });

  app.get(`${base}/trend`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const g = (q.granularity ?? 'day') as Granularity;
    return ok(
      trend(ctx, m.ledgerId, g, q.dateFrom, q.dateTo, q.keyword, {
        accountId: q.accountId,
        parentCategoryId: q.parentCategoryId,
        categoryId: q.categoryId,
        recordTypes: q.recordType,
      }),
    );
  });

  app.get(`${base}/by-category`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const level = q.level === '2' ? 2 : 1;
    return ok(
      byCategory(ctx, m.ledgerId, q.recordType ?? 'expense', q.dateFrom, q.dateTo, level, q.keyword, {
        accountId: q.accountId,
        parentCategoryId: q.parentCategoryId,
        categoryId: q.categoryId,
      }),
    );
  });

  app.get(`${base}/by-account`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(
      byAccount(ctx, m.ledgerId, q.dateFrom, q.dateTo, q.keyword, {
        accountId: q.accountId,
        parentCategoryId: q.parentCategoryId,
        categoryId: q.categoryId,
        recordTypes: q.recordType,
      }),
    );
  });

  app.get(`${base}/by-merchant`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(byMerchant(ctx, m.ledgerId, q.dateFrom, q.dateTo, q.limit ? Number(q.limit) : undefined, q.keyword));
  });

  app.get(`${base}/by-counterparty`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(byCounterparty(ctx, m.ledgerId, q.dateFrom, q.dateTo, q.limit ? Number(q.limit) : undefined, q.keyword));
  });

  app.get(`${base}/by-tag`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(byTag(ctx, m.ledgerId, q.dateFrom, q.dateTo, q.keyword));
  });

  /** 两个端点返回同一份权威数据，只是各自取一半（`docs/04` 写的是分开两个） */
  app.get(`${base}/outstanding-receivables`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(outstanding(ctx, m.ledgerId).receivable);
  });

  app.get(`${base}/outstanding-payables`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(outstanding(ctx, m.ledgerId).payable);
  });

  /* ================================================================ *
   * `docs/15` 进阶统计（S-05 ~ S-17 + X-05 / X-06）
   * ================================================================ */

  /** S-05 预算执行视图（预实对比） */
  app.get(`${base}/budget-execution`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const now = new Date();
    const year = Number(q.year ?? now.getFullYear());
    const month = Number(q.month ?? now.getMonth() + 1);
    return ok(budgetExecution(ctx, m.ledgerId, year, month));
  });

  /** S-06 图表下钻：图 → 分类 → 明细 → 单笔 */
  app.get(`${base}/drilldown`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const r = rangeOf(q);
    return ok(
      drilldown(ctx, m.ledgerId, {
        from: r.from,
        to: r.to,
        categoryId: q.categoryId,
        accountId: q.accountId,
        tagId: q.tagId,
        keyword: q.keyword,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      }),
    );
  });

  /** S-07 多周期报表：week / month / year */
  app.get(`${base}/report`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const kind = (['week', 'month', 'year'].includes(q.period ?? '') ? q.period : 'month') as ReportPeriod;
    return ok(periodReport(ctx, m.ledgerId, kind, q.anchor));
  });

  /** S-08 环比（含天数校准） */
  app.get(`${base}/comparison`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const r = rangeOf(q);
    return ok(
      comparison(ctx, m.ledgerId, r.from, r.to, q.keyword, {
        accountId: q.accountId,
        parentCategoryId: q.parentCategoryId,
        categoryId: q.categoryId,
        recordTypes: q.recordType,
      }),
    );
  });

  /** S-09 净资产序列 */
  app.get(`${base}/net-worth`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(netWorthSeries(ctx, m.ledgerId, q.limit ? Number(q.limit) : 12));
  });

  /** S-09 写月末快照（幂等） */
  app.post(`${base}/net-worth/snapshots`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(z.object({ snapshotDate: dateStr }), req.body);
    return ok(
      captureNetWorthSnapshot(
        ctx,
        m.ledgerId,
        body.snapshotDate,
        currentPolicy(ctx, m.ledgerId) || DEFAULT_POLICY_VERSION,
      ),
    );
  });

  /** S-09 补拍历史快照（最近 12 个已结束月份，幂等） */
  app.post(`${base}/net-worth/snapshots/backfill`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(backfillNetWorthSnapshots(ctx, m.ledgerId));
  });

  /** S-11 同比分析 */
  app.get(`${base}/year-over-year`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const now = new Date();
    return ok(
      yearOverYear(
        ctx,
        m.ledgerId,
        Number(q.year ?? now.getFullYear()),
        Number(q.month ?? now.getMonth() + 1),
        q.keyword,
        {
          accountId: q.accountId,
          parentCategoryId: q.parentCategoryId,
          categoryId: q.categoryId,
          recordTypes: q.recordType,
        },
      ),
    );
  });

  /** S-11 事件标注 */
  app.get(`${base}/events`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const hasRange = Boolean(q.dateFrom || q.dateTo);
    const r = hasRange ? rangeOf(q) : null;
    return ok(listEvents(ctx, m.ledgerId, r?.from, r?.to));
  });

  app.post(`${base}/events`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(createEvent(ctx, m.ledgerId, m.userId, parseOrThrow(eventBody, req.body)));
  });

  app.delete(`${base}/events/:id`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(deleteEvent(ctx, m.ledgerId, id));
  });

  /** S-12 自定义报表 */
  app.get(`${base}/reports`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const saved = listReports(ctx, m.ledgerId);
    // 内置预设不落库，每次随列表一起返回（用户「复制另存」时才写库）
    return ok({
      builtin: BUILTIN_REPORTS.map((b, i) => ({ id: `builtin_${i}`, name: b.name, config: b.config, isBuiltin: true })),
      saved,
    });
  });

  app.post(`${base}/reports`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(reportBody, req.body);
    return ok(
      createReport(ctx, m.ledgerId, m.userId, {
        name: body.name,
        config: body.config as ReportConfig,
        sortOrder: body.sortOrder ?? undefined,
      }),
    );
  });

  app.patch(`${base}/reports/:id`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    const body = parseOrThrow(reportPatch, req.body);
    return ok(
      updateReport(ctx, m.ledgerId, id, {
        name: body.name ?? undefined,
        config: (body.config as ReportConfig | null) ?? undefined,
        sortOrder: body.sortOrder ?? undefined,
      }),
    );
  });

  app.delete(`${base}/reports/:id`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(deleteReport(ctx, m.ledgerId, id));
  });

  app.post(`${base}/reports/run`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(reportBody.shape.config, req.body);
    return ok(runReport(ctx, m.ledgerId, body as ReportConfig));
  });

  /** S-13 报表导出（CSV，带 BOM） */
  app.get(`${base}/export.csv`, opts, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const r = rangeOf(q);
    const csv = exportCsv(ctx, m.ledgerId, {
      from: r.from,
      to: r.to,
      categoryId: q.categoryId,
      accountId: q.accountId,
      tagId: q.tagId,
      keyword: q.keyword,
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="report-${r.from}_${r.to}.csv"`);
    return reply.send(csv);
  });

  /** S-14 日历热力图 */
  app.get(`${base}/heatmap`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    const year = Number(q.year ?? new Date().getFullYear());
    const month = q.month ? Number(q.month) : undefined;
    return ok(heatmap(ctx, m.ledgerId, year, month));
  });

  /** S-15 结论式洞察 */
  app.get(`${base}/insights`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(insights(ctx, m.ledgerId, r.from, r.to));
  });

  /** S-16 / R-12 / X-07 订阅与重复扣费识别 */
  app.get(`${base}/subscriptions`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as RangeQuery;
    return ok(detectSubscriptions(ctx, m.ledgerId, q.limit ? Number(q.limit) : 12));
  });

  app.post(`${base}/subscriptions/confirm`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(confirmSubscription(ctx, m.ledgerId, parseOrThrow(subBody, req.body)));
  });

  app.post(`${base}/subscriptions/ignore`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(ignoreSubscription(ctx, m.ledgerId, parseOrThrow(subBody, req.body)));
  });

  /** S-17 现金流三分类 */
  app.get(`${base}/cash-flow`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(cashFlowStatement(ctx, m.ledgerId, r.from, r.to));
  });

  /** X-05 口径版本 */
  app.get(`${base}/policies`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok({ current: currentPolicy(ctx, m.ledgerId), versions: listPolicyVersions(ctx, m.ledgerId) });
  });

  app.post(`${base}/policies`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(policyBody, req.body);
    return ok(createPolicyVersion(ctx, m.ledgerId, m.userId, body));
  });

  /** X-06 报销冲减 */
  app.get(`${base}/reimbursements`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(listReimbursements(ctx, m.ledgerId, r.from, r.to));
  });

  app.post(`${base}/reimbursements`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(createReimbursement(ctx, m.ledgerId, m.userId, parseOrThrow(reimbBody, req.body)));
  });

  app.post(`${base}/reimbursements/:id/void`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(voidReimbursement(ctx, m.ledgerId, id));
  });

  /** X-06 消费出口：分类支出（已扣报销） */
  app.get(`${base}/category-expense-net`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(categoryExpenseNetOfReimbursement(ctx, m.ledgerId, r.from, r.to));
  });

  /** 供前端复用区间的纯函数出口（周/月/年边界） */
  app.get(`${base}/period-of`, opts, async (req) => {
    const q = req.query as RangeQuery;
    const kind = (['week', 'month', 'year'].includes(q.period ?? '') ? q.period : 'month') as ReportPeriod;
    return ok(periodOf(kind, q.anchor));
  });

  /* ------------------------------------------------------------------ *
   * 报表页（主流记账 App 对标）新增的三个维度
   * ------------------------------------------------------------------ */

  /** 成员收支（口径是**记录人**，不是消费人 —— 见 byMember 的注释） */
  app.get(`${base}/by-member`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(byMember(ctx, m.ledgerId, r.from, r.to, (req.query as RangeQuery).keyword));
  });

  /** 星期分布（周日~周六，含 0 支出日） */
  app.get(`${base}/weekday`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(weekdaySpending(ctx, m.ledgerId, r.from, r.to, (req.query as RangeQuery).keyword));
  });

  /** 账户期初 / 期末 / 结余（用账户页同一个余额函数） */
  app.get(`${base}/accounts-balance`, opts, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const r = rangeOf(req.query as RangeQuery);
    return ok(accountsBalance(ctx, m.ledgerId, r.from, r.to));
  });
}
