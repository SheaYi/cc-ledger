/**
 * 账单导入路由（`docs/04 §8.9`）。
 *
 * `preview` 与 `commit` 都是 multipart：文件字段 `file`，映射字段 `mapping`（JSON 字符串）。
 * 为什么不用 JSON body + base64 文件：20MB 文件 base64 之后膨胀 33%，
 * 而 Fastify 的 JSON body 默认上限远小于此，走 multipart 还能复用现成的
 * `req.file()` 与体积限额。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../../context.js';
import { LIMITS } from '../../config/constants.js';
import { ok, HttpError } from '../../utils/errors.js';
import { membershipFromRequest } from '../ledgers/access.js';
import { commit, preview, type Mapping } from './service.js';

/**
 * ⚠️ 兜底记录类型只能是**支出 / 收入**。
 *
 * 此前写的是 `RECORD_TYPES`（全部 6 种），于是前端/脚本可以传 `transfer`、
 * 而导入链路根本没有对方账户这个概念 —— 请求不报错、行却建不出来。
 * 枚举收窄后，非法值在 schema 层就被拒（明确的 400），
 * 而不是变成一个「成功 0 笔、错误 500 笔」的导入报告。
 * 逐行的类型由「收支/类型」列决定，不走这里。
 */
const IMPORTABLE_RECORD_TYPES = ['expense', 'income'] as const;

/**
 * 可映射的列字段以 `service.ts` 的 `IMPORT_COLUMN_FIELDS` 为**唯一出口**。
 * 其中 `dateColumn` / `amountColumn` 必填，其余全部可选（留空有兜底）。
 */
const mappingSchema = z.object({
  dateColumn: z.string().min(1, '必须指定日期列'),
  amountColumn: z.string().min(1, '必须指定金额列'),
  recordTypeColumn: z.string().nullish(),
  directionColumn: z.string().nullish(),
  timeColumn: z.string().nullish(),
  nameColumn: z.string().nullish(),
  categoryColumn: z.string().nullish(),
  merchantColumn: z.string().nullish(),
  counterpartyColumn: z.string().nullish(),
  feeColumn: z.string().nullish(),
  discountColumn: z.string().nullish(),
  tagsColumn: z.string().nullish(),
  noteColumn: z.string().nullish(),
  recordType: z.enum(IMPORTABLE_RECORD_TYPES).default('expense'),
  defaultAccountId: z.string().default(''),
  defaultCategoryId: z.string().nullish(),
  incomeCategoryId: z.string().nullish(),
});

function parseMapping(raw: unknown): Mapping | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw HttpError.validation([{ field: 'mapping', message: 'mapping 必须是 JSON 字符串' }]);
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw HttpError.validation([{ field: 'mapping', message: 'mapping 不是合法 JSON' }]);
  }
  // 预览阶段允许缺列（让服务端去猜），所以不强制 required；字段类型仍要校
  return mappingSchema.partial().parse(obj) as Mapping;
}

export async function registerImportRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const base = '/api/v1/ledgers/:ledgerId/transactions/import';
  /**
   * 导入是**重接口**：一次可能写 20000 行。给它单独一档限流（5 次/10 分钟），
   * 否则一个脚本就能把库写满 —— 而 SQLite 单写者模型下它还顺带把整个应用堵死。
   */
  const limit = { rateLimit: { max: 5, timeWindow: '10 minutes' } };

  app.post(`${base}/preview`, { preHandler: app.requireAuth, config: limit }, async (req) => {
    const m = membershipFromRequest(ctx, req);
    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let mappingRaw: string | undefined;
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
      } else if (part.fieldname === 'mapping') {
        mappingRaw = String(part.value);
      }
    }
    if (!fileBuffer) {
      throw HttpError.validation([{ field: 'file', message: '缺少文件字段 file' }]);
    }
    if (fileBuffer.byteLength > LIMITS.IMPORT_MAX_BYTES) {
      throw HttpError.payloadTooLarge(`文件不得超过 ${LIMITS.IMPORT_MAX_BYTES / 1024 / 1024} MB`);
    }
    return ok(preview(ctx, m.ledgerId, fileBuffer, parseMapping(mappingRaw)));
  });

  app.post(`${base}/commit`, { preHandler: app.requireAuth, config: limit }, async (req, reply) => {
    const m = membershipFromRequest(ctx, req);
    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let mappingRaw: string | undefined;
    let allowDuplicate = false;
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
      } else if (part.fieldname === 'mapping') {
        mappingRaw = String(part.value);
      } else if (part.fieldname === 'allowDuplicate') {
        allowDuplicate = String(part.value) === 'true';
      }
    }
    if (!fileBuffer) {
      throw HttpError.validation([{ field: 'file', message: '缺少文件字段 file' }]);
    }
    if (fileBuffer.byteLength > LIMITS.IMPORT_MAX_BYTES) {
      throw HttpError.payloadTooLarge(`文件不得超过 ${LIMITS.IMPORT_MAX_BYTES / 1024 / 1024} MB`);
    }
    if (!mappingRaw) {
      throw HttpError.validation([{ field: 'mapping', message: '提交时必须给出完整映射' }]);
    }
    const mapping = mappingSchema.parse(JSON.parse(mappingRaw)) as Mapping;
    return reply.code(201).send(ok(commit(ctx, m.userId, m.ledgerId, fileBuffer, mapping, allowDuplicate)));
  });
}
