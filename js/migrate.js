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
    const rawFolder = (cfg.DIARY_FOLDER_ID || '').trim();
    const folderId = REST.extractId(rawFolder);
    if (!folderId) throw new Error('설정에서 "기존 일기 문서 폴더 ID"를 입력하세요.');

    // 폴더 존재/접근 검증 → 어떤 ID로 실패했는지 명확히
    if (progressCb) progressCb(`📁 폴더 확인 중... (ID: ${folderId})`);
    try {
      const f = await REST.driveGet(folderId, 'id,name,mimeType');
      if (f.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error(`입력한 ID는 폴더가 아닙니다(${f.mimeType}). 폴더 ID를 넣어주세요.`);
      }
      if (progressCb) progressCb(`📁 폴더 확인됨: ${f.name}`);
    } catch (e) {
      throw new Error(`일기 문서 폴더를 찾을 수 없습니다. (입력값 "${rawFolder}" → ID "${folderId}")\n폴더 ID가 맞는지, 로그인한 계정에 그 폴더 접근 권한이 있는지 확인하세요.\n[원본 오류] ${e.message}`);
    }

    await DiaryStore.ensureSheet();
    const docs = await _listDocs(folderId);
    if (progressCb) progressCb(`📄 일기 문서 ${docs.length}개 발견`);
    if (docs.length === 0) return { docs: 0, parsed: 0, added: 0, skipped: 0, withPhoto: 0 };

    const photoMap = await _photoNameMap(REST.extractId(cfg.BEST_PHOTO_FOLDER_ID || ''));

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

  // ── 구글 폼 기록 시트(일자/운동/공부/주요활동/주간요약) → 일기 시트 이관 ─────────
  function _parseSheetRef(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    const idm = s.match(/\/spreadsheets\/d\/([\w-]+)/);
    const id = idm ? idm[1] : (/^[\w-]{20,}$/.test(s) ? s : null);
    if (!id) return null;
    const gm = s.match(/[#&?]gid=(\d+)/);
    return { id, gid: gm ? parseInt(gm[1], 10) : null };
  }
  function _formDate(s) { // '2020. 1. 13' / '2020-1-13' → '2020-01-13'
    const m = String(s || '').match(/(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  const _NOVAL = /^(안\s*함|아니오|아니요|no|n|x|없음|-|0)$/i;
  // 행 → 일기 엔트리. 주간 요약을 본문으로, 운동/공부/주요활동은 의미 있는 값일 때만 꼬리표 한 줄로.
  function formRowToEntry(cols, row) {
    const v = (k) => (cols[k] != null ? String(row[cols[k]] || '').trim() : '');
    const date = _formDate(v('date'));
    if (!date) return null;
    const summary = v('summary');
    const meta = [];
    const ex = v('exercise'), st = v('study'), ac = v('activity');
    if (ex && !_NOVAL.test(ex)) meta.push('운동: ' + ex);
    if (st && !_NOVAL.test(st)) meta.push('공부: ' + st);
    if (ac && summary.indexOf(ac) === -1) meta.push('활동: ' + ac); // 본문에 이미 언급되면 생략
    let text = summary;
    if (meta.length) text = (text ? text + '\n\n' : '') + '(' + meta.join(' / ') + ')';
    if (!text.trim()) return null;
    return { date, text: text.trim() };
  }
  // 시트 URL/ID를 받아 폼 기록을 일기 시트로 가져온다(이미 있는 날짜는 bulkAppend가 건너뜀).
  async function importFormSheet(ref) {
    const parsed = _parseSheetRef(ref);
    if (!parsed) throw new Error('시트 URL 또는 ID를 인식하지 못했습니다.');
    const meta = await REST.sheetGet(parsed.id, 'sheets.properties');
    const sheets = meta.sheets || [];
    if (!sheets.length) throw new Error('시트 탭을 찾을 수 없습니다.');
    const tab = (parsed.gid != null && sheets.find(s => s.properties.sheetId === parsed.gid)) || sheets[0];
    const title = String(tab.properties.title || '').replace(/'/g, "''");
    const res = await REST.valuesGet(parsed.id, `'${title}'!A1:Z`);
    const rows = res.values || [];
    if (rows.length < 2) throw new Error('데이터 행이 없습니다.');
    // 헤더에서 열 위치 탐색(느슨 매칭) — 열 순서가 바뀌어도 동작
    const head = rows[0].map(h => String(h || ''));
    const find = (re) => head.findIndex(h => re.test(h));
    const cols = {
      date: find(/일자|날짜/),
      summary: find(/요약|일기|내용/),
      exercise: find(/운동/), study: find(/공부/), activity: find(/활동/),
    };
    if (cols.date === -1) throw new Error('"일자" 열을 찾지 못했습니다. (헤더: ' + head.join(', ') + ')');
    if (cols.summary === -1) throw new Error('"주간 요약" 열을 찾지 못했습니다. (헤더: ' + head.join(', ') + ')');
    Object.keys(cols).forEach(k => { if (cols[k] === -1) cols[k] = null; });
    const entries = rows.slice(1).map(r => formRowToEntry(cols, r)).filter(Boolean);
    if (!entries.length) throw new Error('가져올 수 있는 기록이 없습니다(일자/내용 비어 있음).');
    const { added, skipped } = await DiaryStore.bulkAppend(entries);
    return { rows: rows.length - 1, parsed: entries.length, added, skipped };
  }

  return { run, parseDoc, importFormSheet, formRowToEntry };
})();
