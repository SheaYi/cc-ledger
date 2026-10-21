/** 预算路由（`docs/04 §十四`），挂在 `/api/v1/ledgers/:ledgerId` 下。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { ok } from '../../utils/errors.js';
import { parseOrThrow } from '../../utils/validate.js';
import { membershipFromRequest } from '../ledgers/access.js';
import {
  budgetProgress,
  copyFromPrevious,
  createBudget,
  deleteBudget,
  listBudgets,
  listTransfers,
  revokeTransfer,
  transfer,
  updateBudget,
} from './service.js';
import {
  addPoolEntry,
  computeAlerts,
  createPool,
  getPrefs,
  listChanges,
  listPoolEntries,
  listPools,
  listTemplates,
  periodRange,
  planByRatio,
  precheckExpense,
  RATIO_PRESETS,
  recordChange,
  rollover,
  saveTemplate,
  setPrefs,
  suggestBudgets,
  tagBudgetProgress,
} from './advanced.js';

const amount = z.union([z.string(), z.number()]);

const budgetBody = z.object({
  categoryId: z.string().min(1).nullish(),
  periodType: z.enum(['monthly', 'weekly', 'custom', 'yearly']).optional(),
  year: z.number().int().min(1970).max(9999),
  month: z.number().int().min(1).max(12).nullish(),
  amount,
  rollover: z.boolean().optional(),
  alertRatio: z.number().int().min(1).max(100).optional(),
  /* B-07 多周期：周预算与自定义账期必须给出起止日 */
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  periodLabel: z.string().max(40).nullish(),
  /* B-12 预算定位：分类 / 标签 / 项目 */
  scope: z.enum(['category', 'tag', 'project']).optional(),
  scopeId: z.string().min(1).nullish(),
  projectLabel: z.string().max(60).nullish(),
  /* B-05 单条预算可单独静音 */
  alertEnabled: z.boolean().optional(),
  /* B-13 可见性 */
  visibility: z.enum(['ledger', 'private']).optional(),
});

const ratioBody = z.object({
  preset: z.string().min(1).optional(),
  year: z.number().int().min(1970).max(9999),
  month: z.number().int().min(1).max(12),
  categoryGroups: z
    .object({ needs: z.array(z.string()).default([]), wants: z.array(z.string()).default([]) })
    .optional(),
});

const rolloverBody = z.object({
  fromYear: z.number().int().min(1970).max(9999),
  fromMonth: z.number().int().min(1).max(12),
  toYear: z.number().int().min(1970).max(9999),
  toMonth: z.number().int().min(1).max(12),
  mode: z.enum(['clear', 'carry', 'to_savings']),
  categoryIds: z.array(z.string()).optional(),
  mapping: z.record(z.string(), z.string()).optional(),
  note: z.string().max(200).nullish(),
});

const poolBody = z.object({
  name: z.string().min(1).max(40),
  targetAmount: amount,
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  savingsAccountId: z.string().min(1).nullish(),
  expenseCategoryId: z.string().min(1).nullish(),
  note: z.string().max(200).nullish(),
});

const poolEntryBody = z.object({
  kind: z.enum(['contribute', 'spend', 'adjust', 'refund']),
  amount,
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(200).nullish(),
  relatedTxId: z.string().min(1).nullish(),
});

const templateBody = z.object({
  id: z.string().min(1).nullish(),
  name: z.string().min(1).max(40),
  note: z.string().max(200).nullish(),
  items: z.array(z.object({ categoryId: z.string().min(1), amount })).min(1),
});

const precheckBody = z.object({
  categoryId: z.string().min(1).nullish(),
  amount,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const prefsBody = z.object({
  defaultAlertRatio: z.number().int().min(1).max(100).optional(),
  dndEnabled: z.boolean().optional(),
  dndFrom: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  dndTo: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  notifyOnCreate: z.boolean().optional(),
  predictionMinDays: z.number().int().min(1).max(30).optional(),
});

const copyBody = z.object({
  fromYear: z.number().int().min(1970).max(9999),
  fromMonth: z.number().int().min(1).max(12),
  toYear: z.number().int().min(1970).max(9999),
  toMonth: z.number().int().min(1).max(12),
});

const transferBody = z.object({
  year: z.number().int().min(1970).max(9999),
  month: z.number().int().min(1).max(12),
  fromCategoryId: z.string().min(1),
  toCategoryId: z.string().min(1),
  amount,
  note: z.string().max(200).nullish(),
});

export async function registerBudgetRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/budgets';

  app.get(base, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { year?: string; month?: string };
    const now = new Date();
    const year = q.year ? Number(q.year) : now.getFullYear();
    const month = q.month ? Number(q.month) : undefined;
    return ok(listBudgets(ctx, m.ledgerId, year, month));
  });

  /**
   * 预算进度。这是**这一页真正要读的数据**（`docs/05 §16.2` 的「预算 vs 实际」
   * 本质是差异分析），所以放在预算自己的前缀下而不是 `/stats/budget-progress`
   * —— 两个 URL 会让「同一份数字有两个地址」，将来改口径必漏一处。
   */
  app.get(`${base}/progress`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { year?: string; month?: string };
    const now = new Date();
    const year = q.year ? Number(q.year) : now.getFullYear();
    const month = q.month ? Number(q.month) : undefined;
    return ok(budgetProgress(ctx, m.ledgerId, year, month));
  });

  app.post(base, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(budgetBody, req.body);
    return reply.code(201).send(ok(createBudget(ctx, m.userId, m.ledgerId, body)));
  });

  app.post(`${base}/copy-from-previous`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(copyBody, req.body);
    return ok(copyFromPrevious(ctx, m.userId, m.ledgerId, body));
  });

  /* ---------- 调拨（B-06） ---------- */

  app.get(`${base}/transfers`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { year?: string; month?: string };
    const now = new Date();
    return ok(
      listTransfers(
        ctx,
        m.ledgerId,
        q.year ? Number(q.year) : now.getFullYear(),
        q.month ? Number(q.month) : undefined,
      ),
    );
  });

  app.post(`${base}/transfers`, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(transferBody, req.body);
    return reply.code(201).send(ok(transfer(ctx, m.userId, m.ledgerId, body)));
  });

  app.delete(`${base}/transfers/:id`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(revokeTransfer(ctx, m.userId, m.ledgerId, id));
  });

  app.patch(`${base}/prefs`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(setPrefs(ctx, m.ledgerId, parseOrThrow(prefsBody, req.body)));
  });

  app.patch(`${base}/:id`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    const body = parseOrThrow(budgetBody.partial(), req.body);
    return ok(updateBudget(ctx, m.userId, m.ledgerId, id, body));
  });

  app.delete(`${base}/:id`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    /**
     * 顺序很重要：**先留痕再删除**。
     * `budget_changes.budget_id` 有 `ON DELETE SET NULL`，所以删除之后再写留痕，
     * 那条 budget_id 指向的预算已经不存在 → FOREIGN KEY constraint failed → 500。
     * （这个 500 很有迷惑性：用户看到「删除失败」，而预算其实已经删掉了，
     *  且报错栈指向 recordChange，完全看不出是顺序问题。）
     */
    recordChange(ctx, m.ledgerId, m.userId, { budgetId: id, action: 'delete' });
    return ok(deleteBudget(ctx, m.userId, m.ledgerId, id));
  });

/* ================================================================== *
 * 以下为 `docs/15` 对标 FRD 的预算需求（B-01/04/05/07~13）。
 *
 * ℹ️ **顺序说明（曾经写错过，这里留档）**：
 * 我曾以为「静态段必须排在动态段之前，否则会被遮蔽」并按此写了一条闸门。
 * 实测（`Fastify.inject` 最小复现）证明：**radix 树里静态段永远优先于
 * 同层动态段，与注册顺序无关**。
 * ```
 * app.patch('/b/:id', …)      // 先注册
 * app.patch('/b/prefs', …)    // 后注册
 * PATCH /b/prefs → 命中 prefs 处理器 ✅
 * PATCH /b/abc   → 命中 :id 处理器  ✅
 * ```
 * 所以这里保持**按用途分组**（设置类 → 规划类 → 池 → 工具类）而不是
 * 按「静态在前」排序，可读性更好。闸门已删（它建立在一个错误前提上）。
 * ================================================================== */

  /* ---------- B-05 预警设置与当前预警 ---------- */

  app.get(`${base}/prefs`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(getPrefs(ctx, m.ledgerId));
  });

  /**
   * 当前应触发的预警。**这个端点会写库**（去重记录），
   * 所以前端必须只在「进入预算页」时调一次，不能轮询 ——
   * 每次调用都会把「首次提醒」标记成「已提醒」。
   */
  app.get(`${base}/alerts`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { year?: string; month?: string };
    const year = Number(q.year ?? new Date().getFullYear());
    const month = Number(q.month ?? new Date().getMonth() + 1);
    const rows = budgetProgress(ctx, m.ledgerId, year, month);
    return ok(
      computeAlerts(
        ctx,
        m.ledgerId,
        rows.map((r) => {
          const p = periodRange(r.periodType, r.year, r.month);
          return {
            id: r.id,
            label: r.categoryName ?? '总预算',
            usedRatio: r.usedRatio,
            alertRatio: r.alertRatio,
            alertEnabled: true,
            periodKey: p.key,
          };
        }),
      ),
    );
  });

  /* ---------- B-01 比例法（B-11 推荐） ---------- */

  app.get(`${base}/ratio-presets`, { preHandler: app.requireAuth }, async () =>
    ok(RATIO_PRESETS),
  );

  app.post(`${base}/plan-by-ratio`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(planByRatio(ctx, m.ledgerId, parseOrThrow(ratioBody, req.body)));
  });

  app.get(`${base}/suggestions`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { year?: string; month?: string };
    return ok(
      suggestBudgets(
        ctx,
        m.ledgerId,
        Number(q.year ?? new Date().getFullYear()),
        Number(q.month ?? new Date().getMonth() + 1),
      ),
    );
  });

  /* ---------- B-11 模板 ---------- */

  app.get(`${base}/templates`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(listTemplates(ctx, m.ledgerId));
  });

  app.post(`${base}/templates`, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(templateBody, req.body);
    const out = saveTemplate(ctx, m.userId, m.ledgerId, body);
    recordChange(ctx, m.ledgerId, m.userId, { action: 'template_save', after: { name: body.name } });
    return reply.code(body.id ? 200 : 201).send(ok(out));
  });

  /* ---------- B-07 账期工具（按发薪日生成） ---------- */

  app.get(`${base}/periods`, { preHandler: app.requireAuth }, async (req) => {
    const q = req.query as { payDay?: string; fromYear?: string; toYear?: string };
    const y = new Date().getFullYear();
    const { periodsByPayday } = await import('./advanced.js');
    return ok(
      periodsByPayday(
        Number(q.payDay ?? 1),
        Number(q.fromYear ?? y),
        Number(q.toYear ?? y),
      ),
    );
  });

  /* ---------- B-08 结转 ---------- */

  app.post(`${base}/rollover`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const body = parseOrThrow(rolloverBody, req.body);
    const out = rollover(ctx, m.userId, m.ledgerId, body);
    recordChange(ctx, m.ledgerId, m.userId, {
      action: 'rollover',
      after: { mode: body.mode, moved: out.movedAmount },
      note: body.note ?? null,
    });
    return ok(out);
  });

  /* ---------- B-09 专项预算池 ---------- */

  app.get(`${base}/pools`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { status?: string };
    return ok(listPools(ctx, m.ledgerId, q.status));
  });

  app.post(`${base}/pools`, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    return reply.code(201).send(ok(createPool(ctx, m.userId, m.ledgerId, parseOrThrow(poolBody, req.body))));
  });

  app.get(`${base}/pools/:id/entries`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return ok(listPoolEntries(ctx, m.ledgerId, id));
  });

  app.post(`${base}/pools/:id/entries`, { preHandler: app.requireAuth }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const { id } = req.params as { id: string };
    return reply
      .code(201)
      .send(ok(addPoolEntry(ctx, m.userId, m.ledgerId, id, parseOrThrow(poolEntryBody, req.body))));
  });

  /* ---------- B-04 记账事前校验 ---------- */

  /**
   * 记账页实时校验。**不写库** —— 它是纯查询，且会被高频调用（用户每改一次金额）。
   * 去重逻辑只在 `GET /alerts` 里，那才是「提醒」语义发生的地方。
   */
  app.post(`${base}/precheck`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    return ok(precheckExpense(ctx, m.ledgerId, parseOrThrow(precheckBody, req.body)));
  });

  /* ---------- B-12 标签预算 ---------- */

  app.get(`${base}/tag-progress`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { from?: string; to?: string };
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    return ok(tagBudgetProgress(ctx, m.ledgerId, from, to));
  });

  /* ---------- B-06/B-13 变更留痕 ---------- */

  app.get(`${base}/changes`, { preHandler: app.requireAuth }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const q = req.query as { limit?: string };
    return ok(listChanges(ctx, m.ledgerId, q.limit ? Number(q.limit) : 50));
  });
}
