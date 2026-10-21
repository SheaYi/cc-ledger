# syntax=docker/dockerfile:1

# =====================================================================
#  CC记账 (cc-ledger) — 多阶段 Dockerfile
#  目标：镜像 ≤ 200MB / 非 root / 数据全在 /data 卷 / 重启即升级
# =====================================================================

# ============ Stage 1: deps（装全部依赖，用于编译）============
FROM node:22-alpine AS deps
WORKDIR /app

# better-sqlite3 是原生模块，Alpine(musl) 下必须在镜像内编译
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --include=dev


# ============ Stage 2: build（编译 TS + 裁剪为生产依赖）============
FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 编译 TypeScript
RUN npm run build

# 重新只装生产依赖（保留 better-sqlite3 的编译产物）
RUN npm ci --omit=dev && npm cache clean --force


# ============ Stage 3: runner（最小运行时）============
FROM node:22-alpine AS runner
WORKDIR /app

# 时区（影响周期账单与日期边界）
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata dumb-init curl && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

# 非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -u 1001 -S nodejs -G nodejs

# 数据目录（提前创建并授权，保证 named volume 首次挂载权限正确）
RUN mkdir -p /data/uploads/avatars /data/uploads/transactions /data/backups && \
    chown -R nodejs:nodejs /data

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DB_PATH=/data/cc-ledger.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups

COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/dist ./dist
COPY --from=build --chown=nodejs:nodejs /app/drizzle ./drizzle
COPY --from=build --chown=nodejs:nodejs /app/public ./public
COPY --from=build --chown=nodejs:nodejs /app/package.json ./

USER nodejs

EXPOSE 3000

# 健康检查：调用应用自身 /healthz（内部会验证 DB 可读）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
