import type { FastifyInstance } from 'fastify';
import { getMigrationStatus, type DbHandle } from '../../db/client.js';
import { APP_NAME } from '../../config/constants.js';
import type { Scheduler } from '../../scheduler/index.js';

export interface HealthDeps {
  dbHandle: DbHandle;
  version: string;
  startedAt: number;
  scheduler: Scheduler;
}

/**
 * GET /healthz
 * 数据库不可读时返回 503，供 Docker HEALTHCHECK 使用（docs/04 §17.1）。
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async (_req, reply) => {
    let connected = true;
    let error: string | undefined;
    try {
      deps.dbHandle.raw.prepare('SELECT 1').get();
    } catch (e) {
      connected = false;
      error = e instanceof Error ? e.message : String(e);
    }

    if (!connected) {
      return reply.code(503).send({
        status: 'error',
        app: APP_NAME,
        version: deps.version,
        database: { connected: false, error },
      });
    }

    const mig = getMigrationStatus(deps.dbHandle);
    return reply.code(200).send({
      status: 'ok',
      app: APP_NAME,
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      database: {
        connected: true,
        migrationsApplied: mig.applied,
        walMode: mig.walMode,
      },
      scheduler: {
        running: deps.scheduler.isRunning(),
        nextRun: deps.scheduler.nextRun(),
        tasks: deps.scheduler.tasks,
      },
    });
  });
}
