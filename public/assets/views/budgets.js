/**
 * 预算管理（`docs/05 §十六`）。
 *
 * ## 这一页的核心是「预算 vs 实际」的差异，不是「填一个数字」
 *
 * 所以每条预算卡片的结构固定为：**预算额 → 已花 → 剩余 → 使用率**，
 * 其中「剩余」在超支时是负数并染红 —— 那是用户唯一需要立刻看见的事实。
 *
 * ## 语义色纪律（三条，别越界）
 *
 *  · **使用率**是「用掉百分比」，永远 ≥ 0，**不套 toneClass** ——
 *    「用了 120%」是红的没错，但「用了 50%」染绿等于说「花得漂亮」，
 *    而支出本来就是这个页面的目标，把支出标成成功色是价值判断的错位。
 *  · **剩余额**有正负（超支为负），**可以**上 `is-neg`。
 *  · `alertLevel`（normal/warning/danger）是**预警状态**，不是好坏，
 *    所以用中性徽标 + 文案，不套收支配色。
 *
 * ## 月份切换
 *
 * 默认本月。切到未来月允许「先设预算」—— 这是合理需求（提前规划），
 * 与「关账不允许关未来月」是两种不同的未来。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { applyFieldErrors, esc, h, lucide, money, setLoading, toast } from '../ui.js';
import { parseAmountToCents } from '../lib/amounts.js';

const pad = (n) => String(n).padStart(2, '0');
const monthsOf = (year) => Array.from({ length: 12 }, (_, i) => i + 1);

/** 预警档位 → 文案 + 徽标。与后端 `alertLevel` 一一对应。 */
const LEVEL = {
  normal: { text: '健康', cls: 'badge--dark' },
  warning: { text: '接近上限', cls: 'badge--accent' },
  danger: { text: '已超支', cls: 'badge--danger' },
};

/**
 * 节奏 → 一句话结论（B-10）。
 *
 * 这一段是「预算 vs 实际」之外的**第三个数字**（执行率 + 时间进度），
 * 也是唯一能回答「我这个月会不会超」的数字。
 *
 * ⚠️ 措辞必须区分三种情况，不能一律说「快了」：
 *  · behind  要说清**会超多少**（预测值），否则用户不知道要调整多少
 *  · ahead   要说清**会剩多少**，这是好消息，值得说
 *  · on_track 只说「按现在的花法」，不要加任何形容词
 * 另外 `projected*` 为 null 是「已过天数不足 3 天，不预测」——
 * 那不是「没问题」，是「还不知道」，措辞必须不同。
 */
const PACE = {
  behind: { cls: 'is-neg', mark: '花钱偏快' },
  on_track: { cls: '', mark: '按节奏' },
  ahead: { cls: '', mark: '花钱偏慢' },
};

export async function renderBudgets(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  const [accRes, catRes] = await Promise.all([
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listCategories(ledger.id, { recordType: 'expense' }).then((r) => r.data),
  ]);
  const accounts = accRes.filter((a) => a.kind !== 'virtual' && !a.archivedAt);

  const flatCats = () => {
    const out = [];
    for (const p of catRes) for (const c of p.children ?? []) if (!c.archivedAt) out.push({ ...c, parentName: p.name });
    return out;
  };

  const frame = appFrame({
    active: 'budgets',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">预算</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 给分类设上限，把记账从事后记录变成事前控制
            </p>
          </div>
          <div class="row row--sm row--wrap">
            <select class="input bdg__month" data-role="pick-month" aria-label="选择月份"></select>
            <button class="btn btn--sm" type="button" data-action="add">新建预算</button>
            <button class="btn btn--sm btn--secondary" type="button" data-action="ratio">比例法</button>
            <button class="btn btn--sm btn--secondary" type="button" data-action="suggest">历史推荐</button>
          </div>
        </div>
      </div>

      <div class="bdg__summary" data-role="summary"></div>
      <div data-role="plan-slot"></div>
      <div data-role="form-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'budgets', go, ledger });

  const summarySlot = frame.querySelector('[data-role=summary]');
  const planSlot = frame.querySelector('[data-role=plan-slot]');
  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');
  const monthSel = frame.querySelector('[data-role=pick-month]');

  /** 年份给近 3 年（去年/今年/明年）—— 用户不会给 5 年后的月度设预算 */
  function paintMonthPicker() {
    const y0 = now.getFullYear();
    monthSel.innerHTML =
      [y0 - 1, y0, y0 + 1]
        .map((y) => {
          const opts = monthsOf(y)
            .map((m) => `<option value="${y}-${m}"${y === year && m === month ? ' selected' : ''}>${y} 年 ${m} 月</option>`)
            .join('');
          return `<optgroup label="${y} 年">${opts}</optgroup>`;
        })
        .join('');
  }

  const reload = async () => {
    const rows = (await Api.budgetProgress(ledger.id, { year, month })).data;
    paint(rows);
  };

  /**
   * 「这个月还剩 X 元」换成「还有 N 天，每天可以花 Y 元」（B-03 的可行动性）。
   * 三种情形分别给不同的结论 —— 预测为空时要说「还不知道」而不是「没问题」。
   */
  function paceLine(r) {
    if (r.over) {
      return `<p class="bdg-card__pace is-neg">已超出 ${esc(money(Math.abs(Number(r.remainingAmount))))}${
        r.projectedOver !== null
          ? `，按现在的花法全月约 ${esc(money(r.projectedSpent))}`
          : ''
      }</p>`;
    }
    const p = PACE[r.pace] ?? PACE.on_track;
    if (r.projectedSpent === null) {
      return `<p class="bdg-card__pace text-muted">才过了 ${esc(String(r.elapsedDays))} 天，还判断不出节奏（满 3 天开始预测）</p>`;
    }
    const willOver = Number(r.projectedOver ?? 0) > 0;
    return `<p class="bdg-card__pace ${p.cls}">
      ${esc(p.mark)}：还有 ${esc(String(r.remainingDays))} 天，每天可花 ${esc(money(r.dailyRemaining ?? '0.00'))}
      ${willOver ? ` · 按现在的花法月底约超 ${esc(money(r.projectedOver))}` : ` · 预计全月 ${esc(money(r.projectedSpent))}`}
    </p>`;
  }

  function paint(rows) {
    const total = rows.find((r) => r.categoryId === null) ?? null;
    const cats = rows.filter((r) => r.categoryId !== null);
    const alloc = total?.allocation ?? null;

    summarySlot.innerHTML = total
      ? `<div class="stat-strip">
           <div class="stat-strip__cell">
             <span class="stat-strip__label">${esc(year)} 年 ${month} 月总预算</span>
             <span class="stat-strip__value tnum">${esc(money(total.amount))}</span>
             <span class="stat-strip__sub">时间已过 ${esc(String(total.timeProgress))}%（${esc(String(total.elapsedDays))}/${esc(String(total.periodDays))} 天）</span>
           </div>
           <div class="stat-strip__cell">
             <span class="stat-strip__label">已花</span>
             <span class="stat-strip__value tnum">${esc(money(total.spentAmount))}</span>
             <span class="stat-strip__sub">占预算 ${esc(total.usedRatio)}%</span>
           </div>
           <div class="stat-strip__cell">
             <span class="stat-strip__label">${total.over ? '超出' : '剩余'}</span>
             <span class="stat-strip__value tnum ${Number(total.remainingAmount) < 0 ? 'is-neg' : ''}">${esc(money(total.remainingAmount))}</span>
             <span class="stat-strip__sub">${total.dailyRemaining !== null ? `每天可花 ${esc(money(total.dailyRemaining))}` : '已超支'}</span>
           </div>
           <div class="stat-strip__cell">
             <span class="stat-strip__label">分类预算</span>
             <span class="stat-strip__value tnum">${cats.length} 条</span>
             ${
               alloc
                 ? `<span class="stat-strip__sub">${alloc.unallocated !== null ? `未分配 ${esc(money(alloc.unallocated))}` : '未设总额'}</span>`
                 : ''
             }
           </div>
         </div>
         ${
           alloc?.message
             ? `<p class="bdg__alloc ${alloc.overAllocated !== null ? 'is-neg' : 'text-muted'}">${esc(alloc.message)}</p>`
             : ''
         }
         ${total ? paceLine(total) : ''}`
      : '';

    listSlot.innerHTML = rows.length
      ? `<div class="bdg-list">
           ${rows.map(cardHtml).join('')}
         </div>
         <div class="row row--sm row--wrap bdg__foot">
           <button class="btn btn--quiet btn--sm" type="button" data-action="copy-prev">从上月复制</button>
         </div>`
      : `<div class="card empty-state">
           <span class="empty-state__icon">${lucide('target', 22)}</span>
           <p class="tt-body-strong">${year} 年 ${month} 月还没有预算</p>
           <p class="tt-caption text-muted">设一条总预算，或给常花的分类各设一条上限</p>
         </div>`;

    listSlot.querySelectorAll('[data-budget] [data-act]').forEach((btn) =>
      /**
       * ⚠️ 必须用箭头函数包一层并显式接住异常。
       * 直接把 `removeBudget` 当监听器会把 **Event** 传进 `row` 参数，
       * 而 `row.categoryName` 在 Event 上是 undefined —— 表现是「点了没反应」。
       * async 函数里的异常会变成 unhandled rejection，同样**没有任何提示**。
       */
      btn.addEventListener('click', (e) => {
        const id = btn.closest('[data-budget]').dataset.budget;
        const row = rows.find((r) => r.id === id);
        const act = e.currentTarget.dataset.act;
        const run = act === 'del' ? removeBudget : act === 'transfer' ? openTransfer : openForm;
        Promise.resolve(run(row)).catch((err) => toast(err?.message ?? '操作失败', 'error'));
      }),
    );
    listSlot.querySelector('[data-action=copy-prev]')?.addEventListener('click', (e) => {
      copyPrev().catch((err) => toast(err?.message ?? '操作失败', 'error'));
      void e;
    });
    listSlot.querySelector('[data-action=show-transfers]')?.addEventListener('click', (e) => {
      openTransfers().catch((err) => toast(err?.message ?? '加载失败', 'error'));
      void e;
    });
  }

  function cardHtml(r) {
    const lv = LEVEL[r.alertLevel] ?? LEVEL.normal;
    const isTotal = r.categoryId === null;
    return `
      <div class="card bdg-card${r.over ? ' is-over' : ''}" data-budget="${esc(r.id)}">
        <div class="bdg-card__head">
          <div class="bdg-card__title">
            <span class="tt-body-strong">${esc(isTotal ? '总预算' : r.categoryName ?? '未分类')}</span>
            ${isTotal ? '<span class="badge badge--dark">全账本</span>' : ''}
            ${r.over ? `<span class="badge badge--danger">${esc(lv.text)}</span>` : ''}
          </div>
          <span class="bdg-card__amt tnum">${esc(money(r.amount))}</span>
        </div>

        ${
          /**
           * 双轨进度：上面是「预算用掉多少」（实心），下面一条细线是「时间过去多少」。
           * 两条线并排才看得出节奏 —— 只画一条时，「用掉 50%」到底是超前还是落后无从判断。
           */
          isTotal
            ? `<div class="bdg-card__time" title="时间已过 ${esc(String(r.timeProgress))}%">
                 <span style="width:${Math.min(100, r.timeProgress)}%"></span>
               </div>`
            : ''
        }
        <div class="bdg-card__bar" role="img" aria-label="已用 ${esc(r.usedRatio)}%">
          <span class="bdg-card__bar-fill${r.over ? ' is-over' : ''}" style="width:${Math.min(100, Number(r.usedRatio))}%"></span>
        </div>
        <div class="recon-line">
          <span class="tt-caption text-muted">已用 ${esc(r.usedRatio)}%</span>
          <span class="tt-caption tnum">已花 ${esc(money(r.spentAmount))}</span>
        </div>
        <div class="recon-line">
          <span class="tt-caption text-muted">${r.over ? '超出' : '剩余'}</span>
          ${
            // 超支时**显示绝对值**：文案已经说了「超出」，再配一个「−¥38.00」
            // 就成了「超出 −38 元」，负号出现了两次 —— 读者要停下来想一下哪个才对。
            r.over
              ? `<span class="tt-caption tnum is-neg">${esc(money(Math.abs(Number(r.remainingAmount))))}</span>`
              : `<span class="tt-caption tnum">${esc(money(r.remainingAmount))}</span>`
          }
        </div>
        ${!r.over && r.alertLevel !== 'normal' ? `<p class="tt-fine-print text-muted">已过预警线（${esc(String(r.alertRatio))}%）</p>` : ''}
        ${isTotal ? paceLine(r) : ''}

        <div class="row row--sm row--wrap">
          ${isTotal ? '<button class="btn btn--quiet btn--sm" type="button" data-action="show-transfers">调拨记录</button>' : ''}
          <button class="btn btn--quiet btn--sm" type="button" data-act="transfer">调拨</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="edit">调整</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="del">删除</button>
        </div>
      </div>`;
  }

  /* ---------------- 动作 ---------------- */

  async function removeBudget(row) {
    if (!window.confirm(`删除${row.categoryId === null ? '总' : ''}预算「${row.categoryName ?? ''}」？`)) return;
    try {
      await Api.deleteBudget(ledger.id, row.id);
      await reload();
      toast('预算已删除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 调拨（B-06） ---------------- */

  /**
   * 调拨弹窗。
   *
   * 交互刻意做成「从哪个分类挪到哪个分类」而不是「给目标分类加多少」——
   * 前者的语义是**移动**（总额不变），后者看起来像**新增**（总额变大）。
   * YNAB 把 move money 做成招牌交互正是这个原因：用户要解决的是
   * 「A 超了、B 还有余」，而不是「我想多花一点」。
   */
  async function openTransfer(row = null) {
    // 候选必须是**该期间有预算的分类**：没预算的分类调入是可以的（服务端会自动建），
    // 但不能作为「来源」—— 从没设过的预算里划不出东西来。
    const progress = (await Api.budgetProgress(ledger.id, { year, month })).data;
    const sources = progress.filter((p) => p.categoryId !== null);
    if (!sources.length) {
      toast('还没有分类预算可调拨 —— 先给几个分类设上限', 'default');
      return;
    }
    const all = flatCats();
    const from = row?.categoryId ?? sources[0].categoryId;

    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <p class="tt-body-strong">调拨预算额度</p>
          <p class="tt-fine-print text-muted">
            移动额度，**不产生账单**、账户余额不变。历史可撤销。
          </p>

          <div class="field-row">
            <div class="field" data-field="fromCategoryId">
              <label class="field__label" for="bdg-from">从</label>
              <select class="input select" id="bdg-from" name="fromCategoryId">
                ${sources
                  .map(
                    (p) =>
                      `<option value="${esc(p.categoryId)}"${from === p.categoryId ? ' selected' : ''}>${esc(
                        p.categoryName ?? '未分类',
                      )}（可划 ${esc(money(p.amount))}）</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="toCategoryId">
              <label class="field__label" for="bdg-to">挪到</label>
              <select class="input select" id="bdg-to" name="toCategoryId">
                ${all
                  .map(
                    (c) =>
                      `<option value="${esc(c.id)}">${esc(`${c.parentName} › ${c.name}`)}</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="amount">
              <label class="field__label" for="bdg-tamt">金额（元）</label>
              <input class="input" id="bdg-tamt" name="amount" inputmode="decimal" data-money placeholder="100.00" />
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field" data-field="note">
            <label class="field__label" for="bdg-tnote">备注</label>
            <input class="input" id="bdg-tnote" name="note" maxlength="200" placeholder="例如：把餐饮的挪给零食" />
            <span class="field__error"></span>
          </div>

          <div class="row row--sm">
            <button class="btn btn--primary" type="submit">调拨</button>
            <button class="btn btn--quiet" type="button" data-role="cancel">取消</button>
          </div>
        </form>
      </div>
    `);

    const f = form.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = f.querySelector('button[type=submit]');
      const cents = parseAmountToCents(f.amount.value);
      if (cents === null || cents <= 0) {
        toast('调拨金额必须大于 0', 'error');
        f.amount.focus();
        return;
      }
      setLoading(submit, true, '调拨中');
      try {
        const out = (
          await Api.transferBudget(ledger.id, {
            year,
            month,
            fromCategoryId: f.fromCategoryId.value,
            toCategoryId: f.toCategoryId.value,
            amount: f.amount.value,
            note: f.note.value.trim() || null,
          })
        ).data;
        toast(`已把 ${money(out.amount)} 从「${out.fromCategoryName}」挪到「${out.toCategoryName}」`, 'success');
        formSlot.replaceChildren();
        await reload();
      } catch (err) {
        setLoading(submit, false);
        toast(err.message, 'error');
      }
    });
    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());
    formSlot.replaceChildren(form);
    f.amount.focus();
  }

  /** 调拨历史 + 撤销（B-06 的「留痕」半边） */
  async function openTransfers() {
    const rows = (await Api.listBudgetTransfers(ledger.id, { year, month })).data;
    const panel = h(`
      <div class="card">
        <div class="row row--between row--wrap row--md">
          <p class="tt-body-strong">${esc(year)} 年 ${month} 月调拨记录</p>
          <button class="btn btn--quiet btn--sm" type="button" data-role="close">收起</button>
        </div>
        ${
          rows.length
            ? `<div class="bdg-transfers">
                ${rows
                  .map(
                    (t) => `
                  <div class="recon-line">
                    <span class="tt-caption">${esc(t.fromCategoryName ?? '?')} → ${esc(t.toCategoryName ?? '?')}</span>
                    <span class="tt-caption tnum">${esc(money(t.amount))}</span>
                    <button class="btn btn--quiet btn--sm" type="button" data-revoke="${esc(t.id)}">撤销</button>
                  </div>
                  ${t.note ? `<p class="tt-fine-print text-muted bdg-transfer-note">${esc(t.note)}</p>` : ''}
                `,
                  )
                  .join('')}
              </div>`
            : '<p class="tt-caption text-muted">这个月还没有调拨过</p>'
        }
      </div>
    `);
    panel.querySelector('[data-role=close]').addEventListener('click', () => formSlot.replaceChildren());
    panel.querySelectorAll('[data-revoke]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!window.confirm('撤销这次调拨？额度会原路还回。')) return;
        setLoading(b, true, '撤销中');
        try {
          await Api.revokeBudgetTransfer(ledger.id, b.dataset.revoke);
          toast('已撤销调拨', 'success');
          formSlot.replaceChildren();
          await reload();
        } catch (err) {
          setLoading(b, false);
          toast(err.message, 'error');
        }
      }),
    );
    formSlot.replaceChildren(panel);
  }

  async function copyPrev() {
    const pm = month === 1 ? 12 : month - 1;
    const py = month === 1 ? year - 1 : year;
    if (
      !window.confirm(
        `把 ${py} 年 ${pm} 月的预算复制到 ${year} 年 ${month} 月？\n\n本月已存在的预算不会被覆盖`,
      )
    )
      return;
    try {
      const out = (
        await Api.copyBudgetFromPrevious(ledger.id, {
          fromYear: py,
          fromMonth: pm,
          toYear: year,
          toMonth: month,
        })
      ).data;
      await reload();
      toast(out.created ? `已复制 ${out.created} 条预算` : '上月没有可复制的预算', out.created ? 'success' : 'default');
      if (out.skipped) toast(`${out.skipped} 条已存在，未覆盖`, 'default');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 表单 ---------------- */

  function openForm(row = null) {
    const isTotal = row?.categoryId === null;
    const cats = flatCats();
    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <p class="tt-body-strong">${row ? '调整预算' : '新建预算'}</p>

          <div class="field-row">
            <div class="field" data-field="categoryId">
              <label class="field__label" for="bdg-cat">分类</label>
              <select class="input select" id="bdg-cat" name="categoryId"${isTotal ? ' disabled' : ''}>
                <option value=""${isTotal ? ' selected' : ''}>总预算（整个账本）</option>
                ${cats
                  .map(
                    (c) =>
                      `<option value="${esc(c.id)}"${row?.categoryId === c.id ? ' selected' : ''}>${esc(
                        `${c.parentName} › ${c.name}`,
                      )}</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="amount">
              <label class="field__label" for="bdg-amt">预算金额（元）</label>
              <input class="input" id="bdg-amt" name="amount" inputmode="decimal" data-money
                     value="${esc(row?.amount ?? '')}" placeholder="3000.00" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="alertRatio">
              <label class="field__label" for="bdg-ar">预警线（%）</label>
              <input class="input" id="bdg-ar" name="alertRatio" type="number" inputmode="numeric"
                     min="1" max="100" value="${esc(String(row?.alertRatio ?? 80))}" />
              <span class="field__error"></span>
            </div>
          </div>

          <label class="check">
            <input type="checkbox" name="rollover"${row?.rollover ? ' checked' : ''} />
            <span>上月余额结转到本月</span>
          </label>

          <div class="row row--sm">
            <button class="btn btn--primary" type="submit">保存</button>
            <button class="btn btn--quiet" type="button" data-role="cancel">取消</button>
          </div>
        </form>
      </div>
    `);

    const f = form.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = f.querySelector('button[type=submit]');
      const amountCents = parseAmountToCents(f.amount.value);
      if (amountCents === null || amountCents <= 0) {
        toast('预算金额必须大于 0', 'error');
        f.amount.focus();
        return;
      }
      setLoading(submit, true, '保存中');
      const payload = {
        categoryId: f.categoryId.value || null,
        periodType: 'monthly',
        year,
        month,
        amount: f.amount.value,
        rollover: f.rollover.checked,
        alertRatio: Number(f.alertRatio.value || 80),
      };
      try {
        if (row) await Api.updateBudget(ledger.id, row.id, payload);
        else await Api.createBudget(ledger.id, payload);
        toast(row ? '预算已更新' : '预算已创建', 'success');
        formSlot.replaceChildren();
        await reload();
      } catch (err) {
        setLoading(submit, false);
        const map = Object.fromEntries((err.details ?? []).map((d) => [d.field, d.message]));
        if (!applyFieldErrors(f, map)) toast(err.message, 'error');
      }
    });
    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());
    formSlot.replaceChildren(form);
    f.amount.focus();
  }

  /* ================================================================== *
   * B-01 比例法 / B-11 历史推荐
   * ================================================================== */

  /**
   * 两个「帮我定个数」的入口。
   *
   * 为什么不做成表单里的一个字段：定预算这件事的门槛不在「填数字」，
   * 而在**「我该填多少」**。用户卡住的地方是不知道基准，
   * 所以给的是「先算给你看、认可了再一键落库」，
   * 而不是让他先想出一个数再填进去。
   */
  async function openRatio() {
    const panel = h('<div class="card"><p class="tt-caption text-muted">加载中…</p></div>');
    planSlot.replaceChildren(panel);
    try {
      const presets = (await Api.budgetRatioPresets(ledger.id)).data ?? [];
      panel.innerHTML = `
        <div class="row row--between row--wrap row--md">
          <div>
            <p class="tt-body-strong">比例法</p>
            <p class="tt-fine-print text-muted">按「收入 − 固定支出」做基数，而不是全部收入</p>
          </div>
          <button class="btn btn--quiet btn--sm" type="button" data-role="close">收起</button>
        </div>
        <div class="row row--sm row--wrap">
          ${presets
            .map(
              (p) =>
                `<button class="btn btn--sm btn--secondary" type="button" data-preset="${esc(p.key)}">${esc(p.name ?? p.key)}</button>`,
            )
            .join('')}
        </div>
        <div data-role="result"></div>`;
      panel.querySelector('[data-role=close]').addEventListener('click', () => planSlot.replaceChildren());
      panel.querySelectorAll('[data-preset]').forEach((btn) =>
        btn.addEventListener('click', (e) => runRatio(e.currentTarget, e.currentTarget.dataset.preset)),
      );
    } catch (err) {
      panel.innerHTML = `<p class="tt-caption is-neg">${esc(err.message ?? '加载失败')}</p>`;
    }
  }

  async function runRatio(btn, preset) {
    btn.disabled = true;
    try {
      const plan = (await Api.planBudgetByRatio(ledger.id, { year, month, preset })).data;
      const slot = planSlot.querySelector('[data-role=result]');
      slot.innerHTML = `
        <div class="recon-line">
          <span class="tt-caption">基数（收入 − 固定支出）</span>
          <span class="tt-caption tnum">${esc(money(plan.baseAmount))}</span>
        </div>
        <p class="tt-fine-print text-muted">${esc(plan.baseNote ?? '')}</p>
        <div class="recon-line"><span class="tt-caption">必要支出</span><span class="tt-caption tnum">${esc(money(plan.needs))}</span></div>
        <div class="recon-line"><span class="tt-caption">想要支出</span><span class="tt-caption tnum">${esc(money(plan.wants))}</span></div>
        <div class="recon-line"><span class="tt-caption">储蓄</span><span class="tt-caption tnum">${esc(money(plan.savings))}</span></div>
        <p class="tt-fine-print text-muted">逐分类建议（先选好哪些分类算「必要」才有值）</p>
        ${(plan.suggestions ?? [])
          .slice(0, 12)
          .map(
            (x) => `
          <div class="recon-line">
            <span class="tt-caption">${esc(x.categoryName ?? '未分类')}</span>
            <span class="tt-fine-print text-muted">${esc(x.group === 'needs' ? '必要' : x.group === 'wants' ? '想要' : '储蓄')}</span>
            <span class="tt-caption tnum">${esc(money(x.amount))}</span>
            <button class="btn btn--quiet btn--sm" type="button" data-apply="${esc(x.categoryId ?? '')}" data-amt="${esc(x.amount)}">采用</button>
          </div>`,
          )
          .join('')}
        ${(plan.unmappedCategories ?? []).length
          ? `<p class="tt-fine-print text-muted">${esc(String(plan.unmappedCategories.length))} 个分类还没归到「必要/想要」，它们的建议额度暂未计算</p>`
          : ''}
        `;
      slot.querySelectorAll('[data-apply]').forEach((b) =>
        b.addEventListener('click', (e) => applySuggestion(e.currentTarget)),
      );
    } catch (err) {
      toast(err?.message ?? '计算失败', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * B-11 历史推荐。
   *
   * 后端用的是**近 3 个月 P50 中位数**而不是月均 ——
   * 某月旅行花两万，月均会让接下来三个月每月背两万分摊，
   * 而那两个月根本没花那么多。这个取舍要在界面上说出来，
   * 否则用户看到「建议 800」会以为系统在乱猜。
   */
  async function openSuggest() {
    const panel = h('<div class="card"><p class="tt-caption text-muted">加载中…</p></div>');
    planSlot.replaceChildren(panel);
    try {
      const rows = (await Api.budgetSuggestions(ledger.id, year, month)).data ?? [];
      panel.innerHTML = `
        <div class="row row--between row--wrap row--md">
          <div>
            <p class="tt-body-strong">历史推荐</p>
            <p class="tt-fine-print text-muted">近 3 个月的中位数（P50），不是月均 —— 一次旅行不会污染后面三个月</p>
          </div>
          <button class="btn btn--quiet btn--sm" type="button" data-role="close">收起</button>
        </div>
        ${
          rows.length
            ? rows
                .slice(0, 12)
                .map(
                  (s) => `
              <div class="recon-line">
                <span class="tt-caption">${esc(s.categoryName ?? '未分类')}</span>
                <span class="tt-caption tnum">${esc(money(s.suggested ?? '0.00'))}</span>
                <span class="tt-fine-print text-muted">中位 ${esc(money(s.medianMonthly ?? '0.00'))} · 上月 ${esc(money(s.lastMonth ?? '0.00'))} · ${esc(String(s.sampleMonths ?? 0))} 个月样本</span>
                <button class="btn btn--quiet btn--sm" type="button" data-apply="${esc(s.categoryId ?? '')}" data-amt="${esc(s.suggested ?? '0.00')}">采用</button>
              </div>`,
                )
                .join('')
            : '<p class="tt-caption text-muted">历史数据不足，先记几个月账</p>'
        }`;
      panel.querySelector('[data-role=close]').addEventListener('click', () => planSlot.replaceChildren());
      panel.querySelectorAll('[data-apply]').forEach((b) =>
        b.addEventListener('click', (e) => applySuggestion(e.currentTarget)),
      );
    } catch (err) {
      panel.innerHTML = `<p class="tt-caption is-neg">${esc(err.message ?? '加载失败')}</p>`;
    }
  }

  async function applySuggestion(btn) {
    const categoryId = btn.dataset.apply;
    const amount = btn.dataset.amt;
    if (!categoryId) return;
    btn.disabled = true;
    try {
      await Api.createBudget(ledger.id, { categoryId, year, month, amount });
      toast('已采用', 'success');
      planSlot.replaceChildren();
      await reload();
    } catch (err) {
      btn.disabled = false;
      toast(err?.message ?? '保存失败', 'error');
    }
  }

  frame.querySelector('[data-action=add]').addEventListener('click', () => openForm(null));
  frame.querySelector('[data-action=ratio]').addEventListener('click', () => openRatio());
  frame.querySelector('[data-action=suggest]').addEventListener('click', () => openSuggest());
  monthSel.addEventListener('change', () => {
    const [y, m] = monthSel.value.split('-').map(Number);
    year = y;
    month = m;
    formSlot.replaceChildren();
    reload();
  });

  paintMonthPicker();
  await reload();
  return null;
}
