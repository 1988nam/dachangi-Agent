/**
 * 다챙이 - Google REST 직접 호출(OAuth Bearer). API 키/디스커버리 의존 제거.
 *   (API 키 HTTP 리퍼러 제한과 무관하게 동작)
 */
const REST = (() => {
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const SHEETS = 'https://sheets.googleapis.com/v4';

  async function _req(method, url, body) {
    const token = (typeof Auth !== 'undefined' && Auth.getToken) ? Auth.getToken() : null;
    if (!token) throw new Error('로그인이 필요합니다(액세스 토큰 없음).');
    const opt = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    if (!res.ok) {
      let t = ''; try { t = await res.text(); } catch (_) {}
      throw new Error(`Google API 오류 (${res.status}) ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.indexOf('application/json') !== -1 ? res.json() : res.text();
  }

  return {
    // Drive
    driveList: (params) => _req('GET', `${DRIVE}/files?${new URLSearchParams(params).toString()}`),
    driveExportText: (fileId) => _req('GET', `${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent('text/plain')}`),
    // Sheets
    sheetGet: (id, fields) => _req('GET', `${SHEETS}/spreadsheets/${id}${fields ? `?fields=${encodeURIComponent(fields)}` : ''}`),
    valuesGet: (id, range) => _req('GET', `${SHEETS}/spreadsheets/${id}/values/${encodeURIComponent(range)}`),
    valuesUpdate: (id, range, values) => _req('PUT', `${SHEETS}/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values }),
    valuesAppend: (id, range, values) => _req('POST', `${SHEETS}/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values }),
    batchUpdate: (id, requests) => _req('POST', `${SHEETS}/spreadsheets/${id}:batchUpdate`, { requests }),
    createSpreadsheet: (resource) => _req('POST', `${SHEETS}/spreadsheets`, resource),
  };
})();
