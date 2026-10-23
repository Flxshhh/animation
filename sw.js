// Service worker: сохраняет приложение и словарь на телефоне,
// чтобы сайт открывался и добавлял слова без интернета.
// При изменении файлов приложения увеличь версию — старый кэш удалится.
const CACHE = 'wordbook-v6';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'chat.js', 'manifest.webmanifest', 'icon.svg',
  'fonts/manrope-cyrillic-wght-normal.woff2', 'fonts/manrope-latin-wght-normal.woff2',
  'dict/ru.json', 'dict/pron.json', 'dict/ex.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // запросы к API перевода/словаря идут в сеть напрямую
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // stale-while-revalidate: сразу отдаём из кэша (работает офлайн и быстро),
  // а в фоне скачиваем свежую версию — она будет при следующем открытии
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; })
      .catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || (await cache.match('index.html')) || Response.error();
  }));
});
