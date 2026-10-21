/**
 * Stage 3 单元 + 集成测试
 * 集成部分用 fastify.inject 直接跑真实 HTTP 管线（含迁移、种子、认证、限流），
 * 数据库落在临时目录，不污染 ./data。
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
import { hashPassword, verifyPassword } from '../src/utils/password.js';
import {
  createRefreshToken,
  generateInviteCode,
  hashRefreshToken,
  parseDurationSeconds,
} from '../src/utils/token.js';
import { AppError } from '../src/utils/errors.js';
import { parseOrThrow, passwordSchema, usernameSchema } from '../src/utils/validate.js';

/* ------------------------------------------------------------------ *
 * 1. 密码哈希（argon2id）
 * ------------------------------------------------------------------ */
describe('密码哈希', () => {
  it('argon2id 哈希可被正确校验', async () => {
    const hash = await hashPassword('Str0ngPass!2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Str0ngPass!2026')).toBe(true);
  });

  it('错误口令校验失败', async () => {
    const hash = await hashPassword('Str0ngPass!2026');
    expect(await verifyPassword(hash, 'Str0ngPass!2027')).toBe(false);
  });

  it('相同口令两次哈希结果不同（含随机盐）', async () => {
    const a = await hashPassword('SamePass123');
    const b = await hashPassword('SamePass123');
    expect(a).not.toBe(b);
  });

  it('空哈希/非法哈希返回 false，不抛异常', async () => {
    expect(await verifyPassword('', 'x')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 令牌工具
 * ------------------------------------------------------------------ */
describe('令牌工具', () => {
  it('parseDurationSeconds 支持常见写法', () => {
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('30d')).toBe(2_592_000);
    expect(parseDurationSeconds('90d')).toBe(7_776_000);
    expect(parseDurationSeconds('12h')).toBe(43_200);
    expect(parseDurationSeconds('45s')).toBe(45);
    expect(parseDurationSeconds('600')).toBe(600);
    expect(parseDurationSeconds('bogus', 42)).toBe(42);
  });

  it('refresh token 带 rt_ 前缀且每次不同', () => {
    const a = createRefreshToken();
    const b = createRefreshToken();
    expect(a.token.startsWith('rt_')).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThan(20);
  });

  it('hashRefreshToken 稳定且不可逆（只存哈希）', () => {
    const { token } = createRefreshToken();
    const h1 = hashRefreshToken(token);
    const h2 = hashRefreshToken(token);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).not.toContain(token);
  });

  it('邀请码为 6 位且排除易混字符 I/O/0/1', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode(6);
      expect(code).toHaveLength(6);
      expect(/^[2-9A-HJ-NP-Z]+$/.test(code)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. 校验与错误体系
 * ------------------------------------------------------------------ */
describe('校验与错误体系', () => {
  it('用户名规则：3-32 位字母数字下划线', () => {
    expect(usernameSchema.safeParse('zhang_san1').success).toBe(true);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('张三').success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('密码规则：≥8 位且含字母与数字', () => {
    expect(passwordSchema.safeParse('Str0ngPass').success).toBe(true);
    expect(passwordSchema.safeParse('abcdefgh').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(false);
    expect(passwordSchema.safeParse('Ab1').success).toBe(false);
  });

  it('parseOrThrow 抛出 VALIDATION_ERROR 并带字段明细', () => {
    try {
      parseOrThrow(usernameSchema, 'x');
      throw new Error('应当抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.status).toBe(400);
      expect(err.details?.[0]?.field).toBe('(root)');
    }
  });

  it('错误码映射到正确的 HTTP 状态', () => {
    expect(new AppError('NOT_FOUND').status).toBe(404);
    expect(new AppError('FORBIDDEN').status).toBe(403);
    expect(new AppError('DUPLICATE_RESOURCE').status).toBe(409);
    expect(new AppError('DB_BUSY').status).toBe(503);
  });
});

/* ------------------------------------------------------------------ *
 * 4. HTTP 集成（真实 app + 临时数据库）
 * ------------------------------------------------------------------ */
describe('认证与账本 HTTP 集成', () => {
  let app: FastifyInstance;
  let dbHandle: DbHandle;
  let tmpDir: string;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-test-'));
    env.DATA_DIR = tmpDir;
    env.DB_PATH = path.join(tmpDir, 'test.db');
    env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    env.BACKUP_DIR = path.join(tmpDir, 'backups');

    dbHandle = openDatabase(env.DB_PATH);
    runMigrations(dbHandle);
    const scheduler = createScheduler(dbHandle, env);
    app = await buildApp({
      env,
      dbHandle,
      scheduler,
      publicDir: path.join(tmpDir, 'no-such-public-dir'),
      startedAt: Date.now(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    dbHandle?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let ipSeq = 0;
  const ip = () => `198.51.100.${++ipSeq}`;

  const req = (method: string, url: string, opts: { payload?: unknown; token?: string } = {}) =>
    app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: {
        'x-forwarded-for': ip(),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });

  const register = async (username: string) => {
    const res = await req('POST', '/auth/register', {
      payload: { username, password: 'Str0ngPass!2026', nickname: `昵称_${username}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data;
  };

  it('注册后返回令牌与个人账本，且预置数据已就绪', async () => {
    const data = await register('u_alice');
    expect(data.user.username).toBe('u_alice');
    expect(data.ledger.name).toBe('我的账本');
    expect(data.expiresIn).toBe(900);
    expect(data.refreshToken.startsWith('rt_')).toBe(true);

    const seeded = dbHandle.raw
      .prepare('SELECT (SELECT count(*) FROM account_groups WHERE ledger_id=?) g, (SELECT count(*) FROM accounts WHERE ledger_id=?) a, (SELECT count(*) FROM categories WHERE ledger_id=?) c, (SELECT count(*) FROM tags WHERE ledger_id=?) t, (SELECT count(*) FROM templates WHERE ledger_id=?) p')
      .get(data.ledger.id, data.ledger.id, data.ledger.id, data.ledger.id, data.ledger.id) as Record<string, number>;
    expect(seeded.g).toBe(6);
    expect(seeded.a).toBe(3);
    expect(seeded.c).toBeGreaterThan(100);
    expect(seeded.t).toBe(8);
    expect(seeded.p).toBe(8);
  });

  it('GET /users/me 需要有效令牌', async () => {
    const anon = await req('GET', '/users/me');
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe('UNAUTHORIZED');
  });

  it('登录 → 刷新轮换 → 旧令牌失效', async () => {
    const alice = await register('u_bob');
    const login = await req('POST', '/auth/login', {
      payload: { identifier: 'u_bob', password: 'Str0ngPass!2026' },
    });
    expect(login.statusCode).toBe(200);
    const rt = login.json().data.refreshToken;

    const rotated = await req('POST', '/auth/refresh', { payload: { refreshToken: rt } });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().data.refreshToken).not.toBe(rt);

    const reuse = await req('POST', '/auth/refresh', { payload: { refreshToken: rt } });
    expect(reuse.statusCode).toBe(401);

    // 新 access token 可用
    const me = await req('GET', '/users/me', { token: rotated.json().data.accessToken });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.id).toBe(alice.user.id);
  });

  it('邀请码全链路：创建 → 公开预览 → 兑换 → 成员可见', async () => {
    const owner = await register('u_owner');
    const guest = await register('u_guest');

    const created = await req('POST', '/ledgers', {
      token: owner.accessToken,
      payload: { name: '共同账本', type: 'shared' },
    });
    expect(created.statusCode).toBe(201);
    const ledgerId = created.json().data.id;

    const inv = await req('POST', `/ledgers/${ledgerId}/invitations`, {
      token: owner.accessToken,
      payload: { role: 'admin', maxUses: 2, expiresInHours: 24 },
    });
    expect(inv.statusCode).toBe(201);
    const code = inv.json().data.code;
    expect(inv.json().data.inviteUrl).toBe(`http://ledger.test/invite/${code}`);

    // 公开预览无需登录
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/invitations/${code}`,
      headers: { 'x-forwarded-for': ip() },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.valid).toBe(true);
    expect(preview.json().data.ledger.name).toBe('共同账本');

    const redeem = await req('POST', `/invitations/${code}/redeem`, { token: guest.accessToken });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().data.alreadyMember).toBe(false);
    expect(redeem.json().data.role).toBe('admin');

    const again = await req('POST', `/invitations/${code}/redeem`, { token: guest.accessToken });
    expect(again.json().data.alreadyMember).toBe(true);

    const members = await req('GET', `/ledgers/${ledgerId}/members`, { token: owner.accessToken });
    expect(members.json().data).toHaveLength(2);

    // 跨账本访问 → 404
    const cross = await req('GET', `/ledgers/${owner.ledger.id}`, { token: guest.accessToken });
    expect(cross.statusCode).toBe(404);
  });

  it('修改密码后全部 refresh token 失效', async () => {
    const u = await register('u_pwd');
    const res = await req('PATCH', '/users/me/password', {
      token: u.accessToken,
      payload: { oldPassword: 'Str0ngPass!2026', newPassword: 'N3wPass!2026' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.revokedSessions).toBeGreaterThan(0);

    const reuse = await req('POST', '/auth/refresh', { payload: { refreshToken: u.refreshToken } });
    expect(reuse.statusCode).toBe(401);

    const relogin = await req('POST', '/auth/login', {
      payload: { identifier: 'u_pwd', password: 'N3wPass!2026' },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('未知 API 路由返回统一 404 包装', async () => {
    const res = await req('GET', '/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(typeof res.json().error.requestId).toBe('string');
  });
});
