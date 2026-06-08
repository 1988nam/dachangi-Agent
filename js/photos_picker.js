/**
 * 다챙이 - 구글 포토 Picker API 연동 (사진 직접 선택).
 *  Library API의 readonly(전체 라이브러리 검색) scope가 2025-03-31 폐기되어,
 *  사용자가 포토 창에서 직접 고르는 Picker 방식만 가능. 날짜 자동수집은 더 이상 불가.
 *  사진 바이트는 baseUrl(인증 필요·CORS 비허용)에서 받아야 하므로 /api/photo 프록시 경유.
 */
const PhotosPicker = (() => {
  const BASE = 'https://photospicker.googleapis.com/v1';

  function _bearer() { return { Authorization: `Bearer ${Auth.getToken()}` }; }

  async function createSession() {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ..._bearer(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`포토 세션 생성 실패 (${res.status}) — 포토 권한/스코프 확인`);
    return res.json();
  }

  async function getSession(id) {
    const res = await fetch(`${BASE}/sessions/${id}`, { headers: _bearer() });
    if (!res.ok) throw new Error(`세션 조회 실패 (${res.status})`);
    return res.json();
  }

  function deleteSession(id) {
    try { fetch(`${BASE}/sessions/${id}`, { method: 'DELETE', headers: _bearer() }); } catch (_) {}
  }

  // 선택된 미디어 항목 전체(페이지네이션)
  async function listMediaItems(sessionId) {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 20; i++) {
      const u = new URL(`${BASE}/mediaItems`);
      u.searchParams.set('sessionId', sessionId);
      u.searchParams.set('pageSize', '100');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await fetch(u.toString(), { headers: _bearer() });
      if (!res.ok) throw new Error(`사진 목록 조회 실패 (${res.status})`);
      const j = await res.json();
      (j.mediaItems || []).forEach(it => {
        const mf = it.mediaFile || it;
        const meta = mf.mediaFileMetadata || {};
        out.push({
          id: it.id || '',
          baseUrl: mf.baseUrl || '',
          mimeType: mf.mimeType || '',
          filename: mf.filename || '',
          createTime: it.createTime || meta.creationTime || '',
          width: parseInt(meta.width || '0', 10) || 0,
          height: parseInt(meta.height || '0', 10) || 0,
        });
      });
      pageToken = j.nextPageToken || '';
      if (!pageToken) break;
    }
    return out;
  }

  // 'NNNs' → ms
  function _secs(s, dflt) {
    if (!s) return dflt;
    const m = String(s).match(/([\d.]+)s/);
    return m ? Math.round(parseFloat(m[1]) * 1000) : dflt;
  }

  // 전체 흐름: 세션 생성 → 포토 창 열기 → 선택 폴링 → 선택 항목 반환
  async function pick(onProgress) {
    const log = onProgress || (() => {});
    // 팝업은 사용자 제스처 직후 동기로 먼저 열어 차단을 피한다(이후 location만 교체).
    const win = window.open('about:blank', 'dachangi_gphoto', 'width=480,height=720');
    let session;
    try {
      log('📷 포토 세션 생성 중...');
      session = await createSession();
    } catch (e) {
      if (win) win.close();
      throw e;
    }
    if (win) { try { win.location.href = session.pickerUri; } catch (_) {} }
    else { window.open(session.pickerUri, '_blank'); }

    const interval = Math.max(1500, _secs(session.pollingConfig && session.pollingConfig.pollInterval, 3000));
    const timeout = Math.min(_secs(session.pollingConfig && session.pollingConfig.timeoutIn, 300000), 600000);
    const start = Date.now();
    log('🖼️ 포토 창에서 사진을 선택하세요...');
    try {
      while (true) {
        await new Promise(r => setTimeout(r, interval));
        if (Date.now() - start > timeout) throw new Error('시간 초과 — 다시 시도하세요.');
        let st = null;
        try { st = await getSession(session.id); } catch (_) { continue; }
        if (st.mediaItemsSet) break;
        if (win && win.closed) {
          const chk = await getSession(session.id).catch(() => null);
          if (chk && chk.mediaItemsSet) break;
          throw new Error('선택이 취소되었습니다.');
        }
      }
      log('✅ 선택 완료, 목록 불러오는 중...');
      return await listMediaItems(session.id);
    } finally {
      if (win && !win.closed) { try { win.close(); } catch (_) {} }
      deleteSession(session.id);
    }
  }

  function _abToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  // baseUrl 사진 바이트 → base64 (프록시 경유, JPEG로 정규화)
  async function fetchImageBase64(baseUrl, maxDim) {
    maxDim = maxDim || 1024;
    const sized = `${baseUrl}=w${maxDim}-h${maxDim}`;
    const proxied = `/api/photo?url=${encodeURIComponent(sized)}`;
    const res = await fetch(proxied, { headers: _bearer() });
    if (!res.ok) throw new Error(`사진 다운로드 실패 (${res.status})`);
    const blob = await res.blob();
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
    } catch (e) {
      const buf = await blob.arrayBuffer();
      let mime = (blob.type || 'image/jpeg').toLowerCase();
      if (mime === 'image/webp') mime = 'image/jpeg';
      return { mime, data: _abToBase64(buf) };
    }
  }

  return { pick, fetchImageBase64, createSession, listMediaItems };
})();
