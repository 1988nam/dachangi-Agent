/**
 * 다챙이 - 일기 저장소 (구글 시트를 DB로). 사진은 드라이브에 두고 ID만 저장.
 *   시트 탭 '일기' : [날짜, 일기, 대표사진ID, 사진ID목록, 생성시각, 대표썸네일(base64), 작성방식, 제목]
 *   대표썸네일: 구글 포토 소스는 baseUrl이 ~60분 만료되어 재참조 불가 →
 *     저장 시 작은 JPEG 썸네일을 시트에 직접 넣어 히스토리에서 그대로 표시(드라이브 불필요).
 *   작성방식(G열): '수동'=사용자가 직접 쓴 일기, 빈칸=AI(자동) 작성. 옛 행은 빈칸이라 자동으로 간주.
 *   제목(H열): Gemini가 본문을 압축한 10자 이내 짧은 제목(사이드바 날짜 옆 표시). 빈칸이면 미생성.
 *   모든 시트 호출은 REST(OAuth Bearer) — API 키/디스커버리 불필요.
 */
const DiaryStore = (() => {
  const TAB = '일기';
  const HEADER = ['날짜', '일기', '대표사진ID', '사진ID목록', '생성시각', '대표썸네일', '작성방식', '제목'];
  const LS_ID = 'dachangi_diary_sheet_id';
  const MAX_THUMB = 48000; // 시트 셀 한도(5만자) 안전 여유

  let _ensureP = null;            // ensureSheet 세션 캐시 — 동시 호출이 시트를 2개 만드는 경합 방지
  let _writeQ = Promise.resolve(); // 쓰기 직렬화 큐 — read-then-write 경합으로 같은 날짜 행 중복 방지

  function _serial(fn) {
    const r = _writeQ.then(fn, fn);
    _writeQ = r.catch(() => {});
    return r;
  }

  function currentSheetId() {
    const cfg = window.DACHANGI_CONFIG || {};
    const fromCfg = REST.extractId(cfg.DIARY_SHEET_ID || '');
    return fromCfg || localStorage.getItem(LS_ID) || '';
  }

  async function _ensureTab(sid) {
    const meta = await REST.sheetGet(sid, 'sheets.properties.title');
    const titles = (meta.sheets || []).map(s => s.properties.title);
    if (!titles.includes(TAB)) {
      await REST.batchUpdate(sid, [{ addSheet: { properties: { title: TAB } } }]);
      await REST.valuesUpdate(sid, `${TAB}!A1:H1`, [HEADER]);
    }
  }

  // 시트가 휴지통에 있으면 그대로 쓰다가 30일 후 일기 전체가 영구 삭제됨 — Drive 메타로 확인.
  //  Drive 조회 자체가 실패하면(공유 드라이브 권한 등) 휴지통 판단을 보류하고 접근성은 Sheets API(_ensureTab)에 맡긴다.
  async function _assertNotTrashed(sid) {
    let meta;
    try { meta = await REST.driveGet(sid, 'id,trashed'); }
    catch (_) { return; }
    if (meta && meta.trashed) throw new Error('일기 DB 시트가 휴지통에 있습니다. 드라이브 휴지통에서 복원하세요.');
  }

  async function _ensureImpl() {
    const cfg = window.DACHANGI_CONFIG || {};
    const fromCfg = REST.extractId(cfg.DIARY_SHEET_ID || '');
    const sidExisting = fromCfg || localStorage.getItem(LS_ID) || '';
    if (sidExisting) {
      try {
        await _assertNotTrashed(sidExisting);
        await _ensureTab(sidExisting);
        return sidExisting;
      } catch (e) {
        const msg = String((e && e.message) || e);
        // 설정에 명시한 시트는 사용자가 지정한 것 — 임의로 새로 만들지 않고 명확히 알림
        if (fromCfg) throw new Error(`설정의 일기 시트에 접근할 수 없습니다 — 삭제/휴지통/계정 권한을 확인하세요. [원본] ${msg}`);
        // 캐시(자동 생성) ID는 확정적 사용 불가일 때만 폴백해 새 시트를 만든다(끝의 setItem이 캐시를 덮어씀).
        //  · 휴지통 / 404(삭제·Drive 접근불가) / 403+권한거부(다른 계정 로그인 — Sheets는 이때 403 PERMISSION_DENIED)
        //  일시적 오류(네트워크·401만료·403쿼터·429·5xx)는 캐시를 보존한 채 그대로 전파 —
        //  빈 새 시트로 포크되어 기존 일기 히스토리가 사라지는 것을 막는다.
        const is403Perm = /\(403\)/.test(msg) && /permission|PERMISSION_DENIED|insufficient|forbidden/i.test(msg);
        const definitive = /휴지통/.test(msg) || /\(404\)/.test(msg) || is403Perm;
        if (!definitive) throw e;
        console.warn('[DiaryStore] 캐시된 시트 사용 불가(확정) → 새 시트 생성:', msg);
      }
    }
    const created = await REST.createSpreadsheet({ properties: { title: '다챙이 일기 DB' }, sheets: [{ properties: { title: TAB } }] });
    const sid = created.spreadsheetId;
    await REST.valuesUpdate(sid, `${TAB}!A1:H1`, [HEADER]);
    localStorage.setItem(LS_ID, sid);
    return sid;
  }

  // 시트 확보(없으면 자동 생성) → spreadsheetId 반환. 동시/반복 호출은 같은 프라미스 재사용.
  function ensureSheet() {
    if (!_ensureP) _ensureP = _ensureImpl().catch(e => { _ensureP = null; throw e; });
    return _ensureP;
  }

  // 전체 일기 로드(최신순)
  async function loadEntries() {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:H`);
    const rows = res.values || [];
    return rows.map((r, i) => ({
      rowIndex: i + 2,
      date: r[0] || '',
      text: r[1] || '',
      bestPhotoId: r[2] || '',
      photoIds: (r[3] || '').split(',').map(s => s.trim()).filter(Boolean),
      createdAt: r[4] || '',
      thumb: r[5] || '',
      type: (r[6] === '수동') ? 'manual' : '', // 빈칸/옛 행은 자동(AI) 작성으로 간주
      title: r[7] || '', // 빈칸이면 제목 미생성(백필 대상)
    })).filter(e => e.date).reverse();
  }

  // 정현체(직접 쓴 글) 학습 대상 판별 — 본인이 손으로 쓴 일기만 골라 문체·어투를 학습한다.
  //  ① type==='manual' : 📝 직접 쓰기 기능으로 작성(시트 G열 '수동').
  //  ② 2025-01-01 이전 옛 일기 : 수동 작성 기능 도입 전이라 type 표시가 없지만(빈칸),
  //     2020~2024 일기는 전부 정현이 직접 쓴 글이므로 학습에 포함한다(사용자 확인).
  //  2025년부터는 type==='manual'만 학습 대상 → 이후 AI 생성 일기가 섞여도 정현체 풀이 오염되지 않는다.
  function isHandwritten(e) {
    return !!e && (e.type === 'manual' || (!!e.date && e.date < '2025-01-01'));
  }

  // 같은 날짜 있으면 업데이트, 없으면 추가
  async function _saveEntryImpl(entry) {
    const sid = await ensureSheet();
    const thumb = (entry.thumb || '').length <= MAX_THUMB ? (entry.thumb || '') : '';
    const rowVals = [
      entry.date,
      (entry.text || '').slice(0, 45000),
      entry.bestPhotoId || '',
      (entry.photoIds || []).join(','),
      new Date().toLocaleString('ko-KR'),
      thumb,
      entry.type === 'manual' ? '수동' : '', // 자동(AI)은 빈칸
      (entry.title || '').slice(0, 40),      // 제목(보통 10자 이내, 방어적으로 40자 컷)
    ];
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const dates = (res.values || []).map(r => r[0]);
    const idx = dates.indexOf(entry.date);
    if (idx !== -1) {
      const row = idx + 2;
      await REST.valuesUpdate(sid, `${TAB}!A${row}:H${row}`, [rowVals]);
    } else {
      await REST.valuesAppend(sid, `${TAB}!A:H`, [rowVals]);
    }
    return { sheetId: sid };
  }

  // 여러 일기 일괄 추가(이관용). 이미 있는 날짜는 스킵. 날짜 오름차순.
  async function _bulkAppendImpl(entries) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const existing = new Set((res.values || []).map(r => r[0]));
    const now = new Date().toLocaleString('ko-KR');
    const seen = new Set();
    const sorted = (entries || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const rows = [];
    let skipped = 0;
    for (const e of sorted) {
      if (!e.date || existing.has(e.date) || seen.has(e.date)) { skipped++; continue; }
      seen.add(e.date);
      rows.push([e.date, (e.text || '').slice(0, 45000), e.bestPhotoId || '', (e.photoIds || []).join(','), now, '', e.type === 'manual' ? '수동' : '', (e.title || '').slice(0, 40)]);
    }
    if (rows.length) await REST.valuesAppend(sid, `${TAB}!A:H`, rows);
    return { added: rows.length, skipped };
  }

  // 탭의 숫자 sheetId(gid) 조회 — 행 삭제(deleteDimension)에 필요
  async function _tabSheetId(sid) {
    const meta = await REST.sheetGet(sid, 'sheets.properties');
    const sh = (meta.sheets || []).find(s => s.properties.title === TAB);
    return sh ? sh.properties.sheetId : null;
  }

  function _findRow(values, date) {
    const dates = (values || []).map(r => r[0]);
    return dates.indexOf(date); // 0-based(데이터 기준), 실제 시트행 = idx+2
  }

  // 일기 본문만 수정(사진/날짜 유지)
  async function _updateTextImpl(date, text) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const idx = _findRow(res.values, date);
    if (idx === -1) throw new Error('해당 날짜의 일기를 찾을 수 없습니다.');
    await REST.valuesUpdate(sid, `${TAB}!B${idx + 2}`, [[(text || '').slice(0, 45000)]]);
    return { row: idx + 2 };
  }

  // 제목만 수정(H열) — 본문/날짜/사진 유지. 백필 및 본문 수정 후 제목 갱신에 사용.
  async function _updateTitleImpl(date, title) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const idx = _findRow(res.values, date);
    if (idx === -1) throw new Error('해당 날짜의 일기를 찾을 수 없습니다.');
    await REST.valuesUpdate(sid, `${TAB}!H${idx + 2}`, [[(title || '').slice(0, 40)]]);
    return { row: idx + 2 };
  }

  // 여러 일기의 제목을 한 번에 기록(백필용). items: [{date, title}] → 한 번의 values:batchUpdate.
  //  날짜→행 매핑은 A2:A 1회 조회로 해결. 시트에 없는 날짜는 missing으로 집계.
  async function _bulkUpdateTitlesImpl(items) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const dates = (res.values || []).map(r => r[0]);
    const data = [];
    let missing = 0;
    for (const it of (items || [])) {
      const idx = dates.indexOf(it.date);
      if (idx === -1) { missing++; continue; }
      data.push({ range: `${TAB}!H${idx + 2}`, values: [[(it.title || '').slice(0, 40)]] });
    }
    if (data.length) await REST.valuesBatchUpdate(sid, data);
    return { updated: data.length, missing };
  }

  // 날짜 + 본문 수정. 새 날짜가 다른 일기와 겹치면 거부.
  async function _updateEntryImpl(oldDate, newDate, text) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const dates = (res.values || []).map(r => r[0]);
    const idx = dates.indexOf(oldDate);
    if (idx === -1) throw new Error('해당 날짜의 일기를 찾을 수 없습니다.');
    newDate = (newDate || oldDate).trim();
    if (newDate !== oldDate && dates.indexOf(newDate) !== -1) {
      throw new Error(`이미 ${newDate} 일기가 있습니다. 다른 날짜를 쓰거나 기존 일기를 먼저 지우세요.`);
    }
    const row = idx + 2;
    await REST.valuesUpdate(sid, `${TAB}!A${row}:B${row}`, [[newDate, (text || '').slice(0, 45000)]]);
    return { row, date: newDate };
  }

  // 대표 사진만 교체(본문/날짜 유지). C=bestPhotoId, F=썸네일 폴백
  async function _updatePhotoImpl(date, bestPhotoId, thumb) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const idx = _findRow(res.values, date);
    if (idx === -1) throw new Error('해당 날짜의 일기를 찾을 수 없습니다.');
    const row = idx + 2;
    await REST.valuesUpdate(sid, `${TAB}!C${row}`, [[bestPhotoId || '']]);
    await REST.valuesUpdate(sid, `${TAB}!F${row}`, [[((thumb || '').length <= MAX_THUMB) ? (thumb || '') : '']]);
    return { row };
  }

  // 일기 한 줄 삭제
  async function _deleteByDateImpl(date) {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const idx = _findRow(res.values, date);
    if (idx === -1) throw new Error('해당 날짜의 일기를 찾을 수 없습니다.');
    const sheetId = await _tabSheetId(sid);
    if (sheetId == null) throw new Error('일기 탭을 찾을 수 없습니다.');
    await REST.batchUpdate(sid, [{
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: idx + 1, endIndex: idx + 2 } },
    }]);
    return { deleted: date };
  }

  // 모든 쓰기는 직렬화 큐를 거친다 — 자동 저장 vs 💾 수동 저장 동시 실행 등으로 인한 중복 행 방지
  return {
    ensureSheet, loadEntries, currentSheetId, isHandwritten,
    saveEntry: (entry) => _serial(() => _saveEntryImpl(entry)),
    bulkAppend: (entries) => _serial(() => _bulkAppendImpl(entries)),
    updateText: (date, text) => _serial(() => _updateTextImpl(date, text)),
    updateTitle: (date, title) => _serial(() => _updateTitleImpl(date, title)),
    bulkUpdateTitles: (items) => _serial(() => _bulkUpdateTitlesImpl(items)),
    updateEntry: (oldDate, newDate, text) => _serial(() => _updateEntryImpl(oldDate, newDate, text)),
    updatePhoto: (date, bestPhotoId, thumb) => _serial(() => _updatePhotoImpl(date, bestPhotoId, thumb)),
    deleteByDate: (date) => _serial(() => _deleteByDateImpl(date)),
  };
})();
