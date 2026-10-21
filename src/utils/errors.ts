/**
 * 统一错误体系（对齐 docs/04 §1.5 错误码表）。
 *
 * 所有业务错误一律抛 AppError，由全局错误处理器转成标准响应包装：
 *   { "error": { "code", "message", "details"?, "requestId" } }
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'BUSINESS_RULE_VIOLATION',
  'PERIOD_CLOSED',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE_RESOURCE',
  'PAYLOAD_TOO_LARGE',
  'IMPORT_VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'DB_BUSY',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  BUSINESS_RULE_VIOLATION: 400,
  PERIOD_CLOSED: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_RESOURCE: 409,
  PAYLOAD_TOO_LARGE: 413,
  IMPORT_VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  DB_BUSY: 503,
};

export const API_ERROR_MESSAGE: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: '请求参数校验失败',
  BUSINESS_RULE_VIOLATION: '违反业务规则',
  PERIOD_CLOSED: '该期间已结账',
  UNAUTHORIZED: '未登录或凭证无效',
  TOKEN_EXPIRED: '登录状态已过期',
  FORBIDDEN: '无权限执行该操作',
  NOT_FOUND: '资源不存在',
  CONFLICT: '数据已被他人修改',
  DUPLICATE_RESOURCE: '资源已存在',
  PAYLOAD_TOO_LARGE: '上传内容超过大小限制',
  IMPORT_VALIDATION_FAILED: '导入校验失败',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  INTERNAL_ERROR: '服务端异常',
  DB_BUSY: '数据库繁忙，请稍后重试',
};

export interface FieldIssue {
  field: string;
  message: string;
}

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: FieldIssue[];

  constructor(code: ApiErrorCode, message?: string, details?: FieldIssue[]) {
    super(message ?? API_ERROR_MESSAGE[code]);
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = details;
  }
}

export const HttpError = {
  validation: (details: FieldIssue[], message?: string) =>
    new AppError('VALIDATION_ERROR', message, details),
  business: (message: string) => new AppError('BUSINESS_RULE_VIOLATION', message),
  periodClosed: (message?: string) => new AppError('PERIOD_CLOSED', message),
  unauthorized: (message?: string) => new AppError('UNAUTHORIZED', message),
  tokenExpired: (message?: string) => new AppError('TOKEN_EXPIRED', message),
  forbidden: (message?: string) => new AppError('FORBIDDEN', message),
  notFound: (message?: string) => new AppError('NOT_FOUND', message),
  conflict: (message?: string) => new AppError('CONFLICT', message),
  duplicate: (message?: string) => new AppError('DUPLICATE_RESOURCE', message),
  payloadTooLarge: (message?: string) => new AppError('PAYLOAD_TOO_LARGE', message),
  rateLimited: (message?: string) => new AppError('RATE_LIMITED', message),
  internal: (message?: string) => new AppError('INTERNAL_ERROR', message),
  dbBusy: (message?: string) => new AppError('DB_BUSY', message),
};

/** 响应包装：单资源 */
export function ok<T>(data: T): { data: T } {
  return { data };
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  [key: string]: unknown;
}

/** 响应包装：列表 */
export function okList<T>(data: T[], meta: PageMeta): { data: T[]; meta: PageMeta } {
  return { data, meta };
}
