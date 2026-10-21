/**
 * 操作审计日志（docs/02 §3.6）。
 * 所有涉及账本数据变更的动作都写一条 ledger_logs，保证"每笔变更有据可查"。
 */
import type { Db } from '../db/client.js';
import { ledgerLogs } from '../db/schema.js';
import { newId, ID_PREFIX } from './id.js';
import { nowIso } from './money.js';

export interface AuditInput {
  ledgerId: string;
  actorId: string;
  action:
    | 'create'
    | 'update'
    | 'delete'
    | 'invite'
    | 'join'
    | 'leave'
    | 'role_change'
    | 'reconcile'
    | 'close_period'
    | 'reopen_period'
    | 'import'
    | 'transfer';
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  before?: unknown;
  after?: unknown;
}

export function writeAudit(db: Db, input: AuditInput): void {
  db.insert(ledgerLogs)
    .values({
      id: newId(ID_PREFIX.ledgerLog),
      ledgerId: input.ledgerId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary ?? null,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
      createdAt: nowIso(),
    })
    .run();
}
