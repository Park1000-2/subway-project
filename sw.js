/**
 * sw.js — 오프라인 동작용 서비스워커
 *
 * 지하철 안에서는 신호가 끊기므로 '네트워크 없이도 되는 것'이 핵심입니다.
 * 이 앱은 서버 호출이 없어서 파일만 캐시해 두면 전부 동작합니다.
 *
 * 파일을 고치면 CACHE 값을 바꾸세요(같은 날 여러 번이면 뒤에 -2, -3). 새 버전이
 * 설치되고 옛 캐시는 지워집니다. 안 바꾸면 이미 설치한 기기가 옛 파일을 계속 씁니다.
 */
const CACHE = 'sitting-commute-2026-10-17-3';
const FONTS = 'sitting-commute-fonts';

/** 앱이 도는 데 필요한 전부 (data/ 의 원본 CSV 는 빌드 산출물이라 제외) */
const PRECACHE = [
  './', './index.html', './manifest.json',
  './src/app.js', './src/planner.js', './src/congestion.js', './src/graph.js',
  './src/network.js', './src/demand.js', './src/schedule.js', './src/transfer-cars.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나라도 실패하면 설치가 통째로 깨지므로 개별로 담습니다
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isFont = (url) =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // 구글 폰트: 한 번 받아 두면 계속 캐시에서 (오프라인 첫 실행 대비)
  if (isFont(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(FONTS);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        return hit ?? Response.error();
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // 앱 파일: 캐시를 먼저 내주고 뒤에서 갱신 (stale-while-revalidate)
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request).then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => null);
    if (hit) return hit;
    const res = await fresh;
    if (res) return res;
    // 오프라인에서 처음 보는 주소면 시작 화면으로
    return (await cache.match('./index.html')) ?? Response.error();
  })());
});
