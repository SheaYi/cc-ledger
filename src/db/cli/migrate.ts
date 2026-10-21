import { loadEnv } from '../../config/env.js';
import { openDatabase, getMigrationStatus } from '../client.js';
import { runMigrations, resolveMigrationsFolder } from '../migrate.js';

const env = loadEnv();
const handle = openDatabase(env.DB_PATH);

try {
  console.log(`▶ 迁移目录：${resolveMigrationsFolder()}`);
  runMigrations(handle);
  const status = getMigrationStatus(handle);
  console.log(`✅ 迁移完成：已应用 ${status.applied} 个迁移文件`);
  console.log(`   journal_mode = ${status.journalMode}`);
  console.log(`   数据库：${env.DB_PATH}`);
} catch (err) {
  console.error('❌ 迁移失败：', err);
  handle.close();
  process.exit(1);
}

handle.close();
