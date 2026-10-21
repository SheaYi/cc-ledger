/**
 * 前端模板字符串守卫：**注释里不许出现反引号**。
 *
 * ## 为什么需要它
 *
 * 零构建前端里，一个语法错误 = 整页白屏，而 tsc / vitest / audit:imports
 * **全都抓不到**（它们只覆盖 src/）。本项目已经因此**三次**返工，
 * 而错误信息指向的位置在**几十行之后**（真正提前闭合的模板早就开了），
 * 报错行号与病灶行号毫无关系 —— 手工排查一次要十几分钟。
 *
 * ⚠️ 本文件自身的注释里也绝不能出现反引号 —— 它检查的就是这个。
 *    （写这条注释时我恰好踩了一次，被自己写的闸门之外的 node --check 挡住。）
 *
 * ## 检查规则
 *
 * 只在「已经进入某个模板字符串或 HTML 注释」之后出现的反引号才危险。
 * 文件顶部的 JSDoc 用的是普通块注释，里面的反引号是代码引用（合法）。
 *
 * 状态机跟踪四种上下文：
 *   · 反引号 → 进入模板；下一个未转义的反引号收尾
 *   · 注释标记 → 进入 htmlcomment；--> 收尾
 *   · 转义序列 → 整体跳过
 *
 * 代价：不是完整的 JS 词法分析（不区分正则字面量、字符串里的标记），
 * 但那些场景在本项目的视图文件里不存在，而**误报会让人开始忽略这个闸门** ——
 * 一个常红的闸门等于没有闸门（与 audit:routes 的「方法未标注」同一教训）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'public/assets';
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(ROOT);

const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let i = 0;
  let line = 1;
  let ctx = null; // {kind:'template'|'htmlcomment', line:number}
  const bump = (from, to) => {
    for (let k = from; k < to; k++) if (src[k] === '\n') line += 1;
  };

  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];

    if (ch === '\n') {
      line += 1;
      // 行注释到行尾结束；但若正在模板内，行尾不结束模板
      if (ctx?.kind === 'linecomment') ctx = null;
      i += 1;
      continue;
    }

    if (ch === '/' && nx === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      // // 只在**不在模板内**时才是注释（模板内 // 是纯文本）；
      // 而行注释里的反引号**合法**（那是代码引用），所以不进 ctx。
      if (ctx?.kind !== 'template' && ctx?.kind !== 'htmlcomment') {
        bump(i, stop);
        i = stop;
        continue;
      }
      bump(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && nx === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      // 模板内的 /* */ 是纯文本，不能当注释起点（会吃掉真正的病灶）
      if (!ctx) {
        bump(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === '<' && src.startsWith('<!--', i)) {
      // HTML 注释只在**模板内**危险：它出现在模板里时，它的反引号会让模板提前闭合。
      // 模板外的 HTML 注释（真实 DOM 的注释节点）完全无害。
      if (ctx?.kind === 'template') {
        ctx = { kind: 'htmlcomment', line };
        bump(i, i + 4);
        i += 4;
        continue;
      }
    }

    if (ch === '-' && ctx?.kind === 'htmlcomment' && src.startsWith('-->', i)) {
      ctx = null;
      bump(i, i + 3);
      i += 3;
      continue;
    }

    if (ch === '`') {
      if (ctx?.kind === 'template') {
        ctx = null; // 模板正常收尾
        i += 1;
        continue;
      }
      if (ctx?.kind === 'htmlcomment' || ctx?.kind === 'jscomment') {
        problems.push({
          file,
          line,
          kind: ctx.kind,
          fromLine: ctx.line,
        });
        ctx = null; // 视为模板闭合，继续往下扫
        i += 1;
        continue;
      }
      ctx = { kind: 'template', line };
      i += 1;
      continue;
    }

    if (ch === '\\') {
      i += 2; // 转义序列整体跳过
      continue;
    }
    i += 1;
  }
}

console.log('模板反引号守卫：' + files.length + ' 个文件');
if (!problems.length) {
  console.log('  ✓ 注释内无反引号');
  process.exit(0);
}
for (const p of problems) {
  console.log(
    `  ✗ ${p.file}:${p.line}  ${p.kind} 起于第 ${p.fromLine} 行 —— ` +
      '注释里的反引号会让模板提前闭合，整页白屏',
  );
}
console.log(
  '\n修法：把注释里的代码引用改成引号（说 mode 而不是写 mode），' +
    '或把该注释移到模板字符串之外。',
);
process.exit(1);
