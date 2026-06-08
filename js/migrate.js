/**
 * 다챙이 - 기존 GAS 일기(드라이브 Google 문서) → 일기 시트 DB 이관
 *  문서명 'yyyy-MM 일기', 각 일기 = 날짜(헤딩) → (사진) → 본문 → (대표 사진 원본: 파일명)
 *  Drive로 text/plain export 후 파싱(보정), 대표사진 폴더에서 파일명→ID 매칭.
 */
const Migrate = (() => {
  async function _listDocs(folderId) {
    const out = []; let pt = '';
    for (let i = 0; i < 30; i++) {
      const params = { q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`, fields: 'nextPageToken, files(id,name)', pageSize: 200 };
      if (pt) params.pageToken = pt;
      const res = await REST.driveList(params);
      (res.files || []).forEach(f => out.push(f));
      pt = res.nextPageToken || ''; if (!pt) break;
    }
    // 이름순(yyyy-MM 일기) 정렬
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async function _exportText(fileId) {
    return (await REST.driveExportText(fileId)) || '';
  }

  // 텍스트 → [{date, text, photoName}] (보정 포함)
  function parseDoc(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const dateRe = /^\s*(\d{4}-\d{2}-\d{2})/;
    const photoRe = /^\(대표\s*사진\s*원본:\s*(.+?)\)\s*$/;
    const entries = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.replace(/\f/g, '').trim(); // 페이지구분(form feed) 제거
      const dm = line.match(dateRe);
      if (dm) {
        if (cur) entries.push(cur);
        cur = { date: dm[1], lines: [], photoName: '' };
        continue;
      }
      if (!cur) continue;
      const pm = line.match(photoRe);
      if (pm) { cur.photoName = pm[1].trim(); continue; }
      cur.lines.push(line);
    }
    if (cur) entries.push(cur);
    return entries.map(e => ({
      date: e.date,
      text: e.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
      photoName: e.photoName,
    })).filter(e => e.date && e.text);
  }

  // 대표사진 폴더의 파일명 → ID 맵 (사진 매칭용, 선택)
  async function _photoNameMap(folderId) {
    const map = {};
    if (!folderId) return map;
    try {
      let pt = '';
      for (let i = 0; i < 30; i++) {
        const params = { q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`, fields: 'nextPageToken, files(id,name)', pageSize: 1000 };
        if (pt) params.pageToken = pt;
        const res = await REST.driveList(params);
        (res.files || []).forEach(f => { if (f.name && map[f.name] === undefined) map[f.name] = f.id; });
        pt = res.nextPageToken || ''; if (!pt) break;
      }
    } catch (e) { console.warn('[Migrate] 대표사진 맵 로드 실패:', e); }
    return map;
  }

  async function run(progressCb) {
    const cfg = window.DACHANGI_CONFIG || {};
    const folderId = (cfg.DIARY_FOLDER_ID || '').trim();
    if (!folderId) throw new Error('설정에서 "기존 일기 문서 폴더 ID"를 입력하세요.');

    await DiaryStore.ensureSheet();
    const docs = await _listDocs(folderId);
    if (progressCb) progressCb(`📄 일기 문서 ${docs.length}개 발견`);
    if (docs.length === 0) return { docs: 0, parsed: 0, added: 0, skipped: 0, withPhoto: 0 };

    const photoMap = await _photoNameMap((cfg.BEST_PHOTO_FOLDER_ID || '').trim());

    const all = [];
    for (let d = 0; d < docs.length; d++) {
      if (progressCb) progressCb(`(${d + 1}/${docs.length}) ${docs[d].name} 파싱 중...`);
      let text = '';
      try { text = await _exportText(docs[d].id); }
      catch (e) { console.warn('[Migrate] export 실패:', docs[d].name, e); continue; }
      const entries = parseDoc(text);
      entries.forEach(e => {
        const bestPhotoId = (e.photoName && photoMap[e.photoName]) ? photoMap[e.photoName] : '';
        all.push({ date: e.date, text: e.text, bestPhotoId, photoIds: bestPhotoId ? [bestPhotoId] : [] });
      });
      if (progressCb) progressCb(`  · ${docs[d].name}: 일기 ${entries.length}건`);
    }

    const withPhoto = all.filter(e => e.bestPhotoId).length;
    if (progressCb) progressCb(`💾 시트에 일괄 저장 중... (파싱 ${all.length}건)`);
    const { added, skipped } = await DiaryStore.bulkAppend(all);
    return { docs: docs.length, parsed: all.length, added, skipped, withPhoto };
  }

  return { run, parseDoc };
})();
