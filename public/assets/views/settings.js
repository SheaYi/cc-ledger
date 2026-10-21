/**
 * 我的（设置）—— 账号、账本、成员、安全。
 * 这里刻意不放任何记账内容：记账在概览/账户/分类/标签，这一页只管「人」和「账本」本身。
 */
import { Api, ApiError } from '../api.js';
import { auth } from '../store.js';
import { appFrame, mountTabBar } from '../chrome.js';
import { currentLedger, invalidateSession, loadSession } from '../session.js';
import {
  applyFieldErrors,
  avatarHtml,
  clearFieldErrors,
  esc,
  formatDate,
  formatDateTime,
  h,
  icon,
  LEDGER_TYPE_LABEL,
  lucide,
  ROLE_LABEL,
  setLoading,
  toast,
} from '../ui.js';

/* ------------------------------------------------------------------ *
 * 账本名称校验（前端即时反馈；服务端为唯一性兜底，见 ledgers/service.ts）
 * ------------------------------------------------------------------ */

/** 名称长度上限，与后端 `updateLedgerSchema` / `createLedgerSchema` 的 max(40) 同源 */
const LEDGER_NAME_MAX = 40;

/**
 * 清洗账本名：去掉控制字符与 CSV/表格里会被当成语法的字符。
 *
 * 为什么要过滤而不是直接拒绝：用户是**打错了**不是想攻击，
 * 直接报错会逼他猜哪个字符非法；自动清掉再说一句「已去掉非法字符」更好。
 *
 * ⚠️ 前导 `= + - @` 必须处理 —— 导出成 CSV 后这些前缀会被
 *    Excel / WPS 当成**公式**执行（CSV 注入），金额列尤其危险。
 */
function sanitizeLedgerName(raw) {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .replace(/^\s*([=+\-@])/, '$1') // 只去掉前导的公式触发符，保留中间的连字符
    .trim();
}

/** 返回错误文案；通过则返回 null */
function validateLedgerName(raw, others) {
  const cleaned = sanitizeLedgerName(raw);
  if (!cleaned) return '账本名不能为空';
  if (raw.trim() && raw.trim() !== cleaned) return '名称里有非法字符（<> 或控制字符），已自动去掉，确认后保存';
  if (cleaned.length > LEDGER_NAME_MAX) return `账本名最多 ${LEDGER_NAME_MAX} 字，当前 ${cleaned.length} 字`;
  const dup = (others ?? []).some((o) => String(o.name ?? '').trim() === cleaned);
  if (dup) return '已经有同名账本了，换一个名字';
  return null;
}
import { effective, getMode, MODE_LABEL, onChange, setMode, THEME_OPTIONS } from '../theme.js';

/**
 * 账本可选图标。
 *
 * ⚠️ 每个名字都必须在 `lucide-data.js` 的 LUCIDE 里真实存在 ——
 * `lucide()` 缺名时**静默回退成 circle-help 问号图**（不报错、不警告），
 * 所以写错名字的后果不是崩溃，而是界面上冒出一堆问号。
 * 新增名字前先跑 `node -e "import('./public/assets/lucide-data.js').then(m=>console.log(!!m.LUCIDE['名字']))"`。
 */
const LEDGER_ICON_OPTIONS = [
  'wallet',
  'credit-card',
  'piggy-bank',
  'building-2',
  'landmark',
  'briefcase',
  'plane',
  'utensils',
  'shopping-bag',
  'gift',
  'heart',
  'users',
  'baby',
  'paw-print',
  'graduation-cap',
  'receipt',
];

/** 账本图标：用户挑过就用他挑的，没挑过按账本类型回退（**不回退成问号图**） */
function ledgerIconHtml(l, size = 18) {
  const name = l.icon || (l.type === 'shared' ? 'users' : 'wallet');
  return `<span class="ledger-card__icon">${lucide(name, size)}</span>`;
}
/**
 * 账本卡片的「操作」行与「切换」职责分开。
 *
 * ⚠️ 整卡是 `<button>` 时**不能**把「编辑 / 删除」塞进去 ——
 * HTML 不允许按钮嵌套按钮，浏览器会把内层的 `<button>` 提到外面，
 * 结果 DOM 结构和写的不一样：样式错位、点击目标互相吞掉，
 * 而这种问题在静态检查里完全看不出来（源码是对的，DOM 不是）。
 * 所以卡片降级为 `<article>`，切换交给内层那颗按钮。
 *
 * ## 层级（00-DESIGN）
 * 名称是卡片唯一的主标题（body-strong 17/600），下面一行是元信息（caption 14/400），
 * 最弱一行是操作提示（fine-print 12/400）—— 三层的字号、字重、颜色各差一档，
 * 扫视时眼睛先落在名称上，而不是三个同样灰的字块上。
 *
 * 图标与名称**同处一行**（`__head` 内），而不是另起一列：
 * 另起一列时图标只能垂直居中于整块内容，于是它对着的不是名称行而是「类型」行，
 * 看上去就是错位。同行后图标 24px 见方、名称行 22px，中心自然对齐。
 *
 * 「当前账本」徽标下移到元信息行：留在标题行会与名称抢横向空间
 * （卡片最窄 250px，可用宽扣掉图标后只剩 ~190px），长名字会被挤成「备…」。
 *
 * 「当前账本」时**不再**重复一行「正在用这本账记账」——
 * 徽标 + 蓝色描边 + 浅蓝底已经三处说了同一件事，再加一行就是让装饰抢戏
 * （00-DESIGN：UI recedes so the product can speak）。
 * 非当前账本仍保留「点击切换为当前账本」—— 那是**操作提示**，不是状态重复。
 */
function ledgerCard(l) {
  const canManage = l.role === 'owner' || l.role === 'admin';
  const canDelete = l.role === 'owner';
  const typeLabel = LEDGER_TYPE_LABEL[l.type] ?? l.type;
  const roleLabel = ROLE_LABEL[l.role] ?? l.role;
  return `
    <article class="ledger-card${l.isCurrent ? ' is-current' : ''}" data-ledger="${esc(l.id)}">
      <button class="ledger-card__switch" type="button" data-action="switch-ledger"
              data-id="${esc(l.id)}" data-current="${l.isCurrent}"
              title="${l.isCurrent ? '正在用这本账记账' : '点击切换为当前账本'}">
        <span class="ledger-card__main">
          <span class="ledger-card__head">
            ${ledgerIconHtml(l, 18)}
            <span class="ledger-card__name" title="${esc(l.name)}">${esc(l.name)}</span>
          </span>
          <span class="ledger-card__sub">
            <span>${esc(typeLabel)}</span>
            <span class="ledger-card__sep" aria-hidden="true">·</span>
            <span>${esc(roleLabel)}</span>
            <span class="ledger-card__sep" aria-hidden="true">·</span>
            <span>${l.memberCount} 人</span>
            ${l.isCurrent ? '<span class="ledger-card__current">当前账本</span>' : ''}
          </span>
          ${
            l.isCurrent
              ? ''
              : '<span class="ledger-card__meta">点击切换为当前账本</span>'
          }
        </span>
        <span class="ledger-card__go" aria-hidden="true"></span>
      </button>
      <div class="ledger-card__ops">
        <button class="btn btn--quiet btn--sm" type="button" data-action="edit-ledger"
                data-id="${esc(l.id)}" ${canManage ? '' : 'disabled'}>
          ${icon('edit', 14)}<span>编辑</span>
        </button>
        <button class="btn btn--quiet btn--sm is-danger" type="button" data-action="ask-delete-ledger"
                data-id="${esc(l.id)}" ${canDelete ? '' : 'disabled'}>
          ${icon('trash', 14)}<span>删除</span>
        </button>
      </div>
    </article>
  `;
}

function memberRow(m) {
  return `
    <div class="kv">
      ${avatarHtml(m, 'avatar--sm')}
      <span style="min-width:0">
        <span class="tt-body-strong" style="display:block">${esc(m.nickname)}${
          m.isActive ? '' : '（已停用）'
        }</span>
        <span class="tt-fine-print">@${esc(m.username)} · 加入于 ${esc(formatDate(m.joinedAt))}</span>
      </span>
      <span class="kv__v">
        <span class="badge${m.role === 'owner' ? ' badge--dark' : ''}">${esc(
          ROLE_LABEL[m.role] ?? m.role,
        )}</span>
      </span>
    </div>
  `;
}

async function cropSquare(file, size = 512) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  canvas
    .getContext('2d')
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function renderSettings(container, { go }) {
  const loading = appFrame({
    active: 'settings',
    inner: `<div class="card"><div class="skeleton" style="width:38%"></div>
            <div class="skeleton" style="width:62%;margin-top:14px"></div></div>`,
  });
  container.replaceChildren(loading);

  let me = null;
  try {
    me = await loadSession(true);
  } catch (err) {
    const expired = err instanceof ApiError && err.status === 401;
    if (expired || err.status === 401) auth.clear();
    const fail = appFrame({
      inner: `
        <div class="card" style="text-align:center;padding:48px 24px">
          <h1 class="tt-display-md">${expired ? '登录已过期' : '加载失败'}</h1>
          <p class="tt-lead" style="margin-top:8px">${esc(err.message)}</p>
          <button class="btn" type="button" data-action="to-login" style="margin-top:20px">重新登录</button>
        </div>`,
    });
    fail.querySelector('[data-action=to-login]').addEventListener('click', () => {
      auth.clear();
      go('/login');
    });
    container.replaceChildren(fail);
    return fail;
  }

  const current = currentLedger(me);
  let members = [];
  if (current) {
    try {
      members = (await Api.listMembers(current.id)).data;
    } catch {
      members = [];
    }
  }

  const frame = appFrame({
    active: 'settings',
    user: me,
    ledger: current,
    inner: `
      <div class="page__hero">
        <h1 class="tt-display-md">我的</h1>
        <p class="tt-caption text-muted">账号资料、账本与成员、登录安全</p>
      </div>

      <section class="card">
        <div class="row row--top row--wrap" style="gap:16px">
          ${avatarHtml(me, 'avatar--lg')}
          <div style="flex:1;min-width:180px">
            <h2 class="tt-display-md">${esc(me.nickname)}</h2>
            <p class="tt-caption text-muted" style="margin-top:4px">
              @${esc(me.username)}${me.email ? ' · ' + esc(me.email) : ''}
            </p>
            <p class="tt-fine-print" style="margin-top:6px">
              账号创建于 ${esc(formatDate(me.createdAt))}${
                me.lastLoginAt ? ' · 上次登录 ' + esc(formatDateTime(me.lastLoginAt)) : ''
              }
            </p>
          </div>
          <div class="row row--wrap">
            <label class="btn btn--pearl btn--sm" style="cursor:pointer">
              更换头像
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden data-role="avatar-input" />
            </label>
            <button class="btn btn--secondary btn--sm" type="button" data-action="edit-nickname">修改昵称</button>
          </div>
        </div>
        <div data-role="nickname-slot" style="margin-top:16px"></div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-display-md">我的账本</h2>
          <button class="btn btn--pearl btn--sm" type="button" data-action="new-ledger">新建账本</button>
        </div>
        <div data-role="create-slot"></div>
        <div class="grid-cards" data-role="ledger-grid">
          ${
            me.ledgers.length
              ? me.ledgers.map(ledgerCard).join('')
              : '<div class="card empty">还没有账本</div>'
          }
        </div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-display-md">成员与邀请</h2>
          <span class="badge">${esc(current?.name ?? '—')} · ${members.length} 人</span>
          <button class="btn btn--secondary btn--sm" type="button" data-action="join-ledger">加入他人账本</button>
          <button class="btn btn--pearl btn--sm" type="button" data-action="invite" ${
            current ? '' : 'disabled'
          }>邀请成员</button>
        </div>
        <div class="card card--flush">
          <div class="card__body" style="padding-top:18px">
            <div data-role="invite-slot"></div>
          </div>
          ${
            members.length
              ? `<div style="padding:0 var(--s-lg) 18px">${members.map(memberRow).join('')}</div>`
              : '<div class="empty">暂无成员数据</div>'
          }
        </div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-display-md">外观</h2>
          <span class="badge" data-role="theme-badge">—</span>
        </div>
        <div class="card">
          <div class="stack stack--md">
            <div class="segmented" role="radiogroup" aria-label="主题模式" data-role="theme-seg">
              ${THEME_OPTIONS.map(
                (o) => `
                <button class="segmented__item" type="button" role="radio" aria-checked="false"
                        data-theme-value="${esc(o.value)}">
                  ${lucide(o.icon, 15)}<span>${esc(o.label)}</span>
                </button>`,
              ).join('')}
            </div>
            <p class="tt-caption text-muted" data-role="theme-hint"></p>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="tt-display-md">安全</h2>
          <span class="section__hint">修改密码后，所有设备都需要重新登录</span>
        </div>
        <div class="card">
          <form data-role="password-form" novalidate class="stack stack--md form-narrow">
            <div class="field" data-field="oldPassword">
              <label class="field__label">原密码</label>
              <input class="input" type="password" name="oldPassword" autocomplete="current-password" />
              <span class="field__error"></span>
            </div>
            <div class="field" data-field="newPassword">
              <label class="field__label">新密码</label>
              <input class="input" type="password" name="newPassword" autocomplete="new-password"
                     placeholder="至少 8 位，含字母与数字" />
              <span class="field__error"></span>
            </div>
            <div class="row">
              <button class="btn" type="submit">修改密码</button>
              <button class="btn btn--danger btn--sm" type="button" data-action="logout" style="height:44px">
                退出登录
              </button>
            </div>
          </form>
        </div>
      </section>
    `,
  });
  mountTabBar(frame, { active: 'settings', go });
  container.replaceChildren(frame);

  const rerender = () => {
    invalidateSession();
    go('/settings', { replace: true });
  };

  /* ---------------- 退出 ---------------- */
  frame.querySelectorAll('[data-action=logout]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!window.confirm('确认退出登录？')) return;
      try {
        await Api.logout({ allDevices: false });
      } catch {
        /* 网络异常也照样本地退出 */
      }
      auth.clear();
      invalidateSession();
      toast('已退出登录');
      go('/login', { replace: true });
    }),
  );

  /* ---------------- 切换账本 ---------------- */
  frame.querySelectorAll('[data-action=switch-ledger]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.dataset.current === 'true') return;
      try {
        await Api.setCurrentLedger(btn.dataset.id);
        toast('已切换当前账本', 'success');
        rerender();
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );

  /* ---------------- 新建账本 ---------------- */
  const renderCreateForm = () => {
    const slot = frame.querySelector('[data-role=create-slot]');
    const form = h(`
      <div class="card">
        <form novalidate class="stack stack--md">
          <div class="field" data-field="name">
            <label class="field__label">账本名称</label>
            <input class="input" name="name" placeholder="例如：家庭共同账本" />
            <span class="field__error"></span>
          </div>
          <div>
            <span class="field__label">账本类型</span>
            <div class="chip-row" role="radiogroup" aria-label="账本类型" style="margin-top:8px">
              <button class="chip" type="button" role="radio" aria-checked="true" data-value="shared">
                共同账本<span class="chip__sub">邀请家人一起记</span>
              </button>
              <button class="chip" type="button" role="radio" aria-checked="false" data-value="personal">
                个人账本<span class="chip__sub">只给自己看</span>
              </button>
            </div>
          </div>
          <div class="row">
            <button class="btn btn--sm" type="submit">创建</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          </div>
        </form>
      </div>
    `);
    form.querySelectorAll('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        form.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
      }),
    );
    form.querySelector('[data-role=cancel]').addEventListener('click', () => slot.replaceChildren());
    form.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = f.querySelector('button[type=submit]');
      clearFieldErrors(f);
      setLoading(submit, true, '创建中');
      try {
        const res = await Api.createLedger({
          name: f.name.value.trim(),
          type: form.querySelector('.chip[aria-checked=true]').dataset.value,
          currency: 'CNY',
        });
        toast(`账本「${res.data.name}」已创建`, 'success');
        rerender();
      } catch (err) {
        applyFieldErrors(f, err.fieldErrors ?? {});
        if (!err.details?.length) toast(err.message, 'error');
      } finally {
        setLoading(submit, false);
      }
    });
    slot.replaceChildren(form);
    form.querySelector('input[name=name]').focus();
  };

  frame.querySelector('[data-action=new-ledger]')?.addEventListener('click', () => {
    const slot = frame.querySelector('[data-role=create-slot]');
    if (slot.firstElementChild) {
      slot.replaceChildren();
      return;
    }
    renderCreateForm();
    slot.scrollIntoView({ block: 'nearest' });
  });

  /* ---------------- 账本：编辑 / 删除（仅 owner/admin 可编辑，仅 owner 可删除） ---------------- */
  const byId = (id) => (me.ledgers ?? []).find((x) => x.id === id) ?? null;
  frame.querySelectorAll('[data-action=edit-ledger]').forEach((btn) =>
    btn.addEventListener('click', () => openLedgerEdit(byId(btn.dataset.id))),
  );
  frame.querySelectorAll('[data-action=ask-delete-ledger]').forEach((btn) =>
    btn.addEventListener('click', () => {
      openLedgerDelete(byId(btn.dataset.id));
    }),
  );

  /* ---------------- 邀请 ---------------- */
  frame.querySelectorAll('[data-action=join-ledger]').forEach((btn) =>
    btn.addEventListener('click', () => openJoinLedger()),
  );

  frame.querySelector('[data-action=invite]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true, '生成中');
    try {
      const res = await Api.createInvitation(current.id, {
        role: 'member',
        maxUses: 1,
        expiresInHours: 24,
      });
      const { code, inviteUrl, expiresAt } = res.data;
      const panel = h(`
        <div class="stack stack--sm">
          <p class="tt-caption text-muted">把这个邀请码或链接发给家人，24 小时内有效</p>
          <p class="code-display">${esc(code)}</p>
          <div class="row row--wrap">
            <button class="btn btn--sm" type="button" data-role="copy-code">复制邀请码</button>
            <button class="btn btn--secondary btn--sm" type="button" data-role="copy-link">复制邀请链接</button>
          </div>
          <p class="tt-fine-print">有效期至 ${esc(formatDateTime(expiresAt))} · 链接：${esc(inviteUrl)}</p>
        </div>
      `);
      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制到剪贴板', 'success');
        } catch {
          window.prompt('请手动复制：', text);
        }
      };
      panel.querySelector('[data-role=copy-code]').addEventListener('click', () => copy(code));
      panel.querySelector('[data-role=copy-link]').addEventListener('click', () => copy(inviteUrl));
      const slot = frame.querySelector('[data-role=invite-slot]');
      slot.replaceChildren(panel);
      slot.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  /* ---------------- 改昵称 ---------------- */
  frame.querySelector('[data-action=edit-nickname]')?.addEventListener('click', () => {
    const slot = frame.querySelector('[data-role=nickname-slot]');
    if (slot.firstElementChild) {
      slot.replaceChildren();
      return;
    }
    const form = h(`
      <form novalidate class="row row--wrap row--top">
        <div class="field" data-field="nickname" style="flex:1;min-width:180px">
          <input class="input" name="nickname" value="${esc(me.nickname)}" />
          <span class="field__error"></span>
        </div>
        <button class="btn btn--sm" type="submit">保存</button>
        <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
      </form>
    `);
    form.querySelector('[data-role=cancel]').addEventListener('click', () => slot.replaceChildren());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors(form);
      try {
        await Api.updateProfile({ nickname: form.nickname.value.trim() });
        toast('昵称已更新', 'success');
        rerender();
      } catch (err) {
        applyFieldErrors(form, err.fieldErrors ?? {});
        if (!err.details?.length) toast(err.message, 'error');
      }
    });
    slot.replaceChildren(form);
    form.querySelector('input').focus();
  });

  /* ---------------- 头像 ---------------- */
  frame.querySelector('[data-role=avatar-input]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('请选择 8MB 以内的图片', 'error');
      return;
    }
    try {
      toast('正在处理图片…');
      const blob = await cropSquare(file, 512);
      if (!blob) throw new Error('图片处理失败');
      const form = new FormData();
      form.append('file', blob, 'avatar.png');
      await Api.upload('/users/me/avatar', form);
      toast('头像已更新', 'success');
      rerender();
    } catch (err) {
      toast(err.message ?? '头像上传失败', 'error');
    }
  });

  /* ---------------- 改密码 ---------------- */
  const pwdForm = frame.querySelector('[data-role=password-form]');
  pwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(pwdForm);
    const submit = pwdForm.querySelector('button[type=submit]');
    setLoading(submit, true, '提交中');
    try {
      await Api.changePassword({
        oldPassword: pwdForm.oldPassword.value,
        newPassword: pwdForm.newPassword.value,
      });
      toast('密码已修改，请重新登录', 'success');
      auth.clear();
      invalidateSession();
      go('/login', { replace: true });
    } catch (err) {
      applyFieldErrors(pwdForm, err.fieldErrors ?? {});
      if (!err.details?.length) toast(err.message, 'error');
    } finally {
      setLoading(submit, false);
    }
  });

  /* ---------------- 账本：编辑 / 删除 ----------------
     弹窗复用交易表单那套 `.modal / .modal__panel` 结构，只是内容换成账本字段，
     不引入任何新的弹窗库。 */

  /**
   * 挂载一个弹窗并返回 `close()`。
   *
   * ⚠️ 焦点在关闭时要**主动交还**给触发它的按钮 —— 否则屏幕阅读器用户
   *    关闭弹窗后焦点掉回 <body>，得从头 tab 一遍才能回到刚才的位置。
   *    这是个看不出来但对键盘用户是硬伤的细节。
   */
  function openModal({ title, bodyHtml, footHtml, onMount }) {
    const back = document.activeElement;
    const close = () => {
      view.remove();
      document.removeEventListener('keydown', onKey);
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    const view = h(`
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ledger-modal-title">
        <div class="modal__scrim" data-role="modal-scrim"></div>
        <div class="modal__panel">
          <div class="modal__head">
            <h2 class="modal__title" id="ledger-modal-title">${esc(title)}</h2>
            <button class="btn btn--quiet btn--icon" type="button" data-role="modal-x"
                    aria-label="关闭">${icon('close', 18)}</button>
          </div>
          <div class="modal__body">${bodyHtml}</div>
          <div class="modal__foot">${footHtml}</div>
        </div>
      </div>
    `);
    view.querySelector('[data-role=modal-scrim]').addEventListener('click', close);
    view.querySelector('[data-role=modal-x]').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(view);
    onMount?.(view, close);
    return close;
  }

  /** 账本编辑弹窗：名称 / 图标 / 备注，错误挂在各自字段下方 */
  function openLedgerEdit(ledger) {
    if (!ledger) return;
    const others = (me.ledgers ?? []).filter((x) => x.id !== ledger.id);
    openModal({
      title: `编辑账本「${ledger.name}」`,
      bodyHtml: `
        <form novalidate class="stack stack--md" data-role="ledger-form">
          <div class="field" data-field="name">
            <label class="field__label" for="lg-name">账本名称 *</label>
            <input class="input" id="lg-name" name="name" maxlength="${LEDGER_NAME_MAX}"
                   value="${esc(ledger.name)}" autocomplete="off" />
            <span class="field__hint">最多 ${LEDGER_NAME_MAX} 字；< > 等字符会被自动去掉</span>
            <span class="field__error"></span>
          </div>
          <div class="field" data-field="icon">
            <span class="field__label">图标</span>
            <div class="chip-row" role="radiogroup" aria-label="账本图标">
              ${LEDGER_ICON_OPTIONS.map(
                (n) => `
                <button class="chip chip--icon" type="button" role="radio"
                        aria-checked="${(ledger.icon || (ledger.type === 'shared' ? 'users' : 'wallet')) === n}"
                        data-icon="${esc(n)}" title="${esc(n)}">
                  ${lucide(n, 16)}
                </button>`,
              ).join('')}
            </div>
            <span class="field__hint">不挑就用「${esc(
                ledger.type === 'shared' ? '共同账本' : '个人账本',
              )}」的默认图标</span>
            <span class="field__error"></span>
          </div>
          <div class="field" data-field="note">
            <label class="field__label" for="lg-note">备注</label>
            <textarea class="input" id="lg-note" name="note" rows="3" maxlength="140"
                      placeholder="这本账用来记什么">${esc(ledger.note ?? '')}</textarea>
            <span class="field__hint">最多 140 字，可选</span>
            <span class="field__error"></span>
          </div>
        </form>`,
      footHtml: `
        <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
        <button class="btn btn--sm" type="button" data-role="save">保存</button>`,
      onMount(view, close) {
        const form = view.querySelector('[data-role=ledger-form]');
        const nameInput = form.elements.name;
        let picked = ledger.icon || '';

        view.querySelector('[data-role=cancel]').addEventListener('click', close);

        /** 即时校验：只在「用户已输入过内容之后」提示，避免一打开就红一片 */
        const check = () => {
          clearFieldErrors(form);
          const err = validateLedgerName(nameInput.value, others);
          if (err && nameInput.value.trim()) applyFieldErrors(form, { name: err });
          return !err || !nameInput.value.trim();
        };
        nameInput.addEventListener('input', () => {
          nameInput.value = sanitizeLedgerName(nameInput.value);
          check();
        });

        form.querySelectorAll('[data-icon]').forEach((chip) =>
          chip.addEventListener('click', () => {
            const next = chip.dataset.icon;
            picked = picked === next ? '' : next;
            form.querySelectorAll('[data-icon]').forEach((c) =>
              c.setAttribute('aria-checked', String(c.dataset.icon === picked)),
            );
          }),
        );

        view.querySelector('[data-role=save]').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          clearFieldErrors(form);
          const err = validateLedgerName(nameInput.value, others);
          if (!nameInput.value.trim() || err) {
            applyFieldErrors(form, { name: err ?? '账本名不能为空' });
            nameInput.focus();
            return;
          }
          setLoading(btn, true, '保存中');
          try {
            await Api.updateLedger(ledger.id, {
              name: sanitizeLedgerName(nameInput.value),
              icon: picked || null,
              note: form.elements.note.value.trim() || null,
            });
            toast('账本信息已更新', 'success');
            close();
            rerender();
          } catch (err) {
            applyFieldErrors(form, err.fieldErrors ?? {});
            if (!err.details?.length) toast(err.message, 'error');
          } finally {
            setLoading(btn, false);
          }
        });

        nameInput.focus();
        nameInput.select();
      },
    });
  }

  /**
   * 删除确认弹窗。
   *
   * 按钮上方必须给出**真实代价**：先向服务端要一次影响统计，
   * 把「会带走 N 笔账目 / M 位成员」摆出来。
   * 统计拿不到时**不给删** —— 宁可让用户多走一步，
   * 也不能在他没看见代价的地方放一个不可逆按钮。
   */
  async function openLedgerDelete(ledger) {
    if (!ledger) return;
    let impact = null;
    let loadErr = null;
    try {
      impact = (await Api.ledgerDeletionImpact(ledger.id)).data;
    } catch (err) {
      loadErr = err;
    }

    if (!impact) {
      openModal({
        title: '暂时不能删除',
        bodyHtml: `<p class="tt-caption">没能统计出这个账本下的数据量，为避免误删，已取消删除。</p>
                  <p class="tt-fine-print text-muted">${esc(loadErr?.message ?? '未知错误')}</p>`,
        footHtml: `<button class="btn btn--sm" type="button" data-role="ok">知道了</button>`,
        onMount(view, close) {
          view.querySelector('[data-role=ok]').addEventListener('click', close);
        },
      });
      return;
    }

    const rows = [
      ['账目', impact.counts.transactions],
      ['成员', impact.counts.members],
      ['账户', impact.counts.accounts],
      ['分类', impact.counts.categories],
      ['预算', impact.counts.budgets],
      ['周期账单', impact.counts.recurring],
      ['分期计划', impact.counts.installments],
      ['常用模板', impact.counts.templates],
      ['待处理邀请', impact.counts.invitations],
      ['对账记录', impact.counts.reconciliations],
    ].filter(([, n]) => Number(n) > 0);

    openModal({
      title: `删除账本「${ledger.name}」`,
      bodyHtml: `
        <p class="tt-caption is-neg">
          删除后，这个账本下的<b>全部数据会被一并永久删除，且无法恢复</b>。
        </p>
        ${
          rows.length
            ? `<div class="purge-list" data-role="purge-list">
                 ${rows.map(([k, n]) => `<div class="recon-line"><span class="tt-caption">${esc(k)}</span><span class="tt-caption tnum">${esc(String(n))}</span></div>`).join('')}
               </div>`
            : '<p class="tt-fine-print text-muted">这个账本下还没有数据。</p>'
        }
        ${
          impact.isCurrent
            ? '<p class="tt-fine-print text-muted">这是你当前正在用的账本，删除后会自动切到另一个账本。</p>'
            : ''
        }
        ${
          impact.counts.members > 1
            ? `<p class="tt-fine-print is-neg">这本账还有另外 ${impact.counts.members - 1} 位成员，删除会同时移除他们的访问权限。</p>`
            : ''
        }
        <label class="row row--sm" style="align-items:center;gap:6px">
          <input type="checkbox" data-role="ack" />
          <span class="tt-caption">我已了解，删除后无法恢复</span>
        </label>`,
      footHtml: `
        <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
        <button class="btn btn--danger btn--sm" type="button" data-role="confirm" disabled>确认删除</button>`,
      onMount(view, close) {
        const ack = view.querySelector('[data-role=ack]');
        const confirmBtn = view.querySelector('[data-role=confirm]');
        // 勾了「了解后果」才解锁删除键 —— 让不可逆动作前多一道必须手动完成的门。
        ack.addEventListener('change', () => {
          confirmBtn.disabled = !ack.checked;
        });
        view.querySelector('[data-role=cancel]').addEventListener('click', close);
        confirmBtn.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          setLoading(btn, true, '删除中');
          try {
            await Api.purgeLedger(ledger.id);
            toast(`账本「${ledger.name}」已删除`, 'success');
            close();
            rerender();
          } catch (err) {
            toast(err.message ?? '删除失败', 'error');
          } finally {
            setLoading(btn, false);
          }
        });
      },
    });
  }

  /* ---------------- 加入他人账本 ----------------
     两条路：邀请码直接预览 → 确认页；粘贴链接 → 解析出 code 跳 /invite/code。 */
  function openJoinLedger() {
    openModal({
      title: '加入他人账本',
      bodyHtml: `
        <form novalidate class="stack stack--md" data-role="join-form">
          <div class="segmented" role="radiogroup" aria-label="加入方式" data-role="join-mode">
            <button class="segmented__item" type="button" role="radio" aria-checked="true" data-mode="code">
              邀请码
            </button>
            <button class="segmented__item" type="button" role="radio" aria-checked="false" data-mode="link">
              邀请链接
            </button>
          </div>

          <div class="field" data-field="code">
            <label class="field__label" for="jn-code">邀请码 *</label>
            <input class="input" id="jn-code" name="code" maxlength="6"
                   placeholder="6 位邀请码" autocomplete="off" />
            <span class="field__hint">向账本所有者索取，大小写不敏感</span>
            <span class="field__error"></span>
          </div>

          <div class="field" data-field="link" hidden>
            <label class="field__label" for="jn-link">邀请链接</label>
            <input class="input" id="jn-link" name="link" placeholder="粘贴收到的邀请链接" autocomplete="off" />
            <span class="field__hint">粘贴后会跳转到加入确认页</span>
            <span class="field__error"></span>
          </div>

          <div data-role="join-preview"></div>

          <div class="row row--wrap">
            <button class="btn btn--sm" type="submit">下一步</button>
            <button class="btn btn--quiet btn--sm" type="button" data-role="cancel">取消</button>
          </div>
        </form>`,
      footHtml: '',
      onMount(view, close) {
        const form = view.querySelector('[data-role=join-form]');
        const codeField = form.querySelector('[data-field=code]');
        const linkField = form.querySelector('[data-field=link]');
        const codeInput = form.elements.code;
        const linkInput = form.elements.link;
        const slot = view.querySelector('[data-role=join-preview]');
        let mode = 'code';

        view.querySelector('[data-role=cancel]').addEventListener('click', close);

        form.querySelectorAll('[data-mode]').forEach((btn) =>
          btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            form.querySelectorAll('[data-mode]').forEach((b) =>
              b.setAttribute('aria-checked', String(b === btn)),
            );
            codeField.hidden = mode !== 'code';
            linkField.hidden = mode !== 'link';
            slot.replaceChildren();
            clearFieldErrors(form);
            (mode === 'code' ? codeInput : linkInput).focus();
          }),
        );

        codeInput.addEventListener('input', () => {
          // 邀请码只可能是字母+数字，顺手在输入时收敛，避免格式错误一路带到服务端
          codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        });

        const fail = (field, msg) => {
          clearFieldErrors(form);
          applyFieldErrors(form, { [field]: msg });
        };

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          clearFieldErrors(form);
          const submit = form.querySelector('button[type=submit]');

          if (mode === 'code') {
            const raw = codeInput.value.trim();
            if (!raw) return fail('code', '请输入邀请码');
            if (!/^[A-Z0-9]{6}$/.test(raw)) return fail('code', '邀请码是 6 位字母或数字');
            setLoading(submit, true, '校验中');
            try {
              const data = (await Api.previewInvitation(raw)).data;
              renderJoinConfirm(slot, data, raw, close);
            } catch (err) {
              const status = err?.status ?? 0;
              const msg =
                status === 404
                  ? '邀请码不存在或已失效'
                  : status === 410 || /过期|失效|撤销|用完/.test(err.message ?? '')
                    ? err.message
                    : err.message || '邀请码校验失败';
              fail('code', msg);
              toast(msg, 'error');
            } finally {
              setLoading(submit, false);
            }
            return;
          }

          /** 链接方式：从整串 URL 里认出 code，再交给落地页 */
          const raw = linkInput.value.trim();
          if (!raw) return fail('link', '请输入或粘贴邀请链接');
          const code = extractInviteCode(raw);
          if (!code) return fail('link', '链接格式不对，请复制完整的邀请链接');
          close();
          go(`/invite/${code}`);
        });
      },
    });
  }

  /**
   * 从邀请链接里取出邀请码。
   *
   * 用户粘贴进来的东西五花八门：完整 URL、只有路径、带别的查询参数、
   * 甚至直接就是 6 位邀请码。逐一兼容，比让他再去剪一次链接强。
   */
  function extractInviteCode(raw) {
    const s = String(raw ?? '').trim();
    if (/^[A-Z0-9]{6}$/i.test(s)) return s.toUpperCase();
    const m = s.match(/\/invite\/([A-Za-z0-9]{4,12})/) || s.match(/[?&](?:code|invite)=([A-Za-z0-9]{4,12})/);
    return m ? m[1].toUpperCase() : null;
  }

  /** 加入确认卡片：账本名 + 邀请人，供确认 / 取消 */
  function renderJoinConfirm(slot, data, code, closeModal) {
    const inviter = data.inviter;
    const card = h(`
      <div class="card card--soft" data-role="join-confirm">
        <div class="row" style="gap:10px">
          ${inviter ? avatarHtml(inviter) : '<span class="avatar avatar--sm">·</span>'}
          <span style="min-width:0">
            <span class="tt-body-strong" style="display:block">${esc(inviter?.nickname ?? '某位用户')}</span>
            <span class="tt-fine-print">邀请你加入账本「${esc(data.ledger?.name ?? '—')}」</span>
          </span>
        </div>
        <p class="tt-fine-print text-muted" style="margin-top:8px">
          加入后你的角色为「${esc(ROLE_LABEL[data.role] ?? data.role)}」${
            data.expiresAt ? ` · 邀请有效期至 ${esc(formatDateTime(data.expiresAt))}` : ''
          }
        </p>
        <div class="row row--wrap" style="margin-top:12px">
          <button class="btn btn--sm" type="button" data-role="do-join">确认加入</button>
          <button class="btn btn--quiet btn--sm" type="button" data-role="back">取消</button>
        </div>
      </div>
    `);
    card.querySelector('[data-role=back]').addEventListener('click', () => slot.replaceChildren());
    card.querySelector('[data-role=do-join]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setLoading(btn, true, '加入中');
      try {
        const res = await Api.redeemInvitation(code);
        toast(
          res.data.alreadyMember
            ? `你已经是「${res.data.ledger?.name ?? ''}」的成员，已为你切换过去`
            : `已加入「${res.data.ledger?.name ?? ''}」`,
          'success',
        );
      } catch (err) {
        toast(err?.message ?? '加入失败', 'error');
      } finally {
        setLoading(btn, false);
      }
    });
    slot.replaceChildren(card);
    card.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- 外观（主题三态） ----------------
     切换只改 <html data-theme> 与 CSS 变量，即时生效、不重渲染页面
     （重渲染会打断滚动位置，也会闪一下骨架）。 */
  const themeSeg = frame.querySelector('[data-role=theme-seg]');
  const themeHint = frame.querySelector('[data-role=theme-hint]');
  const themeBadge = frame.querySelector('[data-role=theme-badge]');

  const paintTheme = () => {
    const mode = getMode();
    const theme = effective(mode);
    themeSeg.querySelectorAll('[data-theme-value]').forEach((btn) =>
      btn.setAttribute('aria-checked', String(btn.dataset.themeValue === mode)),
    );
    themeBadge.textContent = `当前：${MODE_LABEL[theme]}`;
    themeHint.textContent =
      mode === 'auto'
        ? `跟随系统设置，系统当前为「${MODE_LABEL[theme]}」；系统切到深色时界面自动跟随。`
        : `始终使用${MODE_LABEL[theme]}配色，不随系统切换。`;
  };

  themeSeg.querySelectorAll('[data-theme-value]').forEach((btn) =>
    btn.addEventListener('click', () => {
      setMode(btn.dataset.themeValue);
      paintTheme();
    }),
  );
  paintTheme();

  // 自动模式下系统切换主题时同步控件文案；页面离开后自动退订，避免监听堆积。
  const offTheme = onChange(() => {
    if (!frame.isConnected) {
      offTheme();
      return;
    }
    paintTheme();
  });

  return frame;
}
