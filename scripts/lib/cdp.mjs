/**
 * CDP 探针公共库（脚本侧）
 *
 *   import { connect, shot, waitFor } from './lib/cdp.mjs';
 *
 * ## 为什么抽这个库
 *
 * 仓库里先后长出 4 份 CDP 探针（`probe-boundary-ui.mjs` 加临时目录里的
 * stage-* / batch*-shot / dev-shot* 等 40+ 个脚本），每份都是把同一段
 * 15 行 WebSocket 胶水**抄一遍**。抄的代价不是行数，而是**纪律会丢**：
 *
 *   · 有一份忘了 `setCacheDisabled` → 拍到 1 小时前的旧脚本（`max-age=3600`）；
 *   · 有一份把 `cc-ledger.theme.v1` 用 `JSON.stringify('dark')` 写成 `"dark"`
 *     → `theme.js` 的 `MODES.includes(raw)` 取不到 → 静默回落 auto
 *     → **夜景截图拍成白天，而所有断言都绿**（项目里最贵的一个坑）；
 *   · 有一份先导航再 `Storage.clearDataForOrigin` → sw.js 已经注册，
 *     Cache Storage 清不掉，等于用缓存掩盖真实状态。
 *
 * 这些都不是「忘了写代码」，是**忘了那段代码背后有一条为什么**。
 * 集中到一处之后，纪律写在函数的注释里，谁用都带着。
 *
 * ## 四条纪律（每次探针必须齐，缺一条结果都不可信）
 *
 * ① **清 Storage 必须在任何一次应用导航之前**
 *    `public/sw.js` 已上线，多一层 Cache Storage。导航本身就会注册 SW，
 *    导航完再查必然已存在 —— 而「清不掉」的表现是页面读到了旧缓存，
 *    断言还全绿。顺序：`clearDataForOrigin` → `clearBrowserCache` → 才导航。
 *
 * ② **`Network.setCacheDisabled({cacheDisabled:true})`**
 *    静态资源带 `max-age=3600`，不清就拍到上一轮跑的脚本。
 *
 * ③ **主题键写裸字符串**：`localStorage.setItem(k, 'dark')`，
 *    不能 `JSON.stringify` —— 那是上一条②的根因。
 *
 * ④ **`captureBeyondViewport: false` + 先 `getAnimations().finish()`**
 *    前者否则 `position: sticky` 元素被拍在半路；
 *    后者否则进场动画拍成半透明（配合 `setEmulatedMedia` 模拟
 *    `prefers-reduced-motion` 更稳 —— 但本项目主题走
 *    `html[data-theme]` 而非 media query，模拟 media **对本项目无效**，
 *    必须一并写 localStorage）。
 *
 * 另外：**截图前先滚动到待验证区域**（见 `shot()` 的 `focus` 参数）。
 * 对账面板挂在账户列表**下方**，不滚的话拍到的是空分组列表 ——
 * 断言全绿、截图里什么都没有，这是真的发生过的事故。
 *
 * ## 关于 headless 下的 Storage 猴补丁
 *
 * `Storage.prototype.setItem/removeItem` 的猴补丁在 headless 里**不可靠**
 * （实测日志始终为空；试过打 window、改 sessionStorage、修「每文档重置」
 * 都不行）。要抓存储变更，用 CDP 的 `DOMStorage` 域 ——
 * 见本文件 `watchStorage()`，它是 **CDP 协议级**的，不依赖页面内 JS。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 连上一个已经开着的 headless 浏览器并返回探针句柄。
 *
 * 前提：另有一个进程在监听 CDP 端口（默认 9333）。探针**不负责**启动浏览器 ——
 * 让每个脚本自己 spawn 一个 headless 实例，会同时开五六个 Chromium，
 * 内存与端口都会互相干扰。
 *
 * @param {{cdp?: string, base?: string}} cfg
 */
export async function connect({ cdp = 'http://127.0.0.1:9333', base = 'http://127.0.0.1:3000' } = {}) {
  const targets = await (await fetch(`${cdp}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error(`CDP ${cdp} 上没有可用的 page target（headless 起了吗？）`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`连不上 ${cdp}`));
  });

  let id = 0;
  const pending = new Map();
  /** 事件订阅者：method → Set<handler> */
  const listeners = new Map();

  /** 控制台异常 */
  const errors = [];
  /**
   * 网络失败单独记一份。
   * ⚠️ `Log.entryAdded` 只给一句 "Failed to load resource"、**不给 url** ——
   * 直接用它做归因，404 永远查不到是哪个接口。一律以
   * `Network.responseReceived` 的 `response.url` 为准。
   */
  const netFails = [];

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      errors.push(`LOG ${m.params.entry.text} <${m.params.entry.url ?? ''}>`);
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400 && r.url.includes('/api/v1/')) netFails.push(`${r.status} ${r.url.replace(base, '')}`);
    }
    if (m.method === 'Network.loadingFailed')
      netFails.push(`NETFAIL ${m.params.errorText ?? ''} ${m.params.type ?? ''}`);
    for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  /** 在页面里求值（自动 await promise，异常直接抛而不是返回 undefined） */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  // 纪律②
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // headless 下 DOM `.focus()` 不生效，输入框点不动
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Log 域会回放历史条目 —— 启用后立刻清空，只收本次产生的
  errors.length = 0;

  /**
   * 自动应答 `confirm()`。
   *
   * ## 为什么必须由 CDP 应答，而不是在页面里 `window.confirm = () => true`
   *
   * headless 里 `confirm()` 会弹一个**原生**对话框。它一弹出，页面 JS 就阻塞，
   * 而 `Runtime.evaluate` 默认在**主世界**执行 —— 此时正被那个 handler 占着，
   * 于是赋值语句自己都发不出去（表现为脚本停在这一行直到超时，
   * 而**不是**任何报错，信息量为零）。
   *
   * 这条是所有「删除 / 取消 / 提交」交互的公共前置，不是某个页面特有的。
   * 所以它属于**库**：写在探针里会出现第二个探针忘了写，而现象是「静默挂住」。
   *
   * 需要**拒绝**的分支用 `dialog: 'dismiss'` 临时改，或在页面里改用非原生对话框。
   */
  const dialogs = [];
  let dialogPolicy = 'accept';
  const onEvent = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
  };
  onEvent('Page.javascriptDialogOpening', (p) => {
    dialogs.push({ type: p.type, message: p.message, at: Date.now() });
    send('Page.handleJavaScriptDialog', { accept: dialogPolicy === 'accept' }).catch(() => {});
  });

  /**
   * 在**任何页面脚本之前**把 `confirm` 变成自动接受。
   *
   * ## 为什么不能靠 CDP 的 `Page.handleJavaScriptDialog` 兜底
   *
   * 那个事件确实会触发（`dialogs` 里有记录），但 headless 下对话框弹出后，
   * 页面 JS **阻塞在 `confirm()` 那一行**，直到对话框被关闭才继续。
   * 于是「弹出 → 应答」之间存在一个窗口，窗口内页面不做任何事 ——
   * 表现为提交动作「什么都没发生」：没有 toast、没有报错、没有请求。
   *
   * 而 `Runtime.evaluate` 也救不了：它跑在**主世界**，正好被那个阻塞占着，
   * 于是 `window.confirm = () => true` 这句赋值**自己都发不出去**。
   *
   * `addScriptToEvaluateOnNewDocument` 在文档创建时、页面任何脚本之前运行，
   * 那时还没有对话框可言 —— 所以这才是唯一稳的做法。
   * CDP 侧的应答保留作双保险（万一有 `alert`/`beforeunload` 这类无法提前覆盖的）。
   */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      // 探针环境：confirm 一律接受，但仍把原文记进 __confirmLog 以便断言「确实问过」
      window.__confirmLog = [];
      window.confirm = function (msg) { window.__confirmLog.push(String(msg ?? '')); return true; };
      window.alert = function (msg) { window.__confirmLog.push('alert:' + String(msg ?? '')); };
    `,
  });

  /**
   * 干净起点（纪律①）。
   *
   * **必须在任何一次应用导航之前调用**。想「先导航再清」也行不通：
   * 导航本身会注册 SW，届时 Cache Storage 必然已存在。
   *
   * 注意本函数**不导航**，它只清。导航由调用方在之后自己做，
   * 这样顺序在代码里是显式的、看得见的。
   */
  async function wipe() {
    await send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'all' });
    await send('Network.clearBrowserCache');
    errors.length = 0;
    netFails.length = 0;
  }

  /**
   * 等目标元素出现 —— **不要固定 sleep**。
   *
   * 首屏刚清过缓存、SW 要重新注册，第一个请求明显慢于后续
   * （实测固定 1.1s 时第一次预览请求会扑空）。而 SPA 的路由切换是
   * 「pushState + 异步渲染」，`Page.navigate` 的 load 事件比数据回来早。
   *
   * @param {string} selector 要等的元素
   * @param {{tries?: number, intervalMs?: number, label?: string}} cfg
   * @returns {Promise<boolean>} false = 超时（不抛，交给调用方决定是断言失败还是重试）
   */
  async function waitFor(selector, { tries = 40, intervalMs = 250, label } = {}) {
    for (let i = 0; i < tries; i++) {
      await sleep(intervalMs);
      try {
        // 导航途中 evaluate 会抛（执行上下文已销毁），吞掉继续等
        if (await ev(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      } catch {
        /* 导航中 */
      }
    }
    if (label) console.warn(`  ⏱ 等待超时：${label ?? selector}`);
    return false;
  }

  /**
   * 轮询直到 `read()` 返回的真值 —— 用于「等异步结果渲染出来」。
   *
   * ⚠️ 终止条件要挑**只能由本次动作产生**的信号。曾经把 `toast` 也写进
   * 终止条件，结果踩坑：登录页在自己还是未登录态时就会打一个
   * 「未登录或凭证无效」的 toast，而那个 toast **在点预览之前就已经挂在
   * DOM 里**（要等它自己消失）→ 轮询立刻退出，读到空结果区，
   * 看起来像"预览失败"，实际预览早就成功了。
   */
  async function waitUntil(read, { tries = 40, intervalMs = 250, label } = {}) {
    for (let i = 0; i < tries; i++) {
      await sleep(intervalMs);
      const v = await read();
      if (v) return v;
    }
    if (label) console.warn(`  ⏱ 轮询超时：${label}`);
    return null;
  }

  /**
   * 注入登录态。
   *
   * ⚠️ 落地页选同源静态资源（默认 `/manifest.webmanifest`）而不是 `/login`：
   * 登录页在 mount 时会跑一遍登录态清理 / `auth/me`，那些是**异步**的，
   * 会在我们 `setItem` 之后才完成，把刚写的 token 抹掉。表现极具迷惑性：
   * 回读成功、页面也渲染出了账户行，但下一个请求就 401。
   * 同源静态资源能访问 localStorage，却**不跑任何应用脚本**，
   * 没有东西会来抢着清理。
   *
   * 注入后**立刻回读校验**并最多重试 6 次 —— `setItem` 本身不会失败，
   * 失败的是「有没有人来抢着清」，回读是唯一能发现这件事的手段。
   */
  function authInjector({ token, refreshToken, extra = {} } = {}) {
    const auth = {
      accessToken: token,
      refreshToken,
      expiresAt: Date.now() + 3600_000,
    };
    const storage = { 'cc-ledger.auth.v1': auth, ...extra };
    const inject = `(() => { const s = ${JSON.stringify(storage)};
      for (const [k, v] of Object.entries(s))
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      return true; })()`;
    return {
      inject,
      /** 导航到干净落地页 → 注入 → 回读校验；读不回来直接抛 */
      async arm(theme = 'light') {
        await send('Page.navigate', { url: `${base}/manifest.webmanifest` });
        await sleep(400);
        for (let i = 0; i < 6; i++) {
          await ev(inject);
          // 纪律③：主题写**裸字符串**
          await ev(`localStorage.setItem('cc-ledger.theme.v1', ${JSON.stringify(theme)}); true`);
          await sleep(150);
          const stored = await ev(`localStorage.getItem('cc-ledger.auth.v1')`);
          if (stored) {
            try {
              if (JSON.parse(stored).accessToken === token) return;
            } catch {
              /* 被写成别的东西了，继续 */
            }
          }
        }
        throw new Error('auth 注入后读不回来');
      },
      /** 读一下当前 token 在不在（用于诊断登录态竞态） */
      async tokenState() {
        return ev(`(() => {
          const raw = localStorage.getItem('cc-ledger.auth.v1');
          if (!raw) return 'MISSING';
          try { return JSON.parse(raw).accessToken ? 'ok' : 'NO_TOKEN'; }
          catch { return 'UNPARSEABLE'; }
        })()`);
      },
    };
  }

  /**
   * 打开一个页面并等它渲染到位。
   *
   * 两轮尝试：登录态被落地页的异步 boot 冲掉时，重新注入 + 重载即可。
   * 这是**自愈**而不是掩盖 —— 前提是同时开着 `watchStorage()`，
   * 否则你只是把竞态藏起来了，看不见它还在。
   *
   * @param {string} path 应用内路径
   * @param {{wait?: string, width?: number, height?: number, mobile?: boolean, theme?: string}} cfg
   */
  async function open(
    path,
    { wait, width = 1440, height = 1000, mobile = false, theme = 'light', arm } = {},
  ) {
    let lastTheme = theme;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (arm) await arm(theme);
      lastTheme = theme;
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await send('Page.navigate', { url: `${base}${path}` });
      const okWait = wait ? await waitFor(wait) : true;
      if (okWait) {
        await sleep(300);
        errors.length = 0; // 只收本轮产生的
        netFails.length = 0;
        return true;
      }
      if (attempt === 2) throw new Error(`打开 ${path} 未等到 ${wait}（两轮尝试均超时）`);
    }
    return false;
  }

  /**
   * 截图。
   *
   * @param {string} name 文件名（不含扩展名）
   * @param {{dir: string, focus?: string, theme?: string, settleMs?: number}} cfg
   *   `focus` = **待验证区域的 CSS 选择器**，拍之前先滚到它。
   *   这是纪律④的正面写法：把「要拍哪里」写进调用点，而不是靠人记得先手动滚。
   */
  async function shot(name, { dir, focus, settleMs = 400 } = {}) {
    if (focus) {
      await ev(`(() => {
        const t = document.querySelector(${JSON.stringify(focus)});
        t?.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await sleep(settleMs);
    }
    // 纪律④：动画先 finish，否则拍到半透明的进场中间态
    await ev(`document.getAnimations().forEach(a => { try { a.finish(); } catch {} }); true`);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    mkdirSync(dir, { recursive: true });
    const p = `${dir.replace(/[\\/]+$/, '')}/${name}.png`;
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }

  /**
   * 观察 localStorage 变更 —— CDP 的 `DOMStorage` 域。
   *
   * 这是 `Storage.prototype` 猴补丁的**替代品**：猴补丁在 headless 里
   * 不可靠（打补丁似乎没生效，日志始终为空），而 `DOMStorage` 是
   * **协议级**的，不依赖页面内 JS 是否被成功打补丁。
   *
   * 用法：
   * ```js
   * const store = watchStorage();
   * store.start();                 // DOMStorage.enable
   * store.onRemove((e) => log(e));  // 谁把 token 抹了
   * ...
   * store.changes();                // 回看全部变更（含 key / oldValue / newValue）
   * ```
   *
   * ⚠️ 它**只报变更、不报调用栈**。CDP 协议在这里没有 JS 栈信息 ——
   * 所以定位「谁干的」仍然要靠时间相关性（变更时刻 vs 某个动作）。
   */
  function watchStorage() {
    const changes = [];
    const handlers = { added: [], updated: [], removed: [], cleared: [] };
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
    };
    on('DOMStorage.domStorageItemAdded', (p) => {
      const e = {
        area: p.storageId?.securityOrigin,
        key: p.key,
        newValue: p.newValue,
        at: Date.now(),
      };
      changes.push({ kind: 'added', ...e });
      handlers.added.forEach((f) => f(e));
    });
    on('DOMStorage.domStorageItemUpdated', (p) => {
      const e = {
        area: p.storageId?.securityOrigin,
        key: p.key,
        oldValue: p.oldValue,
        newValue: p.newValue,
        at: Date.now(),
      };
      changes.push({ kind: 'updated', ...e });
      handlers.updated.forEach((f) => f(e));
    });
    on('DOMStorage.domStorageItemRemoved', (p) => {
      const e = { area: p.storageId?.securityOrigin, key: p.key, oldValue: p.oldValue, at: Date.now() };
      changes.push({ kind: 'removed', ...e });
      handlers.removed.forEach((f) => f(e));
    });
    on('DOMStorage.domStorageItemsCleared', (p) => {
      const e = { area: p.storageId?.securityOrigin, at: Date.now() };
      changes.push({ kind: 'cleared', ...e });
      handlers.cleared.forEach((f) => f(e));
    });
    return {
      start: () => send('DOMStorage.enable'),
      stop: () => send('DOMStorage.disable'),
      onAdded: (f) => handlers.added.push(f),
      onUpdated: (f) => handlers.updated.push(f),
      onRemoved: (f) => handlers.removed.push(f),
      onCleared: (f) => handlers.cleared.push(f),
      changes: () => [...changes],
      /** 打印一份人类可读的变更流水（诊断登录态竞态时贴这个） */
      dump: (label = 'localStorage 变更') => {
        console.log(`\n── ${label}（${changes.length} 条）──`);
        for (const c of changes) {
          const v = c.kind === 'cleared' ? '' : ` ${JSON.stringify(c.oldValue ?? '')} → ${JSON.stringify(c.newValue ?? '')}`;
          console.log(`  ${c.kind.padEnd(7)} ${c.key ?? '(全部)'}${v}`);
        }
      },
      clear: () => changes.splice(0),
    };
  }

  return {
    cdp: send,
    ev,
    waitFor,
    waitUntil,
    wipe,
    authInjector,
    open,
    shot,
    watchStorage,
    errors,
    netFails,
    base,
    /** 已弹过的原生对话框（confirm/alert），便于断言「确实问过了」 */
    dialogs,
    /** 临时改应答策略：`probe.dialogPolicy = 'dismiss'` 后再触发下一次 */
    set dialogPolicy(v) {
      dialogPolicy = v;
    },
    get dialogPolicy() {
      return dialogPolicy;
    },
    close: () => ws.close(),
    /** 汇总结果并按通过数决定退出码 —— 所有探针统一用它收尾 */
    finish(results, { shots = [], exitOnFail = true } = {}) {
      const passed = results.filter((r) => r.ok).length;
      console.log(`\n结果 ==== ${passed} / ${results.length}`);
      if (shots.length) console.log('截图 ==== ' + shots.map((s) => s.split(/[\\/]/).pop()).join(', '));
      if (exitOnFail) process.exit(passed === results.length ? 0 : 1);
      return passed;
    },
  };
}

/**
 * 探针结果收集器：与 `finish()` 配套。
 * 断言多的时候比裸数组好读 —— 名字会打出来，失败行自带 detail。
 */
export function checker() {
  const results = [];
  const shots = [];
  return {
    results,
    shots,
    check(name, ok, detail = '') {
      results.push({ name, ok: !!ok, detail });
      console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : `  ${detail}`}`);
    },
    shot(p) {
      shots.push(p);
      return p;
    },
  };
}

export { dirname };
