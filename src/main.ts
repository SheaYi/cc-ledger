import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadEnv, type Env } from './config/env.js';
import type { AppCtx } from './context.js';
import { APP_NAME } from './config/constants.js';
import { openDatabase } from './db/client.js';
import { runMigrations, resolveMigrationsFolder } from './db/migrate.js';
import { createScheduler } from './scheduler/index.js';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 启动第 2 步：准备数据目录 */
function ensureDataDirs(env: Env): void {
  const dirs = [
    env.DATA_DIR,
    path.join(env.UPLOAD_DIR, 'avatars'),
    path.join(env.UPLOAD_DIR, 'transactions'),
    env.BACKUP_DIR,
    path.dirname(path.resolve(env.DB_PATH)),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // 1. 环境变量校验（fail fast）
  const env = loadEnv();

  // 2. 数据目录
  ensureDataDirs(env);

  // 3-5. 打开数据库 + PRAGMA + 迁移
  const dbHandle = openDatabase(env.DB_PATH);
  runMigrations(dbHandle);

  // 6-7. 定时任务（清理/备份/周期账单）
  // 周期账单生成需要 AppCtx（走 transactions 的 createTransaction 才能复用金额与账户规约），
  // 而 scheduler 在 HTTP 服务之前创建，所以这里单独构造一份 —— AppCtx 无状态，两处等价。
  const schedulerCtx: AppCtx = { env, dbHandle, db: dbHandle.db, startedAt };
  const scheduler = createScheduler(dbHandle, env, schedulerCtx);
  scheduler.start();

  // 8. HTTP 服务
  const app = await buildApp({
    env,
    dbHandle,
    scheduler,
    publicDir: path.resolve(here, '../public'),
    startedAt,
  });

  await app.listen({ port: env.PORT, host: env.HOST });

  console.log(
    JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      msg: `${APP_NAME} 已启动`,
      version: env.APP_VERSION,
      port: env.PORT,
      dbPath: env.DB_PATH,
      migrationsDir: resolveMigrationsFolder(),
      nodeEnv: env.NODE_ENV,
      scheduler: env.ENABLE_SCHEDULER,
    }),
  );

  // 优雅关闭
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, '收到退出信号，开始优雅关闭');
    try {
      scheduler.stop();
      await app.close();
      dbHandle.close();
      app.log.info('已优雅退出');
      process.exit(0);
    } catch (e) {
      app.log.error(e, '关闭过程异常');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\n❌ 配置错误（启动已中止）\n${err.message}\n`);
  } else {
    console.error('\n❌ 启动失败：', err);
  }
  process.exit(1);
});
