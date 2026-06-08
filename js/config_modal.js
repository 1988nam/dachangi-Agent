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

  function hasValidConfig() {
    const cfg = window.DACHANGI_CONFIG || {};
    return !!(cfg.CLIENT_ID && cfg.CLIENT_ID.indexOf('YOUR_') !== 0
      && cfg.API_KEY && cfg.API_KEY.indexOf('YOUR_') !== 0);
  }

  return { open, close, save, hasValidConfig, loadModels };
})();
