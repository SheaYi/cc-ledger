/**
 * 生成 public/assets/lucide-data.js：
 * 从 src/db/seed-data.ts 与 PICKER（表单图标选择器）收集用到的 Lucide 图标名，
 * 校验每个名字在 lucide-static 中存在（拼错直接报错退出），
 * 然后输出「图标名 -> 内层 SVG」映射，供前端 ui.js 离线渲染。
 *
 * 用法：node scripts/gen-lucide.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ICONS_DIR = join(ROOT, 'node_modules', 'lucide-static', 'icons');
const SEED = join(ROOT, 'src', 'db', 'seed-data.ts');
const OUT = join(ROOT, 'public', 'assets', 'lucide-data.js');

/** 分类表单图标选择器提供的候选集（用户自建分类用） */
const PICKER = [
  'utensils', 'coffee', 'beer', 'wine', 'cookie', 'apple', 'car-front', 'bus',
  'train-front', 'plane', 'bike', 'fuel', 'house', 'building-2', 'shopping-cart',
  'shopping-bag', 'shopping-basket', 'shirt', 'footprints', 'glasses', 'gift',
  'heart', 'heart-handshake', 'baby', 'paw-print', 'bone', 'dumbbell', 'trophy',
  'tent', 'waves', 'gamepad-2', 'clapperboard', 'music', 'camera', 'book-open',
  'graduation-cap', 'pencil', 'palette', 'stethoscope', 'pill', 'heart-pulse',
  'smartphone', 'laptop', 'monitor', 'tv', 'battery-charging', 'wifi', 'cloud',
  'banknote', 'credit-card', 'wallet', 'landmark', 'piggy-bank', 'coins',
  'trending-up', 'trending-down', 'percent', 'receipt', 'briefcase', 'store',
  'printer', 'paperclip', 'megaphone', 'wrench', 'hammer', 'scissors',
  'spray-can', 'brush', 'flower-2', 'leaf', 'sun', 'moon', 'star', 'zap',
  'flame', 'droplet', 'snowflake', 'package', 'tag', 'ticket', 'users',
  'plus', 'info', 'list-filter', 'check', 'archive', 'rotate-ccw',
  /**
   * 上移 / 下移（分类排序）。
   *
   * ⚠️ 这两个**只能**在这里显式登记：脚本的图标名来自 seed 与 PICKER，
   *    不扫前端源码。分类排序按钮写了 `lucide('chevron-up')` 而库里没有它时，
   *    `lucide()` 会静默回退到 `circle-help` —— 用户看到的就是**一个问号**，
   *    而控制台没有任何报错（缺名只体现在 `data-missing-icon` 属性上）。
   */
  'chevron-up', 'chevron-down',
  /** 预算页的 `lucide('target')`：与上面同源的缺名问号问题 */
  'target',
];

/** 账户分组表单图标选择器提供的候选集（钱包台账语义，用户自建分组用） */
const GROUP_PICKER = [
  'banknote', 'banknote-x', 'landmark', 'building', 'building-2', 'house',
  'credit-card', 'card-sim', 'wallet', 'coins', 'piggy-bank', 'vault',
  'hand-coins', 'badge-dollar-sign', 'circle-dollar-sign', 'circle-percent',
  'receipt', 'calculator', 'scale', 'shield', 'gem', 'boxes', 'package',
  'briefcase', 'store', 'globe', 'smartphone', 'laptop', 'trending-up',
  'trending-down', 'link', 'ticket-percent',
];

/**
 * 界面自身的图标（不面向用户选择，而是组件语法的一部分）：
 * 记录类型的语义图标 + 列表/详情页的动作与状态图标。
 * 这些名字一旦写进视图就必须在这里登记 —— 否则 `lucide()` 会静默回退成
 * `circle-help`，界面上只会出现"问号"而不会报错（docs/13 列表页起引入）。
 */
const UI_ICONS = [
  // 六种记录类型的语义图标（列表/详情页用；与 RECORD_TYPE_LABEL 一一对应）
  'receipt', 'banknote', 'arrow-left-right', 'hand-coins', 'heart-handshake', 'scale',
  // 动作
  'ellipsis', 'pencil', 'copy', 'trash-2', 'rotate-ccw', 'undo-2', 'check', 'x',
  'filter', 'list-filter', 'search', 'calendar', 'arrow-down-up', 'eye', 'plus',
  // 状态与信息
  'clock', 'user-round', 'sticky-note', 'file-text', 'triangle-alert', 'info',
  'circle-help', 'tag', 'wallet-cards', 'book-open', 'history', 'sparkles',
];

// 1) 从种子数据收集图标名
const src = readFileSync(SEED, 'utf8');
const used = [...src.matchAll(/icon:\s*'([^']+)'/g)].map((m) => m[1]);
const names = [...new Set([...used, ...PICKER, ...GROUP_PICKER, ...UI_ICONS])].sort();

// 2) 校验存在性（lucide-static 的新旧命名都以文件名为准）
const available = new Set(readdirSync(ICONS_DIR).map((f) => f.replace(/\.svg$/, '')));
const missing = names.filter((n) => !available.has(n));
if (missing.length > 0) {
  console.error(`✗ 以下 Lucide 图标名不存在：\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

// 3) 提取内层 SVG（去掉外层 <svg> 标签；class 交给渲染方注入）
const entries = names.map((name) => {
  const svg = readFileSync(join(ICONS_DIR, `${name}.svg`), 'utf8');
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .trim()
    // 双引号会破坏 JS 单引号字符串？这里用 JSON.stringify 安全输出
    ;
  return `  ${JSON.stringify(name)}: ${JSON.stringify(inner)},`;
});

const banner = `/**
 * 自动生成：node scripts/gen-lucide.mjs
 * 来源：lucide-static（ISC License）https://lucide.dev
 * 请勿手改；新增图标后重新运行脚本。
 */
export const LUCIDE = {
${entries.join('\n')}
};
`;

writeFileSync(OUT, banner, 'utf8');
console.log(`✓ 已生成 ${OUT}`);
console.log(`  共 ${names.length} 个图标（种子引用 ${new Set(used).size} 个 + 选择器补充，已去重）`);
