/**
 * 周期账单管理（`docs/05 §11.3`）：规则列表 / 未来几期预览 / 已生成的账单 / 暂停恢复。
 *
 * ## 这一页最关键的交互是「频率 → 专属字段」的联动
 *
 * 频率一变，要填的字段就换一套：日无专属、周要星期几、月要几号、年要几月。
 * 这些字段**默认全部显隐好**，而不是等 JS 切换 —— 表单是原生控件，
 * 用 hidden 属性切换已经足够，少一个状态就少一类「填了残留值被提交」的错。
 *
 * 隐藏的字段提交时一律给 `null`（不是留着旧值）：后端对「给了不该给的参数」是宽容的，
 * 但留着旧值会让「我明明改成了每周」在数据里仍带着一个 dayOfMonth=1 显得莫名其妙。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { esc, h, icon, lucide, money, setLoading, toast, applyFieldErrors } from '../ui.js';
import { RECORD_TYPES, parseAmountToCents } from '../lib/amounts.js';

const TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  receivable: '应收款项',
  payable: '应付款项',
  adjustment: '余额调整',
};
/** 余额调整不能做周期规则（它只由对账生成，docs/05 §9.5） */
const TEMPLATABLE = RECORD_TYPES.filter((t) => t !== 'adjustment');

const FREQ = {
  daily: { label: '每天 / 每 N 天', unit: '天' },
  weekly: { label: '每周 / 每 N 周', unit: '周' },
  monthly: { label: '每月 / 每 N 月', unit: '月' },
  yearly: { label: '每年 / 每 N 年', unit: '年' },
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export async function renderRecurring(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  const [ruleRes, accRes, grpRes, catRes, tagRes] = await Promise.all([
    Api.listRecurringRules(ledger.id).then((r) => r.data),
    Api.listAccounts(ledger.id).then((r) => r.data),
    Api.listAccountGroups(ledger.id).then((r) => r.data),
    Api.listCategories(ledger.id).then((r) => r.data),
    Api.listTags(ledger.id).then((r) => r.data),
  ]);

  let list = ruleRes;
  /** 周期账单只能用真实账户（虚拟账户是台账口径，后端也会 400） */
  const accounts = accRes.filter((a) => a.kind !== 'virtual' && !a.archivedAt);
  const groups = grpRes.filter((g) => !g.archivedAt);
  const tags = tagRes.filter((t) => !t.archivedAt);

  const frame = appFrame({
    active: 'recurring',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">周期账单</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 房租、话费、订阅这类固定支出与收入，交给它自动记
            </p>
          </div>
          <button class="btn btn--sm" type="button" data-action="add">新建规则</button>
        </div>
      </div>

      <div data-role="panel-slot"></div>
      <div data-role="form-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'recurring', go, ledger });

  const panelSlot = frame.querySelector('[data-role=panel-slot]');
  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');

  /* ---------------- 频率描述 ---------------- */

  /** 把规则讲成人话：「每月 1 号」「每 2 周的周一」「每天」 */
  function freqText(r) {
    const every = r.intervalCount > 1 ? `每 ${r.intervalCount} ` : '每';
    if (r.frequency === 'daily') return r.intervalCount > 1 ? `每 ${r.intervalCount} 天` : '每天';
    if (r.frequency === 'weekly') {
      return `${every === '每' ? '每' : '每 '}${r.intervalCount > 1 ? r.intervalCount : ''}周的${
        WEEKDAYS[r.weekDay ?? 1] ?? ''
      }`.replace('每周的', '每周的').replace('每周的', '每周');
    }
    if (r.frequency === 'monthly') {
      return r.intervalCount > 1 ? `每 ${r.intervalCount} 个月的 ${r.dayOfMonth ?? 1} 号` : `每月 ${r.dayOfMonth ?? 1} 号`;
    }
    return r.intervalCount > 1 ? `每 ${r.intervalCount} 年` : '每年';
  }

  /* ---------------- 列表 ---------------- */

  function rowHtml(r) {
    const paused = r.status === 'paused';
    const err = (r.warnings ?? []).find((w) => w.level === 'error');
    const soft = (r.warnings ?? []).find((w) => w.level === 'warn');
    const marks = [
      paused ? '<span class="badge badge--dark">已暂停</span>' : '',
      err ? `<span class="rcm-row__warn" title="${esc(err.message)}">${lucide('triangle-alert', 13)}</span>` : '',
      soft ? `<span class="rcm-row__warn rcm-row__warn--soft" title="${esc(soft.message)}">${lucide('info', 13)}</span>` : '',
    ].join('');
    const next = r.nextDueDate
      ? `<span class="rcm-row__next">下次 ${esc(r.nextDueDate)}</span>`
      : '<span class="rcm-row__next rcm-row__next--none">没有下一期</span>';
    return `
      <div class="rcm-row${paused ? ' is-paused' : ''}" data-rule="${esc(r.id)}">
        <span class="rcm-row__main">
          <span class="tt-body-strong">${esc(r.name)}${marks}</span>
          <span class="tt-fine-print">
            ${esc(freqText(r))} · ${esc(r.accountName ?? '—')} → ${esc(TYPE_LABEL[r.recordType] ?? r.recordType)}
            ${r.categoryName ? ` · ${esc(r.categoryName)}` : ''}
          </span>
        </span>
        <span class="rcm-row__amount tnum">${esc(money(r.amount))}</span>
        ${next}
        <span class="rcm-row__acts">
          <button class="btn btn--quiet btn--sm" type="button" data-act="preview">预览</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="run">立即生成</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="toggle">
            ${paused ? '恢复' : '暂停'}
          </button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="edit">编辑</button>
          <button class="btn btn--quiet btn--sm" type="button" data-act="del">删除</button>
        </span>
      </div>`;
  }

  function render() {
    const active = list.filter((r) => r.status === 'active');
    const paused = list.filter((r) => r.status !== 'active');
    listSlot.innerHTML = `
      <div class="list-meta">
        <span class="tt-fine-print">
          ${active.length} 条进行中${paused.length ? ` · ${paused.length} 条已暂停` : ''}
        </span>
        <span class="tt-fine-print">每天凌晨自动生成，提前天数到期的账会先出来</span>
      </div>
      ${
        list.length === 0
          ? `<div class="card empty-state">
               <span class="empty-state__icon">${lucide('calendar', 22)}</span>
               <p class="tt-body-strong">还没有周期账单</p>
               <p class="tt-caption text-muted">
                 房租、话费、视频订阅、固定工资这类重复发生的账，设一次就不用再记
               </p>
             </div>`
          : `<div class="rcm-list">
               ${active.map(rowHtml).join('')}
               ${paused.length ? '<p class="rcm-group">已暂停</p>' : ''}
               ${paused.map(rowHtml).join('')}
             </div>`
      }
    `;

    listSlot.querySelectorAll('.rcm-row [data-act]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-rule]').dataset.rule;
        const rule = list.find((r) => r.id === id);
        const act = btn.dataset.act;
        if (act === 'edit') openForm(rule);
        else if (act === 'del') removeRule(rule);
        else if (act === 'toggle') togglePause(rule);
        else if (act === 'run') runNow(rule, btn);
        else if (act === 'preview') openPreview(rule);
      }),
    );
  }

  const reload = async () => {
    list = (await Api.listRecurringRules(ledger.id)).data;
    render();
  };

  /* ---------------- 动作 ---------------- */

  async function togglePause(rule) {
    try {
      if (rule.status === 'paused') {
        await Api.resumeRecurringRule(ledger.id, rule.id);
        toast(`「${rule.name}」已恢复`, 'success');
      } else {
        await Api.pauseRecurringRule(ledger.id, rule.id);
        toast(`「${rule.name}」已暂停，不再自动出账`, 'success');
      }
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function runNow(rule, btn) {
    setLoading(btn, true, '生成中');
    try {
      const out = (await Api.runRecurringRuleNow(ledger.id, rule.id)).data;
      await reload();
      toast(
        out.reused
          ? `${out.dueDate} 那期已经生成过了`
          : `已生成 ${out.dueDate} 的${TYPE_LABEL[rule.recordType] ?? ''} ${money(rule.amount)}`,
        out.reused ? 'default' : 'success',
      );
    } catch (err) {
      setLoading(btn, false);
      toast(err.message, 'error');
    }
  }

  async function removeRule(rule) {
    if (
      !window.confirm(
        `删除规则「${rule.name}」？\n\n已生成的账单**不会**被删除 —— 它们是已经记过的账。`,
      )
    )
      return;
    try {
      await Api.deleteRecurringRule(ledger.id, rule.id);
      await reload();
      toast('规则已删除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- 预览 / 已生成 ---------------- */

  async function openPreview(rule) {
    panelSlot.replaceChildren();
    let preview = [];
    let generated = [];
    try {
      const [p, g] = await Promise.all([
        Api.previewRecurringRule(ledger.id, rule.id, 5).then((r) => r.data),
        Api.generatedByRecurringRule(ledger.id, rule.id, 12).then((r) => r.data),
      ]);
      preview = p ?? [];
      generated = g ?? [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const panel = h(`
      <div class="card">
        <div class="row row--between row--wrap">
          <p class="tt-body-strong">「${esc(rule.name)}」的未来与已生成</p>
          <button class="btn btn--quiet btn--sm" type="button" data-role="panel-close">收起</button>
        </div>
        <div class="rcm-panel__cols">
          <section>
            <p class="rcm-panel__h">未来 5 期</p>
            ${
              preview.length
                ? `<ul class="rcm-panel__list">${preview
                    .map(
                      (p) =>
                        `<li class="rcm-panel__item">
                           <span class="tnum">${esc(p.dueDate)}</span>
                           <span class="tnum text-muted">${esc(money(p.amount))}</span>
                           <button class="btn btn--quiet btn--sm" type="button" data-skip="${esc(p.dueDate)}">跳过这期</button>
                         </li>`,
                    )
                    .join('')}</ul>`
                : '<p class="tt-fine-print">这条规则已经没有下一期了</p>'
            }
          </section>
          <section>
            <p class="rcm-panel__h">已生成 ${generated.length ? `（最近 ${generated.length} 笔）` : ''}</p>
            ${
              generated.length
                ? `<ul class="rcm-panel__list">${generated
                    .map(
                      (g) =>
                        `<li class="rcm-panel__item${g.deleted ? ' is-deleted' : ''}">
                           <span class="tnum">${esc(g.txDate)}</span>
                           <span class="tnum text-muted">${esc(money(g.amount))}</span>
                           <span class="tt-fine-print">${g.deleted ? '已删除' : '已入账'}</span>
                           ${
                             g.deleted
                               ? `<button class="btn btn--quiet btn--sm" type="button" data-unskip="${esc(g.txDate)}">取消跳过</button>`
                               : `<button class="btn btn--quiet btn--sm" type="button" data-skip="${esc(g.txDate)}">跳过这期</button>`
                           }
                         </li>`,
                    )
                    .join('')}</ul>`
                : '<p class="tt-fine-print">还没生成过</p>'
            }
          </section>
        </div>
      </div>
    `);

    panel.querySelector('[data-role=panel-close]').addEventListener('click', () => panelSlot.replaceChildren());
    panel.querySelectorAll('[data-skip]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await Api.skipRecurringDate(ledger.id, rule.id, b.dataset.skip);
          toast(`已跳过 ${b.dataset.skip} 那期`, 'success');
          await reload();
          openPreview(list.find((r) => r.id === rule.id));
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
    panel.querySelectorAll('[data-unskip]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await Api.unskipRecurringDate(ledger.id, rule.id, b.dataset.unskip);
          toast('已取消跳过', 'success');
          await reload();
          openPreview(list.find((r) => r.id === rule.id));
        } catch (err) {
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

  function openForm(rule = null) {
    const f0 = rule?.frequency ?? 'monthly';
    const rt0 = rule?.recordType ?? 'expense';

    const accOptions = (selected, includeEmpty = true) =>
      (includeEmpty ? '<option value="">不指定</option>' : '') +
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

    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <div class="row row--between row--wrap">
            <p class="tt-body-strong">${rule ? `编辑「${esc(rule.name)}」` : '新建周期账单'}</p>
            <span class="tt-fine-print">最多 30 字，同一账本内不可重名</span>
          </div>

          <div class="field-row">
            <div class="field" data-field="name">
              <label class="field__label" for="rc-name">名称</label>
              <input class="input" id="rc-name" name="name" maxlength="30"
                     value="${esc(rule?.name ?? '')}" placeholder="例如：房租" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="amount">
              <label class="field__label" for="rc-amount">金额（元）</label>
              <input class="input" id="rc-amount" name="amount" inputmode="decimal"
                     value="${esc(rule?.amount && rule.amount !== '0.00' ? rule.amount : '')}"
                     placeholder="4500.00" data-money />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="recordType">
              <label class="field__label" for="rc-rt">记录类型</label>
              <select class="input select" id="rc-rt" name="recordType">
                ${TEMPLATABLE.map(
                  (t) =>
                    `<option value="${t}"${rt0 === t ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`,
                ).join('')}
              </select>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="frequency">
              <label class="field__label" for="rc-freq">频率</label>
              <select class="input select" id="rc-freq" name="frequency">
                ${Object.entries(FREQ)
                  .map(
                    ([k, v]) =>
                      `<option value="${k}"${f0 === k ? ' selected' : ''}>${esc(v.label)}</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="intervalCount">
              <label class="field__label" for="rc-interval">间隔（个周期）</label>
              <input class="input" id="rc-interval" name="intervalCount" type="number" inputmode="numeric"
                     min="1" max="365" value="${esc(String(rule?.intervalCount ?? 1))}" />
            </div>
            <div class="field" data-field="dayOfMonth" data-role="f-monthly" hidden>
              <label class="field__label" for="rc-dom">每月几号</label>
              <input class="input" id="rc-dom" name="dayOfMonth" type="number" inputmode="numeric"
                     min="1" max="31" value="${esc(String(rule?.dayOfMonth ?? 1))}" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="weekDay" data-role="f-weekly" hidden>
              <label class="field__label" for="rc-wd">星期几</label>
              <select class="input select" id="rc-wd" name="weekDay">
                ${WEEKDAYS.map(
                  (w, i) =>
                    `<option value="${i}"${(rule?.weekDay ?? 1) === i ? ' selected' : ''}>${esc(w)}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="field" data-field="month" data-role="f-yearly" hidden>
              <label class="field__label" for="rc-month">几月</label>
              <select class="input select" id="rc-month" name="month">
                ${Array.from({ length: 12 }, (_, i) => i + 1)
                  .map(
                    (m) =>
                      `<option value="${m}"${(rule?.month ?? 1) === m ? ' selected' : ''}>${m} 月</option>`,
                  )
                  .join('')}
              </select>
            </div>
          </div>

          <label class="check" data-role="f-monthly-end" hidden>
            <input type="checkbox" name="maxMonthEnd" ${rule ? (rule.maxMonthEnd ? 'checked' : '') : 'checked'} />
            <span>设成 31 号而那个月没 31 天时，自动取月末（2 月 → 28/29），不跳过</span>
          </label>

          <div class="field-row">
            <div class="field" data-field="startDate">
              <label class="field__label" for="rc-start">开始日期</label>
              <input class="input" id="rc-start" name="startDate" type="date"
                     value="${esc(rule?.startDate ?? new Date().toISOString().slice(0, 10))}" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="endDate">
              <label class="field__label" for="rc-end">结束日期（可空 = 长期）</label>
              <input class="input" id="rc-end" name="endDate" type="date"
                     value="${esc(rule?.endDate ?? '')}" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="generateAheadDays">
              <label class="field__label" for="rc-ahead">提前几天生成</label>
              <input class="input" id="rc-ahead" name="generateAheadDays" type="number" inputmode="numeric"
                     min="0" max="30" value="${esc(String(rule?.generateAheadDays ?? 1))}" />
              <span class="field__hint">1 = 到期前一天就出现在账单列表里</span>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="accountId">
              <label class="field__label" for="rc-acc">账户</label>
              <select class="input select" id="rc-acc" name="accountId">${accOptions(
                rule?.accountId ?? null,
                false,
              )}</select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="toAccountId" data-role="f-transfer" hidden>
              <label class="field__label" for="rc-to">转入账户</label>
              <select class="input select" id="rc-to" name="toAccountId">${accOptions(
                rule?.toAccountId ?? null,
              )}</select>
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="categoryId">
              <label class="field__label" for="rc-cat">分类</label>
              <!-- 分类**必填**：createTransaction 强制要求，规则不带分类就永远生成不出来 -->
              <select class="input select" id="rc-cat" name="categoryId">
                <option value="">请选择分类</option>
                ${flatCats(rt0)
                  .map(
                    (c) =>
                      `<option value="${esc(c.id)}"${rule?.categoryId === c.id ? ' selected' : ''}>${esc(
                        `${c.parentName} › ${c.name}`,
                      )}</option>`,
                  )
                  .join('')}
              </select>
              <span class="field__error"></span>
            </div>
          </div>

          <div class="field-row">
            <div class="field" data-field="title">
              <label class="field__label" for="rc-title">账单名称</label>
              <input class="input" id="rc-title" name="title" maxlength="50"
                     value="${esc(rule?.title ?? '')}" placeholder="不填就用名称" />
            </div>
            <div class="field" data-field="merchant">
              <label class="field__label" for="rc-merchant">商家</label>
              <input class="input" id="rc-merchant" name="merchant" maxlength="50"
                     value="${esc(rule?.merchant ?? '')}" />
            </div>
          </div>

          <label class="check">
            <input type="checkbox" name="autoCreate" ${rule ? (rule.autoCreate ? 'checked' : '') : 'checked'} />
            <span>到期自动生成（关掉就只剩「立即生成」这个手动入口）</span>
          </label>

          <div class="row">
            <button class="btn btn--sm" type="submit">${rule ? '保存' : '创建'}</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          </div>
        </form>
      </div>
    `);

    const f = form.querySelector('form');
    const freqSel = f.frequency;
    const rtSel = f.recordType;
    const catSel = f.categoryId;

    /** 频率专属字段的显隐（页面最关键的联动，全在这里） */
    const syncFreq = () => {
      const v = freqSel.value;
      form.querySelectorAll('[data-role=f-weekly]').forEach((el) => (el.hidden = v !== 'weekly'));
      form.querySelectorAll('[data-role=f-monthly]').forEach((el) => (el.hidden = v !== 'monthly'));
      form.querySelectorAll('[data-role=f-yearly]').forEach((el) => (el.hidden = v !== 'yearly'));
    };
    freqSel.addEventListener('change', syncFreq);
    syncFreq();

    const syncType = () => {
      form.querySelectorAll('[data-role=f-transfer]').forEach((el) => (el.hidden = rtSel.value !== 'transfer'));
      const keep = catSel.value;
      catSel.innerHTML =
        '<option value="">请选择分类</option>' +
        flatCats(rtSel.value)
          .map(
            (c) =>
              `<option value="${esc(c.id)}"${keep === c.id ? ' selected' : ''}>${esc(
                `${c.parentName} › ${c.name}`,
              )}</option>`,
          )
          .join('');
      if (catSel.value !== keep) catSel.value = '';
    };
    rtSel.addEventListener('change', syncType);
    syncType();

    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = f.querySelector('button[type=submit]');
      const name = f.name.value.trim();
      if (!name) {
        f.name.focus();
        toast('名称不能为空', 'error');
        return;
      }
      const amountCents = parseAmountToCents(f.amount.value);
      if (amountCents === null || amountCents <= 0) {
        f.amount.focus();
        toast('金额必须大于 0', 'error');
        return;
      }
      setLoading(submit, true, '保存中');

      const v = freqSel.value;
      const num = (name2, def) => {
        const raw = f[name2]?.value;
        return raw === '' || raw === undefined ? def : Number(raw);
      };
      const payload = {
        name,
        recordType: rtSel.value,
        accountId: f.accountId.value || null,
        toAccountId: rtSel.value === 'transfer' ? f.toAccountId.value || null : null,
        categoryId: catSel.value || null,
        frequency: v,
        intervalCount: num('intervalCount', 1),
        startDate: f.startDate.value,
        endDate: f.endDate.value || null,
        // 隐藏的字段一律给 null：留着旧值会让「我明明改成了每周」在数据里仍带一个 dayOfMonth
        dayOfMonth: v === 'monthly' ? num('dayOfMonth', 1) : null,
        weekDay: v === 'weekly' ? num('weekDay', 1) : null,
        month: v === 'yearly' ? num('month', 1) : null,
        maxMonthEnd: f.maxMonthEnd.checked,
        amount: f.amount.value,
        fee: '0',
        discount: '0',
        title: f.title.value.trim() || null,
        merchant: f.merchant.value.trim() || null,
        note: null,
        tagIds: [],
        generateAheadDays: num('generateAheadDays', 1),
        autoCreate: f.autoCreate.checked,
      };

      try {
        if (rule) {
          await Api.updateRecurringRule(ledger.id, rule.id, payload);
          toast(`「${name}」已更新`, 'success');
        } else {
          await Api.createRecurringRule(ledger.id, payload);
          toast(`「${name}」已创建`, 'success');
        }
        formSlot.replaceChildren();
        panelSlot.replaceChildren();
        await reload();
      } catch (err) {
        setLoading(submit, false);
        if (Array.isArray(err?.details) && err.details.length) {
          const map = Object.fromEntries(err.details.map((d) => [d.field, d.message]));
          if (applyFieldErrors(f, map)) toast('有字段填得不对', 'error');
          else toast(err.message, 'error');
        } else {
          // 暂停状态不能被这条路径绕开（后端会拒），错误直接落到名称框旁
          const wrap = f.querySelector('[data-field=name] .field__error');
          if (wrap) wrap.textContent = err.message;
          toast(err.message, 'error');
        }
      }
    });

    formSlot.replaceChildren(form);
    f.name.focus();
  }

  frame.querySelector('[data-action=add]').addEventListener('click', () => openForm(null));

  render();
  return null;
}