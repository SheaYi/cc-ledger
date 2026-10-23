# 更新日志

版本号遵循语义化版本（SemVer）：主版本.次版本.修订号。
打 `v*` tag 时 GitHub Actions 会产出同名的固定版本镜像（如 `v1.1.0`），
推 `main` 时产出 `latest` 与 `sha-xxxxxxx`。

## 1.1.0 — 2026-10-23

### 新增
- **手机端重设计**（`public/assets/mobile.css`，依据 `docs/00-DESIGN.md`）
  - 底部导航改为 5 个：**账户 / 账单 / 记一笔（中心动作位）/ 统计 / 设置**；
    被移出栏的 11 个二级页面全部有归属，不产生不可达页面
  - 移动端专属样式层：触控一律 ≥44px、输入 17px（防 iOS 聚焦缩放）、
    `env(safe-area-inset-*)` 适配刘海与 Home 条、顶栏底栏磨砂、提交条随软键盘抬升
  - 三档断点 1023 / 640 / 419；手机与平板上 `/` 直接落到 `/accounts`
- **导入/导出分类拆分**：单列「分类」拆为「主类别」「子类别」，CSV 由 17 列变 18 列；
  导入可分别映射两列，`resolveCategoryByNames` 按「主+子」反查分类树
- **对账工具**：重复扣费候选判定（`duplicate_reviews`）、记账完整度分析、银行流水导入
- **镜像与部署**
  - GitHub Actions 自动构建镜像并推 `ghcr.io/shayi/cc-ledger`；配了 secret 可同步推 Docker Hub
  - 数据卷改绑定挂载 `${DATA_HOST_DIR:-./data}:/data`，数据落在 NAS 共享文件夹
  - 新增网页「Docker → 项目」专用 `docker-compose.nas.yml`（无 `${}` 插值）与
    compose 专用 `.env.docker.example`

### 修复
- 统计页窄屏下拉控件把「全部类别」截成「全部类…」
- 记账页横向溢出 4~8px（`app.css` 的 `.action-bar` 写死 `margin: 0 -16px`，
  与移动端 12px 留白不等；现统一走 `var(--page-gutter)`）
- 导航措辞与页面标题不一致：「我的 → 设置」「报表 → 统计」

### 变更
- 侧栏与移动端导航同步调整；PWA 缓存版本 `v10 → v11`

## 1.0.0

首个可用版本：多账本记账、账户与往来、分类两级、预算、报表、分期与周期账单、
导入导出、SQLite（WAL）+ 每日自动备份。
