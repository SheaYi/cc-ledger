/**
 * 数据导入（`docs/05 §十四`，ADR-D11 定为 P0）。
 *
 * ## 三步流程与「为什么文件要传两次」
 *
 * ① 选文件 → `POST /import/preview`（**不传映射**，服务端按表头猜）
 * ② 用户在校对表里改映射 → 再点「刷新预览」看改动的效果
 * ③ 确认无误 → `POST /import/commit`
 *
 * 文件持有在**浏览器**里，服务端不落临时文件。所以第 ③ 步要再传一次同一个文件。
 * 代价是用户选两次文件？不 —— 这里持有的是同一个 `File` 对象，两次读它不用重选。
 *
 * ## 这一页最容易骗用户的地方
 *
 * 「成功 3 行、失败 3 行」里的**失败行必须能点开看到行号 + 原值 + 原因**。
 * 只给一个总数的话，用户唯一的动作就是「把整个文件重做一遍」——
 * 而重做还是会撞上同一行。只给数字的导入报告比不给更糟。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { applyFieldErrors, esc, h, icon, lucide, money, setLoading, toast, RECORD_TYPE_LABEL } from '../ui.js';
import { downloadTextFile } from '../lib/download.js';

/**
 * 映射表单的**字段槽**（标准字段 → 文档列）。
 *
 * ⚠️ 顺序与 `src/modules/imports/service.ts` 的 `IMPORT_COLUMN_FIELDS` **逐项一致**，
 *    前端只负责渲染，不另定义「哪几列能映射」。此前前端、后端、模板三处各写一份，
 *    正是「映射错乱 / 字段遗漏」的根因。
 */
const MAPPING_FIELDS = [
  { key: 'dateColumn', label: '日期列', required: true, hint: '账单日期取这一列' },
  { key: 'amountColumn', label: '金额列', required: true, hint: '账单金额取这一列（导入取绝对值，正负由类型决定）' },
  { key: 'recordTypeColumn', label: '类型列', hint: '留空则整份文件按下方「默认记录类型」入账' },
  { key: 'accountColumn', label: '账户列', hint: '每行按这一列的账户名入账；留空或该行没有值，才记到下方「导入到哪个账户」' },
  { key: 'timeColumn', label: '时间列', hint: '留空则记账时间为当日 00:00:00' },
  { key: 'nameColumn', label: '名称列', hint: '按这一列原样写入账单名称；留空则名称为空（不再取商家兜底）' },
  { key: 'mainCategoryColumn', label: '主类别列', hint: '留空则走自动分类规则，再退回兜底分类' },
  { key: 'subCategoryColumn', label: '子类别列', hint: '留空则沿「主类别」的兜底链路' },
  { key: 'merchantColumn', label: '商家列', hint: '按这一列原样写入；只取值，不参与自动分类规则匹配；留空则账单无商家' },
  { key: 'counterpartyColumn', label: '对象列', hint: '留空则账单无往来对象' },
  { key: 'feeColumn', label: '手续费列', hint: '留空则按 0 处理' },
  { key: 'discountColumn', label: '折扣列', hint: '留空则按 0 处理' },
  { key: 'tagsColumn', label: '标签列', hint: '留空则无标签；按这一列原样写入，账本里没有的同名标签会自动新建' },
  { key: 'noteColumn', label: '备注列', hint: '按这一列原样写入；只取值，不参与自动分类规则匹配；留空则账单无备注' },
];

/** 列字段键清单：从渲染清单派生，不另写一份（避免两处漂移） */
const IMPORT_FIELD_KEYS = MAPPING_FIELDS.map((f) => f.key);

const KIND_LABEL = {
  text: '文本',
  date: '日期',
  time: '时间',
  money: '金额（元）',
  enum: '枚举',
  ref: '引用',
};
/**
 * 标准字段 → 中文名。
 *
 * ⚠️ 键集合必须覆盖 `MAPPING_FIELDS` 的全部键 —— 少了会在对照表里
 *    显示成英文键名（`recordTypeColumn`），是「看起来像没做完」的典型。
 */
const FIELD_LABEL = {
  dateColumn: '日期',
  amountColumn: '金额',
  recordTypeColumn: '类型',
  accountColumn: '账户',
  directionColumn: '收支',
  timeColumn: '时间',
  nameColumn: '名称',
  mainCategoryColumn: '主类别',
  subCategoryColumn: '子类别',
  merchantColumn: '商家',
  counterpartyColumn: '对象',
  feeColumn: '手续费',
  discountColumn: '折扣',
  tagsColumn: '标签',
  noteColumn: '备注',
};

export async function renderImport(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  const [accRes, catRes, incCatRes] = await Promise.all([
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listCategories(ledger.id, { recordType: 'expense' }).then((r) => r.data),
    Api.listCategories(ledger.id, { recordType: 'income' }).then((r) => r.data),
  ]);
  const accounts = accRes.filter((a) => a.kind !== 'virtual' && !a.archivedAt);
  const flat = (tree) => {
    const out = [];
    for (const p of tree) for (const c of p.children ?? []) if (!c.archivedAt) out.push({ ...c, parentName: p.name });
    return out;
  };
  const expCats = flat(catRes);
  const incCats = flat(incCatRes);

  /** 页面级状态：文件持有在这里，所以 preview / commit 传的是同一个 File */
  let file = null;
  let preview = null;
  let report = null;
  /**
   * 用户手工调过的映射（覆盖服务端猜测）。
   *
   * ⚠️ 键必须与后端 `IMPORT_COLUMN_FIELDS` 一一对应，一个都不能少 ——
   *    少一个的结果是该列在「刷新预览」时被当作未映射清掉，
   *    而界面上看不出任何异常（下拉还是显示着，值其实已经丢了）。
   */
  const mapping = {
    dateColumn: '',
    amountColumn: '',
    recordTypeColumn: null,
    accountColumn: null,
    directionColumn: null,
    timeColumn: null,
  nameColumn: null,
  mainCategoryColumn: null,
  subCategoryColumn: null,
  merchantColumn: null,
    counterpartyColumn: null,
    feeColumn: null,
    discountColumn: null,
    tagsColumn: null,
    noteColumn: null,
    recordType: 'expense',
    defaultAccountId: accounts[0]?.id ?? '',
    defaultCategoryId: '',
    incomeCategoryId: '',
  };

  const frame = appFrame({
    active: 'import',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">导入账单</h1>
            <p class="tt-caption text-muted">支付宝 / 微信 / 银行导出的 CSV，一次补齐历史流水</p>
          </div>
        </div>
      </div>

      <section class="section" data-role="step1">
        <div class="section__head"><h2 class="tt-body-strong">① 选择文件</h2></div>
        <div class="card stack stack--md">
          <div class="field" data-field="file">
            <label class="field__label" id="imp-file-label">CSV 文件（≤ 20 MB / ≤ 20000 行）</label>
            <button class="dropzone" type="button" data-role="dropzone"
                    aria-labelledby="imp-file-label" aria-describedby="imp-file-hint">
              <span class="dropzone__icon" aria-hidden="true">${lucide('file-text', 26)}</span>
              <span class="dropzone__body">
                <span class="dropzone__title" data-role="dz-title">拖拽 CSV 文件到此处，或点击选择</span>
                <span class="dropzone__hint" data-role="dz-hint">支持支付宝 / 微信 / 银行导出 · ≤ 20 MB / ≤ 20000 行</span>
              </span>
              <span class="dropzone__check" data-role="dz-check" aria-hidden="true" hidden>${icon('check', 18)}</span>
              <input class="visually-hidden" id="imp-file" type="file" accept=".csv,text/csv" data-role="file" />
            </button>
            <button class="dropzone__remove" type="button" data-role="file-remove" hidden aria-label="移除已选文件">
              ${icon('close', 14)}<span>移除</span>
            </button>
            <span class="field__error" data-role="file-error"></span>
            <p class="tt-fine-print text-muted" id="imp-file-hint" data-role="file-hint" hidden></p>
          </div>
          <div class="row row--sm row--wrap">
            <button class="btn btn--primary" type="button" data-role="do-preview">读取表头</button>
            <button class="btn btn--quiet" type="button" data-role="do-download">下载示例模板</button>
          </div>
        </div>
      </section>

      <div data-role="step2"></div>
      <div data-role="step3"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'import', go, ledger });

  const step2 = frame.querySelector('[data-role=step2]');
  const step3 = frame.querySelector('[data-role=step3]');
  const fileInput = frame.querySelector('[data-role=file]');
  const dropzone = frame.querySelector('[data-role=dropzone]');
  const dzTitle = frame.querySelector('[data-role=dz-title]');
  const dzHint = frame.querySelector('[data-role=dz-hint]');
  const dzCheck = frame.querySelector('[data-role=dz-check]');
  const fileRemove = frame.querySelector('[data-role=file-remove]');
  const fileHint = frame.querySelector('[data-role=file-hint]');

  const DZ_DEFAULT_TITLE = '拖拽 CSV 文件到此处，或点击选择';
  const DZ_DEFAULT_HINT = '支持支付宝 / 微信 / 银行导出 · ≤ 20 MB / ≤ 20000 行';

  /** 选中文件后刷新拖拽区的视觉：标题换成文件名、显示勾选与移除、底色转蓝。 */
  function refreshFileUI() {
    const picked = Boolean(file);
    dropzone.classList.toggle('is-filled', picked);
    dzTitle.textContent = picked ? file.name : DZ_DEFAULT_TITLE;
    dzHint.textContent = picked ? `${(file.size / 1024).toFixed(1)} KB · 已就绪，点击「读取表头」预览` : DZ_DEFAULT_HINT;
    dzCheck.hidden = !picked;
    fileRemove.hidden = !picked;
    fileHint.hidden = !picked;
    if (picked) fileHint.textContent = `已选择：${file.name}（${file.size} 字节），点击「读取表头」生成字段对照与预览`;
  }

  fileInput.addEventListener('change', (e) => {
    file = e.target.files?.[0] ?? null;
    refreshFileUI();
    preview = null;
    report = null;
    step2.replaceChildren();
    step3.replaceChildren();
  });

  /** 点拖拽区 = 打开系统文件框（input 藏在按钮里，靠这里显式触发） */
  dropzone.addEventListener('click', () => fileInput.click());
  /** 键盘可达：聚焦拖拽区后回车 / 空格也能开文件框 */
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  /** 移除已选文件：清空 input 与状态，回到初始态 */
  fileRemove.addEventListener('click', () => {
    file = null;
    fileInput.value = '';
    refreshFileUI();
    preview = null;
    report = null;
    step2.replaceChildren();
    step3.replaceChildren();
  });
  /** 支持真正的拖拽：拖到区上高亮，松手即选中（文件只持有引用，不重复选） */
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-drag');
    }),
  );
  ['dragleave', 'dragend', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-drag');
    }),
  );
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    file = f;
    refreshFileUI();
    preview = null;
    report = null;
    step2.replaceChildren();
    step3.replaceChildren();
  });

  frame.querySelector('[data-role=do-download]').addEventListener('click', (e) => {
    /**
     * 模板给的是**支付宝的列名**，因为那是国内用户最可能先导出的。
     * 微信/银行的差异体现在列名上，用户照着模板改表头即可。
     *
     * ⚠️ 表头必须与 `src/modules/imports/service.ts` 的 `MAPPING_TEMPLATES[].columns`
     *    对齐：解析器的 `guessMapping()` 按**别名精确/包含匹配**找列，
     *    写一个解析器不认识的列名，用户下载完还要在第 ② 步手工重映射一遍，
     *    那这份模板就是白下的。列名取自 alipay 模板：
     *      dateColumn 交易时间 / amountColumn 金额 / merchantColumn 交易对方 /
     *      noteColumn 商品说明 / directionColumn 收/支
     *
     * ⚠️ 行数要给足**三种形态**：纯支出（负号）、收入行（正号 + 收/支=收入）、
     *      带空格的日期。解析器的 `normalizeDate()` 与 `resolveRecordType()`
     *      都各有分支，只有都覆盖到，用户照抄才不会踩到「日期格式非法」。
     */
    const rows = [
      '交易时间,交易对方,金额,收/支,商品说明',
      '2026-03-01 12:30:45,示例商家,35.00,支出,午餐',
      '2026-03-02,示例商家,8000.00,收入,三月工资',
      '2026-03-03 09:15:22,地铁,6.00,支出,通勤',
    ];
    // BOM：Excel 缺了会把中文表头认成乱码；解析器也会剥掉它（imports/service.ts 顶部注释）
    const csv = `﻿${rows.join('\r\n')}\r\n`;

    downloadTextFile('CC记账-导入模板.csv', csv, {
      mime: 'text/csv;charset=utf-8',
      throwOnEmpty: true,
      okMessage: '模板已下载（含 UTF-8 BOM，Excel 打开不乱码；表头已按支付宝账单格式预填）',
    });
  });

  async function doPreview(btn) {
    if (!file) {
      toast('请先选择文件', 'error');
      return;
    }
    setLoading(btn, true, '读取中');
    try {
      const out = (await Api.previewImport(ledger.id, file, anyMappingSet() ? mapping : null)).data;
      preview = out;
      // 用服务端猜的结果**填充**映射，但只填还没被用户改过的字段
      // ⚠️ 全部列字段都要填 —— 漏一个，该列猜出来了也不进表单，
      //    用户看到的预览与实际导入不一致。
      for (const k of IMPORT_FIELD_KEYS) {
        if (!mapping[k] && out.guessed?.[k]) mapping[k] = out.guessed[k];
      }
      renderStep2();
    } catch (err) {
      setLoading(btn, false);
      toast(err.message, 'error');
    }
  }

  function anyMappingSet() {
    return Boolean(mapping.dateColumn && mapping.amountColumn);
  }

  /**
   * 字段对照表：把文件里**每一列**逐条交代清楚。
   *
   * 为什么必须有 —— 映射表单只列「要写进账单的那几列」，
   * 文件里剩下的列就静默消失，用户会以为「导进来就是完整的」。
   * 尤其是像本系统自己的导出文件那样的 18 列：只交代核心几列、
   * 另外的列一字不提，用户无法判断「主类别」「子类别」「手续费」到底丢没丢。
   *
   * 数据来自**服务端** `preview.columns`（模板契约的原样投影），
   * 前端不另抄一份 —— 另抄一份必然漂移，且漂移是静默的。
   * 列顺序 = 文档顺序；「必填」与「可选」用徽标区分，
   * 非必填项一律给出「不填会怎样」的提示（用户明确要求）。
   */
  function renderColumnRef(header) {
    const cols = preview.columns ?? [];
    if (!cols.length) return '';
    const mappedCount = cols.filter((c) => c.consume).length;
    return `
      <details class="col-ref" data-role="col-ref">
        <summary class="tt-body-strong">
          文件字段对照（${cols.length} 列：读取 ${mappedCount} 列，其余 ${cols.length - mappedCount} 列导入时不使用）
        </summary>
        <div class="imp-table-wrap">
          <table class="imp-table col-ref__table">
            <thead>
              <tr><th>#</th><th>文件列名</th><th>类型</th><th>取值范围</th><th>必填</th><th>导入去向</th><th>留空时</th><th>说明</th></tr>
            </thead>
            <tbody>
              ${cols
                .map(
                  (c) => `
                <tr class="${c.consume ? 'col-ref__row--used' : ''}">
                  <td class="tnum">${esc(String(c.index))}</td>
                  <td class="tt-body-strong">${esc(c.column)}${header.includes(c.column) ? '' : '<span class="tt-fine-print is-neg"> 文件里没有这一列</span>'}</td>
                  <td>${esc(KIND_LABEL[c.kind] ?? c.kind)}</td>
                  <td class="tt-fine-print">${c.values?.length ? esc(c.values.join(' / ')) : '—'}</td>
                  <td>${c.required ? '<span class="badge is-req">必填</span>' : '<span class="badge">可选</span>'}</td>
                  <td class="tt-fine-print">${c.consume ? esc(FIELD_LABEL[c.consume] ?? c.consume) : '<span class="text-muted">不读取</span>'}</td>
                  <td class="tt-fine-print text-muted">${esc(c.defaultValue ?? '')}</td>
                  <td class="tt-fine-print text-muted">${esc(c.hint)}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
        ${
          preview.matchedTemplate
            ? `<p class="tt-fine-print text-muted">已识别为「${esc(preview.templates?.find((t) => t.key === preview.matchedTemplate)?.label ?? preview.matchedTemplate)}」格式，上表即该格式的完整契约。</p>`
            : '<p class="tt-fine-print text-muted">未识别为任何预设格式，上表按本文件的实际表头生成；导入前请逐列核对。</p>'
        }
      </details>`;
  }

  /**
   * 折叠态与表单值**分开存**（用户明确要求「相互独立」）。
   *
   * `mapping` 是表单值，`ui` 是展开态。两条状态互不驱动：
   * 收起/展开只切 `ui.moreOpen` 并改 DOM 的 hidden/类名，
   * **绝不重新渲染**表单 —— 一旦靠重渲染来切折叠，
   * 用户已填的值就要靠「回填」来维持，而回填必漏字段（本项目踩过一次：
   * 回填列表漏了 directionColumn）。不重渲染，值就天然还在。
   */
  const ui = { moreOpen: false };

  /** 单个映射项的 DOM（必填 / 可选共用一套结构，只差徽标） */
  function mapItemHtml(f, header) {
    const filled = Boolean(mapping[f.key]);
    return `
      <div class="map-item${filled ? ' is-mapped' : ''}${f.required && !filled ? ' is-missing' : ''}" data-field="${f.key}" data-required="${f.required ? 1 : 0}">
        <div class="map-item__head">
          <label class="field__label" for="imp-${f.key}">${esc(f.label)}</label>
          ${f.required ? '<span class="badge is-req">必填</span>' : '<span class="badge">可选</span>'}
          <span class="map-item__flag" data-flag>${icon('check', 14)}<span>已映射</span></span>
        </div>
        <select class="input select" id="imp-${f.key}" name="${f.key}">
          <option value="">（不用）</option>
          ${header
            .map((c) => `<option value="${esc(c)}"${mapping[f.key] === c ? ' selected' : ''}>${esc(c)}</option>`)
            .join('')}
        </select>
        <span class="map-item__hint">${esc(f.hint ?? '')}</span>
        <span class="field__error"></span>
      </div>`;
  }

  /**
   * 非必填映射项：默认收起，按钮上带「已配置 / 总数」。
   *
   * 收起不是「藏起来不管」—— 按钮必须自曝状态：还有几项没配、
   * 里面有没有已经配好的。否则用户收起后再也想不到回去看，
   * 而漏配一列的后果是「那一列在导入时静默消失」。
   */
  function renderOptionalBlock(header) {
    const opts = MAPPING_FIELDS.filter((f) => !f.required);
    const done = opts.filter((f) => Boolean(mapping[f.key])).length;
    return `
      <div class="map-block__head">
        <h3 class="tt-body-strong">可选映射</h3>
        <span class="tt-fine-print text-muted">不配也能导入，只是对应列不写进账单</span>
      </div>
      <button class="map-more" type="button" data-role="toggle-more"
              aria-expanded="${ui.moreOpen ? 'true' : 'false'}" aria-controls="imp-optional">
        <span class="map-more__label" data-role="more-text">${esc(moreLabel(done, opts.length))}</span>
        <span class="map-more__dot" data-role="more-dot"${done ? '' : ' hidden'} aria-hidden="true"></span>
        <span class="map-more__chev">${icon('chevron-down', 16)}</span>
      </button>
      <div class="map-grid map-grid--optional" id="imp-optional" data-role="optional-fields"${ui.moreOpen ? '' : ' hidden'}>
        ${opts.map((f) => mapItemHtml(f, header)).join('')}
      </div>`;
  }

  function moreLabel(done, total) {
    return `${ui.moreOpen ? '收起可选字段' : '展开更多字段'}（${done}/${total}）`;
  }

  /**
   * 只改类名与文案，不重建 DOM —— 表单值因此天然保留。
   * 每次 select 变更后调用一次，已映射态的视觉与折叠按钮的计数才是实时的。
   */
  function refreshMapStates() {
    const opts = MAPPING_FIELDS.filter((f) => !f.required);
    for (const f of MAPPING_FIELDS) {
      const el = step2.querySelector(`.map-item[data-field="${f.key}"]`);
      if (!el) continue;
      const filled = Boolean(mapping[f.key]);
      el.classList.toggle('is-mapped', filled);
      el.classList.toggle('is-missing', Boolean(f.required) && !filled);
      const flag = el.querySelector('[data-flag]');
      if (flag) flag.hidden = !filled;
    }
    const acc = step2.querySelector('.map-item[data-field="defaultAccountId"]');
    if (acc) acc.classList.toggle('is-missing', !mapping.defaultAccountId);

    const done = opts.filter((f) => Boolean(mapping[f.key])).length;
    const text = step2.querySelector('[data-role=more-text]');
    if (text) text.textContent = moreLabel(done, opts.length);
    const dot = step2.querySelector('[data-role=more-dot]');
    if (dot) dot.hidden = done === 0;
  }

  function renderStep2() {
    const header = preview.header ?? [];
    step2.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">② 校对映射</h2>
          <span class="tt-fine-print">共 ${preview.total} 行 · 与已有账单重复 ${preview.duplicates} 行</span>
        </div>
        <div class="card stack stack--md">
          <div class="row row--sm row--wrap">
            <button class="btn btn--quiet btn--sm" type="button" data-tpl="${esc(preview.templates?.[0]?.key ?? '')}"
                    title="${esc(preview.templates?.[0]?.hint ?? '')}">套用「${esc(preview.templates?.[0]?.label ?? '')}」</button>
            ${(preview.templates ?? [])
              .slice(1)
              .map((t) => `<button class="btn btn--quiet btn--sm" type="button" data-tpl="${esc(t.key)}" title="${esc(t.hint)}">${esc(t.label)}</button>`)
              .join('')}
          </div>

          <div class="map-block">
            <div class="map-block__head">
              <h3 class="tt-body-strong">必填映射</h3>
              <span class="tt-fine-print text-muted">缺任一项就无法导入</span>
            </div>
            <div class="map-grid">
              ${MAPPING_FIELDS.filter((f) => f.required).map((f) => mapItemHtml(f, header)).join('')}
              <div class="map-item" data-field="defaultAccountId" data-required="1">
                <div class="map-item__head">
                  <label class="field__label" for="imp-acc">导入到哪个账户</label>
                  <span class="badge is-req">必填</span>
                </div>
                <select class="input select" id="imp-acc">
                  ${accounts
                    .map((a) => `<option value="${esc(a.id)}"${mapping.defaultAccountId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`)
                    .join('')}
                </select>
                <span class="map-item__hint">兜底账户：没映射「账户列」、或该行账户为空时才用它</span>
                <span class="field__error"></span>
              </div>
            </div>
          </div>

          <div class="map-block">
            ${renderOptionalBlock(header)}
          </div>

          <div class="map-block">
            <div class="map-block__head">
              <h3 class="tt-body-strong">导入设置</h3>
              <span class="tt-fine-print text-muted">作用于整批行，不是逐列映射</span>
            </div>
            <div class="map-grid">
              <div class="map-item">
                <div class="map-item__head">
                  <label class="field__label" for="imp-rt">默认记录类型</label>
                  <span class="badge">可选</span>
                </div>
                <select class="input select" id="imp-rt">
                  <option value="expense"${mapping.recordType === 'expense' ? ' selected' : ''}>支出</option>
                  <option value="income"${mapping.recordType === 'income' ? ' selected' : ''}>收入</option>
                </select>
                <span class="map-item__hint">「收支 / 类型」列未映射时，全部按这个类型入账</span>
              </div>
              <div class="map-item" data-field="defaultCategoryId">
                <div class="map-item__head">
                  <label class="field__label" for="imp-cat">未匹配到规则的支出归到</label>
                  <span class="badge">可选</span>
                </div>
                <select class="input select" id="imp-cat">
                  <option value="">（不指定）</option>
                  ${expCats.map((c) => `<option value="${esc(c.id)}"${mapping.defaultCategoryId === c.id ? ' selected' : ''}>${esc(`${c.parentName} › ${c.name}`)}</option>`).join('')}
                </select>
                <span class="map-item__hint">不指定时，规则也没命中的行会失败并列进报告</span>
                <span class="field__error"></span>
              </div>
              <div class="map-item" data-field="incomeCategoryId">
                <div class="map-item__head">
                  <label class="field__label" for="imp-inccat">收入归到</label>
                  <span class="badge">可选</span>
                </div>
                <select class="input select" id="imp-inccat">
                  <option value="">（不指定）</option>
                  ${incCats.map((c) => `<option value="${esc(c.id)}"${mapping.incomeCategoryId === c.id ? ' selected' : ''}>${esc(`${c.parentName} › ${c.name}`)}</option>`).join('')}
                </select>
                <span class="map-item__hint">分类树按类型分开，收入不能用支出分类兜底</span>
                <span class="field__error"></span>
              </div>
            </div>
          </div>

          <p class="tt-fine-print text-muted">
            分类优先级：<b>自动分类规则</b> → 上面的兜底分类。都没命中时该行会失败并在报告里列出。
          </p>

          ${renderColumnRef(header)}

          <div class="row row--sm row--wrap">
            <button class="btn btn--quiet btn--sm" type="button" data-role="re-preview">刷新预览</button>
            <button class="btn btn--primary" type="button" data-role="do-commit">确认导入</button>
          </div>

          <div class="imp-preview">
            <div class="list-meta">
              <span class="tt-fine-print">前 ${Math.min(20, preview.total)} 行预览</span>
              <span class="tt-fine-print">红色行是没解析出来的（原因在末列）</span>
            </div>
            <div class="imp-table-wrap">
              <table class="imp-table">
                <thead><tr><th>行</th>${header.map((c) => `<th>${esc(c)}</th>`).join('')}<th>解析结果</th></tr></thead>
                <tbody>
                  ${(preview.sample ?? [])
                    .map(
                      (s) => `
                    <tr class="${s.message ? 'is-bad' : ''}">
                      <td class="tnum">${esc(String(s.row))}</td>
                      ${s.raw.map((v) => `<td>${esc(v)}</td>`).join('')}
                      <td class="tt-fine-print">${
                        s.message
                          ? `<span class="is-neg">${esc(s.message)}</span>`
                          : `${esc(s.parsed.txDate)} · ${esc(money(s.parsed.amount))} · <span class="${
                              s.parsed.recordType === 'income' ? 'is-pos' : ''
                            }">${esc(RECORD_TYPE_LABEL[s.parsed.recordType] ?? s.parsed.recordType)}</span>${
                              s.parsed.recordType === 'expense' || s.parsed.recordType === 'income'
                                ? ''
                                : '（导入时不支持）'
                            }`
                      }</td>
                    </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>`;

    step2.querySelectorAll('select, input').forEach((el) =>
      el.addEventListener('change', () => {
        if (el.name) mapping[el.name] = el.value || null;
        else if (el.id === 'imp-rt') mapping.recordType = el.value;
        else if (el.id === 'imp-acc') mapping.defaultAccountId = el.value;
        else if (el.id === 'imp-cat') mapping.defaultCategoryId = el.value;
        else if (el.id === 'imp-inccat') mapping.incomeCategoryId = el.value;
        // 只刷状态类与计数，不重建 DOM：改一列不该让别的已填项闪一下
        refreshMapStates();
      }),
    );

    /**
     * 折叠切换：只碰 `ui.moreOpen` 与容器的 hidden / 类名。
     *
     * ⚠️ **不能**在这里调 `renderStep2()`。重渲染 = 整块 innerHTML 重建，
     * 折叠区里已填的值要靠回填活下来，而回填列表一旦漏字段就静默丢配置；
     * 更直观的坏处是焦点丢失、下拉被关。用户的原始要求就是
     * 「表单状态与折叠状态相互独立」，不重渲染是这句话最直接的实现。
     */
    step2.querySelector('[data-role=toggle-more]').addEventListener('click', (e) => {
      ui.moreOpen = !ui.moreOpen;
      const btn = e.currentTarget;
      const panel = step2.querySelector('[data-role=optional-fields]');
      btn.setAttribute('aria-expanded', ui.moreOpen ? 'true' : 'false');
      if (panel) panel.hidden = !ui.moreOpen;
      refreshMapStates();
      if (ui.moreOpen) {
        const first = panel?.querySelector('select');
        if (first) first.focus({ preventScroll: true });
      }
    });
    step2.querySelectorAll('[data-tpl]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const tpl = (preview.templates ?? []).find((t) => t.key === btn.dataset.tpl);
        if (!tpl) return;
        try {
          /**
           * 映射值由**服务端**按该模板在本文件的表头上算好后带回来（`tpl.mapping`）。
           *
           * ⚠️ 此前这里是前端硬编码的 `aliases` 表：模板改列名就得记得同步改前端，
           * 漏改的表现是「点了模板，什么都没变」—— 静默、无报错、极难察觉。
           * 现在前端只负责搬运服务端算好的值，两处不同源的问题从根上消失。
           */
          /**
           * ⚠️ **整份** mapping 一起搬运，而不是只挑 5 个键。
           * 此前只写了 5 个键，其余可选列在「套用模板」后被静默清空。
           */
          const m = tpl.mapping ?? {};
          for (const k of IMPORT_FIELD_KEYS) {
            mapping[k] = m[k] ?? (k === 'dateColumn' || k === 'amountColumn' ? '' : null);
          }
          preview = (await Api.previewImport(ledger.id, file, mapping)).data;
          renderStep2();
          toast(`已按「${tpl.label}」套用映射`, 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
    step2.querySelector('[data-role=re-preview]').addEventListener('click', (e) => doPreview(e.currentTarget));
    /**
     * ⚠️ 必须用箭头函数包一层，不能把 `commit` 直接当监听器。
     *
     * 直接写 `addEventListener('click', commit)` 会把 **Event 对象**传进
     * `commit(btn)`，而 `commit` 里的 `setLoading(btn, …)` 要访问 `btn.dataset`
     * —— Event 没有 dataset，于是**抛 TypeError**。因为 `commit` 是 async，
     * 异常变成 unhandled rejection：没有 toast、没有请求、界面毫无反应。
     *
     * 实测症状极难定位：探针里表现为「点了确认，什么都没发生，也没有任何报错」。
     * 而用户看到的是「导入按钮点了没反应」—— 一个连失败提示都没有的功能，
     * 比明确报错的糟糕程度高一个量级（用户会以为是自己操作错了）。
     *
     * 所以这里既传对了按钮，也**显式接住异常**：任何一个未预料的失败
     * 都必须变成一条用户看得见的提示。
     */
    step2.querySelector('[data-role=do-commit]').addEventListener('click', (e) => {
      commit(e.currentTarget).catch((err) => {
        setLoading(e.currentTarget, false);
        toast(err?.message ? `导入失败：${err.message}` : '导入失败，请重试', 'error');
      });
    });
  }

  async function commit(btn) {
    refreshMapStates();
    if (!mapping.dateColumn || !mapping.amountColumn) {
      // 不只弹一句 toast：把缺的那一项在表单里也点亮，用户才知道该改哪个
      const miss = !mapping.dateColumn ? '日期列' : '金额列';
      toast(`「${miss}」还没选，缺它无法导入`, 'error');
      const el = step2.querySelector(`.map-item[data-field="${!mapping.dateColumn ? 'dateColumn' : 'amountColumn'}"]`);
      el?.querySelector('select')?.focus({ preventScroll: false });
      return;
    }
    if (!mapping.defaultAccountId) {
      toast('请选择导入到哪个账户', 'error');
      return;
    }
    /**
     * 确认文案要**按实际归集方式**说清楚。
     *
     * ⚠️ 映射了「账户列」之后，账单是**按行分散**入账的，
     *    再写「导入 N 行到「现金」」就是假的——用户看完以为全进现金，
     *    实际进了五张卡。文案必须跟着归集方式变。
     */
    const fallbackName = accounts.find((a) => a.id === mapping.defaultAccountId)?.name ?? '';
    const byColumn = Boolean(mapping.accountColumn);
    const confirmText = byColumn
      ? `确认导入 ${preview?.total ?? 0} 行？\n\n· 按「${mapping.accountColumn}」列的账户名分别入账\n· 该列为空或名字对不上的行：记到「${fallbackName}」（名字对不上的会失败并列进报告）`
      : `确认导入 ${preview?.total ?? 0} 行到「${fallbackName}」？\n\n（可选映射里的「账户列」没配，所以整批都进这一个账户）`;
    if (!window.confirm(`${confirmText}\n\n导入的账单与手记的账单完全同路，可用账单列表筛选出来核对`)) return;
    setLoading(btn, true, '导入中');
    try {
      report = (await Api.commitImport(ledger.id, file, mapping)).data;
      renderStep3();
      toast(
        `导入完成：成功 ${report.succeeded} 笔${report.failed ? `、失败 ${report.failed} 笔` : ''}${report.skipped ? `、跳过重复 ${report.skipped} 笔` : ''}`,
        report.failed ? 'default' : 'success',
      );
    } catch (err) {
      setLoading(btn, false);
      const map = Object.fromEntries((err.details ?? []).map((d) => [d.field, d.message]));
      if (!applyFieldErrors(frame, map)) toast(err.message, 'error');
    }
  }

  function renderStep3() {
    step3.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2 class="tt-body-strong">③ 导入报告</h2>
          <span class="tt-fine-print">行号与 Excel 里的一致（含表头那行）</span>
        </div>
        <div class="card">
          <div class="stat-strip">
            <div class="stat-strip__cell">
              <span class="stat-strip__label">成功</span>
              <span class="stat-strip__value tnum is-pos">${esc(String(report.succeeded))}</span>
            </div>
            <div class="stat-strip__cell">
              <span class="stat-strip__label">失败</span>
              <span class="stat-strip__value tnum ${report.failed ? 'is-neg' : ''}">${esc(String(report.failed))}</span>
            </div>
            <div class="stat-strip__cell">
              <span class="stat-strip__label">跳过（重复）</span>
              <span class="stat-strip__value tnum">${esc(String(report.skipped))}</span>
            </div>
            <div class="stat-strip__cell">
              <span class="stat-strip__label">总行数</span>
              <span class="stat-strip__value tnum">${esc(String(report.total))}</span>
            </div>
          </div>
          ${
            report.errors.length
              ? `<div class="imp-errors">
                  <table class="imp-table imp-report">
                    <thead>
                      <tr><th>行</th><th>字段</th><th>原值</th><th>原因</th></tr>
                    </thead>
                    <tbody>
                      ${report.errors
                        .map(
                          (e) => `
                        <tr>
                          <td class="tnum">${esc(String(e.row))}</td>
                          <td class="tt-caption">${esc(e.column)}</td>
                          <td class="tt-caption">${esc(String(e.value))}</td>
                          <td class="tt-caption text-muted">${esc(e.message)}</td>
                        </tr>`,
                        )
                        .join('')}
                    </tbody>
                  </table>
                 </div>`
              : '<p class="tt-caption text-muted">没有失败的行</p>'
          }
          <div class="row row--sm row--wrap">
            <button class="btn btn--secondary btn--sm" type="button" data-role="to-tx">去账单列表核对</button>
          </div>
        </div>
      </section>`;
    step3.querySelector('[data-role=to-tx]').addEventListener('click', () => go?.('/transactions'));
  }

  frame.querySelector('[data-role=do-preview]').addEventListener('click', (e) => doPreview(e.currentTarget));
  return null;
}
