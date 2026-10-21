/**
 * 开发用种子脚本：
 *   npm run db:seed                  → 自动创建 dev 用户与 dev 账本并写入预置数据
 *   npm run db:seed -- <ledgerId> <userId>  → 为指定账本写入预置数据
 *
 * 注意：正式流程中预置数据由「注册 / 创建账本」自动触发（Stage 3+）。
 */
import { loadEnv } from '../../config/env.js';
import { openDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';
import { seedLedgerDefaults } from '../seed.js';
import { ledgerMembers, ledgers, users } from '../schema.js';
import { nowIso } from '../../utils/money.js';
import { eq } from 'drizzle-orm';

const DEV_USER_ID = 'usr_dev';
const DEV_LEDGER_ID = 'ldg_dev';

const env = loadEnv();
const handle = openDatabase(env.DB_PATH);
runMigrations(handle);
const { db } = handle;

let ledgerId = process.argv[2];
let userId = process.argv[3];

if (!ledgerId || !userId) {
  const at = nowIso();
  console.log('ℹ 未提供参数，使用开发用 dev 用户/账本');

  db.insert(users)
    .values({
      id: DEV_USER_ID,
      username: 'dev',
      nickname: '开发者',
      passwordHash: 'dev-placeholder-not-a-real-hash',
      status: 'active',
      isSystem: true,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .run();

  db.insert(ledgers)
    .values({
      id: DEV_LEDGER_ID,
      name: '开发账本',
      type: 'personal',
      currency: 'CNY',
      ownerId: DEV_USER_ID,
      currentLedger: true,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .run();

  db.insert(ledgerMembers)
    .values({
      id: `${DEV_LEDGER_ID}#lm_dev`,
      ledgerId: DEV_LEDGER_ID,
      userId: DEV_USER_ID,
      role: 'owner',
      joinedAt: at,
    })
    .onConflictDoNothing()
    .run();

  ledgerId = DEV_LEDGER_ID;
  userId = DEV_USER_ID;
}

const exists = db.select().from(ledgers).where(eq(ledgers.id, ledgerId)).get();
if (!exists) {
  console.error(`❌ 账本不存在：${ledgerId}`);
  handle.close();
  process.exit(1);
}

const result = seedLedgerDefaults(db, ledgerId, userId);
console.log('✅ 预置数据写入完成（幂等）');
console.log(`   账本：${ledgerId}`);
console.log(`   新增 → 分组 ${result.groups} / 账户 ${result.accounts} / 分类 ${result.categories} / 标签 ${result.tags} / 模板 ${result.templates}`);
console.log('   （重复执行时新增数应为 0）');

handle.close();
