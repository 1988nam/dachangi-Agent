/**
 * 다챙이 - 구글 포토 baseUrl 프록시 (Cloudflare Pages Function).
 *  포토 Picker의 사진 바이트는 baseUrl + Authorization 헤더로만 받을 수 있는데,
 *  그 usercontent 엔드포인트는 브라우저 CORS를 허용하지 않아 정적앱에서 직접 fetch가 막힘.
 *  → 이 함수가 서버측에서 대신 받아 전달. 프런트→함수는 같은 출처(/api/photo)라 CORS 없음.
 *  오용(오픈 프록시) 방지를 위해 구글 도메인만 허용한다.
 */
const ALLOW = ['.googleusercontent.com', '.google.com', '.ggpht.com'];

export async function onRequestGet({ request }) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  if (!target) return new Response('missing url', { status: 400 });

  let host;
  try { host = new URL(target).hostname.toLowerCase(); }
  catch (_) { return new Response('bad url', { status: 400 }); }
  if (!ALLOW.some(d => host.endsWith(d))) return new Response('forbidden host', { status: 403 });

  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('missing authorization', { status: 401 });

  const upstream = await fetch(target, { headers: { Authorization: auth } });
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Cache-Control', 'private, max-age=600');
  return new Response(upstream.body, { status: upstream.status, headers });
}
