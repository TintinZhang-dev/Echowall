// Phewall Service Worker — 网络优先 + 静态缓存兜底（离线可用）
const CACHE = 'phewall-static-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 动态接口/上传文件/APK 下载不缓存也不拦截(下载必须直达浏览器/原生处理)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/downloads/')) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          // 带 ?v= 版本号的资源:先清掉同一路径的旧版本缓存,避免无限囤积
          if (url.search && url.search.includes('v=')) {
            const keys = await cache.keys();
            await Promise.all(keys.filter(k => {
              const ku = new URL(k.url);
              return ku.pathname === url.pathname && ku.search !== url.search;
            }).map(k => cache.delete(k)));
          }
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await cache.match(req);
        return cached || Response.error();
      }
    })
  );
});
