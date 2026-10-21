/**
 * 邀请码落地页（docs/04 §4.6）——未登录可预览，登录后一键加入。
 * 简洁版：整页一张居中卡片。
 */
import { Api, ApiError } from '../api.js';
import { auth } from '../store.js';
import { siteFooter, topBar } from '../chrome.js';
import { avatarHtml, esc, formatDateTime, h, LEDGER_TYPE_LABEL, ROLE_LABEL, setLoading, toast } from '../ui.js';

const INVALID_REASON = {
  expired: '该邀请码已过期',
  exhausted: '该邀请码使用次数已用完',
  revoked: '该邀请码已被撤销',
};

function shell(cardInner) {
  const view = h(`
    <div>
      <div data-role="nav-slot"></div>
      <main class="invite-main">
        <div class="invite-card">${cardInner}</div>
      </main>
      <div data-role="footer-slot"></div>
    </div>
  `);
  // 未登录时 topBar 自动渲染「登录」按钮；已登录时渲染用户胶囊（可进「我的」）
  view.querySelector('[data-role=nav-slot]').replaceWith(topBar({ user: auth.me }));
  view.querySelector('[data-role=footer-slot]').replaceWith(siteFooter());
  return view;
}

export async function renderInvite(container, { code, go }) {
  container.replaceChildren(
    shell('<p class="tt-caption text-muted" style="text-align:center">正在校验邀请码…</p>'),
  );

  let data;
  try {
    data = (await Api.previewInvitation(code)).data;
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : '网络异常，请稍后重试';
    const view = shell(`
      <div style="text-align:center">
        <h1 class="tt-display-md">邀请链接已失效</h1>
        <p class="tt-lead" style="margin-top:8px">${esc(msg)}</p>
        <button class="btn" type="button" data-role="home" style="margin-top:20px">回到首页</button>
      </div>
    `);
    view.querySelector('[data-role=home]').addEventListener('click', () => go('/'));
    container.replaceChildren(view);
    return view;
  }

  const inviterName = data.inviter?.nickname ?? '某位用户';
  const roleLabel = ROLE_LABEL[data.role] ?? data.role;
  const ledgerName = data.ledger?.name ?? '—';

  const view = shell(`
    <div class="stack" style="gap:20px">
      <div class="row" style="gap:10px">
        ${data.inviter ? avatarHtml(data.inviter) : '<span class="avatar">·</span>'}
        <span>
          <span class="tt-body-strong" style="display:block">${esc(inviterName)}</span>
          <span class="tt-fine-print">邀请你一起记账</span>
        </span>
      </div>

      <div>
        <h1 class="tt-display-md">「${esc(ledgerName)}」</h1>
        <p class="tt-caption text-muted" style="margin-top:6px">
          ${esc(LEDGER_TYPE_LABEL[data.ledger?.type] ?? '')} · 当前 ${data.memberCount} 位成员 · 加入后你将成为${esc(roleLabel)}
        </p>
      </div>

      <p class="code-display">${esc(data.code)}</p>

      ${
        data.valid
          ? `<p class="tt-fine-print">
               有效期至 ${esc(formatDateTime(data.expiresAt))}${
                 data.remainingUses === null ? ' · 使用次数不限' : ` · 剩余 ${data.remainingUses} 次`
               }
             </p>`
          : `<p class="tt-caption" style="color:var(--c-danger)">${esc(
              INVALID_REASON[data.reason] ?? '该邀请码当前不可用',
            )}</p>`
      }

      <div data-role="actions"></div>
    </div>
  `);

  const actions = view.querySelector('[data-role=actions]');

  if (!data.valid) {
    const btn = h('<button class="btn btn--secondary btn--block" type="button">回到首页</button>');
    btn.addEventListener('click', () => go('/'));
    actions.replaceChildren(btn);
  } else if (auth.isLoggedIn) {
    const btn = h(`<button class="btn btn--block" type="button">加入「${esc(ledgerName)}」</button>`);
    btn.addEventListener('click', async () => {
      setLoading(btn, true, '加入中');
      try {
        const res = await Api.redeemInvitation(data.code);
        toast(
          res.data.alreadyMember ? '你已经是该账本成员，已为你切换' : `已加入「${res.data.ledger.name}」`,
          'success',
        );
        go('/');
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '加入失败', 'error');
        setLoading(btn, false);
      }
    });
    actions.replaceChildren(btn);
  } else {
    const btn = h('<button class="btn btn--block" type="button">登录 / 注册后加入</button>');
    btn.addEventListener('click', () => go(`/login?next=${encodeURIComponent(`/invite/${data.code}`)}`));
    actions.replaceChildren(btn);
  }

  container.replaceChildren(view);
  return view;
}
