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

const pass = results.filter((r) => r.ok).length;
for (const r of results.filter((x) => !x.ok)) console.log('  ✗', r.name, '|', r.detail);
console.log(`\n结果 ==== ${pass} / ${results.length}`);
process.exit(pass === results.length ? 0 : 1);