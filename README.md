# CC记账（cc-ledger）

Docker 化的多人协作记账系统。技术栈：Node 22 + TypeScript 5 + Fastify 5 + Drizzle ORM + better-sqlite3。

---

## 当前进度

| 节点 | 范围 | 状态 |
|---|---|---|
| ① | 项目骨架 + Docker 化（`/healthz`、优雅退出） | ✅ 完成 |
| ② | 数据模型 21 表 + 迁移 + 预置数据（6 分组 / 3 虚拟账户 / 22 主类 / 106 子类 / 8 标签 / 8 模板） | ✅ 完成 |
| ③ | 认证与用户体系 + 账本协作（注册 / 登录 / 令牌轮换 / 资料 / 头像 / 邀请码） | ✅ 完成 |
| ④ | 账户 · 分类 · 标签 · 对账 | ⏳ 待开始 |
| ⑤ | 账单核心（6 种记录类型 + 金额计算规约） | ⏳ |
| ⑥ | 模板 · 周期账单 · 分期 | ⏳ |
| ⑦ | 统计 · 预算 · 导入 · 附件 · 搜索 | ⏳ |
| ⑧ | PWA 完善 · 镜像构建 · NAS 部署 | ⏳ |

---

## 快速开始（本地开发）

```bash
# 1. 安装依赖
npm install

# 2. 准备环境变量
cp .env.example .env
# 生产务必替换 JWT_SECRET： openssl rand -base64 48

# 3. 生成迁移文件（Schema 变更后执行）
npm run db:generate

# 4. 执行迁移
npm run db:migrate

# 5. 启动开发服务器
npm run dev
```

访问：

- 应用 <http://localhost:3000>（首次进入会跳转登录页，可直接点「创建账号」）
- 健康检查 <http://localhost:3000/healthz>

> 开发期如果反复注册测试账号被限流（默认 3 次/小时/IP），把 `.env` 里的
> `RATE_LIMIT_REGISTER_MAX` / `RATE_LIMIT_LOGIN_MAX` 调大即可。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（tsx watch） |
| `npm run build` | 编译 TypeScript → `dist/` |
| `npm start` | 生产启动 |
| `npm run db:generate` | 由 Schema 生成迁移文件 |
| `npm run db:migrate` | 执行未完成的迁移 |
| `npm run db:seed` | 为开发账本写入预置数据（幂等，可选） |
| `npm run typecheck` | 类型检查 |
| `npm test` | 单元 + 集成测试（vitest） |
| `npm run smoke` | 端到端冒烟测试（需先启动服务） |

## 已实现的 API

Base URL：`/api/v1`；除公开接口外均需 `Authorization: Bearer <access_token>`。

| 模块 | 端点 |
|---|---|
| 认证 | `POST /auth/register`、`POST /auth/login`、`POST /auth/refresh`（令牌轮换）、`POST /auth/logout` |
| 用户 | `GET /users/me`、`PATCH /users/me`、`PATCH /users/me/password`、`POST /users/me/avatar`、`POST /users/me/current-ledger` |
| 账本 | `GET/POST /ledgers`、`GET/PATCH/DELETE /ledgers/:id` |
| 成员 | `GET /ledgers/:id/members`、`POST /ledgers/:id/members/:userId/role`、`DELETE /ledgers/:id/members/:userId` |
| 邀请 | `POST/GET /ledgers/:id/invitations`、`GET /invitations/:code`（公开预览）、`POST /invitations/:code/redeem` |
| 转让 | `POST /ledgers/:id/transfer-ownership` |

响应结构、错误码、限流策略严格对齐 `docs/04-API接口设计.md`。

## Docker 部署

### 方式一：直接拉镜像（推荐，主机上无需编译）

每次推送到 `main`，GitHub Actions 会自动构建并推送镜像到 ghcr：

```bash
echo 'CC_IMAGE=ghcr.io/shayi/cc-ledger:latest' >> .env   # 用现成镜像
docker compose pull
docker compose up -d
```

升级：`docker compose pull && docker compose up -d`（数据在 `data/`，不受影响）。
镜像私有，需先 `docker login ghcr.io -u SheaYi`（token 勾 `read:packages`），
或在 GitHub → Packages → Package settings 里把可见性改成 Public。

### 方式二：本地构建

```bash
cp .env.example .env      # 填 JWT_SECRET 与 PUBLIC_BASE_URL
docker compose up -d --build
docker compose logs -f
```

- 端口：`3000`
- 数据目录：宿主 `./data`（可用 `.env` 的 `DATA_HOST_DIR` 指定绝对路径）→ 容器内 `/data`
  - NAS 上即 `/volume1/docker/cc-ledger/data`，在「文件管理」里直接可见
  - ⚠️ 容器以 uid 1001 运行，宿主目录必须先 `sudo chown -R 1001:1001 data`
- 容器内目录：`/data/cc-ledger.db`（主库）、`/data/uploads`（头像/附件）、`/data/backups`（每日备份）

> ⚠️ `PUBLIC_BASE_URL` 必须改成 NAS 的实际访问地址（如 `http://192.168.0.10:3000`），
> 否则生成的邀请链接会指向 localhost。
>
> 绿联 DXP4800 的详细步骤见 [`DEPLOY-绿联NAS.md`](./DEPLOY-绿联NAS.md)。

### 备份与恢复

```bash
# 备份（停 5 秒，整目录打包 —— 保证 SQLite 一致性）
docker compose stop
sudo tar czf cc-ledger-$(date +%Y%m%d).tar.gz -C ./data .
docker compose start
```

```bash
# 恢复
docker compose stop
sudo rm -f ./data/cc-ledger.db-wal ./data/cc-ledger.db-shm
sudo tar xzf cc-ledger-20261022.tar.gz -C ./data
sudo chown -R 1001:1001 ./data
docker compose start
```

## 数据模型

21 张表，金额一律 INTEGER（单位「分」）。详见 `docs/02-数据模型设计.md`。

## 目录结构

```
src/
├── main.ts              启动入口（环境校验 → 目录 → DB → 迁移 → 调度 → HTTP）
├── app.ts               Fastify 实例（错误处理 / CORS / 限流 / 上传 / 静态 / SPA 回退）
├── context.ts           业务模块共享上下文（env / db / startedAt）
├── config/              env（Zod 校验）、constants（枚举字典）
├── db/                  client（PRAGMA）、migrate、schema（21 表）、seed、seed-data
├── plugins/             auth（JWT + requireAuth）、error-handler（统一响应包装）
├── modules/
│   ├── health/          /healthz
│   ├── auth/            注册 / 登录 / 刷新 / 登出
│   ├── users/           资料 / 改密 / 头像
│   └── ledgers/         账本 / 成员 / 邀请 / 权限（access.ts）
├── scheduler/           node-cron 定时任务
└── utils/               id（ULID）、money（整数分）、password（argon2id）、token、validate、errors、audit
drizzle/                 迁移文件（只增不改）
public/                  前端静态资源（原生 ES Module，无构建步骤）
├── index.html
└── assets/
    ├── tokens.css       设计令牌（唯一来源 docs/00-DESIGN.md，组件层不写死 hex）
    ├── app.css          组件层（排版阶梯 / 图块系统 / 按钮两套语法 / footer / tabbar）
    ├── chrome.js        页面骨架：global-nav / sub-nav-frosted / footer / 底部 TabBar
    ├── ui.js            DOM 工具 + 图标集
    ├── api.js / store.js
    └── views/           auth（图块节奏）/ home（store 模式）/ invite（quote 图块）
scripts/                 端到端冒烟脚本
tests/                   单元 + 集成测试
```

## 安全说明

- 密码：**argon2id**（`@node-rs/argon2`，参数 m=19456 / t=2 / p=1）。原生模块不可用时自动降级 scrypt，格式自描述可平滑升级。
- 令牌：access JWT 15 分钟；refresh 为不透明随机串，**数据库只存 SHA-256 哈希**，刷新即轮换、旧令牌立刻失效；改密 / 登出即批量吊销。
- 数据隔离：所有账本数据查询强制注入 `ledger_id`；跨账本访问返回 **404** 而非 403，避免泄露资源存在性。
- 上传：头像 ≤2 MB（JPEG/PNG/WebP），服务端裁剪为 512×512；`/uploads/*` 由 `@fastify/static` 提供并自带路径穿越防护。
- 限流：登录 5 次/分钟/IP、注册 3 次/小时/IP，可用环境变量调整。
