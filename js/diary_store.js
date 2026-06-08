/**
 * 다챙이 - 일기 저장소 (구글 시트를 DB로). 사진은 드라이브에 두고 ID만 저장.
 *   시트 탭 '일기' : [날짜, 일기, 대표사진ID, 사진ID목록, 생성시각]
 *   DIARY_SHEET_ID 미설정 시 앱이 스프레드시트를 자동 생성하고 localStorage에 ID 보관.
 */
const DiaryStore = (() => {
  const TAB = '일기';
  const HEADER = ['날짜', '일기', '대표사진ID', '사진ID목록', '생성시각'];
  const LS_ID = 'dachangi_diary_sheet_id';

  function currentSheetId() {
    const cfg = window.DACHANGI_CONFIG || {};
    const fromCfg = (cfg.DIARY_SHEET_ID || '').trim();
    return fromCfg || localStorage.getItem(LS_ID) || '';
  }

  // Sheets API 클라이언트가 없으면 지연 로드. 실패 시 원인 안내.
  async function _ensureSheetsApi() {
    if (gapi.client && gapi.client.sheets) return;
    try { await gapi.client.load('https://sheets.googleapis.com/$discovery/rest?version=v4'); } catch (_) {}
    if (!gapi.client || !gapi.client.sheets) {
      throw new Error('구글 시트 API를 사용할 수 없습니다. GCP에서 "Google Sheets API"를 활성화하고, API 키 제한(API restrictions)에 Sheets API를 포함한 뒤 새로고침하세요.');
    }
  }

  async function _ensureTab(sid) {
    const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties.title' });
    const titles = (meta.result.sheets || []).map(s => s.properties.title);
    if (!titles.includes(TAB)) {
      await gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, resource: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
      await gapi.client.sheets.spreadsheets.values.update({ spreadsheetId: sid, range: `${TAB}!A1:E1`, valueInputOption: 'RAW', resource: { values: [HEADER] } });
    }
  }

  // 시트 확보(없으면 자동 생성) → spreadsheetId 반환
  async function ensureSheet() {
    await _ensureSheetsApi();
    let sid = currentSheetId();
    if (sid) { await _ensureTab(sid); return sid; }
    const created = await gapi.client.sheets.spreadsheets.create({
      resource: { properties: { title: '다챙이 일기 DB' }, sheets: [{ properties: { title: TAB } }] },
    });
    sid = created.result.spreadsheetId;
    await gapi.client.sheets.spreadsheets.values.update({ spreadsheetId: sid, range: `${TAB}!A1:E1`, valueInputOption: 'RAW', resource: { values: [HEADER] } });
    localStorage.setItem(LS_ID, sid);
    return sid;
  }

  // 전체 일기 로드(최신순)
  async function loadEntries() {
    const sid = await ensureSheet();
    const res = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${TAB}!A2:E` });
    const rows = res.result.values || [];
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
    const res = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${TAB}!A2:A` });
    const dates = (res.result.values || []).map(r => r[0]);
    const idx = dates.indexOf(entry.date);
    if (idx !== -1) {
      const row = idx + 2;
      await gapi.client.sheets.spreadsheets.values.update({ spreadsheetId: sid, range: `${TAB}!A${row}:E${row}`, valueInputOption: 'RAW', resource: { values: [rowVals] } });
    } else {
      await gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: sid, range: `${TAB}!A:E`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: [rowVals] } });
    }
    return { sheetId: sid };
  }

  // 여러 일기 일괄 추가(이관용). 이미 있는 날짜는 스킵. 날짜 오름차순으로 추가.
  async function bulkAppend(entries) {
    const sid = await ensureSheet();
    const res = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${TAB}!A2:A` });
    const existing = new Set((res.result.values || []).map(r => r[0]));
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
    if (rows.length) {
      await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: sid, range: `${TAB}!A:E`, valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS', resource: { values: rows },
      });
    }
    return { added: rows.length, skipped };
  }

  return { ensureSheet, loadEntries, saveEntry, bulkAppend, currentSheetId };
})();
