/**
 * 다챙이 - Google REST 직접 호출(OAuth Bearer). API 키/디스커버리 의존 제거.
 *   (API 키 HTTP 리퍼러 제한과 무관하게 동작)
 */
const REST = (() => {
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const SHEETS = 'https://sheets.googleapis.com/v4';

  async function _req(method, url, body, _retried) {
    const token = (typeof Auth !== 'undefined' && Auth.getToken) ? Auth.getToken() : null;
    if (!token) throw new Error('로그인이 필요합니다(액세스 토큰 없음).');
    const opt = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    if (!res.ok) {
      // 토큰 만료(401): 한 번만 조용히 갱신 후 재시도
      if (res.status === 401 && !_retried && Auth.refreshToken) {
        try { await Auth.refreshToken(); }
        catch (_) { throw new Error('로그인이 만료되었습니다 — 로그아웃 후 다시 로그인해 주세요.'); }
        return _req(method, url, body, true);
      }
      let t = ''; try { t = await res.text(); } catch (_) {}
      throw new Error(`Google API 오류 (${res.status}) ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.indexOf('application/json') !== -1 ? res.json() : res.text();
  }

  // 드라이브/시트 URL을 붙여넣어도 ID만 추출. 순수 ID면 그대로.
  function extractId(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return '';
    let m = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/)
      || s.match(/\/d\/([a-zA-Z0-9_-]{10,})/)
      || s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    return s; // 이미 ID 형태로 간주
  }

  return {
    extractId,
    // Drive
    driveList: (params) => _req('GET', `${DRIVE}/files?${new URLSearchParams(params).toString()}`),
    driveGet: (id, fields) => _req('GET', `${DRIVE}/files/${id}?supportsAllDrives=true&fields=${encodeURIComponent(fields || 'id,name,mimeType')}`),
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
