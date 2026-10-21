/**
 * 周期账单的日期计算（`docs/05 §11.2` / `§11.4`）。
 *
 * ## 为什么单独成文件
 *
 * 「下一期是哪天」是这套功能里唯一有真实算法难度的部分 —— 月末容错、跨月回绕、
 * 闰年、每周的第 N 个星期三…… 全在这里，而 CRUD 只是存取。拆开是为了**能单独测**：
 * 它是纯函数（输入规则 + 起点日期，输出日期或 null），不需要数据库。
 *
 * ## 约定
 *
 * - 所有日期都是本地日历日 `YYYY-MM-DD`，**不带时区**。周期账单是「每月 1 号交房租」
 *   这种日历概念，跟时区无关；带时区会让「今天是哪天」在容器 TZ 与用户 TZ 不同时错位。
 * - `from` 是**不含**的起点：返回的是**严格晚于** `from` 的下一个应生成日。
 *   这样 `cursor` 可以直接喂回本函数推进，不必担心自己卡在原地。
 * - 返回 `null` 表示「这条规则没有下一期了」（过了 `endDate`，或月长不够且不容错）。
 */

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RuleSchedule {
  frequency: Frequency;
  /** 每 N 个周期（`interval_count`，默认 1） */
  intervalCount: number;
  /** 起始日（含）`YYYY-MM-DD` */
  startDate: string;
  /** 结束日（含），空 = 长期 */
  endDate?: string | null;
  /** 每月第几天（1-31） */
  dayOfMonth?: number | null;
  /** 星期几（0=周日 … 6=周六） */
  weekDay?: number | null;
  /** 年中的第几月（1-12），仅 yearly */
  month?: number | null;
  /**
   * 「设 31 号但那个月没 31 天」时取月末（2 月 → 28/29），否则**跳过该月**。
   * `docs/05 §11.2`：月末容错，设定「每月 31 号」时 2 月自动取月末，不会漏生成。
   */
  maxMonthEnd: boolean;
}

/* ------------------------------------------------------------------ *
 * 基础日期工具（一律按本地日历日算，避开 UTC 的「昨天」陷阱）
 * ------------------------------------------------------------------ */

export function parseDay(day: string): Date {
  const parts = day.split('-').map(Number);
  // 输入恒为 YYYY-MM-DD（已过 zod 的 date 校验），这里只兜住手滑写坏的情况
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(y, m - 1, d);
}

export function fmtDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 比较两个日历日（字符串比较对 ISO 日期是安全的） */
function before(a: string, b: string): boolean {
  return a < b;
}

/* ------------------------------------------------------------------ *
 * 各频率的「下一期」
 * ------------------------------------------------------------------ */

/** 某个年月的第 day 天；day 超出月长时按 maxMonthEnd 决定月末还是跳过 */
function dayInMonth(
  year: number,
  month1: number,
  day: number,
  maxMonthEnd: boolean,
): string | null {
  const len = daysInMonth(year, month1);
  const d = day > len ? (maxMonthEnd ? len : null) : day;
  if (d === null) return null;
  return fmtDay(new Date(year, month1 - 1, d));
}

/**
 * 严格晚于 `from` 的下一个应生成日；没有则 null。
 * @param s 规则
 * @param from 起点（不含）
 */
export function nextDueDate(s: RuleSchedule, from: string): string | null {
  const interval = Math.max(1, Math.trunc(s.intervalCount || 1));
  const start = s.startDate;
  const end = s.endDate || null;
  if (end && before(end, from) && before(end, start)) return null;

  const limit = end ? (before(end, from) ? end : end) : null;

  /** 统一出口：越界检查 + 早于 startDate 的挡回 */
  const accept = (day: string): string | null => {
    if (before(day, start)) return null;
    if (limit && before(limit, day)) return null;
    return day;
  };

  const fromDate = parseDay(from);

  if (s.frequency === 'daily') {
    // 锚点是 startDate：每 N 天，不能用「from + N」，否则重跑会漂移
    const base = parseDay(start);
    const diff = Math.floor((fromDate.getTime() - base.getTime()) / 86_400_000);
    const nextIdx = Math.floor(diff / interval) + 1;
    let cand = addDays(base, nextIdx * interval);
    // 浮点/时区导致的边界回退：至少要严格晚于 from
    let guard = 0;
    while (fmtDay(cand) <= from && guard++ < 400) cand = addDays(cand, interval);
    return accept(fmtDay(cand));
  }

  if (s.frequency === 'weekly') {
    const wd = (s.weekDay ?? 1) % 7;
    const base = parseDay(start);
    // 锚定到 start 所在周的该星期几 —— 「每 N 周」是以它为原点数的
    const baseWeekStart = addDays(base, -((base.getDay() + 7 - wd) % 7));
    /**
     * ⚠️ 必须先把 from **对齐到目标星期几**再按 7 天推进。
     * 直接 `from + 7k` 只在 from 恰好是目标星期时成立 —— from 是周三时，
     * 永远算不出下一个周一（踩过：期望 10-12，实得 10-14）。
     */
    const first = addDays(fromDate, (wd - fromDate.getDay() + 7) % 7);
    for (let w = 0; w <= 520; w++) {
      const cand = addDays(first, w * 7);
      const day = fmtDay(cand);
      if (day <= from) continue;
      if (limit && before(limit, day)) return null;
      const candWeekStart = addDays(cand, -((cand.getDay() + 7 - wd) % 7));
      const weeks = Math.round((candWeekStart.getTime() - baseWeekStart.getTime()) / (7 * 86_400_000));
      if (weeks % interval !== 0) continue;
      return accept(day);
    }
    return null;
  }

  if (s.frequency === 'monthly') {
    const day = s.dayOfMonth ?? 1;
    // 从 from 所在月开始逐月推进（含当月：若当月的应生成日尚未到，也要能命中）
    let y = fromDate.getFullYear();
    let m = fromDate.getMonth() + 1;
    for (let i = 0; i < 1200; i++) {
      const cand = dayInMonth(y, m, day, s.maxMonthEnd);
      if (cand && from < cand) {
        // 「每 N 月」判定：以 startDate 所在月为锚
        const baseY = parseDay(start).getFullYear();
        const baseM = parseDay(start).getMonth() + 1;
        const months = (y - baseY) * 12 + (m - baseM);
        if (months % interval === 0) return accept(cand);
      }
      if (limit) {
        const monthEndDay = fmtDay(new Date(y, m, 0));
        if (before(limit, monthEndDay) && !cand) return null;
      }
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      if (limit && `${y}-${String(m).padStart(2, '0')}` > limit.slice(0, 7)) return null;
    }
    return null;
  }

  // yearly
  const mon = s.month ?? parseDay(start).getMonth() + 1;
  const day = s.dayOfMonth ?? parseDay(start).getDate();
  let y = fromDate.getFullYear();
  for (let i = 0; i < 400; i++) {
    const cand = dayInMonth(y, mon, day, s.maxMonthEnd);
    if (cand && from < cand) {
      const years = y - parseDay(start).getFullYear();
      if (years % interval === 0) return accept(cand);
    }
    if (limit && limit.slice(0, 4) < String(y)) return null;
    y += 1;
  }
  return null;
}

/**
 * 从 `cursor` 起（含 cursor 当天判断逻辑由调用方负责）连续取 n 个应生成日。
 * 用于「预览未来 5 期」（docs/05 §11.3）与生成任务。
 *
 * @param s 规则
 * @param cursor 起点（不含）
 * @param n 取几期
 * @param untilDate 到该日期为止（含），空 = 不限
 */
export function upcomingDueDates(s: RuleSchedule, cursor: string, n: number, untilDate?: string | null): string[] {
  const out: string[] = [];
  let cur = cursor;
  let guard = 0;
  while (out.length < n && guard++ < 2000) {
    const next = nextDueDate(s, cur);
    if (!next) break;
    if (untilDate && before(untilDate, next)) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/**
 * 从 `cursor` 之后一直取到 `untilDate`（含）为止的所有应生成日。
 * 生成任务用它 —— **幂等由 client_request_id 兜底**（唯一索引），这里只管把日期列全。
 */
export function dueDatesUntil(s: RuleSchedule, cursor: string, untilDate: string): string[] {
  return upcomingDueDates(s, cursor, 2000, untilDate);
}