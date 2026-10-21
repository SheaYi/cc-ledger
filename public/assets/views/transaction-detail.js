/**
 * 账单详情页 `/transactions/:id`（docs/13 §3.4 路由表 · §9.4「查看详情」的落点）
 *
 * 一条账单里最容易看不懂的是**「这笔钱到底动了谁」**：支出动一个账户，
 * 转账动两个（还可能有手续费这个第三个），应收/应付在「产生」阶段可能一个账户都不动。
 * 所以这一页的主结构不是「字段罗列」，而是：
 *   ① 顶部一行说清「这是什么、动了多少」
 *   ② 「金额构成」把 `03 §1.2` 的公式摊开（复用 `lib/amounts.js` 的同构公式，
 *      与服务端、与记账页预览三方同源 —— 这里绝不复写一遍算法）
 *   ③ 「明细」才是字段清单
 *
 * 有意为之：
 *  · 余额调整（adjustment）只能看不能改 —— 它的唯一合法来源是对账（docs/05 §9.5），
 *    给「编辑」等于开了一条绕过对账的暗门。
 *  · 已在回收站的账单（`deletedAt`）走另一套动作：恢复 / 永久删除，不给「编辑」。
 */
import { Api } from '../api.js';
import { appFrame } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import {
  RECORD_TYPE_LABEL,
  actionToast,
  esc,
  h,
  icon,
  lucide,
  money,
  setLoading,
  toast,
} from '../ui.js';
import {
  amountText,
  amountTone,
  dashText,
  stampLabel,
  subjectText,
} from '../lib/tx-format.js';
import { calculateAmounts, parseAmountToCents } from '../lib/amounts.js';

export async function renderTransactionDetail(container, { go, txId }) {
  const loading = appFrame({
    active: 'transactions',
    inner: `<div class="card"><div class="skeleton" style="width:30%"></div>
            <div class="skeleton" style="width:54%;height:40px;margin-top:20px"></div>
            <div class="skeleton" style="width:80%;margin-top:20px"></div></div>`,
  });
  container.replaceChildren(loading);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return loading;
  }

  let tx;
  try {
    tx = (await Api.getTransaction(ledger.id, txId)).data;
  } catch (err) {
    container.replaceChildren(
      notFoundFrame(me, ledger, err, go),
    );
    return null;
  }

  const delta = Number(tx.signedAmount ?? tx.accountDelta ?? 0);
  const deleted = !!tx.deletedAt;

  const frame = appFrame({
    active: 'transactions',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div class="stack stack--sm">
            <div class="row row--wrap">
              <a class="btn btn--quiet btn--sm" href="/transactions" data-link
                 aria-label="返回账单列表">${icon('chevron', 14)}账单</a>
              <span class="badge">${esc(RECORD_TYPE_LABEL[tx.recordType] ?? tx.recordType)}</span>
              ${tx.stageLabel ? `<span class="badge badge--accent">${esc(tx.stageLabel)}</span>` : ''}
              ${deleted ? '<span class="badge badge--dark">已在回收站</span>' : ''}
            </div>
            <h1 class="txd__amount tnum ${amountTone(delta)}">${esc(amountText(delta))}</h1>
            <p class="tt-caption text-muted">
              ${esc(subjectText(tx))}${tx.name ? ` · ${esc(tx.name)}` : ''}
            </p>
          </div>
          <div class="row row--wrap" data-role="actions"></div>
        </div>
      </div>

      <div class="txd">
        ${
          /**
           * 金额构成 + 凭证附件 作为一组（`txd__pair`）：两张卡无缝相连、共享一条发丝线，
           * 让「凭证附件紧邻金额构成下方」在桌面两列与窄屏单列下都成立，
           * 同时压缩掉两卡之间原有的 24px 网格间距 + 各自内边距，页面更紧凑。
           * 凭证附件（R-13）入口保留：绝大多数账单没有附件，但「功能对用户等于不存在」比占一屏更糟。
           */
          `<div class="txd__pair">
          <section class="card txd__card">
            <div class="card__head"><h3 class="tt-body-strong">金额构成</h3></div>
            <p class="tt-caption text-muted" data-role="explain"></p>
            <div class="txd__formula" data-role="lines"></div>
            <div class="txd__deltas" data-role="deltas"></div>
          </section>

          <section class="card txd__card" data-role="attach-card">
            <div class="card__head">
              <h3 class="tt-body-strong">凭证附件</h3>
              <label class="btn btn--quiet btn--sm">
                添加
                <input type="file" hidden data-role="attach-input"
                       accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,text/plain,text/csv" />
              </label>
            </div>
            <div data-role="attach-list"></div>
          </section>
        </div>`
        }

        <section class="card txd__card">
          <div class="card__head"><h3 class="tt-body-strong">明细</h3></div>
          <div class="txd__fields" data-role="fields"></div>
        </section>
      </div>
    `,
  });
  container.replaceChildren(frame);

  const $ = (sel) => frame.querySelector(sel);

  /* ---------------- 金额构成：复用与服务端同源的公式 ---------------- */
  const inputs = {
    recordType: tx.recordType,
    direction: tx.direction,
    amount: parseAmountToCents(tx.amount) ?? 0,
    fee: parseAmountToCents(tx.fee) ?? 0,
    discount: parseAmountToCents(tx.discount) ?? 0,
  };
  try {
    const calc = calculateAmounts(inputs);
    $('[data-role=explain]').textContent = calc.explanation;

    const lines = h('<ul class="txd__lines"></ul>');
    (calc.previewLines ?? []).forEach((line) => {
      lines.appendChild(h(`<li class="tt-fine-print">${esc(line)}</li>`));
    });
    $('[data-role=lines]').replaceChildren(lines);

    $('[data-role=deltas]').replaceChildren(
      deltasBlock([
        {
          label: tx.toAccount ? `${tx.account?.name ?? '主账户'} 余额` : '账户余额影响',
          value: calc.accountDelta / 100,
          hint: tx.account?.name ?? '',
        },
        tx.toAccount
          ? { label: `${tx.toAccount.name} 余额`, value: calc.toAccountDelta / 100, hint: tx.toAccount.name }
          : null,
        calc.feeAccountDelta
          ? { label: '手续费账户（虚拟）', value: calc.feeAccountDelta / 100, hint: '不参与净资产' }
          : null,
      ].filter(Boolean)),
    );
  } catch (err) {
    // 公式算不出来说明这条数据的字段组合本身不合法（历史数据 / 迁移残留）——
    // 不静默吞掉，明确告诉用户"这条数据有问题"，而不是显示一排 0 让人以为账平了。
    $('[data-role=explain]').textContent = `这条账单的字段组合无法通过账务公式校验：${err.message}`;
    $('[data-role=lines]').replaceChildren();
    $('[data-role=deltas]').replaceChildren();
  }

  /* ---------------- 明细字段 ---------------- */
  const tagList = tx.tags ?? [];
  $('[data-role=fields]').replaceChildren(
    fieldsBlock([
      ['记录类型', RECORD_TYPE_LABEL[tx.recordType] ?? tx.recordType],
      tx.stageLabel ? ['阶段', tx.stageLabel] : null,
      ['分类', tx.category ? subjectText(tx) : dashText(null, '未分类')],
      ['账户', tx.account ? `${tx.account.name}` : dashText(null, '—')],
      tx.toAccount ? ['转入 / 目标账户', tx.toAccount.name] : null,
      ['金额', money(Number(tx.amount))],
      Number(tx.fee) ? ['手续费', money(Number(tx.fee))] : null,
      Number(tx.discount) ? ['折扣', money(Number(tx.discount))] : null,
      ['实际值', money(Number(tx.actualAmount))],
      ['名称', dashText(tx.name)],
      ['商家', dashText(tx.merchant)],
      ['对象', dashText(tx.counterparty)],
      ['备注', dashText(tx.note)],
      ['日期时间', stampLabel(tx)],
      ['创建时间', tx.createdAt ? String(tx.createdAt).replace('T', ' ').slice(0, 16) : '—'],
      tx.updatedAt && tx.updatedAt !== tx.createdAt
        ? ['最后修改', String(tx.updatedAt).replace('T', ' ').slice(0, 16)]
        : null,
      ['记账人', tx.createdBy ? tx.createdBy.nickname : '—'],
    ].filter(Boolean)),
  );

  if (tagList.length) {
    const chips = h('<div class="txd__tags"></div>');
    tagList.forEach((t) =>
      chips.appendChild(
        h(`<span class="badge" style="--tag:${esc(t.color)}">
             <span class="chip__dot"></span>${esc(t.name)}
           </span>`),
      ),
    );
    const row = h('<div class="kv"><span class="tt-fine-print">标签</span><span class="txd__tagcell"></span></div>');
    row.querySelector('.txd__tagcell').replaceWith(chips);
    $('[data-role=fields]').appendChild(row);
  }

  /* ---------------- 凭证附件（R-13） ---------------- */
  /**
   * 附件**在回收站里不给加**：后端会拒（`账单在回收站里，恢复后才能继续添加附件`），
   * 而让用户先撞一次 400 再看懂那句话，不如界面上直接不给入口。
   */
  const attachInput = $('[data-role=attach-input]');
  const attachList = $('[data-role=attach-list]');
  if (deleted && attachInput) {
    $('[data-role=attach-card] .card__head .btn')?.remove();
  }

  /**
   * 渲染附件列表。
   *
   * ⚠️ 历史坑：曾经把所有附件拼成一个多节点字符串一次性传给 `h()`，
   * 而 `h()` 只返回 `tpl.content.firstElementChild`（第一个节点），
   * 于是多附件时只剩第一条被渲染、其余「消失」——表现为「只显示最后上传的、
   * 删掉最新的才露出上一个」。这里改为**每条附件单独建节点再追加**，
   * 从根上规避 `h()` 截断，也顺带让删除按钮各自绑定、互不影响。
   */
  async function loadAttachments() {
    if (!attachList) return;
    try {
      const rows = (await Api.listAttachments(ledger.id, tx.id)).data;
      if (!rows.length) {
        attachList.replaceChildren(
          h('<p class="tt-caption text-muted">没有附件。退票截图、发票、合同都可以放这里。</p>'),
        );
        return;
      }
      const frag = document.createDocumentFragment();
      rows.forEach((a) => {
        const row = h(attachmentRowHtml(a));
        const delBtn = row.querySelector('[data-del]');
        delBtn?.addEventListener('click', () => deleteAttachment(a, delBtn));
        frag.appendChild(row);
      });
      attachList.replaceChildren(frag);
    } catch (err) {
      attachList.replaceChildren(h(`<p class="tt-caption is-neg">${esc(err.message ?? '附件加载失败')}</p>`));
    }
  }

  function attachmentRowHtml(a) {
    return `<div class="recon-line">
      ${
        a.mimeType?.startsWith('image/')
          ? `<img class="txd__thumb" src="${esc(a.url)}" alt="" loading="lazy" />`
          : `<span class="txd__fileicon">${lucide('file-text', 16)}</span>`
      }
      <a class="tt-caption" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.fileName)}</a>
      <span class="tt-fine-print text-muted">${esc(a.sizeText ?? '')}</span>
      <button class="btn btn--quiet btn--sm" type="button" data-del="${esc(a.id)}">删除</button>
    </div>`;
  }

  async function deleteAttachment(a, delBtn) {
    if (!window.confirm(`删除附件「${a.fileName}」？`)) return;
    setLoading(delBtn, true, '删除中');
    try {
      await Api.deleteAttachment(ledger.id, a.id);
      toast('附件已删除', 'success');
      await loadAttachments();
    } catch (err) {
      setLoading(delBtn, false);
      toast(err.message, 'error');
    }
  }

  attachInput?.addEventListener('change', async () => {
    const file = attachInput.files?.[0];
    if (!file) return;
    setLoading(attachInput, true, '上传中');
    try {
      await Api.uploadAttachment(ledger.id, tx.id, file);
      toast('附件已上传', 'success');
      attachInput.value = '';
      await loadAttachments();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(attachInput, false);
    }
  });
  loadAttachments();

  /* ---------------- 动作 ---------------- */
  const actHost = $('[data-role=actions]');
  if (deleted) {
    actHost.append(
      btn('恢复这笔账单', 'primary', async (b) => {
        setLoading(b, true, '恢复中');
        try {
          await Api.restoreTransaction(ledger.id, tx.id);
          toast('已恢复', 'success');
          go(`/transactions/${encodeURIComponent(tx.id)}`, { replace: true });
        } catch (err) {
          setLoading(b, false);
          toast(err.message, 'error');
        }
      }),
      btn('永久删除', 'danger', async (b) => {
        if (
          !window.confirm(
            '永久删除后无法恢复，附件也会一并删除。\n\n确认永久删除这笔账单？',
          )
        )
          return;
        setLoading(b, true, '删除中');
        try {
          await Api.permanentDeleteTransaction(ledger.id, tx.id);
          toast('已永久删除', 'success');
          go('/transactions');
        } catch (err) {
          setLoading(b, false);
          toast(err.message, 'error');
        }
      }),
    );
  } else {
    // 余额调整只能由对账生成（docs/05 §9.5），不给编辑入口，避免绕开「账可被证明」
    if (tx.recordType !== 'adjustment') {
      actHost.appendChild(
        h(`<a class="btn btn--secondary btn--sm" href="/transactions/${encodeURIComponent(
          tx.id,
        )}/edit" data-link>${lucide('pencil', 16)}编辑</a>`),
      );
    }
    actHost.append(
      h(`<a class="btn btn--quiet btn--sm" href="/transactions/new?copyFrom=${encodeURIComponent(
        tx.id,
      )}" data-link>${lucide('copy', 16)}复制一笔</a>`),
      /**
       * 存为模板（`docs/05 §10.3` 的三种创建方式之一）。
       *
       * 刻意**不弹输入框**：模板名默认取这笔的「名称」，重名时自动退到
       * 「分类 · 类型」再加时间后缀，用户一句话都不用填就能存完 ——
       * 存模板这件事本身不该成为一次需要动脑的操作。要改名去面板里改。
       * 存完给「撤销」，因为建了东西却撤不掉是所有这类操作里最烦人的一种。
       */
      btn('存为模板', 'quiet', async (b) => {
        setLoading(b, true, '处理中');
        const base = tx.name?.trim() || `${subjectText(tx)} · ${RECORD_TYPE_LABEL[tx.recordType]}`;
        let created = null;
        try {
          created = (await Api.saveAsTemplate(ledger.id, tx.id, { name: base.slice(0, 20) })).data;
        } catch (err) {
          // 同名就退到带时间后缀的名字；再失败才报错
          const stamped = `${base.slice(0, 14)} ${new Date().toTimeString().slice(0, 5)}`;
          try {
            created = (await Api.saveAsTemplate(ledger.id, tx.id, { name: stamped })).data;
          } catch (err2) {
            setLoading(b, false);
            toast(err2.message || err.message, 'error');
            return;
          }
        }
        setLoading(b, false);
        if (!created) return;
        toast(`已存为模板「${created.name}」，长按「记一笔」可用`, 'success');
        actionToast(`模板「${created.name}」已创建`, [
          {
            label: '撤销',
            primary: true,
            onClick: async () => {
              try {
                await Api.deleteTemplate(ledger.id, created.id);
                toast('已撤销', 'success');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
        ]);
      }),
      btn('移入回收站', 'danger', async (b) => {
        if (!window.confirm(`把「${subjectText(tx)} ${amountText(delta)}」移入回收站？\n\n回收站保留 30 天。`))
          return;
        setLoading(b, true, '处理中');
        try {
          await Api.deleteTransaction(ledger.id, tx.id);
          go('/transactions');
          actionToast(`已移入回收站 · ${subjectText(tx)}`, [
            {
              label: '撤销',
              primary: true,
              onClick: async () => {
                try {
                  await Api.restoreTransaction(ledger.id, tx.id);
                  toast('已恢复', 'success');
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
          ]);
        } catch (err) {
          setLoading(b, false);
          toast(err.message, 'error');
        }
      }),
    );
  }

  return frame;
}

/* ---------------- 小组件 ---------------- */

function btn(label, kind, onClick) {
  const node = h(
    `<button class="btn btn--${kind} btn--sm" type="button">${esc(label)}</button>`,
  );
  node.addEventListener('click', () => onClick(node));
  return node;
}

function deltasBlock(rows) {
  const node = h('<div class="txd__delta-list"></div>');
  rows.forEach((r) => {
    const v = Number(r.value ?? 0);
    node.appendChild(
      h(`
        <div class="txd__delta">
          <span class="txd__delta-label">${esc(r.label)}</span>
          <span class="txd__delta-value tnum ${amountTone(v)}">${esc(amountText(v))}</span>
        </div>
      `),
    );
  });
  return node;
}

function fieldsBlock(rows) {
  const node = h('<div></div>');
  rows.forEach(([label, value]) => {
    node.appendChild(
      h(`
        <div class="kv">
          <span class="tt-fine-print">${esc(label)}</span>
          <span class="kv__v">${esc(value)}</span>
        </div>
      `),
    );
  });
  return node;
}

function notFoundFrame(me, ledger, err, go) {
  const frame = appFrame({
    active: 'transactions',
    user: me,
    ledger,
    inner: `
      <div class="card empty-state">
        <span class="empty-state__icon">${lucide('search', 22)}</span>
        <p class="tt-body-strong">找不到这笔账单</p>
        <p class="tt-caption text-muted">${esc(err?.message ?? '它可能已被永久删除，或不在当前账本里。')}</p>
        <a class="btn btn--sm" href="/transactions" data-link>回到账单列表</a>
      </div>
    `,
  });
  void go;
  return frame;
}
