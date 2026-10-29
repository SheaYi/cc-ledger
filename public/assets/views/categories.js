/**
 * 分类 —— 记账的「科目表」。
 * 两层结构：主类别 → 子类别（docs/03 §4），账单必须挂到子类别。
 * 版式：主类别块（图标 + 名称 + 近一年合计）+ 子类别 chip（图标 + 名称 + 近一年笔数）。
 * 内置分类（is_default）名称不可改，但可以停用（归档）不用的分类。
 */
import { Api } from '../api.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, loadSession } from '../session.js';
import { confirmDialog, entityIcon, esc, h, lucide, money, setLoading, toast } from '../ui.js';

const TABS = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'receivable', label: '应收' },
  { key: 'payable', label: '应付' },
];

/** 图标选择器候选集（Lucide），覆盖常见记账场景 */
const ICON_CHOICES = [
  'utensils', 'coffee', 'cookie', 'beer', 'wine', 'shopping-cart', 'shopping-bag',
  'shopping-basket', 'car-front', 'bus', 'train-front', 'plane', 'bike', 'fuel',
  'house', 'building-2', 'smartphone', 'laptop', 'wifi', 'cloud', 'clapperboard',
  'gamepad-2', 'music', 'ticket', 'heart-pulse', 'stethoscope', 'pill', 'shield',
  'graduation-cap', 'book-open', 'pencil', 'gift', 'heart', 'heart-handshake',
  'baby', 'paw-print', 'dumbbell', 'tent', 'waves', 'trophy', 'shirt', 'briefcase',
  'store', 'landmark', 'banknote', 'credit-card', 'wallet', 'coins', 'percent',
  'trending-up', 'receipt', 'package', 'wrench', 'scissors', 'flower-2', 'leaf',
];

export async function renderCategories(container, { go }) {
  const loading = appFrame({
    active: 'categories',
    inner: `<div class="card"><div class="skeleton" style="width:36%"></div>
            <div class="skeleton" style="width:66%;margin-top:14px"></div></div>`,
  });
  container.replaceChildren(loading);

  const me = await loadSession();
  const ledger = currentLedger(me);
  if (!ledger) {
    go('/login', { replace: true });
    return loading;
  }

  let recordType = 'expense';
  let showArchived = false;

  const frame = appFrame({
    active: 'categories',
    user: me,
    ledger,
    inner: `
      <div class="page__hero">
        <div class="row row--between row--wrap row--md">
          <div>
            <h1 class="tt-display-md">分类</h1>
            <p class="tt-caption text-muted">${esc(ledger.name)} · 主类别 → 子类别，账单挂在子类别上</p>
          </div>
          <button class="btn btn--sm" type="button" data-action="add-main">
            ${lucide('plus', 16)} 新增主类别
          </button>
        </div>
      </div>
      <div class="segmented" data-role="type-tabs"></div>
      <div data-role="form-slot"></div>
      <div data-role="list-slot"></div>
    `,
  });
  mountTabBar(frame, { active: 'categories', go });
  container.replaceChildren(frame);

  const tabsEl = frame.querySelector('[data-role=type-tabs]');
  const formSlot = frame.querySelector('[data-role=form-slot]');
  const listSlot = frame.querySelector('[data-role=list-slot]');

  const paintTabs = () => {
    tabsEl.innerHTML = TABS.map(
      (t) => `
      <button class="segmented__item" type="button" data-key="${t.key}"
              aria-selected="${t.key === recordType}">${esc(t.label)}</button>`,
    ).join('');
    tabsEl.querySelectorAll('.segmented__item').forEach((b) =>
      b.addEventListener('click', () => {
        recordType = b.dataset.key;
        paintTabs();
        renderList();
      }),
    );
  };

  const renderList = async () => {
    const tree = (await Api.listCategories(ledger.id, {
      recordType,
      includeArchived: showArchived,
    })).data;

    const totalMain = tree.length;
    const totalSub = tree.reduce((n, p) => n + p.children.length, 0);
    const archivedTotal = tree.reduce(
      (n, p) => n + (p.archivedAt ? 1 : 0) + p.children.filter((c) => c.archivedAt).length,
      0,
    );

    /** 主类别上 / 下移：交换同层可见顺序后整体提交，再重渲染（sortOrder 持久化） */
    const moveMain = async (target, dir) => {
      const idx = tree.findIndex((p) => p.id === target.id);
      if (idx < 0) return;
      const ni = dir === 'up' ? idx - 1 : idx + 1;
      if (ni < 0 || ni >= tree.length) return;
      const arr = [...tree];
      [arr[idx], arr[ni]] = [arr[ni], arr[idx]];
      try {
        await Api.reorderCategories(ledger.id, arr.map((p) => p.id));
        await renderList();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    /** 子类别上 / 下移：仅交换同一父级下的可见顺序 */
    const moveSub = async (parent, childId, dir) => {
      const kids = showArchived ? parent.children : parent.children.filter((c) => !c.archivedAt);
      const idx = kids.findIndex((c) => c.id === childId);
      if (idx < 0) return;
      const ni = dir === 'up' ? idx - 1 : idx + 1;
      if (ni < 0 || ni >= kids.length) return;
      const arr = [...kids];
      [arr[idx], arr[ni]] = [arr[ni], arr[idx]];
      try {
        await Api.reorderCategories(ledger.id, arr.map((c) => c.id));
        await renderList();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    listSlot.innerHTML = `
      <div class="list-meta">
        <span class="tt-fine-print">
          ${totalMain} 个主类别 · ${totalSub} 个子类别 · 金额为近一年使用统计
        </span>
        <label class="check">
          <input type="checkbox" data-role="show-archived" ${showArchived ? 'checked' : ''} />
          <span class="tt-fine-print">显示已停用${archivedTotal > 0 ? `（${archivedTotal}）` : ''}</span>
        </label>
      </div>
      ${
        tree.length === 0
          ? `<div class="card empty-state">
               <span class="empty-state__icon">${lucide('list-filter', 22)}</span>
               <p class="tt-body-strong">还没有分类</p>
               <p class="tt-caption text-muted">先建一个主类别，再往下挂子类别</p>
             </div>`
          : tree
              .map((p) => {
                const kids = showArchived
                  ? p.children
                  : p.children.filter((c) => !c.archivedAt);
                return `
        <div class="cat-block${p.archivedAt ? ' is-archived' : ''}" data-main="${esc(p.id)}">
          <div class="cat-block__head">
            <span class="cat-block__icon">${entityIcon(p.icon, 18)}</span>
            <span class="cat-block__name">${esc(p.name)}</span>
            ${p.isDefault ? '<span class="badge">内置</span>' : ''}
            ${p.archivedAt ? '<span class="badge badge--dark">已停用</span>' : ''}
            <span class="cat-block__total">
              合计 <b class="tnum">${money(p.txAmount ?? 0)}</b>
            </span>
            ${
              p.archivedAt
                ? `<button class="btn btn--quiet btn--sm" type="button" data-act="restore-main">恢复</button>`
                : `                     <span class="cat-block__actions">
                     <button class="btn btn--quiet btn--sm" type="button" data-act="move-up"
                             title="上移" aria-label="上移">${lucide('chevron-up', 14)}</button>
                     <button class="btn btn--quiet btn--sm" type="button" data-act="move-down"
                             title="下移" aria-label="下移">${lucide('chevron-down', 14)}</button>
                     <button class="btn btn--quiet btn--sm" type="button" data-act="add-sub"
                             title="在「${esc(p.name)}」下新增子类别">${lucide('plus', 14)} 子类别</button>
                     <button class="btn btn--quiet btn--sm" type="button" data-act="edit-main">编辑</button>
                     <button class="btn btn--quiet btn--sm" type="button" data-act="remove-main">删除</button>
                   </span>`
            }
          </div>
          ${
            kids.length
              ? `<div class="cat-chips">
                   ${kids
                     .map(
                       (c, i) => `
                   <div class="cat-chip${c.archivedAt ? ' is-archived' : ''}" data-cat="${esc(c.id)}"
                        title="编辑「${esc(c.name)}」">
                     <button class="cat-chip__move" type="button" data-submove="up" aria-label="上移"
                             ${i === 0 ? 'disabled' : ''}>${lucide('chevron-up', 14)}</button>
                     <span class="cat-chip__body" role="button" tabindex="0">
                       ${entityIcon(c.icon, 14)}
                       <span class="cat-chip__name">${esc(c.name)}</span>
                       ${c.txCount > 0 ? `<span class="cat-chip__count tnum">${c.txCount}</span>` : ''}
                       ${c.archivedAt ? '<span class="cat-chip__flag">已停用</span>' : ''}
                     </span>
                     <button class="cat-chip__move" type="button" data-submove="down" aria-label="下移"
                             ${i === kids.length - 1 ? 'disabled' : ''}>${lucide('chevron-down', 14)}</button>
                   </div>`,
                     )
                     .join('')}
                 </div>`
              : '<div class="cat-chips cat-chips--empty"><span class="tt-fine-print">该主类别下还没有子类别</span></div>'
          }
        </div>`;
              })
              .join('')
      }
    `;

    listSlot.querySelector('[data-role=show-archived]')?.addEventListener('change', (e) => {
      showArchived = e.target.checked;
      renderList();
    });

    /* 子类别 chip → 编辑（点击主体或回车；上/下移按钮单独处理） */
    listSlot.querySelectorAll('.cat-chip__body').forEach((body) => {
      const chip = body.closest('.cat-chip');
      const open = () => {
        const parent = tree.find((p) => p.id === chip?.closest('.cat-block')?.dataset.main);
        const child = parent?.children.find((c) => c.id === chip?.dataset.cat);
        if (parent && child) {
          openForm({ recordType, parentId: parent.id, parentName: parent.name, category: child });
        }
      };
      body.addEventListener('click', open);
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });

    /* 子类别上 / 下移 */
    listSlot.querySelectorAll('[data-submove]').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const chip = btn.closest('.cat-chip');
        const parent = tree.find((p) => p.id === chip?.closest('.cat-block')?.dataset.main);
        if (parent) moveSub(parent, chip.dataset.cat, btn.dataset.submove);
      }),
    );

    /* 块级操作 */
    listSlot.querySelectorAll('.cat-block').forEach((block) => {
      const parent = tree.find((p) => p.id === block.dataset.main);
      block.querySelectorAll('[data-act]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const act = btn.dataset.act;
          if (act === 'add-sub') {
            openForm({ recordType, parentId: parent.id, parentName: parent.name });
          } else if (act === 'edit-main') {
            openForm({ recordType, category: parent, parentName: '' });
          } else if (act === 'move-up') {
            moveMain(parent, 'up');
          } else if (act === 'move-down') {
            moveMain(parent, 'down');
          } else if (act === 'remove-main') {
            archiveCategory(parent);
          } else if (act === 'restore-main') {
            Api.restoreCategory(ledger.id, parent.id)
              .then(() => {
                toast(`已恢复「${parent.name}」`, 'success');
                renderList();
              })
              .catch((err) => toast(err.message, 'error'));
          }
        }),
      );
    });
  };

  /* ---------------- 删除（实为停用 / 软删除） ---------------- */
  const archiveCategory = async (target) => {
    const used = target.txCount > 0;
    const ok = await confirmDialog({
      title: `删除分类「${target.name}」`,
      confirmText: '删除',
      danger: true,
      lines: [
        {
          text: '删除后该分类会从账单选择器中移除，但已有账单完整保留、金额统计不受影响，且可随时恢复。',
          strong: true,
        },
        used
          ? `该分类近一年被 ${target.txCount} 笔账单引用，因此只能「停用」而非物理删除；这些账单的归类保持不变。`
          : '该分类暂无账单引用。',
        target.level === 1
          ? '它名下的子类别会一并停用；需要时可从「显示已停用」里逐个恢复。'
          : '需要时可从「显示已停用」里恢复。',
      ],
    });
    if (!ok) return;
    try {
      const res = await Api.deleteCategory(ledger.id, target.id);
      toast(
        res.data.txCount > 0
          ? `已删除「${target.name}」（${res.data.txCount} 笔历史账单保留）`
          : `已删除「${target.name}」`,
        'success',
      );
      formSlot.replaceChildren();
      await renderList();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  /* ---------------- 表单（新增 / 编辑 + 图标选择） ---------------- */
  const openForm = ({ recordType: rt, parentId = null, parentName = '', category = null }) => {
    const isSub = Boolean(parentId && !category);
    const isPreset = Boolean(category?.isDefault);
    const title = isSub
      ? `在「${parentName}」下新增子类别`
      : category
        ? `编辑「${category.name}」`
        : '新增主类别';

    const currentIcon = category?.icon ?? '';
    const iconGrid = ICON_CHOICES.map(
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
            <p class="tt-body-strong">${esc(title)}</p>
            <span class="badge">${esc(TABS.find((t) => t.key === rt)?.label ?? rt)}${
              isPreset ? ' · 内置' : ''
            }</span>
          </div>
          ${
            isPreset
              ? `<div class="panel row" style="align-items:flex-start">
                   ${lucide('info', 16)}
                   <span class="tt-fine-print">
                     内置分类不可修改名称；不需要的分类可以删除（停用，可恢复），随时可恢复。
                   </span>
                 </div>`
              : ''
          }
          <div class="field" data-field="name">
            <label class="field__label">名称</label>
            <input class="input" name="name" value="${esc(category?.name ?? '')}"
                   placeholder="例如：餐饮" ${isPreset ? 'disabled' : ''} />
            <span class="field__error"></span>
          </div>
          <div class="field">
            <label class="field__label">图标</label>
            <div class="icon-grid" role="radiogroup" aria-label="图标">${iconGrid}</div>
          </div>
          <div class="row">
            <button class="btn btn--sm" type="submit">${category ? '保存' : '创建'}</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
            ${
              category && !category.archivedAt
                ? `<button class="btn btn--quiet btn--sm" type="button" data-role="archive">删除</button>`
                : ''
            }
            ${
              category?.archivedAt
                ? `<button class="btn btn--secondary btn--sm" type="button" data-role="restore">恢复</button>`
                : ''
            }
          </div>
        </form>
      </div>
    `);

    form.querySelector('[data-role=cancel]').addEventListener('click', () => formSlot.replaceChildren());
    form.querySelectorAll('.icon-grid__item').forEach((item) =>
      item.addEventListener('click', () => {
        form.querySelectorAll('.icon-grid__item').forEach((s) => {
          s.classList.toggle('is-on', s === item);
          s.setAttribute('aria-checked', String(s === item));
        });
      }),
    );
    form.querySelector('[data-role=archive]')?.addEventListener('click', () => archiveCategory(category));
    form.querySelector('[data-role=restore]')?.addEventListener('click', () => {
      Api.restoreCategory(ledger.id, category.id)
        .then(() => {
          toast(`已恢复「${category.name}」`, 'success');
          formSlot.replaceChildren();
          renderList();
        })
        .catch((err) => toast(err.message, 'error'));
    });

    form.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = f.querySelector('button[type=submit]');
      setLoading(submit, true, '保存中');
      const icon = form.querySelector('.icon-grid__item.is-on')?.dataset.value || null;
      try {
        if (category) {
          const payload = { icon };
          // 内置分类只允许改展示图标，名称交给后端保护
          if (!isPreset) payload.name = f.name.value.trim();
          await Api.updateCategory(ledger.id, category.id, payload);
          toast('分类已更新', 'success');
        } else {
          await Api.createCategory(ledger.id, {
            recordType: rt,
            parentId,
            name: f.name.value.trim(),
            icon,
          });
          toast(parentId ? '子类别已创建' : '主类别已创建', 'success');
        }
        formSlot.replaceChildren();
        renderList();
      } catch (err) {
        const wrap = f.querySelector('[data-field=name] .field__error');
        if (wrap && !isPreset) wrap.textContent = err.message;
        toast(err.message, 'error');
      } finally {
        setLoading(submit, false);
      }
    });

    formSlot.replaceChildren(form);
    if (!isPreset) form.querySelector('input[name=name]')?.focus();
    form.scrollIntoView({ block: 'nearest' });
  };

  frame.querySelector('[data-action=add-main]').addEventListener('click', () => {
    openForm({ recordType });
  });

  paintTabs();
  await renderList();
  return frame;
}
