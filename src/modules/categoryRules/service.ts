/**
 * 自动分类规则（`docs/04 §十五`）。
 *
 * ## 它解决什么
 *
 * 导入几百条历史流水时，逐条选分类是不可完成的工作。规则的价值在于：
 * **先把账单落库（分类可空），再用规则批量回填**。
 *
 * ## 匹配语义（三处必须一致，否则用户会看到「规则命中了但没生效」）
 *
 *  ① `matchField`：merchant / counterparty / name（**账单名称**）/ note；
 *  ② `matchOp`：
 *     - `contains`  包含（大小写不敏感）
 *     - `equals`    全等（大小写不敏感、去首尾空白）
 *     - `startsWith`前缀
 *     - `regex`     正则（非法正则 → 建规则时 400，不留到运行期炸）
 *  ③ `priority` 越小越先匹配；**命中即停**（first-match-wins）。
 *     不做「多条命中取最长/最高分」—— 那需要打分体系，文档没定义，
 *     凭直觉加会与文档行为不符。
 *
 * ## 只回填**没有分类**的账单
 *
 * 已人工归类的账单永远不被规则覆盖。这条是产品底线：用户的判断优先于自动化。
 * 所以「应用规则」返回的是「本次改了多少笔」，没改的静默跳过。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { categories, categoryRules, transactions } from '../../db/schema.js';
import { RECORD_TYPES, type RecordType } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { nowIso } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';

export const MATCH_FIELDS = ['merchant', 'counterparty', 'name', 'note'] as const;
export const MATCH_OPS = ['contains', 'equals', 'startsWith', 'regex'] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];
export type MatchOp = (typeof MATCH_OPS)[number];

export interface RuleDto {
  id: string;
  priority: number;
  matchField: MatchField;
  matchOp: MatchOp;
  matchValue: string;
  recordType: RecordType;
  targetCategoryId: string;
  targetCategoryName: string | null;
  enabled: boolean;
  hitCount: number;
  createdAt: string;
}

const FIELD_COLUMN = {
  merchant: transactions.merchant,
  counterparty: transactions.counterparty,
  name: transactions.name,
  note: transactions.note,
} as const;

export function listRules(ctx: AppCtx, ledgerId: string): RuleDto[] {
  const rows = ctx.db
    .select()
    .from(categoryRules)
    .where(eq(categoryRules.ledgerId, ledgerId))
    .orderBy(asc(categoryRules.priority), asc(categoryRules.id))
    .all();
  const cats = ctx.db.select().from(categories).where(eq(categories.ledgerId, ledgerId)).all();
  const names = new Map(cats.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    id: r.id,
    priority: r.priority,
    matchField: r.matchField as MatchField,
    matchOp: r.matchOp as MatchOp,
    matchValue: r.matchValue,
    recordType: r.recordType as RecordType,
    targetCategoryId: r.targetCategoryId,
    targetCategoryName: names.get(r.targetCategoryId) ?? null,
    enabled: r.enabled,
    hitCount: r.hitCount,
    createdAt: r.createdAt,
  }));
}

function requireRule(ctx: AppCtx, ledgerId: string, id: string) {
  const row = ctx.db
    .select()
    .from(categoryRules)
    .where(and(eq(categoryRules.ledgerId, ledgerId), eq(categoryRules.id, id)))
    .get();
  if (!row) throw HttpError.notFound('规则不存在');
  return row;
}

export interface RuleInput {
  priority?: number;
  matchField: MatchField;
  matchOp: MatchOp;
  matchValue: string;
  recordType: RecordType;
  targetCategoryId: string;
  enabled?: boolean;
}

function assertInput(ctx: AppCtx, ledgerId: string, input: RuleInput) {
  if (!MATCH_FIELDS.includes(input.matchField)) {
    throw HttpError.validation([{ field: 'matchField', message: `只支持 ${MATCH_FIELDS.join(' / ')}` }]);
  }
  if (!MATCH_OPS.includes(input.matchOp)) {
    throw HttpError.validation([{ field: 'matchOp', message: `只支持 ${MATCH_OPS.join(' / ')}` }]);
  }
  const value = input.matchValue?.trim();
  if (!value) throw HttpError.validation([{ field: 'matchValue', message: '匹配内容不能为空' }]);
  if (value.length > 100) {
    throw HttpError.validation([{ field: 'matchValue', message: '匹配内容最多 100 字' }]);
  }
  // 正则必须**建规则时**就编译一次：留到运行期才炸的话，
  // 用户看到的只是「导入后有几条没分类」，完全定位不到是哪条规则的问题。
  if (input.matchOp === 'regex') {
    try {
      new RegExp(value, 'i');
    } catch {
      throw HttpError.validation([{ field: 'matchValue', message: '正则表达式不合法' }]);
    }
  }
  if (!(RECORD_TYPES as readonly string[]).includes(input.recordType)) {
    throw HttpError.validation([{ field: 'recordType', message: '记录类型不合法' }]);
  }
  const cat = ctx.db
    .select({ id: categories.id, recordType: categories.recordType })
    .from(categories)
    .where(and(eq(categories.ledgerId, ledgerId), eq(categories.id, input.targetCategoryId)))
    .get();
  if (!cat) throw HttpError.validation([{ field: 'targetCategoryId', message: '目标分类不存在' }]);
  if (cat.recordType !== input.recordType) {
    throw HttpError.validation([{ field: 'targetCategoryId', message: '目标分类与记录类型不匹配' }]);
  }
  return { value, priority: input.priority ?? 100 };
}

export function createRule(ctx: AppCtx, actorId: string, ledgerId: string, input: RuleInput): RuleDto {
  const v = assertInput(ctx, ledgerId, input);
  const id = newId(ID_PREFIX.categoryRule);
  ctx.db
    .insert(categoryRules)
    .values({
      id,
      ledgerId,
      priority: v.priority,
      matchField: input.matchField,
      matchOp: input.matchOp,
      matchValue: v.value,
      recordType: input.recordType,
      targetCategoryId: input.targetCategoryId,
      enabled: input.enabled ?? true,
      hitCount: 0,
      createdAt: nowIso(),
      createdBy: actorId,
    })
    .run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'category_rule',
    entityId: id,
    summary: `新建自动分类规则：${input.matchField} ${input.matchOp} “${v.value}”`,
  });
  return listRules(ctx, ledgerId).find((r) => r.id === id)!;
}

export function updateRule(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  id: string,
  patch: Partial<RuleInput>,
): RuleDto {
  const before = requireRule(ctx, ledgerId, id);
  const merged: RuleInput = {
    priority: patch.priority ?? before.priority,
    matchField: (patch.matchField ?? before.matchField) as MatchField,
    matchOp: (patch.matchOp ?? before.matchOp) as MatchOp,
    matchValue: patch.matchValue ?? before.matchValue,
    recordType: (patch.recordType ?? before.recordType) as RecordType,
    targetCategoryId: patch.targetCategoryId ?? before.targetCategoryId,
    enabled: patch.enabled ?? before.enabled,
  };
  const v = assertInput(ctx, ledgerId, merged);
  ctx.db
    .update(categoryRules)
    .set({
      priority: merged.priority ?? v.priority,
      matchField: merged.matchField,
      matchOp: merged.matchOp,
      matchValue: v.value,
      recordType: merged.recordType,
      targetCategoryId: merged.targetCategoryId,
      enabled: merged.enabled ?? true,
    })
    .where(eq(categoryRules.id, id))
    .run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'category_rule',
    entityId: id,
    summary: `更新自动分类规则 ${id}`,
    before: { matchValue: before.matchValue, enabled: before.enabled },
    after: { matchValue: v.value, enabled: merged.enabled },
  });
  return listRules(ctx, ledgerId).find((r) => r.id === id)!;
}

export function deleteRule(ctx: AppCtx, actorId: string, ledgerId: string, id: string): { id: string } {
  const row = requireRule(ctx, ledgerId, id);
  ctx.db.delete(categoryRules).where(eq(categoryRules.id, id)).run();
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'category_rule',
    entityId: id,
    summary: `删除自动分类规则 “${row.matchValue}”`,
    before: row,
  });
  return { id };
}

export function reorderRules(ctx: AppCtx, actorId: string, ledgerId: string, ids: string[]): RuleDto[] {
  const own = new Set(ctx.db.select({ id: categoryRules.id }).from(categoryRules).where(eq(categoryRules.ledgerId, ledgerId)).all().map((r) => r.id));
  for (const id of ids) {
    if (!own.has(id)) throw HttpError.validation([{ field: 'ids', message: '排序列表里含有不属于该账本的规则' }]);
  }
  // 优先级按顺序重排成 10,20,30…：留出中间插位的空间，用户以后手动插一条不必全量重排
  ids.forEach((id, i) => {
    ctx.db.update(categoryRules).set({ priority: (i + 1) * 10 }).where(eq(categoryRules.id, id)).run();
  });
  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'category_rule',
    entityId: 'reorder',
    summary: `重排自动分类规则（${ids.length} 条）`,
  });
  return listRules(ctx, ledgerId);
}

/* ------------------------------------------------------------------ *
 * 试运行 / 应用
 * ------------------------------------------------------------------ */

interface Compiled {
  id: string;
  field: MatchField;
  op: MatchOp;
  value: string;
  regex?: RegExp;
  recordType: string;
  targetCategoryId: string;
}

function compile(ctx: AppCtx, ledgerId: string, onlyEnabled = true): Compiled[] {
  return ctx.db
    .select()
    .from(categoryRules)
    .where(eq(categoryRules.ledgerId, ledgerId))
    .orderBy(asc(categoryRules.priority), asc(categoryRules.id))
    .all()
    .filter((r) => (onlyEnabled ? r.enabled : true))
    .map((r) => {
      const c: Compiled = {
        id: r.id,
        field: r.matchField as MatchField,
        op: r.matchOp as MatchOp,
        value: r.matchValue,
        recordType: r.recordType,
        targetCategoryId: r.targetCategoryId,
      };
      if (r.matchOp === 'regex') {
        try {
          c.regex = new RegExp(r.matchValue, 'i');
        } catch {
          /* assertInput 已在建/改规则时挡掉；这里只是不让一条坏规则毁掉整批 */
        }
      }
      return c;
    });
}

function hit(rule: Compiled, tx: { recordType: string } & Record<string, unknown>): boolean {
  if (tx.recordType !== rule.recordType) return false;
  const raw = tx[rule.field];
  if (typeof raw !== 'string') return false;
  const hay = raw.toLowerCase();
  const needle = rule.value.toLowerCase();
  if (rule.op === 'contains') return hay.includes(needle);
  if (rule.op === 'equals') return hay.trim() === needle.trim();
  if (rule.op === 'startsWith') return hay.trim().startsWith(needle.trim());
  if (rule.regex) return rule.regex.test(raw);
  return false;
}

/** 找一条账单的**第一条**命中规则（first-match-wins） */
export function matchRuleOf(
  rules: Compiled[],
  tx: { recordType: string } & Record<string, unknown>,
): Compiled | null {
  return rules.find((r) => hit(r, tx)) ?? null;
}

const TX_SELECT = {
  id: transactions.id,
  recordType: transactions.recordType,
  merchant: transactions.merchant,
  counterparty: transactions.counterparty,
  name: transactions.name,
  note: transactions.note,
  categoryId: transactions.categoryId,
  parentCategoryId: transactions.parentCategoryId,
};

/**
 * 试运行：用最近 N 笔账单测试命中情况（`docs/04 §十五` 的 `preview`）。
 * **不落库** —— 目的是让用户在建规则之前看到「会命中哪些」。
 */
export function previewRules(ctx: AppCtx, ledgerId: string, limit = 100) {
  const rules = compile(ctx, ledgerId);
  const rows = ctx.db
    .select(TX_SELECT)
    .from(transactions)
    .where(and(eq(transactions.ledgerId, ledgerId), sql`${transactions.deletedAt} is null`))
    .orderBy(sql`${transactions.txDate} desc`)
    .limit(Math.min(500, Math.max(1, limit)))
    .all();

  const samples = [];
  let wouldFill = 0;
  const perRule = new Map<string, number>();
  for (const tx of rows) {
    const r = matchRuleOf(rules, tx);
    if (!r) continue;
    perRule.set(r.id, (perRule.get(r.id) ?? 0) + 1);
    if (!tx.categoryId) wouldFill += 1;
    if (samples.length < 20) {
      samples.push({
        transactionId: tx.id,
        name: tx.name,
        ruleId: r.id,
        matchValue: r.value,
        targetCategoryId: r.targetCategoryId,
        hasCategory: Boolean(tx.categoryId),
      });
    }
  }

  return {
    sampled: rows.length,
    matched: perRule.size ? [...perRule.values()].reduce((a, b) => a + b, 0) : 0,
    /** 会被补上分类的笔数（已有分类的不算） */
    wouldFill,
    perRule: [...perRule.entries()].map(([ruleId, count]) => ({ ruleId, count })),
    samples,
  };
}
/**
 * 供导入模块复用：给定一批「待分类的行」，返回每行命中的规则与分类（不落库）。
 *
 * 返回 `{ ruleId, categoryId } | null` 而不是只给 categoryId ——
 * 导入方要拿 `ruleId` 去累加 `hit_count`（「这条规则真的在这批数据里生效过」），
 * 只给分类的话那个计数器就永远只能靠人工维护。
 */
export function classifyRows(
  ctx: AppCtx,
  ledgerId: string,
  rows: { recordType: string; merchant?: string | null; counterparty?: string | null; name?: string | null; note?: string | null }[],
): { ruleId: string; categoryId: string }[] {
  const rules = compile(ctx, ledgerId);
  if (!rules.length) return rows.map(() => null) as never;
  return rows.map((r) => {
    const hitRule = matchRuleOf(rules, r as { recordType: string } & Record<string, unknown>);
    return hitRule ? { ruleId: hitRule.id, categoryId: hitRule.targetCategoryId } : null;
  }) as never;
}

/**
 * 把本次命中的次数累加到规则的 `hit_count`。
 * 导入是唯一会批量命中规则的地方，所以统计也只在这里发生 —— 规则页展示的
 * 「命中 N 次」因此是**真实的导入命中率**，而不是某个手工跑过的计数器。
 */
export function bumpHitCounts(ctx: AppCtx, ledgerId: string, perRule: Map<string, number>): void {
  if (!perRule.size) return;
  for (const [ruleId, count] of perRule) {
    if (count <= 0) continue;
    ctx.db
      .update(categoryRules)
      .set({ hitCount: sql`${categoryRules.hitCount} + ${count}` })
      .where(and(eq(categoryRules.ledgerId, ledgerId), eq(categoryRules.id, ruleId)))
      .run();
  }
}
