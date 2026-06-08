/**
 * 다챙이 - 메인 (이벤트 연결, 로그인 흐름)
 */
let _toastTimer = null;
function showToast(msg, type) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show' + (type === 'error' ? ' error' : '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

function _todayMinus(days) {
  const d = new Date(Date.now() - days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function onLoginSuccess(user) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('user-name').textContent = user?.name || '';
  const cfg = window.DACHANGI_CONFIG || {};
  const hint = document.getElementById('folder-hint');
  if (hint) hint.innerHTML = cfg.MAIN_PHOTO_FOLDER_ID
    ? `메인 폴더 안의 <code>${'{yyyy-MM}'}</code> 폴더에서 선택한 날짜의 사진을 찾습니다.`
    : '⚠️ 설정에서 <b>사진 메인 폴더 ID</b>를 먼저 입력하세요.';
  renderHistory();
}

// 일기 히스토리 렌더 (구글 시트 '일기' DB, 최신순). 펼칠 때 대표 사진 lazy 로드.
async function renderHistory() {
  const listEl = document.getElementById('history-list');
  if (!listEl || typeof DiaryStore === 'undefined') return;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  listEl.innerHTML = '<div class="hint">⏳ 불러오는 중...</div>';
  let entries = [];
  try { entries = await DiaryStore.loadEntries(); }
  catch (e) { listEl.innerHTML = `<div class="hint" style="color:var(--red)">❌ ${esc(e.message || e)}</div>`; return; }
  if (!entries.length) { listEl.innerHTML = '<div class="hint">저장한 일기가 없습니다. 일기를 생성하고 💾 시트에 저장하세요.</div>'; return; }
  listEl.innerHTML = entries.map(e => {
    const preview = esc(e.text).slice(0, 120);
    return `
      <div class="hist-item" data-best="${esc(e.bestPhotoId)}" data-expanded="0" style="border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:10px; cursor:pointer;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>📅 ${esc(e.date)}</strong>
          <span class="hist-arrow" style="color:var(--text-muted); font-size:12px;">▼</span>
        </div>
        <div class="hist-preview" style="color:var(--text-secondary); font-size:13px; margin-top:6px;">${preview}${e.text.length > 120 ? '…' : ''}</div>
        <div class="hist-full" style="display:none; margin-top:10px;">
          <div class="hist-photo" style="margin-bottom:10px;"></div>
          <div style="white-space:pre-wrap; line-height:1.7; font-size:14px;">${esc(e.text)}</div>
        </div>
      </div>`;
  }).join('');
}

function onLogoutDone() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function _runFromUI() {
  Auth && DiaryAgent.run({
    dateStr: document.getElementById('diary-date').value,
    candCount: parseInt(document.getElementById('cand-count').value, 10) || 10,
    topCount: parseInt(document.getElementById('top-count').value, 10) || 3,
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // 날짜 기본값: 어제
  const dateEl = document.getElementById('diary-date');
  if (dateEl) dateEl.value = _todayMinus(1);

  // 로그인/설정
  document.getElementById('login-btn').addEventListener('click', () => {
    if (!ConfigModal.hasValidConfig()) {
      showToast('먼저 ⚙️ 설정에서 CLIENT_ID / API Key를 입력하세요.', 'error');
      ConfigModal.open();
      return;
    }
    Auth.login();
  });
  document.getElementById('login-config-btn').addEventListener('click', () => ConfigModal.open());
  document.getElementById('config-btn').addEventListener('click', () => ConfigModal.open());
  document.getElementById('logout-btn').addEventListener('click', () => Auth.logout());
  document.getElementById('cfg-cancel').addEventListener('click', () => ConfigModal.close());
  document.getElementById('cfg-save').addEventListener('click', () => ConfigModal.save());
  document.getElementById('cfg-load-models').addEventListener('click', () => ConfigModal.loadModels());

  // 생성
  document.getElementById('generate-btn').addEventListener('click', _runFromUI);
  document.getElementById('regenerate-btn').addEventListener('click', _runFromUI);

  // 결과 액션
  document.getElementById('copy-btn').addEventListener('click', async () => {
    const t = document.getElementById('diary-text').value;
    try { await navigator.clipboard.writeText(t); showToast('📋 복사됨'); }
    catch (_) { showToast('복사 실패 — 직접 선택해 복사하세요.', 'error'); }
  });
  document.getElementById('download-btn').addEventListener('click', () => {
    const t = document.getElementById('diary-text').value;
    const date = document.getElementById('diary-date').value || 'diary';
    const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${date} 일기.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 시트에 저장
  document.getElementById('save-diary-btn').addEventListener('click', async () => {
    const last = DiaryAgent.getLast();
    if (!last) { showToast('먼저 일기를 생성하세요.', 'error'); return; }
    const text = document.getElementById('diary-text').value;
    const btn = document.getElementById('save-diary-btn'); const o = btn.textContent;
    btn.disabled = true; btn.textContent = '💾 저장 중...';
    try {
      await DiaryStore.saveEntry({
        date: last.dateStr, text,
        bestPhotoId: (last.topImages[0] || {}).id || '',
        photoIds: last.topImages.map(t => t.id).filter(Boolean),
      });
      showToast('✅ 일기가 구글 시트에 저장되었습니다.');
      renderHistory();
    } catch (e) { console.error(e); showToast('❌ 저장 실패: ' + (e.message || e), 'error'); }
    finally { btn.disabled = false; btn.textContent = o; }
  });

  // 기존 일기 문서 → 시트 이관
  document.getElementById('migrate-btn').addEventListener('click', async () => {
    const cfg = window.DACHANGI_CONFIG || {};
    if (!cfg.DIARY_FOLDER_ID) { showToast('설정에서 "기존 일기 문서 폴더 ID"를 먼저 입력하세요.', 'error'); ConfigModal.open(); return; }
    if (!confirm('기존 일기 문서들을 스캔하여 일기 시트로 이관합니다.\n이미 있는 날짜는 건너뜁니다. 진행할까요?')) return;
    const btn = document.getElementById('migrate-btn'); const o = btn.textContent;
    const prog = document.getElementById('migrate-progress');
    btn.disabled = true; btn.textContent = '📥 이관 중...';
    const log = (m) => { if (prog) prog.textContent = m; };
    try {
      const r = await Migrate.run(log);
      log('');
      showToast(`✅ 이관 완료: 문서 ${r.docs}개 → 일기 ${r.added}건 추가(중복 ${r.skipped} 스킵, 사진매칭 ${r.withPhoto})`);
      renderHistory();
    } catch (e) {
      console.error(e); log('❌ ' + (e.message || e));
      showToast('❌ 이관 실패: ' + (e.message || e), 'error');
    } finally { btn.disabled = false; btn.textContent = o; }
  });

  // 히스토리 새로고침 + 항목 펼치기/접기(사진 lazy 로드)
  document.getElementById('history-refresh').addEventListener('click', () => renderHistory());
  document.getElementById('history-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.hist-item');
    if (!item) return;
    const expanded = item.getAttribute('data-expanded') === '1';
    item.setAttribute('data-expanded', expanded ? '0' : '1');
    item.querySelector('.hist-preview').style.display = expanded ? '' : 'none';
    item.querySelector('.hist-full').style.display = expanded ? 'none' : '';
    item.querySelector('.hist-arrow').textContent = expanded ? '▼' : '▲';
    if (!expanded) {
      const best = item.getAttribute('data-best');
      const ph = item.querySelector('.hist-photo');
      if (best && ph && !ph.dataset.loaded) {
        ph.dataset.loaded = '1';
        ph.innerHTML = '<span class="hint">🖼️ 사진 불러오는 중...</span>';
        try { const url = await DriveAPI.fetchThumbDataUrl(best, 360); ph.innerHTML = `<img src="${url}" style="max-width:360px; width:100%; border-radius:10px; border:1px solid var(--border);" />`; }
        catch (_) { ph.innerHTML = '<span class="hint">사진을 불러오지 못했습니다(삭제/권한).</span>'; }
      }
    }
  });

  Auth.onLogin(onLoginSuccess);
  Auth.onLogout(onLogoutDone);
});
