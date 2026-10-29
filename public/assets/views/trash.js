/**
 * 回收站（软删除的账单）
 *
 * ## 为什么要有这一页
 *
 * 「移入回收站」在账单列表里是一个行内菜单项，但**删完就没有入口了**：
 * 用户误删一笔后既看不到它、也捞不回来，只能重新录一遍 ——
 * 而重录的账单丢失了原记录的分类 / 标签 / 附件与创建时间。
 * 软删除（`deleted_at`）在后端早就存在，这一页是它的第一个消费方。
 *
 * ## 三个动作，语义必须分开
 *
 *   · **恢复** —— 撤销软删除，账单回到原来的位置（余额、统计全部回到原样）。
 *   · **彻底删除** —— 物理删行，**不可撤销**。所以二次确认的文案要说清后果，
 *     且只给 owner / admin（后端 `requireRole` 已拦，前端只是把 403 说成人话）。
 *   · **清空回收站** —— 批量彻底删除，危险度最高，确认按钮走危险色。
 *
 * ## 版式
 *
 * 复用既有排版类（`page__hero` / `card` / `badge` / `btn` / `empty-state` /
 * `list-meta`），新增的只有 `.trash-*` 一族（行布局没有现成等价物）。
 * 列宽**只写一处**：`--trash-cols` 变量，表头与数据行引用同一个变量 ——
 * 两处各写一遍必然在改列时错开（见对账历史页的同类教训）。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { confirmDialog, entityIcon, esc, formatDateTime, icon, toast } from '../ui.js';
import { amountText, amountTone, subjectIcon, subjectText, typeBadge } from '../lib/tx-format.js';

/** 一页取满：回收站不是翻页浏览的场景，用户是来找某一笔的 */
const PAGE_SIZE = 200;

export async function renderTrash(container, { go } = {}) {
  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!me || !ledger) {
    container.replaceChildren();
    return null;
  }

  let items = [];
  /** 勾中的 id。用 Set 而不是给 DOM 挂 class：渲染是整块重绘的，class 会丢 */
  const selected = new Set();
  let busy = false;

  const frame = appFrame({
    active: 'trash',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">回收站</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 移入这里的账单仍占着数据，恢复即可回到原处
            </p>
          </div>
        </div>
      </div>

      <div data-role="bar-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  container.replaceChildren(frame);
  mountTabBar(frame, { active: 'trash', go, ledger });

  const barSlot = frame.querySelector('[data-role=bar-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');

  /* ---------------- 渲染 ---------------- */

  function rowHtml(tx) {
    const delta = Number(tx.signedAmount ?? tx.accountDelta ?? 0);
    const badge = typeBadge(tx);
    const name = tx.name ? String(tx.name) : '';
    const cat = subjectText(tx);
    return `
      <div class="trash-row" data-id="${esc(tx.id)}">
        <label class="trash-row__pick" title="选择">
          <input type="checkbox" data-pick="${esc(tx.id)}"
                 aria-label="选择「${esc(name || cat)}」"${selected.has(tx.id) ? ' checked' : ''} />
        </label>

        <span class="trash-row__main">
          <span class="trash-row__icon">${entityIcon(subjectIcon(tx), 16) || icon('list', 16)}</span>
          <span class="trash-row__text">
            <span class="trash-row__name">${esc(name || cat)}</span>
            <span class="trash-row__sub">${esc(name ? cat : tx.account?.name ?? '')}</span>
          </span>
        </span>

        <!--
          四个元信息格包一层 trash-row__meta：桌面 display:contents
          （子元素各自占一列），手机端收成第二行一行（与 tx-row__meta 同一套做法）。
          不包这层，手机端就得给 4 个格子各写一个 grid-area —— 而它们本来就是同一组信息。
        -->
        <span class="trash-row__meta">
          <span class="trash-row__badge">${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</span>
          <span class="trash-row__acct">${esc(tx.account?.name ?? '')}</span>
          <span class="trash-row__date tnum">${esc(String(tx.txDate ?? ''))}</span>
          <span class="trash-row__del tnum" title="删除时间">${esc(formatDateTime(tx.deletedAt))}</span>
        </span>
        <span class="trash-row__amt tnum ${amountTone(delta)}">${esc(amountText(delta))}</span>

        <span class="trash-row__acts">
          <button class="btn btn--sm" type="button" data-act="restore" data-id="${esc(tx.id)}">恢复</button>
          <button class="btn btn--sm btn--danger" type="button" data-act="purge" data-id="${esc(tx.id)}">彻底删除</button>
        </span>
      </div>`;
  }

  function renderBar() {
    const n = selected.size;
    const all = items.length > 0 && n === items.length;
    barSlot.innerHTML = `
      <div class="card trash-bar">
        <label class="trash-bar__all">
          <input type="checkbox" data-role="all"${all ? ' checked' : ''} aria-label="全选" />
          <span>全选</span>
        </label>
        <span class="trash-bar__count list-meta">共 ${items.length} 笔${n ? ` · 已选 ${n} 笔` : ''}</span>
        <span class="trash-bar__spacer"></span>
        <button class="btn btn--sm" type="button" data-act="restore-sel"${n ? '' : ' disabled'}>恢复所选</button>
        <button class="btn btn--sm btn--danger" type="button" data-act="purge-sel"${n ? '' : ' disabled'}>彻底删除所选</button>
        <button class="btn btn--sm btn--danger" type="button" data-act="empty"${items.length ? '' : ' disabled'}>清空回收站</button>
      </div>`;
  }

  function renderList() {
    if (!items.length) {
      listSlot.innerHTML = `
        <div class="card">
          <div class="empty-state">
            <span class="empty-state__icon">${icon('trash', 22)}</span>
            <p class="tt-body-strong">回收站是空的</p>
            <p class="tt-fine-print text-muted">移入回收站的账单会出现在这里，恢复后回到原处</p>
          </div>
        </div>`;
      return;
    }
    listSlot.innerHTML = `
      <div class="card card--flush trash-list">
        <div class="trash-row trash-row--head">
          <span></span>
          <span class="trash-row__main">账单</span>
          <span class="trash-row__meta">
            <span class="trash-row__badge">类型</span>
            <span class="trash-row__acct">账户</span>
            <span class="trash-row__date">记账日</span>
            <span class="trash-row__del">删除时间</span>
          </span>
          <span class="trash-row__amt">金额</span>
          <span class="trash-row__acts"></span>
        </div>
        ${items.map(rowHtml).join('')}
      </div>`;
  }

  function render() {
    renderBar();
    renderList();
  }

  /* ---------------- 数据 ---------------- */

  async function load() {
    const res = await Api.listTrash(ledger.id, { pageSize: PAGE_SIZE }).catch(() => null);
    items = res?.data ?? [];
    /** 已经不在回收站里的（恢复了 / 被清了）要从选中集里摘掉，否则计数会虚高 */
    const alive = new Set(items.map((t) => t.id));
    for (const id of [...selected]) if (!alive.has(id)) selected.delete(id);
    render();
  }

  /* ---------------- 动作 ---------------- */

  /**
   * 后端对「彻底删除」做了 owner/admin 限制，这里只是把 403 说成人话：
   * 「操作失败」会让人以为是网络问题，而真正的原因是权限。
   */
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      toast(label);
      await load();
    } catch (err) {
      toast(err?.message ?? `${label}失败`, 'error');
    } finally {
      busy = false;
    }
  }

  const ids = () => [...selected];

  async function onBarClick(e) {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      const act = btn.dataset.act;
      if (act === 'restore-sel') {
        const n = ids().length;
        if (!n) return;
        await run(`已恢复 ${n} 笔`, () => Api.batchRestoreTransactions(ledger.id, ids()));
        return;
      }
      if (act === 'purge-sel') {
        const n = ids().length;
        if (!n) return;
        const ok = await confirmDialog({
          title: `彻底删除 ${n} 笔账单`,
          lines: [
            { text: '这些账单将被物理删除，无法恢复。', strong: true },
            '它们涉及的账户余额、报表统计会一并变化（相当于这些账从未记过）。',
            '只是想让它们回到账本里，请改用「恢复所选」。',
          ],
          confirmText: '彻底删除',
          danger: true,
        });
        if (!ok) return;
        await run(`已彻底删除 ${n} 笔`, async () => {
          for (const id of ids()) await Api.permanentDeleteTransaction(ledger.id, id);
        });
        return;
      }
      if (act === 'empty') {
        const ok = await confirmDialog({
          title: '清空回收站',
          lines: [
            { text: `回收站里共 ${items.length} 笔账单将被物理删除，无法恢复。`, strong: true },
            '这个动作不可撤销，且会影响账户余额与历史报表。',
            '不确定就先「恢复所选」，把要留的捞回来再清。',
          ],
          confirmText: '清空回收站',
          danger: true,
        });
        if (!ok) return;
        await run('回收站已清空', () => Api.emptyTrash(ledger.id));
      }
      return;
    }

    const all = e.target.closest('[data-role=all]');
    if (all) {
      if (all.checked) items.forEach((t) => selected.add(t.id));
      else selected.clear();
      render();
    }
  }

  async function onListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      const id = btn.dataset.id;
      if (btn.dataset.act === 'restore') {
        await run('已恢复', () => Api.restoreTransaction(ledger.id, id));
        return;
      }
      const ok = await confirmDialog({
        title: '彻底删除这笔账单',
        lines: [
          { text: '它将被物理删除，无法恢复。', strong: true },
          '只是想让它回到账本里，请改用「恢复」。',
        ],
        confirmText: '彻底删除',
        danger: true,
      });
      if (!ok) return;
      await run('已彻底删除', () => Api.permanentDeleteTransaction(ledger.id, id));
      return;
    }

    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const id = pick.dataset.pick;
      if (pick.checked) selected.add(id);
      else selected.delete(id);
      renderBar();
    }
  }

  barSlot.addEventListener('click', (e) => onBarClick(e).catch((err) => toast(err?.message ?? '操作失败', 'error')));
  listSlot.addEventListener('click', (e) => onListClick(e).catch((err) => toast(err?.message ?? '操作失败', 'error')));

  await load();
  return null;
}
