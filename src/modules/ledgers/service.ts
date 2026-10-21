/**
 * 账本服务（docs/04 §四）。
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { AppCtx } from '../../context.js';
import {
  accounts,
  budgets,
  categories,
  installmentPlans,
  ledgerInvitations,
  ledgerMembers,
  ledgers,
  reconciliationRecords,
  recurringRules,
  templates,
  transactions,
  users,
} from '../../db/schema.js';
import type { MemberRole } from '../../config/constants.js';
import { seedLedgerDefaults } from '../../db/seed.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { nowIso } from '../../utils/money.js';
import { generateInviteCode, isoAfterSeconds } from '../../utils/token.js';
import { sanitizeDisplayName } from '../../utils/validate.js';
import { writeAudit } from '../../utils/audit.js';
import { memberCount, type Membership } from './access.js';

export function ledgerPayload(ctx: AppCtx, m: Membership) {
  const row = ctx.db
    .select({ icon: ledgers.icon, note: ledgers.note })
    .from(ledgers)
    .where(eq(ledgers.id, m.ledgerId))
    .get();
  return {
    id: m.ledgerId,
    name: m.ledgerName,
    type: m.ledgerType,
    icon: row?.icon ?? '',
    note: row?.note ?? '',
    role: m.role,
    memberCount: memberCount(ctx, m.ledgerId),
    ownerId: m.ownerId,
    archivedAt: m.ledgerArchivedAt,
    joinedAt: m.joinedAt,
  };
}

/** 创建账本：写 ledgers + owner 成员 + 预置数据（docs/04 §4.2） */
export function createLedger(
  ctx: AppCtx,
  userId: string,
  input: { name: string; type: 'personal' | 'shared'; currency: string },
) {
  const at = nowIso();
  const id = newId(ID_PREFIX.ledger);

  const owned = Number(
    ctx.db
      .select({ c: sql<number>`count(*)` })
      .from(ledgerMembers)
      .where(eq(ledgerMembers.userId, userId))
      .get()?.c ?? 0,
  );

  ctx.db.transaction((tx) => {
    tx.insert(ledgers)
      .values({
        id,
        name: input.name,
        type: input.type,
        currency: input.currency,
        ownerId: userId,
        currentLedger: owned === 0,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    tx.insert(ledgerMembers)
      .values({
        id: newId(ID_PREFIX.ledgerMember),
        ledgerId: id,
        userId,
        role: 'owner',
        joinedAt: at,
      })
      .run();
  });

  seedLedgerDefaults(ctx.db, id, userId);
  writeAudit(ctx.db, {
    ledgerId: id,
    actorId: userId,
    action: 'create',
    entityType: 'ledger',
    entityId: id,
    summary: `创建账本「${input.name}」`,
    after: { name: input.name, type: input.type },
  });

  return ctx.db.select().from(ledgers).where(eq(ledgers.id, id)).get()!;
}

/**
 * 更新账本（owner / admin）。
 *
 * 允许改：名称 / 图标 / 备注 / 币种（币种保留给后续多币种）。
 *
 * ## 重名为什么在这里而不是前端拦
 * 前端只看到「我这一屏的账本」，而账本列表可能被归档过滤、也可能刚被别人改过。
 * 前端的重名提示只能算**提前反馈**，真正的唯一性必须由写入方保证 ——
 * 否则两次请求并发各改一个名字，库里就留下两本同名账。
 *
 * ## 重名的范围
 * 按**操作者可见的账本**去重，而不是全库唯一：
 * 两个互不相关的用户各有一本「家庭账」是完全正常的。
 * 比较时统一 `trim` 后比（中英文）。SQLite 的 UNIQUE 做不了
 * 「按 user 分区 + 忽略首尾空格」，所以走应用层。
 */
export function updateLedger(
  ctx: AppCtx,
  m: Membership,
  patch: { name?: string; currency?: string; icon?: string | null; note?: string | null },
) {
  if (patch.name !== undefined) {
    const taken = ctx.db
      .select({ id: ledgers.id })
      .from(ledgers)
      .innerJoin(ledgerMembers, and(eq(ledgerMembers.ledgerId, ledgers.id), eq(ledgerMembers.userId, m.userId)))
      .where(and(isNull(ledgers.archivedAt), ne(ledgers.id, m.ledgerId), eq(ledgers.name, patch.name.trim())))
      .get();
    if (taken) {
      throw HttpError.validation([{ field: 'name', message: '已经有同名账本了，换一个名字' }]);
    }
  }

  const before = { name: m.ledgerName, currency: undefined as string | undefined };
  const next: Record<string, string | null> = { updatedAt: nowIso() };
  /**
   * ⚠️ 名称必须过 `sanitizeDisplayName()` —— 前端那层只是即时反馈，
   *    接口可以绕过它直连。这里才是保证「库里不会有 < > / 控制字符」的地方。
   */
  if (patch.name !== undefined) next.name = sanitizeDisplayName(patch.name);
  if (patch.currency !== undefined) next.currency = patch.currency;
  // 图标名同样收口：只允许字母、数字、连字符，避免出现非法 lucide 名（会静默变问号图）
  if (patch.icon !== undefined) {
    next.icon = patch.icon ? String(patch.icon).trim().replace(/[^a-z0-9-]/gi, '') || null : null;
  }
  if (patch.note !== undefined) next.note = patch.note;

  ctx.db.update(ledgers).set(next).where(eq(ledgers.id, m.ledgerId)).run();
  writeAudit(ctx.db, {
    ledgerId: m.ledgerId,
    actorId: m.userId,
    action: 'update',
    entityType: 'ledger',
    entityId: m.ledgerId,
    summary: `更新账本信息`,
    before,
    after: patch,
  });
  return ctx.db.select().from(ledgers).where(eq(ledgers.id, m.ledgerId)).get()!;
}

/* ------------------------------------------------------------------ *
 * 删除账本
 * ------------------------------------------------------------------ */

/**
 * 删除前必须让用户看见**代价**。
 *
 * 「确认删除吗？」这种问法对账本是失职的：账本名下挂着一整局的账目、
 * 账户、分类、预算、成员关系。用户点确认时脑子里估算的那个数，
 * 和他实际会失去的东西往往差一两个数量级。
 *
 * 所以确认弹窗不写「确定吗」，而是先问服务端「这一删，会带走什么」，
 * 把**真实计数**摆在按钮上方。计数由这里统一出，前端不累加、不估算。
 */
export interface LedgerDeletionImpact {
  ledgerId: string;
  ledgerName: string;
  isCurrent: boolean;
  counts: {
    members: number;
    transactions: number;
    accounts: number;
    categories: number;
    budgets: number;
    recurring: number;
    installments: number;
    templates: number;
    invitations: number;
    reconciliations: number;
  };
  /** 删掉它之后，当前用户还剩几本账（0 表示这是最后一本，禁止删除） */
  remainingLedgers: number;
}

/**
 * 逐表统计「会被带走多少」。
 *
 * 每本账的实际体量差别极大（空壳账 vs 记了三年的账），
 * 写一张固定清单会让用户要么高估要么低估代价。
 *
 *<｜hy_place▁holder▁no▁813｜>意义 pulled out 为独立函数而不是塞进 `deletionImpact`：
 * 将来新增账本级表时，这里少一张表 = 用户看到的数量少一块，
 * 而**总数对不上**这种事没人会发现（它永远「看起来像对的」）。
 */
function ledgerRowCounts(ctx: AppCtx, ledgerId: string): LedgerDeletionImpact['counts'] {
  const entries: [keyof LedgerDeletionImpact['counts'], SQLiteTable & { ledgerId: AnySQLiteColumn }][] = [
    ['members', ledgerMembers],
    ['transactions', transactions],
    ['accounts', accounts],
    ['categories', categories],
    ['budgets', budgets],
    ['recurring', recurringRules],
    ['installments', installmentPlans],
    ['templates', templates],
    ['invitations', ledgerInvitations],
    ['reconciliations', reconciliationRecords],
  ];
  const out = {} as LedgerDeletionImpact['counts'];
  for (const [key, table] of entries) {
    out[key] = Number(
      ctx.db
        .select({ c: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.ledgerId, ledgerId))
      .get()?.c ?? 0,
    );
  }
  return out;
}

export function deletionImpact(ctx: AppCtx, m: Membership): LedgerDeletionImpact {
  const total = Number(
    ctx.db
      .select({ c: sql<number>`count(*)` })
      .from(ledgerMembers)
      .where(eq(ledgerMembers.userId, m.userId))
      .get()?.c ?? 0,
  );
  return {
    ledgerId: m.ledgerId,
    ledgerName: m.ledgerName,
    isCurrent: Boolean(
      ctx.db.select({ c: ledgers.currentLedger }).from(ledgers).where(eq(ledgers.id, m.ledgerId)).get()?.c,
    ),
    counts: ledgerRowCounts(ctx, m.ledgerId),
    remainingLedgers: Math.max(0, total - 1),
  };
}

/**
 * 物理删除账本：级联删掉它名下的一切（仅 owner）。
 *
 * ## 为什么不能只靠 `ledger_id` 上的 CASCADE
 * 账本**带数据**时，纯靠 `ledger_id` 级联删除会失败。根因是**账本内子表之间的外键**：
 * `transactions.account_id` / `category_id`、`budgets.from_category_id`、
 * `installment_plans.account_id`、`accounts.group_id` …… 这些指向 `accounts` /
 * `categories` / `account_groups` 的外键**没声明 onDelete**（SQLite 默认
 * NO ACTION，等价于 RESTRICT）。删账本时级联先删 `accounts`，但仍有交易/预算
 * 指向它 → `FOREIGN KEY constraint failed` → 删除 500、账本原封不动。
 * 空账本没有这些引用，所以「反而能删」—— 这正是「只有空账本能删」的来源。
 *
 * 因此这里**显式按依赖顺序**清数据：先断 `categories` 自引用（RESTRICT），
 * 再删所有「引用父表」的子表，最后删父表本身，账本行放最后
 * （此时子表已空，级联不会再受阻）。
 *
 * ## 为什么仍断言 `foreign_keys=ON`
 * 没开 pragma 时上面的显式删除虽能跑，但真正的完整性保障就没了；且将来一旦 schema
 * 里加了**不带 ledger_id** 的账本级表（极不可能，但防万一），不靠级联就会漏删留孤儿。
 * 所以关着就拒绝执行 —— 宁可删除失败，也不留残渣。
 *
 * ## 为什么不让它 Hash.deletedAt 软删
 * 账本不是账单。账单软删为「误删能找回」，账本删除动机通常是「这本连同它的一切都不该存在」。
 * 留副本等于留 guesswork；找回由导出/回收承担，不由库兜着。
 */
export function deleteLedger(ctx: AppCtx, m: Membership) {
  if (m.role !== 'owner') throw HttpError.forbidden('只有账本所有者可以删除账本');

  /**
   * ⚠️ `pragma foreign_keys` 返回的列名就是 **`foreign_keys`**（不是 `fk`）。
   *    写成 `fk.fk` 会永远拿到 `undefined` → 判定成「没开启」→ 删除被拒。
   */
  const fk = ctx.db.get<{ foreign_keys: number }>(sql.raw('pragma foreign_keys'));
  if (Number(fk?.foreign_keys ?? 0) !== 1) {
    throw HttpError.internal('级联删除不可用（未开启外键约束），已取消删除以免留下孤儿数据');
  }

  const impact = deletionImpact(ctx, m);
  if (impact.remainingLedgers === 0) {
    throw HttpError.business('至少保留一本账本，删除后你的账号将无处记账');
  }

  const before = {
    name: m.ledgerName,
    memberCount: impact.counts.members,
    transactionCount: impact.counts.transactions,
  };

  /**
   * 删的若是「当前账本」，得在删之前把成员名单抄下来 ——
   * `ledger_members` 会随账本一起被级联带走，删完就查不到谁需要切换了。
   */
  const memberIds = impact.isCurrent
    ? ctx.db
        .select({ userId: ledgerMembers.userId })
        .from(ledgerMembers)
        .where(eq(ledgerMembers.ledgerId, m.ledgerId))
        .all()
        .map((r) => r.userId)
    : [];

  ctx.db.transaction((tx) => {
    /**
     * 断 `categories` 自引用层级（ON DELETE RESTRICT），否则一次性删本账本分类会被
     * 父子关系卡住 → 同上的 FOREIGN KEY 失败。
     */
    tx.update(categories).set({ parentId: null }).where(eq(categories.ledgerId, m.ledgerId)).run();

    /** ① 先删所有「引用父表」的子表（及其它带 ledger_id 的表），顺序无关。 */
    for (const name of ledgerScopedTables(ctx.dbHandle.raw)) {
      if (LEDGER_DELETE_DEFERRED.has(name)) continue;
      tx.run(sql`DELETE FROM ${sql.identifier(name)} WHERE ledger_id = ${m.ledgerId}`);
    }

    /**
     * ② 再删父表，且**父表之间也要按顺序**：`accounts.group_id → account_groups`
     * 是 NO ACTION，所以 `account_groups` 必须排在 `accounts` 之后。
     */
    tx.run(sql`DELETE FROM ${sql.identifier('accounts')} WHERE ledger_id = ${m.ledgerId}`);
    tx.run(sql`DELETE FROM ${sql.identifier('account_groups')} WHERE ledger_id = ${m.ledgerId}`);
    tx.run(sql`DELETE FROM ${sql.identifier('categories')} WHERE ledger_id = ${m.ledgerId}`);

    /** ③ 最后删账本行本身（子表已空，级联不会再受阻）。 */
    tx.delete(ledgers).where(eq(ledgers.id, m.ledgerId)).run();

    /**
     * ④ 若删掉的是「当前账本」，给每位成员挑一本剩下的账顶上。
     *
     * 读侧 `currentLedgerId()` 本来就有 fallback（没有 current 就取最早一本），
     * 所以不补这步也不会记账失败。但那样库里的状态是自相矛盾的：
     * 没有任何一本账被标为「当前」，而 UI 卡片上的「当前账本」徽标会集体消失 ——
     * 用户删完一看，设置页里一本当前账本都没有，像是把账号删坏了。
     * 不可逆动作之后的状态应该是**自洽**的，不该靠读的时候兜回来。
     */
    for (const uid of memberIds) {
      const next = tx
        .select({ id: ledgers.id })
        .from(ledgerMembers)
        .innerJoin(ledgers, eq(ledgers.id, ledgerMembers.ledgerId))
        .where(and(eq(ledgerMembers.userId, uid), isNull(ledgers.archivedAt)))
        .orderBy(asc(ledgers.createdAt))
        .get();
      if (next) tx.update(ledgers).set({ currentLedger: true }).where(eq(ledgers.id, next.id)).run();
    }
  });

  writeAudit(ctx.db, {
    ledgerId: m.ledgerId,
    actorId: m.userId,
    action: 'delete',
    entityType: 'ledger',
    entityId: m.ledgerId,
    summary: `删除账本「${m.ledgerName}」（级联删除 ${impact.counts.transactions} 笔账目）`,
    before,
  });

  return { deleted: true, ...impact };
}

/**
 * 删除账本时**必须后删**的父表——它们被其它账本子表以 NO ACTION / RESTRICT 引用，
 * 必须等引用者先清掉。其中 `account_groups` 还被 `accounts.group_id` 引用，所以
 * 排在 `accounts` 之后。
 */
const LEDGER_DELETE_DEFERRED = new Set(['accounts', 'categories', 'account_groups', 'ledgers']);

/** 带 `ledger_id` 列的表（动态枚举，新增账本级表自动覆盖，不会漏删留孤儿）。 */
let cachedLedgerTables: string[] | null = null;
function ledgerScopedTables(raw: import('better-sqlite3').Database): string[] {
  if (cachedLedgerTables) return cachedLedgerTables;
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const rows = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as { name: string }[];
  const out: string[] = [];
  for (const r of rows) {
    const name = r.name;
    if (!NAME_RE.test(name)) continue;
    const has = raw
      .prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('${name}') WHERE name='ledger_id'`)
      .get() as { c: number } | undefined;
    if (Number(has?.c ?? 0) > 0) out.push(name);
  }
  cachedLedgerTables = out;
  return out;
}

/** 归档账本（仅 owner，docs/04 §4.4） */
export function archiveLedger(ctx: AppCtx, m: Membership): string {
  const at = nowIso();
  ctx.db.update(ledgers).set({ archivedAt: at, updatedAt: at }).where(eq(ledgers.id, m.ledgerId)).run();
  writeAudit(ctx.db, {
    ledgerId: m.ledgerId,
    actorId: m.userId,
    action: 'delete',
    entityType: 'ledger',
    entityId: m.ledgerId,
    summary: `归档账本「${m.ledgerName}」`,
  });
  return at;
}

/** 成员列表（docs/04 §4.5） */
export function listMembers(ctx: AppCtx, ledgerId: string) {
  const rows = ctx.db
    .select({
      userId: users.id,
      username: users.username,
      nickname: users.nickname,
      avatarPath: users.avatarPath,
      isActive: users.status,
      role: ledgerMembers.role,
      nicknameOverride: ledgerMembers.nicknameOverride,
      joinedAt: ledgerMembers.joinedAt,
    })
    .from(ledgerMembers)
    .innerJoin(users, eq(users.id, ledgerMembers.userId))
    .where(eq(ledgerMembers.ledgerId, ledgerId))
    .orderBy(asc(ledgerMembers.joinedAt))
    .all();

  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    nickname: r.nicknameOverride ?? r.nickname,
    avatarPath: r.avatarPath,
    role: r.role as MemberRole,
    nicknameOverride: r.nicknameOverride,
    joinedAt: r.joinedAt,
    isActive: r.isActive === 'active',
  }));
}

/** 变更成员角色（docs/02 §3.4 权限矩阵） */
export function changeMemberRole(
  ctx: AppCtx,
  actor: Membership,
  targetUserId: string,
  role: MemberRole,
): void {
  const target = ctx.db
    .select()
    .from(ledgerMembers)
    .where(and(eq(ledgerMembers.ledgerId, actor.ledgerId), eq(ledgerMembers.userId, targetUserId)))
    .get();
  if (!target) throw HttpError.notFound('该用户不是本账本成员');
  if (target.role === 'owner') throw HttpError.business('不能直接变更账本所有者的角色，请使用转让功能');
  if (role === 'owner') throw HttpError.business('请使用「转让所有权」接口变更 owner');
  if (target.role === role) return;

  // admin 不能管理其他 admin
  if (actor.role === 'admin' && target.role === 'admin') {
    throw HttpError.forbidden('管理员不能变更其他管理员的角色');
  }

  ctx.db.update(ledgerMembers).set({ role }).where(eq(ledgerMembers.id, target.id)).run();
  writeAudit(ctx.db, {
    ledgerId: actor.ledgerId,
    actorId: actor.userId,
    action: 'role_change',
    entityType: 'ledger_member',
    entityId: targetUserId,
    summary: `将成员角色由 ${target.role} 变更为 ${role}`,
    before: { role: target.role },
    after: { role },
  });
}

/** 移除成员 / 主动退出（docs/04 §4.5） */
export function removeMember(ctx: AppCtx, actor: Membership, targetUserId: string): void {
  const target = ctx.db
    .select()
    .from(ledgerMembers)
    .where(and(eq(ledgerMembers.ledgerId, actor.ledgerId), eq(ledgerMembers.userId, targetUserId)))
    .get();
  if (!target) throw HttpError.notFound('该用户不是本账本成员');

  // 先判权限，再判业务约束（保证越权返回 403 而非 400）
  const isSelf = actor.userId === targetUserId;
  if (!isSelf && actor.role === 'member') throw HttpError.forbidden('普通成员无权移除他人');
  if (!isSelf && actor.role === 'admin' && target.role === 'admin') {
    throw HttpError.forbidden('管理员不能移除其他管理员');
  }
  if (target.role === 'owner') {
    throw HttpError.business('账本所有者不能被移除，请先转让所有权');
  }

  ctx.db.delete(ledgerMembers).where(eq(ledgerMembers.id, target.id)).run();
  writeAudit(ctx.db, {
    ledgerId: actor.ledgerId,
    actorId: actor.userId,
    action: isSelf ? 'leave' : 'delete',
    entityType: 'ledger_member',
    entityId: targetUserId,
    summary: isSelf ? '退出账本' : '移除成员',
  });
}

/** 创建邀请码（docs/04 §4.6，排除易混字符，6 位） */
export function createInvitation(
  ctx: AppCtx,
  actor: Membership,
  input: { role: 'admin' | 'member'; maxUses: number; expiresInHours: number },
) {
  let code = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = generateInviteCode(6);
    const exists = ctx.db
      .select({ id: ledgerInvitations.id })
      .from(ledgerInvitations)
      .where(eq(ledgerInvitations.code, candidate))
      .get();
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) throw HttpError.internal('邀请码生成失败，请重试');

  const id = newId(ID_PREFIX.invitation);
  const at = nowIso();
  const expiresAt = isoAfterSeconds(Math.max(1, input.expiresInHours) * 3600);

  ctx.db
    .insert(ledgerInvitations)
    .values({
      id,
      ledgerId: actor.ledgerId,
      inviterId: actor.userId,
      code,
      role: input.role,
      maxUses: input.maxUses,
      usedCount: 0,
      expiresAt,
      createdAt: at,
    })
    .run();

  writeAudit(ctx.db, {
    ledgerId: actor.ledgerId,
    actorId: actor.userId,
    action: 'invite',
    entityType: 'ledger_invitation',
    entityId: id,
    summary: `生成邀请码 ${code}（角色 ${input.role}，可用 ${input.maxUses} 次）`,
  });

  return { id, code, expiresAt, maxUses: input.maxUses, usedCount: 0, role: input.role };
}

function findInvitation(ctx: AppCtx, code: string) {
  const normalized = code.trim().toUpperCase();
  const inv = ctx.db
    .select()
    .from(ledgerInvitations)
    .where(eq(ledgerInvitations.code, normalized))
    .get();
  if (!inv) throw HttpError.notFound('邀请码不存在');
  return inv;
}

function inviteState(inv: { revokedAt: string | null; expiresAt: string; maxUses: number; usedCount: number }) {
  const now = nowIso();
  if (inv.revokedAt) return { valid: false, reason: 'revoked' as const };
  if (inv.expiresAt < now) return { valid: false, reason: 'expired' as const };
  if (inv.maxUses > 0 && inv.usedCount >= inv.maxUses) {
    return { valid: false, reason: 'exhausted' as const };
  }
  return { valid: true, reason: null };
}

/** 邀请预览（公开接口，未登录可访问） */
export function previewInvitation(ctx: AppCtx, code: string) {
  const inv = findInvitation(ctx, code);
  const state = inviteState(inv);
  const ledger = ctx.db.select().from(ledgers).where(eq(ledgers.id, inv.ledgerId)).get();
  const inviter = ctx.db.select().from(users).where(eq(users.id, inv.inviterId)).get();

  return {
    code: inv.code,
    valid: state.valid,
    reason: state.reason,
    ledger: ledger ? { id: ledger.id, name: ledger.name, type: ledger.type } : null,
    inviter: inviter ? { id: inviter.id, nickname: inviter.nickname, avatarPath: inviter.avatarPath } : null,
    role: inv.role as MemberRole,
    expiresAt: inv.expiresAt,
    maxUses: inv.maxUses,
    usedCount: inv.usedCount,
    remainingUses: inv.maxUses > 0 ? Math.max(0, inv.maxUses - inv.usedCount) : null,
    memberCount: ledger ? memberCount(ctx, ledger.id) : 0,
  };
}

/** 兑换邀请码（docs/04 §4.6；已加入时幂等返回） */
export function redeemInvitation(ctx: AppCtx, userId: string, code: string) {
  const inv = findInvitation(ctx, code);

  const ledger = ctx.db.select().from(ledgers).where(eq(ledgers.id, inv.ledgerId)).get();
  if (!ledger) throw HttpError.notFound('账本不存在');

  // 幂等优先：已是成员则直接返回，不受邀请码是否过期/用尽影响
  const existing = ctx.db
    .select()
    .from(ledgerMembers)
    .where(and(eq(ledgerMembers.ledgerId, inv.ledgerId), eq(ledgerMembers.userId, userId)))
    .get();

  if (existing) {
    activateLedgerFor(ctx, userId, inv.ledgerId);
    return {
      alreadyMember: true,
      ledger: { id: ledger.id, name: ledger.name, type: ledger.type },
      role: existing.role as MemberRole,
      joinedAt: existing.joinedAt,
      memberCount: memberCount(ctx, ledger.id),
      currentLedgerId: inv.ledgerId,
    };
  }

  const state = inviteState(inv);
  if (!state.valid) {
    const msg =
      state.reason === 'expired'
        ? '邀请码已过期'
        : state.reason === 'exhausted'
          ? '邀请码使用次数已达上限'
          : '邀请码已被撤销';
    throw HttpError.business(msg);
  }
  if (ledger.archivedAt) throw HttpError.business('该账本已归档，无法加入');

  const at = nowIso();
  ctx.db.transaction((tx) => {
    tx.insert(ledgerMembers)
      .values({
        id: newId(ID_PREFIX.ledgerMember),
        ledgerId: inv.ledgerId,
        userId,
        role: inv.role,
        joinedAt: at,
      })
      .run();
    tx.update(ledgerInvitations)
      .set({ usedCount: inv.usedCount + 1 })
      .where(eq(ledgerInvitations.id, inv.id))
      .run();
    // 加入后自动切换为当前账本（仅影响本人可访问的账本）
    tx.run(
      sql`update ${ledgers} set current_ledger = 0
          where id in (select ledger_id from ${ledgerMembers} where user_id = ${userId})`,
    );
    tx.update(ledgers).set({ currentLedger: true }).where(eq(ledgers.id, inv.ledgerId)).run();
  });

  writeAudit(ctx.db, {
    ledgerId: inv.ledgerId,
    actorId: userId,
    action: 'join',
    entityType: 'ledger_member',
    entityId: userId,
    summary: `通过邀请码加入账本，角色 ${inv.role}`,
  });

  return {
    alreadyMember: false,
    ledger: { id: ledger.id, name: ledger.name, type: ledger.type },
    role: inv.role as MemberRole,
    joinedAt: at,
    memberCount: memberCount(ctx, ledger.id),
    currentLedgerId: ledger.id as string | null,
  };
}

/** 切换当前账本（内部使用，仅影响该用户可访问的账本） */
function activateLedgerFor(ctx: AppCtx, userId: string, ledgerId: string): void {
  ctx.db.transaction((tx) => {
    tx.run(
      sql`update ${ledgers} set current_ledger = 0
          where id in (select ledger_id from ${ledgerMembers} where user_id = ${userId})`,
    );
    tx.update(ledgers).set({ currentLedger: true }).where(eq(ledgers.id, ledgerId)).run();
  });
}

/** 转让所有权：新 owner 必须是当前成员；操作者降级为 admin（docs/04 §4.7） */
export function transferOwnership(ctx: AppCtx, actor: Membership, newOwnerId: string): void {
  const target = ctx.db
    .select()
    .from(ledgerMembers)
    .where(and(eq(ledgerMembers.ledgerId, actor.ledgerId), eq(ledgerMembers.userId, newOwnerId)))
    .get();
  if (!target) throw HttpError.business('新所有者必须是当前账本成员');
  if (target.userId === actor.userId) throw HttpError.business('不能转让给自己');

  const at = nowIso();
  ctx.db.transaction((tx) => {
    tx.update(ledgerMembers).set({ role: 'admin' }).where(eq(ledgerMembers.id, actor.membershipId)).run();
    tx.update(ledgerMembers).set({ role: 'owner' }).where(eq(ledgerMembers.id, target.id)).run();
    tx.update(ledgers).set({ ownerId: newOwnerId, updatedAt: at }).where(eq(ledgers.id, actor.ledgerId)).run();
  });

  writeAudit(ctx.db, {
    ledgerId: actor.ledgerId,
    actorId: actor.userId,
    action: 'transfer',
    entityType: 'ledger',
    entityId: actor.ledgerId,
    summary: `转让账本所有权给 ${target.userId}`,
    before: { ownerId: actor.userId },
    after: { ownerId: newOwnerId },
  });
}

/** 待处理邀请列表（owner/admin 可见） */
export function listInvitations(ctx: AppCtx, ledgerId: string) {
  return ctx.db
    .select()
    .from(ledgerInvitations)
    .where(and(eq(ledgerInvitations.ledgerId, ledgerId), isNull(ledgerInvitations.revokedAt)))
    .orderBy(asc(ledgerInvitations.createdAt))
    .all()
    .map((i) => ({
      id: i.id,
      code: i.code,
      role: i.role as MemberRole,
      maxUses: i.maxUses,
      usedCount: i.usedCount,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      valid: inviteState(i).valid,
    }));
}
