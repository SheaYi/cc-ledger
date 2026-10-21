import fs from 'node:fs';
import path from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type { DbHandle } from '../db/client.js';
import type { AppCtx } from '../context.js';
import { generateDue } from '../modules/recurring/service.js';
import { payDueSchedules } from '../modules/installment/service.js';
import { captureNetWorthSnapshot } from '../modules/stats/advanced.js';
import { ledgers } from '../db/schema.js';
import type { Env } from '../config/env.js';
import { nowIso } from '../utils/money.js';
import { LIMITS } from '../config/constants.js';

export interface Scheduler {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  nextRun(): string | null;
  readonly tasks: string[];
}

/** 计算下一次「每日 HH:mm」的本地时间（ISO 字符串） */
function nextDailyAt(hour: number, minute: number): string {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return nowIso(t);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 某年某月（1-based）的最后一天，格式 YYYY-MM-DD */
function monthEnd(y: number, m: number): string {
  return `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
}

/**
 * 定时任务（docs/06 第六节）。
 * 全部以容器 TZ=Asia/Shanghai 为准。
 */
export function createScheduler(handle: DbHandle, env: Env, ctx?: AppCtx): Scheduler {
  const jobs: ScheduledTask[] = [];
  let running = false;
  const names: string[] = [];

  const log = (msg: string, extra?: Record<string, unknown>) => {
    console.log(JSON.stringify({ level: 'info', time: nowIso(), msg, ...extra }));
  };

  // ---- 任务 1：周期账单生成（Stage 10 实现） ----
  const recurringExpr = '5 0 * * *';
  // ---- 任务 2：分期还款（Stage 11 已实现；逾期标记留给 Stage 12 统计） ----
  const overdueExpr = '10 0 * * *';
  // ---- 任务 3：数据库备份 ----
  const backupExpr = '0 3 * * *';
  // ---- 任务 4：回收站清理 ----
  const trashExpr = '0 4 * * *';
  // ---- 任务 5：过期 Token 清理 ----
  const tokenExpr = '0 * * * *';

  function backupDatabase(): void {
    if (!env.BACKUP_ENABLED) return;
    try {
      fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
      const d = new Date();
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const target = path.join(env.BACKUP_DIR, `cc-ledger-${stamp}.db`);
      handle.raw.prepare('VACUUM INTO ?').run(target);

      // 保留策略
      const cutoff = Date.now() - env.BACKUP_RETENTION_DAYS * 86400_000;
      for (const f of fs.readdirSync(env.BACKUP_DIR)) {
        if (!f.startsWith('cc-ledger-') || !f.endsWith('.db')) continue;
        const full = path.join(env.BACKUP_DIR, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      }
      log('数据库备份完成', { file: target, retentionDays: env.BACKUP_RETENTION_DAYS });
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', time: nowIso(), msg: '数据库备份失败', error: String(e) }));
    }
  }

  function cleanTrash(): void {
    try {
      const cutoff = nowIso(new Date(Date.now() - LIMITS.TRASH_RETENTION_DAYS * 86400_000));
      const r = handle.raw
        .prepare('DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < ?')
        .run(cutoff);
      log('回收站清理完成', { removed: r.changes, retentionDays: LIMITS.TRASH_RETENTION_DAYS });
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', time: nowIso(), msg: '回收站清理失败', error: String(e) }));
    }
  }

  function cleanTokens(): void {
    try {
      const r = handle.raw
        .prepare('DELETE FROM refresh_tokens WHERE expires_at < ?')
        .run(nowIso());
      if (r.changes > 0) log('过期 Token 清理完成', { removed: r.changes });
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', time: nowIso(), msg: 'Token 清理失败', error: String(e) }));
    }
  }

  return {
    tasks: names,
    start() {
      if (running || !env.ENABLE_SCHEDULER) return;
      const opts = { timezone: env.TZ };

      /**
       * 周期账单生成（docs/05 §11.4）：每日 00:05 扫一遍 active 规则，
       * 把「今天 + 提前天数」之前该出的账补齐。
       * 幂等由 client_request_id 的唯一索引兜底（见 recurring/service.ts 纪律 ①），
       * 所以容器重启、任务重跑、这里被手动触发多次都**不会**产生第二笔。
       */
      jobs.push(
        cron.schedule(recurringExpr, () => {
          if (!ctx) {
            log('周期账单生成：缺少 AppCtx，跳过');
            return;
          }
          try {
            const r = generateDue(ctx);
            log('周期账单生成', {
              created: r.summary.created,
              reused: r.summary.reused,
              failed: r.summary.failed,
              rules: r.summary.rules,
            });
            for (const d of r.details.filter((x) => x.error).slice(0, 5)) {
              log('周期账单生成失败', { rule: d.ruleName, dueDate: d.dueDate, error: d.error });
            }
          } catch (err) {
            log('周期账单生成异常', { error: err instanceof Error ? err.message : String(err) });
          }
        }, opts),
      );
      /**
       * 分期还款（`docs/05 §12.3` 的步骤 2）：每天扫一遍，把「到期且未还」的期还掉。
       * 生成的是**转账**（主账户 −X → 负债账户 +X），**不是支出** ——
       * 支出只在建计划时记那一笔（`docs/05 §12.2`：分期 = 一次支出 + 多次转账还款）。
       * 幂等靠 `client_request_id` 的唯一索引：同一期永远同一个键，任务重跑不会多还。
       */
      jobs.push(
        cron.schedule(overdueExpr, () => {
          if (!ctx) {
            log('分期还款：缺少 AppCtx，跳过');
            return;
          }
          try {
            const r = payDueSchedules(ctx);
            log('分期还款', {
              plans: r.summary.plans,
              paid: r.summary.paid,
              failed: r.summary.failed,
            });
            for (const d of r.details.filter((x) => x.error).slice(0, 5)) {
              log('分期还款失败', { scheduleId: d.scheduleId, seq: d.seq, error: d.error });
            }
          } catch (err) {
            log('分期还款异常', { error: err instanceof Error ? err.message : String(err) });
          }
        }, opts),
      );
      jobs.push(cron.schedule(backupExpr, backupDatabase, opts));
      jobs.push(cron.schedule(trashExpr, cleanTrash, opts));
      jobs.push(cron.schedule(tokenExpr, cleanTokens, opts));
      /**
       * 净资产月末快照（S-09）：每月 1 号 00:15 为所有账本拍「上月末」快照。
       * 历史月份的净值必须靠快照固化（docs/14：历史事实不可被今天的改账重写），
       * 而此前没有任何入口写这张表 —— 报表页的净资产趋势因此对所有人都是空的。
       * 这里补上自动续拍；历史月份的回填由前端「补拍历史快照」按钮触发。
       * `captureNetWorthSnapshot` 按 snapshotDate 定格，幂等（唯一索引 + upsert）。
       */
      jobs.push(
        cron.schedule('15 0 1 * *', () => {
          if (!ctx) {
            log('净资产月末快照：缺少 AppCtx，跳过');
            return;
          }
          try {
            const d = new Date();
            const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
            const pm = monthEnd(prev.getFullYear(), prev.getMonth() + 1);
            const ids = ctx.db.select({ id: ledgers.id }).from(ledgers).all() as { id: string }[];
            for (const { id } of ids) {
              captureNetWorthSnapshot(ctx, id, pm);
            }
            log('净资产月末快照完成', { ledgers: ids.length, snapshotDate: pm });
          } catch (err) {
            log('净资产月末快照异常', { error: err instanceof Error ? err.message : String(err) });
          }
        }, opts),
      );

      names.push(
        '周期账单生成(00:05)',
        '分期还款(00:10)',
        '数据库备份(03:00)',
        '回收站清理(04:00)',
        'Token清理(每小时)',
        '净资产月末快照(每月1号 00:15)',
      );
      running = true;
      log('定时任务已注册', { timezone: env.TZ, count: jobs.length });
    },
    stop() {
      for (const j of jobs) j.stop();
      jobs.length = 0;
      names.length = 0;
      running = false;
    },
    isRunning() {
      return running;
    },
    nextRun() {
      return running ? nextDailyAt(0, 5) : null;
    },
  };
}
