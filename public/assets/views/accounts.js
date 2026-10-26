/**
 * 账户 —— 记账的「钱包台账」。
 * 本期能力：分组浏览实时余额、分组的新建/改名/换图标/停用/恢复、新建/编辑/归档账户、
 *          期初余额与期初日期、信用卡扩展字段、账户对账（预览差异 → 选原因 → 生成调整单）。
 * 余额口径见 docs/03 §2.1；余额不可直接编辑（docs/03 §2.3）。
 *
 * 账户分组的约束（镜像后端 service.ts）：
 *   · 删除分组**不带走账户** —— 组内账户统一移到「未分组」；
 *   · 停用（而非删除）用于「名字还要留着、暂时不用」的场景，可随时恢复。
 *
 * 账户的两种「离开日常列表」方式：
 *   · 归档 = 以后不怎么用，但历史还要查（可取消归档）；
 *   · 删除 = 这条记录本身是错的（不可恢复），有账单引用时后端会拒绝。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import {
  ACCOUNT_KIND_LABEL,
  ACCOUNT_TYPE_LABEL,
  RECONCILE_REASON_LABEL,
  applyFieldErrors,
  clearFieldErrors,
  accountIcon,
  confirmDialog,
  entityIcon,
  esc,
  formatDate,
  h,
  lucide,
  money,
  setLoading,
  todayStr,
  toast,
} from '../ui.js';

/** 可手工创建的账户类型（排除 3 个系统虚拟类型） */
const CREATABLE_TYPES = [
  'cash',
  'debit_card',
  'credit_card',
  'third_party',
  'prepaid',
  'investment',
  'fixed_deposit',
  'loan',
  'other',
];

/** 分组类型（组织维度：只影响归类展示，不影响净资产计算） */
const GROUP_KINDS = ['asset', 'liability', 'virtual'];

/** 分组图标候选集（Lucide），覆盖钱包台账语义 */
const GROUP_ICON_CHOICES = [
  'banknote', 'banknote-x', 'landmark', 'building-2', 'house', 'credit-card',
  'card-sim', 'wallet', 'coins', 'piggy-bank', 'vault', 'hand-coins',
  'badge-dollar-sign', 'circle-dollar-sign', 'circle-percent', 'receipt',
  'calculator', 'scale', 'shield', 'gem', 'boxes', 'package', 'briefcase',
  'store', 'globe', 'smartphone', 'laptop', 'trending-up', 'trending-down',
  'link', 'ticket-percent',
];

const REASONS = Object.keys(RECONCILE_REASON_LABEL);

/**
 * 差异归因候选的展示（R-02）。
 *
 * ## 它与「差异原因」的区别
 *
 * · 差异原因（`REASONS`）是**会计口径**：`bank_fee` 决定调整单记成什么。
 * · 归因（本函数）是**业务事实**：「这 300 元是漏记的一笔地铁充值」。
 *
 * 前者是记账必须选的技术字段，后者是帮用户回忆的**可选项** ——
 * 所以这里不做必填、不做校验、不给「不填就报错」的压力。
 * 用户勾了哪几条、填了多少金额，会随对账记录一起存下来，
 * 下次复查时能看到「上次的差额后来是怎么解释的」。
 */
const ATTR_HINT = {
  missing_entry: 'App 里没有这笔，银行有',
  wrong_entry: '有，但金额或方向记错了',
  duplicate: '同一笔被记了两次',
  in_transit: '刚发生，两边还没同步',
};

function attributionBlock(p) {
  const list = p.attributions ?? [];
  if (!list.length) return '';
  return `
    <div class="field recon__attr" data-role="attribution">
      <span class="field__label">这笔差额可能是什么？（可选）</span>
      <p class="tt-fine-print text-muted">
        勾中你认为成立的几条；金额可以只填其中一条。选填不影响对账结果。
      </p>
      ${list
        .map(
          (a) => `
        <label class="check recon__attr-item">
          <input type="checkbox" data-attr="${esc(a.kind)}" />
          <span class="recon__attr-main">
            <span class="tt-caption">${esc(a.label)}</span>
            <span class="tt-fine-print text-muted">${esc(ATTR_HINT[a.kind] ?? '')}</span>
            ${a.evidence ? `<span class="tt-fine-print text-muted">${esc(a.evidence)}</span>` : ''}
          </span>
          ${
            a.amount !== null && a.amount !== undefined
              ? `<input class="input recon__attr-amt" inputmode="decimal" data-attr-for="${esc(a.kind)}"
                         placeholder="${esc(a.amount)}" value="${esc(a.amount)}" />`
              : ''
          }
        </label>`,
        )
        .join('')}
    </div>`;
}

function toneClass(v) {
  const n = Number(v);
  return n > 0 ? 'is-pos' : n < 0 ? 'is-neg' : '';
}

function option(value, label, selected) {
  return `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`;
}

function typeOptions(selected) {
  return CREATABLE_TYPES.map((t) => option(t, ACCOUNT_TYPE_LABEL[t] ?? t, selected)).join('');
}

/* =====================================================================
 * 账户分组表单（新建 / 编辑 / 删除 / 恢复）
 * ===================================================================== */
function groupForm({ group = null }) {
  const isEdit = Boolean(group);
  const currentKind = group?.kind ?? 'asset';
  const currentIcon = group?.icon ?? 'banknote';

  const kindButtons = GROUP_KINDS.map(
    (k) => `
      <button class="segmented__item" type="button" role="radio" data-kind="${esc(k)}"
              aria-selected="${k === currentKind}">${esc(ACCOUNT_KIND_LABEL[k] ?? k)}</button>`,
  ).join('');

  const iconGrid = GROUP_ICON_CHOICES.map(
    (name) => `
      <button class="icon-grid__item${name === currentIcon ? ' is-on' : ''}" type="button" role="radio"
              aria-checked="${name === currentIcon}" data-value="${esc(name)}" title="${esc(name)}">
        ${lucide(name, 18)}
      </button>`,
  ).join('');

  const form = h(`
    <div class="card">
      <form novalidate class="stack stack--md">
        <div class="row row--between">
          <p class="tt-body-strong">${isEdit ? `编辑分组「${esc(group.name)}」` : '新建账户分组'}</p>
          ${group?.archivedAt ? '<span class="badge badge--dark">已停用</span>' : '<span class="badge">账户分组</span>'}
        </div>

        <div class="field-row">
          <div class="field field--wide" data-field="name">
            <label class="field__label">分组名称</label>
            <input class="input" name="name" value="${esc(group?.name ?? '')}"
                   placeholder="例如：境外账户 / 借出去的钱" maxlength="20" />
            <span class="field__error"></span>
          </div>
          <div class="field" data-field="kind">
            <label class="field__label">类型</label>
            <div class="segmented" data-role="kind" role="radiogroup" aria-label="分组类型">
              ${kindButtons}
            </div>
            <span class="field__error"></span>
          </div>
        </div>

        <div class="field">
          <label class="field__label">图标</label>
          <div class="icon-grid" role="radiogroup" aria-label="图标">${iconGrid}</div>
        </div>

        <p class="tt-fine-print">
          分组只决定账户在列表里的归类；净资产按账户自身的资产 / 负债属性计算，与分组类型无关。
        </p>

        <div class="row">
          <button class="btn btn--sm" type="submit">${isEdit ? '保存' : '创建分组'}</button>
          <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          ${
            isEdit && !group.archivedAt
              ? `<button class="btn btn--quiet btn--sm" type="button" data-role="archive">停用分组</button>
                 <button class="btn btn--danger btn--sm" type="button" data-role="remove">删除分组</button>`
              : ''
          }
          ${
            isEdit && group.archivedAt
              ? '<button class="btn btn--secondary btn--sm" type="button" data-role="restore">恢复分组</button>'
              : ''
          }
        </div>
      </form>
    </div>
  `);

  form.querySelector('[data-role=cancel]').addEventListener('click', () =>
    form.dispatchEvent(new CustomEvent('groupcancel', { bubbles: true })),
  );

  form.querySelectorAll('[data-role=kind] .segmented__item').forEach((btn) =>
    btn.addEventListener('click', () => {
      form
        .querySelectorAll('[data-role=kind] .segmented__item')
        .forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    }),
  );

  form.querySelectorAll('.icon-grid__item').forEach((item) =>
    item.addEventListener('click', () => {
      form.querySelectorAll('.icon-grid__item').forEach((s) => {
        s.classList.toggle('is-on', s === item);
        s.setAttribute('aria-checked', String(s === item));
      });
    }),
  );

  form.querySelector('[data-role=remove]')?.addEventListener('click', () =>
    form.dispatchEvent(new CustomEvent('groupremove', { bubbles: true, detail: group })),
  );
  form.querySelector('[data-role=archive]')?.addEventListener('click', () =>
    form.dispatchEvent(new CustomEvent('grouparchive', { bubbles: true, detail: group })),
  );
  form.querySelector('[data-role=restore]')?.addEventListener('click', () =>
    form.dispatchEvent(new CustomEvent('grouprestore', { bubbles: true, detail: group })),
  );

  form.addEventListener('submit', (e) => e.preventDefault());

  /** 由外部读取表单值 */
  form.__values = () => ({
    name: form.querySelector('input[name=name]').value.trim(),
    kind:
      form.querySelector('[data-role=kind] .segmented__item[aria-selected=true]')?.dataset.kind ??
      'asset',
    icon: form.querySelector('.icon-grid__item.is-on')?.dataset.value || null,
  });
  form.__submitter = () => form.querySelector('button[type=submit]');
  form.__fieldErrors = (err) => applyFieldErrors(form, err.fieldErrors ?? {});

  return form;
}

/* =====================================================================
 * 新建 / 编辑账户表单
 * ===================================================================== */
function accountForm({ groups, account = null }) {
  const isEdit = Boolean(account);
  const isCredit = (account?.type ?? 'cash') === 'credit_card';

  const form = h(`
    <div class="card">
      <form novalidate class="stack stack--md">
        <div class="row row--between">
          <p class="tt-body-strong">${isEdit ? `编辑账户「${esc(account.name)}」` : '新建账户'}</p>
          ${account?.archivedAt ? '<span class="badge badge--dark">已归档</span>' : ''}
        </div>

        <div class="field-row">
          <div class="field field--wide" data-field="name">
            <label class="field__label">账户名称</label>
            <input class="input" name="name" value="${esc(account?.name ?? '')}"
                   placeholder="例如：招商银行储蓄卡(6688)" />
            <span class="field__error"></span>
          </div>
          <div class="field" data-field="groupId">
            <label class="field__label">所属分组</label>
            <select class="input select" name="groupId">
              ${groups
                .map((g) => option(g.id, g.name, account?.groupId))
                .join('')}
            </select>
            <span class="field__error"></span>
          </div>
          <div class="field" data-field="type">
            <label class="field__label">账户类型</label>
            <select class="input select" name="type" ${isEdit ? 'disabled' : ''}>
              ${typeOptions(account?.type)}
            </select>
            <span class="field__error"></span>
          </div>
        </div>

        ${
          isEdit
            ? `<p class="tt-fine-print">
                 账户类型创建后不可更改；余额由账单与对账决定，不在此处直接编辑。
               </p>`
            : `<div class="field-row">
                 <div class="field" data-field="openingBalance">
                   <label class="field__label">期初余额（元）</label>
                   <input class="input" name="openingBalance" inputmode="decimal"
                          value="${esc(account?.openingBalance ?? '0.00')}" />
                   <span class="field__error"></span>
                 </div>
                 <div class="field" data-field="openingDate">
                   <label class="field__label">期初日期</label>
                   <input class="input" type="date" name="openingDate" value="${esc(todayStr())}" />
                   <span class="field__error"></span>
                 </div>
                 <p class="tt-fine-print field--note">
                   期初余额 = 期初日期那一刻的余额。早于该日期的流水不参与余额计算，但可用于历史统计。
                 </p>
               </div>`
        }

        <div data-role="credit-slot" style="${isCredit ? '' : 'display:none'}">
          <div class="field-row">
            <div class="field">
              <label class="field__label">信用额度（元）</label>
              <input class="input" name="creditLimit" inputmode="decimal"
                     value="${esc(account?.creditLimit ?? '')}" placeholder="50000.00" />
              <span class="field__error"></span>
            </div>
            <div class="field">
              <label class="field__label">账单日</label>
              <input class="input" name="billingDay" type="number" min="1" max="31"
                     value="${esc(account?.billingDay ?? '')}" placeholder="5" />
              <span class="field__error"></span>
            </div>
            <div class="field">
              <label class="field__label">还款日</label>
              <input class="input" name="dueDay" type="number" min="1" max="31"
                     value="${esc(account?.dueDay ?? '')}" placeholder="20" />
              <span class="field__error"></span>
            </div>
          </div>
        </div>

        <div class="field-row">
          <div class="field field--wide2">
            <label class="field__label">备注（选填）</label>
            <input class="input" name="note" value="${esc(account?.note ?? '')}" placeholder="日常工资卡" />
          </div>
          <label class="check">
            <input type="checkbox" name="includeInTotal" ${
              account ? (account.includeInTotal ? 'checked' : '') : 'checked'
            } />
            <span>计入资产总额</span>
          </label>
        </div>

        <div class="row">
          <button class="btn btn--sm" type="submit">${isEdit ? '保存修改' : '创建账户'}</button>
          <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          ${
            /**
             * 删除**只在编辑态出现**，且位置与分组表单的「删除分组」一致（末位、危险色）。
             * 不放在列表行里：行上有「对账 / 编辑 / 归档」三个动作已经够挤，
             * 而删除是「想清楚了才做」的动作 —— 它需要用户先打开这个账户、
             * 看清它的名字与余额，再决定。误删的代价远大于多点一次的代价。
             */
            isEdit
              ? '<button class="btn btn--danger btn--sm" type="button" data-role="remove">删除账户</button>'
              : ''
          }
        </div>
      </form>
    </div>
  `);

  form.querySelector('[data-role=remove]')?.addEventListener('click', () =>
    form.dispatchEvent(new CustomEvent('accountremove', { bubbles: true, detail: account })),
  );

  const typeSelect = form.querySelector('select[name=type]');
  typeSelect?.addEventListener('change', () => {
    form.querySelector('[data-role=credit-slot]').style.display =
      typeSelect.value === 'credit_card' ? '' : 'none';
  });

  return form;
}

/* =====================================================================
 * 对账面板
 * ===================================================================== */
function reconcilePanel(account) {
  const panel = h(`
    <div class="card recon">
      <div class="recon__head">
        <div>
          <p class="tt-body-strong">对账 · ${esc(account.name)}</p>
          <p class="tt-fine-print">打开银行 / 支付 App 查看实际余额，填在下面，系统自动比对账面</p>
        </div>
        <button class="btn btn--quiet btn--sm" type="button" data-role="close">收起</button>
      </div>

      <div class="field-row">
        <div class="field">
          <label class="field__label">实际余额（元）</label>
          <input class="input" data-role="actual" inputmode="decimal" placeholder="48000.00" />
        </div>
        <div class="field">
          <label class="field__label">对账日期</label>
          <input class="input" type="date" data-role="date" value="${esc(todayStr())}" />
        </div>
        <button class="btn btn--secondary btn--sm" type="button" data-role="preview">计算差异</button>
      </div>

      <div data-role="result"></div>
    </div>
  `);

  const actualInput = panel.querySelector('[data-role=actual]');
  const dateInput = panel.querySelector('[data-role=date]');
  const result = panel.querySelector('[data-role=result]');

  const runPreview = async () => {
    const actual = actualInput.value.trim();
    if (!actual) {
      toast('请先填写实际余额', 'error');
      actualInput.focus();
      return;
    }
    try {
      const res = await Api.previewReconcile(account.ledgerId ?? account.__ledgerId, account.id, {
        actualBalance: actual,
        reconcileDate: dateInput.value,
      });
      renderResult(res.data);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const renderResult = (p) => {
    /**
     * 口径变更披露（docs/14）：期初日当天有流水时提示用户核对。
     *
     * 只在**出现差额**这一支提示 —— 账实相符时这句话是纯噪音。
     * 而差额恰恰是用户该去银行 App 看一眼的时刻：如果他当初把期初余额填大来
     * 迁就旧口径（建账当天的账不计入），切 `≤` 之后就会**双计**，
     * 表现正是「差额 = 期初日当天的净流水」。
     */
    const odt = p.openingDayTx;
    const boundaryNote = !p.isBalanced && odt
      ? `<div class="recon__boundary">
           <p class="tt-fine-print">
             该账户在期初日（${esc(odt.date)}）当天有 ${odt.count} 笔流水，
             净额 ${money(odt.delta)}。期初余额口径已于 ${esc(p.boundaryPolicyChangedAt ?? '2026-10-14')}
             修正为「建账当天的流水计入余额」。
             <strong>若差额恰好等于这笔净额</strong>，说明当初的期初余额被填大了 ——
             这笔账会重复计入，请核对银行实际余额后再决定如何处理。
           </p>
         </div>`
      : '';

    if (p.isBalanced) {
      result.innerHTML = `
        <div class="recon__balanced">
          <span class="recon__balanced-mark">✓</span>
          <div>
            <p class="tt-body-strong">账实相符</p>
            <p class="tt-caption text-muted">
              账面 ${money(p.systemBalance)} = 实际 ${money(p.actualBalance)}，将记录一次对账历史。
            </p>
          </div>
          <button class="btn btn--sm" type="button" data-role="submit">记录对账</button>
        </div>
      `;
      result.querySelector('[data-role=submit]').addEventListener('click', () => submit(p, null, null));
      return;
    }

    const suggested = p.suggestedReasons ?? REASONS.slice(0, 3);
    result.innerHTML = `
      <div class="recon__diff">
        <div class="recon__diff-row">
          <span class="tt-caption text-muted">账面余额</span><span class="tnum">${money(p.systemBalance)}</span>
        </div>
        <div class="recon__diff-row">
          <span class="tt-caption text-muted">实际余额</span><span class="tnum">${money(p.actualBalance)}</span>
        </div>
        <div class="recon__diff-row recon__diff-row--total">
          <span class="tt-caption">差额</span>
          <span class="tnum ${toneClass(p.diffAmount)}">${money(p.diffAmount)}</span>
        </div>
      </div>
      ${boundaryNote}
      <div class="stack">
        ${
          /**
           * 差异归因（R-02）。位置刻意在「差异原因」**之上**：
           * 用户此刻的问题是「这个差额到底是什么」，
           * 而「差异原因」是会计口径（决定调整单怎么记），是第二问。
           * 先答第一问，再让他做第二问的选择。
           */
          attributionBlock(p)
        }
        <div class="field">
          <span class="field__label">差异原因（必选）</span>
          <div class="chip-row" data-role="reasons" role="radiogroup" aria-label="差异原因">
            ${REASONS.map(
              (code) => `
              <button class="chip" type="button" role="radio"
                      aria-checked="${suggested[0] === code}" data-value="${esc(code)}">
                ${esc(RECONCILE_REASON_LABEL[code])}
              </button>`,
            ).join('')}
          </div>
        </div>
        <div class="field">
          <label class="field__label">补充说明（选「其他」时必填）</label>
          <input class="input" data-role="note" placeholder="例如：年费扣款 150 元" />
        </div>
        <label class="check">
          <input type="checkbox" data-role="lock" />
          <span>同时锁定该账户早于此对账日的账单（锁定后只能新增对冲账单修正）</span>
        </label>
        <div class="row">
          <button class="btn btn--sm" type="button" data-role="submit">生成调整单并完成对账</button>
          <button class="btn btn--quiet btn--sm" type="button" data-role="skip">
            只记录对账，不生成调整单
          </button>
        </div>
      </div>
    `;

    result.querySelectorAll('[data-role=reasons] .chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        result
          .querySelectorAll('[data-role=reasons] .chip')
          .forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
      }),
    );

    const submit = (createAdjustment) => {
      const code = result.querySelector('[data-role=reasons] .chip[aria-checked=true]')?.dataset.value;
      const note = result.querySelector('[data-role=note]').value.trim();
      const lock = result.querySelector('[data-role=lock]').checked;
    /**
     * 勾选并填写金额的归因（R-02）。
     *
     * ⚠️ 读的是 \`checked\`（原生 checkbox 状态）而不是 \`aria-checked\` ——
     * 之前给 checkbox 写 \`aria-checked="false"\` 然后从未同步它，
     * 于是无论用户勾没勾，\`[aria-checked=true]\` 都匹配不到，
     * 归因永远提交空数组。checkbox 的选中状态本来就该读 \`checked\`，
     * \`aria-checked\` 是给 \`role\` 为 radio/checkbox 的自定义元素用的。
     */
    const attributions = [...result.querySelectorAll('[data-attr]')]
      .filter((el) => el.checked)
      .map((el) => {
        const amt = result.querySelector(`[data-attr-for="${el.dataset.attr}"]`);
        return {
          kind: el.dataset.attr,
          amount: amt && amt.value.trim() ? amt.value.trim() : null,
          note: null,
        };
      });
    doSubmit(p, createAdjustment, code, note, lock, attributions);
  };
    result.querySelector('[data-role=submit]').addEventListener('click', () => submit(true));
    result.querySelector('[data-role=skip]').addEventListener('click', () => submit(false));
  };

  const doSubmit = async (p, createAdjustment, reasonCode, reasonNote, lockBeforeDate = false, attributions = []) => {
    const btn = panel.querySelector('[data-role=preview]');
    setLoading(btn, true, '提交中');
    try {
      const res = await submitFn({
        actualBalance: p.actualBalance,
        reconcileDate: p.reconcileDate,
        createAdjustment,
        lockBeforeDate,
        ...(reasonCode ? { reasonCode } : {}),
        ...(reasonNote ? { reasonNote } : {}),
        // ⚠️ 只有非空才带这个键。带一个空数组也会被落成 `'[]'`，
        // 而「用户没填归因」与「用户填了但一条都没选」在库里应当可区分。
        ...(attributions.length ? { attributions } : {}),
      });
      toast(
        p.isBalanced
          ? '对账完成：账实相符'
          : `对账完成，已生成 ${money(res.data.diffAmount)} 的调整单`,
        'success',
      );
      panel.dispatchEvent(new CustomEvent('reconciled', { bubbles: true }));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  };

  let submitFn = async () => ({ data: {} });
  /** 由外部注入真正的提交函数（需要 ledgerId） */
  panel.__bind = (ledgerId, handler) => {
    submitFn = handler;
    account.__ledgerId = ledgerId;
  };

  panel.querySelector('[data-role=preview]').addEventListener('click', runPreview);
  panel.querySelector('[data-role=close]').addEventListener('click', () => {
    panel.dispatchEvent(new CustomEvent('reconclose', { bubbles: true }));
  });
  actualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runPreview();
    }
  });

  return panel;
}

/* =====================================================================
 * 页面
 * ===================================================================== */
export async function renderAccounts(container, { go }) {
  const loading = appFrame({
    active: 'accounts',
    inner: `<div class="card"><div class="skeleton" style="width:36%"></div>
            <div class="skeleton" style="width:60%;margin-top:14px"></div></div>`,
  });
  container.replaceChildren(loading);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return loading;
  }

  /**
   * 「显示已停用」这一个开关，同时管**分组**和**账户**两件事。
   *
   * 之前它只作用于分组：账户列表请求的 `includeArchived` 从来不传，
   * 而后端 `accounts/service.ts › listAccounts()` 默认会 `isNull(archivedAt)`
   * 把已归档账户过滤掉 —— 于是勾了开关也**拿不到**归档账户的数据，
   * 表现就是「勾了没反应」。现在请求与本地过滤都以这个值为准。
   */
  let showArchivedGroups = false;

  /** 账户列表请求：后端默认排除已归档，开关打开才一起取回来 */
  const fetchAccounts = () =>
    Api.listAccounts(ledger.id, { includeArchived: showArchivedGroups }).then((r) => r.data);

  const [allGroups, accounts] = await Promise.all([
    Api.listAccountGroups(ledger.id, { includeArchived: true }).then((r) => r.data),
    fetchAccounts(),
  ]);

  /** 仅未停用的分组可用于「所属分组」选择 */
  const activeGroups = () => allGroups.filter((g) => !g.archivedAt);

  const frame = appFrame({
    active: 'accounts',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">账户</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · ${accounts.filter((a) => a.kind !== 'virtual').length} 个账户 ·
              余额 = 期初 + 全部流水
            </p>
          </div>
          <!--
            桌面端的操作组。手机端整组隐藏（见 mobile.css「账户页」）：
            三个按钮挤在 358px 里会互相压字，而「账户页的主角是账户本身」。
            手机端改为列表末尾一条 .acct-add：「＋ 新建账户」为主，
            「新建分组」降成同行的交互色文字链接 —— 两个能力都还在，
            但都不在开屏第一屏占位置。
          -->
          <div class="row" data-role="page-actions">
            <a class="btn btn--quiet btn--sm" href="/reconciliations" data-link>
              ${lucide('scale', 15)} 对账历史
            </a>
            <button class="btn btn--quiet btn--sm" type="button" data-action="new-group">
              ${lucide('plus', 15)} 新建分组
            </button>
            <button class="btn btn--sm" type="button" data-action="new-account">新建账户</button>
          </div>
        </div>
      </div>
      <div data-role="form-slot"></div>
      <!-- .acct-list：列表内部所有块（计数条 / 分组块 / 虚拟账户 / 末尾新建行）
           共用**同一档**间距。之前这一层没有任何间距规则，
           分组块之间是 0，只有「标题区 → 列表」之间有 .page 的 gap，
           于是看上去「这块贴着、那块很松」。 -->
      <div class="acct-list" data-role="list-slot"></div>
      <div data-role="recon-slot"></div>
    `,
  });
  mountTabBar(frame, { active: 'accounts', go });
  container.replaceChildren(frame);

  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');
  const reconSlot = frame.querySelector('[data-role=recon-slot]');

  /* ---------------- 列表 ---------------- */
  const renderList = async () => {
    const [freshGroups, freshAccounts] = await Promise.all([
      Api.listAccountGroups(ledger.id, { includeArchived: true }).then((r) => r.data),
      fetchAccounts(),
    ]);
    allGroups.length = 0;
    allGroups.push(...freshGroups);
    accounts.length = 0;
    accounts.push(...freshAccounts);
    paint();
  };

  const paint = () => {
    /**
     * 真实账户也要按归档态过滤，而且**必须与请求口径同源**：
     * 关着开关时后端本来就不返回归档账户，这里再过滤一次是为了防御
     * 「开关刚被关上、手上还是上一份带归档的数据」这半秒窗口；
     * 开着开关时 `includeArchived=true` 拿回来的归档账户才进列表。
     */
    const real = accounts.filter(
      (a) => a.kind !== 'virtual' && (showArchivedGroups || !a.archivedAt),
    );
    const virtual = accounts.filter((a) => a.kind === 'virtual');
    const archivedGroups = allGroups.filter((g) => g.archivedAt);
    const shown = allGroups.filter((g) => showArchivedGroups || !g.archivedAt);

    const groupBlocks = shown
      .map((g) => {
        const list = real.filter((a) => a.groupId === g.id);
        const head = `
          <div class="acct-group__head">
            <span class="acct-group__name">${entityIcon(g.icon, 14)} ${esc(g.name)}</span>
            ${g.kind !== 'asset' ? `<span class="badge">${esc(ACCOUNT_KIND_LABEL[g.kind] ?? g.kind)}</span>` : ''}
            ${g.archivedAt ? '<span class="badge badge--dark">已停用</span>' : ''}
            <span class="tt-fine-print tnum">${money(g.totalBalance)}</span>
            <span class="acct-group__acts">
              ${
                g.archivedAt
                  ? `<button class="btn btn--quiet btn--sm" type="button"
                             data-gact="restore" data-id="${esc(g.id)}">恢复</button>`
                  : `<button class="btn btn--quiet btn--sm" type="button"
                             data-gact="edit" data-id="${esc(g.id)}">编辑</button>`
              }
            </span>
          </div>`;

        if (g.archivedAt && list.length === 0) {
          return `
          <div class="acct-group is-archived">
            ${head}
            <div class="card card--flush">
              <div class="empty">分组已停用${g.accountCount > 0 ? `，${g.accountCount} 个历史账户仍归属此分组` : ''}</div>
            </div>
          </div>`;
        }

        return `
          <div class="acct-group">
            ${head}
            <div class="card card--flush">
              ${
                list.length
                  ? list
                      .map((a) => {
                        const isArch = Boolean(a.archivedAt);
                        return `
                <div class="acct-row${isArch ? ' is-archived' : ''}">
                  <span class="acct-row__icon">${accountIcon(a, 16)}</span>
                  <span class="acct-row__main">
                    <span class="tt-body-strong">${esc(a.name)}${
                      isArch ? ' <span class="badge badge--dark">已归档</span>' : ''
                    }</span>
                    <span class="tt-fine-print">
                      ${esc(ACCOUNT_TYPE_LABEL[a.type] ?? a.type)}${
                        a.openingBalance !== '0.00' ? ` · 期初 ${money(a.openingBalance)}` : ''
                      }${a.lastReconciledAt ? ` · 上次对账 ${esc(formatDate(a.lastReconciledAt))}` : ''}
                    </span>
                  </span>
                  <span class="acct-row__amount ${toneClass(a.balance)} tnum">${money(a.balance)}</span>
                  <span class="acct-row__actions">
                    ${
                      isArch
                        ? /* 已归档账户不给「对账 / 编辑 / 归档」—— 它已经不在日常账里，
                              给可点按钮是假动作。唯一该有的是「取消归档」：
                              归档不是删除，随时可以回来。
                              （删除不在这里 —— 它收在编辑表单里，见 accountForm。） */
                          `<button class="btn btn--secondary btn--sm" type="button"
                            data-act="restore" data-id="${esc(a.id)}">取消归档</button>
                    <button class="btn btn--quiet btn--sm" type="button"
                            data-act="edit" data-id="${esc(a.id)}">编辑</button>`
                        : `<button class="btn btn--pearl btn--sm" type="button"
                            data-act="recon" data-id="${esc(a.id)}">对账</button>
                    <button class="btn btn--quiet btn--sm" type="button"
                            data-act="edit" data-id="${esc(a.id)}">编辑</button>
                    <button class="btn btn--quiet btn--sm" type="button"
                            data-act="archive" data-id="${esc(a.id)}">归档</button>`
                    }
                  </span>
                </div>`;
                      })
                      .join('')
                  : '<div class="empty">该分组下暂无账户</div>'
              }
            </div>
          </div>
        `;
      })
      .join('');

    listSlot.innerHTML = `
      <!--
        计数文案与「显示已停用」开关。手机端只隐藏计数文案（list-meta__count），
        开关必须留着：它是归档账户唯一的召回入口，藏了就等于手机上
        「账户归档后永远找不回来」。计数则是列表自己已经表达过的信息
        （分组头上有名字、账户行上有余额），手机上再读一遍是噪声。
        ⚠️ 这段注释在模板字符串里，禁止出现反引号 —— 反引号会提前闭合模板。
      -->
      <div class="list-meta" data-role="list-meta">
        <span class="tt-fine-print list-meta__count">
          ${shown.length} 个分组 · ${real.length} 个账户 · 分组决定账户归类，可随时改名或停用
        </span>
        <label class="check">
          <input type="checkbox" data-role="show-archived-groups" ${
            showArchivedGroups ? 'checked' : ''
          } />
          <span class="tt-fine-print">显示已停用${
            archivedGroups.length ? `（${archivedGroups.length}）` : ''
          }</span>
        </label>
      </div>
      ${
        real.length === 0
          ? `<div class="card empty-state">
               <span class="empty-state__icon">${lucide('wallet', 22)}</span>
               <p class="tt-body-strong">还没有账户</p>
               <p class="tt-caption text-muted">先建一张银行卡或现金账户，才能开始记账</p>
             </div>`
          : ''
      }
      ${groupBlocks}
      ${
        virtual.length
          ? `<div class="acct-group">
               <div class="acct-group__head">
                 <span class="acct-group__name">系统虚拟账户</span>
                 <span class="tt-fine-print">由债权 / 债务 / 手续费自动维护</span>
               </div>
               <div class="card card--flush">
                 ${virtual
                   .map(
                     (a) => `
                   <div class="acct-row">
                     <span class="acct-row__icon">${accountIcon(a, 16)}</span>
                     <span class="acct-row__main">
                       <span class="tt-body-strong">${esc(a.name)}</span>
                       <span class="tt-fine-print">${esc(ACCOUNT_KIND_LABEL[a.kind])} · 不可删除</span>
                     </span>
                     <span class="acct-row__amount ${toneClass(a.balance)} tnum">${money(
                       a.balance,
                     )}</span>
                   </div>`,
                   )
                   .join('')}
               </div>
             </div>`
          : ''
      }
      <!--
        手机端唯一的入口：列表末尾一条全宽「＋ 新建账户」。
        位置在**列表末尾**而不是页头 —— 单手操作时拇指就在屏幕下半部，
        且它紧跟在最后一个分组后面，「在哪儿加」这件事不用找。
        桌面端不显示（页头那组按钮已有）。
      -->
      <div class="acct-add">
        <button class="btn btn--quiet btn--sm" type="button" data-action="new-account">
          ${lucide('plus', 15)} 新建账户
        </button>
        <button class="acct-add__link" type="button" data-action="new-group">新建分组</button>
      </div>
    `;

    /**
     * 停用显隐。这里**必须重新请求**而不能只 `paint()`：
     * 关着开关时后端压根没返回归档账户，本地重画也变不出来。
     */
    listSlot
      .querySelector('[data-role=show-archived-groups]')
      ?.addEventListener('change', async (e) => {
        showArchivedGroups = e.target.checked;
        try {
          await renderList();
        } catch (err) {
          toast(err.message ?? '刷新账户列表失败', 'error');
        }
      });

    /* 分组级动作（与账户行动作区分开） */
    listSlot.querySelectorAll('[data-gact]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const g = allGroups.find((x) => x.id === btn.dataset.id);
        if (!g) return;
        if (btn.dataset.gact === 'edit') openGroupForm(g);
        else if (btn.dataset.gact === 'restore') restoreGroup(g);
      }),
    );

    /* 行内动作 */
    listSlot.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const acc = accounts.find((a) => a.id === btn.dataset.id);
        if (!acc) return;

        if (btn.dataset.act === 'edit') {
          openForm(acc);
        } else if (btn.dataset.act === 'archive') {
          if (!window.confirm(`确认归档「${acc.name}」？历史账单会保留，账户不再出现在列表里。`)) return;
          try {
            const res = await Api.archiveAccount(ledger.id, acc.id);
            void res;
            toast('账户已归档', 'success');
            await renderList();
          } catch (err) {
            toast(err.message, 'error');
          }
        } else if (btn.dataset.act === 'restore') {
          unarchiveAccount(acc);
        } else if (btn.dataset.act === 'recon') {
          openReconcile(acc);
        }
      }),
    );
  };

  /* ---------------- 分组管理 ---------------- */
  const openGroupForm = (group = null) => {
    const form = groupForm({ group });

    form.addEventListener('groupcancel', () => formSlot.replaceChildren());

    form.addEventListener('groupremove', () => removeGroup(group));

    form.addEventListener('grouparchive', () => archiveGroupAction(group));

    form.addEventListener('grouprestore', () => restoreGroup(group));

    form.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = form.__submitter();
      const values = form.__values();
      clearFieldErrors(form);
      setLoading(submit, true, '保存中');
      try {
        if (group) {
          await Api.updateAccountGroup(ledger.id, group.id, values);
          toast(`分组「${values.name}」已更新`, 'success');
        } else {
          await Api.createAccountGroup(ledger.id, values);
          toast(`分组「${values.name}」已创建`, 'success');
        }
        formSlot.replaceChildren();
        await renderList();
      } catch (err) {
        form.__fieldErrors(err);
        toast(err.message, 'error');
      } finally {
        setLoading(submit, false);
      }
    });

    formSlot.replaceChildren(form);
    const nameInput = form.querySelector('input[name=name]');
    nameInput.focus();
    nameInput.select();
    form.scrollIntoView({ block: 'nearest' });
  };

  /**
   * 删除分组。
   *
   * 关键前置认知：**删分组不等于删账户**。分组只是归类维度，账户是账本实体，
   * 所以后端会把组内账户统一移到「未分组」再删掉分组本身。
   * 这件事必须在确认弹窗里先说清楚 —— 否则用户会以为「删分组 = 里面的账户一起没了」，
   * 而这是他能在这页做出的最不可挽回的误判。
   */
  const removeGroup = async (g) => {
    if (!g) return;

    const moving = g.accountCount ?? 0;
    const okToDelete = await confirmDialog({
      title: '删除账户分组',
      confirmText: '删除分组',
      lines: [
        { text: `即将删除分组「${g.name}」，删除后不可恢复。`, strong: true },
        moving > 0
          ? `组内的 ${moving} 个账户不会被删除，会统一移到「未分组」；账户余额与历史账单完全不受影响。`
          : '该分组下没有账户，删除后不会带走任何数据。',
        '分组只是归类方式，不是账户本身。',
      ],
    });
    if (!okToDelete) return;

    try {
      const res = await Api.deleteAccountGroup(ledger.id, g.id);
      const { movedAccounts = 0, fallbackGroup } = res.data ?? {};
      toast(
        movedAccounts > 0
          ? `分组「${g.name}」已删除，${movedAccounts} 个账户已移至「${fallbackGroup?.name ?? '未分组'}」`
          : `分组「${g.name}」已删除`,
        'success',
      );
      formSlot.replaceChildren();
      await renderList();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  /**
   * 停用分组（可恢复）。
   *
   * 与删除的分工：删除是「这个分类没了」，停用是「名字先留着、暂时不用」。
   * 后端只允许停用**空**分组 —— 装着账户的分组要么删（账户搬到未分组）、
   * 要么继续用，没有第三种状态。
   */
  const archiveGroupAction = async (g) => {
    if (!g) return;
    try {
      await Api.archiveAccountGroup(ledger.id, g.id);
      toast(`分组「${g.name}」已停用，可在「显示已停用」里恢复`, 'success');
      formSlot.replaceChildren();
      await renderList();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  /**
   * 删除账户（物理删除，不可恢复）。
   *
   * 后端会在「已被账单或其它记录引用」时拒绝并给出原因（那种情况该用归档），
   * 这里不做前置探测 —— 让后端当唯一裁判，避免前端与后端的判定各写一份、
   * 将来加一种引用就漏一处。拒绝的原因原样转成 toast 说给用户听。
   */
  const removeAccount = async (acc) => {
    if (!acc) return;
    if (acc.isSystem) {
      toast('系统虚拟账户不可删除', 'error');
      return;
    }

    const okToDelete = await confirmDialog({
      title: '删除账户',
      confirmText: '删除账户',
      lines: [
        { text: `即将删除账户「${acc.name}」，删除后不可恢复。`, strong: true },
        '如果只是以后不常用，用「归档」更合适：归档保留全部历史账单，且随时可以取消归档。',
        '有账单记录的账户无法删除，系统会提示你改用归档。',
      ],
    });
    if (!okToDelete) return;

    try {
      await Api.purgeAccount(ledger.id, acc.id);
      toast(`账户「${acc.name}」已删除`, 'success');
      /* 关掉编辑表单：被删的账户已经不存在，留着一张指向空的表单在页面上是脏数据 */
      formSlot.replaceChildren();
      await renderList();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  /** 取消归档：归档不是删除，账户要能原样回来 */
  const unarchiveAccount = async (acc) => {
    if (!acc) return;
    try {
      await Api.restoreAccount(ledger.id, acc.id);
      toast(`「${acc.name}」已取消归档`, 'success');
      /**
       * 取消归档后把开关留在「显示已停用」上会让人以为没生效
       * （账户仍在列表里，只是混在归档项中间）。关掉开关回到日常视图。
       */
      showArchivedGroups = false;
      await renderList();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const restoreGroup = (g) => {
    if (!g) return;
    Api.restoreAccountGroup(ledger.id, g.id)
      .then(() => {
        toast(`已恢复分组「${g.name}」`, 'success');
        showArchivedGroups = false;
        formSlot.replaceChildren();
        renderList();
      })
      .catch((err) => toast(err.message, 'error'));
  };

  /* ---------------- 表单 ---------------- */
  const openForm = (account = null) => {
    /**
     * 分组候选默认只给未停用的。但如果**正在编辑的这个账户本身就属于一个已停用分组**
     * （归档账户常出现这种组合），那个分组必须出现在选项里 —— 否则保存时会把它
     * 悄悄改挂到列表第一项上。带上它，但不给别的已停用分组开口子。
     */
    const actives = activeGroups();
    const groups =
      account?.groupId && !actives.some((g) => g.id === account.groupId)
        ? allGroups.filter((g) => !g.archivedAt || g.id === account.groupId)
        : actives;
    const form = accountForm({ groups, account });
    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());
    /* 删除收在编辑表单里（与分组表单同构）：先看清这个账户，再谈删不删 */
    form.addEventListener('accountremove', () => removeAccount(account));
    form.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = f.querySelector('button[type=submit]');
      clearFieldErrors(f);
      setLoading(submit, true, '保存中');
      try {
        if (account) {
          const payload = {
            name: f.name.value.trim(),
            groupId: f.groupId.value,
            note: f.note.value.trim() || null,
            includeInTotal: f.includeInTotal.checked,
          };
          if (account.type === 'credit_card') {
            payload.creditLimit = f.creditLimit.value.trim() || null;
            payload.billingDay = f.billingDay.value ? Number(f.billingDay.value) : null;
            payload.dueDay = f.dueDay.value ? Number(f.dueDay.value) : null;
          }
          await Api.updateAccount(ledger.id, account.id, payload);
          toast('账户已更新', 'success');
        } else {
          await Api.createAccount(ledger.id, {
            groupId: f.groupId.value,
            name: f.name.value.trim(),
            type: f.type.value,
            openingBalance: f.openingBalance.value.trim() || '0.00',
            openingDate: f.openingDate.value || todayStr(),
            includeInTotal: f.includeInTotal.checked,
            note: f.note.value.trim() || null,
            ...(f.type.value === 'credit_card'
              ? {
                  creditLimit: f.creditLimit.value.trim() || null,
                  billingDay: f.billingDay.value ? Number(f.billingDay.value) : null,
                  dueDay: f.dueDay.value ? Number(f.dueDay.value) : null,
                }
              : {}),
          });
          toast('账户已创建', 'success');
        }
        formSlot.replaceChildren();
        await renderList();
      } catch (err) {
        applyFieldErrors(f, err.fieldErrors ?? {});
        if (!err.details?.length) toast(err.message, 'error');
      } finally {
        setLoading(submit, false);
      }
    });
    formSlot.replaceChildren(form);
    form.querySelector('input[name=name]').focus();
    form.scrollIntoView({ block: 'nearest' });
  };

  /**
   * 页头按钮组（桌面）与列表末尾入口（手机）是同一个动作，两处都要生效。
   *
   * ⚠️ 这里**必须用事件委托**，不能 `querySelectorAll` 逐个绑：
   * 手机端的 `.acct-add` 是 `paint()` 写进 `listSlot.innerHTML` 的，
   * 每重画一次就是一批全新的 DOM 节点；而绑定代码只执行一次、且排在首次
   * `paint()` **之前**（那一刻 listSlot 还是空的）—— 于是手机端这两个按钮
   * 从来没挂上监听器，点了毫无反应。委托挂在常驻的 `frame` 上，
   * 列表重画多少次都不受影响。
   */
  frame.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-action]');
    if (!btn || !frame.contains(btn)) return;
    if (btn.dataset.action === 'new-account') openForm(null);
    else if (btn.dataset.action === 'new-group') openGroupForm(null);
  });

  /* ---------------- 对账 ---------------- */
  const openReconcile = (acc) => {
    const panel = reconcilePanel(acc);
    panel.__bind(ledger.id, (payload) => Api.submitReconcile(ledger.id, acc.id, payload));
    panel.addEventListener('reconciled', () => {
      reconSlot.replaceChildren();
      renderList();
      toast('账户余额已按实际值校正', 'success');
    });
    panel.addEventListener('reconclose', () => reconSlot.replaceChildren());
    reconSlot.replaceChildren(panel);
    panel.scrollIntoView({ block: 'nearest' });
  };

  paint();
  return frame;
}
