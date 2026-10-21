/**
 * 用户服务（docs/04 §三）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Jimp } from 'jimp';
import type { AppCtx } from '../../context.js';
import { ledgerMembers, ledgers, users } from '../../db/schema.js';
import type { MemberRole } from '../../config/constants.js';
import { LIMITS } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { nowIso } from '../../utils/money.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { revokeSessions } from '../auth/service.js';

export interface LedgerSummary {
  id: string;
  name: string;
  type: string;
  /** lucide 图标名；空串表示「用户没挑过」，前端按类型回退默认图标 */
  icon: string;
  note: string;
  role: MemberRole;
  memberCount: number;
  isCurrent: boolean;
  archivedAt: string | null;
}

/** 当前用户可见的账本列表（按其成员身份） */
export function listUserLedgers(
  ctx: AppCtx,
  userId: string,
  includeArchived = false,
): LedgerSummary[] {
  const rows = ctx.db
    .select({
      id: ledgers.id,
      name: ledgers.name,
      type: ledgers.type,
      icon: ledgers.icon,
      note: ledgers.note,
      role: ledgerMembers.role,
      currentLedger: ledgers.currentLedger,
      ownerId: ledgers.ownerId,
      archivedAt: ledgers.archivedAt,
      memberCount: sql<number>`(select count(*) from ${ledgerMembers} lm2 where lm2.ledger_id = ${ledgers.id})`,
    })
    .from(ledgerMembers)
    .innerJoin(ledgers, eq(ledgers.id, ledgerMembers.ledgerId))
    .where(
      includeArchived
        ? eq(ledgerMembers.userId, userId)
        : and(eq(ledgerMembers.userId, userId), isNull(ledgers.archivedAt)),
    )
    .orderBy(ledgers.createdAt)
    .all();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    // 可空列：这里一律收成字符串，前端不必再判 null。语义与 DB 一致 —— 空串 = 没设过。
    icon: r.icon ?? '',
    note: r.note ?? '',
    role: r.role as MemberRole,
    memberCount: Number(r.memberCount),
    isCurrent: r.currentLedger,
    archivedAt: r.archivedAt,
  }));
}

/** 当前选中账本 ID（个人账本默认，协作账本以 current_ledger=1 标记） */
export function currentLedgerId(ctx: AppCtx, userId: string): string | null {
  const row = ctx.db
    .select({ id: ledgers.id })
    .from(ledgerMembers)
    .innerJoin(ledgers, eq(ledgers.id, ledgerMembers.ledgerId))
    .where(
      and(
        eq(ledgerMembers.userId, userId),
        eq(ledgers.currentLedger, true),
        isNull(ledgers.archivedAt),
      ),
    )
    .get();
  if (row) return row.id;

  const first = ctx.db
    .select({ id: ledgers.id })
    .from(ledgerMembers)
    .innerJoin(ledgers, eq(ledgers.id, ledgerMembers.ledgerId))
    .where(and(eq(ledgerMembers.userId, userId), isNull(ledgers.archivedAt)))
    .orderBy(ledgers.createdAt)
    .get();
  return first?.id ?? null;
}

/** 切换当前账本（需是该账本成员），只影响本人可访问的账本 */
export function activateLedger(ctx: AppCtx, userId: string, ledgerId: string): void {
  const member = ctx.db
    .select({ id: ledgerMembers.id })
    .from(ledgerMembers)
    .where(and(eq(ledgerMembers.userId, userId), eq(ledgerMembers.ledgerId, ledgerId)))
    .get();
  if (!member) throw HttpError.notFound('账本不存在');

  ctx.db.transaction((tx) => {
    tx.run(
      sql`update ${ledgers} set current_ledger = 0
          where id in (select ledger_id from ${ledgerMembers} where user_id = ${userId})`,
    );
    tx.update(ledgers).set({ currentLedger: true }).where(eq(ledgers.id, ledgerId)).run();
  });
}

/** 更新资料 */
export function updateProfile(
  ctx: AppCtx,
  userId: string,
  patch: { nickname?: string; email?: string | null; phone?: string | null },
) {
  const current = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!current) throw HttpError.notFound('用户不存在');

  const next = {
    nickname: patch.nickname ?? current.nickname,
    email: patch.email === undefined ? current.email : patch.email,
    phone: patch.phone === undefined ? current.phone : patch.phone,
    updatedAt: nowIso(),
  };

  if (next.email && next.email !== current.email) {
    const dup = ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, next.email))
      .get();
    if (dup) throw HttpError.duplicate('邮箱已被其他账号使用');
  }
  if (next.phone && next.phone !== current.phone) {
    const dup = ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, next.phone))
      .get();
    if (dup) throw HttpError.duplicate('手机号已被其他账号使用');
  }

  ctx.db.update(users).set(next).where(eq(users.id, userId)).run();
  return ctx.db.select().from(users).where(eq(users.id, userId)).get()!;
}

/** 修改密码：校验旧密码 → 写入新哈希 → 吊销全部 refresh token（docs/04 §3.3） */
export async function changePassword(
  ctx: AppCtx,
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<number> {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw HttpError.notFound('用户不存在');

  const valid = await verifyPassword(user.passwordHash, oldPassword);
  if (!valid) throw HttpError.unauthorized('原密码不正确');

  const hash = await hashPassword(newPassword);
  ctx.db
    .update(users)
    .set({ passwordHash: hash, updatedAt: nowIso() })
    .where(eq(users.id, userId))
    .run();

  return revokeSessions(ctx, userId, { allDevices: true });
}

export const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const AVATAR_SIZE = 512;

export interface AvatarResult {
  avatarPath: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/**
 * 头像上传：校验类型/体积 → 裁剪为 512×512 正方形 → 存 /data/uploads/avatars/{userId}.png
 * （docs/04 §3.4）。转码失败时保留原文件（ext 依据 MIME），不阻断用户。
 */
export async function saveAvatar(
  ctx: AppCtx,
  userId: string,
  file: { buffer: Buffer; mimetype: string; filename: string },
): Promise<AvatarResult> {
  if (!AVATAR_MIME.has(file.mimetype)) {
    throw HttpError.validation([
      { field: 'file', message: '仅支持 JPEG / PNG / WebP 格式' },
    ]);
  }
  if (file.buffer.byteLength > LIMITS.AVATAR_MAX_BYTES) {
    throw HttpError.payloadTooLarge(`头像不得超过 ${LIMITS.AVATAR_MAX_BYTES / 1024 / 1024} MB`);
  }
  if (file.buffer.byteLength === 0) {
    throw HttpError.validation([{ field: 'file', message: '文件内容为空' }]);
  }

  const dir = path.join(ctx.env.UPLOAD_DIR, 'avatars');
  fs.mkdirSync(dir, { recursive: true });

  let outBuffer: Buffer;
  let ext: string;
  try {
    const image = await Jimp.read(file.buffer);
    image.cover({ w: AVATAR_SIZE, h: AVATAR_SIZE });
    outBuffer = await image.getBuffer('image/png');
    ext = 'png';
  } catch {
    outBuffer = file.buffer;
    ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  }

  const absPath = path.join(dir, `${userId}.${ext}`);
  // 清理同名的历史不同扩展名文件
  for (const old of ['png', 'jpg', 'webp']) {
    const p = path.join(dir, `${userId}.${old}`);
    if (p !== absPath && fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.writeFileSync(absPath, outBuffer);

  const avatarPath = `/uploads/avatars/${userId}.${ext}`;
  ctx.db
    .update(users)
    .set({ avatarPath, updatedAt: nowIso() })
    .where(eq(users.id, userId))
    .run();

  return { avatarPath, sizeBytes: outBuffer.byteLength, width: AVATAR_SIZE, height: AVATAR_SIZE };
}
