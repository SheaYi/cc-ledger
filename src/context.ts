import type { Env } from './config/env.js';
import type { DbHandle, Db } from './db/client.js';

/** 各业务模块共享的运行上下文 */
export interface AppCtx {
  env: Env;
  dbHandle: DbHandle;
  /** 便捷引用：dbHandle.db */
  db: Db;
  startedAt: number;
}
