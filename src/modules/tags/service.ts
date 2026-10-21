/**
 * 标签（docs/04 §7.1）。标签是账本级主数据，color 走 8 色盘。
 * useCount 以关联表实时统计为准，避免计数器漂移。
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { tags, transactionTags } from '../../db/schema.js';
import { TAG_COLORS } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { nowIso } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';

export interface TagRow {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  useCount: number;
  archivedAt: string | null;
}

const COLUMNS = {
  id: tags.id,
  name: tags.name,
  color: tags.color,
  sortOrder: tags.sortOrder,
  useCount: tags.useCount,
  archivedAt: tags.archivedAt,
} as const;

function liveUsage(ctx: AppCtx, ledgerId: string): Map<string, number> {
  const rows = ctx.dbHandle.raw
    .prepare(
      `SELECT tt.tag_id AS tid, COUNT(*) AS c
         FROM transaction_tags tt
         JOIN transactions t ON t.id = tt.transaction_id
        WHERE t.ledger_id = @ledger AND t.deleted_at IS NULL
        GROUP BY tt.tag_id`,
    )
    .all({ ledger: ledgerId }) as { tid: string; c: number }[];
  return new Map(rows.map((r) => [r.tid, Number(r.c)]));
}

function payload(r: TagRow, useCount: number) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    sortOrder: r.sortOrder,
    useCount,
    archivedAt: r.archivedAt,
  };
}

export function listTags(ctx: AppCtx, ledgerId: string, includeArchived = false) {
  const conditions = [eq(tags.ledgerId, ledgerId)];
  if (!includeArchived) conditions.push(isNull(tags.archivedAt));

  const rows = ctx.db
    .select(COLUMNS)
    .from(tags)
    .where(and(...conditions))
    .orderBy(asc(tags.sortOrder), asc(tags.name))
    .all() as TagRow[];

  const usage = liveUsage(ctx, ledgerId);
  return rows.map((r) => payload(r, usage.get(r.id) ?? 0));
}

function requireTag(ctx: AppCtx, ledgerId: string, id: string): TagRow {
  const row = ctx.db
    .select(COLUMNS)
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.ledgerId, ledgerId)))
    .get();
  if (!row) throw HttpError.notFound('标签不存在');
  return row as TagRow;
}

export function createTag(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  input: { name: string; color?: string | null },
) {
  const dup = ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), eq(tags.name, input.name)))
    .get();
  if (dup) throw HttpError.duplicate('同名标签已存在');

  const maxRow = ctx.db
    .select({ m: sql<number>`coalesce(max(${tags.sortOrder}), 0)` })
    .from(tags)
    .where(eq(tags.ledgerId, ledgerId))
    .get();

  const total = ctx.db
    .select({ c: sql<number>`count(*)` })
    .from(tags)
    .where(eq(tags.ledgerId, ledgerId))
    .get();

  const id = newId(ID_PREFIX.tag);
  ctx.db
    .insert(tags)
    .values({
      id,
      ledgerId,
      name: input.name,
      color: input.color || TAG_COLORS[Number(total?.c ?? 0) % TAG_COLORS.length]!,
      sortOrder: Number(maxRow?.m ?? 0) + 1,
      useCount: 0,
      createdAt: nowIso(),
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'create',
    entityType: 'tag',
    entityId: id,
    summary: `新增标签「${input.name}」`,
  });
  return payload(requireTag(ctx, ledgerId, id), 0);
}

export function updateTag(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  tagId: string,
  input: { name?: string; color?: string | null },
) {
  const current = requireTag(ctx, ledgerId, tagId);
  if (input.name && input.name !== current.name) {
    const dup = ctx.db
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(eq(tags.ledgerId, ledgerId), eq(tags.name, input.name), sql`${tags.id} <> ${tagId}`),
      )
      .get();
    if (dup) throw HttpError.duplicate('同名标签已存在');
  }

  ctx.db
    .update(tags)
    .set({
      name: input.name ?? current.name,
      color: input.color === undefined || !input.color ? current.color : input.color,
    })
    .where(eq(tags.id, tagId))
    .run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'update',
    entityType: 'tag',
    entityId: tagId,
    summary: `更新标签「${input.name ?? current.name}」`,
  });
  return payload(requireTag(ctx, ledgerId, tagId), liveUsage(ctx, ledgerId).get(tagId) ?? 0);
}

export function deleteTag(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  tagId: string,
): { archived: true; useCount: number } {
  const current = requireTag(ctx, ledgerId, tagId);
  const useCount = liveUsage(ctx, ledgerId).get(tagId) ?? 0;

  ctx.db.update(tags).set({ archivedAt: nowIso() }).where(eq(tags.id, tagId)).run();

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'delete',
    entityType: 'tag',
    entityId: tagId,
    summary: `停用标签「${current.name}」${useCount > 0 ? `（已使用 ${useCount} 次，保留历史）` : ''}`,
    before: current,
  });
  return { archived: true, useCount };
}

export function reorderTags(ctx: AppCtx, ledgerId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const owned = ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), inArray(tags.id, ids)))
    .all();
  if (owned.length !== new Set(ids).size) throw HttpError.notFound('标签不存在');

  ctx.db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(tags).set({ sortOrder: index + 1 }).where(eq(tags.id, id)).run();
    });
  });
}

/** 校验标签集合都属于该账本（记账时使用，防跨账本引用） */
export function assertTagsInLedger(ctx: AppCtx, ledgerId: string, tagIds: string[]): void {
  if (tagIds.length === 0) return;
  const rows = ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.ledgerId, ledgerId), inArray(tags.id, tagIds)))
    .all();
  if (rows.length !== new Set(tagIds).size) throw HttpError.notFound('标签不存在');
}

/** 供其他模块引用（保持 transaction_tags 结构可见） */
export const TAG_LINK_TABLE = transactionTags;
