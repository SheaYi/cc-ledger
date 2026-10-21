import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  raw: Database.Database;
  db: Db;
  close(): void;
}

/**
 * 打开 SQLite 连接并应用强制 PRAGMA（docs/02 第二节）。
 */
export function openDatabase(dbPath: string): DbHandle {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const raw = new Database(resolved);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('temp_store = MEMORY');
  raw.pragma('cache_size = -20000');

  const db = drizzle(raw, { schema });
  return { raw, db, close: () => raw.close() };
}

export interface MigrationStatus {
  applied: number;
  walMode: boolean;
  journalMode: string;
}

/** 读取迁移状态与 WAL 模式（供 /healthz 使用） */
export function getMigrationStatus(handle: DbHandle): MigrationStatus {
  let applied = 0;
  try {
    const row = handle.raw
      .prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations')
      .get() as { c?: number } | undefined;
    applied = row?.c ?? 0;
  } catch {
    applied = 0; // 迁移表尚未创建
  }
  const journal = String(handle.raw.pragma('journal_mode', { simple: true })).toLowerCase();
  return { applied, walMode: journal === 'wal', journalMode: journal };
}
