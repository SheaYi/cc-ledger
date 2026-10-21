import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { Env } from './config/env.js';
import type { DbHandle } from './db/client.js';
import type { Scheduler } from './scheduler/index.js';
import type { AppCtx } from './context.js';
import { LIMITS } from './config/constants.js';
import { newId } from './utils/id.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuth, clientIp } from './plugins/auth.js';
import { registerHealthRoutes } from './modules/health/index.js';
import { registerAuthRoutes } from './modules/auth/index.js';
import { registerUserRoutes } from './modules/users/index.js';
import { registerLedgerRoutes } from './modules/ledgers/index.js';
import { registerAccountRoutes } from './modules/accounts/index.js';
import { registerCategoryRoutes } from './modules/categories/index.js';
import { registerTagRoutes } from './modules/tags/index.js';
import { registerReconciliationRoutes } from './modules/reconciliation/index.js';
import { registerTransactionRoutes } from './modules/transactions/index.js';
import { registerDebtRoutes } from './modules/debts/index.js';
import { registerTemplateRoutes } from './modules/templates/index.js';
import { registerRecurringRoutes } from './modules/recurring/index.js';
import { registerInstallmentRoutes } from './modules/installment/index.js';
import { registerStatsRoutes } from './modules/stats/index.js';
import { registerBudgetRoutes } from './modules/budgets/index.js';
import { registerCategoryRuleRoutes } from './modules/categoryRules/index.js';
import { registerPeriodClosureRoutes } from './modules/periodClosures/index.js';
import { registerAttachmentRoutes } from './modules/attachments/index.js';
import { registerImportRoutes } from './modules/imports/index.js';
import { registerCollabRoutes } from './modules/collab/index.js';

export interface AppContext {
  env: Env;
  dbHandle: DbHandle;
  scheduler: Scheduler;
  publicDir: string;
  startedAt: number;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.env.LOG_LEVEL },
    genReqId: () => newId('req'),
    trustProxy: true,
    bodyLimit: 1 * 1024 * 1024,
  });

  // 统一错误响应包装
  registerErrorHandler(app);

  await app.register(cors, { origin: true, credentials: true });

  // 限流：默认关闭，按路由开启（docs/04 §1.6）
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) =>
      `${clientIp(req)}:${(req.routeOptions as { url?: string } | undefined)?.url ?? req.url}`,
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: `请求过于频繁，请在 ${Math.ceil(context.ttl / 1000)} 秒后重试`,
        requestId: req.id,
      },
    }),
  });

  // 文件上传（头像 ≤2MB；附件 ≤10MB 由各路由自行收紧）
  await app.register(multipart, {
    limits: { fileSize: LIMITS.ATTACHMENT_MAX_BYTES, files: 1, fields: 20 },
  });

  // 认证基础设施（JWT + requireAuth）
  const appCtx: AppCtx = {
    env: ctx.env,
    dbHandle: ctx.dbHandle,
    db: ctx.dbHandle.db,
    startedAt: ctx.startedAt,
  };
  await registerAuth(app, appCtx);

  // 健康检查
  registerHealthRoutes(app, {
    dbHandle: ctx.dbHandle,
    version: ctx.env.APP_VERSION,
    startedAt: ctx.startedAt,
    scheduler: ctx.scheduler,
  });

  // 业务路由
  await registerAuthRoutes(app, appCtx);
  await registerUserRoutes(app, appCtx);
  await registerLedgerRoutes(app, appCtx);
  await registerAccountRoutes(app, appCtx);
  await registerCategoryRoutes(app, appCtx);
  await registerTagRoutes(app, appCtx);
  await registerReconciliationRoutes(app, appCtx);
  await registerTransactionRoutes(app, appCtx);
  await registerDebtRoutes(app, appCtx);
  await registerTemplateRoutes(app, appCtx);
  await registerRecurringRoutes(app, appCtx);
  await registerInstallmentRoutes(app, appCtx);
  // Stage 12-13：统计 / 预算 / 自动分类规则 / 期间关闭 / 附件 / 导入
  await registerStatsRoutes(app, appCtx);
  await registerBudgetRoutes(app, appCtx);
  await registerCategoryRuleRoutes(app, appCtx);
  await registerPeriodClosureRoutes(app, appCtx);
  await registerAttachmentRoutes(app, appCtx);
  await registerImportRoutes(app, appCtx);
  await registerCollabRoutes(app, appCtx);

  // 上传文件（头像 / 附件）——路径穿越由 @fastify/static 内部防护
  const uploadDir = path.resolve(ctx.env.UPLOAD_DIR);
  fs.mkdirSync(uploadDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '7d',
  });

  // 静态前端（前端产物由构建阶段 COPY 进镜像）
  if (fs.existsSync(ctx.publicDir)) {
    await app.register(fastifyStatic, {
      root: ctx.publicDir,
      prefix: '/',
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // sw.js 绝对不能缓存：Service Worker 本身被缓存住就等于**关掉了更新机制**，
        // 用户会被永久锁在旧版本（app.ts:115 这条规则早于 PWA 实现就在，是预留）。
        // manifest 同理 —— 它决定安装后的图标与快捷入口，启发式缓存会让改了版本
        // 的用户长期看不到新入口。
        if (filePath.endsWith('sw.js') || filePath.endsWith('.html') || filePath.endsWith('.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.(js|css|woff2?|png|svg|webp)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    });
  }

  // 统一 404：API 返回 JSON，其余回落到前端外壳（SPA 路由）
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.raw.url ?? '';
    if (url.startsWith('/api/')) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '接口不存在', requestId: req.id } });
    }
    const indexHtml = path.join(ctx.publicDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexHtml));
    }
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: '资源不存在', requestId: req.id } });
  });

  return app;
}
