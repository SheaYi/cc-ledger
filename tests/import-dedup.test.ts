/**
 * 导入去重口径：**日期 / 时间 / 金额一样即为重复**。
 *
 * 锁死三件事：
 *   1. 商家**不参与**判据 —— 同日同额、商家不同的两行必须判为重复（商家是按列直写的
 *      自由文本，写法不统一，拿它当键只会让真重复漏网）；
 *   2. 时间**参与**判据 —— 同日同额但时间不同的两行是两笔真消费，不能互相吃掉；
 *   3. 日期不同 / 金额不同都不是重复；跨文件重复提交同样被挡住。
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
import { commit } from '../src/modules/imports/service.js';
import type { Mapping } from '../src/modules/imports/service.js';

describe('导入：去重键 = 日期 + 时间 + 金额', () => {
  let dbHandle: DbHandle;
  let tmpDir: string;
  let ctx: AppCtx;
  const UID = 'u_impdedup';
  let ledgerId = '';
  let accountId = '';
  let catDefault = '';

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-impdd-'));
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
        username: 'impdd',
        passwordHash: 'x',
        nickname: 'ImpDD',
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();

    const ledger = createLedger(ctx, UID, { name: '导入去重账本', type: 'personal', currency: 'CNY' });
    ledgerId = ledger.id;
    const grp = dbHandle.db
      .select()
      .from(accountGroups)
      .where(eq(accountGroups.ledgerId, ledgerId))
      .all()[0]!;
    accountId = createAccount(ctx, UID, ledgerId, { groupId: grp.id, name: '现金', type: 'cash' }).id;

    /** 分类必须建到二级：`createTransaction` 只接受子类别 */
    const parent = createCategory(ctx, UID, ledgerId, { recordType: 'expense', name: '兜底' });
    catDefault = createCategory(ctx, UID, ledgerId, {
      recordType: 'expense',
      name: '兜底子项',
      parentId: parent.id,
    }).id;
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
    return commit(
      ctx,
      UID,
      ledgerId,
      Buffer.from(csv),
      { ...baseMapping, defaultAccountId: accountId, defaultCategoryId: catDefault, ...extra },
      false,
    );
  };

  const allTx = () => dbHandle.db.select().from(transactions).where(eq(transactions.ledgerId, ledgerId)).all();

  it('同日同额、商家不同 → 判为重复（商家不参与判据）', () => {
    const before = allTx().length;
    const rep = runImport(
      ['日期', '商家', '金额'],
      [
        ['2026-09-01', '星巴克', '30.00'],
        ['2026-09-01', '星巴克（国贸店）', '30.00'],
      ],
      { merchantColumn: '商家' },
    );
    expect(rep.succeeded).toBe(1);
    expect(rep.skipped).toBe(1);
    expect(allTx().length).toBe(before + 1);
  });

  it('同日同额但时间不同 → 不是重复（时间参与判据）', () => {
    const before = allTx().length;
    const rep = runImport(
      ['日期', '时间', '商家', '金额'],
      [
        ['2026-09-02', '09:05', '便利店', '20.00'],
        ['2026-09-02', '21:30', '便利店', '20.00'],
      ],
      { timeColumn: '时间', merchantColumn: '商家' },
    );
    expect(rep.succeeded).toBe(2);
    expect(rep.skipped).toBe(0);
    expect(allTx().length).toBe(before + 2);
  });

  it('时间写法不同（9:05 / 09:05:00）归一后算同一时刻 → 判为重复', () => {
    const before = allTx().length;
    const rep = runImport(
      ['日期', '时间', '金额'],
      [
        ['2026-09-03', '9:05', '12.00'],
        ['2026-09-03', '09:05:00', '12.00'],
      ],
      { timeColumn: '时间' },
    );
    expect(rep.succeeded).toBe(1);
    expect(rep.skipped).toBe(1);
    expect(allTx().length).toBe(before + 1);
  });

  it('日期不同 / 金额不同 → 都不是重复', () => {
    const before = allTx().length;
    const rep = runImport(
      ['日期', '金额'],
      [
        ['2026-09-04', '30.00'],
        ['2026-09-05', '30.00'],
        ['2026-09-04', '30.01'],
      ],
    );
    expect(rep.succeeded).toBe(3);
    expect(rep.skipped).toBe(0);
    expect(allTx().length).toBe(before + 3);
  });

  it('同一文件再导一次 → 全部被去重键挡住（与已有账单比对）', () => {
    const before = allTx().length;
    const rep = runImport(['日期', '金额'], [['2026-09-06', '66.00']]);
    expect(rep.succeeded).toBe(1);
    const again = runImport(['日期', '金额'], [['2026-09-06', '66.00']]);
    expect(again.succeeded).toBe(0);
    expect(again.skipped).toBe(1);
    expect(allTx().length).toBe(before + 1);
  });

  it('未来日期会被钳到今天 → 去重键跟着钳，重复导入仍被挡住', () => {
    const before = allTx().length;
    const future = '2099-01-01';
    const rep = runImport(['日期', '金额'], [[future, '88.00']]);
    expect(rep.succeeded).toBe(1);
    const again = runImport(['日期', '金额'], [[future, '88.00']]);
    expect(again.succeeded).toBe(0);
    expect(again.skipped).toBe(1);
    expect(allTx().length).toBe(before + 1);
  });
});
