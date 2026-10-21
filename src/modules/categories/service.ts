/**
 * 分类（docs/03 §4、docs/04 §六）。
 *
 * 结构固定为：record_type（6 种）→ level 1 主类别 → level 2 子类别。
 * 硬性约束：
 *   · 账单必须挂到 level 2，系统自动回填 parent_category_id（记账阶段落实）；
 *   · 有账单引用的分类禁止物理删除，只能 archived_at 停用；
 *   · 禁止三层，禁止跨 record_type 挂父类。
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { categories, transactions } from '../../db/schema.js';
import { RECORD_TYPES, RECORD_TYPES_WITH_CATEGORY, type RecordType } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { nowIso } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';

export interface CategoryRow {
  id: string;
  parentId: string | null;
  level: number;
  name: string;
  recordType: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
  archivedAt: string | null;
}

const COLUMNS = {
  id: categories.id,
  parentId: categories.parentId,
  level: categories.level,
  name: categories.name,
  recordType: categories.recordType,
  icon: categories.icon,
  color: categories.color,
  sortOrder: categories.sortOrder,
  isDefault: categories.isDefault,
  archivedAt: categories.archivedAt,
} as const;

/**
 * 统计每个分类近一年（365 天）被账单引用的笔数与金额
 * （同时含 parent_category_id 的引用，供主类别聚合）。
 * 口径与 docs/03 §1.5 净结余一致：直接用 actual_amount，转账/应收/应付不掺入。
 */
function usageStats(ctx: AppCtx, ledgerId: string): Map<string, { count: number; amount: number }> {
  const rows = ctx.dbHandle.raw
    .prepare(
      `SELECT cid AS cid, COUNT(*) AS c, COALESCE(SUM(actual), 0) AS amt FROM (
         SELECT category_id AS cid, actual_amount AS actual FROM transactions
          WHERE ledger_id = @ledger AND deleted_at IS NULL AND category_id IS NOT NULL
            AND tx_date > date('now', '-365 day')
         UNION ALL
         SELECT parent_category_id AS cid, actual_amount AS actual FROM transactions
          WHERE ledger_id = @ledger AND deleted_at IS NULL AND parent_category_id IS NOT NULL
            AND tx_date > date('now', '-365 day')
       ) GROUP BY cid`,
    )
    .all({ ledger: ledgerId }) as { cid: string; c: number; amt: number }[];

  const map = new Map<string, { count: number; amount: number }>();
  for (const r of rows) {
    map.set(r.cid, { count: Number(r.c), amount: Number(r.amt) });
  }
  return map;
}

function rowPayload(r: CategoryRow, stats: { count: number; amount: number }) {
  return {
    id: r.id,
    name: r.name,
    recordType: r.recordType,
    level: r.level,
    parentId: r.parentId,
    icon: r.icon,
    color: r.color,
    sortOrder: r.sortOrder,
    isDefault: r.isDefault,
    archivedAt: r.archivedAt,
    txCount: stats.count,
    // 金额口径：内部以「分」聚合，出参统一为元字符串（与账单金额一致）
    txAmount: (stats.amount / 100).toFixed(2),
  };
}

/** 树形列表：主类别 + children（docs/04 §六） */
export function listCategoryTree(
  ctx: AppCtx,
  ledgerId: string,
  opts: { recordType?: string; includeArchived?: boolean } = {},
) {
  const conditions = [eq(categories.ledgerId, ledgerId)];
  if (opts.recordType) {
    conditions.push(eq(categories.recordType, opts.recordType));
  }
  if (!opts.includeArchived) conditions.push(isNull(categories.archivedAt));

  const rows = ctx.db
    .select(COLUMNS)
    .from(categories)
    .where(and(...conditions))
    .orderBy(asc(categories.level), asc(categories.sortOrder), asc(categories.name))
    .all() as CategoryRow[];

  const usage = usageStats(ctx, ledgerId);
  const parents = rows.filter((r) => r.level === 1);
  const childrenOf = new Map<string, CategoryRow[]>();
  for (const r of rows) {
    if (r.level !== 2 || !r.parentId) continue;
    const bucket = childrenOf.get(r.parentId) ?? [];
    bucket.push(r);
    childrenOf.set(r.parentId, bucket);
  }

  return parents.map((p) => {
    const kids = (childrenOf.get(p.id) ?? []).map((c) =>
      rowPayload(c, usage.get(c.id) ?? { count: 0, amount: 0 }),
    );
    const own = usage.get(p.id) ?? { count: 0, amount: 0 };
    const totalCents =
      own.amount + (childrenOf.get(p.id) ?? []).reduce((acc, c) => acc + (usage.get(c.id)?.amount ?? 0), 0);
    return {
      ...rowPayload(p, own),
      // 主类别的引用数 = 自身命中 + 全部子类命中（统计口径）
      txCount: own.count + kids.reduce((acc, k) => acc + k.txCount, 0),
      txAmount: (totalCents / 100).toFixed(2),
      children: kids,
    };
  });
}

/** 扁平列表（供记账表单选择器用） */
export function listCategoryOptions(ctx: AppCtx, ledgerId: string, recordType?: string) {
  const tree = listCategoryTree(ctx, ledgerId, { recordType });
  return tree.map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    recordType: p.recordType,
    children: p.children.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      parentId: c.parentId,
    })),
  }));
}

function requireCategory(ctx: AppCtx, ledgerId: string, id: string): CategoryRow {
  const row = ctx.db
    .select(COLUMNS)
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('分类不存在');
  return row as CategoryRow;
}

export function assertRecordType(value: string): asserts value is RecordType {
  if (!(RECORD_TYPES as readonly string[]).includes(value)) {
    throw HttpError.validation([{ field: 'recordType', message: '记录类型不合法' }]);
  }
}

export function createCategory(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: { recordType: string; parentId?: string | null; name: string; icon?: string | null; color?: string | null },
) {
  assertRecordType(input.recordType);
  if (!RECORD_TYPES_WITH_CATEGORY.includes(input.recordType)) {
    throw HttpError.business('该记录类型不需要分类');
  }

  let level = 1;
  if (input.parentId) {
    const parent = requireCategory(ctx, ledgerId, input.parentId);
    if (parent.level !== 1) throw HttpError.business('分类只支持两层，不能在子类别下继续新建');
    if (parent.recordType !== input.recordType) {
      throw HttpError.business('子类别必须与父类别属于同一记录类型');
    }
    level = 2;
  }

  const dup = ctx.db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.ledgerId, ledgerId),
        eq(categories.recordType, input.recordType),
        input.parentId ? eq(categories.parentId, input.parentId) : isNull(categories.parentId),
        eq(categories.name, input.name),
      ),
    )
    .get();
  if (dup) throw HttpError.duplicate('同级下已存在同名分类');

  const maxRow = ctx.db
    .select({ m: sql<number>`coalesce(max(${categories.sortOrder}), 0)` })
    .from(categories)
    .where(
      and(
        eq(categories.ledgerId, ledgerId),
        eq(categories.recordType, input.recordType),
        input.parentId ? eq(categories.parentId, input.parentId) : isNull(categories.parentId),
      ),
    )
    .get();

  const id = newId(ID_PREFIX.category);
  ctx.db
    .insert(categories)
    .values({
      id,
      ledgerId,
      recordType: input.recordType,
      parentId: input.parentId ?? null,
      level,
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
      sortOrder: Number(maxRow?.m ?? 0) + 1,
      isDefault: false,
      createdAt: nowIso(),
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'category',
    entityId: id,
    summary: `新增${level === 1 ? '主类别' : '子类别'}「${input.name}」`,
  });

  return rowPayload(requireCategory(ctx, ledgerId, id), { count: 0, amount: 0 });
}

export function updateCategory(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  categoryId: string,
  input: { name?: string; icon?: string | null; color?: string | null },
) {
  const current = requireCategory(ctx, ledgerId, categoryId);

  // 内置分类（is_default=1）是预置科目表的一部分：名称不可改，可停用/恢复/换展示图标。
  if (current.isDefault && input.name !== undefined && input.name !== current.name) {
    throw HttpError.business('内置分类不可修改名称，不需要的分类可以停用（归档）');
  }

  if (input.name && input.name !== current.name) {
    const dup = ctx.db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.ledgerId, ledgerId),
          eq(categories.recordType, current.recordType),
          current.parentId ? eq(categories.parentId, current.parentId) : isNull(categories.parentId),
          eq(categories.name, input.name),
          sql`${categories.id} <> ${categoryId}`,
        ),
      )
      .get();
    if (dup) throw HttpError.duplicate('同级下已存在同名分类');
  }

  ctx.db
    .update(categories)
    .set({
      name: input.name ?? current.name,
      icon: input.icon === undefined ? current.icon : input.icon,
      color: input.color === undefined ? current.color : input.color,
    })
    .where(eq(categories.id, categoryId))
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'category',
    entityId: categoryId,
    summary: `更新分类「${input.name ?? current.name}」`,
    before: current,
    after: input,
  });
  return rowPayload(requireCategory(ctx, ledgerId, categoryId), { count: 0, amount: 0 });
}

/**
 * 删除分类。有账单引用时只能停用（archived_at），不做物理删除。
 * 主类别下还有未停用的子类别时，一并停用。
 */
export function deleteCategory(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  categoryId: string,
): { archived: true; txCount: number; archivedChildren: number } {
  const current = requireCategory(ctx, ledgerId, categoryId);
  const usage = usageStats(ctx, ledgerId);
  const txCount = usage.get(current.id)?.count ?? 0;

  const children =
    current.level === 1
      ? (ctx.db
          .select(COLUMNS)
          .from(categories)
          .where(and(eq(categories.parentId, current.id), isNull(categories.archivedAt)))
          .all() as CategoryRow[])
      : [];

  const childTx = children.reduce((acc, c) => acc + (usage.get(c.id)?.count ?? 0), 0);

  const at = nowIso();
  ctx.db.transaction((tx) => {
    for (const c of children) {
      tx.update(categories).set({ archivedAt: at }).where(eq(categories.id, c.id)).run();
    }
    tx.update(categories).set({ archivedAt: at }).where(eq(categories.id, categoryId)).run();
  });

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'category',
    entityId: categoryId,
    summary: `停用分类「${current.name}」${
      txCount + childTx > 0 ? `（已引用 ${txCount + childTx} 笔账单，进行停用而非删除）` : ''
    }`,
    before: current,
  });

  return { archived: true, txCount: txCount + childTx, archivedChildren: children.length };
}

/** 恢复停用分类 */
export function restoreCategory(ctx: AppCtx, actorId: string, ledgerId: string, categoryId: string) {
  const current = requireCategory(ctx, ledgerId, categoryId);
  ctx.db.update(categories).set({ archivedAt: null }).where(eq(categories.id, categoryId)).run();

  if (current.parentId) {
    const parent = requireCategory(ctx, ledgerId, current.parentId);
    if (parent.archivedAt) {
      ctx.db.update(categories).set({ archivedAt: null }).where(eq(categories.id, parent.id)).run();
    }
  }

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'category',
    entityId: categoryId,
    summary: `恢复分类「${current.name}」`,
  });
  return rowPayload(requireCategory(ctx, ledgerId, categoryId), { count: 0, amount: 0 });
}

export function reorderCategories(ctx: AppCtx, ledgerId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const owned = ctx.db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.ledgerId, ledgerId), inArray(categories.id, ids)))
    .all();
  if (owned.length !== new Set(ids).size) throw HttpError.notFound('分类不存在');

  ctx.db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(categories).set({ sortOrder: index + 1 }).where(eq(categories.id, id)).run();
    });
  });
}

/** 账本内是否有任何分类被账单引用（供删除前提示） */
export function categoryHasTransactions(ctx: AppCtx, ledgerId: string, categoryId: string): boolean {
  const row = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.ledgerId, ledgerId),
        sql`(${transactions.categoryId} = ${categoryId} OR ${transactions.parentCategoryId} = ${categoryId})`,
      ),
    )
    .get();
  return Number(row?.c ?? 0) > 0;
}
