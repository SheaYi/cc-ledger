/**
 * 导入时「商家 / 备注」的**定位**：普通映射列。
 *
 * 锁死三件事（改动其中任何一条都会让用户看到「值莫名其妙变了」或「整批导入失败」）：
 *   1. 这两列**不参与自动分类规则匹配** —— 分类只由「名称」列命中的规则、
 *      「主类别 / 子类别」列写明的分类名、兜底分类决定；
 *      反之，只用这两列做判据的规则（`match_field='merchant' | 'note'`）在导入时不生效。
 *   2. 映射到这两列只是**取值**：有值原样导入，为空 / 缺失留空 ——
 *      不报错、不填充默认值、不做推断补全；
 *   3. 边界情况不炸：整列为空、列名带多余空格（全角也算）、映射了文件里没有的列名。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../src/context.js';
import type { Env } from '../src/config/env.js';
import { openDatabase, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { users, accountGroups, transactions } from '../src/db/schema.js';
import { createLedger } from '../src/modules/ledgers/service.js';
import { createAccount } from '../src/modules/accounts/service.js';
import { createCategory } from '../src/modules/categories/service.js';
import { createRule } from '../src/modules/categoryRules/service.js';
import { commit } from '../src/modules/imports/service.js';
import type { Mapping } from '../src/modules/imports/service.js';

describe('导入：商家与备注只作为映射列', () => {
  let dbHandle: DbHandle;
  let tmpDir: string;
  let ctx: AppCtx;
  const UID = 'u_impcls';
  let ledgerId = '';
  let accountId = '';
  let catDefault = '';
  let catByMerchantRule = '';
  let catByNameRule = '';
  let catByNoteRule = '';

  const env: Env = {
    NODE_ENV: 'test',
    PORT: 0,
    HOST: '127.0.0.1',
    TZ: 'Asia/Shanghai',
    DATA_DIR: '',
    DB_PATH: '',
    UPLOAD_DIR: '',
    BACKUP_DIR: '',
    JWT_SECRET: 'test-secret-at-least-16-chars-long-000',
    JWT_ACCESS_EXPIRES: '15m',
    JWT_REFRESH_EXPIRES: '30d',
    JWT_REFRESH_EXPIRES_MOBILE: '90d',
    PUBLIC_BASE_URL: 'http://ledger.test',
    RATE_LIMIT_LOGIN_MAX: 100,
    RATE_LIMIT_REGISTER_MAX: 100,
    LOG_LEVEL: 'silent',
    ENABLE_SCHEDULER: false,
    BACKUP_ENABLED: false,
    BACKUP_RETENTION_DAYS: 14,
    APP_VERSION: '1.0.0',
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-impcls-'));
    env.DATA_DIR = tmpDir;
    env.DB_PATH = path.join(tmpDir, 'test.db');
    env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    env.BACKUP_DIR = path.join(tmpDir, 'backups');

    dbHandle = openDatabase(env.DB_PATH);
    runMigrations(dbHandle);
    ctx = { env, dbHandle, db: dbHandle.db, startedAt: Date.now() };

    const nowIso = () => new Date().toISOString();
    dbHandle.db
      .insert(users)
      .values({
        id: UID,
        username: 'impcls',
        passwordHash: 'x',
        nickname: 'ImpCls',
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();

    const ledger = createLedger(ctx, UID, { name: '导入分类账本', type: 'personal', currency: 'CNY' });
    ledgerId = ledger.id;
    const grp = dbHandle.db
      .select()
      .from(accountGroups)
      .where(eq(accountGroups.ledgerId, ledgerId))
      .all()[0]!;
    accountId = createAccount(ctx, UID, ledgerId, { groupId: grp.id, name: '现金', type: 'cash' }).id;

    /**
     * 分类必须建到**二级**：`createTransaction` 只接受子类别（一级分类只是分组），
     * 传一级会报「只能选择子类别」—— 规则的目标分类同理。
     */
    const leaf = (parentName: string, childName: string) => {
      const parent = createCategory(ctx, UID, ledgerId, { recordType: 'expense', name: parentName });
      return createCategory(ctx, UID, ledgerId, {
        recordType: 'expense',
        name: childName,
        parentId: parent.id,
      }).id;
    };
    catDefault = leaf('兜底', '兜底子项');
    catByMerchantRule = leaf('商家规则', '商家规则子项');
    catByNameRule = leaf('名称规则', '名称规则子项');
    catByNoteRule = leaf('备注规则', '备注规则子项');

    /** 三条规则分别以商家 / 名称 / 备注为判据，用来验证「谁才是分类依据」 */
    createRule(ctx, UID, ledgerId, {
      matchField: 'merchant',
      matchOp: 'contains',
      matchValue: '星巴克',
      recordType: 'expense',
      targetCategoryId: catByMerchantRule,
    });
    createRule(ctx, UID, ledgerId, {
      matchField: 'name',
      matchOp: 'contains',
      matchValue: '咖啡',
      recordType: 'expense',
      targetCategoryId: catByNameRule,
    });
    createRule(ctx, UID, ledgerId, {
      matchField: 'note',
      matchOp: 'contains',
      matchValue: '加班',
      recordType: 'expense',
      targetCategoryId: catByNoteRule,
    });
  });

  afterAll(() => {
    dbHandle?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseMapping: Mapping = {
    dateColumn: '日期',
    amountColumn: '金额',
    recordType: 'expense',
    defaultAccountId: '',
  };

  const runImport = (header: string[], rows: string[][], extra: Partial<Mapping> = {}) => {
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    const rep = commit(
      ctx,
      UID,
      ledgerId,
      Buffer.from(csv),
      { ...baseMapping, defaultAccountId: accountId, defaultCategoryId: catDefault, ...extra },
      false,
    );
    return rep;
  };

  const txOf = (merchant: string | null) =>
    dbHandle.db
      .select()
      .from(transactions)
      .where(eq(transactions.ledgerId, ledgerId))
      .all()
      .find((t) => t.merchant === merchant);

  it('商家/备注不参与规则匹配：分类由「名称」列的规则决定', () => {
    const rep = runImport(
      ['日期', '名称', '商家', '备注', '金额'],
      [['2026-10-01', '咖啡', '星巴克', '加班', '30.00']],
      { nameColumn: '名称', merchantColumn: '商家', noteColumn: '备注' },
    );

    expect(rep.succeeded).toBe(1);
    expect(rep.failed).toBe(0);
    const tx = txOf('星巴克')!;
    /** 值仍然原样写入 —— 只是不作为分类判据 */
    expect(tx.merchant).toBe('星巴克');
    expect(tx.note).toBe('加班');
    expect(tx.name).toBe('咖啡');
    /** 分类来自「名称」规则，不是商家规则 / 备注规则 */
    expect(tx.categoryId).toBe(catByNameRule);
    expect(tx.categoryId).not.toBe(catByMerchantRule);
    expect(tx.categoryId).not.toBe(catByNoteRule);
  });

  it('商家与备注整列为空 → 字段留空、走兜底分类，不报错', () => {
    const before = dbHandle.db.select().from(transactions).where(eq(transactions.ledgerId, ledgerId)).all().length;
    const rep = runImport(
      ['日期', '名称', '商家', '备注', '金额'],
      [['2026-10-02', '打车', '', '', '40.00']],
      { nameColumn: '名称', merchantColumn: '商家', noteColumn: '备注' },
    );

    expect(rep.succeeded).toBe(1);
    const rows = dbHandle.db.select().from(transactions).where(eq(transactions.ledgerId, ledgerId)).all();
    expect(rows.length).toBe(before + 1);
    const tx = rows.find((t) => t.name === '打车')!;
    expect(tx.merchant).toBeNull();
    expect(tx.note).toBeNull();
    expect(tx.categoryId).toBe(catDefault);
  });

  it('列名含多余空格 / 全角空格仍能读到（归一化兜底），不静默变空', () => {
    /** 表头写作「商 家」，映射值写作「 商家 」—— 两级都靠归一化匹配命中 */
    const rep = runImport(
      ['日期', '名称', '商 家', '备注', '金额'],
      [['2026-10-03', '午饭', '楼下便利店', '同事聚餐', '55.00']],
      { nameColumn: '名称', merchantColumn: ' 商家 ', noteColumn: '备注　' },
    );

    expect(rep.succeeded).toBe(1);
    const tx = txOf('楼下便利店')!;
    expect(tx.merchant).toBe('楼下便利店');
    expect(tx.note).toBe('同事聚餐');
  });

  it('映射了文件里没有的列名 → 视为该列缺失：留空、不失败、不填充', () => {
    const rep = runImport(
      ['日期', '名称', '金额'],
      [['2026-10-04', '水果', '18.00']],
      { nameColumn: '名称', merchantColumn: '压根没有这一列', noteColumn: '也没有备注列' },
    );

    expect(rep.succeeded).toBe(1);
    expect(rep.failed).toBe(0);
    const tx = dbHandle.db
      .select()
      .from(transactions)
      .where(eq(transactions.ledgerId, ledgerId))
      .all()
      .find((t) => t.name === '水果')!;
    expect(tx.merchant).toBeNull();
    expect(tx.note).toBeNull();
  });
});
