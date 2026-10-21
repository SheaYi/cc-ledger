/**
 * 全局错误处理器 —— 统一响应包装（docs/04 §1.1 / §1.5）。
 *   { "error": { "code", "message", "details"?, "requestId" } }
 */
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, type ApiErrorCode, type FieldIssue } from '../utils/errors.js';

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);

function zodDetails(err: ZodError): FieldIssue[] {
  return err.issues.map((i) => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawError, req, reply) => {
    const error = rawError as Error & { code?: string; statusCode?: number };

    // 1. 业务错误
    if (rawError instanceof AppError) {
      return reply.code(rawError.status).send({
        error: {
          code: rawError.code,
          message: rawError.message,
          ...(rawError.details ? { details: rawError.details } : {}),
          requestId: req.id,
        },
      });
    }

    // 2. Zod 校验错误（理论上已被 parseOrThrow 拦截，这里兜底）
    if (rawError instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR' satisfies ApiErrorCode,
          message: '请求参数校验失败',
          details: zodDetails(rawError),
          requestId: req.id,
        },
      });
    }

    // 3. SQLite 繁忙
    const errCode = (error as { code?: string }).code ?? '';
    if (BUSY_CODES.has(errCode) || /SQLITE_BUSY/i.test(error.message)) {
      req.log.warn({ err: error }, '数据库繁忙');
      return reply.code(503).send({
        error: { code: 'DB_BUSY', message: '数据库繁忙，请稍后重试', requestId: req.id },
      });
    }

    // 4. Fastify 内置错误（body 解析、体积超限、限流等）
    const status = error.statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: '上传内容超过大小限制', requestId: req.id },
      });
    }
    if (status === 429) {
      const custom = (rawError as { error?: { message?: string } }).error?.message;
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: custom ?? '请求过于频繁，请稍后再试',
          requestId: req.id,
        },
      });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message || '请求不合法',
          requestId: req.id,
        },
      });
    }

    // 5. 未预期异常
    req.log.error({ err: error }, '未处理的服务端异常');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: '服务端异常', requestId: req.id },
    });
  });
}
