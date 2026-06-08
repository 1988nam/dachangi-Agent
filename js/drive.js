/**
 * 다챙이 - 구글 드라이브 연동 (사진 조회 + 이미지 base64 변환)
 */
const DriveAPI = (() => {
  // 메인 폴더 안에서 'yyyy-MM' 월별 폴더 찾기
  async function findMonthFolder(mainFolderId, monthStr) {
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
      // EXIF: 'yyyy:MM:dd HH:mm:ss' → 'yyyy-MM-dd'
      return photo.exifTime.slice(0, 10).replace(/:/g, '-');
    }
    if (photo.createdTime) return photo.createdTime.slice(0, 10);
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
    const token = Auth.getToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
      // HEIC 등 디코딩 불가 → 원본 바이트 전송
      const buf = await blob.arrayBuffer();
      let mime = (blob.type || 'image/jpeg').toLowerCase();
      if (mime === 'image/webp') mime = 'image/jpeg';
      return { mime, data: _abToBase64(buf) };
    }
  }

  // 썸네일 표시용 data URL (작게)
  async function fetchThumbDataUrl(fileId, maxDim) {
    const { mime, data } = await fetchImageBase64(fileId, maxDim || 240);
    return `data:${mime};base64,${data}`;
  }

  return { findMonthFolder, listImages, filterByDate, selectByResolution, fetchImageBase64, fetchThumbDataUrl, photoDateStr };
})();
