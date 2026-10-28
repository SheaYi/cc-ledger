import { z } from 'zod';

/** 配置错误：启动阶段必须失败退出 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** 布尔环境变量解析（'false' / '0' / 'no' / 'off' → false） */
const boolEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  TZ: z.string().min(1).default('Asia/Shanghai'),

  DATA_DIR: z.string().min(1).default('./data'),
  DB_PATH: z.string().min(1).default('./data/cc-ledger.db'),
  UPLOAD_DIR: z.string().min(1).default('./data/uploads'),
  BACKUP_DIR: z.string().min(1).default('./data/backups'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET 长度至少 16 位'),
  JWT_ACCESS_EXPIRES: z.string().min(1).default('15m'),
  JWT_REFRESH_EXPIRES: z.string().min(1).default('30d'),
  /** 移动端 refresh token 有效期（docs/01 §7.1：延长至 90 天） */
  JWT_REFRESH_EXPIRES_MOBILE: z.string().min(1).default('90d'),

  /** 对外访问基址（用于生成邀请链接、二维码），局域网可写 http://<NAS-IP>:3000 */
  PUBLIC_BASE_URL: z.string().min(1).default('http://localhost:3000'),

  /** 限流阈值（docs/04 §1.6 为生产基线，可按部署环境调整） */
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().min(1).default(3),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  ENABLE_SCHEDULER: boolEnv(true),
  BACKUP_ENABLED: boolEnv(true),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).default(14),
  APP_VERSION: z.string().min(1).default('1.1.12'),
});

export type Env = z.infer<typeof EnvSchema>;

/** 加载并校验环境变量（fail fast） */
export function loadEnv(): Env {
  // Node 22 内置 .env 加载（不存在则忽略，生产用环境变量注入）
  const loadEnvFile = (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (typeof loadEnvFile === 'function') {
    try {
      loadEnvFile('.env');
    } catch {
      /* .env 可选 */
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`环境变量校验失败：\n${lines.join('\n')}`);
  }
  return parsed.data;
}
