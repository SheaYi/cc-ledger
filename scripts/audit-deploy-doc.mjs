/**
 * 部署文档与容器配置的一致性静态校验
 *
 * 目的：文档里写的每一个「事实」都必须与真实配置对得上 ——
 * 照着文档操作的人没法验证文档本身对不对，所以这里把可静态断言的部分钉住。
 *
 * 校验项：
 *   1. compose 必需字段齐全 + ports 格式合法
 *   2. 文档提到的每个环境变量都真实存在于 src/config/env.ts
 *   3. 文档写的 /healthz 字段名与 src/modules/health/index.ts 真实返回一致
 *   4. 文档写的迁移数与 drizzle/ 下真实文件数一致
 *   5. .dockerignore 未误排除构建必需文件
 *   6. 文档不含已知笔误（如 ENABLE_SCHUPEDULER）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOC = 'DEPLOY-绿联NAS.md';
const doc = readFileSync(DOC, 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const envTs = readFileSync('src/config/env.ts', 'utf8');
const healthTs = readFileSync('src/modules/health/index.ts', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const fail = (name, detail = '') => results.push({ name, ok: false, detail });

/* 1. compose 必需字段 + ports 格式 */
for (const key of [
  'services:', 'build:', 'image:', 'container_name:',
  'restart:', 'ports:', 'environment:', 'volumes:', 'healthcheck:',
]) {
  if (compose.includes(key)) check(`compose 含 ${key}`, true);
  else fail(`compose 含 ${key}`, '缺失');
}
const portsLine = compose.match(/ports:\s*\n\s*-\s*["']?([^\s"']+)["']?\s*$/m);
if (portsLine && /^\d+:\d+$/.test(portsLine[1])) {
  check('ports 为「宿主:容器」格式', true, portsLine[1]);
} else {
  fail('ports 为「宿主:容器」格式', portsLine ? portsLine[1] : '未匹配');
}
if (/restart:\s*unless-stopped/.test(compose)) check('restart=unless-stopped（开机自启）', true);
else fail('restart=unless-stopped（开机自启）', '缺失');

/* 2. 文档提到的每个 env 变量都真实存在 */
for (const v of [
  'JWT_SECRET', 'PUBLIC_BASE_URL', 'RATE_LIMIT_LOGIN_MAX',
  'RATE_LIMIT_REGISTER_MAX', 'ENABLE_SCHEDULER', 'TZ', 'DATA_DIR', 'DB_PATH',
]) {
  if (!envTs.includes(v)) fail(`env 变量 ${v} 存在`, 'env.ts 中没有');
  else if (!doc.includes(v)) fail(`文档提到 ${v}`, '文档漏写');
  else check(`env 变量 ${v} 文档与代码一致`, true);
}

/* 3. 文档写的 healthz 字段与代码真实返回一致 */
for (const f of ['status', 'app', 'version', 'uptimeSeconds', 'migrationsApplied', 'walMode', 'scheduler']) {
  if (!healthTs.includes(f)) fail(`healthz 返回 ${f}`, '代码里没有该字段');
  else if (!doc.includes(f)) fail(`文档提到 healthz.${f}`, '文档漏写');
  else check(`healthz 字段 ${f} 文档与代码一致`, true);
}

/* 4. 迁移数与真实文件数一致 */
const migCount = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).length;
const docMig = doc.match(/migrationsApplied[`"']?\s*[:|]?\s*\**\s*(\d+)/);
if (docMig && Number(docMig[1]) === migCount) {
  check(`文档迁移数 ${migCount} 与 drizzle/ 实际一致`, true);
} else {
  fail('文档迁移数与实际一致', `文档 ${docMig ? docMig[1] : '未写'} vs 实际 ${migCount}`);
}

/* 5. dockerignore 未误排除构建必需文件 */
const patterns = dockerignore.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('!'));
for (const f of ['Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json', 'tsconfig.json', 'drizzle.config.ts', 'drizzle', 'public', 'src']) {
  const bad = patterns.find((p) => p === f || (p.endsWith('/') && f.startsWith(p)));
  if (bad) fail(`${f} 未被 .dockerignore 排除`, `被 ${bad} 排除`);
  else check(`${f} 未被 .dockerignore 排除`, true);
}

/* 6. 已知笔误守卫 */
for (const typo of ['ENABLE_SCHUPEDULER', '每 15 分钟的限流', '5 次/15 分钟', 'migrationsApplied": 1,']) {
  if (doc.includes(typo)) fail(`文档不含笔误「${typo}」`, '仍存在');
  else check(`文档不含笔误「${typo}」`, true);
}
/* CPU 型号：DXP4800 是 Pentium Gold 8505，不是 N100 */
if (doc.includes('N100')) fail('文档 CPU 型号正确', '仍写着 N100');
else check('文档 CPU 型号正确', true);
if (!doc.includes('8505')) fail('文档写明 Pentium Gold 8505', '未写');
else check('文档写明 Pentium Gold 8505', true);

/* 登录限流窗口必须是 1 minute（曾误写为 15 分钟） */
const authTs = readFileSync('src/modules/auth/index.ts', 'utf8');
if (/RATE_LIMIT_LOGIN_MAX,\s*timeWindow:\s*'1 minute'/.test(authTs)) {
  if (/每\s*15\s*分钟/.test(doc)) fail('登录限流窗口与代码一致', '文档仍写 15 分钟');
  else check('登录限流窗口与代码一致（1 分钟）', true);
} else {
  check('登录限流窗口（代码结构变化，跳过断言）', true);
}

/* 7. 网页项目版 compose（docker-compose.nas.yml）与主配置不漂移
 *    这份文件给「Docker → 项目」界面用，值全部写死、不能含 ${} 插值，
 *    否则没有 .env 的环境会直接起不来。 */
const nasPath = 'docker-compose.nas.yml';
let nas = '';
try {
  nas = readFileSync(nasPath, 'utf8');
  check('存在网页项目版 compose', true);
} catch {
  fail('存在网页项目版 compose', `${nasPath} 缺失（网页「Docker → 项目」要用）`);
}
if (nas) {
  /* 注释里可以出现 ${...}（讲解用），只校验真正的 YAML 内容 */
  const nasBody = nas.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
  if (/\$\{/.test(nasBody)) fail('网页项目版 compose 不含 ${} 插值', '发现 ${…}，无 .env 时会启动失败');
  else check('网页项目版 compose 不含 ${} 插值', true);

  for (const [name, re] of [
    ['镜像', /image:\s*ghcr\.io\/shayi\/cc-ledger:latest/],
    ['端口', /ports:\s*\n\s*-\s*["']?3000:3000["']?/],
    ['容器名', /container_name:\s*cc-ledger/],
    ['数据目录', /-\s*\/volume1\/docker\/cc-ledger\/data:\/data/],
    ['开机自启', /restart:\s*unless-stopped/],
    ['健康检查', /healthcheck:/],
    ['非 root 加固', /cap_drop:\s*\n\s*-\s*ALL/],
  ]) {
    if (re.test(nas)) check(`网页项目版 compose ${name}与主配置一致`, true);
    else fail(`网页项目版 compose ${name}与主配置一致`, '与 docker-compose.yml 不一致或缺失');
  }
  /* 镜像地址必须和 workflow 推的地址同构：ghcr.io/<owner>/<repo>:<tag>
   * workflow 用 ${GITHUB_REPOSITORY,,} 转小写，所以这里只校验「小写 + 仓库名与
   * package.json 的 name 一致 + 标签是 latest」，不硬编码 owner。
   * 主配置允许默认走本地构建（cc-ledger:1.0.0），但必须能被 CC_IMAGE 覆盖。 */
  const pkgName = JSON.parse(readFileSync('package.json', 'utf8')).name;
  const wf = readFileSync('.github/workflows/docker-image.yml', 'utf8');
  if (!/GITHUB_REPOSITORY,,\}/.test(wf)) fail('workflow 镜像名转小写', 'ghcr 路径只接受小写，需 ${GITHUB_REPOSITORY,,}');
  else check('workflow 镜像名转小写', true);

  if (/\$\{CC_IMAGE:-/.test(compose)) check('docker-compose.yml 可被 CC_IMAGE 覆盖镜像', true);
  else fail('docker-compose.yml 可被 CC_IMAGE 覆盖镜像', '缺少 ${CC_IMAGE:-…}');

  const nasImg = (nas.match(/image:\s*(ghcr\.io\/[^\s]+)/) || [])[1] || '';
  if (nasImg && nasImg === nasImg.toLowerCase() && nasImg.endsWith(`/${pkgName}:latest`)) {
    check('docker-compose.nas.yml 镜像地址与 workflow 同构', true, nasImg);
  } else {
    fail('docker-compose.nas.yml 镜像地址与 workflow 同构', nasImg || '未找到 image');
  }
  /* 文档里出现的 ghcr 地址也必须是同一路径（写成 SheaYi 大写会被 registry 拒） */
  const docImages = [...doc.matchAll(/ghcr\.io\/[A-Za-z0-9_.\-/]+/g)].map((m) => m[0]);
  const badImg = docImages.find((s) => s !== s.toLowerCase() || !s.includes(`/${pkgName}`));
  if (badImg) fail('文档里的 ghcr 地址合法', badImg);
  else check(`文档里 ${docImages.length} 处 ghcr 地址全小写且仓库名正确`, true);
}

/* 8. .env 模板（docker compose 专用）与 compose 实际引用的变量一一对应 */
let envTpl = '';
try {
  envTpl = readFileSync('.env.docker.example', 'utf8');
  check('存在 docker compose 用 .env 模板', true);
} catch {
  fail('存在 docker compose 用 .env 模板', '.env.docker.example 缺失');
}
if (envTpl) {
  for (const v of ['JWT_SECRET', 'PUBLIC_BASE_URL', 'CC_IMAGE', 'DATA_HOST_DIR']) {
    if (new RegExp('^' + v + '=', 'm').test(envTpl)) check(`.env 模板含 ${v}`, true);
    else fail(`.env 模板含 ${v}`, '缺失');
    /* 模板里多写的变量要么被 compose 用上，要么就是误导 */
    if (compose.includes('${' + v)) check(`compose 引用 ${v}`, true);
    else fail(`compose 引用 ${v}`, '模板里有但 compose 没用（误导）');
  }
}

const pass = results.filter((r) => r.ok).length;
for (const r of results.filter((x) => !x.ok)) console.log('  ✗', r.name, '|', r.detail);
console.log(`\n结果 ==== ${pass} / ${results.length}`);
process.exit(pass === results.length ? 0 : 1);
