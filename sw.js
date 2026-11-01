// Service Worker —— 离线缓存
const CACHE_NAME = 'inspection-v18';
const ASSETS = [
  './',
  './index.html',
  './work.html',
  './report.html',
  './history.html',
  './settings.html',
  './import_export.html',
  './privacy.html',
  './manifest.json',
  './css/base.css',
  './css/index.css',
  './css/work.css',
  './css/report.css',
  './css/history.css',
  './css/settings.css',
  './css/import_export.css',
  './css/privacy.css',
  './js/wx-polyfill.js',
  './js/pages/work.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  // 单个资源失败不影响整体安装
  e.waitUntil(
    caches.open(CACHE_NAME).then(c =>
      Promise.all(ASSETS.map(url => c.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 页面请求走“网络优先”，保证更新后立刻拿到新页面
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
        return resp;
      }).catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // 静态资源走“缓存优先”
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return resp;
      });
    })
  );
});
