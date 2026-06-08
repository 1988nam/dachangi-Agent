/**
 * 다챙이 - 일기 저장소 (구글 시트를 DB로). 사진은 드라이브에 두고 ID만 저장.
 *   시트 탭 '일기' : [날짜, 일기, 대표사진ID, 사진ID목록, 생성시각]
 *   모든 시트 호출은 REST(OAuth Bearer) — API 키/디스커버리 불필요.
 */
const DiaryStore = (() => {
  const TAB = '일기';
  const HEADER = ['날짜', '일기', '대표사진ID', '사진ID목록', '생성시각'];
  const LS_ID = 'dachangi_diary_sheet_id';

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
      await REST.valuesUpdate(sid, `${TAB}!A1:E1`, [HEADER]);
    }
  }

  // 시트 확보(없으면 자동 생성) → spreadsheetId 반환
  async function ensureSheet() {
    let sid = currentSheetId();
    if (sid) { await _ensureTab(sid); return sid; }
    const created = await REST.createSpreadsheet({ properties: { title: '다챙이 일기 DB' }, sheets: [{ properties: { title: TAB } }] });
    sid = created.spreadsheetId;
    await REST.valuesUpdate(sid, `${TAB}!A1:E1`, [HEADER]);
    localStorage.setItem(LS_ID, sid);
    return sid;
  }

  // 전체 일기 로드(최신순)
  async function loadEntries() {
    const sid = await ensureSheet();
    const res = await REST.valuesGet(sid, `${TAB}!A2:E`);
    const rows = res.values || [];
    return rows.map((r, i) => ({
      rowIndex: i + 2,
      date: r[0] || '',
      text: r[1] || '',
      bestPhotoId: r[2] || '',
      photoIds: (r[3] || '').split(',').map(s => s.trim()).filter(Boolean),
      createdAt: r[4] || '',
    })).filter(e => e.date).reverse();
  }

  // 같은 날짜 있으면 업데이트, 없으면 추가
  async function saveEntry(entry) {
    const sid = await ensureSheet();
    const rowVals = [
      entry.date,
      (entry.text || '').slice(0, 45000),
      entry.bestPhotoId || '',
      (entry.photoIds || []).join(','),
      new Date().toLocaleString('ko-KR'),
    ];
    const res = await REST.valuesGet(sid, `${TAB}!A2:A`);
    const dates = (res.values || []).map(r => r[0]);
    const idx = dates.indexOf(entry.date);
    if (idx !== -1) {
      const row = idx + 2;
      await REST.valuesUpdate(sid, `${TAB}!A${row}:E${row}`, [rowVals]);
    } else {
      await REST.valuesAppend(sid, `${TAB}!A:E`, [rowVals]);
    }
    return { sheetId: sid };
  }

  // 여러 일기 일괄 추가(이관용). 이미 있는 날짜는 스킵. 날짜 오름차순.
  async function bulkAppend(entries) {
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
      rows.push([e.date, (e.text || '').slice(0, 45000), e.bestPhotoId || '', (e.photoIds || []).join(','), now]);
    }
    if (rows.length) await REST.valuesAppend(sid, `${TAB}!A:E`, rows);
    return { added: rows.length, skipped };
  }

  return { ensureSheet, loadEntries, saveEntry, bulkAppend, currentSheetId };
})();
