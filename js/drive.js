/**
 * 다챙이 - 구글 드라이브 연동 (사진 조회 + 이미지 base64 변환)
 */
const DriveAPI = (() => {
  // REST를 안 거치는 raw fetch(사진 다운로드/업로드)용 401 1회 갱신·재시도 래퍼.
  //  매 시도마다 최신 토큰으로 Authorization을 덮어쓴다(긴 업로드 도중 토큰 만료 대비).
  async function _authedFetch(url, opts, _retried) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers, { Authorization: `Bearer ${Auth.getToken()}` });
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401 && !_retried && Auth.refreshToken) {
      try { await Auth.refreshToken(); } catch (_) { return res; }
      return _authedFetch(url, opts, true);
    }
    return res;
  }

  // 메인 폴더 안에서 'yyyy-MM' 월별 폴더 찾기
  async function findMonthFolder(mainFolderId, monthStr) {
    mainFolderId = REST.extractId(mainFolderId);
    const res = await REST.driveList({
      q: `'${mainFolderId}' in parents and name = '${monthStr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)',
      pageSize: 10,
    });
    const files = res.files || [];
    return files.length ? files[0] : null;
  }

  // 폴더 내 이미지 파일 전체(페이지네이션)
  async function listImages(folderId) {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 20; i++) {
      const params = {
        q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType,size,createdTime,imageMediaMetadata(time,width,height))',
        pageSize: 1000,
      };
      if (pageToken) params.pageToken = pageToken;
      const res = await REST.driveList(params);
      (res.files || []).forEach(f => {
        const meta = f.imageMediaMetadata || {};
        out.push({
          id: f.id, name: f.name, mimeType: f.mimeType,
          size: parseInt(f.size || '0', 10) || 0,
          createdTime: f.createdTime || '',
          width: meta.width || 0, height: meta.height || 0,
          exifTime: meta.time || '',
        });
      });
      pageToken = res.nextPageToken || '';
      if (!pageToken) break;
    }
    return out;
  }

  // 사진의 '촬영 날짜'(yyyy-MM-dd): EXIF 우선, 없으면 생성시각
  function photoDateStr(photo) {
    if (photo.exifTime) {
      // EXIF: 'yyyy:MM:dd HH:mm:ss' → 'yyyy-MM-dd' (현지 시각이라 그대로 사용)
      return photo.exifTime.slice(0, 10).replace(/:/g, '-');
    }
    if (photo.createdTime) {
      // createdTime은 RFC3339 UTC — 그대로 자르면 KST 0~9시 사진이 전날로 분류됨 → 로컬 시간대로 변환
      const d = new Date(photo.createdTime);
      if (!isNaN(d.getTime())) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      }
      return photo.createdTime.slice(0, 10);
    }
    return '';
  }

  // 특정 날짜에 찍은 사진만
  function filterByDate(photos, dateStr) {
    return photos.filter(p => photoDateStr(p) === dateStr);
  }

  // 해상도(0.7)+용량(0.3) 복합점수 상위 N장 (1차 선별)
  function selectByResolution(photos, maxCount) {
    const maxPixels = Math.max(1, ...photos.map(p => (p.width * p.height) || 1));
    const maxSize = Math.max(1, ...photos.map(p => p.size || 1));
    return photos.slice().sort((a, b) => {
      const sa = ((a.width * a.height) / maxPixels) * 0.7 + (a.size / maxSize) * 0.3;
      const sb = ((b.width * b.height) / maxPixels) * 0.7 + (b.size / maxSize) * 0.3;
      return sb - sa;
    }).slice(0, maxCount);
  }

  function _abToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // 이미지 바이트 → base64 (가능하면 maxDim으로 다운스케일한 JPEG, 실패 시 원본)
  async function fetchImageBase64(fileId, maxDim) {
    maxDim = maxDim || 1024;
    const res = await _authedFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {});
    if (!res.ok) throw new Error(`이미지 다운로드 실패 (${res.status})`);
    const blob = await res.blob();
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      return { mime: 'image/jpeg', data: dataUrl.split(',')[1] };
    } catch (e) {
      // HEIC 등 디코딩 불가 → 1차: 드라이브 서버 변환 썸네일(JPEG)로 재시도.
      //  원본 수 MB를 그대로 base64 전송하면 후보 여러 장일 때 Gemini 인라인 한도(20MB) 초과 위험.
      try {
        const meta = await REST.driveGet(fileId, 'thumbnailLink');
        if (meta && meta.thumbnailLink) {
          const link = _resizeThumbLink(meta.thumbnailLink, maxDim);
          const tRes = await _authedFetch(`/api/photo?url=${encodeURIComponent(link)}`, {});
          if (tRes.ok) {
            const tBlob = await tRes.blob();
            if ((tBlob.type || '').indexOf('image/') === 0) {
              const bmp = await createImageBitmap(tBlob);
              const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
              const w = Math.max(1, Math.round(bmp.width * scale));
              const h = Math.max(1, Math.round(bmp.height * scale));
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
              return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
            }
          }
        }
      } catch (_) {}
      // 2차: 원본 바이트 전송
      const buf = await blob.arrayBuffer();
      let mime = (blob.type || 'image/jpeg').toLowerCase();
      if (mime === 'image/webp') mime = 'image/jpeg';
      return { mime, data: _abToBase64(buf) };
    }
  }

  // 앱 전용 사진 폴더 확보(없으면 생성). drive.file 권한으로 앱이 만든 폴더/파일만 다룸.
  async function ensurePhotoFolder() {
    const LS = 'dachangi_photo_folder_id';
    const cached = localStorage.getItem(LS);
    if (cached) {
      // files.get은 휴지통 파일에도 200을 주므로 trashed까지 확인 — 휴지통 폴더에 계속 저장하면 30일 후 영구 삭제됨
      try {
        const meta = await REST.driveGet(cached, 'id,trashed');
        if (!meta.trashed) return cached;
        localStorage.removeItem(LS);
      } catch (_) { localStorage.removeItem(LS); }
    }
    const res = await _authedFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '다챙이 일기 사진', mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!res.ok) throw new Error(`사진 폴더 생성 실패 (${res.status})`);
    const j = await res.json();
    localStorage.setItem(LS, j.id);
    return j.id;
  }

  function _b64ToBlob(b64, mime) {
    const chars = atob(b64);
    const bytes = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/jpeg' });
  }

  // 사진(base64) → 앱 사진 폴더에 업로드 → fileId 반환 (메타 생성 후 미디어 PATCH 2단계)
  async function uploadPhoto(name, base64, mime) {
    const folderId = await ensurePhotoFolder();
    const metaRes = await _authedFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || '다챙이 사진.jpg', parents: [folderId], mimeType: mime || 'image/jpeg' }),
    });
    if (!metaRes.ok) throw new Error(`사진 파일 생성 실패 (${metaRes.status})`);
    const { id } = await metaRes.json();
    const upRes = await _authedFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': mime || 'image/jpeg' },
      body: _b64ToBlob(base64, mime),
    });
    if (!upRes.ok) {
      // 바이트 업로드 실패 시 메타만 생성된 0바이트 고아 파일을 정리하고 실패 처리
      try { await _authedFetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' }); } catch (_) {}
      throw new Error(`사진 업로드 실패 (${upRes.status})`);
    }
    return id;
  }

  function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  // thumbnailLink의 크기 접미사(=s220 / =w..-h..)를 원하는 size로 교체
  function _resizeThumbLink(link, size) {
    if (/=s\d+(-c)?$/.test(link)) return link.replace(/=s\d+(-c)?$/, `=s${size}`);
    if (/=w\d+-h\d+(-c)?$/.test(link)) return link.replace(/=w\d+-h\d+(-c)?$/, `=s${size}`);
    return link + (link.indexOf('=') === -1 ? `=s${size}` : '');
  }

  // 썸네일 표시용 data URL.
  //  1순위: 드라이브 서버 렌더 썸네일(thumbnailLink) → 포맷 무관(HEIC도 JPEG로 변환)·고화질. /api/photo 프록시 경유(CORS 회피).
  //  2순위(폴백): 원본 다운로드 후 캔버스 다운스케일(HEIC는 PC에서 디코딩 실패 가능).
  async function fetchThumbDataUrl(fileId, maxDim) {
    const size = maxDim || 1024;
    try {
      const meta = await REST.driveGet(fileId, 'thumbnailLink');
      if (meta && meta.thumbnailLink) {
        const link = _resizeThumbLink(meta.thumbnailLink, size);
        const res = await fetch(`/api/photo?url=${encodeURIComponent(link)}`, {
          headers: { Authorization: `Bearer ${Auth.getToken()}` },
        });
        if (res.ok) {
          const blob = await res.blob();
          if ((blob.type || '').indexOf('image/') === 0) return await _blobToDataUrl(blob);
        }
        console.warn('[Drive] thumbnailLink 응답 비정상, 원본 폴백');
      }
    } catch (e) { console.warn('[Drive] thumbnailLink 실패, 원본 폴백:', e.message || e); }
    // 폴백: 원본 → 캔버스 다운스케일
    const { mime, data } = await fetchImageBase64(fileId, size);
    return `data:${mime};base64,${data}`;
  }

  return { findMonthFolder, listImages, filterByDate, selectByResolution, fetchImageBase64, fetchThumbDataUrl, photoDateStr, uploadPhoto, ensurePhotoFolder };
})();
