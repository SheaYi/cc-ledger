# CC记账 · 绿联 NAS 部署指南（DXP4800 / UGOS Pro）

> **机型**：绿联 DXP4800（Intel Pentium Gold 8505，**x86_64**，8GB DDR5，可扩 64GB）
> **系统**：UGOS Pro（自带「Docker」应用）
> **形态**：单容器 + 共享文件夹绑定挂载（数据落在 `/volume1/docker/cc-ledger/data`，容器内是 `/data`），容器可随时重建
> **本次目标**：局域网访问 `http://<NAS_IP>:3000`

---

## 📌 关于本文的可信度（请先看这段）

**已实测验证的**（在开发机上跑过真实代码得出）：

- `/healthz` 的字段名与含义（直接读 `src/modules/health/index.ts`）
- 迁移文件数量 **17**（数 `drizzle/*.sql`）
- 所有环境变量名（比对 `src/config/env.ts`）
- 限流窗口：登录 **每分钟 5 次**、注册 **每小时 3 次**（读 `src/modules/auth/index.ts`）
- 每日备份时间 **03:00**、保留 14 天（读 `src/scheduler/index.ts`）

**未实测、需要你在 NAS 上验证的**：

- `docker compose up -d --build` 的**完整构建过程**（开发机上没装 Docker，无法预先跑通）
- 首次构建耗时（文档写 5–15 分钟，是经验估计，取决于你的网速）
- 备份/恢复命令（需要真实数据目录才能验证）

> 这些无法预先验证的部分，都配了「如果失败怎么办」的排障步骤（第八节）。
> 另外 `npm run audit:deploydoc` 会持续校验本文与代码的一致性 —— 代码改了本文没跟上，这个闸门会红。

---

## 零、先确认这几件事（开始前 2 分钟）

| # | 需要确认 | 怎么查 | 影响 |
|---|---|---|---|
| 1 | NAS 的局域网 IP | 网页界面：**控制面板 → 网络设置 → 网络连接** | 后面所有命令和访问地址都要用它 |
| 2 | 3000 端口没被占 | SSH 后执行 `docker ps`，看有没有容器已用 3000 | 被占就把映射改成 `38000:3000`（**只改左边**） |
| 3 | Docker 应用已装 | 桌面上的「Docker」图标 | 没装就到「应用中心」搜 Docker 安装 |
| 4 | 有 ≥2GB 空闲存储 | **存储管理器 → 存储空间** | 不够就先清空间 |

> ⚠️ **CPU 型号提醒**：DXP4800 是 Intel **Pentium Gold 8505**（x86_64）。
> 本项目用的是 `node:22-alpine` 官方镜像，x86_64 直接可用，**不需要模拟器、不需要换镜像**。
> 也不需要 GPU —— 这是一个纯 CPU 的 Web 服务，硬件直通（`devices: /dev/dri`）是给影音转码类应用用的，与本项目无关。

---

## 一、需要传哪些文件

在电脑上的项目目录 `cc-ledger/` 里，**只有这些**需要传到 NAS：

```
cc-ledger/
├── Dockerfile            ← 必需
├── docker-compose.yml    ← 必需（SSH 部署用，靠 .env 填变量）
├── docker-compose.nas.yml ← 可选（网页「Docker → 项目」粘贴用，值写死）
├── package.json          ← 必需
├── package-lock.json     ← 必需（Dockerfile 用 npm ci，缺了会失败）
├── tsconfig.json         ← 必需（npm run build 要用）
├── drizzle.config.ts     ← 必需
├── drizzle/              ← 必需（17 个数据库迁移文件，缺了数据库建不出表）
├── public/               ← 必需（前端页面）
├── src/                  ← 必需（要现场编译 TypeScript）
└── .env                  ← 不用传（自己在 NAS 上建，见第三节）
```

**不用传**：`node_modules/`、`dist/`、`data/`（`.dockerignore` 已自动排除）。

> 为什么 `drizzle/` 和 `public/` 必须传？
> `drizzle/` 是数据库的「建表图纸」，缺了容器启动时建不出任何表；
> `public/` 是前端网页文件，缺了后端能跑但打开是空白页。

---

## 二、开启 SSH（后面所有命令都要用它）

**网页操作路径**：`控制面板` → `终端机`（Terminal）

1. 勾选 **「启用 SSH」**
2. 端口保持默认 **22**（或改成一个不常见的端口更安全）
3. 点 **「应用」** 保存 —— **改完不点应用是不生效的**
4. 建议设置「**自动关闭时间**」，例如 30 分钟，防止忘记关

**从电脑连上去**：

- **Windows**：按 `Win + R` → 输入 `cmd` → 回车
- **macOS**：打开「启动台」→ 搜索「终端」

在弹出的黑窗口里输入（把用户名和 IP 换成你的）：

```bash
ssh 你的用户名@192.168.1.10
```

> 用户名就是你登录 NAS 网页界面用的那个管理员账号。
> 首次连接会问 `Are you sure you want to continue connecting?`，输入 `yes` 回车。
> 然后输密码 —— **输入时屏幕上不显示任何字符（连星号都没有），这是正常的**，打完直接回车。

**需要 root 权限时**（创建目录、改权限要用）：

```bash
sudo -i
```

> 这会再次要求输密码，输完提示符会变成 `#`，就是 root 了。
> 用完退出：`exit`（退回普通用户），再 `exit` 一次断开连接。

---

## 三、目录与环境准备

### 3.1 建目录（源码 + 数据）

```bash
sudo mkdir -p /volume1/docker/cc-ledger
sudo mkdir -p /volume1/docker/cc-ledger/data
sudo chown -R 1001:1001 /volume1/docker/cc-ledger/data
```

> **用途**：`/volume1/docker/cc-ledger` 放项目源码；它下面的 `data` 放**真实数据**
> （数据库、附件、自动备份）。`docker-compose.yml` 里那一行
> `${DATA_HOST_DIR:-./data}:/data` 就是把 `data` 目录接到容器内的 `/data`。
> 这样数据库文件直接躺在共享文件夹里 —— 在绿联「文件管理」里看得见，
> 备份就是复制一个目录，不用再套一层 `docker run` 去导卷。
>
> **`chown 1001:1001` 不能省**：容器以非 root 用户 `nodejs`（uid 1001）运行，
> 而 `sudo mkdir` 建出来的目录属主是 root。不改属主，容器一启动就会
> `SQLITE_CANTOPEN` / `permission denied`，然后在重启循环里刷日志。
> 这条命令正是「把目录交给容器用户」。
>
> `/volume1` 是第一个存储池的路径 —— 如果你的存储池编号不是 1，
> 在 SSH 里执行 `ls /` 看看有哪些 `volumeN` 目录，挑一个空间够的
> （下文所有 `/volume1` 都要跟着换）。

### 3.2 上传文件

**方式一：网页上传（简单，适合文件不多）**

`文件管理` → 进入存储空间 → 打开（或新建）`docker` 文件夹 → 进入 `cc-ledger` 文件夹 →
把上面第一节列的文件/文件夹拖进去。

> `.env` 不用上传（下一步自己建），`node_modules` 和 `data` 不用上传
> （前者是依赖，NAS 上会重新装；后者是数据，本地的那份不该带到 NAS 上）。
> 但 **`data` 目录本身要先建好并 chown 1001**，见 3.1。

**方式二：命令行传（快，适合文件多）**

在你的**电脑**上执行（不是 NAS 上）：

```bash
scp -r package.json package-lock.json tsconfig.json drizzle.config.ts Dockerfile docker-compose.yml drizzle public src 你的用户名@192.168.1.10:/volume1/docker/cc-ledger/
```

> `scp` 和 `ssh` 是同一套工具，作用是「复制文件」。参数 `-r` 表示递归复制文件夹（不带 `-r` 传文件夹会失败）。

上传完在 NAS 上确认一下：

```bash
ls -l /volume1/docker/cc-ledger
```

> 应该能看到 `Dockerfile`、`docker-compose.yml`、`drizzle`、`public`、`src` 等条目。
> **如果少了 `drizzle` 或 `public`，先回去补传**，否则容器起来是坏的。

### 3.3 生成密钥

```bash
openssl rand -base64 48
```

> **用途**：生成一串随机的加密密钥，用于签发登录令牌。
> **用途说明**：所有用户登录后拿到的凭证都由这串密钥签名。密钥泄露 = 任何人都能伪造登录态。
> 所以它**必须**是随机值、**必须**保密、**绝不能**用示例值。
> 把输出整串复制下来，下一步要用。（这是临时命令，关掉窗口就没了，务必先复制）

### 3.4 建 .env 文件

```bash
cd /volume1/docker/cc-ledger
nano .env
```

> **用途**：把密钥和配置写进一个文件，`docker-compose.yml` 会自动读取它。
> （`.env` 以点开头，Linux 里默认隐藏，但 Docker 认得它。）

在编辑器里写入以下内容，把 `<粘贴第3.3步生成的密钥>` 和 `<你的NAS IP>` 换掉：

```bash
# 登录令牌加密密钥（第 3.3 步生成的那串）
JWT_SECRET=<粘贴第3.3步生成的密钥>

# 对外访问地址 —— 生成邀请链接、二维码时用它
# 必须改成 NAS 的真实 IP，否则别人收到的邀请链接打不开
PUBLIC_BASE_URL=http://192.168.1.10:3000

# 登录限流（同一 IP 每分钟最多 5 次登录请求，含成功）
RATE_LIMIT_LOGIN_MAX=5
# 注册限流（同一 IP 每小时最多注册 3 个账号）
RATE_LIMIT_REGISTER_MAX=3
```

**保存退出**：`Ctrl + O` → 回车（保存）→ `Ctrl + X`（退出）。

确认文件建好了：

```bash
cat .env
```

> ⚠️ 如果这里报 `JWT_SECRET` 相关错误，说明内容没存上，最常见原因是没按 `Ctrl+O`。

---

## 四、配置文件逐项说明

`docker-compose.yml` 就是「怎么把服务跑起来」的说明书。逐项拆解：

| 配置项 | 作用 | 能不能改 |
|---|---|---|
| `build: context: .` | 用当前目录的 `Dockerfile` 构建镜像 | 别改 |
| `image: ${CC_IMAGE:-cc-ledger:1.1.14}` | 用哪个镜像：不设 `CC_IMAGE` 就用本地构建的这个名字；设成 `ghcr.io/shayi/cc-ledger:latest` 就是拉 GitHub 构建好的 | 可改（见 5.0） |
| `restart: unless-stopped` | **开机自启的核心**：容器退出就自动拉起；你手动停的则不再拉 | 见第五节 |
| `ports: "3000:3000"` | **端口映射**，见第六节 | 端口冲突时只改左边 |
| `JWT_SECRET` | 登录凭证密钥 | **必改**，其余可不动 |
| `PUBLIC_BASE_URL` | 邀请链接里的地址 | **必改**成真实 IP |
| `DATA_DIR: /data` | 数据目录在容器里的位置 | 别改 |
| `DB_PATH: /data/cc-ledger.db` | **数据库文件的准确落盘路径**（改它等于换一个空库） | 别改 |
| `volumes: ${DATA_HOST_DIR:-./data}:/data` | **绑定挂载**：把 NAS 上 `cc-ledger/data` 目录接到容器 `/data`。数据是**看得见的普通文件**，不再是 Docker 内部卷 | 可改（换存放位置），改完必须重新 chown 1001 |
| `deploy.resources.limits.memory: 512M` | 内存上限，防止拖垮 NAS | 按需调 |
| `cap_drop: ALL` | 去掉容器所有特权（安全加固） | 别改 |
| `logging.max-size: 10m` | 单个日志文件最大 10MB，共留 3 个 | 按需调 |
| `healthcheck` | 每 30 秒自己检查一次是否正常 | 别改 |
| `TZ: Asia/Shanghai` | 时区，影响「每月 1 号」等日期计算 | 别改 |

### 镜像构建做了什么（Dockerfile 三段）

1. **deps**：装全部依赖。`better-sqlite3` 是需要编译的原生模块，所以先装编译工具（`python3 make g++`）
2. **build**：编译 TypeScript → 只保留生产依赖（镜像更小）
3. **runner**：最终运行环境。**非 root 用户**（uid 1001）、只有最精简的系统包、约 200MB

> 为什么必须用官方 `node:22-alpine`？Alpine 用 musl libc，
> 某些只在 glibc 下编译好的包会报 `invalid ELF header`。本项目 Dockerfile 已处理好，别改基础镜像。

---

## 五、启动与开机自启

**三条路线，结果一样**：

| 路线 | 怎么做 | 适合谁 |
|---|---|---|
| **拉镜像（最省事，推荐）** | `docker compose pull && docker compose up -d` | NAS 上不编译，30 秒起好；镜像由 GitHub 自动构建 |
| **A. 本地构建** | `docker compose up -d --build` | 改了代码要立刻在 NAS 上生效 |
| **B. 网页界面「Docker → 项目」** | 新建项目，路径填 `docker/cc-ledger`，**粘贴 `docker-compose.nas.yml` 全文**（不是根目录那份） | 不想开 SSH；界面无 `.env` 也能跑，详见 5.1 |

> ⚠️ **不管走哪条路线，第 3.1 步的 `mkdir data` + `chown 1001:1001` 都必须先做**（需要 SSH 一次）。
> 界面里创建的空目录属主是 root，容器写不进去 —— 这是唯一绕不过 SSH 的一步。

### 5.0 直接拉镜像（推荐：NAS 上不编译）

镜像由 **GitHub Actions 自动构建**：每次推送到 `main`，仓库里的
`.github/workflows/docker-image.yml` 就会编译一次，产物推到 GitHub 的镜像仓库（ghcr）。

> **为什么推荐**：Pentium Gold 8505 上编译 `better-sqlite3` 要 5–15 分钟、吃掉 1GB 内存；
> 拉现成镜像只要几十秒，升级也只是换一个镜像层。

**第 1 步：把镜像地址写进 `.env`**（在 NAS 上）

```bash
cd /volume1/docker/cc-ledger
echo 'CC_IMAGE=ghcr.io/shayi/cc-ledger:latest' >> .env
```

> `CC_IMAGE` 不是应用的环境变量，只被 `docker-compose.yml` 读取，用来决定「用哪个镜像」。
> 不写这一行 = 走本地构建（默认 `cc-ledger:1.1.14`）。

**第 2 步：登录 ghcr**（镜像设为 public 后可以跳过这步）

```bash
# 先建一个只读 token：GitHub → Settings → Developer settings →
#   Personal access tokens → Tokens (classic) → 勾 read:packages
echo '<粘贴那个 token>' | docker login ghcr.io -u SheaYi --password-stdin
```

**第 3 步：拉取并启动**

```bash
docker compose pull
docker compose up -d
```

> **以后升级**就重复第 3 步：`docker compose pull && docker compose up -d`。
> 数据在 `data/` 里，换镜像不动数据。

**镜像地址怎么确认**：GitHub 仓库 → **Actions** → 左侧「构建并推送 Docker 镜像」→ 点最新的运行 →
页面底部 Summary 里就写着本次的完整镜像地址；也可以在仓库首页右下角 **Packages** 里看到。

可用标签：

| 标签 | 完整镜像地址 | 什么时候有 | 用途 |
|---|---|---|---|
| `latest` | `ghcr.io/shayi/cc-ledger:latest` | 每次推 `main` | 日常用这个 |
| `sha-60b1224` | `ghcr.io/shayi/cc-ledger:sha-60b1224` | 每次构建 | 想钉死到某一次提交 |
| `v1.1.12` | `ghcr.io/shayi/cc-ledger:v1.1.12` | 打了 `v*` tag | 固定版本 |
| `v1.1.14` | `ghcr.io/shayi/cc-ledger:v1.1.14` | 打了 `v*` tag | 固定版本 |

> ⚠️ **版本标签带 `v` 前缀**，和 git tag 完全一致：写 `v1.1.12`，**不能**写成 `1.1.12`。
> 少一个 `v` 拉不到镜像（`manifest unknown`，HTTP 404），但报错只说"找不到"，
> 很容易误判成"镜像没构建成功"。想锁版本就把 `CC_IMAGE` 写成上面的完整地址。

**想把镜像设为 public（这样任何机器不用登录就能拉）**：
GitHub → 你的头像 → Your profile → **Packages** → `cc-ledger` → 右侧 **Package settings** →
底部 **Danger Zone** → **Change visibility** → Public。

> 公开镜像里**没有你的任何数据**：`.dockerignore` 已排除 `.env`、`data/`、`node_modules/`。
> 仓库源码本来就是公开的，镜像只是它编译后的产物。

#### 5.0.1 同时推到 Docker Hub（可选）

想让镜像同时出现在 Docker Hub（`docker.io/<用户名>/cc-ledger`），**不需要手动 push**：
workflow 已经支持，配上两个 secret 就会自动双推。

**第 1 步：在 Docker Hub 建 token**

1. 登录 [hub.docker.com](https://hub.docker.com) → 右上头像 → **Account settings**
2. **Security** → **New Access Token** → 描述随便写，权限选 **Read & Write** → 生成
3. 复制那串 token（**只显示一次**，关掉就看不到了）

**第 2 步：填到 GitHub 仓库里**

仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Name | Value |
|---|---|
| `DOCKERHUB_USERNAME` | 你的 Docker Hub 用户名（**全小写写**，比如 `shayi`） |
| `DOCKERHUB_TOKEN` | 上一步那串 token |

**第 3 步：触发一次构建**

改任何文件推一下 `main`，或 **Actions → 构建并推送 Docker 镜像 → Run workflow**。
跑完后镜像会同时出现在两处：

```
ghcr.io/shayi/cc-ledger:latest
docker.io/<你的用户名>/cc-ledger:latest
```

> 第一次 push 时 Docker Hub 会自动创建这个仓库（默认 Public）。
> 想改成私有：hub.docker.com → 仓库 → Settings → Visibility。

**第 4 步：NAS 上换成 Docker Hub 的地址**

```bash
sed -i '/^CC_IMAGE=/d' /volume1/docker/cc-ledger/.env
echo 'CC_IMAGE=<你的用户名>/cc-ledger:latest' >> /volume1/docker/cc-ledger/.env
cd /volume1/docker/cc-ledger && docker compose pull && docker compose up -d
```

> `docker.io/` 前缀可以省略，compose 默认就去 Hub 找。

**⚠️ 必须先知道的两件事**

1. **Docker Hub 在国内一样经常超时**，而且比 ghcr 更容易被限流
   （匿名拉取 100 次/6 小时）。如果你现在卡的就是 `registry-1.docker.io ... context deadline exceeded`，
   换到 Docker Hub **不会变好** —— 反而更慢。真正省事的是
   **见 8.11 的「在有网的电脑上 `docker save` → 拷贝 → `docker load`」**。
2. **镜像加速器一般只代理 `docker.io/library/*`**（也就是 `nginx`、`alpine` 这类官方镜像），
   对 `<用户名>/cc-ledger` 这种个人仓库**多半不生效**。别指望配个加速器就能拉自己的镜像。

**手动 push（不想走 Actions 时）**

```bash
# 在能上网的电脑上，先把镜像弄到本地
docker pull ghcr.io/shayi/cc-ledger:latest
docker login -u <用户名>              # 密码处粘 Access Token，不是登录密码
docker tag ghcr.io/shayi/cc-ledger:latest <用户名>/cc-ledger:latest
docker push <用户名>/cc-ledger:latest
```


### 5.1 网页「Docker → 项目」创建

**先说清一件事：网页界面里不需要你「创建 docker-compose.yaml 文件」**。
「项目」是把 compose **内容**贴进编辑框，Docker 自己在项目目录下生成 `docker-compose.yml`。
只有你自己写文件时才需要关心后缀 —— `.yml` / `.yaml` 都认。

贴哪一份，取决于你要不要用 `.env`：

| 你的选择 | 贴哪份 compose | 变量从哪来 |
|---|---|---|
| **我自己建 `.env`**（SSH 或文件管理写文件） | 仓库根目录 `docker-compose.yml` | `.env` 里的 `JWT_SECRET` / `PUBLIC_BASE_URL` / `CC_IMAGE` / `DATA_HOST_DIR` |
| **不建 `.env`** | `docker-compose.nas.yml` | 值全部写死在 compose 里，只需改 `★` 两处 |

> 两份文件内容等价（端口、挂载、安全项都一样，`npm run audit:deploydoc` 会校验不漂移），
> 区别只是**变量放哪里**。`.env` 只是给 compose 做文本替换用的，**不会进容器**；
> 容器里的环境变量始终来自 `environment:` 段。

**第 1 步：建数据目录并交属主**（只有这步必须 SSH，做一次）

```bash
sudo mkdir -p /volume1/docker/cc-ledger/data
sudo chown -R 1001:1001 /volume1/docker/cc-ledger/data
ls -ld /volume1/docker/cc-ledger/data      # 期望：drwxr-xr-x 2 1001 1001
```

**第 2 步：生成密钥**

```bash
openssl rand -base64 48
```

**第 3 步（走 `.env` 才需要）：写 .env**

仓库里已备好模板 `.env.docker.example`（只含 compose 要用的 4 个变量），

```bash
cp .env.docker.example .env
nano .env          # 改 JWT_SECRET 和 PUBLIC_BASE_URL 两处
chmod 600 .env
```

不想用 nano 就整段覆盖：

```bash
cd /volume1/docker/cc-ledger
cat > .env <<'ENV'
# ===== 必填 =====
JWT_SECRET=把上一步的输出整段粘这里
PUBLIC_BASE_URL=http://192.168.1.10:3000

# ===== 镜像来源 =====
CC_IMAGE=ghcr.io/shayi/cc-ledger:latest

# ===== 数据落点（写绝对路径，最稳）=====
DATA_HOST_DIR=/volume1/docker/cc-ledger/data
ENV
chmod 600 .env
```

> - **不要给值加引号**：`.env` 里 `JWT_SECRET="abc"` 会把引号一起当成密钥的一部分。
> - `chmod 600` 是防止同机其他账号读到密钥；compose 是 docker 守护进程（root）读的，不影响。
> - 也可以用「文件管理」建这个文件，但注意别让编辑器存成 `.env.txt`（Windows 记事本的老毛病）。
> - **别从 Windows 直接拷这个文件过去**（可能带 CRLF 甚至 UTF-8 BOM）。真拷了就修一下：
>   `sed -i 's/\r$//; 1s/^\xEF\xBB\xBF//' .env`，然后 `head -1 .env | od -c | head -2` 确认行首没有乱码。
> - 这个文件已在 `.gitignore` 里，不会被推上 GitHub。

**第 4 步：新建项目**

Docker → **项目** → **新建**（有的版本叫「创建项目」）：

| 字段 | 填什么 |
|---|---|
| 名称 / 项目名 | `cc-ledger` |
| 路径 / 工作目录 | `/volume1/docker/cc-ledger`（**必须和 `.env` 同一目录**） |
| Compose 内容 | 走 `.env` → 贴根目录 `docker-compose.yml`；不建 `.env` → 贴 `docker-compose.nas.yml` |

**第 5 步：部署**，等界面显示 `运行中 / running`（首次拉镜像 1–3 分钟）。

**走 `.env` 的三个注意点**

1. **别让界面误触发本地编译**：根 `docker-compose.yml` 带 `build:` 段（给 SSH 场景用的）。
   如果界面有「重新构建 / Rebuild」选项，**不要勾** —— 勾了会在 NAS 上编译
   `better-sqlite3`，5–15 分钟。想彻底避免，把贴进去的内容里这两行删掉：
   ```yaml
       build:
         context: .
         dockerfile: Dockerfile
   ```
   （`image:` 指向 ghcr，删掉 `build:` 依然能正常跑。）
2. **确认 `.env` 真的被读到了**：compose 只读「项目工作目录」下的 `.env`。
   查真实工作目录：
   ```bash
   docker inspect cc-ledger --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
   ```
   如果输出的不是 `/volume1/docker/cc-ledger`，就把 `.env` 移到那个目录再重新部署。
3. **验证值生效**（不用回显密钥）：
   ```bash
   docker exec cc-ledger printenv PUBLIC_BASE_URL
   ```
   应显示你自己填的地址；如果还是 `http://localhost:3000`，就是 `.env` 没读到。

**两种撞车情况**

- 之前用 SSH 起过同名容器（`container_name: cc-ledger`）→ 网页项目部署会报端口占用。
  先在 SSH 里 `cd /volume1/docker/cc-ledger && docker compose down`，再回网页部署。
- 不要同时留 `build:` 和 `image:` 时点「重新构建」，理由同上。

### 5.2 首次构建并启动（SSH，本地编译，兜底用）

> 只有在「拉不到 ghcr 镜像」或「想改源码再跑」时才需要这一步，正常部署走 5.0 / 5.1 即可。

**必须用 SSH 执行**（绿联网页界面的项目编辑器对 `build` 场景支持有限）：

```bash
cd /volume1/docker/cc-ledger
```

```bash
docker compose up -d --build
```

> **参数拆解**：
> - `up` = 创建并启动容器
> - `-d` = 后台运行（detached），不占用当前终端，关窗口也不会停
> - `--build` = 启动前先重新构建镜像（第一次必须加；之后代码没改可以不加）
>
> **这一步会花 5–15 分钟**（要在 NAS 上下载依赖并编译），属于正常，请耐心等待。

### 5.3 看启动日志

```bash
docker compose logs -f --tail=100
```

> `-f` = 持续输出新日志；`--tail=100` = 只看最近 100 行。
> 看到 `CC记账 已启动` 或类似字样就是成功了。
> **按 `Ctrl + C` 退出日志查看**（容器不会因此停止）。

### 5.4 开机自启

**已经自动生效了。** `docker-compose.yml` 里这行就是开机自启：

```yaml
restart: unless-stopped
```

它的含义是：**容器意外退出就自动重启；NAS 重启开机后 Docker 服务起来，它也会自动启动。**
你不需要额外做任何配置。

> 两种策略的区别：
> - `always`：永远重启，包括你手动 `docker stop` 之后（下次 Docker 起来还会起）
> - `unless-stopped`：**你手动停的就不会自动起**，除非你再手动 start
>
> 本项目用 `unless-stopped`，是为了让你能「手动停下来歇一歇」，不会被强制拉起。

**验证自启生效**：

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' cc-ledger
```

> 输出 `unless-stopped` 就对了。

### 5.5 绿联网页界面管理（日常更常用）

SSH 不方便时，用网页界面点：

`Docker` 应用 → **容器** → 找到 `cc-ledger` → 右侧按钮可 **启动 / 停止 / 重启 / 查看日志 / 删除**

**改配置 / 升级镜像**：`Docker` → **项目** → 点项目名 → **编辑** → 改 compose 内容或点 **拉取/重新部署**。
改完重新部署时，容器会按新配置重建，`/data` 里的数据不动。

> ⚠️ **可以用界面删容器，数据不会跟着走**：数据在共享文件夹的 `data` 目录里，
> 容器只是个壳，删了重建、重新 `up` 起来数据原样在。
> 唯一的风险是**手动去文件管理里删掉 `data` 目录** —— 那才是真删库，删前先备份。

---

## 六、网络概念（这一节请耐心看完，后面排障全靠它）

### 6.1 IP 地址：设备在网络里的门牌号

你的路由器会给每个连进来的设备分配一个地址，比如 `192.168.1.10`。
家里/办公室里设备互相通信时就靠这个号找到对方。

**看 NAS 的 IP**：网页界面 `控制面板 → 网络设置 → 网络连接`，那里会显示当前 IP。
**建议在路由器里给 NAS 绑一个固定 IP**（叫「静态 DHCP」或「IP 保留」），
否则路由器重启后可能换一个 IP，你存的地址就失效了。

> 📌 **本次需要**：需要，命令行里到处要用。
> 如果发现 NAS 的 IP 变了导致访问不了，八成就是这个问题。

### 6.2 端口：设备上的「小窗口编号」

一台设备上可以同时跑很多服务（SSH、Docker、其他应用），
靠**端口号**区分谁是谁。打个比方：一个楼里有 65535 个房间，端口号就是房间号。

- `22` = SSH（远程命令行）
- `80` = HTTP（网页）
- `443` = HTTPS（加密网页）
- `3000` = 本项目 CC记账 使用的端口（可改）

### 6.3 端口映射：把「房间号」对上门牌

容器有自己的内部网络，容器里的 3000 端口和 NAS 上的 3000 端口**是两个不同的东西**。
`ports: "3000:3000"` 就是建立一条对应关系：

```
你访问 http://192.168.1.10:3000
        ↓  路由器送到 NAS
NAS 的 3000 端口  ←→  容器里的 3000 端口
```

**格式是「NAS端口:容器端口」**。所以：

| 想做的事 | 怎么改 |
|---|---|
| 换成别的对外端口（如 8080） | 改成 `"8080:3000"` —— **只改左边**，右边永远是容器内部的 3000 |
| 只允许本机访问，不给局域网开 | 改成 `"127.0.0.1:3000:3000"` |
| 同一个服务开两个入口 | 写两行，`- "3000:3000"` 和 `- "38000:3000"` |

> 📌 **本次需要**：需要，就是上面那一行。
> **新手最容易踩的坑**：端口被别的服务占了 → 容器起不来。
> 排查方法：`docker ps` 看端口列表；或 `ss -tlnp | grep 3000` 看谁占着。

### 6.4 局域网 vs 外网：谁能访问你

| | 局域网访问 | 外网访问 |
|---|---|---|
| 谁能访问 | 同一个路由器下的设备（家里的手机、电脑） | 世界上任何地方的人 |
| 怎么做到 | 浏览器输入 `http://NAS_IP:3000` | 需额外配置，见 6.7 |
| 安全性 | 相对高（物理上不在同一个网络就连不上） | 低（暴露在公网会被扫描） |

> 📌 **本次需要**：**只做局域网**，外网配置见 6.7，属于「以后想要时再做」。

### 6.5 HTTP 与 HTTPS：明文 vs 加密

- **HTTP** = 明文传输。同一网络里别人理论上能看到你请求的内容（包括登录密码）。
- **HTTPS** = 加密传输。浏览器地址栏会出现 🔒。

HTTPS 通常通过一张「数字证书」实现。证书有两种来源：

- **公网证书**（Let's Encrypt）：免费，但**必须先能从公网访问到你的服务**才能自动签发
- **自签证书**：自己给自己签，浏览器会警告「不安全」，需手动点「继续」

还有个关键限制：**浏览器的 Service Worker（离线功能）和 PWA 安装，要求 HTTPS 或 localhost**。
所以用 HTTP 时，CC记账 的在线记账功能完全正常，但「添加到主屏幕」「离线记账」不可用。

> 📌 **本次需要**：**不需要配置 HTTPS**，用 HTTP 即可（局域网内）。
> 这是有意为之：局域网 + HTTP 是这类家庭服务最务实的起点。
> 想启用 PWA 时按 6.7 走。

### 6.6 端口转发：把门开到街上（本次不需要）

**危险操作，不建议对记账系统使用。**

路由器可以把「外部来的请求」直接转到家里某个设备的某个端口。
比如把公网的 3000 转发到 `192.168.1.10:3000`，全世界的 3000 端口扫描器都会来敲你的门。

即使加了密码，也会遇到：暴力破解（虽有每分钟 5 次的限流，仍可能被持续骚扰）、
Docker API 未授权导致被入侵、证书无法自动签发、家里 IP 变动导致要重新配。

> 📌 **本次需要**：**不配置**。

### 6.7 DDNS 和外网访问（本次不需要，但给你留路径）

**DDNS**：你的家庭宽带 IP（公网 IP）不固定，隔一段时间就变。
动态域名服务（DDNS）给你一个固定域名（如 `mynas.abc.com`），
它会自动跟着你的公网 IP 变化而更新，这样你不用记 IP 也能找到家。

> DDNS 只解决「IP 会变」的问题，**它本身不提供任何加密或安全**。
> 单独配 DDNS + 端口转发 = 把家门敞开且没有锁。**这是最常见的踩坑组合。**

**推荐方案：Tailscale**（如果以后确实需要在外使用）

Tailscale 是基于 WireGuard 的组网工具：

- 在 NAS 和你的手机/笔记本上各装一个客户端，登录同一个账号
- 两台设备自动组成一个私有网络，**互相用一个固定内网 IP 直连**
- 自带加密（等价 HTTPS 级别），**不需要买证书、不需要在路由器开任何端口**
- 免费额度足够个人使用

有了 Tailscale，外网访问就是 `http://<NAS的Tailscale-IP>:3000`，
而且因为 IP 是内网地址语义，浏览器会把它当「安全上下文」，**PWA 和离线功能自动可用**。

> 📌 **本次需要**：**不需要**。先用局域网跑通。需要时在 UGOS Pro 的「Docker」里加一个
> `tailscale/tailscale` 容器即可，不影响本项目。

### 6.8 反向代理：一个门面接所有服务（本次不需要）

反向代理就是放在所有服务前面的「总台」：外部只认它一个地址，它根据路径把请求转给后面的不同服务。

比如 `http://NAS_IP/` 转给记账、`/photos/` 转给相册、`/files/` 转给文件管理。

它的真正价值在两点：

1. **统一 HTTPS**：只给代理配一次证书，所有服务都跟着有 HTTPS
2. **隐藏内部端口**：不用为每个服务都开端口，外部只看到 80/443

> 📌 **本次需要**：**不需要**。只有一个服务时引入代理纯属增加复杂度。
> 等到 NAS 上跑了 5 个以上要对外的服务时再考虑（用 Caddy 或 Nginx）。

### 本次配置速查表

| 概念 | 本次需要配置吗 | 怎么做 |
|---|:---:|---|
| IP 地址 | ✅ 必需 | `控制面板 → 网络设置` 查；建议路由器绑静态 IP |
| 端口 | ✅ 必需 | 用 3000，冲突则改 compose 里左边那个 |
| 端口映射 | ✅ 必需 | 已写好 `3000:3000` |
| 局域网访问 | ✅ 必需 | 浏览器开 `http://NAS_IP:3000` |
| SSH | ✅ 必需（部署阶段） | `控制面板 → 终端机` → 启用 |
| 开机自启 | ✅ 已配好 | `restart: unless-stopped` |
| HTTPS | ❌ 不需要 | 局域网 HTTP 够用 |
| 端口转发 | ❌ 不需要 | 且不建议 |
| DDNS | ❌ 不需要 | 只解决 IP 变，不提供安全 |
| 外网访问 | ❌ 不需要 | 以后要的话用 Tailscale |
| 反向代理 | ❌ 不需要 | 单服务用不上 |

---

## 七、验证部署成功

**必须逐条做完**，不要只看容器显示 `Up` 就算好了 —— 容器在跑不代表服务真的能用。

### 7.1 容器在运行且健康

```bash
docker ps
```

**期望看到**：`STATUS` 列显示 `Up 2 minutes (healthy)`。
括号里的 `healthy` 最重要 —— 说明应用自己报告「一切正常」。
如果显示 `Up 2 minutes (unhealthy)` 或在反复重启，回到第八节排障。

### 7.2 健康检查接口返回正常

```bash
curl http://127.0.0.1:3000/healthz
```

**期望输出**（字段名和含义）：

```json
{
  "status": "ok",
  "app": "CC记账",
  "version": "1.1.14",
  "uptimeSeconds": 3944,
  "database": { "connected": true, "migrationsApplied": 17, "walMode": true },
  "scheduler": { "running": true, "nextRun": "...", "tasks": [] }
}
```

逐项检查：

| 字段 | 期望值 | 不对说明什么 |
|---|---|---|
| `status` | `"ok"` | 不是 ok 就看 `database.error` 字段 |
| `uptimeSeconds` | **持续增长** | 每次查询都变小 = 容器在反复重启，回到 8.3 |
| `database.connected` | `true` | `false` = 数据库打不开，通常是数据目录属主不是 1001（见 8.4） |
| `database.migrationsApplied` | **17** | 小于 17 = 迁移没跑完；`0` = 表根本没建起来 |
| `database.walMode` | `true` | WAL 模式是并发读写的前提 |
| `scheduler.running` | `true` | `false` = 定时任务没启动（周期账单、每日备份将不工作） |

### 7.3 端口确实在监听

```bash
ss -tlnp | grep 3000
```

> **用途**：确认 NAS 真的在 3000 端口上"接客"。有输出 = 监听中；没输出 = 端口映射没生效。

### 7.4 从 NAS 外部访问（这一步最关键）

在**你的电脑浏览器**里打开：

```
http://192.168.1.10:3000
```

（换成你的真实 IP）

**期望**：看到 CC记账 的登录/注册页面。

> ⚠️ 如果这一步失败、但 7.1~7.3 都正常，那问题在 **NAS 防火墙**或**电脑和 NAS 不在同一个网络**，
> 不是应用的问题（详见 8.4）。

### 7.5 注册第一个账号

页面上点「注册」，创建你自己的账号。

> **注意**：限流是**按 IP 计数、且对所有请求计数（不只失败的那些）**：
> 登录每分钟 5 次、注册每小时 3 次。所以**先注册你自己的**，别拿家人的号反复试。
> 另外家里多台设备共用同一个出口 IP 时，登录次数是**合并计算**的 ——
> 家里 6 个人同一分钟内各登录一次就会触发限流，等 1 分钟自动恢复。

注册成功后：

1. 进入「设置 → 账本」，确认能看到默认账本
2. **记一笔**（比如 10 元午餐），确认金额显示正确
3. 打开「统计」，确认图表出得来

### 7.6 数据持久化验证（重启容器不丢数据）

```bash
docker compose restart
```

等 30 秒，然后刷新浏览器，确认**刚才记的那笔账还在**。

> **这一步验证的是「数据目录挂接对了」**。如果重启后账目消失，
> 说明数据写在了容器的临时层而不是宿主的 `data` 目录 —— 这是必须立刻发现的问题，
> 因为以后升级/重建容器会导致数据丢失。
>
> 也可以直接看宿主目录里有没有文件（这是绑定挂载才有的好处）：
>
> ```bash
> ls -l /volume1/docker/cc-ledger/data
> ```
>
> 应该能看到 `cc-ledger.db`、`cc-ledger.db-wal`、`backups/`、`uploads/`。

### 7.7 开机自启验证

```bash
docker compose restart
```

容器能自动起来（等价验证）。更彻底的重启 NAS 验证可以在方便时做：
`控制面板 → 系统 → 重新启动`，等 NAS 起来后（2~3 分钟）直接开浏览器访问 3000 端口，
不用登录 SSH —— 能访问就说明自启配置正确。

---

## 八、常见问题排查

### 8.1 完全访问不到

**按顺序排查，不要跳步：**

**第 1 步：容器在跑吗**

```bash
docker ps -a
```

- 看不到 `cc-ledger` → 压根没创建成功，回第 8.2
- `STATUS` 是 `Exited (1)` → 容器启动就崩了，看日志：

```bash
docker compose logs --tail=50
```

- `STATUS` 显示 `Restarting` → 在反复重启，看 8.3

**第 2 步：应用自己说健康吗**

```bash
curl http://127.0.0.1:3000/healthz
```

- 返回正常 JSON → 应用没问题，**问题在网络层，继续第 3 步**
- 返回 503 或连不上 → 应用有问题，看第 4 步

**第 3 步：端口通吗**

```bash
ss -tlnp | grep 3000
```

- 没输出 → 端口映射没生效。检查 `docker-compose.yml` 里 `ports` 那行有没有写错（比如写成 `3000` 而不是 `"3000:3000"`）

**第 4 步：从电脑上能不能连到 NAS**

在电脑上（不是 NAS 上）执行：

```bash
ping 192.168.1.10
```

- ping 不通 → **电脑和 NAS 不在同一个网络**。检查电脑连的是不是同一个路由器/WiFi。
  公司网络、访客 WiFi 通常隔离设备。

**第 5 步：NAS 防火墙放行了吗**

网页界面：`控制面板 → 安全` → 看有没有防火墙规则挡了 3000。

### 8.2 容器起不来 / 启动即退出

```bash
docker compose logs --tail=80
```

| 日志里的关键词 | 原因 | 解决 |
|---|---|---|
| `JWT_SECRET` / `must be set` | 没配密钥 | 确认 `.env` 存在且内容正确：`cat .env` |
| `EACCES` / `permission denied` | 数据目录权限不足 | 见 8.4 |
| `no such file or directory` | 传文件时漏了目录 | 检查 `drizzle/`、`public/`、`src/` 是否都在 |
| `ENOSPC` / `no space left` | 磁盘满了 | 清理空间，或换存储池 |
| `error while loading shared libraries` | 镜像与 CPU 架构不符 | 确认用官方 `node:22-alpine`（x86_64 通用） |

### 8.3 容器反复重启（Restarting）

**现象**：`docker ps` 里状态是 `Restarting`，状态码常见 `1` 或 `137`。

```bash
docker inspect cc-ledger --format '{{.State.ExitCode}} {{.State.OOMKilled}}'
```

- **`OOMKilled=true`** → 内存不够。NAS 只有 8GB 的话，把 compose 里
  `limits.memory: 512M` 调到 `256M`，或关闭其他占内存的应用
- **`ExitCode=137`** → 同上，被强制杀掉。也可理解为内存不足
- **`ExitCode=1`** → 应用自己报错，去看 `docker compose logs`

另外检查是不是健康检查一直失败导致重启：

```bash
docker inspect cc-ledger --format '{{.State.Health.Status}} {{json .State.Health.Log}}'
```

### 8.4 权限不足（EACCES / permission denied）

容器以 **非 root 用户 uid 1001** 运行（安全加固），而数据目录是 NAS 上的普通目录 ——
**属主必须是 1001，否则写不进去**。这是本项目最常见的启动失败原因。

典型症状（日志里）：

```
SqliteError: unable to open database file     ← 父目录没有写/执行权限
Error: EACCES: permission denied, mkdir '/data/uploads'
```

修法（在 NAS 上执行，目录名按你实际的改）：

```bash
sudo chown -R 1001:1001 /volume1/docker/cc-ledger/data
docker compose restart
```

> **为什么 sudo mkdir 之后还要 chown**：`mkdir` 用 root 建目录，属主是 `root:root`；
> 容器里的 `nodejs` 用户（1001）对它没有写权限。`chown` 把整个 `data`
> 连同已有文件一起交给 1001 —— 已经存了数据的目录也能安全执行，不会动内容。
>
> **确认改对了**：
>
> ```bash
> ls -ld /volume1/docker/cc-ledger/data     # 属主应显示 1001 1001
> docker exec cc-ledger id                  # 应显示 uid=1001(nodejs)
> docker exec cc-ledger touch /data/.probe && echo 可写
> ```
>
> ⚠️ **别用 `chmod 777` 绕过**：那等于把所有用户都放进来，
> 也绕过了「非 root 运行」这层加固。要的是「换属主」，不是「放开权限」。

### 8.5 端口被占用

```bash
ss -tlnp | grep 3000
```

输出末尾会显示占用进程的 PID 和名字。

**解决**（两种，选一种）：

**方案一：换端口（推荐）** —— 改 `docker-compose.yml` 的 `ports`：

```yaml
    ports:
      - "38000:3000"
```

然后：

```bash
docker compose up -d
```

访问地址相应变成 `http://NAS_IP:38000`。
**同时记得改 `.env` 里的 `PUBLIC_BASE_URL`**，否则邀请链接还是旧端口，会打不开。

**方案二：停掉占用者**

```bash
docker stop 占用者容器名
```

> 端口映射写成 `38000:3000` 时，**如果 38000 也被占，报错信息里会明确写出是宿主端口冲突**。

### 8.6 访问不到但容器正常 —— 防火墙 / 网络隔离

容器 `healthy`、`curl 127.0.0.1:3000` 也正常，浏览器就是打不开。

**原因 1：NAS 防火墙挡了**

网页界面 `控制面板 → 安全` → 检查防火墙规则，放行 3000 端口。

**原因 2：电脑和 NAS 不在同一网段**

执行 `ping NAS_IP` 测试。不通就是网络问题。

**原因 3：Docker 绑定了 127.0.0.1**

如果 `ports` 写成了 `127.0.0.1:3000:3000`，那只有 NAS 本机能访问，外部一律拒绝。改成 `"3000:3000"`。

### 8.7 邀请链接打不开 / 指向 localhost

**现象**：生成的邀请链接是 `http://localhost:3000`，别人点了打不开。

**原因**：`.env` 里的 `PUBLIC_BASE_URL` 没改或改错了。

**解决**：

```bash
vi .env
```

改成你的真实地址，然后：

```bash
docker compose up -d
```

> ⚠️ 改完必须 `up -d` 重建容器才会生效（环境变量是启动时注入的，`restart` 不够）。

### 8.8 数据看起来不对 / 账目少了

**如果是从本机迁移过来的数据**，注意 SQLite 在 WAL 模式下**不能直接 `cp` 数据库文件** —— 
会把未合并的日志留在原处，拷出来的库可能是坏的或缺数据。

正确做法：

```bash
# 在**本机**（数据源）执行，用 VACUUM INTO 生成一致副本
docker compose exec cc-ledger node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/cc-ledger.db');
  db.exec(\"VACUUM INTO '/data/cc-ledger-consistent.db'\");
  db.close();
"
```

再把生成的文件拷出来。

> 本次是全新数据、不迁移，所以**这条用不上**。列在这里是防止你以后需要迁移时踩坑。

### 8.9 时区不对 / 日期差一天

检查 compose 里 `TZ: Asia/Shanghai` 是否在，且 NAS 系统时区也是东八区。
时区错了会导致「每月 1 号生成周期账单」的触发时间偏移。

### 8.10 磁盘空间不足

```bash
df -h
```

```bash
docker system df
```

清理无用镜像（⚠️ 会删掉未被使用的镜像和构建缓存，但不影响运行中的容器）：

```bash
docker system prune -a --volumes
```

> ⚠️ **`--volumes` 会删除未被使用的命名卷**。本项目的数据不在卷里（在共享文件夹的
> `data` 目录），所以它删不到账本数据；但如果你有别的容器已停止且卷没挂载，
> 那些卷会被清掉。执行前先确认。

### 8.11 拉镜像超时：`registry-1.docker.io ... context deadline exceeded`

完整报错长这样：

```
Get "https://registry-1.docker.io/v2/": context deadline exceeded
(Client.Timeout exceeded while awaiting headers)
```

**先读懂它在说什么**：超时的主机是 `registry-1.docker.io`（Docker Hub），
**不是** `ghcr.io`。而本项目只在**构建镜像**时才会用到 Docker Hub
（`Dockerfile` 第一行 `FROM node:22-alpine`）。所以这条报错基本等于：
**它没在拉 ghcr 的现成镜像，而是在 NAS 上编译** —— 编译第一步要去 Docker Hub 下基础镜像，
网络到不了，就超时了。

**为什么会莫名其妙开始编译**：`docker-compose.yml` 里同时有 `build:` 和 `image:`。
`docker compose up -d` 发现本地没有 `ghcr.io/shayi/cc-ledger:latest` 这个镜像，
就退回用 `build:` 自己造一个。**正确顺序是先 pull 再 up**：

```bash
cd /volume1/docker/cc-ledger
docker compose pull          # 只拉镜像，不会触发构建
docker compose up -d         # 此时镜像已在本地，不会再走 build
```

**用网页项目部署的**：界面上如果勾了「构建 / Rebuild」，取消它；
或者直接把 compose 里的 `build:` 三行删掉（`image:` 已经指向 ghcr，删了照样能跑）。

**怎么确认 ghcr 通不通**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://ghcr.io/v2/
```

返回 `401`＝**通的**（匿名没带凭证，属正常）；`curl: (28)` 超时 ＝ 到 ghcr 也不通。
（注意：`401` 只证明网络可达，不代表镜像能拉 —— 包是私有的话也会 `401`，见 8.12。）

**如果连 ghcr 也超时**，三条路，按推荐顺序：

1. **换个网络拉**：很多家庭宽带到 ghcr 是间歇性超时，挂 NAS 的代理/VPN 或换时段重试即可。
2. **在有网的电脑上拉好再导入**（最稳，不依赖 NAS 出网）：
   ```bash
   # 电脑上
   docker pull ghcr.io/shayi/cc-ledger:latest
   docker save ghcr.io/shayi/cc-ledger:latest -o cc-ledger.tar
   scp cc-ledger.tar 你的用户名@192.168.1.10:/volume1/docker/cc-ledger/
   ```
   ```bash
   # NAS 上
   cd /volume1/docker/cc-ledger
   docker load -i cc-ledger.tar
   docker compose up -d
   ```
   `docker load` 之后本地就有这个 tag，`up` 不会再联网。
3. **用第三方 ghcr 镜像源**（应急，可能滞后）：把 `CC_IMAGE` 换成镜像站地址，先探活再改：
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://ghcr.nju.edu.cn/v2/
   ```
   > 这类镜像站由第三方维护，随时可能停服或不同步最新镜像，**不要当长期方案**。

**顺手排查两件事**

```bash
nslookup registry-1.docker.io      # DNS 能不能解析
docker info | grep -A3 'Registry Mirrors'   # 配了加速器却没生效？
```

> 镜像加速器（`docker.m.daocloud.io` 之类）**只加速 Docker Hub**，对 ghcr **没有作用** ——
> 别指望配了它就能拉 ghcr。它只在你确实要本地构建时（下 `node:22-alpine`）才有用：
> 绿联 `Docker → 设置 → 镜像加速` 里填一个可用地址，然后 `docker info` 确认已生效。

---

### 8.12 拉镜像被拒：`ghcr.io/... : unauthorized`

完整报错长这样：

```
✘ Image ghcr.io/sheayi/cc-ledger:latest Error  Head "https://ghcr.io/v2/sheayi/cc-ledger/manifests/latest": unauthorized   1.1s
Error response from daemon: Head "https://ghcr.io/v2/sheayi/cc-ledger/manifests/latest": unauthorized
```

**先读懂它在说什么**：`unauthorized` ＝ **GHCR 认得这个地址，但不让你匿名读**。
也就是说网络是通的、镜像名字也没写错，**问题出在「这个包是私有的」**。

> GitHub Container Registry 的包**默认就是私有**，哪怕仓库本身是公开的也一样。
> 所以第一次在 NAS 上拉，几乎必然撞这一下。

**怎么确认**（不用登录也能测）：

```bash
curl -sS "https://ghcr.io/token?scope=repository%3Asheayi%2Fcc-ledger%3Apull&service=ghcr.io"
```

- 返回 `{"errors":[{"code":"UNAUTHORIZED"...` → **私有包**，需要按下面处理；
- 返回带 `"token":"..."` → 已公开，匿名可直接拉。

**方案 A：把包改成公开（推荐，NAS 上不用存任何密钥）**

在浏览器里做，30 秒完成：

1. 打开 `https://github.com/users/SheaYi/packages`（这是**包**列表，不是仓库）
   → 点 `cc-ledger` → 右侧 **Package settings**
   （直达：`https://github.com/users/SheaYi/packages/container/cc-ledger/settings`）
2. 拉到最下面 **Danger Zone** → **Change visibility** → 选 **Public**
3. 按提示输入包名 `cc-ledger` 确认

> ⚠️ **最常见的走错路**：进了仓库的 `Settings → Danger Zone → Change repository visibility`。
> 那是**源码仓库**的可见性，跟镜像包**完全两回事**（仓库本来就是 public，改了等于没改）。
> 必须是从头像菜单进的 **Your packages**，地址里带 `/packages/` 才对。

改完回 NAS 重拉：

```bash
cd /volume1/docker/cc-ledger
docker compose pull
docker compose up -d
```

> 公开只是**允许匿名拉取**，不会泄露源码（源码在仓库里，本来就是公开的）。
> 但镜像里若打包了敏感配置才需要私有 —— 本项目镜像只有编译产物，无密钥。

**方案 B：不动可见性，在 NAS 上登录 ghcr**

1. 造一个只用来拉镜像的令牌：
   GitHub 右上角头像 → **Settings** → **Developer settings**
   → **Personal access tokens → Tokens (classic)** → **Generate new token (classic)**
   → 勾 **`read:packages`**（别的都别勾）→ 生成后复制保存（关页面就看不见了）
2. 在 NAS 上登录一次（凭据会存进 `~/.docker/config.json`，之后 `compose up` 自动带上）：

   ```bash
   docker login ghcr.io -u SheaYi
   # Password 粘贴刚才那个 PAT（输入时不显示，直接回车）
   ```

   看到 `Login Succeeded` 就成了。一行版（不推荐，密码会进 shell 历史）：

   ```bash
   echo '你的PAT' | docker login ghcr.io -u SheaYi --password-stdin
   ```

3. 重新部署：

   ```bash
   cd /volume1/docker/cc-ledger
   docker compose pull
   docker compose up -d
   ```

> 绿联网页「项目」里没有登录入口，**必须先 SSH 登录 NAS 执行一次 `docker login`**，
> 再回网页点部署 —— 登录状态是存在 NAS 上的，网页部署时会复用。

**方案 C：干脆换成 Docker Hub**

如果你已经按上一节配好了 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 两个 secret，
也可以把 compose 里的镜像换成：

```yaml
image: <你的dockerhub用户名>/cc-ledger:latest
```

Docker Hub 的个人仓库默认公开，NAS 不用登录。改完记得同步 `docker-compose.yml`
里的 `CC_IMAGE` 与 `.env`（`npm run audit:deploydoc` 会校验两处一致）。

---

## 九、日常运维速查

| 操作 | 命令 |
|---|---|
| 看实时日志 | `docker compose logs -f --tail=200` |
| 重启服务 | `docker compose restart` |
| 停止服务 | `docker compose stop` |
| 启动服务 | `docker compose start` |
| 重建镜像并更新（代码有改动后） | `docker compose up -d --build` |
| 改了 `.env` 后生效 | `docker compose up -d`（不是 restart） |
| 查看端口占用 | `ss -tlnp \| grep 3000` |
| 进入容器内部 | `docker exec -it cc-ledger sh` |
| 磁盘空间 | `df -h` / `docker system df` |

---

## 十、数据在哪、怎么备份

### 数据位置

数据是 **NAS 上的普通目录**，不是 Docker 内部卷 —— 用「文件管理」进
`Docker / cc-ledger / data` 就能看到（可能提示无权访问，因为属主是 1001，见 8.4）。

```
/volume1/docker/cc-ledger/data        ← NAS 共享文件夹里，看得见
        │  绑定挂载（compose 的 ${DATA_HOST_DIR:-./data}:/data）
        ▼
   容器内 /data
├── cc-ledger.db          主数据库（WAL 模式）
├── cc-ledger.db-wal      预写日志
├── cc-ledger.db-shm      共享内存索引
├── uploads/
│   ├── avatars/          用户头像
│   └── transactions/     账单附件（凭证图片）
└── backups/              每日 03:00 自动备份，保留 14 天
```

> **想换存放位置**（比如放到另一块盘）：在 `.env` 里加一行
> `DATA_HOST_DIR=/volume2/cc-ledger-data`，然后
> `mkdir` + `chown 1001:1001` + `docker compose up -d`。
> **改路径等于换库**：新目录是空的，旧数据要自己搬过去。

### 应用层备份（自动，一致性快照）

`ENABLE_SCHEDULER=true`（调度器总开关）且 `BACKUP_ENABLED=true`（备份任务开关，
compose 里两个都已开）时，每天 **03:00** 用
`VACUUM INTO` 生成一份**一致性完整数据库**到 `data/backups/cc-ledger-<时间戳>.db`，
保留 14 天。这是为了防「应用层逻辑错误」导致的坏数据，也是不停机备份的来源。

> `VACUUM INTO` = SQLite 自带的「导出一份干净副本」命令，
> 拿到的文件不依赖 `-wal`/`-shm`，可以单独拷走直接当数据库用。

### 宿主机层备份（建议每月手工做一次）

**记账数据丢了无法恢复。** 最稳的做法是停 5 秒、整目录打包：

```bash
mkdir -p /volume1/docker/backup
cd /volume1/docker/cc-ledger
docker compose stop
sudo tar czf /volume1/docker/backup/cc-ledger-$(date +%Y%m%d).tar.gz -C /volume1/docker/cc-ledger/data .
docker compose start
```

> **为什么要停**：SQLite 运行时数据一部分在 `-wal` 里，边跑边打包可能拿到「半截」，
> 恢复后表现为少几笔账。停容器几秒，一致性就 100% 了。
> （不能接受停机就用下一段的「不停机备份」。）

**附：不停机备份**（前提是当天自动备份已经跑过，即 `data/backups/` 有当天的 `.db`）：

```bash
cd /volume1/docker/cc-ledger/data
LATEST=$(ls -t backups/cc-ledger-*.db | head -1)
mkdir -p /volume1/docker/backup
cp "$LATEST" /volume1/docker/backup/cc-ledger-$(date +%Y%m%d).db
tar czf /volume1/docker/backup/uploads-$(date +%Y%m%d).tar.gz uploads
```

> 数据库取「已经是一致快照的那份」，附件单独打包 —— 全程不停机。
> 代价是数据库最多落后到当天 03:00。

> 无论哪种方式，都**复制一份到另一块硬盘或云盘**（同一台机器上的备份，机器坏了就一起没了）。

### 恢复

```bash
cd /volume1/docker/cc-ledger
docker compose stop
```

```bash
cd /volume1/docker/cc-ledger/data
sudo cp -a cc-ledger.db cc-ledger.db.broken-$(date +%s) 2>/dev/null || true
sudo rm -f cc-ledger.db-wal cc-ledger.db-shm
sudo tar xzf /volume1/docker/backup/cc-ledger-20261022.tar.gz -C .
sudo chown -R 1001:1001 .
```

```bash
cd /volume1/docker/cc-ledger && docker compose start
```

> 关键是**删掉 `-wal` 和 `-shm`**：这两个是预写日志，删掉后 SQLite 会自动从主库重建。
> 不删的话旧日志会和恢复的主库冲突（表现为「恢复了但还是缺数据」）。
> 第一步的 `cp` 是留一份现场，万一恢复错了还能回头。
> 最后那次 `chown` 别漏 —— tar 解出来的属主是 root，容器又写不进去了。

### 如果之前用过命名卷，数据怎么搬过来

老版本 compose 用的是命名卷 `cc-ledger-data`。改成共享文件夹后**不会自动搬数据**，
新目录是空的 —— 需要手动拷一次：

```bash
cd /volume1/docker/cc-ledger
docker compose down
```

```bash
docker volume ls | grep cc-ledger      # 先确认真实卷名，可能是 <别的目录名>_cc-ledger-data
```

```bash
sudo docker run --rm \
  -v cc-ledger_cc-ledger-data:/from:ro \
  -v /volume1/docker/cc-ledger/data:/to \
  alpine sh -c 'cp -a /from/. /to/'
```

```bash
sudo chown -R 1001:1001 /volume1/docker/cc-ledger/data
docker compose up -d
```

> 拷完先看一眼目录：应有 `cc-ledger.db`、`uploads/`、`backups/`。
> 确认账目都在之后，旧卷才可以用 `docker volume rm cc-ledger_cc-ledger-data` 删掉
> （**删之前务必先验证新目录能正常打开账本**）。

---

## 十一、安全检查清单

部署完对照检查：

- [ ] `JWT_SECRET` 是 `openssl rand -base64 48` 生成的随机值，**不是**示例值
- [ ] `PUBLIC_BASE_URL` 是真实 IP，不是 `localhost`
- [ ] `.env` 没有提交到任何代码仓库（`.dockerignore` 已排除，但传给 NAS 时别放到公开网盘）
- [ ] 容器以非 root（uid 1001）运行 —— `docker exec cc-ledger id` 应显示非 root
- [ ] `cap_drop: ALL` 保留
- [ ] 数据目录属主是 1001 —— `ls -ld /volume1/docker/cc-ledger/data` 应显示 `1001 1001`
- [ ] `data` 目录已纳入 NAS 的定期备份/快照计划（它是普通目录，套件能直接备份到）
- [ ] 3000 端口**没有**在路由器上做端口转发
- [ ] 备份至少做过一次，并验证过能打开
- [ ] SSH 用完关闭，或设了自动关闭时间

---

## 附：最快路径（熟练用户）

```bash
ssh 你的用户名@NAS_IP
```

```bash
sudo mkdir -p /volume1/docker/cc-ledger/data && cd /volume1/docker/cc-ledger
```

```bash
sudo chown -R 1001:1001 /volume1/docker/cc-ledger/data
```

（从电脑 `scp` 上传文件）

```bash
openssl rand -base64 48
```

（把密钥写进 `.env`，连同 `PUBLIC_BASE_URL`）

```bash
docker compose up -d --build
```

```bash
docker compose logs -f --tail=100
```

（`Ctrl+C` 退出日志）

```bash
curl http://127.0.0.1:3000/healthz
```

浏览器打开 `http://NAS_IP:3000` → 注册 → 记一笔 → 完成。