/**
 * 分期账单管理（`docs/05 §十二`）：计划列表 / 期明细 / 逐期还款 / 提前结清 / 取消。
 *
 * ## 这个模块唯一要死守的口径（`docs/05 §12.2`）
 *
 * > **分期 = 一次支出 + 多次转账还款。**
 *
 * 首笔支出在**创建计划那一刻**就一次性记全额（含手续费），之后每期只生成**转账**。
 * 所以页面上任何地方都**不能**出现「累计支出」随时间增长的展示 —— 那等于把同一笔消费
 * 记了第二遍。本页所有数字要么是「还款进度」，要么是「一开始就定了的总额」，
 * 二者不叠加。这一条在 UI 层体现为：卡片主数字是**剩余待还**，不是累计已记。
 *
 * ## 账户语义（极易搞反，务必看清）
 *
 *   · `debtAccountId` = **负债账户（信用卡）** —— 首笔支出记在它头上，还款时它是收款方；
 *   · `accountId`     = **还款账户（储蓄卡）** —— 每期转账从这里扣钱。
 *
 * 后端 `validate()` 明确禁止两者相同。表单 label 写「刷卡 / 消费账户」与「还款扣款账户」，
 * 而不是「账户 A / 账户 B」，就是为了避免这里填反。
 *
 * ## 为什么**不**在表单里做「每期还款额预览」
 *
 * 期分摊（`split.ts`：本金尾差归最后一期、手续费按 feeHandling 三种摊法）在后端有
 * 31 条恒等式单测守着。前端再算一遍就是第二份真相 —— 一旦漂移，用户按前端看到的数字
 * 做决策、后端按另一套扣账，比不给预览糟糕得多。所以这里**不给**，改在创建完成后
 * 由卡片和明细面板展示后端真实期表（`GET /installment-plans/:id/schedules`）。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { applyFieldErrors, esc, h, lucide, money, setLoading, toast } from '../ui.js';
import { RECORD_TYPES, parseAmountToCents } from '../lib/amounts.js';

const STATUS_LABEL = { active: '进行中', settled: '已还清', cancelled: '已取消' };
const STATUS_CLASS = { active: 'badge--accent', settled: 'badge--dark', cancelled: 'badge--dark' };

const TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  receivable: '应收款项',
  payable: '应付款项',
  adjustment: '余额调整',
};

/** 余额调整只由对账生成（`docs/13 §4`），不能建分期 */
const PLAN_TYPES = RECORD_TYPES.filter((t) => t !== 'adjustment' && t !== 'receivable' && t !== 'payable');

const FREQ = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};

const FEE_MODE = {
  once: { label: '一次性收取', hint: '手续费在创建时一次性计入消费总额' },
  per_period: { label: '每期收取', hint: '每期还款时另收一笔手续费' },
};

const FEE_HANDLING = {
  first_period: '首期多还（默认）',
  per_period: '按期分摊',
  manual_last: '手动尾款',
};

const pct = (paid, total) => (total ? Math.round((paid / total) * 100) : 0);

/** 手续费允许留空；空即为 0。后端对 fee 是 z.number → undefined 时才走默认 0 */
const sanitizeFee = (raw) => {
  const cents = parseAmountToCents(raw);
  return cents === null || cents < 0 ? undefined : String(cents / 100);
};

export async function renderInstallments(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  const [planRes, accRes, grpRes, catRes] = await Promise.all([
    Api.listInstallmentPlans(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id).then((r) => r.data),
    Api.listCategories(ledger.id).then((r) => r.data),
  ]);

  let list = planRes;
  /** 分期两端都得是真实账户：虚拟账户是台账口径，后端 validate 会直接 400 */
  const accounts = accRes.filter((a) => a.kind !== 'virtual' && !a.archivedAt);
  const groups = grpRes.filter((g) => !g.archivedAt);

  const frame = appFrame({
    active: 'installments',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">分期账单</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 一次记全额支出，之后按期还，不再重复计支出
            </p>
          </div>
          <button class="btn btn--sm" type="button" data-action="add">新建分期</button>
        </div>
      </div>

      <div class="inst__strip stat-strip" data-role="strip"></div>
      <div data-role="panel-slot"></div>
      <div data-role="form-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'installments', go, ledger });

  const stripSlot = frame.querySelector('[data-role=strip]');
  const panelSlot = frame.querySelector('[data-role=panel-slot]');
  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');

  const reload = async () => {
    list = (await Api.listInstallmentPlans(ledger.id)).data;
    render();
  };

  /* ---------------- 概览条 ---------------- */

  function paintStrip() {
    const active = list.filter((p) => p.status === 'active');
    /** 待还 = Σ 各计划的剩余未还（后端给的 remainingAmount，已含未摊的手续费） */
    const outstanding = active.reduce((a, p) => a + Math.round(Number(p.progress.remainingAmount) * 100), 0);
    const nextSum = active.reduce(
      (a, p) => a + (p.progress.nextDue ? Math.round(Number(p.progress.nextDue.totalDue) * 100) : 0),
      0,
    );
    const feeSum = list.reduce((a, p) => a + Math.round(Number(p.totalFee) * 100), 0);
    const cell = (label, value, tone = '') =>
      `<div class="stat-strip__cell">
         <span class="stat-strip__label">${esc(label)}</span>
         <span class="stat-strip__value tnum ${tone}">${value}</span>
       </div>`;
    stripSlot.innerHTML = [
      cell('进行中', `${active.length} 个`),
      cell('待还总额', money(outstanding / 100)),
      cell('近一期应还', money(nextSum / 100)),
      // 手续费合计不给语义色：它是成本不是盈亏，正负号在这里没有含义
      cell('手续费合计', money(feeSum / 100)),
    ].join('');
  }

  /* ---------------- 卡片 ---------------- */

  /**
   * ⚠️ 「N / 12 期已还」与「下一期」两行必须包在 `.inst-card__lines` 里。
   *
   * `.recon-line` 自带 `border-top`，靠自身的 `:first-child` 把自己那一条去掉。
   * 若让它俩直接当卡片子元素，它们前面还有进度条 —— 第一条分隔线正好压在进度条上，
   * 视觉上像进度条画了两遍。包一层之后，容器里它俩才是 `:first-child`。
   */
  function rowHtml(p) {
    const err = (p.warnings ?? []).find((w) => w.level === 'error');
    const soft = (p.warnings ?? []).find((w) => w.level === 'warn');
    const done = p.status !== 'active';
    const { paidCount, totalCount, remainingAmount, nextDue } = p.progress;
    const bar = pct(paidCount, totalCount);

    return `
      <div class="card inst-card${done ? ' is-done' : ''}" data-plan="${esc(p.id)}">
        <div class="inst-card__head">
          <div class="inst-card__title">
            <span class="tt-body-strong">${esc(p.title)}</span>
            <span class="badge ${STATUS_CLASS[p.status] ?? 'badge--dark'}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
            ${
              err
                ? `<span class="inst-card__warn" title="${esc(err.message)}">${lucide('triangle-alert', 13)}</span>`
                : ''
            }
            ${
              soft
                ? `<span class="inst-card__warn inst-card__warn--soft" title="${esc(soft.message)}">${lucide('info', 13)}</span>`
                : ''
            }
          </div>
          <span class="inst-card__grand tnum">${esc(money(p.grandTotal))}</span>
        </div>

        <p class="tt-fine-print">
          ${esc(p.debtAccountName ?? '—')} 消费 → ${esc(p.accountName ?? '—')} 还款
          · ${esc(p.installmentCount)} 期 · ${esc(FREQ[p.frequency] ?? p.frequency)}
          ${p.categoryName ? ` · ${esc(p.categoryName)}` : ''}
        </p>
        <p class="tt-fine-print text-muted">
          本金 ${esc(money(p.totalAmount))}
          ${
            Number(p.totalFee) !== 0
              ? ` · 手续费 ${esc(money(p.totalFee))}（${esc(FEE_MODE[p.feeMode]?.label ?? p.feeMode)}，${esc(FEE_HANDLING[p.feeHandling] ?? p.feeHandling)}）`
              : ' · 无手续费'
          }
        </p>

        <div class="inst-card__bar" role="img" aria-label="已还 ${paidCount} / ${totalCount} 期">
          <span class="inst-card__bar-fill" style="width:${bar}%"></span>
        </div>
        <div class="inst-card__lines">
          <div class="recon-line">
            <span class="tt-caption text-muted">${esc(paidCount)} / ${esc(totalCount)} 期已还</span>
            <span class="tt-caption tnum">待还 ${esc(money(remainingAmount))}</span>
          </div>
          <div class="recon-line">
            ${
              nextDue
                ? `<span class="tt-caption text-muted">下一期 ${esc(nextDue.dueDate)}</span>
                   <span class="tt-caption tnum">应还 ${esc(money(nextDue.totalDue))}</span>`
                : '<span class="tt-caption text-muted">已无待还期数</span>'
            }
          </div>
        </div>

        <div class="row row--sm row--wrap">
          <button class="btn btn--quiet btn--sm" type="button" data-act="detail">期明细</button>
          ${
            done
              ? ''
              : `<button class="btn btn--quiet btn--sm" type="button" data-act="pay">还下一期</button>
                 <button class="btn btn--quiet btn--sm" type="button" data-act="settle">提前结清</button>
                 <button class="btn btn--quiet btn--sm" type="button" data-act="cancel">取消分期</button>`
          }
          <button class="btn btn--quiet btn--sm" type="button" data-act="del">删除</button>
        </div>
      </div>`;
  }

  function render() {
    paintStrip();
    const active = list.filter((p) => p.status === 'active');
    const rest = list.filter((p) => p.status !== 'active');

    listSlot.innerHTML =
      list.length === 0
        ? `<div class="card empty-state">
             <span class="empty-state__icon">${lucide('credit-card', 22)}</span>
             <p class="tt-body-strong">还没有分期</p>
             <p class="tt-caption text-muted">
               买手机、家电、装修要分期时，在这儿建一次：消费即刻全额记一笔支出，
               之后每期自动生成一笔还款转账
             </p>
           </div>`
        : `<div class="inst-list">
             ${active.map(rowHtml).join('')}
             ${
               rest.length
                 ? `<p class="inst-group">已结清 / 已取消</p>${rest.map(rowHtml).join('')}`
                 : ''
             }
           </div>`;

    listSlot.querySelectorAll('[data-plan] [data-act]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-plan]').dataset.plan;
        const plan = list.find((p) => p.id === id);
        const act = btn.dataset.act;
        if (act === 'detail') openDetail(plan);
        else if (act === 'pay') payNext(plan, btn);
        else if (act === 'settle') settleEarly(plan);
        else if (act === 'cancel') cancelPlan(plan);
        else if (act === 'del') removePlan(plan);
      }),
    );
  }

  /* ---------------- 动作 ---------------- */

  async function payNext(plan, btn) {
    const next = plan.progress.nextDue;
    if (!next) {
      toast('已经没有待还的期了', 'default');
      return;
    }
    setLoading(btn, true, '还款中');
    try {
      const out = (await Api.payInstallmentSchedule(ledger.id, next.scheduleId)).data;
      await reload();
      if (out.reused) {
        toast(`第 ${next.seq} 期已经还过了`, 'default');
      } else {
        toast(
          `第 ${next.seq} 期已还 ${money(next.totalDue)}（${plan.accountName ?? ''} → ${plan.debtAccountName ?? ''}）`,
          'success',
        );
      }
    } catch (err) {
      setLoading(btn, false);
      toast(err.message, 'error');
    }
  }

  async function settleEarly(plan) {
    const pending = plan.progress.totalCount - plan.progress.paidCount;
    if (!window.confirm(`提前结清「${plan.title}」？\n\n剩余 ${pending} 期会合并成一笔转账一次还清。`)) return;
    try {
      const out = (await Api.settleInstallmentEarly(ledger.id, plan.id)).data;
      await reload();
      toast(out.reused ? '已经结清过了' : `已结清 ${money(out.amount)}（${out.periods} 期）`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function cancelPlan(plan) {
    if (
      !window.confirm(
        `取消分期「${plan.title}」？\n\n只停掉未还的期；已还的记录与那笔消费支出都会保留`,
      )
    )
      return;
    try {
      await Api.cancelInstallmentPlan(ledger.id, plan.id);
      await reload();
      toast('已取消分期', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removePlan(plan) {
    try {
      await Api.deleteInstallmentPlan(ledger.id, plan.id);
      panelSlot.replaceChildren();
      await reload();
      toast('分期已删除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 期明细 ---------------- */

  async function openDetail(plan) {
    let scheds = [];
    let startTx = null;
    try {
      [scheds, startTx] = await Promise.all([
        Api.listInstallmentSchedules(ledger.id, plan.id).then((r) => r.data),
        Api.installmentStartTransaction(ledger.id, plan.id).then((r) => r.data),
      ]);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const panel = h(`
      <div class="card">
        <div class="row row--between row--wrap row--md">
          <div>
            <p class="tt-body-strong">${esc(plan.title)} · 期明细</p>
            <p class="tt-caption text-muted">
              ${
                startTx
                  ? `消费记在 ${esc(startTx.txDate)}，金额 ${esc(money(startTx.amount))}${
                      Number(startTx.fee) ? ` + 手续费 ${esc(money(startTx.fee))}` : ''
                    }`
                  : '未找到对应的消费支出'
              }
            </p>
          </div>
          <div class="row row--sm">
            ${
              startTx
                ? `<button class="btn btn--quiet btn--sm" type="button" data-role="goto-start">看那笔支出</button>`
                : ''
            }
            <button class="btn btn--quiet btn--sm" type="button" data-role="panel-close">收起</button>
          </div>
        </div>

        <div class="inst-sched">
          ${scheds
            .map((s) => {
              const paid = s.status === 'paid';
              return `
                <div class="inst-sched__row${paid ? ' is-paid' : ''}">
                  <span class="inst-sched__seq">第 ${esc(s.seq)} 期</span>
                  <span class="tt-caption tnum">${esc(s.dueDate)}</span>
                  <span class="tt-caption text-muted tnum">
                    本金 ${esc(money(s.principal))}${Number(s.fee) ? ` + 费 ${esc(money(s.fee))}` : ''}
                  </span>
                  <span class="inst-sched__due tnum">${esc(money(s.totalDue))}</span>
                  <span class="inst-sched__state">
                    ${
                      paid
                        ? `<span class="badge badge--dark">已还</span>`
                        : `<button class="btn btn--quiet btn--sm" type="button" data-pay="${esc(s.id)}">标记已还</button>`
                    }
                  </span>
                </div>`;
            })
            .join('')}
        </div>
      </div>
    `);

    panel.querySelector('[data-role=panel-close]').addEventListener('click', () => panelSlot.replaceChildren());
    panel.querySelector('[data-role=goto-start]')?.addEventListener('click', () => {
      if (startTx && go) go(`/transactions/${encodeURIComponent(startTx.id)}`);
    });
    panel.querySelectorAll('[data-pay]').forEach((b) =>
      b.addEventListener('click', async () => {
        setLoading(b, true, '还款中');
        try {
          const out = (await Api.payInstallmentSchedule(ledger.id, b.dataset.pay)).data;
          await reload();
          toast(out.reused ? '这期已经还过了' : '已记一笔还款转账', out.reused ? 'default' : 'success');
          const fresh = list.find((p) => p.id === plan.id);
          if (fresh) openDetail(fresh);
        } catch (err) {
          setLoading(b, false);
          toast(err.message, 'error');
        }
      }),
    );
    panelSlot.replaceChildren(panel);
  }

  /* ---------------- 表单 ---------------- */

  const flatCats = (t) => {
    const out = [];
    for (const p of catRes) {
      if (p.recordType !== t) continue;
      for (const c of p.children ?? []) if (!c.archivedAt) out.push({ ...c, parentName: p.name });
    }
    return out;
  };

  function openForm(plan = null) {
    const rt0 = plan?.recordType ?? 'expense';
    const feeMode0 = plan?.feeMode ?? 'once';
    const handling0 = plan?.feeHandling ?? 'first_period';
    const accName = (id) => accounts.find((a) => a.id === id)?.name ?? '';

    const accOptions = (selected) =>
      groups
        .map((g) => {
          const inGroup = accounts.filter((a) => a.groupId === g.id);
          if (!inGroup.length) return '';
          return `<optgroup label="${esc(g.name)}">${inGroup
            .map(
              (a) =>
                `<option value="${esc(a.id)}"${selected === a.id ? ' selected' : ''}>${esc(a.name)}</option>`,
            )
            .join('')}</optgroup>`;
        })
        .join('');

    const cat0 = plan?.categoryId ?? '';
    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <div class="row row--between row--wrap">
            <p class="tt-body-strong">${plan ? `编辑「${esc(plan.title)}」` : '新建分期'}</p>
            <span class="tt-fine-print">同一账本内不可重名</span>
          </div>

          <div class="field-row">
            <div class="field" data-field="title">
              <label class="field__label" for="ins-title">名称</label>
              <input class="input" id="ins-title" name="title" maxlength="40"
                     value="${esc(plan?.title ?? '')}" placeholder="例如：iPhone 17 Pro" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="totalAmount">
              <label class="field__label" for="ins-total">本金总额（元）</label>
              <input class="input" id="ins-total" name="totalAmount" inputmode="decimal"
                     value="${esc(plan?.totalAmount ?? '')}" placeholder="12000.00" data-money />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="installmentCount">
              <label class="field__label" for="ins-count">期数</label>
              <input class="input" id="ins-count" name="installmentCount" type="number"
                     inputmode="numeric" min="1" max="60" value="${esc(String(plan?.installmentCount ?? 12))}" />
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="recordType">
              <label class="field__label" for="ins-rt">记录类型</label>
              <select class="input select" id="ins-rt" name="recordType">
                ${PLAN_TYPES.map(
                  (t) => `<option value="${t}"${rt0 === t ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="field" data-field="debtAccountId">
              <label class="field__label" for="ins-debt">刷卡 / 消费账户</label>
              <select class="input select" id="ins-debt" name="debtAccountId">
                <option value="">请选择</option>
                ${accOptions(plan?.debtAccountId ?? '')}
              </select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="accountId">
              <label class="field__label" for="ins-acc">还款扣款账户</label>
              <select class="input select" id="ins-acc" name="accountId">
                <option value="">请选择</option>
                ${accOptions(plan?.accountId ?? '')}
              </select>
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="categoryId">
              <label class="field__label" for="ins-cat">分类</label>
              <select class="input select" id="ins-cat" name="categoryId">
                <option value="">请选择</option>
                ${flatCats(rt0)
                  .map(
                    (c) =>
                      `<option value="${esc(c.id)}"${cat0 === c.id ? ' selected' : ''}>${esc(
                        `${c.parentName} › ${c.name}`,
                      )}</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="firstDate">
              <label class="field__label" for="ins-first">首期还款日</label>
              <input class="input" id="ins-first" name="firstDate" type="date"
                     value="${esc(plan?.firstDate ?? '')}" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="frequency">
              <label class="field__label" for="ins-freq">还款频率</label>
              <select class="input select" id="ins-freq" name="frequency">
                ${Object.entries(FREQ)
                  .map(
                    ([k, v]) =>
                      `<option value="${k}"${(plan?.frequency ?? 'monthly') === k ? ' selected' : ''}>${esc(v)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="feeMode">
              <label class="field__label" for="ins-fm">手续费方式</label>
              <select class="input select" id="ins-fm" name="feeMode">
                ${Object.entries(FEE_MODE)
                  .map(
                    ([k, v]) => `<option value="${k}"${feeMode0 === k ? ' selected' : ''}>${esc(v.label)}</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__hint">${esc(FEE_MODE[feeMode0]?.hint ?? '')}</span>
            </div>
            <div class="field" data-field="totalFee" data-role="f-once">
              <label class="field__label" for="ins-fee">手续费总额（元）</label>
              <input class="input" id="ins-fee" name="totalFee" inputmode="decimal"
                     value="${esc(plan?.totalFee ?? '0')}" data-money />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="perPeriodFee" data-role="f-per" hidden>
              <label class="field__label" for="ins-pfee">每期手续费（元）</label>
              <input class="input" id="ins-pfee" name="perPeriodFee" inputmode="decimal"
                     value="${esc(plan?.perPeriodFee ?? '0')}" data-money />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="feeHandling">
              <label class="field__label" for="ins-fh">手续费摊法</label>
              <select class="input select" id="ins-fh" name="feeHandling">
                ${Object.entries(FEE_HANDLING)
                  .map(
                    ([k, v]) => `<option value="${k}"${handling0 === k ? ' selected' : ''}>${esc(v)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
          </div>

          <div class="row row--sm">
            <button class="btn btn--primary" type="submit">${plan ? '保存修改' : '创建分期'}</button>
            <button class="btn btn--quiet" type="button" data-role="cancel">取消</button>
          </div>
          <p class="tt-fine-print text-muted">
            创建即记一笔全额支出到「刷卡 / 消费账户」（含手续费），之后每期自动生成一笔还款转账。
            ${plan ? '⚠️ 改金额或期数会重建未还的期表，已还的期保留。' : ''}
          </p>
        </form>
      </div>
    `);

    const f = form.querySelector('form');
    const rtSel = f.querySelector('#ins-rt');
    const catSel = f.querySelector('#ins-cat');
    const fmSel = f.querySelector('#ins-fm');
    const onceWrap = f.querySelector('[data-role=f-once]');
    const perWrap = f.querySelector('[data-role=f-per]');
    const debtSel = f.querySelector('#ins-debt');
    const accSel = f.querySelector('#ins-acc');

    /** 分类候选项跟着记录类型走 —— 后端会校验「分类类型须与 record_type 匹配」 */
    const syncType = () => {
      const keep = catSel.value;
      catSel.innerHTML =
        '<option value="">请选择</option>' +
        flatCats(rtSel.value)
          .map((c) => `<option value="${esc(c.id)}">${esc(`${c.parentName} › ${c.name}`)}</option>`)
          .join('');
      if (catSel.value !== keep) catSel.value = '';
    };
    rtSel.addEventListener('change', syncType);
    syncType();

    /** 手续费方式决定要填总额还是每期额 —— 后端按 feeMode 推导另一个 */
    const syncFee = () => {
      const per = fmSel.value === 'per_period';
      onceWrap.hidden = per;
      perWrap.hidden = !per;
      f.querySelector('[data-field=feeMode] .field__hint').textContent = FEE_MODE[fmSel.value]?.hint ?? '';
    };
    fmSel.addEventListener('change', syncFee);
    syncFee();

    /** 两个账户不能相同 —— 后端有同一条规则，这里是即时反馈而非兜底 */
    const guardSame = () => {
      const same = debtSel.value && debtSel.value === accSel.value;
      const target = f.querySelector('[data-field=accountId] .field__error');
      if (target) target.textContent = same ? '还款账户不能与消费账户相同' : '';
      return !same;
    };
    debtSel.addEventListener('change', guardSame);
    accSel.addEventListener('change', guardSame);

    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = f.querySelector('button[type=submit]');
      const title = f.title.value.trim();
      if (!title) {
        f.title.focus();
        toast('名称不能为空', 'error');
        return;
      }
      const totalCents = parseAmountToCents(f.totalAmount.value);
      if (totalCents === null || totalCents <= 0) {
        f.totalAmount.focus();
        toast('本金总额必须大于 0', 'error');
        return;
      }
      if (!guardSame()) {
        toast('还款账户不能与消费账户相同', 'error');
        return;
      }
      if (!accName(f.debtAccountId.value) || !accName(f.accountId.value)) {
        toast('请选择消费账户与还款账户', 'error');
        return;
      }
      if (!f.firstDate.value) {
        f.firstDate.focus();
        toast('请选择首期还款日', 'error');
        return;
      }
      setLoading(submit, true, '保存中');

      const per = fmSel.value === 'per_period';
      const payload = {
        title,
        totalAmount: f.totalAmount.value,
        installmentCount: Number(f.installmentCount.value || 1),
        firstDate: f.firstDate.value,
        frequency: f.frequency.value,
        feeMode: fmSel.value,
        // 隐藏的那个一律给 0 —— 留着旧值会让后端按另一种方式再算一遍手续费
        totalFee: per ? undefined : sanitizeFee(f.totalFee.value),
        perPeriodFee: per ? sanitizeFee(f.perPeriodFee.value) : undefined,
        feeHandling: f.feeHandling.value,
        accountId: f.accountId.value,
        debtAccountId: f.debtAccountId.value,
        recordType: rtSel.value,
        categoryId: catSel.value || null,
      };

      try {
        if (plan) {
          await Api.updateInstallmentPlan(ledger.id, plan.id, payload);
          toast(`「${title}」已更新`, 'success');
        } else {
          await Api.createInstallmentPlan(ledger.id, payload);
          toast(`「${title}」已创建，并已记一笔全额支出`, 'success');
        }
        formSlot.replaceChildren();
        panelSlot.replaceChildren();
        await reload();
      } catch (err) {
        setLoading(submit, false);
        if (Array.isArray(err?.details) && err.details.length) {
          const map = Object.fromEntries(err.details.map((d) => [d.field, d.message]));
          if (!applyFieldErrors(f, map)) toast(err.message, 'error');
        } else {
          toast(err.message, 'error');
        }
      }
    });

    formSlot.replaceChildren(form);
    panelSlot.replaceChildren();
    f.title.focus();
  }

  frame.querySelector('[data-action=add]').addEventListener('click', () => openForm(null));

  render();
  return null;
}
