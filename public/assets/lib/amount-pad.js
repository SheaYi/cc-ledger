/**
 * App 内金额键盘（预定态） —— 手机端专用的「计算器式」金额输入。
 *
 * ## 为什么要自己画一个
 *
 * 原生 `<input inputmode="decimal">` 唤起的是**系统数字键盘**：它在「填表单」这个场景里
 * 是最好的选择，但在记账场景里每次输入都要多两步：
 *   · 「38 + 6 + 12」这种连加，系统键盘只能先心算再输入，或者切去计算器 App 再切回来；
 *   · 小数点要靠手指精确点在九宫格的一个小键上，且在金额场景下它是最高频的按键之一。
 * 随手记、鲨鱼记账、MoneyWiz 都自己画这个键盘，原因就是这两个。
 *
 * ## 边界（很重要）
 *
 * ① **只在紧凑形态（≤1023px）启用**。桌面上实体键盘比任何自绘键盘都快，
 *    强行替换是倒退。因此本模块 `attach()` 在非紧凑形态直接返回空操作。
 * ② **不做编辑，只做产出**。键盘不直接改 `state.amount`，而是把最终数字写回 `input.value`
 *    并派发一个 `input` 事件 —— 让它和手敲完全同路（`transaction-form.js` 的
 *    `[data-money]` 管道、双算校正、草稿保存全部照常触发）。绕过既有管道 = 埋第二套真相。
 * ③ **不用 `eval` / `new Function`**。四则运算自己算（见 `evalExpr`），既是 CSP 安全，
 *    也让「1.5.2 这种非法串」能被判成 null 而不是抛异常。
 *
 * ## 浮层为什么挂在 body 上
 *
 * 记账表单活在 `.compose__card`（`overflow: hidden`）里。挂在卡片内部会被裁掉，
 * 表现为「键盘只露出一点点」（之前账单行菜单踩过同样的坑：`card--flush` 的 overflow）。
 * 挂 `document.body` 天然在层叠上下文最外层，也不用担心父级的 transform 影响 fixed。
 */
import { esc, isCompact } from '../ui.js';

/* ------------------------------------------------------------------ *
 * 表达式求值
 * ------------------------------------------------------------------ */

/**
 * 四则表达式 → 数值；非法表达式返回 `null`（**绝不抛异常**，调用方按 null 处理）。
 *
 * 只认 `[0-9] . + - × ÷` 这几种字符：任何其它字符一律判非法。
 * 「先乘除后加减」是记账场景的默认心智（`2+3×4` 应为 14，不是 20）。
 */
export function evalExpr(src) {
  if (!src) return null;
  const norm = String(src)
    .replace(/×/g, ' * ')
    .replace(/÷/g, ' / ')
    .replace(/−/g, ' - ')
    .replace(/＋/g, ' + ');
  const tokens = norm.match(/\d+(?:\.\d+)?|\.\d+|[+\-*/]/g);
  if (!tokens) return null;

  // 语法：运算符与**数字**必须严格交替，且首尾都得是数字。
  // 不校验的话 "1++2" 会在下面的乘除法循环里错位读到 NaN。
  let expectNumber = true;
  for (const t of tokens) {
    const isOp = /^[+\-*/]$/.test(t);
    if (isOp === expectNumber) return null;
    expectNumber = !expectNumber;
  }
  if (expectNumber) return null; // 以运算符结尾

  const numbers = [Number(tokens[0])];
  const operators = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const rhs = Number(tokens[i + 1]);
    if (op === '*' || op === '/') {
      const lhs = numbers.pop();
      if (op === '/' && rhs === 0) return null; // 除零 = 非法，不是 Infinity
      numbers.push(op === '*' ? lhs * rhs : lhs / rhs);
    } else {
      operators.push(op);
      numbers.push(rhs);
    }
  }

  let out = numbers[0];
  for (let i = 0; i < operators.length; i += 1) {
    out = operators[i] === '+' ? out + numbers[i + 1] : out - numbers[i + 1];
  }
  if (!Number.isFinite(out)) return null;
  return out;
}

/** 金额上限 ¥99,999,999.99（docs/13 §2.3 单笔上限）—— 键盘也不许越过它 */
const MAX_CENTS = 9999999999;

/* ------------------------------------------------------------------ *
 * 键盘本体
 * ------------------------------------------------------------------ */

const KEYS = [
  { id: 'clear', label: 'C', kind: 'fn', area: 'clear' },
  { id: 'op:÷', label: '÷', kind: 'op', area: 'div' },
  { id: 'op:×', label: '×', kind: 'op', area: 'mul' },
  { id: 'back', label: '⌫', kind: 'fn', area: 'del' },
  { id: '7', label: '7', kind: 'num', area: 'n7' },
  { id: '8', label: '8', kind: 'num', area: 'n8' },
  { id: '9', label: '9', kind: 'num', area: 'n9' },
  { id: 'op:−', label: '−', kind: 'op', area: 'sub' },
  { id: '4', label: '4', kind: 'num', area: 'n4' },
  { id: '5', label: '5', kind: 'num', area: 'n5' },
  { id: '6', label: '6', kind: 'num', area: 'n6' },
  { id: 'op:＋', label: '＋', kind: 'op', area: 'add' },
  { id: '1', label: '1', kind: 'num', area: 'n1' },
  { id: '2', label: '2', kind: 'num', area: 'n2' },
  { id: '3', label: '3', kind: 'num', area: 'n3' },
  { id: '0', label: '0', kind: 'num', area: 'n0' },
  { id: '.', label: '.', kind: 'num', area: 'dot' },
  { id: 'eq', label: '=', kind: 'eq', area: 'eq' },
];

/** 上一次输入的最后一个操作数（用于「当前操作数已有小数点 / 位数已达上限」的判断） */
function lastOperand(expr) {
  const parts = String(expr).split(/[＋−×÷]/);
  return parts[parts.length - 1] ?? '';
}

let singleton = null;

/** 键盘在 body 上只有一个实例 —— 任何时候最多一个输入框在编辑 */
function padSingleton() {
  if (singleton) return singleton;

  const root = document.createElement('div');
  root.className = 'amount-pad';
  root.id = 'cc-amount-pad';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '金额键盘');
  root.hidden = true;
  root.innerHTML = `
    <div class="amount-pad__scrim" data-role="scrim"></div>
    <div class="amount-pad__sheet">
      <div class="amount-pad__bar">
        <div class="amount-pad__readout">
          <span class="amount-pad__expr tnum" data-role="expr"></span>
          <span class="amount-pad__res tnum" data-role="res"></span>
        </div>
        <button class="amount-pad__done" type="button" data-role="done">完成</button>
      </div>
      <div class="amount-pad__grid" role="group" aria-label="数字与运算符">
        ${KEYS.map(
          (k) => `
          <button class="amount-pad__key amount-pad__key--${k.kind}" type="button"
                  style="grid-area:${k.area}" data-key="${esc(k.id)}"
                  aria-label="${esc(keyLabel(k))}">${esc(k.label)}</button>`,
        ).join('')}
      </div>
      <p class="amount-pad__hint" data-role="hint" hidden></p>
    </div>
  `;
  document.body.appendChild(root);

  const ui = {
    root,
    sheet: root.querySelector('.amount-pad__sheet'),
    expr: root.querySelector('[data-role=expr]'),
    res: root.querySelector('[data-role=res]'),
    hint: root.querySelector('[data-role=hint]'),
  };

  let target = null;
  let expr = '';
  let lastFocus = null;

  function paint() {
    ui.expr.textContent = expr || '0';
    const v = evalExpr(expr);
    ui.res.textContent = v === null ? '' : `= ${moneyText(v)}`;
    const overMax = v !== null && Math.round(Math.abs(v) * 100) > MAX_CENTS;
    ui.hint.hidden = !overMax;
    if (overMax) ui.hint.textContent = '单笔金额不能超过 ¥ 99,999,999.99';
    ui.hint.classList.toggle('is-error', overMax);
  }

  /**
   * 落值：把表达式的求值结果写回输入框。
   *
   * ⚠️ 必须派发 `input` 事件（而不是直接改 `state`）—— 见文件头的边界 ②：
   * 手敲和键盘-input 走同一条管道，双算校正与草稿才有保障。
   */
  function commitValue() {
    if (!target) return;
    const v = evalExpr(expr);
    if (v === null || Math.round(Math.abs(v) * 100) > MAX_CENTS) {
      ui.hint.hidden = false;
      ui.hint.textContent = v === null ? '这个算式还不完整' : '单笔金额不能超过 ¥ 99,999,999.99';
      return;
    }
    target.value = toAmountString(v);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function close({ commit = true } = {}) {
    if (commit) commitValue();
    /**
     * 只在「焦点此刻确实在键盘里」时才把它还给打开前的元素。
     *
     * 键盘是模态的，退出时必须交还焦点；但如果焦点**已经在别处**
     * （典型：用户直接去点「备注」那个输入框，焦点已经落在备注上），
     * 再抢回去会把用户刚点的那个输入框的焦点夺走 —— 表现是「点了一下没进去，
     * 要点第二下」。键盘该做的只是让路，不该改用户刚表达完的意图。
     */
    const active = document.activeElement;
    const focusWasInPad = Boolean(active && ui.root.contains(active));
    target?.classList.remove('is-editing');
    ui.root.classList.remove('is-open');
    document.documentElement.classList.remove('has-amount-pad');
    // 关掉动画播完再摘 DOM（180ms 与 CSS 的 --d-base 对齐）
    setTimeout(() => {
      if (!ui.root.classList.contains('is-open')) ui.root.hidden = true;
    }, 200);
    const back = target;
    target = null;
    /* 不还焦点回 input：input 一旦 focus 会立刻重新打开键盘，形成「关不掉」的死循环。 */
    if (
      focusWasInPad &&
      lastFocus &&
      document.contains(lastFocus) &&
      lastFocus !== back
    ) {
      lastFocus.focus?.();
    }
    lastFocus = null;
  }

  function open(inputEl) {
    target = inputEl;
    lastFocus = document.activeElement;
    expr = sanitizeInitial(inputEl.value);
    ui.hint.hidden = true;
    ui.root.hidden = false;
    // 强制一次 reflow，保证 transition 从「收起态」起算（否则首次打开没有动画）
    void ui.root.offsetHeight;
    ui.root.classList.add('is-open');
    document.documentElement.classList.add('has-amount-pad');
    paint();
  }

  /**
   * 焦点跑到别处就收起。
   *
   * 键盘是模态的，但**只在用户还在使用它的时候**才该模态。用户去点「备注」
   * 那个普通输入框 = 「金额这块我弄完了」；此时键盘若还压着半屏、背后还盖着
   * 一层遮罩，整页就是灰的，而且 `html.has-amount-pad` 锁着背景滚动 ——
   * 这正是「点输入框 → 页面发灰变暗、布局被挤」的来源。
   *
   * 用 `focusin`（捕获阶段）而不是给每个输入框挂监听：记账页的字段是动态的
   * （分期 / 周期补字段会插入新输入），列举不完。
   */
  document.addEventListener(
    'focusin',
    (e) => {
      if (!ui.root.classList.contains('is-open')) return;
      const el = /** @type {Node} */ (e.target);
      if (el === target) return;
      if (el && ui.root.contains(el)) return;
      close();
    },
    true,
  );

  /**
   * 兜底：目标输入框已经不在文档里（换页了），键盘却还开着。
   * 捕获阶段处理，且不拦事件 —— 这次点击照常生效，只是顺手把残留的遮罩收掉。
   */
  document.addEventListener(
    'click',
    () => {
      if (!ui.root.classList.contains('is-open')) return;
      if (target && !target.isConnected) close({ commit: false });
    },
    true,
  );

  ui.root.addEventListener('click', (e) => {
    const keyBtn = e.target.closest('[data-key]');
    if (keyBtn) {
      press(keyBtn.dataset.key);
      return;
    }
    if (e.target.closest('[data-role=done]')) {
      close();
      return;
    }
    if (e.target.closest('[data-role=scrim]')) {
      // 点遮罩 = 「就这样吧」而不是「取消」：丢掉刚输的金额是最糟的结果
      close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!target) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      press('back');
      return;
    }
    /* 物理键盘：直接放行到 press()，让人能在桌面上（>1023px 但手动 attach 的情形）
       也用得上同一套逻辑 —— 键盘之道只有一条，不能有两份实现。 */
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === '.') press('.');
    else if (e.key === '+') press('op:＋');
    else if (e.key === '-') press('op:−');
    else if (e.key === '*') press('op:×');
    else if (e.key === '/') press('op:÷');
  });

  function press(key) {
    if (!target) return;
    ui.hint.hidden = true;

    if (key === 'clear') {
      expr = '';
      paint();
      return;
    }
    if (key === 'back') {
      expr = expr.slice(0, -1);
      paint();
      return;
    }
    if (key === 'eq') {
      const v = evalExpr(expr);
      if (v === null) {
        ui.hint.hidden = false;
        ui.hint.textContent = '这个算式还不完整';
        return;
      }
      expr = toAmountString(v);
      paint();
      return;
    }
    if (key.startsWith('op:')) {
      const op = key.slice(3);
      if (!expr) return; // 不能以运算符开头：结果必然是 NaN，早于用户输完就拦掉
      if (/[＋−×÷]$/.test(expr)) {
        expr = `${expr.slice(0, -1)}${op}`; // 连按运算符 = 改主意，替换而不是追加
        paint();
        return;
      }
      push(op);
      return;
    }
    if (key === '.') {
      // 空 / 末位是运算符时先补一个前导 0：
      // 「.5」这种写法在本项目里不是合法金额（整数位不可省），
      // 但手指从 0 直接滑到 . 是常态，替用户补那一位比报错好。
      if (!expr || /[＋−×÷]$/.test(expr)) expr += '0';
      if (lastOperand(expr).includes('.')) return;
      expr += '.';
      paint();
      return;
    }
    // 数字
    const operand = lastOperand(expr);
    const [intPart, fracPart] = operand.split('.');
    if (fracPart !== undefined && fracPart.length >= 2) return; // 分是最小单位
    if (fracPart === undefined && intPart.length >= 8) return; // 8 位整数已到 9999 万
    push(key);
  }

  /** 追加字符后重画（把「×100」这类越界挡在**输入时**，而不是等到求值才发现） */
  function push(s) {
    const next = `${expr}${s}`;
    const v = evalExpr(next);
    if (v !== null && Math.round(Math.abs(v) * 100) > MAX_CENTS) {
      ui.hint.hidden = false;
      ui.hint.textContent = '单笔金额不能超过 ¥ 99,999,999.99';
      return;
    }
    expr = next;
    paint();
  }

  singleton = { open, close, root };
  return singleton;
}

function keyLabel(k) {
  if (k.id === 'back') return '退格';
  if (k.id === 'clear') return '清空';
  if (k.id === 'eq') return '计算';
  if (k.id.startsWith('op:')) return k.id.slice(3);
  return k.label;
}

/** 千分位显示（空串按 0 处理）—— 只为看清位数，不是格式化的真源 */
function moneyText(v) {
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 落值格式：两位小数、不带千分位（后端 `parseAmountToCents` 只认纯数字串） */
function toAmountString(v) {
  return Math.abs(Number(v)).toFixed(2);
}

/** 已有值作为初始表达式：去掉千分位与货币符，只保留算式能认的字符 */
function sanitizeInitial(value) {
  return String(value ?? '')
    .replace(/[,\s¥￥]/g, '')
    .slice(0, 40);
}

/**
 * 给一个金额输入框挂上 App 内键盘。
 *
 * @returns {() => void} 卸载函数
 *
 * ## 为什么要把 input 改成 readonly
 *
 * readonly 之后系统键盘不再弹出，但输入框**仍可聚焦**（disabled 不行：连 focus 都没有，
 * 读屏与表单导航会跳过它）。用户点它的语义是「我要改这个数」——由我们决定给什么界面。
 */
export function attachAmountPad(input) {
  if (!input || !isCompact()) return () => {};

  input.setAttribute('readonly', '');
  input.setAttribute('inputmode', 'none');
  input.setAttribute('aria-haspopup', 'dialog');

  const pad = padSingleton();
  const openPad = (e) => {
    e.preventDefault();
    /**
     * 主动失焦：Android Chrome 对 `readonly` 的输入框**仍可能**弹出系统键盘，
     * 于是屏幕上会同时出现两个键盘。`blur()` 不会再触发 focus 事件，
     * 所以不会形成「关掉 → 又被拉起来」的死循环。
     */
    if (document.activeElement === input) input.blur();
    input.classList.add('is-editing');
    pad.open(input);
  };

  input.addEventListener('focus', openPad);
  input.addEventListener('click', openPad);

  return () => {
    input.removeEventListener('focus', openPad);
    input.removeEventListener('click', openPad);
    input.removeAttribute('readonly');
    input.removeAttribute('inputmode');
    input.removeAttribute('aria-haspopup');
  };
}
