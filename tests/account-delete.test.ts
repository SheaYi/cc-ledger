/**
 * 账户 / 账户分组的删除语义（HTTP 集成，真实 app + 临时数据库）
 *
 * 这里锁死的是**两件容易被改坏的事**：
 *   1. 删分组**不带走账户** —— 组内账户统一移到「未分组」；
 *      反过来，「未分组」自己有账户时不能删（它是账户的兜底归属）。
 *   2. 删账户是**物理删除**，且只发生在「没有任何记录引用它」的时候；
 *      有账单的账户必须走归档，归档还能取消（取消归档 = 回到日常列表）。
 *
 * 这两条一旦反了，丢的都是用户真实的钱与历史。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../src/config/env.js';
import { openDatabase, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createScheduler } from '../src/scheduler/index.js';
import { buildApp } from '../src/app.js';

describe('账户 / 分组的删除与恢复', () => {
  let app: FastifyInstance;
  let dbHandle: DbHandle;
  let tmpDir: string;
  let token = '';
  let ledgerId = '';

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

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-acctdel-'));
    env.DATA_DIR = tmpDir;
    env.DB_PATH = path.join(tmpDir, 'test.db');
    env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    env.BACKUP_DIR = path.join(tmpDir, 'backups');

    dbHandle = openDatabase(env.DB_PATH);
    runMigrations(dbHandle);
    app = await buildApp({
      env,
      dbHandle,
      scheduler: createScheduler(dbHandle, env),
      publicDir: path.join(tmpDir, 'no-such-public-dir'),
      startedAt: Date.now(),
    });
    await app.ready();

    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      payload: { username: 'u_del', password: 'Str0ngPass!2026', nickname: '删除测试' },
    });
    expect(reg.statusCode).toBe(201);
    token = reg.json().data.accessToken;
    ledgerId = reg.json().data.ledger.id;
  });

  afterAll(async () => {
    await app?.close();
    dbHandle?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let ipSeq = 0;
  const req = (method: string, url: string, opts: { payload?: unknown } = {}) =>
    app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: { 'x-forwarded-for': `198.51.100.${++ipSeq}`, authorization: `Bearer ${token}` },
      ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });

  /**
   * 种子分组的 id 里带井号（seedId 的拼法），直接拼进 URL 会被当成片段标识符截断，
   * 服务端收到的 groupId 只剩前半截 → 「账户分组不存在」。必须编码。
   */
  const seg = (v: string) => encodeURIComponent(v);

  const dataOf = async (res: Awaited<ReturnType<typeof req>>) => res.json().data;

  it('删分组：组内账户保留并统一移到「未分组」', async () => {
    const groups: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/account-groups`));
    const bank = groups.find((g) => g.name === '银行卡');

    const created = await dataOf(
      await req('POST', `/ledgers/${ledgerId}/accounts`, {
        payload: { groupId: bank.id, name: '待迁移卡', type: 'debit_card', openingBalance: '0.00' },
      }),
    );
    expect(created.id).toBeTruthy();

    const del = await req('DELETE', `/ledgers/${ledgerId}/account-groups/${seg(bank.id)}`);
    expect(del.statusCode).toBe(200);
    const res = del.json().data;
    expect(res.mode).toBe('removed');
    expect(res.movedAccounts).toBeGreaterThanOrEqual(1);
    expect(res.fallbackGroup.name).toBe('未分组');

    // 账户还在，只是换了分组
    const after: any[] = await dataOf(
      await req('GET', `/ledgers/${ledgerId}/accounts?includeArchived=true`),
    );
    const moved = after.find((a) => a.id === created.id);
    expect(moved).toBeTruthy();
    const ungrouped: any[] = await dataOf(
      await req('GET', `/ledgers/${ledgerId}/account-groups`),
    );
    const target = ungrouped.find((g) => g.name === '未分组');
    expect(target).toBeTruthy();
    expect(moved.groupId).toBe(target.id);

    // 分组本身已经不在列表里
    expect(ungrouped.some((g) => g.id === bank.id)).toBe(false);
  });

  it('「未分组」是兜底分组：名下还有账户时不能删', async () => {
    const groups: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/account-groups`));
    const ungrouped = groups.find((g) => g.name === '未分组');
    const res = await req('DELETE', `/ledgers/${ledgerId}/account-groups/${seg(ungrouped.id)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('兜底');
  });

  it('删账户：没有任何账单引用时可以物理删除', async () => {
    const groups: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/account-groups`));
    const cash = groups.find((g) => g.name === '现金');
    const acc = await dataOf(
      await req('POST', `/ledgers/${ledgerId}/accounts`, {
        payload: { groupId: cash.id, name: '建错的账户', type: 'cash', openingBalance: '0.00' },
      }),
    );

    const res = await req('POST', `/ledgers/${ledgerId}/accounts/${acc.id}/purge`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);

    const after: any[] = await dataOf(
      await req('GET', `/ledgers/${ledgerId}/accounts?includeArchived=true`),
    );
    expect(after.some((a) => a.id === acc.id)).toBe(false);
  });

  it('删账户：有账单引用时拒绝，并指路归档', async () => {
    const groups: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/account-groups`));
    const cash = groups.find((g) => g.name === '现金');
    const acc = await dataOf(
      await req('POST', `/ledgers/${ledgerId}/accounts`, {
        payload: { groupId: cash.id, name: '有账的账户', type: 'cash', openingBalance: '0.00' },
      }),
    );
    const cats = await dataOf(await req('GET', `/ledgers/${ledgerId}/categories?recordType=expense`));
    const leaf = (cats as any[]).find((c) => c.children?.length)?.children?.[0] ?? (cats as any[])[0];

    const tx = await req('POST', `/ledgers/${ledgerId}/transactions`, {
      payload: {
        recordType: 'expense',
        direction: 'decrease',
        amount: '12.00',
        accountId: acc.id,
        categoryId: leaf.id,
        txDate: '2026-10-20',
      },
    });
    expect(tx.statusCode).toBe(201);

    const res = await req('POST', `/ledgers/${ledgerId}/accounts/${acc.id}/purge`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('归档');
  });

  it('归档 → 取消归档：账户回到日常列表', async () => {
    const groups: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/account-groups`));
    const cash = groups.find((g) => g.name === '现金');
    const acc = await dataOf(
      await req('POST', `/ledgers/${ledgerId}/accounts`, {
        payload: { groupId: cash.id, name: '归档往返', type: 'cash', openingBalance: '0.00' },
      }),
    );

    const arc = await req('DELETE', `/ledgers/${ledgerId}/accounts/${acc.id}`);
    expect(arc.statusCode).toBe(204);

    const active: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/accounts`));
    expect(active.some((a) => a.id === acc.id)).toBe(false);

    const back = await req('POST', `/ledgers/${ledgerId}/accounts/${acc.id}/restore`);
    expect(back.statusCode).toBe(200);
    expect(back.json().data.archivedAt).toBeNull();

    const again: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/accounts`));
    expect(again.some((a) => a.id === acc.id)).toBe(true);
  });

  /**
   * 已归档的账户同样可以被物理删除（编辑表单里的删除按钮对归档账户也开放）——
   * 「归档了就再也删不掉」是个死角：建错又归档的账户会永远留在库里。
   */
  it('删账户：已归档且无账单的账户也能删除', async () => {
    const groups: any[] = await dataOf(await req('GET', `/ledgers/${ledgerId}/account-groups`));
    const cash = groups.find((g) => g.name === '现金');
    const acc = await dataOf(
      await req('POST', `/ledgers/${ledgerId}/accounts`, {
        payload: { groupId: cash.id, name: '建错又归档', type: 'cash', openingBalance: '0.00' },
      }),
    );
    expect((await req('DELETE', `/ledgers/${ledgerId}/accounts/${acc.id}`)).statusCode).toBe(204);

    const res = await req('POST', `/ledgers/${ledgerId}/accounts/${acc.id}/purge`);
    expect(res.statusCode).toBe(200);

    const after: any[] = await dataOf(
      await req('GET', `/ledgers/${ledgerId}/accounts?includeArchived=true`),
    );
    expect(after.some((a) => a.id === acc.id)).toBe(false);
  });
});
