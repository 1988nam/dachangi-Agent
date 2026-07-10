/**
 * 다챙이 서비스워커 — 정적 앱 셸 오프라인 캐시 + 일기 사진 캐시.
 *  · 같은 출처(GET)의 정적 자산만 stale-while-revalidate 캐시.
 *  · 네비게이션은 network-first(오프라인 시 캐시된 index.html 폴백).
 *  · /api/photo?fileId= (드라이브 썸네일, URL 고정·사진 불변)만 cache-first로 캐시 —
 *    한 번 본 사진은 재방문·오프라인에서도 즉시 표시.
 *  · 그 외 /api/* (url= 모드의 서명 URL 포함) / 구글 API / cross-origin·비GET은
 *    절대 가로채지 않는다(인증 토큰·만료 응답을 캐시하면 안 되므로).
 *  버전을 올리면 CACHE 이름이 바뀌어 옛 캐시가 자동 정리된다. (index.html ?v= 와 함께 올릴 것)
 */
const CACHE = 'dachangi-v54';
// 일기 사진 캐시 — 앱 셸과 달리 버전을 올려도 비우지 않는다(사진은 불변). 로그아웃 시 페이지측에서 삭제.
const PHOTO_CACHE = 'dachangi-photos-v1';
const PHOTO_CACHE_MAX = 400; // 기기 저장공간 보호: 개수 상한(오래된 것부터 베스트에포트 정리)
const CORE = ['./', './index.html', './style.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // 핵심 셸을 미리 받아두되, 일부 실패해도 설치는 진행(쿼리스트링 버전 차이 등 견딤)
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(CORE.map(u => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PHOTO_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 사진 캐시 개수 상한 정리 — Cache keys()는 사실상 삽입순이라 앞에서부터 지우면 LRU 근사
async function _trimPhotoCache(c) {
  try {
    const keys = await c.keys();
    for (let i = 0; i < keys.length - PHOTO_CACHE_MAX; i++) await c.delete(keys[i]);
  } catch (_) {}
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 같은 출처만 처리 — 구글 API/usercontent 등은 네트워크로 직행
  if (url.origin !== self.location.origin) return;

  // 일기 사진(fileId 고정 URL): cache-first. 비정상 응답(401/404 등)은 캐시하지 않는다.
  if (url.pathname === '/api/photo' && url.searchParams.get('fileId')) {
    event.respondWith((async () => {
      try {
        const c = await caches.open(PHOTO_CACHE);
        const cached = await c.match(url.href);
        if (cached) return cached;
        const res = await fetch(req);
        if (res && res.ok && (res.headers.get('Content-Type') || '').indexOf('image/') === 0) {
          await c.put(url.href, res.clone());
          _trimPhotoCache(c); // 비동기 정리(응답 지연 없음)
        }
        return res;
      } catch (_) { return fetch(req); }
    })());
    return;
  }
  // 그 외 /api/* 는 캐시 없이 네트워크 직행(토큰/만료 응답 캐시 금지)
  if (url.pathname.startsWith('/api/')) return;

  // 네비게이션: network-first → 오프라인이면 캐시된 셸로 폴백
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // 정적 자산(css/js/png/manifest): stale-while-revalidate
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
