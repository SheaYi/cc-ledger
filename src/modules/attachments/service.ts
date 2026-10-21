/**
 * 账单附件（`docs/04 §8.8` / §18.4）。
 *
 * ## 存在的理由
 *
 * 记账里最常见的「事后补证据」场景：退票截图、合同、发票、活动二维码。
 * 移动端则是**拍照直接上传**（`docs/09 §18.4`）。
 *
 * ## 文件落在磁盘、库里只存元信息
 *
 * `attachments` 表只记 `file_path / file_name / mime_type / size_bytes`，
 * 二进制不进 SQLite —— 一个 10MB 的 BLOB 塞进去会拖垮所有 `SELECT *`。
 * 文件名**不由客户端决定**：一律用 `{attachmentId}.{ext}` 落盘，
 * 客户端传来的原始名只作为展示用的 `file_name` 存库。
 * 理由：客户端名可能含 `../`、可能超长、可能没有扩展名，直接用它拼路径
 * 就是一次路径穿越。用服务端生成的 id 拼路径，穿越在原理上就不成立。
 *
 * ## 删除语义**沿用既有决策**，不在这里另发明一套
 *
 * `transactions/service.ts` 的 `permanentDelete` 早就定好了：「账单还有附件 →
 * 拒绝永久删除，请先删除附件」。所以账单被真正删掉时它必然已经没有附件行，
 * `ON DELETE CASCADE` 也就没有文件会残留在磁盘上。
 * 本模块只负责「删附件时把文件一起清掉」。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { attachments, transactions } from '../../db/schema.js';
import { LIMITS } from '../../config/constants.js';
import { HttpError } from '../../utils/errors.js';
import { newId, ID_PREFIX } from '../../utils/id.js';
import { nowIso } from '../../utils/money.js';

/** 允许的 MIME → 落盘扩展名。**白名单**，不做「按客户端给的类型猜」。 */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

export interface AttachmentDto {
  id: string;
  transactionId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sizeText: string;
  url: string;
  uploaderId: string;
  createdAt: string;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function listAttachments(ctx: AppCtx, ledgerId: string, transactionId: string): AttachmentDto[] {
  const tx = ctx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.ledgerId, ledgerId), eq(transactions.id, transactionId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');

  const rows = ctx.db
    .select()
    .from(attachments)
    .where(eq(attachments.transactionId, transactionId))
    .orderBy(desc(attachments.createdAt))
    .all();

  return rows.map((a) => toDto(a.filePath, a.id, a.transactionId, a.fileName, a.mimeType, a.sizeBytes, a.uploaderId, a.createdAt));
}

function toDto(
  filePath: string,
  id: string,
  transactionId: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number,
  uploaderId: string,
  createdAt: string,
): AttachmentDto {
  return {
    id,
    transactionId,
    fileName,
    mimeType,
    sizeBytes,
    sizeText: humanSize(sizeBytes),
    url: `/uploads/${filePath.replace(/^[\\/]+/, '').split(path.sep).join('/')}`,
    uploaderId,
    createdAt,
  };
}

export interface SaveInput {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

export function saveAttachment(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  transactionId: string,
  input: SaveInput,
): AttachmentDto {
  const tx = ctx.db
    .select({ id: transactions.id, deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(and(eq(transactions.ledgerId, ledgerId), eq(transactions.id, transactionId)))
    .get();
  if (!tx) throw HttpError.notFound('账单不存在');
  if (tx.deletedAt) throw HttpError.business('账单在回收站里，恢复后才能继续添加附件');

  const ext = MIME_EXT[input.mimetype];
  if (!ext) {
    throw HttpError.validation([
      { field: 'file', message: `不支持的文件类型 ${input.mimetype}（可用：${Object.keys(MIME_EXT).join(' / ')}）` },
    ]);
  }
  if (input.buffer.byteLength === 0) {
    throw HttpError.validation([{ field: 'file', message: '文件内容为空' }]);
  }
  if (input.buffer.byteLength > LIMITS.ATTACHMENT_MAX_BYTES) {
    throw HttpError.payloadTooLarge(`单个附件不得超过 ${LIMITS.ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
  }

  const id = newId(ID_PREFIX.attachment);
  const dir = path.join(ctx.env.UPLOAD_DIR, 'attachments');
  mkdirSync(dir, { recursive: true });

  /**
   * 文件名**由服务端生成**：`{id}.{ext}`。
   * 客户端名只进 `file_name` 字段做展示，绝不参与路径拼接 ——
   * `../../etc/passwd` 这种名字在拼接路径时就是一次目录穿越。
   */
  const storedName = `${id}.${ext}`;
  const filePath = `attachments/${storedName}`;
  writeFileSync(path.join(dir, storedName), input.buffer);

  const displayName = (input.filename || storedName).slice(0, 200);
  const at = nowIso();
  ctx.db
    .insert(attachments)
    .values({
      id,
      ledgerId,
      transactionId,
      filePath,
      fileName: displayName,
      mimeType: input.mimetype,
      sizeBytes: input.buffer.byteLength,
      uploaderId: actorId,
      createdAt: at,
    })
    .run();

  return toDto(filePath, id, transactionId, displayName, input.mimetype, input.buffer.byteLength, actorId, at);
}

/**
 * 软删（进回收站）：只删库里的行，**文件留在磁盘上**。
 *
 * ## 为什么这里没有「物理清理文件」的函数
 *
 * 因为删除路径**已经由 `transactions/service.ts` 的 `permanentDelete` 定好了**：
 * 「账单还有附件 → 拒绝永久删除，请先删除附件」。于是账单被真正删掉时，
 * 它必然已经没有附件行，`ON DELETE CASCADE` 也就没有文件可留 ——
 * 磁盘上不会产生孤儿文件。
 *
 * 早先本模块想自己加一个「删账单时顺带清文件」，那是**重复实现同一条删除语义**，
 * 而且会绕过上面那道拦截（用户连「先删附件」的机会都没有了）。
 * 写一个永不调用的导出比不写更糟：后来者会以为它有用。
 */
export function removeAttachment(ctx: AppCtx, ledgerId: string, id: string): { id: string } {
  const row = ctx.db
    .select()
    .from(attachments)
    .where(and(eq(attachments.ledgerId, ledgerId), eq(attachments.id, id)))
    .get();
  if (!row) throw HttpError.notFound('附件不存在');
  ctx.db.delete(attachments).where(eq(attachments.id, id)).run();
  /** 库行没了，文件就是孤儿 —— 这时它已经没有主人才有资格被删 */
  const abs = path.join(ctx.env.UPLOAD_DIR, row.filePath);
  if (existsSync(abs)) {
    try {
      unlinkSync(abs);
    } catch {
      /* 删不掉就留着：宁可残留一个孤儿文件，也不要让「删除附件」失败 */
    }
  }
  return { id };
}
