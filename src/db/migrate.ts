import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DbHandle } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析迁移目录：
 *  - 生产（dist/db/migrate.js）→ <app>/drizzle
 *  - 开发（src/db/migrate.ts）→ <app>/drizzle
 * 可用环境变量 MIGRATIONS_DIR 覆盖。
 */
export function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  return path.resolve(here, '../../drizzle');
}

/** 执行未完成的数据库迁移（容器重启即升级） */
export function runMigrations(handle: DbHandle, folder = resolveMigrationsFolder()): void {
  migrate(handle.db, { migrationsFolder: folder });
}
