/**
 * 债权债务「未结清」视图（docs/12 §六 D9/D10，`docs/07 §415` 的「未结清视图」）。
 *
 * ## 为什么这张页面存在
 *
 * 债权债务模块存在的唯一理由是回答两个问题：**我还欠谁多少 / 别人还欠我多少**。
 * 这两个数字一直存在（两个虚拟台账的余额），但没有任何界面把它们露出来 ——
 * 用户只能逐条翻流水去拼。
 *
 * ## 三层口径（`docs/03 §1.3`）
 *
 * | 事件 | 现金口径 | 台账口径 | 损益口径 |
 * |---|---|---|---|
 * | 产生（借出 / 登记欠款） | 借出 −A；登记 0 | +A | 0 |
 * | 结算（收回 / 偿还）    | ±A | −A | 0（本金不进损益） |
 * | 核销（坏账 / 免除）     | 0 | −A | 0 |
 *
 * 顶部两张卡读的是**台账口径**（虚拟账户余额，权威总额）；列表是逐笔归属。
 * ⚠️ 台账口径**不能**加进净资产 —— 那是 `kind='virtual'`，`docs/03 §1.3` 已明文。
 * 所以「我的真实家底」要另算，不能把待收待付直接并进净资产。
 *
 * **未归属冲销**单列出来而不是藏起来：记账时不该被强迫先想清楚「还的是哪一笔」，
 * 这部分金额同样在减少台账，只是不归属到任何一笔。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { esc, h, icon, lucide, money, toast } from '../ui.js';
import { dayLabel } from '../lib/tx-format.js';

/** 「未结清 / 全部」两档 —— 已结清的是历史，用户平时不需要看 */
const STATUS = [
  { key: 'open', label: '未结清', on: true },
  { key: 'all', label: '含已结清', on: false },
];

export async function renderDebts(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return null;
  }

  const frame = appFrame({
    active: 'debts',
    user: me,
    ledger,
    inner: `<div data-role="body"><div class="card">
              <div class="skeleton" style="width:32%"></div>
              <div class="skeleton" style="width:58%;height:48px;margin-top:20px"></div>
            </div></div>`,
  });
  container.replaceChildren(frame);

  let status = 'open';
  let view = null;

  const paint = () => {
    const s = view?.summary;
    const items = view?.items ?? [];
    const hasOpen = (s?.openCount ?? 0) > 0;

    frame.querySelector('[data-role=body]').replaceChildren(
      h(`
      <div class="debts">
        <div class="page__hero">
          <h1>往来</h1>
          <p class="tt-caption text-muted">
            债权与债务的<strong>台账口径</strong>：结算与核销后自动移出未结清。
          </p>
        </div>

        <!--
          两张卡是**权威总额**（直接取虚拟台账余额）。刻意不并进净资产 ——
          台账账户是 kind='virtual'，docs/03 §1.3 明确它不进资产负债表。
        -->
        <div class="debt-cards">
          <div class="debt-card">
            <span class="debt-card__label">${icon('hand-coins', 14)}<span>待收</span></span>
            <span class="debt-card__value tnum">${money(s?.totalReceivable ?? 0)}</span>
            <span class="debt-card__sub">${esc(`${s?.openReceivable ?? 0} 笔未收回`)}</span>
          </div>
          <div class="debt-card">
            <span class="debt-card__label">${icon('heart-handshake', 14)}<span>待付</span></span>
            <span class="debt-card__value tnum">${money(s?.totalPayable ?? 0)}</span>
            <span class="debt-card__sub">${esc(`${s?.openPayable ?? 0} 笔未结清`)}</span>
          </div>
          <div class="debt-card debt-card--net">
            <span class="debt-card__label">${icon('scale', 14)}<span>净头寸</span></span>
            <span class="debt-card__value tnum">${money(s?.netPosition ?? 0)}</span>
            <span class="debt-card__sub">待收 − 待付</span>
          </div>
        </div>

        <div class="tx-filters__row">
          ${STATUS.map(
            (x) => `<button class="tx-pill${status === x.key ? ' is-on' : ''}" type="button"
                      role="radio" aria-checked="${status === x.key}" data-status="${esc(x.key)}">
                      ${esc(x.label)}
                    </button>`,
          ).join('')}
        </div>

        ${
          Number(s?.unallocatedReceivable ?? 0) !== 0 || Number(s?.unallocatedPayable ?? 0) !== 0
            ? `<p class="debt-unalloc">
                ${icon('info', 14)}
                <span>
                  有 ${money(
                    Math.abs(Number(s.unallocatedReceivable)) + Math.abs(Number(s.unallocatedPayable)),
                  )} 的结算 / 核销没有关联到具体哪一笔
                  （待收侧 ${money(s.unallocatedReceivable)}、待付侧 ${money(s.unallocatedPayable)}）。
                  记账时补一次「结清哪一笔」就能归属，未归属的部分仍然算在上面的总额里。
                </span>
              </p>`
            : ''
        }

        ${
          items.length === 0
            ? `<div class="empty-state">
                 <span class="empty-state__icon">${icon(status === 'open' ? 'check' : 'handshake', 22)}</span>
                 <p class="tt-body-strong">${status === 'open' ? '没有未结清的往来' : '还没有任何债权债务记录'}</p>
                 <p class="tt-caption text-muted">
                   ${
                     status === 'open'
                       ? '所有借出与欠款都已结清或核销完毕。'
                       : '记一笔「应收款项 · 借出」或「应付款项 · 登记欠款」就会出现在这里。'
                   }
                 </p>
                 <a class="btn btn--sm" href="/transactions/new" data-link>去记一笔</a>
               </div>`
            : `<div class="debt-list">
                 ${items.map(rowNode).join('')}
               </div>`
        }

        ${
          items.length && !hasOpen && status === 'open'
            ? ''
            : ''
        }
        ${
          status === 'open' && (s?.clearedCount ?? 0) > 0
            ? `<p class="tt-caption text-muted debt-more">
                 另有 ${esc(String(s.clearedCount))} 笔已结清，切到「含已结清」查看历史。
               </p>`
            : ''
        }
      </div>`),
    );
    wire();
  };

  /** 单行：谁 · 什么时候 · 金额 · 已结清 / 还差多少 */
  function rowNode(i) {
    const outstanding = Number(i.outstanding);
    /**
     * ⚠️ 用 `=== 0` 判「已结清」，不要用 `<= 0`。
     *
     * `outstanding < 0` 是**超额结清**（关联的还款比本金还多），是数据异常。
     * 若按 `<= 0` 归入「已结清」，用户会看到一笔「已结清」却数字对不上，
     * 而且没有任何提示 —— 异常被样式吃掉了。
     * 后端已返回 `overSettled`，这里把它显示成一行待处理的红字。
     */
    const cleared = outstanding === 0;
    const over = outstanding < 0 || i.overSettled === true;
    const days = i.ageDays;
    // 「最久未结清」放在最前（没有到期日字段时，它是最接近「逾期」的代理指标）
    const ageTag = cleared
      ? ''
      : days > 90
        ? `<span class="debt-row__age is-old">已 ${days} 天</span>`
        : `<span class="debt-row__age">${days} 天</span>`;
    return `
      <article class="debt-row${cleared ? ' is-cleared' : ''}${over ? ' is-over' : ''}" data-id="${esc(i.transactionId)}">
        <div class="debt-row__main">
          <span class="debt-row__icon">${lucide(i.recordType === 'receivable' ? 'hand-coins' : 'heart-handshake', 16)}</span>
          <span class="debt-row__text">
            <!--
              名称最长 50 字，超出必须省略而不是撑破行。
              title 属性保留完整值：省略只是显示层的截断，信息不能丢。

              ⚠️ 注释里**不能出现反引号** —— 这段整体在一个模板字符串里，
              一个反引号就会把它提前闭合，语法闸门会挡下，但挡下之前它已经是白屏。
            -->
            <span class="debt-row__name" title="${esc(i.counterparty || i.name || '未命名')}">${esc(i.counterparty || i.name || '未命名')}</span>
            <span class="debt-row__meta">
              ${esc(i.stage)} · ${esc(dayLabel(i.txDate))}
              ${i.category ? `· ${esc(i.category.parentName ? `${i.category.parentName} › ${i.category.name}` : i.category.name)}` : ''}
            </span>
          </span>
          <span class="debt-row__amount tnum">${esc(money(i.amount))}</span>
        </div>
        <div class="debt-row__bar">
          <span class="debt-row__stat">
            ${
              over
                ? `<span class="debt-row__out is-over tnum">超额结清 ${esc(money(i.outstanding))}</span>
                   <span class="debt-row__done-n tnum">已关联 ${esc(money(i.settled))} / 本金 ${esc(money(i.amount))}</span>`
                : cleared
                  ? `<span class="debt-row__done">${lucide('check', 13)}<span>已结清</span></span>`
                  : `<span class="debt-row__out tnum">还差 ${esc(money(i.outstanding))}</span>
                     ${Number(i.settled) > 0 ? `<span class="debt-row__done-n tnum">已结 ${esc(money(i.settled))}</span>` : ''}`
            }
          </span>
          ${ageTag}
          <span class="debt-row__act">
            ${
              cleared
                ? `<button class="btn btn--quiet btn--sm" type="button" data-act="open"
                          data-id="${esc(i.transactionId)}">查看</button>`
                : `<button class="btn btn--sm" type="button" data-act="settle"
                          data-id="${esc(i.transactionId)}"
                          data-type="${esc(i.recordType)}"
                          data-counterparty="${esc(i.counterparty ?? '')}"
                          data-outstanding="${esc(i.outstanding)}"
                          data-name="${esc(i.name ?? '')}"
                          data-category="${esc(i.category?.id ?? '')}"
                          data-account="${esc(i.account?.id ?? '')}"
                          data-date="${esc(i.txDate)}">结清</button>
                   <button class="btn btn--quiet btn--sm" type="button" data-act="writeoff"
                          data-id="${esc(i.transactionId)}"
                          data-type="${esc(i.recordType)}"
                          data-counterparty="${esc(i.counterparty ?? '')}"
                          data-outstanding="${esc(i.outstanding)}"
                          data-name="${esc(i.name ?? '')}"
                          data-category="${esc(i.category?.id ?? '')}"
                          data-account="${esc(i.account?.id ?? '')}"
                          data-date="${esc(i.txDate)}">核销</button>`
            }
          </span>
        </div>
        ${
          i.settlements.length
            ? `<details class="debt-row__hist">
                 <summary>结清记录 ${esc(String(i.settlements.length))} 笔</summary>
                 ${i.settlements
                   .map(
                     (s) => `<a class="debt-row__hist-item" href="/transactions/${encodeURIComponent(
                       s.transactionId,
                     )}" data-link>
                       ${esc(s.stage)} ${esc(money(s.amount))} · ${esc(dayLabel(s.txDate))}
                     </a>`,
                   )
                   .join('')}
               </details>`
            : ''
        }
      </article>`;
  }

  function wire() {
    frame
      .querySelectorAll('[data-status]')
      .forEach((el) =>
        el.addEventListener('click', async () => {
          if (status === el.dataset.status) return;
          status = el.dataset.status;
          await load();
        }),
      );

    frame.querySelectorAll('[data-act]').forEach((el) =>
      el.addEventListener('click', () => onAction(el.dataset.act, el.dataset)),
    );
  }

  /**
   * 结清 / 核销 = **跳到记账页并预填**，而不是在本页做一笔「迷你表单」。
   *
   * 理由：结清笔的金额、手续费、日期都是账务字段，记账页有完整的双算与校验；
   * 在本页重做一个表单等于把这套校验抄一遍（抄一次就多一个不一致的地方）。
   *
   * ## 预填带什么（任务 2）
   *
   * 带：类型 · 阶段 · 往来对象 · 名称 · **分类** · **账户** · 日期 · 还差多少 · 关联哪笔
   *
   * 「分类」与「账户」是这一轮补上的 —— 之前只带了对象与名称，于是用户点「结清」
   * 落到记账页还要**手选分类与账户**。可这两项恰恰是「结清」里最不该重填的：
   *  · 分类：还的是「借出借款」还是「货款」，与原笔**必然相同**（分类决定台账口径）；
   *  · 账户：钱回到哪张卡，99% 的情况就是原账户（用户偶尔才会指定换账户，所以保留可改）。
   *
   * 不带：`toAccountId` —— 结算阶段由后端按 recordType 推导台账腿（`acc_sys_receivable`），
   * 用户在这里不该看见「转出账户 / 转入账户」这种只有转账才需要的字段。
   *
   * ⚠️ 金额带的是 `outstanding`（**元**字符串）。全站只有一处元↔分转换
   *    （`utils/money.ts:parseAmountToCents`），这里传字符串而不是乘 100 的数字，
   *    就是为了不再造第四份换算实现。
   */
  function onAction(act, d) {
    if (act === 'open') {
      go(`/transactions/${encodeURIComponent(d.id)}`);
      return;
    }
    const type = d.type === 'receivable' ? 'receivable' : 'payable';
    const isWriteOff = act === 'writeoff';
    const direction = isWriteOff
      ? 'write_off'
      : type === 'receivable'
        ? 'increase'
        : 'decrease';
    // 金额默认带出「还差多少」：多数情况一次结清，但用户可以改（部分结清）
    try {
      sessionStorage.setItem(
        'cc-ledger.compose-seed.v1',
        JSON.stringify({
          purpose: 'settle',
          recordType: type,
          direction,
          counterparty: d.counterparty || null,
          name: isWriteOff
            ? `${d.name || d.counterparty || ''} · ${type === 'receivable' ? '坏账核销' : '债务免除'}`.trim()
            : d.name || null,
          /** 分类与账户：与原笔一致，用户仍可在记账页改 */
          categoryId: d.category || null,
          accountId: d.account || null,
          /** 日期用原笔的发生日 —— 结清通常就在同一天/近期，但让用户自己选更稳 */
          txDate: undefined,
          amount: d.outstanding,
          settles: [{ transactionId: d.id, amount: d.outstanding }],
        }),
      );
    } catch {
      /* sessionStorage 不可用（隐私模式）：退回「不带种子」，用户手填 */
    }
    go('/transactions/new');
    toast(
      isWriteOff
        ? `已带入「${type === 'receivable' ? '坏账核销' : '债务免除'}」· 金额可改`
        : `已带入「结清」· 金额可改（部分结清就改小一点）`,
    );
  }

  /**
   * ⚠️ 失败必须是**可见的失败**，不能让页面停在骨架上。
   *
   * 原来这里没有 catch：`Api.listDebts` 一抛，首屏骨架就永远停在那里，
   * 用户看到的是一个「一直在加载」的空白页 —— 而真实情况是请求已经失败了。
   * 「加载中」和「加载失败」在界面上必须长得不一样。
   */
  async function load() {
    try {
      const res = await Api.listDebts(ledger.id, { status });
      view = res.data;
      paint();
    } catch (err) {
      frame.querySelector('[data-role=body]').replaceChildren(
        h(`
        <div class="card">
          <p class="tt-body-strong">往来加载失败</p>
          <p class="tt-caption text-muted">${esc(err?.message ?? '请稍后重试')}</p>
          <button class="btn btn--sm" type="button" data-role="retry">重试</button>
        </div>`),
      );
      frame.querySelector('[data-role=retry]')?.addEventListener('click', () => load());
    }
  }

  await load();
  mountTabBar(frame, { active: 'debts', go });
  return frame;
}
