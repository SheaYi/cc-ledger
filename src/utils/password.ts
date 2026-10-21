/**
 * 密码哈希（docs/01 §3.3：argon2id）。
 *
 * 首选 @node-rs/argon2（napi-rs 预编译，无需本地编译工具链）。
 * 若该原生模块在当前平台不可用，自动降级为 node:crypto scrypt —— 
 * 两者都以 `algo$...` 前缀自描述，校验时按前缀分派，未来可在登录时静默升级。
 */
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

type Argon2Module = {
  hash(password: string, options?: Record<string, unknown>): Promise<string>;
  verify(hashed: string, password: string): Promise<boolean>;
  Algorithm: { Argon2id: number };
};

let argon2: Argon2Module | null = null;
let argon2Probed = false;
let argon2DisabledReason = '';

async function getArgon2(): Promise<Argon2Module | null> {
  if (argon2Probed) return argon2;
  argon2Probed = true;
  try {
    const mod = (await import('@node-rs/argon2')) as unknown as Argon2Module;
    // 探针：确认原生二进制在当前平台真的可加载
    const probe = await mod.hash('probe', { algorithm: mod.Algorithm.Argon2id });
    if (!(await mod.verify(probe, 'probe'))) throw new Error('argon2 自检失败');
    argon2 = mod;
  } catch (e) {
    argon2 = null;
    argon2DisabledReason = e instanceof Error ? e.message : String(e);
  }
  return argon2;
}

/** argon2id 参数（OWASP 推荐档位） */
const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password.normalize('NFKC'),
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

async function scryptHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function scryptVerify(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const salt = Buffer.from(parts[2]!, 'base64');
  const expected = Buffer.from(parts[3]!, 'base64');
  const actual = await scryptAsync(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 生成密码哈希 */
export async function hashPassword(password: string): Promise<string> {
  const mod = await getArgon2();
  if (mod) {
    return mod.hash(password.normalize('NFKC'), {
      algorithm: mod.Algorithm.Argon2id,
      ...ARGON2_OPTIONS,
    });
  }
  return scryptHash(password);
}

/** 校验密码（按哈希前缀分派算法） */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) return scryptVerify(stored, password);
  const mod = await getArgon2();
  if (!mod) {
    // 库中存的是 argon2 哈希但当前环境无法加载 → 拒绝（不可降级为放行）
    return false;
  }
  try {
    return await mod.verify(stored, password.normalize('NFKC'));
  } catch {
    return false;
  }
}

/** 当前生效的密码算法（供 /healthz 与诊断日志） */
export async function passwordAlgorithm(): Promise<string> {
  const mod = await getArgon2();
  return mod ? 'argon2id' : `scrypt (argon2 不可用: ${argon2DisabledReason})`;
}
