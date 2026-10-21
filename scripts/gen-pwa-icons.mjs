/**
 * 生成 PWA 图标（public/icons/）。
 *
 * 为什么需要 PNG：Chrome 的安装判定（installability）要求 manifest 里至少有一个
 * 192 和一个 512 的 **PNG** 图标，SVG 图标能显示但不满足安装条件
 * （docs/09 §4.1「Lighthouse PWA ≥ 90」）。favicon 那套 SVG 方案在这里不够用。
 *
 * 字形方案：**不依赖字体**。jimp 1.6 已移除 TTF 支持（loadFont 只吃 bitmap .fnt），
 * 而为一个图标引入 opentype.js + 自写光栅化器不成比例。字母 C 本身就是
 * 「粗圆环挖掉右侧一段」，用像素级距离场判定即可，任何尺寸都是真圆弧。
 * 抗锯齿用 2× 超采样 + resize（比手写 alpha 混合简单且足够好）。
 *
 * 设计与 favicon 同源：主色 `--c-primary` #0066cc 底 + 白色「CC」。
 * maskable 版**不画圆角**：Android 自适应图标会裁掉外圈，只有中心 80% 安全区
 * 保证可见（docs/09 §4.1 的图标设计约束），圆角会被切掉一角。
 *
 * 用法：`npm run icons`。幂等，可反复执行，跨平台（无字体路径依赖）。
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

/** 与 public/assets/tokens.css 的 --c-primary（日间）一致；图标是静态资产，不随主题切换 */
const BRAND = 0x0066ccff;
const WHITE = 0xffffffff;
const CLEAR = 0x00000000;

/** C 的右侧开口半角（度）—— 太小像 O，太大像括号 */
const OPEN_HALF_DEG = 38;
/** 环厚 / 外径：粗体感 */
const THICKNESS_RATIO = 0.34;
/** 两个 C 的间距 / 外径 */
const GAP_RATIO = 0.3;
/** 超采样倍数：抗锯齿 */
const SS = 2;

const OPEN_COS = Math.cos((OPEN_HALF_DEG * Math.PI) / 180);

/**
 * 画一个字母 C（白色粗环挖右口）。
 * 距离场判定：`R-t ≤ dist ≤ R` 为环，开口内（`cos(angle) > OPEN_COS`）挖掉。
 */
function drawC(img, cx, cy, R) {
  const t = R * THICKNESS_RATIO;
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > R || dist < R - t) return;
    // 开口朝右：只看右半平面的角度（atan2 在开口范围内时 cos > OPEN_COS）
    if (dx > 0 && dx / dist > OPEN_COS) return;
    img.setPixelColor(WHITE, x, y);
  });
}

/** 圆角方块：圆角之外的像素清成透明 */
function roundedRect(img, radius) {
  const { width: w, height: h } = img.bitmap;
  img.scan(0, 0, w, h, (x, y) => {
    const inCorner =
      (x < radius && y < radius && (radius - x) ** 2 + (radius - y) ** 2 > radius ** 2) ||
      (x >= w - radius && y < radius && (x - (w - radius)) ** 2 + (radius - y) ** 2 > radius ** 2) ||
      (x < radius && y >= h - radius && (radius - x) ** 2 + (y - (h - radius)) ** 2 > radius ** 2) ||
      (x >= w - radius && y >= h - radius &&
        (x - (w - radius)) ** 2 + (y - (h - radius)) ** 2 > radius ** 2);
    if (inCorner) img.setPixelColor(CLEAR, x, y);
  });
}

/**
 * @param size 目标边长
 * @param mode 'brand' 圆角方块底（favicon 同款）｜ 'full' 满铺底（maskable）｜
 *             'square' 无圆角方底（iOS apple-touch-icon，系统自己加圆角）
 */
async function makeIcon(size, mode) {
  const big = size * SS;
  const img = new Jimp({ width: big, height: big, color: BRAND });

  // 作画区：圆角版要为圆角留边；maskable 只用中心 80% 安全区
  const content = mode === 'full' ? big * 0.8 : big * 0.88;
  const R = (content * 0.25) / (2 * (1 + GAP_RATIO / 2)); // 两个 C + 间距的总宽 ≈ content×0.5
  const gap = R * GAP_RATIO;
  const cy = big / 2;
  drawC(img, big / 2 - (R + gap / 2), cy, R);
  drawC(img, big / 2 + (R + gap / 2), cy, R);

  if (mode === 'brand') roundedRect(img, Math.round(big * 0.22));
  // jimp 1.6 的 resize 只吃 options 对象（位置参数会走 zod 校验并抛 invalid_union）
  return img.resize({ w: size, h: size });
}

mkdirSync(OUT_DIR, { recursive: true });

const jobs = [
  ['icon-192.png', 192, 'brand'],
  ['icon-512.png', 512, 'brand'],
  ['icon-maskable-192.png', 192, 'full'],
  ['icon-maskable-512.png', 512, 'full'],
  // iOS 不支持 manifest 的 shortcuts，但认 apple-touch-icon；系统自行加圆角，故给方图
  ['apple-touch-icon.png', 180, 'square'],
];

for (const [name, size, mode] of jobs) {
  const img = await makeIcon(size, mode);
  // jimp 1.6 没有 writeAsync：取 buffer 再落盘（顺带能在日志里报出字节数）
  const buf = await img.getBuffer('image/png');
  await writeFile(join(OUT_DIR, name), buf);
  console.log(`  ✓ ${name} (${size}×${size}, ${mode}, ${buf.length} B)`);
}
console.log('图标已生成到 public/icons/');
