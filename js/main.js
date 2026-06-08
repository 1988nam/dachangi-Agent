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

let _entriesCache = [];
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function onLoginSuccess(user) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('user-name').textContent = user?.name || '';
  const cfg = window.DACHANGI_CONFIG || {};
  const hint = document.getElementById('folder-hint');
  if (hint) {
    if ((cfg.PHOTO_SOURCE || 'photos') === 'photos') {
      hint.innerHTML = '📷 <b>구글 포토</b>에서 직접 사진을 골라 일기를 만듭니다. <code>✍️ 일기 생성</code>을 누르면 포토 선택 창이 열립니다(드라이브 설정 불필요).';
    } else {
      hint.innerHTML = cfg.MAIN_PHOTO_FOLDER_ID
        ? `메인 폴더 안의 <code>${'{yyyy-MM}'}</code> 폴더에서 선택한 날짜의 사진을 찾습니다.`
        : '⚠️ 설정에서 <b>사진 메인 폴더 ID</b>를 먼저 입력하세요.';
    }
  }
  showWrite();
  renderMonthList();
}

// ── 뷰 전환 ───────────────────────────────────────────────
function showWrite() {
  document.getElementById('view-write').classList.remove('hidden');
  document.getElementById('view-month').classList.add('hidden');
  document.querySelectorAll('.side-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'write'));
  document.querySelectorAll('.month-row').forEach(b => b.classList.remove('active'));
}
function _showMonthView() {
  document.getElementById('view-write').classList.add('hidden');
  document.getElementById('view-month').classList.remove('hidden');
  document.querySelectorAll('.side-item').forEach(b => b.classList.remove('active'));
}

// 엔트리 카드 HTML (월 뷰·검색 공용). data-date로 특정 일기 펼침 가능.
function _entryCardsHtml(entries) {
  if (!entries.length) return '<div class="hint">일기가 없습니다.</div>';
  return entries.map(e => {
    const preview = _esc(e.text).slice(0, 140);
    // 시트에 저장된 썸네일(포토 소스)은 바로 렌더, 없으면 드라이브 ID로 펼칠 때 lazy 로드
    const photoHtml = e.thumb
      ? `<img src="data:image/jpeg;base64,${e.thumb}" style="max-width:360px; width:100%; border-radius:10px; border:1px solid var(--border);" />`
      : '';
    return `
      <div class="diary-entry hist-item" data-date="${_esc(e.date)}" data-best="${_esc(e.bestPhotoId)}" data-expanded="0">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>📅 ${_esc(e.date)}</strong>
          <span class="hist-arrow" style="color:var(--text-muted); font-size:12px;">▼</span>
        </div>
        <div class="hist-preview" style="color:var(--text-secondary); font-size:13px; margin-top:6px;">${preview}${e.text.length > 140 ? '…' : ''}</div>
        <div class="hist-full" style="display:none; margin-top:10px;">
          <div class="hist-photo" style="margin-bottom:10px;"${e.thumb ? ' data-loaded="1"' : ''}>${photoHtml}</div>
          <div style="white-space:pre-wrap; line-height:1.7; font-size:14px;">${_esc(e.text)}</div>
        </div>
      </div>`;
  }).join('');
}

// 달력 그리드 렌더 (일기 있는 날 강조·클릭)
function _renderCalendar(month, entries) {
  const cal = document.getElementById('month-calendar');
  if (!cal) return;
  cal.style.display = '';
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) { cal.style.display = 'none'; return; }
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const has = new Set(entries.map(e => e.date));
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${month}-${String(d).padStart(2, '0')}`;
    cells += `<div class="cal-cell${has.has(ds) ? ' has' : ''}" data-date="${ds}">${d}</div>`;
  }
  cal.innerHTML = `<div class="cal-head">${dows.map(x => `<div>${x}</div>`).join('')}</div><div class="cal-grid">${cells}</div>`;
  cal.querySelectorAll('.cal-cell.has').forEach(c => c.addEventListener('click', () => showDate(c.dataset.date)));
}

function showMonth(month) {
  _showMonthView();
  document.querySelectorAll('.month-row').forEach(b => b.classList.toggle('active', b.dataset.month === month));
  document.querySelectorAll('.date-item').forEach(b => b.classList.remove('active'));
  document.getElementById('month-title').textContent = `📚 ${month}`;
  const entries = _entriesCache.filter(e => (e.date || '').slice(0, 7) === month);
  _renderCalendar(month, entries);
  // 월 뷰는 '달력만' 표시. 개별 일기는 달력의 날짜(또는 왼쪽 날짜)를 클릭해야 단독으로 나옴.
  document.getElementById('month-diaries').innerHTML = entries.length
    ? `<div class="hint" style="text-align:center; padding:10px;">📅 달력에서 <b>색칠된 날짜</b>를 클릭하면 그날 일기를 봅니다. (이 달 일기 ${entries.length}건)</div>`
    : '<div class="hint">이 달에 저장된 일기가 없습니다.</div>';
}

// 특정 날짜의 일기만 단독 표시 (달력 숨김, 본문엔 그 하루만)
async function showDate(date) {
  _showMonthView();
  const search = document.getElementById('diary-search'); if (search) search.value = '';
  document.querySelectorAll('.month-row').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.date-item').forEach(b => b.classList.toggle('active', b.dataset.date === date));
  const cal = document.getElementById('month-calendar'); if (cal) cal.style.display = 'none';
  document.getElementById('month-title').textContent = `📅 ${date}`;
  const entry = _entriesCache.find(e => e.date === date);
  const box = document.getElementById('month-diaries');
  if (!entry) { box.innerHTML = '<div class="hint">해당 날짜의 일기가 없습니다.</div>'; return; }
  box.innerHTML = _entryCardsHtml([entry]);
  const item = box.querySelector('.hist-item');
  if (item) await _toggleEntry(item); // 단독 표시이므로 바로 펼침
}

// 엔트리 카드 펼치기/접기(+대표 사진 lazy 로드)
async function _toggleEntry(item) {
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
}

// 키워드 검색 (본문/날짜)
function renderSearch(q) {
  q = (q || '').trim();
  if (!q) { showWrite(); document.getElementById('diary-search').value = ''; return; }
  _showMonthView();
  document.querySelectorAll('.month-row').forEach(b => b.classList.remove('active'));
  document.getElementById('month-calendar').style.display = 'none';
  const lq = q.toLowerCase();
  const matches = _entriesCache.filter(e => (e.text || '').toLowerCase().includes(lq) || (e.date || '').includes(q));
  document.getElementById('month-title').textContent = `🔍 "${q}" 검색 결과 (${matches.length}건)`;
  document.getElementById('month-diaries').innerHTML = matches.length ? _entryCardsHtml(matches) : '<div class="hint">일치하는 일기가 없습니다.</div>';
}

// 사이드바 월별 트리 (월 → 날짜). 시트에서 로드.
async function renderMonthList() {
  const listEl = document.getElementById('month-list');
  if (!listEl || typeof DiaryStore === 'undefined') return;
  listEl.innerHTML = '<div class="hint" style="padding:6px 4px;">⏳ 불러오는 중...</div>';
  try { _entriesCache = await DiaryStore.loadEntries(); }
  catch (e) { listEl.innerHTML = `<div class="hint" style="padding:6px 4px; color:var(--red)">❌ ${_esc(e.message || e)}</div>`; return; }
  if (!_entriesCache.length) { listEl.innerHTML = '<div class="hint" style="padding:6px 4px;">저장한 일기 없음.<br/>일기를 만들고 💾 저장하세요.</div>'; return; }
  const byMonth = {};
  _entriesCache.forEach(e => { const m = (e.date || '').slice(0, 7); if (!m) return; (byMonth[m] = byMonth[m] || []).push(e.date); });
  const months = Object.keys(byMonth).sort().reverse();
  listEl.innerHTML = months.map(m => {
    const dates = byMonth[m].slice().sort().reverse();
    return `
      <div class="month-block">
        <button class="month-item month-row" data-month="${m}"><span><span class="month-caret">▸</span>${m}</span><span class="cnt">${dates.length}</span></button>
        <div class="date-sub" data-month="${m}">${dates.map(d => `<button class="date-item" data-date="${d}">${parseInt(d.slice(8), 10)}일</button>`).join('')}</div>
      </div>`;
  }).join('');
  listEl.querySelectorAll('.month-row').forEach(btn => btn.addEventListener('click', () => {
    const m = btn.dataset.month;
    const sub = listEl.querySelector(`.date-sub[data-month="${m}"]`);
    const caret = btn.querySelector('.month-caret');
    const open = sub.classList.toggle('open');
    if (caret) caret.textContent = open ? '▾' : '▸';
    showMonth(m);
  }));
  listEl.querySelectorAll('.date-item').forEach(btn => btn.addEventListener('click', () => showDate(btn.dataset.date)));
  // 월 뷰가 열려 있으면 갱신
  const mv = document.getElementById('view-month');
  if (mv && !mv.classList.contains('hidden') && !document.getElementById('diary-search').value.trim()) {
    const active = document.querySelector('.month-row.active');
    if (active) showMonth(active.dataset.month);
  }
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
  document.getElementById('side-settings').addEventListener('click', () => ConfigModal.open());
  document.getElementById('logout-btn').addEventListener('click', () => Auth.logout());
  // 사이드바 뷰 전환
  document.querySelector('.side-item[data-view="write"]').addEventListener('click', () => showWrite());
  document.getElementById('back-write').addEventListener('click', () => showWrite());
  document.getElementById('side-refresh').addEventListener('click', () => renderMonthList());
  document.getElementById('cfg-cancel').addEventListener('click', () => ConfigModal.close());
  document.getElementById('cfg-save').addEventListener('click', () => ConfigModal.save());
  document.getElementById('cfg-load-models').addEventListener('click', () => ConfigModal.loadModels());
  document.getElementById('cfg-export-btn').addEventListener('click', () => ConfigModal.exportConfig());
  document.getElementById('cfg-import-btn').addEventListener('click', () => ConfigModal.importConfig());

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
        thumb: last.bestThumb || '',
      });
      showToast('✅ 일기가 구글 시트에 저장되었습니다.');
      renderMonthList();
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
      renderMonthList();
    } catch (e) {
      console.error(e); log('❌ ' + (e.message || e));
      showToast('❌ 이관 실패: ' + (e.message || e), 'error');
    } finally { btn.disabled = false; btn.textContent = o; }
  });

  // 월별 일기 항목 펼치기/접기(사진 lazy 로드) — 이벤트 위임
  document.getElementById('month-diaries').addEventListener('click', (e) => {
    const item = e.target.closest('.hist-item');
    if (item) _toggleEntry(item);
  });

  // 일기 검색 (디바운스)
  const searchEl = document.getElementById('diary-search');
  if (searchEl) {
    let _t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(_t);
      _t = setTimeout(() => renderSearch(searchEl.value), 200);
    });
  }

  Auth.onLogin(onLoginSuccess);
  Auth.onLogout(onLogoutDone);
});
