/**
 * 校验工具（docs/04 §1.5：VALIDATION_ERROR + details[{field,message}]）。
 * Zod schema 与业务规则常量复用 docs/02、docs/08 的约束。
 */
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { AppError, type FieldIssue } from './errors.js';
import { LIMITS } from '../config/constants.js';

/**
 * 校验失败 → VALIDATION_ERROR（含逐字段明细）
 *
 * ## 为什么这里要**拒绝未知字段**
 *
 * Zod 的默认行为是 `strip`：schema 里没有的字段被**静默丢弃**，请求照样返回 200。
 * 后果是「前端发了、后端没接、数据一条没存、界面一片空白、没有任何报错」。
 *
 * 实测踩过：差异归因（R-02）提交时前端传了 `attributions`，而
 * `submitSchema` 漏了它 —— 提交返回 200，归因表一直是 NULL，
 * 而所有冒烟都绿（它们只断言了 HTTP 状态码）。
 *
 * 这个函数是**所有**请求校验的唯一出口，所以在这里统一改成 `strict`：
 * 未知字段直接 400，并在 message 里点名是哪个字段。
 * 「多传了一个字段」是一个必须当场暴露的开发错误，
 * 静默接受只会让它在几天后变成一个查不出来���数据缺失。
 *
 * ⚠️ 代价：客户端若发来多余字段会收到 400。这是有意的 ——
 * 契约应当是收紧的，而不是「默默接受但不用」。
 */
export function parseOrThrow<Out>(
  schema: ZodType<Out, ZodTypeDef, unknown>,
  data: unknown,
  message?: string,
): Out {
  /**
   * ⚠️ `strict()` 只存在于 `ZodObject` 上，而这里收的是抽象的 `ZodType`
   * （有些调用方传的是 `baseSchema.extend({...})` 之类，其推断类型也不统一）。
   * 所以走一次显式断言。断言是安全的：非 object schema 调用 `.strict()` 会抛，
   * 而本项目所有调用方传的都是 object schema —— 若将来有人传了别的，
   * 这里的 TypeError 会**立刻**炸在开发期，而不是留到线上。
   */
  const strictable = schema as unknown as { strict: () => ZodType<Out, ZodTypeDef, unknown> };
  const strict = (typeof strictable.strict === 'function' ? strictable.strict() : schema) as ZodType<
    Out,
    ZodTypeDef,
    unknown
  >;
  const result = strict.safeParse(data);
  if (result.success) return result.data;
  const details: FieldIssue[] = result.error.issues.map((i) => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
  }));
  // 未知字段单独给一条可操作的提示，而不是笼统的「参数校验失败」
  const unknown = details.find((d) => d.message.includes('Unrecognized key') || d.message.includes('unrecognized'));
  throw new AppError(
    'VALIDATION_ERROR',
    unknown
      ? `请求包含未知字段「${unknown.field}」。接口契约已变更，请刷新页面后重试`
      : message ?? '请求参数校验失败',
    details,
  );
}// ---------- 复用字段 ----------

export const usernameSchema = z
  .string()
  .trim()
  .min(LIMITS.USERNAME_MIN, `用户名至少 ${LIMITS.USERNAME_MIN} 位`)
  .max(LIMITS.USERNAME_MAX, `用户名最多 ${LIMITS.USERNAME_MAX} 位`)
  .regex(/^[A-Za-z0-9_]+$/, '用户名只能包含字母、数字与下划线');

/** 密码 ≥8 位且同时含字母与数字（docs/04 §2.1） */
export const passwordSchema = z
  .string()
  .min(LIMITS.PASSWORD_MIN, `密码至少 ${LIMITS.PASSWORD_MIN} 位`)
  .max(128, '密码最多 128 位')
  .regex(/[A-Za-z]/, '密码必须包含字母')
  .regex(/\d/, '密码必须包含数字');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('邮箱格式不正确')
  .max(254, '邮箱过长');

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^1[3-9]\d{9}$/, '手机号格式不正确');

export const nicknameSchema = z.string().trim().min(1, '昵称不能为空').max(32, '昵称最多 32 位');

/**
 * 清洗「显示名」类文本（账本名 / 分类名 / 标签名…）。
 *
 * ## 为什么服务端必须再洗一遍
 * 前端会即时过滤，但那只算**提前反馈** —— 接口是公开的，脚本可以直连。
 * 只靠前端过滤，等于把数据合法性押在「调用方是善意浏览器」上。
 *
 * ## 去掉什么
 * ① 控制字符（`\u0000-\u001f`、`\u007f`）：会污染 CSV / 日志，且界面不可见；
 * ② `<` `>`：显示名会进 HTML，去掉它们把 XSS 面收窄到最低；
 * ③ **行首**的 `=` `+` `-` `@`：导出成 CSV 后会被 Excel / WPS 当**公式**执行
 *    （CSV 注入）。只去掉行首，中间的连字符（如「餐饮-午餐」）保留。
 *
 * ⚠️ 不转义引号 —— 引号是正常标点，转义责任在 CSV 序列化那层
 * （`rowsToCsv()` 已按 RFC4180 处理），在这里转义会让名字里凭空多出反斜杠。
 */
export function sanitizeDisplayName(raw: string | null | undefined): string {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .replace(/^([=+\-@])/, '$1')
    .trim();
}

/** 十进制金额字符串（≤2 位小数），docs/04 §1.2 */
export const amountStringSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,2})?$/, '金额必须是最多 2 位小数的十进制字符串');

export const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/** 空串归一为 null（docs/02 §5.1 商家/对象字段约定） */
export function blankToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}
