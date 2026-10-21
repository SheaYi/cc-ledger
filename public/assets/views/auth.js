/**
 * 认证页（登录 / 注册）——简洁版。
 * 一张居中卡片：左侧深色品牌面板（标题 + 三条要点），右侧表单。
 * 手机上左栏收起，只在表单顶部保留小标识。
 */
import { Api, ApiError } from '../api.js';
import { auth } from '../store.js';
import { siteFooter } from '../chrome.js';
import { applyFieldErrors, clearFieldErrors, esc, h, icon, setLoading, toast } from '../ui.js';

const COPY = {
  login: {
    title: '欢迎回来',
    sub: '用用户名、邮箱或手机号进入你的账本',
    headline: '把每一笔都记得明明白白',
    lead: '多人协作 · 精确到分 · 每一笔都能对账',
    submit: '登录',
  },
  register: {
    title: '创建账号',
    sub: '注册后自动为你生成第一个账本',
    headline: '三十秒，建一本属于自己的账',
    lead: '常用分类与账户已预置，开箱即可开始记账',
    submit: '创建账号',
  },
};

const POINTS = [
  { icon: 'users', title: '一间屋子，一本账', body: '邀请家人加入同一本账，各记各的，合起来是一本完整流水。' },
  { icon: 'split', title: '分摊与债权债务', body: '多人分摊后没还的部分自动记成债权或债务，不用手工追踪。' },
  { icon: 'check', title: '记完就能对账', body: '每个账户都有余额公式与期初机制，账面永远和现实对得上。' },
];

function aside() {
  return `
    <aside class="auth-card__aside">
      <span class="brand">
        <span class="brand__tile">CC</span>
        <span class="brand__name">CC记账</span>
      </span>
      <div>
        <h1 class="auth-card__headline">把每一笔都记得明明白白</h1>
        <p class="auth-card__lead">多人协作 · 精确到分 · 每一笔都能对账</p>
      </div>
      <div class="auth-points">
        ${POINTS.map(
          (p) => `
          <div class="auth-point">
            <span class="auth-point__icon">${icon(p.icon, 16)}</span>
            <span>
              <span class="auth-point__title">${esc(p.title)}</span>
              <span class="auth-point__body" style="display:block">${esc(p.body)}</span>
            </span>
          </div>`,
        ).join('')}
      </div>
      <p class="auth-card__legal">数据存放于你自己的 NAS · 金额一律以整数「分」存储</p>
    </aside>
  `;
}

function buildPage(mode, formHtml) {
  const copy = COPY[mode];
  const view = h(`
    <div class="auth-page">
      <div class="auth-page__main">
        <div class="auth-card">
          ${aside()}
          <div class="auth-card__form">
            <span class="brand auth-brand-sm">
              <span class="brand__tile">CC</span>
              <span class="brand__name">CC记账</span>
            </span>
            <form novalidate class="stack stack--md">
              <div>
                <h2 class="auth-card__title">${esc(copy.title)}</h2>
                <p class="auth-card__sub">${esc(copy.sub)}</p>
              </div>
              <div class="alert" role="alert"></div>
              ${formHtml}
              <button class="btn btn--block" type="submit">${esc(copy.submit)}</button>
            </form>
            <p class="auth-switch">
              ${
                mode === 'login'
                  ? '还没有账号？<a class="link" href="/register" data-link>三十秒创建一本账</a>'
                  : '已经有账号了？<a class="link" href="/login" data-link>直接登录</a>'
              }
            </p>
          </div>
        </div>
      </div>
      <div data-role="footer-slot"></div>
    </div>
  `);
  view.querySelector('[data-role=footer-slot]').replaceWith(siteFooter());
  return view;
}

/** 统一绑定提交逻辑：错误按字段回落 + 顶部 alert */
function wireSubmit(view, form, onSubmit, loadingText) {
  const alertBox = view.querySelector('.alert');
  const submit = form.querySelector('button[type=submit]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    alertBox.dataset.visible = 'false';
    setLoading(submit, true, loadingText);
    try {
      await onSubmit();
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) applyFieldErrors(form, err.fieldErrors);
      alertBox.textContent = err instanceof ApiError ? err.message : '网络异常，请稍后重试';
      alertBox.dataset.visible = 'true';
    } finally {
      setLoading(submit, false);
    }
  });
}

/* ---------------- 登录 ---------------- */
export function renderLogin(container, { onSuccess }) {
  const view = buildPage(
    'login',
    `
      <div class="field" data-field="identifier">
        <label class="field__label" for="identifier">账号</label>
        <input class="input" id="identifier" name="identifier" autocomplete="username" placeholder="用户名 / 邮箱 / 手机号" />
        <span class="field__error"></span>
      </div>
      <div class="field" data-field="password">
        <label class="field__label" for="password">密码</label>
        <input class="input" id="password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" />
        <span class="field__error"></span>
      </div>
    `,
  );

  const form = view.querySelector('form');
  wireSubmit(
    view,
    form,
    async () => {
      const res = await Api.login({
        identifier: form.identifier.value.trim(),
        password: form.password.value,
      });
      auth.save(res.data);
      onSuccess(res.data);
    },
    '登录中',
  );

  container.replaceChildren(view);
  return view;
}

/* ---------------- 注册 ---------------- */
export function renderRegister(container, { onSuccess }) {
  const view = buildPage(
    'register',
    `
      <div class="field" data-field="username">
        <label class="field__label" for="username">用户名</label>
        <input class="input" id="username" name="username" autocomplete="username" placeholder="3-32 位字母、数字或下划线" />
        <span class="field__error"></span>
      </div>
      <div class="field" data-field="nickname">
        <label class="field__label" for="nickname">昵称</label>
        <input class="input" id="nickname" name="nickname" autocomplete="nickname" placeholder="张三" />
        <span class="field__error"></span>
      </div>
      <div class="field" data-field="password">
        <label class="field__label" for="password">密码</label>
        <input class="input" id="password" name="password" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字" />
        <span class="field__error"></span>
      </div>
      <div class="field" data-field="email">
        <label class="field__label" for="email">邮箱 <span class="text-muted">（选填）</span></label>
        <input class="input" id="email" name="email" type="email" autocomplete="email" placeholder="zhangsan@example.com" />
        <span class="field__error"></span>
      </div>
    `,
  );

  const form = view.querySelector('form');
  wireSubmit(
    view,
    form,
    async () => {
      const payload = {
        username: form.username.value.trim(),
        nickname: form.nickname.value.trim(),
        password: form.password.value,
      };
      const email = form.email.value.trim();
      if (email) payload.email = email;

      const res = await Api.register(payload);
      auth.save(res.data);
      toast(`欢迎，${res.data.user.nickname}！已为你创建「${res.data.ledger.name}」`, 'success', 4200);
      onSuccess(res.data);
    },
    '创建中',
  );

  container.replaceChildren(view);
  return view;
}
