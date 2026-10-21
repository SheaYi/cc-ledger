/**
 * 标签 —— 记账的「多维标记」。
 * 分类回答「这笔钱花在哪」，标签回答「这笔钱属于什么事」（出差 / 报销 / AA / 装修…）。
 * 一笔账单可以打多个标签，所以标签是账本级主数据而不是分类的子集（docs/02 §六）。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { esc, h, setLoading, toast } from '../ui.js';

/** 与后端 src/config/constants.ts 的 TAG_COLORS 保持一致 */
const PALETTE = [
  { value: '#FF3B30', label: '红' },
  { value: '#FF9500', label: '橙' },
  { value: '#FFCC00', label: '黄' },
  { value: '#34C759', label: '绿' },
  { value: '#007AFF', label: '蓝' },
  { value: '#AF52DE', label: '紫' },
  { value: '#8E8E93', label: '灰' },
  { value: '#636366', label: '深灰' },
];

export async function renderTags(container, { go }) {
  const loading = appFrame({
    active: 'tags',
    inner: `<div class="card"><div class="skeleton" style="width:34%"></div>
            <div class="skeleton" style="width:62%;margin-top:14px"></div></div>`,
  });
  container.replaceChildren(loading);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return loading;
  }

  let showArchived = false;

  const frame = appFrame({
    active: 'tags',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">标签</h1>
            <p class="tt-caption text-muted">
              ${esc(ledger.name)} · 给账单加多维标记，比如「出差」「可报销」「AA」
            </p>
          </div>
          <button class="btn btn--sm" type="button" data-action="add-tag">新建标签</button>
        </div>
      </div>

      <div data-role="stats-slot"></div>
      <div data-role="form-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  mountTabBar(frame, { active: 'settings', go });
  container.replaceChildren(frame);

  const statsSlot = frame.querySelector('[data-role=stats-slot]');
  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');

  const render = async () => {
    const tags = (await Api.listTags(ledger.id, { includeArchived: showArchived })).data;
    const live = tags.filter((t) => !t.archivedAt);
    const tagged = live.filter((t) => t.useCount > 0);
    const totalUse = live.reduce((n, t) => n + t.useCount, 0);
    const top = [...live].sort((a, b) => b.useCount - a.useCount)[0];

    statsSlot.innerHTML = `
      <section class="stat-strip">
        <div class="stat-strip__cell">
          <span class="stat-strip__label">可用标签</span>
          <span class="stat-strip__value tnum">${live.length}</span>
        </div>
        <div class="stat-strip__cell">
          <span class="stat-strip__label">已被使用</span>
          <span class="stat-strip__value tnum">${tagged.length}</span>
        </div>
        <div class="stat-strip__cell">
          <span class="stat-strip__label">累计打标</span>
          <span class="stat-strip__value tnum">${totalUse} 次</span>
        </div>
        <div class="stat-strip__cell">
          <span class="stat-strip__label">最常用</span>
          <span class="stat-strip__value">${
            top && top.useCount > 0 ? esc(top.name) : '<span class="text-muted">—</span>'
          }</span>
        </div>
      </section>
    `;

    listSlot.innerHTML = `
      <div class="list-meta">
        <span class="tt-fine-print">共 ${tags.length} 个标签</span>
        <label class="check">
          <input type="checkbox" data-role="show-archived" ${showArchived ? 'checked' : ''} />
          <span class="tt-fine-print">显示已停用</span>
        </label>
      </div>
      ${
        tags.length === 0
          ? `<div class="card empty-state">
               <span class="empty-state__icon">🏷️</span>
               <p class="tt-body-strong">还没有标签</p>
               <p class="tt-caption text-muted">
                 标签适合标记「跨分类」的事情，例如一次出差的机票、酒店、打车都打上「出差」
               </p>
             </div>`
          : `<div class="tag-grid">
               ${tags
                 .map(
                   (t) => `
               <div class="tag-card${t.archivedAt ? ' is-archived' : ''}" data-tag="${esc(t.id)}">
                 <span class="tag-card__dot" style="background:${esc(t.color)}"></span>
                 <span class="tag-card__main">
                   <span class="tt-body-strong">${esc(t.name)}</span>
                   <span class="tt-fine-print">
                     ${t.useCount > 0 ? `${t.useCount} 笔账单` : '尚未使用'}${t.archivedAt ? ' · 已停用' : ''}
                   </span>
                 </span>
                 ${
                   t.archivedAt
                     ? '<span class="badge badge--dark">已停用</span>'
                     : `<span class="tag-card__actions">
                          <button class="btn btn--quiet btn--sm" type="button" data-act="edit">编辑</button>
                          <button class="btn btn--quiet btn--sm" type="button" data-act="remove">停用</button>
                        </span>`
                 }
               </div>`,
                 )
                 .join('')}
             </div>`
      }
    `;

    listSlot.querySelector('[data-role=show-archived]')?.addEventListener('change', (e) => {
      showArchived = e.target.checked;
      render();
    });

    listSlot.querySelectorAll('.tag-card [data-act]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.closest('[data-tag]').dataset.tag;
        const tag = tags.find((t) => t.id === id);
        if (!tag) return;

        if (btn.dataset.act === 'edit') {
          openForm(tag);
          return;
        }

        const extra =
          tag.useCount > 0
            ? `该标签已用在 ${tag.useCount} 笔账单上，将执行「停用」而不是删除，历史账单的标签不受影响。`
            : '停用后新建账单时不再出现在标签选择器里。';
        if (!window.confirm(`确认停用标签「${tag.name}」？\n\n${extra}`)) return;

        try {
          const res = await Api.deleteTag(ledger.id, tag.id);
          const n = res.data?.useCount ?? 0;
          toast(n > 0 ? `已停用「${tag.name}」（${n} 笔历史账单保留）` : `已停用「${tag.name}」`, 'success');
          await render();
        } catch (err) {
          toast(err.message, 'error');
        }
      }),
    );
  };

  /* ---------------- 表单 ---------------- */
  const openForm = (tag = null) => {
    const selected = tag?.color ?? PALETTE[4].value;

    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <div class="row row--between row--wrap">
            <p class="tt-body-strong">${tag ? '编辑标签' : '新建标签'}</p>
            <span class="tt-fine-print">最多 12 个字，同一账本内不可重名</span>
          </div>

          <div class="field" data-field="name">
            <label class="field__label">标签名</label>
            <input class="input" name="name" maxlength="12" value="${esc(tag?.name ?? '')}"
                   placeholder="例如：可报销" />
            <span class="field__error"></span>
          </div>

          <div>
            <span class="field__label">颜色</span>
            <div class="swatch-row" role="radiogroup" aria-label="标签颜色">
              ${PALETTE.map(
                (c) => `
                <button class="swatch" type="button" role="radio"
                        aria-checked="${c.value === selected}" data-value="${esc(c.value)}"
                        title="${esc(c.label)}" style="--swatch:${esc(c.value)}">
                  <span class="swatch__fill"></span>
                </button>`,
              ).join('')}
            </div>
          </div>

          <div class="row">
            <button class="btn btn--sm" type="submit">${tag ? '保存' : '创建'}</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          </div>
        </form>
      </div>
    `);

    form.querySelectorAll('.swatch').forEach((sw) =>
      sw.addEventListener('click', () => {
        form
          .querySelectorAll('.swatch')
          .forEach((s) => s.setAttribute('aria-checked', String(s === sw)));
      }),
    );

    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());

    form.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = f.querySelector('button[type=submit]');
      setLoading(submit, true, '保存中');
      try {
        const payload = {
          name: f.name.value.trim(),
          color: form.querySelector('.swatch[aria-checked=true]')?.dataset.value,
        };
        if (tag) {
          await Api.updateTag(ledger.id, tag.id, payload);
          toast('标签已更新', 'success');
        } else {
          await Api.createTag(ledger.id, payload);
          toast('标签已创建', 'success');
        }
        formSlot.replaceChildren();
        await render();
      } catch (err) {
        const wrap = f.querySelector('[data-field=name] .field__error');
        if (wrap) wrap.textContent = err.message;
        if (!err.details?.length) toast(err.message, 'error');
      } finally {
        setLoading(submit, false);
      }
    });

    formSlot.replaceChildren(form);
    form.querySelector('input[name=name]').focus();
    form.scrollIntoView({ block: 'nearest' });
  };

  frame.querySelector('[data-action=add-tag]').addEventListener('click', () => openForm(null));

  await render();
  return frame;
}
