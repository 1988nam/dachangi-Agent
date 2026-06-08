/**
 * 다챙이 - 설정 모달 (localStorage 'dachangi_config')
 */
const ConfigModal = (() => {
  const KEY = 'dachangi_config';
  const FIELDS = {
    CLIENT_ID: 'cfg-client-id',
    API_KEY: 'cfg-api-key',
    GEMINI_API_KEY: 'cfg-gemini-key',
    GEMINI_MODEL: 'cfg-gemini-model',
    PHOTO_SOURCE: 'cfg-photo-source',
    MAIN_PHOTO_FOLDER_ID: 'cfg-main-folder',
    DIARY_SHEET_ID: 'cfg-diary-sheet',
    DIARY_FOLDER_ID: 'cfg-diary-folder',
    BEST_PHOTO_FOLDER_ID: 'cfg-best-folder',
    DIARY_PROMPT: 'cfg-prompt',
  };

  function _ensureModelOption(id) {
    if (!id) return;
    const sel = document.getElementById('cfg-gemini-model');
    if (!sel) return;
    if (![].slice.call(sel.options).some(o => o.value === id)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = id; sel.appendChild(o);
    }
  }

  function open() {
    const cfg = window.DACHANGI_CONFIG || {};
    for (const k in FIELDS) {
      const el = document.getElementById(FIELDS[k]);
      if (el) el.value = cfg[k] || '';
    }
    _ensureModelOption(cfg.GEMINI_MODEL);
    const sel = document.getElementById('cfg-gemini-model');
    if (sel && cfg.GEMINI_MODEL) sel.value = cfg.GEMINI_MODEL;
    const ob = document.getElementById('cfg-gemini-oauth');
    if (ob) ob.checked = !!cfg.GEMINI_USE_OAUTH;
    const st = document.getElementById('cfg-models-status'); if (st) st.textContent = '';
    document.getElementById('config-modal').classList.remove('hidden');
  }
  function close() { document.getElementById('config-modal').classList.add('hidden'); }

  function save() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) {}
    for (const k in FIELDS) {
      const el = document.getElementById(FIELDS[k]);
      if (el) stored[k] = (typeof el.value === 'string') ? el.value.trim() : el.value;
    }
    const ob = document.getElementById('cfg-gemini-oauth');
    stored.GEMINI_USE_OAUTH = !!(ob && ob.checked);
    localStorage.setItem(KEY, JSON.stringify(stored));
    showToast('✅ 설정 저장됨. 적용을 위해 새로고침합니다...');
    setTimeout(() => location.reload(), 900);
  }

  // '모델 불러오기' — 현재 인증(OAuth/키)으로 사용 가능한 모델을 드롭다운에 채움
  async function loadModels() {
    const status = document.getElementById('cfg-models-status');
    const btn = document.getElementById('cfg-load-models');
    if (status) { status.style.color = 'var(--text-muted)'; status.textContent = '⏳ 모델 불러오는 중...'; }
    if (btn) btn.disabled = true;
    try {
      const models = await GeminiAPI.listAvailableModels();
      const sel = document.getElementById('cfg-gemini-model');
      const cur = sel.value;
      sel.innerHTML = models.map(m =>
        `<option value="${m.id}">${m.id}${m.displayName ? ' — ' + m.displayName : ''}</option>`
      ).join('');
      if (cur && models.some(m => m.id === cur)) sel.value = cur;
      if (status) { status.style.color = 'var(--green)'; status.textContent = `✅ ${models.length}개 모델 로드됨 — 선택 후 저장`; }
    } catch (e) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = '❌ ' + (e.message || e); }
    } finally { if (btn) btn.disabled = false; }
  }

  // 현재 폼의 설정을 한 줄 Base64 코드로 → 클립보드 복사(다른 기기로 이동/백업)
  function exportConfig() {
    const config = {};
    for (const k in FIELDS) {
      const el = document.getElementById(FIELDS[k]);
      if (el) config[k] = (typeof el.value === 'string') ? el.value.trim() : el.value;
    }
    const ob = document.getElementById('cfg-gemini-oauth');
    config.GEMINI_USE_OAUTH = !!(ob && ob.checked);
    try {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
      const area = document.getElementById('cfg-io-area');
      if (area) { area.value = encoded; area.focus(); area.select(); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(encoded)
          .then(() => showToast('📤 설정이 클립보드에 복사되었습니다. 다른 기기 설정창에 붙여넣으세요.'))
          .catch(() => showToast('클립보드 복사 실패 — 아래 텍스트를 직접 복사하세요.', 'error'));
      } else {
        showToast('아래 텍스트를 직접 복사하세요.');
      }
    } catch (e) { showToast('❌ 설정 내보내기 실패: ' + (e.message || e), 'error'); }
  }

  // 붙여넣은 코드(Base64 또는 JSON)를 폼에 반영(저장은 별도 [저장] 클릭)
  function importConfig() {
    const area = document.getElementById('cfg-io-area');
    const raw = ((area && area.value) || '').trim();
    if (!raw) { showToast('가져올 설정 코드를 먼저 붙여넣으세요.', 'error'); return; }
    try {
      const jsonStr = raw.charAt(0) === '{' ? raw : decodeURIComponent(escape(atob(raw)));
      const parsed = JSON.parse(jsonStr);
      for (const k in FIELDS) {
        if (parsed[k] === undefined) continue;
        const el = document.getElementById(FIELDS[k]);
        if (el) el.value = parsed[k];
      }
      if (parsed.GEMINI_MODEL) {
        _ensureModelOption(parsed.GEMINI_MODEL);
        const sel = document.getElementById('cfg-gemini-model');
        if (sel) sel.value = parsed.GEMINI_MODEL;
      }
      const ob = document.getElementById('cfg-gemini-oauth');
      if (ob && parsed.GEMINI_USE_OAUTH !== undefined) ob.checked = !!parsed.GEMINI_USE_OAUTH;
      showToast('📥 설정을 폼에 반영했습니다. [저장]을 눌러 적용을 완료하세요.');
    } catch (e) { showToast('❌ 설정 분석 실패 — 코드를 확인하세요: ' + (e.message || e), 'error'); }
  }

  function hasValidConfig() {
    const cfg = window.DACHANGI_CONFIG || {};
    // 로그인엔 CLIENT_ID만 필요(Drive/Sheets는 OAuth Bearer로 직접 호출 → API 키 불필요)
    return !!(cfg.CLIENT_ID && cfg.CLIENT_ID.indexOf('YOUR_') !== 0);
  }

  return { open, close, save, hasValidConfig, loadModels, exportConfig, importConfig };
})();
