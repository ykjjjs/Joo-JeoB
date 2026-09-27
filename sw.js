/* Joo-JeoB service worker
   역할 두 가지뿐입니다.
   1) 설치형 앱(홈 화면 아이콘)이 되기 위한 fetch 핸들러 제공
   2) 껍데기(HTML·아이콘·글꼴)를 캐시해서 네트워크가 느리거나 끊겨도 앱이 열리게 함
   ※ 음원 검색(Jamendo) 같은 API 응답과 미디어는 캐시하지 않습니다. */

const VERSION = 'joojeob-v4';
const SHELL   = VERSION + '-shell';
const ASSET   = VERSION + '-asset';

const SHELL_URLS = ['./', './index.html', './manifest.json',
                    './icon-192.png', './icon-512.png',
                    './icon-maskable-192.png', './icon-maskable-512.png',
                    './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 하나가 실패해도 설치는 진행되도록 개별 처리
    await Promise.all(SHELL_URLS.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isFont(url){
  return url.hostname === 'fonts.googleapis.com'
      || url.hostname === 'fonts.gstatic.com'
      || url.hostname === 'cdn.jsdelivr.net';
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                    // POST 등은 그대로
  if (req.headers.has('range')) return;                // 영상 구간 요청은 건드리지 않음
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 글꼴/CDN — 캐시 우선 (한 번 받으면 오프라인에서도 글꼴 유지)
  if (isFont(url)) {
    event.respondWith((async () => {
      const c = await caches.open(ASSET);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;     // 그 외 외부 요청(API 등)은 통과

  // 문서 — 네트워크 우선 (배포하면 바로 최신본), 실패 시 캐시
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok){
          const c = await caches.open(SHELL);
          c.put(req, res.clone());
          c.put('./index.html', res.clone());
        }
        return res;
      } catch (err) {
        const c = await caches.open(SHELL);
        return (await c.match(req)) || (await c.match('./index.html'))
            || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 같은 도메인 정적 파일(아이콘 등) — 캐시 우선 + 뒤에서 갱신
  event.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req);
    const net = fetch(req).then(res => {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }).catch(() => hit || Response.error());
    return hit || net;
  })());
});
