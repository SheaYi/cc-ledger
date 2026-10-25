/**
 * 手机端截图（390 × 844）
 *
 * 用途：只看「手机长什么样」。它不断言业务口径（那是各探针的事），
 * 只负责把五个 Tab 页在真实数据下拍出来，改样式前后各跑一次对比。
 *
 * 用法：
 *   node scripts/shot-mobile.mjs            # 亮色
 *   node scripts/shot-mobile.mjs dark       # 暗色
 *   node scripts/shot-mobile.mjs light out2 # 指定子目录
 *
 * 种子用户缓存在系统临时目录，避免每次注册（注册限流 3 次/小时）。
 */
import { join } from 'node:path';
import { connect } from './lib/cdp.mjs';
import { seed } from './lib/mobile-seed.mjs';

const BASE = 'http://127.0.0.1:3000';
const THEME = process.argv[2] === 'dark' ? 'dark' : 'light';
const SUBDIR = process.argv[3] ?? 'mobile';
const OUT = join(process.cwd(), 'screenshots', SUBDIR);

const W = 390;
const H = 844;

const s = await seed();
console.log(`种子就绪：账本 ${s.ledgerId}`);

const probe = await connect({ base: BASE });
const { ev, wipe, authInjector, open, shot } = probe;

await wipe();
/** `arm` 必须由 authInjector 提供：它自己会先落到同源静态页再注入，
 *  在 about:blank 上写 localStorage 会直接抛 SecurityError。 */
const auth = authInjector({ token: s.token });

/** [文件名, 路径, 等待选择器, 第二张：滚到哪个区域再拍] */
const PAGES = [
  ['accounts', '/accounts', '.page__hero', '.acct-row'],
  ['transactions', '/transactions', '.page__hero', '.tx-day'],
  ['compose', '/transactions/new', '.compose__card', '.action-bar'],
  ['stats', '/stats', '.page__hero', '.st-grid'],
  ['settings', '/settings', '.page__hero', '.section'],
];

for (const [name, path, wait, focus] of PAGES) {
  await open(path, { wait, width: W, height: H, mobile: true, theme: THEME, arm: auth.arm });
  const p = await shot(`${THEME}-${name}`, { dir: OUT });
  console.log('  →', p);
  if (focus) {
    const p2 = await shot(`${THEME}-${name}-2`, { dir: OUT, focus });
    console.log('  →', p2);
  }
}

// TabBar 特写（滚到底部拍一条）
await open('/transactions', { wait: '.tabbar', width: W, height: H, mobile: true, theme: THEME, arm: auth.arm });
await ev(`window.scrollTo(0, document.body.scrollHeight); true`);
await new Promise((r) => setTimeout(r, 600));
console.log('  →', await shot(`${THEME}-tabbar`, { dir: OUT }));

probe.close();
console.log('\n输出目录：', OUT);
