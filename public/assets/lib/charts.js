/**
 * 报表页图表基元（手写 SVG）。
 *
 * ## 为什么自己画而不引图表库
 *
 * ① `00-DESIGN` 的视觉语言（无投影、1px 发丝线、克制配色）本来就没法靠
 *    库的默认主题实现，改主题的代码量常常超过自己画。
 * ② 记账数据的每一个点**用户都会去核对**（这是钱），库的浮点四舍五入
 *    会让「图上 30.0%」与「列表里 ¥300」对不上，而自己画可以按精确值输出。
 * ③ 体积：整套图库几百 KB，而这里只需要 7 种图。
 *
 * ## 全文件统一的五条约定
 *
 * 1. **金额不在这里格式化**。入参一律是「元」的数值或字符串，
 *    需要展示时由调用方传**已格式化**的文本 —— 因为只有调用方知道
 *    该用 `money()` 还是 `signedMoney()`。图内部只做**几何**计算。
 * 2. **所有图都接受空数据并自己渲染空态**，不返回空字符串。
 *    返回空字符串会让容器塌陷成一条白缝，而「没数据」恰恰是需要说清楚的事。
 * 3. **viewBox + width="100%"**，不在 SVG 上写死像素宽度 —— 栅格每列多宽由
 *    外层决定，SVG 只负责按比例缩放。
 * 4. **可点元素用 `<a>` / `[role=link]` + data 属性**，不挂 click 处理器。
 *    中键新标签、读屏、Tab 可达全部免费拿到，且跳转逻辑留在视图层。
 * 5. **交互提示统一走 `data-tip`**，由 `attachTips()` 一处接管
 *    （见下方「交互提示」一节）。图元自己**不**挂任何监听器 ——
 *    七种图各挂一份必然有一处漏掉键盘可达。
 *
 * ⚠️ 本文件在**模板字符串**里生成 SVG：注释里绝不能出现反引号
 *    （会把模板提前闭合 → 整页白屏，且报错行号与病灶无关）。
 */
import { esc } from '../ui.js';

/**
 * 分类色板（数据可视化专用，不是 UI 强调色）。
 *
 * ⚠️ 早先这里用的是**灰度阶梯**（ink → parchment），理由是「分类之间没有高低之分，
 * 彩虹色会暗示红色更严重」。方向没错，但落地错了：最后两级（parchment-2 /
 * parchment）在白卡上几乎与底色同色，扇区看起来像「缺了一块」，
 * 而且相邻两档在灰阶上太近，肉眼分不开。
 *
 * 现在改成 8 档「明度阶梯 + 冷暖交替」的低饱和色（定义在 tokens.css 的
 * `--c-chart-*`）：相邻两档既不同明度也不同色温，任何相邻组合都分得开，
 * 同时因为彩度低，整体仍然是克制的，不会破坏页面的近单色基调。
 * 深浅两套主题各有一组取值。
 */
export const PALETTE = [
  'var(--c-chart-1)',
  'var(--c-chart-2)',
  'var(--c-chart-3)',
  'var(--c-chart-4)',
  'var(--c-chart-5)',
  'var(--c-chart-6)',
  'var(--c-chart-7)',
  'var(--c-chart-8)',
];

/** 第 i 档分类色（超出 8 档则回绕，不会出现 undefined 导致 fill 失败） */
const tone = (i) => PALETTE[i % PALETTE.length];

/* ==================================================================== *
 * 0. 交互提示（Tooltip）
 * ==================================================================== */

/**
 * 图元的提示数据 → `data-tip` 属性。
 *
 * 为什么是 JSON 而不是拼好的 HTML：图元活在 SVG 里，属性值必须整体转义；
 * JSON 不含尖括号，转义后仍能被 `JSON.parse` 原样还原，
 * 比往属性里塞 HTML 安全得多（也就没有二次转义漏掉的风险）。
 *
 * @param {{title?:string, lines?:string[]}|null} data
 */
function tipAttr(data) {
  if (!data) return '';
  return ` data-tip="${esc(JSON.stringify(data))}"`;
}

/** 共享的提示元素：全页只有一个，避免每次渲染都往 body 里堆节点 */
let tipEl = null;
let tipGlobalsBound = false;

function ensureTip() {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'chart-tip';
  tipEl.hidden = true;
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  if (!tipGlobalsBound) {
    tipGlobalsBound = true;
    /**
     * 滚动 / 缩放时提示会「留在原地」——它挂在 body 上用 fixed 定位，
     * 图元已经滚走了而它还浮在那儿。直接收起来最省事，也不会误伤。
     */
    window.addEventListener('scroll', hideTip, { passive: true, capture: true });
    window.addEventListener('resize', hideTip, { passive: true });
  }
  return tipEl;
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

function showTip(el) {
  const raw = el.getAttribute('data-tip');
  if (!raw) {
    hideTip();
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    hideTip();
    return;
  }
  const tip = ensureTip();
  tip.innerHTML =
    (data.title ? `<span class="chart-tip__title">${esc(data.title)}</span>` : '') +
    (data.lines ?? []).map((l) => `<span class="chart-tip__line">${esc(l)}</span>`).join('');
  tip.hidden = false;
}

/**
 * 定位：先量自己的尺寸再决定往哪边放。
 *
 * 用 `position: fixed` + 视口坐标，而不是绝对定位挂进卡片 ——
 * 卡片里任何一个 `overflow: hidden`（列表型卡片就有）都会把提示裁掉，
 * 而图表恰恰经常贴着卡片边缘。
 */
function placeTip(x, y) {
  const tip = ensureTip();
  if (tip.hidden) return;
  const r = tip.getBoundingClientRect();
  const PAD = 12;
  let left = x + PAD;
  let top = y + PAD;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - PAD;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - PAD;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

/**
 * 给一棵子树接上提示交互。**只接一次**（用 dataset 记标记），
 * 之后子树怎么重建都不用重新接 —— 事件委托的收益就在这里。
 *
 * 鼠标与键盘是**两条**路径：`pointerover/move` 跟指针，
 * `focusin` 把提示钉在元素上（键盘用户没有指针坐标）。
 * 只做鼠标的图表对键盘用户等于「没有提示」。
 */
export function attachTips(root) {
  if (!root || root.dataset.tipsBound === '1') return;
  root.dataset.tipsBound = '1';

  const owner = (t) => t?.closest?.('[data-tip]') ?? null;

  root.addEventListener('pointerover', (e) => {
    const el = owner(e.target);
    if (el) showTip(el);
  });
  root.addEventListener('pointermove', (e) => {
    const el = owner(e.target);
    if (!el) {
      hideTip();
      return;
    }
    if (ensureTip().hidden) showTip(el);
    placeTip(e.clientX, e.clientY);
  });
  root.addEventListener('pointerout', (e) => {
    const el = owner(e.target);
    if (!el) return;
    // 指针在同一个图元的子节点之间移动也会触发 pointerout，用 relatedTarget 排掉
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    if (owner(e.relatedTarget)) return; // 直接挪到另一个图元上：交给它的 pointerover
    hideTip();
  });
  root.addEventListener('focusin', (e) => {
    const el = owner(e.target);
    if (!el) return;
    showTip(el);
    const r = el.getBoundingClientRect();
    placeTip(r.left + r.width / 2, r.top);
  });
  root.addEventListener('focusout', () => hideTip());
}

/* ==================================================================== *
 * 1. 通用外壳
 * ==================================================================== */

/** 空态：统一文案，调用方传 hint 说明「怎么才有数据」 */
function emptyBox(hint) {
  return `<div class="chart-empty">
    <p class="tt-caption text-muted">${esc(hint ?? '这个区间还没有数据')}</p>
  </div>`;
}

/** 数值安全化：NaN / Infinity 一律当 0，避免 SVG 属性变成 "NaN" 导致整图不渲染 */
const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 横轴标签取舍：点数多时只在均匀间隔上标注，避免标签叠成一团黑。
 *
 * 例如 30 个日点、最多标 9 个 → 间隔 4，得到 0/4/8/…/28 + 末点 29。
 * 月份 12 个、最多 12 → 全部标注。首尾永远保留（趋势的两端最该被看见）。
 *
 * ⚠️ 间隔要**向上取整到「能放下 maxLabels 个」的最小整数**，
 * 且末点只在与前一标签至少隔 `step/2` 时才补 —— 否则最后一个标签会
 * 紧贴前一个（如 30 点取 step=4 得到 0/4/…/28/29，末尾两个只差 1 格，
 * 日期轴看起来像「挤在一起」而不是等距刻度）。
 *
 * @param {number} count 数据点总数
 * @param {number} maxLabels 最多标注几个
 * @returns {Set<number>} 需要画标签的下标集合
 */
function axisLabelSet(count, maxLabels = 10) {
  if (count <= maxLabels) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = Math.ceil((count - 1) / Math.max(1, maxLabels - 1));
  const set = new Set();
  for (let i = 0; i < count; i += step) set.add(i);
  if (count - 1 - [...set].pop() >= step / 2) set.add(count - 1);
  return set;
}

/**
 * 图 + 图例的统一外壳：**图例一律靠右**（需求 2）。
 *
 * 为什么图例不放在图下面：报表页的卡片宽度是按栅格算出来的，
 * 上下排布会让「图的高度 + 图例的高度」一起挤在卡片里，
 * 项目一多就把图压扁；左右并排时图占据稳定的方形区域，
 * 图例多几行只是往下长，图的形状不变 —— 形状稳定才好横向比较。
 */
function figure(svgHtml, legendHtml) {
  return `<div class="chart-figure">
    <div class="chart-figure__plot">${svgHtml}</div>
    <div class="chart-legend">${legendHtml}</div>
  </div>`;
}

/**
 * 图例（靠右）。含**合计行**（需求 2：总金额要在图例区或图表旁）。
 *
 * 每行三格：色点 · 名称 · 金额。占比不在这里 —— 它由 tooltip 给出，
 * 而完整的占比在旁边的排行榜表里（那里有 占比 + 小计 两列）。
 * 图例再塞一列百分比，窄卡里名称就会被挤到只剩几个字。
 */
function legend(segments, total, opt) {
  const totalText = opt.totalText ?? '';
  const rows = segments
    .map((s, i) => {
      const href = !s._rest && opt.hrefOf ? opt.hrefOf(s) : null;
      const extra = opt.legendExtraOf ? opt.legendExtraOf(s) : '';
      const inner = `
        <span class="chart-legend__dot" style="background:${tone(i)}"></span>
        <span class="chart-legend__name">${esc(s.name)}</span>
        ${extra ? `<span class="chart-legend__extra tnum">${esc(extra)}</span>` : ''}
        <span class="chart-legend__val tnum">${esc(opt.valueText ? opt.valueText(s) : String(s.amount))}</span>`;
      return href
        ? `<a class="chart-legend__item is-clickable" href="${esc(href)}" data-link${tipAttr(
            opt.tipOf ? opt.tipOf(s) : null,
          )}>${inner}</a>`
        : `<div class="chart-legend__item"${tipAttr(opt.tipOf ? opt.tipOf(s) : null)}>${inner}</div>`;
    })
    .join('');

  return `<div class="chart-legend__total">
      <span class="chart-legend__total-label">${esc(opt.totalLabel ?? '合计')}</span>
      <span class="chart-legend__total-val tnum">${esc(totalText)}</span>
    </div>
    ${rows}${
      opt.footnote
        ? `<p class="tt-fine-print text-muted chart-legend__note">${esc(opt.footnote)}</p>`
        : ''
    }`;
}

/* ==================================================================== *
 * 2. 环形图（分类占比，中心显示总额）
 * ==================================================================== */

/**
 * @param {Array<{name:string, amount:string|number, id?:string}>} rows
 * @param {{centerLabel?:string, centerValue?:string, max?:number, hrefOf?:Function,
 *          tipOf?:Function, valueText?:Function}} opt
 */
export function donut(rows, opt = {}) {
  const items = (rows ?? []).filter((r) => num(r.amount) > 0);
  const total = items.reduce((a, r) => a + num(r.amount), 0);
  if (!items.length || total === 0) return emptyBox(opt.emptyHint ?? '这个区间还没有支出');

  const max = opt.max ?? 7;
  const top = items.slice(0, max);
  const rest = items.slice(max);
  const segments = rest.length
    ? [
        ...top,
        {
          name: `其他 ${rest.length} 项`,
          amount: rest.reduce((a, r) => a + num(r.amount), 0),
          _rest: true,
          // 「其他」不可点：点了会跳到一个不存在「其他分类」的筛选
        },
      ]
    : top;

  const R = 58;
  const SW = 22;
  const C = 2 * Math.PI * R;
  /**
   * 只有一项时**不画满环**。满环在没有参照物时看起来像「图没画完」，
   * 留出 8% 缺口既表达了「这就是全部」，又不会让人以为渲染失败。
   */
  const single = segments.length === 1;
  const gap = single ? C * 0.08 : 2;

  /** 逐段累加 dashoffset：每段的起点 = 之前所有段的长度之和 */
  let acc = 0;
  const arcsHtml = segments
    .map((s, i) => {
      const frac = num(s.amount) / total;
      const dash = frac * C;
      const draw = Math.max(0, dash - gap);
      const href = !s._rest && opt.hrefOf ? opt.hrefOf(s) : null;
      const el = `<circle cx="80" cy="80" r="${R}" fill="none"
        class="st-arc${href ? ' is-clickable' : ''}"
        stroke="${tone(i)}" stroke-width="${SW}"
        stroke-dasharray="${draw.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"
        transform="rotate(-90 80 80)"
        ${href ? `data-href="${esc(href)}" role="link" tabindex="0"` : ''}${tipAttr(
          opt.tipOf ? opt.tipOf(s) : null,
        )} />`;
      acc += dash;
      return el;
    })
    .join('');

  const totalText = opt.totalText ?? opt.centerValue ?? '';
  const svg = `<svg viewBox="0 0 160 160" width="160" height="160" role="img"
      aria-label="${esc(opt.centerLabel ?? '占比')}">
    ${arcsHtml}
    <text x="80" y="74" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6">${esc(
      opt.centerLabel ?? '',
    )}</text>
    <text x="80" y="94" text-anchor="middle" font-size="15" font-weight="600" fill="currentColor">${esc(
      opt.centerValue ?? totalText,
    )}</text>
  </svg>`;

  return figure(
    svg,
    legend(segments, total, {
      hrefOf: opt.hrefOf,
      tipOf: opt.tipOf,
      valueText: opt.valueText,
      totalText,
      totalLabel: opt.totalLabel ?? '支出合计',
      footnote: opt.footnote,
    }),
  );
}

/* ==================================================================== *
 * 3. 饼图（成员占比）—— 与环形图的区别是**实心**
 * ==================================================================== */

export function pie(rows, opt = {}) {
  const items = (rows ?? []).filter((r) => num(r.amount) > 0);
  const total = items.reduce((a, r) => a + num(r.amount), 0);
  if (!items.length || total === 0) return emptyBox(opt.emptyHint ?? '还没有成员支出');

  const CX = 80;
  const CY = 80;
  const R = 62;
  let start = -Math.PI / 2; // 12 点方向起
  const slices = items
    .map((r, i) => {
      const frac = num(r.amount) / total;
      const end = start + frac * Math.PI * 2;
      // 单成员占 100% 时 end-start = 2π，SVG arc 会退化成一条线 → 收 0.01 弧度
      const e = items.length === 1 ? end - 0.01 : end;
      const x1 = CX + R * Math.cos(start);
      const y1 = CY + R * Math.sin(start);
      const x2 = CX + R * Math.cos(e);
      const y2 = CY + R * Math.sin(e);
      const large = frac > 0.5 ? 1 : 0;
      const d = `M${CX},${CY} L${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R} 0 ${large} 1 ${x2.toFixed(
        2,
      )},${y2.toFixed(2)} Z`;
      const href = opt.hrefOf ? opt.hrefOf(r) : null;
      start = end;
      return `<path d="${d}" fill="${tone(i)}"
        class="st-slice${href ? ' is-clickable' : ''}"
        ${href ? `data-href="${esc(href)}" role="link" tabindex="0"` : ''}${tipAttr(
          opt.tipOf ? opt.tipOf(r) : null,
        )} />`;
    })
    .join('');

  const svg = `<svg viewBox="0 0 160 160" width="160" height="160" role="img"
      aria-label="${esc(opt.ariaLabel ?? '成员占比')}">
    ${slices}
  </svg>`;

  /** 实心饼没有中心文字，所以**合计必须在图例区**（需求 2） */
  const totalText = opt.totalText ?? (opt.valueText ? opt.valueText({ amount: total }) : String(total));

  return figure(
    svg,
    legend(items, total, {
      hrefOf: opt.hrefOf,
      tipOf: opt.tipOf,
      valueText: opt.valueText,
      legendExtraOf: opt.legendExtraOf,
      totalText,
      totalLabel: opt.totalLabel ?? '合计',
      footnote: opt.footnote,
    }),
  );
}

/* ==================================================================== *
 * 4. 分组柱状图（收入/支出双色）+ 结余折线
 * ==================================================================== */

/**
 * @param {Array<{label:string, income:number, expense:number, net?:number}>} data
 * @param {{hrefOf?:Function, tipOf?:Function, incomeColor?:string, expenseColor?:string}} opt
 */
export function groupedBars(data, opt = {}) {
  /**
   * ⚠️ **不能**过滤掉「收支都为 0」的桶。
   *
   * 过滤之后 X 轴就不等距了：1 月有数据、2 月没有、3 月有数据，
   * 画出来是相邻两根柱子 —— 看起来像连续两个月，实际跨了 3 个月。
   * 时间轴的**距离必须反映真实跨度**，否则趋势图就是在骗人。
   *
   * 所以只有「一个桶都没有」才算空态。
   */
  const rows = data ?? [];
  const hasAny = rows.some((d) => num(d.income) > 0 || num(d.expense) > 0);
  if (!rows.length || !hasAny) return emptyBox(opt.emptyHint ?? '这个区间还没有收支');

  const W = 640;
  const H = 200;
  const PAD_L = 8;
  const PAD_R = 8;
  const TOP = 12;
  const LABEL_H = 18;
  const plotH = H - TOP - LABEL_H;
  const max = Math.max(...rows.map((d) => Math.max(num(d.income), num(d.expense))), 1);
  const y = (v) => TOP + plotH * (1 - num(v) / max);
  const slot = (W - PAD_L - PAD_R) / rows.length;
  const barW = Math.min(18, slot * 0.32);

  const bars = rows
    .map((d, i) => {
      const cx = PAD_L + slot * (i + 0.5);
      const href = opt.hrefOf ? opt.hrefOf(d) : null;
      const attr = href ? `data-href="${esc(href)}" role="link" tabindex="0"` : '';
      /**
       * 每个桶外面套一个**整列高的透明矩形**作为命中区。
       * 只让两根细柱可命中时，鼠标必须精确压在柱子上才算，
       * 而「收入 0 的月份」那根柱子高度为 0 —— 根本压不到，
       * 于是那些月份的提示永远出不来（用户以为图坏了）。
       */
      return `<g class="st-bargroup${href ? ' is-clickable' : ''}" ${attr}${tipAttr(
        opt.tipOf ? opt.tipOf(d) : null,
      )}>
        <rect x="${(PAD_L + slot * i).toFixed(2)}" y="${TOP}" width="${slot.toFixed(2)}"
              height="${plotH.toFixed(2)}" fill="transparent" />
        <rect x="${(cx - barW - 1).toFixed(2)}" y="${y(d.income).toFixed(2)}"
              width="${barW.toFixed(2)}" height="${(TOP + plotH - y(d.income)).toFixed(2)}"
              fill="${opt.incomeColor ?? 'var(--c-success)'}" rx="2" />
        <rect x="${(cx + 1).toFixed(2)}" y="${y(d.expense).toFixed(2)}"
              width="${barW.toFixed(2)}" height="${(TOP + plotH - y(d.expense)).toFixed(2)}"
              fill="${opt.expenseColor ?? 'var(--c-danger)'}" rx="2" />
      </g>`;
    })
    .join('');

  /**
   * 结余折线：画在**同一比例**上会压成一条贴底的线（结余通常比收支小一个量级）。
   * 所以它单独归一化到 plotH 的中部带（±40%），并用虚线区分——
   * 它的作用是看**趋势方向**，不是读绝对值（绝对值在表格里）。
   */
  const hasNet = rows.some((d) => d.net !== undefined && d.net !== null);
  let netLine = '';
  if (hasNet && rows.length > 1) {
    const nets = rows.map((d) => num(d.net));
    const nMax = Math.max(...nets.map(Math.abs), 1);
    const ny = (v) => TOP + plotH / 2 - (v / nMax) * (plotH * 0.4);
    const pts = rows
      .map((d, i) => `${(PAD_L + slot * (i + 0.5)).toFixed(2)},${ny(d.net).toFixed(2)}`)
      .join(' ');
    netLine = `<polyline points="${pts}" fill="none" stroke="var(--c-primary)"
      stroke-width="1.6" stroke-dasharray="4 3" opacity="0.85" />`;
  }

  const labels = rows
    .map((d, i) => {
      // 点多时只标首/中/尾，否则标签会叠成一团黑
      const show =
        rows.length <= 12 || i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 8) === 0;
      if (!show) return '';
      return `<text x="${(PAD_L + slot * (i + 0.5)).toFixed(2)}" y="${H - 4}"
        text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">${esc(d.label)}</text>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
    aria-label="${esc(opt.ariaLabel ?? '收支趋势')}" preserveAspectRatio="none">
    <line x1="${PAD_L}" y1="${TOP + plotH}" x2="${W - PAD_R}" y2="${TOP + plotH}"
      stroke="currentColor" stroke-width="1" opacity="0.15" />
    ${bars}
    ${netLine}
    ${labels}
  </svg>`;
}

/* ==================================================================== *
 * 5. 单序列柱状图（星期分布）
 * ==================================================================== */

export function bars(data, opt = {}) {
  const rows = data ?? [];
  const max = Math.max(...rows.map((d) => num(d.value)), 1);
  const W = 480;
  const H = 168;
  const TOP = 12;
  const LABEL_H = 20;
  const plotH = H - TOP - LABEL_H;
  const slot = W / Math.max(rows.length, 1);
  const barW = Math.min(40, slot * 0.56);

  const rects = rows
    .map((d, i) => {
      const h = (num(d.value) / max) * plotH;
      const x = slot * i + (slot - barW) / 2;
      const href = opt.hrefOf ? opt.hrefOf(d) : null;
      return `<g class="st-bar${href ? ' is-clickable' : ''}"
        ${href ? `data-href="${esc(href)}" role="link" tabindex="0"` : ''}${tipAttr(
          opt.tipOf ? opt.tipOf(d) : null,
        )}>
        <rect x="${(slot * i).toFixed(2)}" y="${TOP}" width="${slot.toFixed(2)}"
              height="${plotH.toFixed(2)}" fill="transparent" />
        <rect x="${x.toFixed(2)}" y="${(TOP + plotH - h).toFixed(2)}"
              width="${barW.toFixed(2)}" height="${Math.max(h, d.value > 0 ? 2 : 0).toFixed(2)}"
              fill="${opt.color ?? tone(1)}" rx="3" />
      </g>`;
    })
    .join('');

  const labels = rows
    .map(
      (d, i) =>
        `<text x="${(slot * i + slot / 2).toFixed(2)}" y="${H - 6}" text-anchor="middle"
          font-size="11" fill="currentColor" opacity="${d.highlight ? '0.95' : '0.6'}"
          font-weight="${d.highlight ? '600' : '400'}">${esc(d.label)}</text>`,
    )
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
    aria-label="${esc(opt.ariaLabel ?? '分布')}">
    <line x1="0" y1="${TOP + plotH}" x2="${W}" y2="${TOP + plotH}"
      stroke="currentColor" stroke-width="1" opacity="0.15" />
    ${rects}
    ${labels}
  </svg>`;
}

/* ==================================================================== *
 * 6. 折线图（每日趋势，自动标注异常峰值）
 * ==================================================================== */

/**
 * 峰值判定：**中位数 + 2 倍四分位距**，不用「均值 + N 倍标准差」。
 *
 * 记账的日消费是重尾分布（偶尔一笔大额），均值会被那几笔拉高，
 * 于是「比均值高 2 倍」的阈值跟着水涨船高，真正的异常日反而不标。
 * 中位数与 IQR 对离群值稳健，是这类数据的正确选择。
 */
function outliers(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 4) return { threshold: Infinity };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  return { threshold: q3 + 2 * iqr };
}

/**
 * 每日趋势（折线 + 异常峰值）。
 *
 * ⚠️ 日期轴**不能**画在 SVG 里。
 *
 * 这类图要填满卡片宽度，所以 SVG 用 `preserveAspectRatio="none"` 做**非等比拉伸**
 * （宽度跟随容器、高度固定）。在 span-4 的窄卡里横向缩放只有 0.6 左右，
 * 放进 SVG 的 10px 文字会被压成 ~6px 宽的一小条，缩略后几乎不可辨 ——
 * 用户看到的就是「日期轴没显示」，而 DOM 里那些 <text> 其实一个不少。
 *
 * 所以这里把绘图区（网格 / 折线 / 数据点）与日期轴**分层**：
 *   · 上层 SVG 只放几何，怎么拉伸都无所谓（横线、折线本来就是连续的）；
 *   · 下层 `.chart-trend__axis` 用 HTML 渲染文字，按真实字号绘制，任何卡宽都清晰。
 * 刻度位置用百分比对齐：`x(i) / W` 与 SVG 的拉伸是同一线性映射，逐点对得上。
 */
export function lineChart(points, opt = {}) {
  const pts = (points ?? []).map((p) => ({
    label: p.label,
    value: num(p.value),
    raw: p,
  }));
  if (pts.length < 2) return emptyBox(opt.emptyHint ?? '数据点不足，画不出趋势');

  const W = 640;
  const H = 168;
  const PAD = 10;
  const plotH = H - PAD * 2;
  const max = Math.max(...pts.map((p) => p.value), 1);
  const stepX = (W - PAD * 2) / (pts.length - 1);
  const y = (v) => PAD + plotH * (1 - v / max);
  const x = (i) => PAD + i * stepX;

  const { threshold } = outliers(pts.map((p) => p.value));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');

  const dots = pts
    .map((p, i) => {
      const peak = p.value > threshold;
      const href = opt.hrefOf ? opt.hrefOf(p.raw) : null;
      /**
       * 峰值**不再**在图上叠一行文字：那行字同样会被非等比拉伸压扁，
       * 反而成了噪声。红点本身已经足够指认，具体是哪一天由下方日期轴
       * 与悬停提示给出（`tipOf`），信息没丢、可读性更好。
       */
      return `<g class="st-point${href ? ' is-clickable' : ''}${peak ? ' is-peak' : ''}"
        ${href ? `data-href="${esc(href)}" role="link" tabindex="0"` : ''}${tipAttr(
          opt.tipOf ? opt.tipOf(p.raw) : null,
        )}>
        <circle cx="${x(i).toFixed(2)}" cy="${y(p.value).toFixed(2)}" r="10" fill="transparent" />
        <circle cx="${x(i).toFixed(2)}" cy="${y(p.value).toFixed(2)}"
          r="${peak ? 4 : 2.2}" fill="${peak ? 'var(--c-danger)' : 'currentColor'}"
          opacity="${peak ? '1' : '0.45'}" />
      </g>`;
    })
    .join('');

  /** 两条极淡的水平网格线 + 一条稍重的底轴，给出「坐标轴」的骨架感而不喧宾夺主 */
  const gridY = [1 / 3, 2 / 3].map((f) => PAD + plotH * f);
  const grid = gridY
    .map(
      (f) =>
        `<line x1="${PAD}" y1="${f.toFixed(2)}" x2="${W - PAD}" y2="${f.toFixed(2)}" stroke="currentColor" stroke-width="1" opacity="0.07" />`,
    )
    .join('');

  /**
   * HTML 日期轴：点数多时按均匀间隔抽稀（首尾必留），
   * 首刻度左对齐、末刻度右对齐，避免文字从卡片边缘溢出去。
   */
  const labelSet = axisLabelSet(pts.length, opt.maxLabels ?? 7);
  const last = pts.length - 1;
  const ticks = [...labelSet]
    .sort((a, b) => a - b)
    .map((i) => {
      const pct = ((x(i) / W) * 100).toFixed(3);
      const edge = i === 0 ? ' is-first' : i === last ? ' is-last' : '';
      return `<span class="chart-trend__tick${edge}" style="left:${pct}%">${esc(pts[i].label)}</span>`;
    })
    .join('');

  return `<div class="chart-trend">
    <div class="chart-trend__plot">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
        aria-label="${esc(opt.ariaLabel ?? '趋势')}" preserveAspectRatio="none">
        ${grid}
        <line x1="${PAD}" y1="${PAD + plotH}" x2="${W - PAD}" y2="${PAD + plotH}"
          stroke="currentColor" stroke-width="1" opacity="0.18" />
        <path d="${path}" fill="none" stroke="${opt.color ?? 'var(--c-danger)'}" stroke-width="1.8" />
        ${dots}
      </svg>
    </div>
    <div class="chart-trend__axis" aria-hidden="true">${ticks}</div>
  </div>`;
}

/* ==================================================================== *
 * 7. 堆叠面积图（净资产构成：现金 / 储蓄 / 负债）
 * ==================================================================== */

/**
 * @param {Array<{label:string, asset:number, debt:number}>} data
 *
 * 净资产构成图（Monarch 式）：资产画成**向上的面积**、负债画成**向下的面积**，
 * 两者分置坐标轴上下两半、中间留间隙，净资产 = 资产面积顶边到负债面积顶边的距离。
 * 负债是减项，**不**正向叠在资产上（否则「总资产」会被虚增）。
 * 只画资产或负债任一 > 0 的月份；全 0 的月份本就不该出现在净资产图里。
 */
export function stackedArea(data, opt = {}) {
  // 只画有数据的月份（资产或负债任一 > 0）；全 0 的月份本就不该出现在净资产图里。
  const rows = (data ?? []).filter((d) => num(d.asset) > 0 || num(d.debt) > 0);
  if (!rows.length) return emptyBox(opt.emptyHint ?? '还没有净资产快照');

  const W = 640;
  const H = 200;
  const PAD = 8;
  const LABEL_H = 16;
  const plotH = H - PAD * 2 - LABEL_H;
  const assetMax = Math.max(...rows.map((d) => num(d.asset)), 1);
  const debtMax = Math.max(...rows.map((d) => num(d.debt)), 1);
  const stepX = rows.length > 1 ? (W - PAD * 2) / (rows.length - 1) : 0;
  const x = (i) => PAD + i * stepX;
  // 资产占上半 60%，负债占下半 32%（中间留 8% 间隔，分置两个方向）
  const DIV = PAD + plotH * 0.6;
  const GAP = plotH * 0.08;
  const yAsset = (v) => PAD + plotH * 0.6 * (1 - num(v) / assetMax);
  const yDebt = (v) => DIV + GAP + plotH * 0.32 * (num(v) / debtMax);

  const assetTop = rows.map((d, i) => `${x(i).toFixed(2)},${yAsset(num(d.asset)).toFixed(2)}`);
  const assetBase = rows.map((_, i) => `${x(i).toFixed(2)},${yAsset(0).toFixed(2)}`);
  const debtTop = rows.map((d, i) => `${x(i).toFixed(2)},${yDebt(num(d.debt)).toFixed(2)}`);
  const debtBase = rows.map((_, i) => `${x(i).toFixed(2)},${yDebt(0).toFixed(2)}`);

  /**
   * 每个时点一条**整列高的透明命中区**：面积图没有离散可点元素，
   * 不给命中区的话「悬停看某个月的数值」根本无从谈起。
   */
  const hits = rows
    .map((d, i) => {
      const w = rows.length > 1 ? stepX : W - PAD * 2;
      const left = rows.length > 1 ? x(i) - w / 2 : PAD;
      return `<rect x="${left.toFixed(2)}" y="${PAD}" width="${w.toFixed(2)}"
        height="${plotH.toFixed(2)}" fill="transparent"${tipAttr(opt.tipOf ? opt.tipOf(d) : null)} />`;
    })
    .join('');

  /**
   * 净资产线（组合图的主角）：净资产 = 资产 − 负债，落在资产半区内部、
   * 恒在资产线之下。任何时点净资产为负（负债 > 资产）时这条线会掉进
   * 下半区，反而和负债区混在一起，所以**只有全部时点净资产 ≥ 0 才画**，
   * 否则退化为纯面积对比（不丢任何信息，只是少了那根主线）。
   */
  const nets = rows.map((d) => num(d.asset) - num(d.debt));
  const allNetPos = nets.every((v) => v >= 0);
  const netLine = allNetPos
    ? `<polyline points="${nets
        .map((v, i) => `${x(i).toFixed(2)},${yAsset(v).toFixed(2)}`)
        .join(' ')}" fill="none" stroke="var(--c-primary)" stroke-width="2.4" opacity="1" />`
    : '';

  const labelSet = axisLabelSet(rows.length, 12);
  const labels = rows
    .map((d, i) =>
      labelSet.has(i)
        ? `<text x="${x(i).toFixed(2)}" y="${H - 3}" text-anchor="middle" font-size="10"
            fill="currentColor" opacity="0.6">${esc(d.label)}</text>`
        : '',
    )
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
    aria-label="${esc(opt.ariaLabel ?? '净资产趋势')}" preserveAspectRatio="none">
    <line x1="${PAD}" y1="${PAD + plotH}" x2="${W - PAD}" y2="${PAD + plotH}"
      stroke="currentColor" stroke-width="1" opacity="0.18" />
    <line x1="${PAD}" y1="${DIV.toFixed(2)}" x2="${W - PAD}" y2="${DIV.toFixed(2)}"
      stroke="currentColor" stroke-width="1" opacity="0.12" stroke-dasharray="3 3" />
    <polygon points="${assetTop.join(' ')} ${[...assetBase].reverse().join(' ')}" fill="${tone(0)}" opacity="0.10" />
    <polyline points="${assetTop.join(' ')}" fill="none" stroke="${tone(0)}" stroke-width="2.2" opacity="0.95" />
    <polygon points="${debtTop.join(' ')} ${[...debtBase].reverse().join(' ')}" fill="var(--c-danger)" opacity="0.10" />
    <polyline points="${debtTop.join(' ')}" fill="none" stroke="var(--c-danger)" stroke-width="2.2" opacity="0.9" />
    ${netLine}
    ${labels}
    ${hits}
  </svg>`;
}

/* ==================================================================== *
 * 8. 排行榜表格（分类 / 成员共用）
 * ==================================================================== */

/**
 * @param {Array<{name:string, amount:string, count:number|string, ratio:number, href?:string, dot?:string}>} rows
 *
 * 列：序号 · 色点 · 名称 · 占比条 · 金额 · 笔数 · 占比 · 小计（8 格）
 *
 * 「小计」列 = 累计占比（当前行及以上之和）。主流记账 App 都有这一列：
 * 它回答的是「前三类占了多少」，而单行占比回答不了这个问题。
 *
 * 「占比条」是这次加的：卡片改成整宽（12 栅格）后，名称列原本是 `1fr`，
 * 在 1300px 宽的卡里会把金额推到很远的地方，中间空出一大片 ——
 * 那是**失衡留白**。加一条按占比伸缩的横条后，空出来的宽度被
 * 「相对大小」这项信息填满，宽度再变也不会难看。
 */
export function rankTable(rows, opt = {}) {
  const items = rows ?? [];
  if (!items.length) return emptyBox(opt.emptyHint ?? '还没有数据');

  const maxRatio = Math.max(...items.map((r) => num(r.ratio)), 1);
  let cum = 0;
  const body = items
    .map((r, i) => {
      const ratio = num(r.ratio);
      cum += ratio;
      const href = r.href ?? (opt.hrefOf ? opt.hrefOf(r) : null);
      const open = href
        ? `<a data-href="${esc(href)}" role="link" tabindex="0" class="rank-row is-clickable"`
        : '<div class="rank-row"';
      return `${open}>
        <span class="rank-row__idx">${i + 1}</span>
        <span class="st-dot" style="background:${esc(r.dot ?? tone(i))}"></span>
        <span class="rank-row__name">${esc(r.name)}</span>
        <span class="rank-row__bar"><span class="rank-row__fill"
          style="width:${Math.max(2, (ratio / maxRatio) * 100).toFixed(1)}%;background:${esc(
            r.dot ?? tone(i),
          )}"></span></span>
        <span class="rank-row__num rank-row__num--amount tnum">${esc(
          opt.amountOf ? opt.amountOf(r) : r.amount,
        )}</span>
        <span class="rank-row__num rank-row__num--count tnum">${esc(String(r.count ?? 0))}</span>
        <span class="rank-row__num rank-row__num--ratio tnum">${esc(ratio.toFixed(1))}%</span>
        <span class="rank-row__num rank-row__num--cum tnum">${esc(cum.toFixed(1))}%</span>
      </${href ? 'a' : 'div'}>`;
    })
    .join('');

  return `<div class="rank-table">
    <div class="rank-row rank-row--head">
      <span class="rank-row__idx"></span>
      <span></span>
      <span class="rank-row__name">${esc(opt.nameTitle ?? '分类')}</span>
      <span class="rank-row__bar"></span>
      <span class="rank-row__num">金额</span>
      <span class="rank-row__num">笔数</span>
      <span class="rank-row__num">占比</span>
      <span class="rank-row__num">小计</span>
    </div>
    ${body}
  </div>`;
}
