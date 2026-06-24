/**
 * 다챙이 - 사진 프록시 (Cloudflare Pages Function). 두 가지 모드:
 *  · ?fileId=&sz= : 드라이브 썸네일. 메타 조회(files.get thumbnailLink)와 바이트 다운로드를
 *    엣지에서 한 번에 처리해 브라우저 왕복을 2회→1회로 줄인다. URL이 고정되어
 *    서비스워커/브라우저 캐시가 가능해진다(일기 사진은 불변).
 *  · ?url= : 구글 포토 Picker baseUrl 등 서명 URL을 그대로 중계(기존 모드).
 *    usercontent 엔드포인트가 브라우저 CORS를 허용하지 않아 정적앱에서 직접 fetch가 막히기 때문.
 *  오용(오픈 프록시) 방지: url 모드는 구글 도메인만 허용, fileId는 드라이브 API에만 사용.
 */
const ALLOW = ['.googleusercontent.com', '.google.com', '.ggpht.com'];

// thumbnailLink의 크기 접미사(=s220 / =w..-h..)를 원하는 size로 교체 (기존 drive.js와 동일 규칙)
function resizeThumbLink(link, size) {
  if (/=s\d+(-c)?$/.test(link)) return link.replace(/=s\d+(-c)?$/, `=s${size}`);
  if (/=w\d+-h\d+(-c)?$/.test(link)) return link.replace(/=w\d+-h\d+(-c)?$/, `=s${size}`);
  return link + (link.indexOf('=') === -1 ? `=s${size}` : '');
}

export async function onRequestGet({ request }) {
  const reqUrl = new URL(request.url);
  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('missing authorization', { status: 401 });

  const fileId = reqUrl.searchParams.get('fileId');
  let target = reqUrl.searchParams.get('url');

  if (fileId) {
    if (!/^[\w-]{10,}$/.test(fileId)) return new Response('bad fileId', { status: 400 });
    const sz = Math.min(2048, Math.max(64, parseInt(reqUrl.searchParams.get('sz'), 10) || 1024));
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=thumbnailLink`,
      { headers: { Authorization: auth } });
    if (!metaRes.ok) return new Response('meta failed', { status: metaRes.status });
    const meta = await metaRes.json().catch(() => ({}));
    if (!meta.thumbnailLink) return new Response('no thumbnail', { status: 404 });
    target = resizeThumbLink(meta.thumbnailLink, sz);
  }

  if (!target) return new Response('missing url', { status: 400 });
  let host;
  try { host = new URL(target).hostname.toLowerCase(); }
  catch (_) { return new Response('bad url', { status: 400 }); }
  if (!ALLOW.some(d => host.endsWith(d))) return new Response('forbidden host', { status: 403 });

  const upstream = await fetch(target, { headers: { Authorization: auth } });
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  // fileId 모드는 URL 고정 + 사진 불변이라 길게, url 모드는 서명 URL이 곧 만료되므로 짧게.
  headers.set('Cache-Control', fileId ? 'private, max-age=86400' : 'private, max-age=600');
  return new Response(upstream.body, { status: upstream.status, headers });
}
