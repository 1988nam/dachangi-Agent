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
let _stagedPersonPhoto = '';

// 모바일 사이드바(오프캔버스) 토글
function _openSidebar() {
  const sb = document.querySelector('.sidebar'); if (sb) sb.classList.add('open');
  const ov = document.getElementById('sidebar-overlay'); if (ov) ov.classList.add('show');
}
function _closeSidebar() {
  const sb = document.querySelector('.sidebar'); if (sb) sb.classList.remove('open');
  const ov = document.getElementById('sidebar-overlay'); if (ov) ov.classList.remove('show');
}
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── 연속기록·통계 ──────────────────────────────────────────
function _computeStats(entries) {
  const dates = new Set((entries || []).map(e => e.date).filter(Boolean));
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ym = `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  let monthCount = 0;
  dates.forEach(d => { if (d.slice(0, 7) === ym) monthCount++; });
  // 연속 기록: 오늘(없으면 어제)부터 거꾸로 연속된 날 수
  const fmt = (dt) => `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  let streak = 0;
  const cur = new Date();
  if (!dates.has(fmt(cur))) cur.setDate(cur.getDate() - 1);
  while (dates.has(fmt(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
  return { total: dates.size, monthCount, daysInMonth, streak };
}
function renderStats() {
  const el = document.getElementById('stats-bar');
  if (!el) return;
  const entries = _entriesCache || [];
  if (!entries.length) { el.style.display = 'none'; return; }
  const s = _computeStats(entries);
  el.style.display = '';
  el.innerHTML =
    `<div class="stat-chip"><span class="stat-num">🔥 ${s.streak}</span><span class="stat-label">연속 기록(일)</span></div>` +
    `<div class="stat-chip"><span class="stat-num">${s.monthCount}/${s.daysInMonth}</span><span class="stat-label">이번 달 채움</span></div>` +
    `<div class="stat-chip"><span class="stat-num">📚 ${s.total}</span><span class="stat-label">전체 일기</span></div>`;
}

// ── 전체 백업 내보내기 ─────────────────────────────────────
function _downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function _exportStamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function _sortedEntries() {
  return (_entriesCache || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
function exportDiariesMarkdown() {
  const entries = _sortedEntries();
  if (!entries.length) { showToast('내보낼 일기가 없습니다.', 'error'); return; }
  const _brandTitle = (window.APP_BRAND && window.APP_BRAND.exportTitle) || '다챙이 일기';
  let md = `# ${_brandTitle} (${entries.length}편)\n\n`;
  entries.forEach(e => { md += `## ${e.date}\n\n${e.text || ''}\n\n---\n\n`; });
  _downloadFile(`${_brandTitle} ${_exportStamp()}.md`, md, 'text/markdown');
  showToast(`📝 ${entries.length}편을 Markdown으로 내보냈습니다.`);
}
function exportDiariesJson() {
  const entries = _sortedEntries().map(e => ({
    date: e.date, text: e.text, bestPhotoId: e.bestPhotoId || '', photoIds: e.photoIds || [], createdAt: e.createdAt || '',
  }));
  if (!entries.length) { showToast('내보낼 일기가 없습니다.', 'error'); return; }
  const _brandTitle = (window.APP_BRAND && window.APP_BRAND.exportTitle) || '다챙이 일기';
  const payload = { app: 'dachangi', exportedAt: new Date().toISOString(), count: entries.length, entries };
  _downloadFile(`${_brandTitle} ${_exportStamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  showToast(`🧩 ${entries.length}편을 JSON으로 내보냈습니다.`);
}

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
  // 일괄 생성: 드라이브 소스일 때만 기간 입력을 보여줌(포토는 창에서 다중 선택)
  const batchRange = document.getElementById('batch-drive-range');
  if (batchRange) batchRange.style.display = ((cfg.PHOTO_SOURCE || 'photos') === 'drive') ? '' : 'none';
  showWrite();
  renderMonthList();
  updatePeopleBadge();
}

// ── 뷰 전환 ───────────────────────────────────────────────
function showWrite() {
  document.getElementById('view-write').classList.remove('hidden');
  document.getElementById('view-month').classList.add('hidden');
  document.getElementById('view-people').classList.add('hidden');
  document.querySelectorAll('.side-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'write'));
  document.querySelectorAll('.month-row').forEach(b => b.classList.remove('active'));
  _closeSidebar();
}
function _showMonthView() {
  document.getElementById('view-write').classList.add('hidden');
  document.getElementById('view-people').classList.add('hidden');
  document.getElementById('view-month').classList.remove('hidden');
  document.querySelectorAll('.side-item').forEach(b => b.classList.remove('active'));
}
function showPeople() {
  document.getElementById('view-write').classList.add('hidden');
  document.getElementById('view-month').classList.add('hidden');
  document.getElementById('view-people').classList.remove('hidden');
  document.querySelectorAll('.side-item').forEach(b => b.classList.remove('active'));
  const sp = document.getElementById('side-people'); if (sp) sp.classList.add('active');
  document.querySelectorAll('.month-row').forEach(b => b.classList.remove('active'));
  _closeSidebar();
  renderPeopleList();
}

// 파일 → 작은 정사각 JPEG 썸네일 base64 (인물 얼굴 저장용)
function _fileToThumb(file, maxDim) {
  maxDim = maxDim || 256;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.8).split(',')[1] || '');
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// 메뉴 뱃지(미확인 인물 수) 갱신
async function updatePeopleBadge() {
  const badge = document.getElementById('people-badge');
  if (!badge || typeof PeopleStore === 'undefined') return;
  try {
    const n = await PeopleStore.countPending();
    if (n > 0) { badge.textContent = n; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  } catch (_) {}
}

// 인물 목록 렌더 — 미확인(확인 필요) 섹션 + 등록된 인물 섹션
async function renderPeopleList() {
  const box = document.getElementById('people-list');
  if (!box || typeof PeopleStore === 'undefined') return;
  box.innerHTML = '<div class="hint">⏳ 불러오는 중...</div>';
  let people;
  try { people = await PeopleStore.loadPeople(); }
  catch (e) { box.innerHTML = `<div class="hint" style="color:var(--red)">❌ ${_esc(e.message || e)}</div>`; return; }
  const pending = people.filter(p => p.status === 'pending'); // 이름 없고 2회+ 감지 → 확인 필요
  const known = people.filter(p => p.status === 'named');      // 관찰중(observed)은 숨김

  let html = '';
  if (pending.length) {
    html += `<div class="hint" style="margin:2px 0 8px; color:var(--amber);">🔔 확인 필요 — 자주 등장한 인물입니다. 이름과 그룹을 입력하세요.</div>`;
    html += pending.map(p => `
      <div class="person-row pending" data-row="${p.rowIndex}">
        <img class="person-face" src="${p.photo ? `data:image/jpeg;base64,${p.photo}` : ''}" alt="" />
        <div class="person-info" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          <input type="text" class="pend-name" placeholder="이름" style="width:100px;" />
          <input type="text" class="pend-rel" placeholder="관계(선택)" style="width:100px;" />
          ${_groupSelectHtml('pend-group', '')}
          <button class="btn pend-save" style="padding:6px 12px;">저장</button>
        </div>
        <button class="btn btn-ghost person-del" style="padding:6px 10px;" title="이 사람이 아니면 삭제">🗑️</button>
      </div>`).join('');
  }
  if (known.length) {
    const order = PeopleStore.GROUPS.concat(['']); // 가족, 친구, 직장, (미분류)
    order.forEach(g => {
      const members = known.filter(p => (p.group || '') === g);
      if (!members.length) return;
      html += `<div class="side-sec" style="padding:14px 2px 6px;">${g || '미분류'} <span style="color:var(--text-muted)">(${members.length})</span></div>`;
      html += members.map(p => `
        <div class="person-row" data-row="${p.rowIndex}">
          <img class="person-face" src="${p.photo ? `data:image/jpeg;base64,${p.photo}` : ''}" alt="" />
          <div class="person-info">
            <div class="person-name">${_esc(p.name)}${p.relation ? ` <span class="person-rel">${_esc(p.relation)}</span>` : ''}</div>
            ${p.memo ? `<div class="person-memo">${_esc(p.memo)}</div>` : ''}
          </div>
          ${_groupSelectHtml('pgroup', p.group)}
          <button class="btn btn-ghost person-del" style="padding:6px 10px;">🗑️</button>
        </div>`).join('');
    });
  }
  if (!pending.length && !known.length) html = '<div class="hint">등록된 인물이 없습니다. 위에서 추가하거나, 일기를 만들면 자주 등장하는 인물이 자동으로 여기에 모입니다.</div>';
  box.innerHTML = html;

  // 행 조작(삭제/저장/그룹) 중엔 목록 전체를 잠근다 — 시트는 행 번호 주소라, 삭제 직후
  // stale rowIndex로 다른 행을 누르면 엉뚱한 인물이 지워지거나 덮어써진다.
  //  성공 시: 재렌더로 새 rowIndex 반영. 실패 시: 행 수가 안 바뀌어 rowIndex가 유효하므로
  //  재렌더 대신 잠금만 해제해 사용자가 입력 중이던 값(이름/관계 등)을 보존하고 즉시 재시도하게 한다.
  const lockList = () => box.querySelectorAll('button, select, input').forEach(el => { el.disabled = true; });
  const unlockList = () => box.querySelectorAll('button, select, input').forEach(el => { el.disabled = false; });

  // 미확인 → 이름·그룹 저장(확인 처리)
  box.querySelectorAll('.pend-save').forEach(btn => btn.addEventListener('click', async () => {
    const rowEl = btn.closest('.person-row');
    const row = parseInt(rowEl.dataset.row, 10);
    const name = rowEl.querySelector('.pend-name').value.trim();
    const relation = rowEl.querySelector('.pend-rel').value.trim();
    const group = rowEl.querySelector('.pend-group').value;
    if (!name) { showToast('이름을 입력하세요.', 'error'); return; }
    lockList();
    try {
      await PeopleStore.updatePerson(row, { name, relation, memo: '' });
      if (group) await PeopleStore.setGroup(row, group);
      showToast(`✅ '${name}' 등록 완료`); renderPeopleList(); updatePeopleBadge();
    } catch (e) { showToast('저장 실패: ' + (e.message || e), 'error'); unlockList(); }
  }));
  // 그룹 변경(등록된 인물)
  box.querySelectorAll('.pgroup').forEach(sel => sel.addEventListener('change', async () => {
    const row = parseInt(sel.closest('.person-row').dataset.row, 10);
    lockList();
    try { await PeopleStore.setGroup(row, sel.value); showToast('그룹 변경됨'); renderPeopleList(); }
    catch (e) { showToast('그룹 변경 실패: ' + (e.message || e), 'error'); unlockList(); }
  }));
  // 삭제
  box.querySelectorAll('.person-del').forEach(btn => btn.addEventListener('click', async () => {
    const row = parseInt(btn.closest('.person-row').dataset.row, 10);
    if (!confirm('이 인물을 삭제할까요?')) return;
    lockList();
    try { await PeopleStore.deleteByRow(row); showToast('🗑️ 삭제됨'); renderPeopleList(); updatePeopleBadge(); }
    catch (e) { showToast('삭제 실패: ' + (e.message || e), 'error'); unlockList(); }
  }));
}

// 그룹 선택 <select> HTML (현재 그룹 선택 상태로)
function _groupSelectHtml(cls, current) {
  const groups = (typeof PeopleStore !== 'undefined' && PeopleStore.GROUPS) ? PeopleStore.GROUPS : ['가족', '친구', '직장'];
  const opts = ['<option value="">미분류</option>']
    .concat(groups.map(g => `<option value="${g}"${g === (current || '') ? ' selected' : ''}>${g}</option>`));
  return `<select class="${cls}" style="width:88px; padding:6px 8px;">${opts.join('')}</select>`;
}

// ── 일기 수정/삭제 ─────────────────────────────────────────
function _enterEditMode(item, date) {
  item.classList.add('editing');
  const entry = _entriesCache.find(e => e.date === date);
  const body = item.querySelector('.hist-body');
  const actions = item.querySelector('.hist-actions');
  const text = entry ? entry.text : (body ? body.textContent : '');
  if (body) {
    body.innerHTML =
      `<div class="field" style="margin-bottom:8px;">
        <label style="font-size:12px; color:var(--text-muted);">날짜</label>
        <input type="date" class="hist-edit-date" value="${_esc(date)}" style="width:170px;" />
      </div>
      <textarea class="hist-edit-area" style="width:100%; min-height:200px;">${_esc(text)}</textarea>
      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:flex-end; margin-top:8px;">
        <div class="field">
          <label style="font-size:12px; color:var(--text-muted);">문체</label>
          <select class="hist-style">
            <option value="">문체 유지</option>
            <option value="junghyun">✍️ 정현체 (직접 쓴 일기 학습)</option>
            <option value="mine">📖 내 일기 문체 따라쓰기</option>
            <option value="emotional">감성 에세이</option>
            <option value="humor">유쾌·재치</option>
            <option value="concise">간결한 기록</option>
            <option value="poetic">시적·서정</option>
            <option value="kid">어린이 그림일기</option>
          </select>
        </div>
        <div class="field">
          <label style="font-size:12px; color:var(--text-muted);">어투</label>
          <select class="hist-tone">
            <option value="">어투 유지</option>
            <option value="junghyun">✍️ 정현체 (직접 쓴 일기 어투 학습)</option>
            <option value="plain">간결한 기록체 (~했다)</option>
            <option value="banmal">친근한 반말 (~했어)</option>
            <option value="polite">부드러운 존댓말 (~했어요)</option>
            <option value="formal">정중한 격식체 (~했습니다)</option>
          </select>
        </div>
        <div class="field" style="flex:1; min-width:200px;">
          <label style="font-size:12px; color:var(--text-muted);">키워드 (선택 — 잘못된 맥락 교정)</label>
          <input type="text" class="hist-keywords" placeholder="예: 회사 워크샵 (친구 모임 아님)" />
        </div>
        <button class="btn btn-ghost hist-rewrite" style="padding:6px 12px;">🔄 AI로 다시 쓰기</button>
      </div>
      <label class="hist-manual-wrap" style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:13px; cursor:pointer;" title="이 일기를 직접 고쳤다면 켜세요. 켜고 저장하면 '수동' 일기로 기록되어 ✍️ 정현체 문체·어투 학습에 포함됩니다.">
        <input type="checkbox" class="hist-manual-toggle" ${entry && entry.type === 'manual' ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;" />
        <span>✍️ <b>내가 고쳐 쓴(수동) 일기로 표시</b> <span style="color:var(--text-muted);">— 저장 시 ‘수동’ 딱지가 붙고 정현체 학습에 포함</span></span>
      </label>
      <div class="hint" style="margin-top:6px;">문체/어투를 고르거나 키워드로 실제 맥락을 알려주고 다시 쓰기를 누르세요 — 키워드는 잘못 쓰인 사실(누구와·어디서)을 교정합니다. <b>💾 저장을 눌러야 시트에 반영</b>됩니다.</div>`;
    body.style.whiteSpace = 'normal';
  }
  if (actions) actions.innerHTML = `<button class="btn hist-save" style="padding:6px 12px;">💾 저장</button><button class="btn btn-ghost hist-cancel" style="padding:6px 12px;">취소</button>`;
}
function _renderViewMode(item, date) {
  item.classList.remove('editing');
  const entry = _entriesCache.find(e => e.date === date);
  const body = item.querySelector('.hist-body');
  const actions = item.querySelector('.hist-actions');
  if (body) { body.textContent = entry ? entry.text : ''; body.style.whiteSpace = 'pre-wrap'; }
  // 접힌 미리보기도 갱신 — 안 하면 수정 저장 후 접었을 때 옛 텍스트가 보임
  const pv = item.querySelector('.hist-preview');
  if (pv && entry) pv.textContent = entry.text.slice(0, 140) + (entry.text.length > 140 ? '…' : '');
  if (actions) actions.innerHTML = `<button class="btn btn-ghost hist-edit" style="padding:6px 12px;">✏️ 수정</button><button class="btn btn-ghost hist-photo-change" style="padding:6px 12px;">📷 사진 변경</button><button class="btn btn-ghost hist-del" style="padding:6px 12px;">🗑️ 삭제</button>`;
}
async function _saveEdit(item, date) {
  const area = item.querySelector('.hist-edit-area');
  if (!area) return;
  const newText = area.value;
  const dateEl = item.querySelector('.hist-edit-date');
  const newDate = dateEl ? dateEl.value.trim() : date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { showToast('날짜를 올바르게 선택하세요.', 'error'); return; }
  // '수동 표시' 토글 — 현재 작성방식과 다르면 저장 후 G열을 갱신한다(같으면 불필요한 쓰기 생략).
  const _entry = _entriesCache.find(e => e.date === date);
  const _curManual = !!(_entry && _entry.type === 'manual');
  const _manualEl = item.querySelector('.hist-manual-toggle');
  const _wantManual = !!(_manualEl && _manualEl.checked);
  const saveBtn = item.querySelector('.hist-save'); const o = saveBtn ? saveBtn.textContent : '';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '저장 중...'; }
  try {
    await DiaryStore.updateEntry(date, newDate, newText);
    // 작성방식 변경(자동↔수동)을 시트 G열에 반영 — updateEntry로 날짜가 바뀌었을 수 있으니 newDate 기준.
    let typeChanged = false;
    if (_wantManual !== _curManual) {
      try { await DiaryStore.updateType(newDate, _wantManual ? 'manual' : ''); typeChanged = true; }
      catch (ce) { console.warn('[Diary] 작성방식(수동) 표시 변경 실패:', ce); showToast('수동 표시 저장 실패: ' + (ce.message || ce), 'error'); }
    }
    // 본문이 바뀌었으니 제목도 새로 생성(사이드바 날짜 옆 표시 갱신). 실패해도 본문 수정은 유지.
    let newTitle;
    try {
      newTitle = await GeminiAPI.generateTitle(newText);
      if (newTitle) await DiaryStore.updateTitle(newDate, newTitle);
    } catch (te) { console.warn('[Diary] 수정 후 제목 생성 실패:', te); }
    if (newDate !== date) {
      // 결과 카드(_last)의 날짜도 동기화 — 안 하면 💾가 옛 날짜로 일기를 부활시킴
      if (typeof DiaryAgent !== 'undefined' && DiaryAgent.onEntryDateChanged) DiaryAgent.onEntryDateChanged(date, newDate);
      showToast('✅ 날짜·내용이 수정되었습니다.');
      await renderMonthList();   // 날짜 변경 → 목록/달 그룹 재구성(새 제목·작성방식 반영)
      showDate(newDate);
    } else {
      const entry = _entriesCache.find(e => e.date === date);
      if (entry) { entry.text = newText; if (newTitle) entry.title = newTitle; if (typeChanged) entry.type = _wantManual ? 'manual' : ''; }
      if (typeChanged) { showDate(date); } // 수동 뱃지가 헤더에 있어 카드 전체를 다시 그려 반영
      else { _renderViewMode(item, date); }
      showToast('✅ 일기가 수정되었습니다.');
      if (newTitle) renderMonthList(); // 사이드바 트리의 제목 갱신(현재 보던 본문 카드는 그대로 유지)
    }
  } catch (e) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = o; }
    showToast('수정 실패: ' + (e.message || e), 'error');
  }
}
async function _deleteDiary(item, date) {
  if (!confirm(`${date} 일기를 삭제할까요?\n되돌릴 수 없습니다.`)) return;
  try {
    await DiaryStore.deleteByDate(date);
    if (typeof DiaryAgent !== 'undefined' && DiaryAgent.onEntryDeleted) DiaryAgent.onEntryDeleted(date);
    showToast('🗑️ 일기가 삭제되었습니다.');
    await renderMonthList();
    showWrite();
  } catch (e) { showToast('삭제 실패: ' + (e.message || e), 'error'); }
}

// 기존 일기의 대표 사진 교체 — 구글 포토에서 새로 골라 드라이브에 영구 저장 후 시트 C/F열 갱신.
//  진행 중 같은 버튼을 다시 누르면 취소(포토 창을 그냥 닫으면 폴링이 한동안 남기 때문).
async function _changePhoto(item, date) {
  const btn = item.querySelector('.hist-photo-change');
  if (btn && btn.dataset.busy === '1') { if (btn._cancelRef) btn._cancelRef.cancelled = true; return; }
  const cancelRef = { cancelled: false };
  if (btn) { btn.dataset.busy = '1'; btn._cancelRef = cancelRef; btn.textContent = '📷 선택 중… (다시 누르면 취소)'; }
  const restore = () => { if (btn) { btn.dataset.busy = ''; btn._cancelRef = null; btn.textContent = '📷 사진 변경'; } };
  try {
    const picked = await PhotosPicker.pick(() => {}, cancelRef);
    if (!picked || !picked.length) { showToast('선택된 사진이 없습니다.', 'error'); restore(); return; }
    if (picked.length > 1) showToast('여러 장 중 첫 번째 사진을 대표로 사용합니다.');
    if (btn) btn.textContent = '☁️ 저장 중...';
    const hi = await PhotosPicker.fetchImageBase64(picked[0].baseUrl, 2048);
    const newId = await DriveAPI.uploadPhoto(`${date} 대표.jpg`, hi.data, hi.mime);
    await DiaryStore.updatePhoto(date, newId, '');
    // 캐시·카드 화면 갱신(시트 재로드 없이)
    const entry = _entriesCache.find(e => e.date === date);
    if (entry) { entry.bestPhotoId = newId; entry.thumb = ''; }
    item.setAttribute('data-best', newId);
    const ph = item.querySelector('.hist-photo');
    if (ph) {
      ph.dataset.loaded = '1';
      ph.innerHTML = '<span class="hint">🖼️ 새 사진 불러오는 중...</span>';
      try { const url = await DriveAPI.fetchThumbDataUrl(newId, 1280); ph.innerHTML = `<img src="${url}" style="max-width:480px; width:100%; border-radius:10px; border:1px solid var(--border);" />`; }
      catch (_) { ph.innerHTML = '<span class="hint">사진을 불러오지 못했습니다.</span>'; }
    }
    showToast('✅ 대표 사진이 변경되었습니다.');
  } catch (e) {
    showToast('사진 변경 실패: ' + (e.message || e), 'error');
  } finally { restore(); }
}

// 편집 모드에서 본문을 새 문체/어투/키워드로 다시 쓰기 — 키워드는 잘못 쓰인 맥락 교정용. 💾 저장 전까지 시트 미반영.
async function _rewriteInEdit(item) {
  const area = item.querySelector('.hist-edit-area'); if (!area) return;
  const styleKey = (item.querySelector('.hist-style') || {}).value || '';
  const toneKey = (item.querySelector('.hist-tone') || {}).value || '';
  const keywords = ((item.querySelector('.hist-keywords') || {}).value || '').trim();
  if (!styleKey && !toneKey && !keywords) { showToast('바꿀 문체/어투를 고르거나 키워드를 입력하세요.', 'error'); return; }
  if (!area.value.trim()) { showToast('다시 쓸 내용이 없습니다.', 'error'); return; }
  // 문체 예시 로드(단건 생성의 _resolveStyle과 동일 규칙):
  //  · 📖 내 일기 문체(mine): 저장된 다른 일기 전반.
  //  · ✍️ 정현체(junghyun, 문체 또는 어투): 직접 쓴 일기(수동 + 2025 이전 옛 일기)를 학습(없으면 gemini 내장 예시로 폴백).
  let samples = [];
  if (styleKey === 'mine') {
    samples = _entriesCache
      .filter(en => en.date !== item.dataset.date && (en.text || '').trim().length >= 50)
      .slice(0, 3).map(en => en.text.slice(0, 1200));
    if (!samples.length) { showToast('참고할 다른 일기가 없어 내 문체를 적용할 수 없습니다.', 'error'); return; }
  } else if (styleKey === 'junghyun' || toneKey === 'junghyun') {
    samples = _entriesCache
      .filter(en => DiaryStore.isHandwritten(en) && en.date !== item.dataset.date && (en.text || '').trim().length >= 30)
      .slice(0, 3).map(en => en.text.slice(0, 1200));
  }
  const btn = item.querySelector('.hist-rewrite'); const o = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '✍️ 다시 쓰는 중...'; }
  try {
    const out = await GeminiAPI.rewriteDiary(area.value, { styleKey, toneKey, samples }, keywords);
    if (out && out.trim()) { area.value = out.trim(); showToast('✅ 다시 썼어요 — 마음에 들면 💾 저장을 누르세요.'); }
    else showToast('다시 쓰기 결과가 비어 있습니다.', 'error');
  } catch (e) { showToast('다시 쓰기 실패: ' + (e.message || e), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = o; } }
}

// 엔트리 카드 HTML (월 뷰·검색 공용). data-date로 특정 일기 펼침 가능.
function _entryCardsHtml(entries) {
  if (!entries.length) return '<div class="hint">일기가 없습니다.</div>';
  return entries.map(e => {
    const preview = _esc(e.text).slice(0, 140);
    // 사진(1~3장)은 펼칠 때 갤러리로 lazy 로드(_toggleEntry → _renderEntryGallery)
    const manualTag = e.type === 'manual' ? ' <span class="manual-tag">✍️ 수동</span>' : '';
    return `
      <div class="diary-entry hist-item" data-date="${_esc(e.date)}" data-best="${_esc(e.bestPhotoId)}" data-expanded="0">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>📅 ${_esc(e.date)}${manualTag}</strong>
          <span class="hist-arrow" style="color:var(--text-muted); font-size:12px;">▼</span>
        </div>
        <div class="hist-preview" style="color:var(--text-secondary); font-size:13px; margin-top:6px;">${preview}${e.text.length > 140 ? '…' : ''}</div>
        <div class="hist-full" style="display:none; margin-top:10px;">
          <div class="hist-photo" style="margin-bottom:10px; display:flex; flex-wrap:wrap; gap:8px;"></div>
          <div class="hist-body" style="white-space:pre-wrap; line-height:1.7; font-size:14px;">${_esc(e.text)}</div>
          <div class="hist-actions" style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-ghost hist-edit" style="padding:6px 12px;">✏️ 수정</button>
            <button class="btn btn-ghost hist-photo-change" style="padding:6px 12px;">📷 사진 변경</button>
            <button class="btn btn-ghost hist-del" style="padding:6px 12px;">🗑️ 삭제</button>
          </div>
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
  _prefetchMonthPhotos(entries);
}

// 그 달 일기 대표사진을 백그라운드 프리페치(동시 2개) — 날짜 클릭 시 캐시 적중으로 즉시 표시.
// 프록시만 시도하고 실패는 조용히 무시(원본 다운로드 폴백 없음). 다른 달로 이동하면 남은 루프 중단.
let _prefetchSeq = 0;
async function _prefetchMonthPhotos(entries) {
  if (typeof DriveAPI === 'undefined' || !DriveAPI.prefetchThumb || !Auth.isLoggedIn()) return;
  const ids = [...new Set(entries.map(e => e.bestPhotoId).filter(Boolean))];
  const seq = ++_prefetchSeq;
  let i = 0;
  const worker = async () => {
    while (i < ids.length && seq === _prefetchSeq) {
      const id = ids[i++];
      try { await DriveAPI.prefetchThumb(id, 1280); } catch (_) {}
    }
  };
  await Promise.all([worker(), worker()]);
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
  _closeSidebar(); // 모바일: 날짜 선택하면 메뉴 닫고 본문 보기
}

// 엔트리 카드 펼치기/접기(+대표 사진 lazy 로드)
async function _toggleEntry(item) {
  const expanded = item.getAttribute('data-expanded') === '1';
  item.setAttribute('data-expanded', expanded ? '0' : '1');
  item.querySelector('.hist-preview').style.display = expanded ? '' : 'none';
  item.querySelector('.hist-full').style.display = expanded ? 'none' : '';
  item.querySelector('.hist-arrow').textContent = expanded ? '▼' : '▲';
  if (!expanded) {
    const ph = item.querySelector('.hist-photo');
    if (ph && !ph.dataset.loaded) {
      ph.dataset.loaded = '1';
      const date = item.getAttribute('data-date');
      const entry = (_entriesCache || []).find(e => e.date === date) || { bestPhotoId: item.getAttribute('data-best') };
      await _renderEntryGallery(ph, entry);
    }
  }
}

// 저장된 일기의 사진 갤러리(대표 먼저, 최대 3장). 못 불러오는 사진(삭제/만료)은 조용히 건너뜀.
async function _renderEntryGallery(container, entry) {
  container.innerHTML = '<span class="hint">🖼️ 사진 불러오는 중...</span>';
  const urls = [];
  // 대표가 base64 썸네일로만 저장된 경우(드라이브 업로드 실패분): 대표를 맨 앞에 먼저 표시
  if (entry.thumb) urls.push(`data:image/jpeg;base64,${entry.thumb}`);
  // 표시 대상 ID = [대표, ...photoIds] 중복 제거. 대표를 항상 먼저 시도해야
  //  옛 포토 일기(photoIds엔 만료 ID, 대표는 드라이브 영구)에서 대표 1장이라도 확실히 나온다.
  const ids = [];
  [entry.bestPhotoId].concat(entry.photoIds || []).forEach(id => { if (id && ids.indexOf(id) === -1) ids.push(id); });
  for (const id of ids) {
    if (urls.length >= 3) break;
    if (entry.thumb && id === entry.bestPhotoId) continue; // base64로 이미 넣은 대표는 중복 방지
    if (typeof DriveAPI === 'undefined') break;
    try { urls.push(await DriveAPI.fetchThumbDataUrl(id, 1280)); } catch (_) {}
  }
  if (!urls.length) { container.innerHTML = '<span class="hint">사진을 불러오지 못했습니다(삭제/권한/만료).</span>'; return; }
  // 대표(첫 장)는 크게, 나머지는 2장씩 나란히
  container.innerHTML = urls.map((u, i) => {
    const style = (urls.length > 1 && i > 0)
      ? 'width:calc(50% - 4px); max-height:240px; object-fit:cover;'
      : 'width:100%; max-width:480px;';
    return `<img src="${u}" style="${style} border-radius:10px; border:1px solid var(--border);" />`;
  }).join('');
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
  // innerHTML 교체 전에 현재 상태(활성 월·펼친 달)를 보존해 두고 아래에서 복원
  const prevActiveEl = document.querySelector('.month-row.active');
  const prevMonth = prevActiveEl ? prevActiveEl.dataset.month : '';
  const prevOpen = Array.from(listEl.querySelectorAll('.date-sub.open')).map(s => s.dataset.month);
  const prevOpenYears = Array.from(listEl.querySelectorAll('.year-sub.open')).map(s => s.dataset.year);
  listEl.innerHTML = '<div class="hint" style="padding:6px 4px;">⏳ 불러오는 중...</div>';
  try { _entriesCache = await DiaryStore.loadEntries(); }
  catch (e) { listEl.innerHTML = `<div class="hint" style="padding:6px 4px; color:var(--red)">❌ ${_esc(e.message || e)}</div>`; return; }
  renderStats();
  if (!_entriesCache.length) { listEl.innerHTML = '<div class="hint" style="padding:6px 4px;">저장한 일기 없음.<br/>일기를 만들고 💾 저장하세요.</div>'; return; }
  const byMonth = {};
  const titleOf = {};
  const typeOf = {};
  _entriesCache.forEach(e => {
    const m = (e.date || '').slice(0, 7); if (!m) return;
    (byMonth[m] = byMonth[m] || []).push(e.date);
    titleOf[e.date] = e.title || '';
    typeOf[e.date] = e.type || '';
  });
  // 날짜 항목 버튼 — "15일 ✍️ [제목]"처럼 날짜 옆에 (수동이면)수동 이모지 + 짧은 제목을 흐리게 덧붙인다.
  const _dateItemHtml = (d, dayLabel) => {
    const t = titleOf[d] || '';
    const manual = typeOf[d] === 'manual' ? '<span class="d-manual" title="수동 일기" style="margin:0 3px;">✍️</span>' : '';
    return `<button class="date-item" data-date="${d}"><span class="d-day">${dayLabel}</span>${manual}${t ? `<span class="d-title">${_esc(t)}</span>` : ''}</button>`;
  };
  const months = Object.keys(byMonth).sort().reverse();
  // 올해 월은 최상위에 그대로(1클릭 접근), 과거 연도는 「▸ yyyy년」 그룹으로 접어 스크롤을 줄인다.
  const curYear = String(new Date().getFullYear());
  const curMonths = months.filter(m => m.slice(0, 4) === curYear);
  const pastYears = {}; // '2024' → ['2024-01', ...]
  months.forEach(m => { const y = m.slice(0, 4); if (y !== curYear) (pastYears[y] = pastYears[y] || []).push(m); });
  const monthBlock = (m, inYear) => {
    const dates = byMonth[m].slice().sort().reverse();
    const label = inYear ? `${parseInt(m.slice(5), 10)}월` : m; // 연도 그룹 안에서는 'n월'로 간결하게
    return `
      <div class="month-block">
        <button class="month-item month-row" data-month="${m}" title="${m}"><span><span class="month-caret">▸</span>${label}</span><span class="cnt">${dates.length}</span></button>
        <div class="date-sub" data-month="${m}">${dates.map(d => _dateItemHtml(d, `${parseInt(d.slice(8), 10)}일`)).join('')}</div>
      </div>`;
  };
  const YEAR_FLAT_MAX = 15; // 과거 연도 일기가 이 수 이하면 월 단계를 생략하고 날짜를 바로 노출(빈약한 해에 월 그룹은 무의미)
  listEl.innerHTML = curMonths.map(m => monthBlock(m, false)).join('')
    + Object.keys(pastYears).sort().reverse().map(y => {
      const ms = pastYears[y];
      const total = ms.reduce((s, m) => s + byMonth[m].length, 0);
      const inner = total <= YEAR_FLAT_MAX
        ? ms.flatMap(m => byMonth[m].slice().sort().reverse())
            .map(d => _dateItemHtml(d, `${parseInt(d.slice(5, 7), 10)}월 ${parseInt(d.slice(8), 10)}일`)).join('')
        : ms.map(m => monthBlock(m, true)).join('');
      return `
      <div class="year-block">
        <button class="month-item year-row" data-year="${y}"><span><span class="month-caret">▸</span>${y}년</span><span class="cnt">${total}</span></button>
        <div class="year-sub" data-year="${y}">${inner}</div>
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
  // 연도 행은 펼침/접힘만(이동 없음) — 이동은 월 클릭으로. 동작이 섞이면 오조작이 잦다.
  listEl.querySelectorAll('.year-row').forEach(btn => btn.addEventListener('click', () => {
    const sub = listEl.querySelector(`.year-sub[data-year="${btn.dataset.year}"]`);
    const caret = btn.querySelector('.month-caret');
    const open = sub.classList.toggle('open');
    if (caret) caret.textContent = open ? '▾' : '▸';
  }));
  listEl.querySelectorAll('.date-item').forEach(btn => btn.addEventListener('click', () => showDate(btn.dataset.date)));
  // 펼쳐 두었던 연도/달 복원 + 활성·펼친 달이 과거 연도면 그 연도 그룹도 자동 펼침
  const openYear = (y) => {
    const sub = listEl.querySelector(`.year-sub[data-year="${y}"]`);
    if (!sub || sub.classList.contains('open')) return;
    sub.classList.add('open');
    const caret = listEl.querySelector(`.year-row[data-year="${y}"] .month-caret`);
    if (caret) caret.textContent = '▾';
  };
  prevOpenYears.forEach(openYear);
  prevOpen.forEach(m => {
    const sub = listEl.querySelector(`.date-sub[data-month="${m}"]`);
    if (sub) sub.classList.add('open');
    const caret = listEl.querySelector(`.month-row[data-month="${m}"] .month-caret`);
    if (caret) caret.textContent = '▾';
    openYear(m.slice(0, 4));
  });
  if (prevMonth) openYear(prevMonth.slice(0, 4));
  // 월 뷰가 열려 있으면 같은 달을 다시 그려 새 데이터 반영(새 DOM에는 active가 없으므로 보존값 사용)
  const mv = document.getElementById('view-month');
  if (mv && !mv.classList.contains('hidden') && prevMonth && !document.getElementById('diary-search').value.trim()) {
    if (listEl.querySelector(`.month-row[data-month="${prevMonth}"]`)) showMonth(prevMonth);
  }
}

function onLogoutDone() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

// ── 문체/어투 선택 ─────────────────────────────────────────
const STYLE_LS = 'dachangi_style_pref';
function _styleFromUI() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  return { styleKey: v('style-select'), toneKey: v('tone-select'), customText: v('style-custom').trim() };
}
function _syncCustomStyleField() {
  const sel = document.getElementById('style-select');
  const field = document.getElementById('style-custom-field');
  if (sel && field) field.style.display = sel.value === 'custom' ? '' : 'none';
}
function _saveStylePref() {
  try { localStorage.setItem(STYLE_LS, JSON.stringify(_styleFromUI())); } catch (_) {}
}
function _restoreStylePref() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(STYLE_LS) || 'null'); } catch (_) {}
  if (!p) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
  set('style-select', p.styleKey || 'junghyun'); // 빈 값(예전 기본)은 정현체로 — 기본 문체 승격
  set('tone-select', p.toneKey || 'junghyun');    // 빈 값(예전 '기본 ~했다')은 정현체로 — 본인 어투 학습이 상위호환
  set('style-custom', p.customText || '');
  _syncCustomStyleField();
}

function _keywordsFromUI() {
  const el = document.getElementById('diary-keywords');
  return el ? el.value.trim() : '';
}

function _runFromUI() {
  DiaryAgent.run({
    dateStr: document.getElementById('diary-date').value,
    candCount: parseInt(document.getElementById('cand-count').value, 10) || 10,
    topCount: parseInt(document.getElementById('top-count').value, 10) || 3,
    style: _styleFromUI(),
    keywords: _keywordsFromUI(),
  });
}

// 수동 작성 — Gemini 없이 사진만 골라 결과 카드를 열고, 본문은 직접 쓴다(문체/키워드 불필요).
function _runManualFromUI() {
  DiaryAgent.runManual({
    dateStr: document.getElementById('diary-date').value,
    candCount: parseInt(document.getElementById('cand-count').value, 10) || 10,
    topCount: parseInt(document.getElementById('top-count').value, 10) || 3,
  });
}

function _runBatchFromUI() {
  DiaryAgent.runBatch({
    candCount: parseInt(document.getElementById('cand-count').value, 10) || 10,
    topCount: parseInt(document.getElementById('top-count').value, 10) || 3,
    style: _styleFromUI(),
    keywords: (document.getElementById('batch-keywords') || {}).value || '',
    startDate: (document.getElementById('batch-start') || {}).value,
    endDate: (document.getElementById('batch-end') || {}).value,
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // 날짜 기본값: 어제
  const dateEl = document.getElementById('diary-date');
  if (dateEl) dateEl.value = _todayMinus(1);
  // 일괄 생성 기간 기본값: 최근 7일(드라이브 소스용)
  const bs = document.getElementById('batch-start'); if (bs) bs.value = _todayMinus(7);
  const be = document.getElementById('batch-end'); if (be) be.value = _todayMinus(1);

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
  document.getElementById('side-settings').addEventListener('click', () => { _closeSidebar(); ConfigModal.open(); });
  document.getElementById('side-people').addEventListener('click', () => showPeople());
  // 모바일 사이드바 토글
  const _tg = document.getElementById('sidebar-toggle'); if (_tg) _tg.addEventListener('click', _openSidebar);
  const _cl = document.getElementById('sidebar-close'); if (_cl) _cl.addEventListener('click', _closeSidebar);
  const _ov = document.getElementById('sidebar-overlay'); if (_ov) _ov.addEventListener('click', _closeSidebar);

  // 인물 사진 스테이징(파일 업로드 또는 구글 포토 선택 공용)
  function _setStagedPersonPhoto(b64) {
    _stagedPersonPhoto = b64 || '';
    const prev = document.getElementById('person-photo-preview');
    if (prev) {
      if (b64) { prev.src = `data:image/jpeg;base64,${b64}`; prev.style.display = ''; }
      else { prev.removeAttribute('src'); prev.style.display = 'none'; }
    }
  }
  document.getElementById('person-photo').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) { _setStagedPersonPhoto(''); return; }
    try { _setStagedPersonPhoto(await _fileToThumb(file, 320)); }
    catch (_) { showToast('사진 처리 실패', 'error'); }
  });
  document.getElementById('person-photo-pick').addEventListener('click', async () => {
    const prog = document.getElementById('person-add-progress');
    // 포토 창을 닫으면 폴링 타임아웃까지 잠기므로 취소 버튼 제공(일기 생성 흐름과 동일)
    const cancelRef = { cancelled: false };
    const setProg = (msg) => {
      if (!prog) return;
      prog.innerHTML = `<span>${_esc(msg)}</span> <button type="button" class="btn btn-ghost pp-cancel" style="padding:2px 10px; font-size:11px;">선택 취소</button>`;
      const cb = prog.querySelector('.pp-cancel');
      if (cb) cb.addEventListener('click', () => { cancelRef.cancelled = true; cb.disabled = true; cb.textContent = '취소 중...'; });
    };
    try {
      const picked = await PhotosPicker.pick(setProg, cancelRef);
      if (prog) prog.textContent = '';
      if (!picked || !picked.length) { showToast('선택된 사진이 없습니다.', 'error'); return; }
      if (prog) prog.textContent = '사진 불러오는 중...';
      const img = await PhotosPicker.fetchImageBase64(picked[0].baseUrl, 320);
      if (prog) prog.textContent = '';
      document.getElementById('person-photo').value = '';
      _setStagedPersonPhoto(img.data);
      showToast('사진 선택됨 — 이름을 입력하고 추가하세요.');
    } catch (e) { if (prog) prog.textContent = ''; showToast('포토 선택 실패: ' + (e.message || e), 'error'); }
  });
  document.getElementById('person-add').addEventListener('click', async () => {
    const name = document.getElementById('person-name').value.trim();
    const relation = document.getElementById('person-relation').value.trim();
    const memo = document.getElementById('person-memo').value.trim();
    const group = document.getElementById('person-group').value;
    if (!name) { showToast('이름을 입력하세요.', 'error'); return; }
    if (!_stagedPersonPhoto) { showToast('얼굴 사진을 선택하세요(파일 또는 📷 포토).', 'error'); return; }
    const btn = document.getElementById('person-add'); const o = btn.textContent;
    btn.disabled = true; btn.textContent = '추가 중...';
    try {
      await PeopleStore.addPerson({ name, relation, memo, group, photo: _stagedPersonPhoto });
      showToast(`✅ '${name}' 인물 추가됨`);
      document.getElementById('person-name').value = '';
      document.getElementById('person-relation').value = '';
      document.getElementById('person-memo').value = '';
      document.getElementById('person-group').value = '';
      document.getElementById('person-photo').value = '';
      _setStagedPersonPhoto('');
      renderPeopleList();
    } catch (e) { showToast('인물 추가 실패: ' + (e.message || e), 'error'); }
    finally { btn.disabled = false; btn.textContent = o; }
  });
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

  // 문체/어투: 마지막 선택 복원 + 변경 시 저장
  _restoreStylePref();
  ['style-select', 'tone-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { _syncCustomStyleField(); _saveStylePref(); });
  });
  const customStyleEl = document.getElementById('style-custom');
  if (customStyleEl) customStyleEl.addEventListener('input', _saveStylePref);

  // 생성
  document.getElementById('generate-btn').addEventListener('click', _runFromUI);
  // 직접 쓰기(수동)
  const _manualBtn = document.getElementById('manual-btn');
  if (_manualBtn) _manualBtn.addEventListener('click', _runManualFromUI);
  // 여러 날 일괄 생성
  const _batchBtn = document.getElementById('batch-btn');
  if (_batchBtn) _batchBtn.addEventListener('click', _runBatchFromUI);
  // 일기 전체 백업 내보내기
  const _expMd = document.getElementById('export-md-btn');
  if (_expMd) _expMd.addEventListener('click', exportDiariesMarkdown);
  const _expJson = document.getElementById('export-json-btn');
  if (_expJson) _expJson.addEventListener('click', exportDiariesJson);
  // 다시 생성: 같은 날짜의 직전 결과가 있으면 사진 재선택 없이 본문만 재생성(문체 변경 반영).
  //  날짜 입력이 직전 생성과 다르면 — 안내문과 달리 전체 파이프라인(자동 저장 = 그 날짜 기존 일기
  //  덮어쓰기)이 돌게 되므로 confirm으로 의도를 확인한다.
  document.getElementById('regenerate-btn').addEventListener('click', () => {
    const last = DiaryAgent.getLast();
    const curDate = document.getElementById('diary-date').value;
    if (last && last.dateStr === curDate) { DiaryAgent.regenerateText(_styleFromUI(), _keywordsFromUI()); return; }
    if (last && curDate && last.dateStr !== curDate) {
      if (!confirm(`날짜(${curDate})가 직전 생성(${last.dateStr})과 다릅니다.\n${curDate} 사진으로 처음부터 새로 생성할까요?\n(${curDate}에 저장된 일기가 있으면 새 일기로 덮어써집니다)`)) return;
    }
    _runFromUI();
  });

  // 결과 액션
  document.getElementById('copy-btn').addEventListener('click', async () => {
    const t = document.getElementById('diary-text').value;
    try { await navigator.clipboard.writeText(t); showToast('📋 복사됨'); }
    catch (_) { showToast('복사 실패 — 직접 선택해 복사하세요.', 'error'); }
  });
  document.getElementById('download-btn').addEventListener('click', () => {
    const t = document.getElementById('diary-text').value;
    // 파일명은 '생성된 일기'의 날짜 기준 — 날짜 입력을 바꿔둔 뒤 받아도 어긋나지 않게
    const last = DiaryAgent.getLast();
    const date = (last && last.dateStr) || document.getElementById('diary-date').value || 'diary';
    const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${date} 일기.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 수동 표시 토글 — AI 초안을 고친 뒤 켜면 '수동(정현체 학습 대상)'으로 저장된다(레이아웃은 그대로).
  const _manualToggle = document.getElementById('manual-toggle');
  if (_manualToggle) _manualToggle.addEventListener('change', () => {
    if (!DiaryAgent.getLast()) { _manualToggle.checked = false; showToast('먼저 일기를 생성하세요.', 'error'); return; }
    DiaryAgent.setManual(_manualToggle.checked);
  });

  // 시트에 저장
  document.getElementById('save-diary-btn').addEventListener('click', async () => {
    const last = DiaryAgent.getLast();
    if (!last) { showToast('먼저 일기를 생성하세요.', 'error'); return; }
    const text = document.getElementById('diary-text').value;
    if (last.type === 'manual' && !text.trim()) { showToast('일기 내용을 직접 작성한 뒤 저장하세요.', 'error'); return; }
    const btn = document.getElementById('save-diary-btn'); const o = btn.textContent;
    btn.disabled = true; btn.textContent = '💾 등록 중...';
    try {
      await DiaryAgent.finalize(text); // 수정 텍스트 + 선택한 대표 사진 반영(같은 날짜 덮어쓰기)
      showToast(last.type === 'manual' ? '✅ 수동(정현체 학습 포함)으로 저장되었습니다.' : '✅ 수정·대표 사진이 반영되어 등록되었습니다.');
      renderMonthList();
    } catch (e) { console.error(e); showToast('❌ 등록 실패: ' + (e.message || e), 'error'); }
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

  // 폼 기록 시트 → 일기 시트 가져오기
  const _fiBtn = document.getElementById('form-import-btn');
  if (_fiBtn) _fiBtn.addEventListener('click', async () => {
    const ref = ((document.getElementById('form-import-url') || {}).value || '').trim();
    if (!ref) { showToast('가져올 시트 URL을 붙여넣으세요.', 'error'); return; }
    if (!Auth.isLoggedIn()) { showToast('먼저 로그인하세요.', 'error'); return; }
    if (!confirm('시트의 기록을 일기로 가져옵니다.\n이미 일기가 있는 날짜는 건너뜁니다. 진행할까요?')) return;
    const o = _fiBtn.textContent; _fiBtn.disabled = true; _fiBtn.textContent = '📋 가져오는 중...';
    try {
      const r = await Migrate.importFormSheet(ref);
      showToast(`✅ 폼 기록 ${r.parsed}건 중 ${r.added}건 추가 (이미 있던 ${r.skipped}건 건너뜀)`);
      renderMonthList();
    } catch (e) { console.error(e); showToast('❌ 가져오기 실패: ' + (e.message || e), 'error'); }
    finally { _fiBtn.disabled = false; _fiBtn.textContent = o; }
  });

  // 기간 일기 문체 일괄 변환 — 시작 전 JSON 자동 백업, 진행 중 재클릭 = 중단
  const _rsBtn = document.getElementById('restyle-btn');
  let _rsCancel = false;
  // 기본 기간 = 올해 1/1 ~ 오늘
  (() => {
    const p = (n) => String(n).padStart(2, '0'); const now = new Date();
    const s = document.getElementById('restyle-start'), e = document.getElementById('restyle-end');
    if (s && !s.value) s.value = `${now.getFullYear()}-01-01`;
    if (e && !e.value) e.value = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  })();
  if (_rsBtn) _rsBtn.addEventListener('click', async () => {
    if (_rsBtn.dataset.busy === '1') { _rsCancel = true; _rsBtn.textContent = '🖋️ 중단 중...'; return; }
    const start = (document.getElementById('restyle-start') || {}).value || '';
    const end = (document.getElementById('restyle-end') || {}).value || '';
    const styleKey = (document.getElementById('restyle-style') || {}).value || '';
    const toneKey = (document.getElementById('restyle-tone') || {}).value || '';
    const prog = document.getElementById('restyle-progress');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) { showToast('기간을 올바르게 선택하세요.', 'error'); return; }
    if (!styleKey && !toneKey) { showToast('변환할 문체나 어투를 선택하세요.', 'error'); return; }
    if (!Auth.isLoggedIn()) { showToast('먼저 로그인하세요.', 'error'); return; }
    let entries;
    try {
      _entriesCache = await DiaryStore.loadEntries();
      entries = _entriesCache.filter(en => en.date >= start && en.date <= end && (en.text || '').trim());
    } catch (e) { showToast('일기 로드 실패: ' + (e.message || e), 'error'); return; }
    if (!entries.length) { showToast('기간 내 일기가 없습니다.', 'error'); return; }
    if (!confirm(`${start} ~ ${end} 일기 ${entries.length}편을 선택한 문체로 다시 써서 덮어씁니다.\n시작 전에 전체 JSON 백업이 자동 다운로드됩니다.\n진행할까요?`)) return;
    try { exportDiariesJson(); } catch (_) {}
    _rsCancel = false; _rsBtn.dataset.busy = '1';
    const o = _rsBtn.textContent; _rsBtn.textContent = '🖋️ 변환 중… (다시 누르면 중단)';
    // 정현체(문체 또는 어투)면 직접 쓴 일기(수동 + 2025 이전 옛 일기)를 학습 예시 풀로(각 변환 시 자기 자신은 제외). 없으면 gemini 내장 예시로 폴백.
    const manualPool = (styleKey === 'junghyun' || toneKey === 'junghyun')
      ? _entriesCache.filter(en => DiaryStore.isHandwritten(en) && (en.text || '').trim().length >= 30)
      : [];
    let done = 0, failed = 0; const failedDates = [];
    const oldestFirst = entries.slice().reverse(); // 과거 → 최신 순(중단해도 앞쪽부터 정리됨)
    for (let i = 0; i < oldestFirst.length; i++) {
      if (_rsCancel) break;
      const en = oldestFirst[i];
      if (prog) prog.textContent = `(${i + 1}/${oldestFirst.length}) ${en.date} 다시 쓰는 중...`;
      try {
        const samples = manualPool.filter(m => m.date !== en.date).slice(0, 3).map(m => m.text.slice(0, 1200));
        const out = await GeminiAPI.rewriteDiary(en.text, { styleKey, toneKey, samples });
        if (!out || !out.trim()) throw new Error('빈 응답');
        await DiaryStore.updateText(en.date, out.trim());
        en.text = out.trim(); // 캐시 동기화(목록 미리보기 갱신용)
        done++;
      } catch (err) {
        failed++; failedDates.push(en.date);
        console.warn('[Restyle]', en.date, err);
        await new Promise(r => setTimeout(r, 1500)); // 쿼터 초과 등 연속 실패 과열 방지
      }
    }
    _rsBtn.dataset.busy = ''; _rsBtn.textContent = o;
    if (prog) prog.textContent = `${_rsCancel ? '⏹️ 중단' : '✅ 완료'} — 변환 ${done}편`
      + (failed ? ` · 실패 ${failed} (${failedDates.slice(0, 6).join(', ')}${failedDates.length > 6 ? '…' : ''}) — 실패분은 기간을 좁혀 다시 실행하세요` : '');
    showToast(`${_rsCancel ? '중단됨 — ' : ''}문체 변환 ${done}편 완료${failed ? `, 실패 ${failed}편` : ''}`);
    renderMonthList();
  });

  // 제목 없는 기존 일기에 Gemini로 10자 제목 일괄 생성(백필). 배치로 묶어 호출·쓰기 최소화.
  const _genTitlesBtn = document.getElementById('gen-titles-btn');
  if (_genTitlesBtn) _genTitlesBtn.addEventListener('click', async () => {
    if (_genTitlesBtn.dataset.busy === '1') return;
    if (!Auth.isLoggedIn()) { showToast('먼저 로그인하세요.', 'error'); return; }
    const prog = document.getElementById('gen-titles-progress');
    const setProg = (m) => { if (prog) prog.textContent = m; };
    let entries;
    try { _entriesCache = await DiaryStore.loadEntries(); entries = _entriesCache; }
    catch (e) { showToast('일기 로드 실패: ' + (e.message || e), 'error'); return; }
    // 제목이 비어 있고 본문이 있는 일기만 대상(이미 제목 있는 건 건너뜀)
    const targets = entries.filter(e => !(e.title || '').trim() && (e.text || '').trim());
    if (!targets.length) { setProg('제목 없는 일기가 없습니다 — 모든 일기에 이미 제목이 있어요.'); showToast('모든 일기에 이미 제목이 있습니다.'); return; }
    if (!confirm(`제목이 없는 일기 ${targets.length}편에 Gemini로 10자 이내 제목을 생성합니다.\n(이미 제목이 있는 일기는 건드리지 않습니다)\n진행할까요?`)) { setProg(''); return; }
    const o = _genTitlesBtn.textContent; _genTitlesBtn.dataset.busy = '1';
    _genTitlesBtn.disabled = true; _genTitlesBtn.textContent = '🏷️ 생성 중...';
    const BATCH = 8;
    let done = 0, failed = 0, firstErr = '', consecFail = 0;
    const _emsg = (err) => (err && err.message) ? err.message : String(err);
    try {
      for (let i = 0; i < targets.length; i += BATCH) {
        const chunk = targets.slice(i, i + BATCH);
        setProg(`(${Math.min(i + BATCH, targets.length)}/${targets.length}) 제목 생성 중...`);
        let titles = [];
        try { titles = await GeminiAPI.generateTitles(chunk.map(e => e.text)); consecFail = 0; }
        catch (err) {
          const msg = _emsg(err); console.warn('[Titles] 배치 실패:', err);
          if (!firstErr) firstErr = msg;
          failed += chunk.length; consecFail++;
          // 첫 구간부터 연속 실패면 같은 원인으로 전부 실패할 가능성이 크다 → 즉시 멈추고 원인을 보여준다(쿼터 낭비 방지)
          if (consecFail >= 2 && done === 0) { setProg(`❌ 연속 실패로 중단 — 원인: ${msg}`); break; }
          await new Promise(r => setTimeout(r, 1200)); continue;
        }
        const pairs = [];
        chunk.forEach((e, j) => { const t = (titles[j] || '').trim(); if (t) { pairs.push({ date: e.date, title: t }); e.title = t; } else failed++; });
        if (pairs.length) {
          try { await DiaryStore.bulkUpdateTitles(pairs); done += pairs.length; }
          catch (err) { const msg = _emsg(err); console.warn('[Titles] 저장 실패:', err); if (!firstErr) firstErr = msg; failed += pairs.length; pairs.forEach(p => { const en = entries.find(x => x.date === p.date); if (en) en.title = ''; }); }
        }
      }
      if (done > 0) {
        setProg(`✅ 완료 — 제목 ${done}편 생성${failed ? ` · 실패 ${failed}편(잠시 후 다시 실행하면 남은 것만 처리)` : ''}`);
        showToast(`🏷️ 제목 ${done}편 생성 완료${failed ? `, 실패 ${failed}편` : ''}`);
      } else {
        setProg(`❌ 제목 생성 전부 실패 — 원인: ${firstErr || '알 수 없음'}`);
        showToast(`❌ 제목 생성 실패: ${firstErr || '원인 미상'}`, 'error');
      }
    } catch (e) { console.error(e); setProg('❌ ' + _emsg(e)); showToast('❌ 제목 생성 실패: ' + _emsg(e), 'error'); }
    finally { _genTitlesBtn.dataset.busy = ''; _genTitlesBtn.disabled = false; _genTitlesBtn.textContent = o; renderMonthList(); }
  });

  // 월별 일기 항목: 펼치기/접기 + 수정/삭제 — 이벤트 위임
  document.getElementById('month-diaries').addEventListener('click', async (e) => {
    const item = e.target.closest('.hist-item');
    if (!item) return;
    const date = item.dataset.date;
    if (e.target.closest('.hist-edit')) { e.stopPropagation(); _enterEditMode(item, date); return; }
    if (e.target.closest('.hist-cancel')) { e.stopPropagation(); _renderViewMode(item, date); return; }
    if (e.target.closest('.hist-save')) { e.stopPropagation(); await _saveEdit(item, date); return; }
    if (e.target.closest('.hist-photo-change')) { e.stopPropagation(); _changePhoto(item, date); return; }
    if (e.target.closest('.hist-rewrite')) { e.stopPropagation(); _rewriteInEdit(item); return; }
    if (e.target.closest('.hist-del')) { e.stopPropagation(); await _deleteDiary(item, date); return; }
    if (item.classList.contains('editing')) return;     // 편집 중엔 토글 안 함
    if (e.target.closest('.hist-actions')) return;       // 액션 영역은 토글 안 함
    if (window.getSelection && String(window.getSelection()).length) return; // 본문 드래그 선택(복사) 중엔 접지 않음
    _toggleEntry(item);
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
