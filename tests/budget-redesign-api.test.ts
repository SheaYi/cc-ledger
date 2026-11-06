/**
 * docs/16 预算重设计：新端点 HTTP 集成冒烟（真实 app + 临时数据库 + 全量迁移）。
 *
 * 为什么必须有这一层：新模块里的 SQL 是**运行时**才拼出来的。
 * typecheck 只保证列名在 TS 类型里存在、audit:routes 只保证路径不冲突，
 * 两者都挡不住「查了一张没建的表」「join 条件写反」「快照 NOT NULL 列没给值」这类错，
 * 而它们的症状往往是 500 或字段悄悄为 null —— 静态闸门全绿、页面却是空的。
 *
 * 这里逐条打过 docs/16 的全部新端点，并锁死几条核心口径：
 *   · A = B − U − C − R
 *   · 维度下拉只返回本账本成员
 *   · 归档后年度趋势读快照，不随今天的编辑变形
 *   · 生成下月预算不覆盖已存在行
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

describe('预算重设计新端点（docs/16 五阶段闭环）', () => {
  let app: FastifyInstance;
  let dbHandle: DbHandle;
  let tmpDir: string;
  let token = '';
  let ledgerId = '';
  let accountId = '';
  let expenseCatId = '';
  let totalBudgetId = '';
  let ipSeq = 0;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = `${year}-${String(month).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const prevDate = `${prev.y}-${String(prev.m).padStart(2, '0')}-15`;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-budget16-'));
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
      headers: { 'x-forwarded-for': '203.0.113.41' },
      payload: { username: 'u_budget16', password: 'Str0ngPass!2026', nickname: '预算重设计' },
    });
    expect(reg.statusCode).toBe(201);
    token = reg.json().data.accessToken;

    const led = await hit('POST', '/ledgers', { name: '预算重设计账本', currency: 'CNY' });
    ledgerId = led.id;
    B = `/ledgers/${ledgerId}/budgets`;

    const groups: any[] = await hit('GET', `/ledgers/${ledgerId}/account-groups`);
    const group = groups[0];
    const acc = await hit('POST', `/ledgers/${ledgerId}/accounts`, {
      groupId: group.id, name: '预算测试卡', type: 'debit_card', openingBalance: '100000.00',
    });
    accountId = acc.id;

    const cats: any[] = await hit('GET', `/ledgers/${ledgerId}/categories?recordType=expense`);
    const parent = cats.find((c) => (c.children ?? []).length > 0) ?? cats[0];
    expenseCatId = (parent.children ?? [])[0]?.id ?? parent.id;

    const total = await hit('POST', `/ledgers/${ledgerId}/budgets`, { year, month, amount: '1000.00' });
    totalBudgetId = total.id;
    await hit('POST', `/ledgers/${ledgerId}/budgets`, { categoryId: expenseCatId, year, month, amount: '400.00' });

    /** 专项项目预算：scopeId 指向一个没被任何账单使用的标签 */
    const tag = await hit('POST', `/ledgers/${ledgerId}/tags`, { name: '装修项目', color: '#007AFF' });
    await hit('POST', B, {
      scope: 'project', scopeId: tag.id, projectLabel: '装修',
      year, month, amount: '500.00', budgetKind: 'expense',
    });

    /** 两笔支出 + 一笔收入，让 U / 预警 / 复盘都有真实数据 */
    const tx = (body: Record<string, unknown>) =>
      hit('POST', `/ledgers/${ledgerId}/transactions`, {
        accountId, txDate: today, fee: '0', discount: '0', ...body,
      });
    await tx({ recordType: 'expense', categoryId: expenseCatId, name: '预算测试餐费', amount: '120.00' });
    await tx({ recordType: 'expense', categoryId: expenseCatId, name: '预算测试大额', amount: '260.00' });
  });

  afterAll(async () => {
    await app?.close();
    dbHandle?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function hit(method: string, url: string, payload?: unknown) {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: {
        'x-forwarded-for': `198.51.100.${++ipSeq}`,
        authorization: `Bearer ${token}`,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    if (res.statusCode >= 400) {
      throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 400)}`);
    }
    return res.json().data;
  }

  /** ⚠️ 不能在 describe 求值时拼 URL：那时 beforeAll 还没跑，ledgerId 仍是空串 */
  let B = '';
  const ym = `year=${year}&month=${month}`;

  it('阶段一：方法说明、周期规则、信封法预览、弹性预算预览', async () => {
    const methods: any[] = await hit('GET', `${B}/methods`);
    expect(methods.map((m) => m.key)).toEqual(['zero_base', 'envelope', 'ratio', 'historical', 'elastic']);
    const rules: any[] = await hit('GET', `${B}/period-rules`);
    expect(rules.length).toBeGreaterThanOrEqual(4);

    const env = await hit('POST', `${B}/plan/envelope`, {
      total: '1000.00',
      allocations: [{ categoryId: expenseCatId, amount: '400.00' }],
    });
    expect(env.total).toBe('1000.00');
    expect(env.allocated).toBe('400.00');
    expect(env.unallocated).toBe('600.00');
    expect(env.overAllocated).toBeNull();

    const elastic = await hit('GET', `${B}/plan/elastic-preview?${ym}&base=50000&ratioBp=1000`);
    expect(elastic.fixedBase).toBe('500.00');
    expect(elastic.ratioPercent).toBe('10.00');
    expect(elastic.effectiveAmount).toBeTruthy();
  });

  it('阶段二：五元组 A = B − U − C − R，承诺占用可创建/释放', async () => {
    const before: any = await hit('GET', `${B}/control?${ym}`);
    expect(before.rows.length).toBeGreaterThanOrEqual(2);
    const total = before.rows.find((r: any) => r.budgetId === totalBudgetId);
    expect(Number(total.used)).toBeCloseTo(380, 2);
    // 调拨/占用为 0 时，A = B − U
    expect(Number(total.available)).toBeCloseTo(Number(total.budgetAmount) - Number(total.used), 2);

    const res = await hit('POST', `${B}/reservations`, {
      kind: 'committed', amount: '50.00', budgetId: totalBudgetId,
      expectedOn: today, note: '待付定金',
    });
    expect(res.status).toBe('held');

    const after: any = await hit('GET', `${B}/control?${ym}`);
    const row = after.rows.find((r: any) => r.budgetId === totalBudgetId);
    expect(Number(row.committed)).toBeCloseTo(50, 2);
    expect(Number(row.available)).toBeCloseTo(
      Number(row.budgetAmount) - Number(row.used) - Number(row.committed) - Number(row.reserved), 2,
    );
    expect(row.reservations.some((r: any) => r.id === res.id)).toBe(true);

    const list: any[] = await hit('GET', `${B}/reservations?${ym}`);
    expect(list.some((r) => r.id === res.id)).toBe(true);

    await hit('POST', `${B}/reservations/${encodeURIComponent(res.id)}/release`);
    const released: any = await hit('GET', `${B}/control?${ym}`);
    expect(Number(released.rows.find((r: any) => r.budgetId === totalBudgetId).committed)).toBeCloseTo(0, 2);
  });

  it('专项项目预算按标签归集，不退回全账本支出', async () => {
    const progress: any[] = await hit('GET', `${B}/progress?${ym}`);
    const proj = progress.find((r) => r.projectLabel === '装修');
    expect(proj).toBeTruthy();
    /* 没有任何账单挂这个标签 → 已用必须是 0。修之前会掉进 categoryId===null
       分支，把全账本 380.00 当成「装修已花」，而且不报任何错。 */
    expect(Number(proj.spentAmount)).toBe(0);
    const total = progress.find((r) => r.id === totalBudgetId);
    expect(Number(total.spentAmount)).toBeCloseTo(380, 2);
  });

  it('维度下拉不越权：只返回本账本成员，且账户带名称', async () => {
    const opts: any = await hit('GET', `${B}/dimension-options`);
    expect(opts.accounts.some((a: any) => a.id === accountId && a.label === '预算测试卡')).toBe(true);
    expect(opts.members.length).toBe(1);
    expect(Array.isArray(opts.tags)).toBe(true);
  });

  it('阶段三：预警分级规则、预警中心纯读、超支后策略', async () => {
    await hit('PATCH', `${B}/prefs`, {
      alertTiers: [80, 90, 100], largeExpenseCents: 20000,
      channels: ['in_app', 'banner'], overspendPolicy: 'suggest_transfer',
      timeProgressAlert: true,
    });
    const rules: any = await hit('GET', `${B}/alert-rules`);
    expect(rules.alertTiers).toEqual([80, 90, 100]);
    expect(rules.descriptions).toHaveLength(3);
    expect(rules.overspendPolicy).toBe('suggest_transfer');

    const center: any = await hit('GET', `${B}/alert-center?${ym}`);
    const again: any = await hit('GET', `${B}/alert-center?${ym}`);
    expect(Array.isArray(center.items)).toBe(true);
    // 纯读：反复调用不应改变结果（不会把提醒标记成已读）
    expect(again.items.length).toBe(center.items.length);
    expect(center.channels).toEqual(['in_app', 'banner']);

    const policy: any = await hit('GET', `${B}/precheck-policy?${ym}`);
    expect(policy.options).toHaveLength(4);
    expect(policy.largeExpenseThreshold).toBe('200.00');
  });

  it('阶段四：追加削减留痕、归档预览 → 归档 → 快照可回看', async () => {
    const adjusted: any = await hit('POST', `${B}/${totalBudgetId}/adjust`, {
      delta: '100.00', reason: '临时增加餐饮额度',
    });
    expect(adjusted.amount).toBe('1100.00');

    const preview: any = await hit('GET', `${B}/archive-preview?${ym}`);
    expect(preview.period).toBe(period);
    expect(preview.count).toBeGreaterThanOrEqual(2);
    expect(preview.items.every((x: any) => typeof x.variance === 'string')).toBe(true);

    const archived: any = await hit('POST', `${B}/archive-period`, { year, month });
    expect(archived.period).toBe(period);
    expect(archived.archived).toBeGreaterThanOrEqual(2);

    const periods: any[] = await hit('GET', `${B}/archived-periods`);
    expect(periods.some((p) => p.period === period)).toBe(true);
    const snap: any[] = await hit('GET', `${B}/archived/${encodeURIComponent(period)}`);
    expect(snap.length).toBe(archived.archived);
    expect(snap[0]).toHaveProperty('varianceRatio');
  });

  it('阶段五：对照表 / 年度趋势读快照 / 下期建议 / 一键生成不覆盖', async () => {
    // 归档后仍可回看：执行控制 / 复盘 / 建议都不能变成空数组
    const archivedControl: any = await hit('GET', `${B}/control?${ym}`);
    expect(archivedControl.archived).toBe(true);
    expect(archivedControl.rows.length).toBeGreaterThanOrEqual(2);

    const review: any = await hit('GET', `${B}/review?${ym}`);
    expect(review.period).toBe(period);
    expect(review.rows.length).toBeGreaterThanOrEqual(2);
    expect(review.summary).toHaveProperty('accuracy');
    expect(review.comparison.mom).toHaveProperty('changeRatio');
    expect(review.comparison.yoy).toHaveProperty('changeRatio');
    // 除零约定：对比期无支出 → null（前端显示「—」）
    expect(review.comparison.mom.changeRatio === null || typeof review.comparison.mom.changeRatio === 'string').toBe(true);

    const trend: any[] = await hit('GET', `${B}/review/trend?year=${year}`);
    expect(trend).toHaveLength(12);
    const archivedMonth = trend.find((t) => t.period === period);
    expect(archivedMonth.archived).toBe(true);
    expect(archivedMonth.budget).not.toBeNull();

    const sug: any = await hit('GET', `${B}/review/suggestions?${ym}`);
    expect(sug.items.length).toBeGreaterThan(0);
    expect(sug.items[0].suggestedAmount).toMatch(/^\d+\.\d{2}$/);

    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const generated: any = await hit('POST', `${B}/review/generate-next`, {
      year, month,
      items: sug.items.map((x: any) => ({
        categoryId: x.categoryId, amount: x.suggestedAmount, budgetKind: x.budgetKind,
        scope: x.scope, scopeId: x.scopeId, projectLabel: x.projectLabel,
      })),
    });
    expect(generated.created).toBeGreaterThan(0);
    /* 总预算与专项项目预算 categoryId 都是 null，去重键必须靠 scope 区分 */
    expect(generated.created).toBe(sug.items.length);
    const again: any = await hit('POST', `${B}/review/generate-next`, {
      year, month,
      items: sug.items.map((x: any) => ({
        categoryId: x.categoryId, amount: x.suggestedAmount, budgetKind: x.budgetKind,
        scope: x.scope, scopeId: x.scopeId, projectLabel: x.projectLabel,
      })),
    });
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(generated.created);

    const nextList: any[] = await hit('GET', `${B}?year=${next.year}&month=${next.month}`);
    expect(nextList.length).toBeGreaterThanOrEqual(generated.created);
  });

  it('负结转把上期超支以负数带进本期，且给出明示', async () => {
    await hit('POST', `${B}`, { categoryId: expenseCatId, year: prev.y, month: prev.m, amount: '100.00' });
    await hit('POST', `/ledgers/${ledgerId}/transactions`, {
      accountId, txDate: prevDate, fee: '0', discount: '0',
      recordType: 'expense', categoryId: expenseCatId, name: '上期超支', amount: '150.00',
    });
    const out: any = await hit('POST', `${B}/rollover`, {
      fromYear: prev.y, fromMonth: prev.m, toYear: year, toMonth: month,
      mode: 'carry_negative', note: '把超支带过来',
    });
    expect(out.mode).toBe('carry_negative');
    expect(out.items.some((i: any) => Number(i.carried) < 0)).toBe(true);
    expect(out.warnings.some((w: string) => w.includes('超支'))).toBe(true);
  });
});
