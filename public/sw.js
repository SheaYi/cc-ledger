/**
 * CC记账 · Service Worker
 *
 * 目标：让应用可安装（Chrome installability 要求有带 fetch handler 的 SW）+
 * 弱网/断网时至少能打开外壳看已加载的数据。**离线写操作不在本版范围**
 * （docs/13 §10.2 的 outbox 重放已登记为 V16，属 PWA 阶段）。
 *
 * 对 docs/09 §4.2 缓存策略的两处修正（都是自托管场景的真实需求）：
 *
 *  ① 文档定 HTML 外壳 cache-first，这里改 **network-first + 缓存兜底**。
 *     理由：cache-first 让用户发版后仍拿着旧外壳，旧外壳引用的旧 JS 又被
 *     SWR 缓存供着 —— 自托管应用迭代频繁，这会变成「升级了却像没升级」的
 *     诡异故障。局域网部署网络往返可忽略，用新鲜度换正确性。
 *  ② 文档定静态资源 stale-while-revalidate，**保留**；但把版本号编进缓存名，
 *     activate 时清掉旧版本，避免无限累积。
 *
 * 版本号：发版时改 `VERSION` 即可让所有客户端换一套缓存并清掉旧的。
 */
/**
 * v2：账单页 `load()` 的请求时序修复（`busy` 锁 → `loadSeq` 最新优先）。
 * 静态资源走 SWR，不换版本号的话用户第一次刷新拿到的仍是旧 JS ——
 * 正好是要修的那份，会被当成「没修好」。
 */
const VERSION = 'cc-ledger-v32';
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const API = `${VERSION}-api`;
const ALL = [SHELL, STATIC, API];

/** 安装即预缓存的外壳：离线时至少能打开应用并看到导航 */
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // 逐个 add：一个失败不该让整个安装失败（比如某个图标 404）
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('cc-ledger-') && !ALL.includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // 写操作一律透传，不做离线队列（V16）

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨域请求不碰

  // ① 页面导航：network-first，断网才回落外壳缓存
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await caches.match('/');
          return (
            cached ??
            new Response('当前离线，且尚未缓存应用外壳。请连接网络后重试。', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          );
        }
      })(),
    );
    return;
  }

  // ② 静态资源：stale-while-revalidate（先给缓存保秒开，后台更新）
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        const cached = await cache.match(request);
        const fresh = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached ?? (await fresh) ?? Response.error();
      })(),
    );
    return;
  }

  // ③ API 读请求：network-first，断网回落上次成功的响应（离线可看旧数据）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API);
        try {
          const res = await fetch(request);
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          const cached = await cache.match(request);
          return (
            cached ??
            new Response(JSON.stringify({ error: { code: 'offline', message: '当前离线' } }), {
              status: 503,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            })
          );
        }
      })(),
    );
  }
});
