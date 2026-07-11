/**
 * 다챙이 - 일기 생성 파이프라인 (GAS runDailyDiary 포팅)
 *  날짜 → 월폴더 → 그날 사진 → 해상도 top N → Gemini 랭킹 top K → 일기 생성 → 표시
 */
const DiaryAgent = (() => {
  let _busy = false;
  let _last = null; // { dateStr, topImages:[{mime,data,name,id}], diary }

  function _progressEl() { return document.getElementById('progress'); }
  function _clearProgress() { const el = _progressEl(); if (el) el.innerHTML = ''; }
  function _step(text, spinner) {
    const el = _progressEl(); if (!el) return null;
    const div = document.createElement('div');
    div.className = 'step';
    div.innerHTML = (spinner ? '<span class="spinner"></span>' : '<span>•</span>') + `<span>${text}</span>`;
    el.appendChild(div);
    return div;
  }
  function _done(div, text) {
    if (!div) return;
    div.innerHTML = `<span>✅</span><span>${text}</span>`;
  }

  // 드라이브 폴더(yyyy-MM) → 그날 사진 → 해상도 후보 → base64 [{mime,data,name,id}]
  async function _gatherFromDrive(cfg, dateStr, candCount) {
    const monthStr = dateStr.slice(0, 7);
    if (!cfg.MAIN_PHOTO_FOLDER_ID) { showToast('설정에서 사진 메인 폴더 ID를 입력하세요.', 'error'); return null; }

    let s = _step(`📁 월별 폴더(${monthStr}) 찾는 중...`, true);
    const folder = await DriveAPI.findMonthFolder(cfg.MAIN_PHOTO_FOLDER_ID, monthStr);
    if (!folder) { _done(s, `폴더 '${monthStr}' 없음`); showToast(`메인 폴더 안에 '${monthStr}' 폴더가 없습니다.`, 'error'); return null; }
    _done(s, `월별 폴더 발견: ${monthStr}`);

    s = _step('🖼️ 사진 목록 조회 중...', true);
    const all = await DriveAPI.listImages(folder.id);
    const dayPhotos = DriveAPI.filterByDate(all, dateStr);
    _done(s, `${monthStr} 폴더 ${all.length}장 중, ${dateStr} 촬영 ${dayPhotos.length}장`);
    if (dayPhotos.length === 0) { showToast('해당 날짜에 찍은 사진이 없습니다.', 'error'); return null; }

    s = _step(`🔎 1차 선별(해상도+용량) 상위 ${candCount}장...`, true);
    const candidates = DriveAPI.selectByResolution(dayPhotos, candCount);
    _done(s, `1차 후보 ${candidates.length}장 선정`);

    s = _step('⬇️ 후보 사진 불러오는 중...', true);
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const img = await DriveAPI.fetchImageBase64(c.id, 1024);
      out.push({ ...img, name: c.name, id: c.id });
      if (s) s.querySelector('span:last-child').textContent = `⬇️ 후보 사진 불러오는 중... (${i + 1}/${candidates.length})`;
    }
    _done(s, `후보 ${out.length}장 로드 완료`);
    return out;
  }

  // 문체/어투 옵션 해석 — 시트에 저장된 일기를 예시(few-shot)로 로드해 문체·어투를 학습시킨다.
  //  · 'junghyun'(정현체): 문체·어투 어느 쪽이든 정현체면, 사용자가 '직접 쓴' 일기(수동 + 2025 이전 옛 일기)를
  //                        우선 학습 → 본인 문체·어투에 가장 근접. 학습 일기가 없으면 빈 배열 → gemini 내장 예시로 폴백.
  //  · 'mine'(내 일기 문체): 작성 방식 무관, 저장된 최근 일기 전반의 말투. 예시 없으면 기본 문체로 폴백.
  async function _resolveStyle(style, dateStr) {
    const st = Object.assign({}, style || {});
    const wantJung = st.styleKey === 'junghyun' || st.toneKey === 'junghyun';
    if (st.styleKey !== 'mine' && !wantJung) return st;
    try {
      const entries = await DiaryStore.loadEntries(); // 최신순
      if (st.styleKey === 'mine') {
        st.samples = entries
          .filter(e => e.date !== dateStr && (e.text || '').trim().length >= 50)
          .slice(0, 3)
          .map(e => e.text.slice(0, 1200));
      } else { // 정현체(문체/어투) — 직접 쓴 일기만 학습
        st.samples = entries
          .filter(e => DiaryStore.isHandwritten(e) && e.date !== dateStr && (e.text || '').trim().length >= 30)
          .slice(0, 3)
          .map(e => e.text.slice(0, 1200));
      }
    } catch (e) { console.warn('[Diary] 문체 예시 로드 실패:', e); st.samples = []; }
    if (st.styleKey === 'mine' && !st.samples.length) {
      st.styleKey = '';
      showToast('참고할 저장된 일기가 없어 기본 문체로 작성합니다.');
    }
    return st;
  }

  // 날짜 → 포토 검색창용 검색어 ('2019년 5월 17일'). Picker는 항상 최신순이라
  //  과거 사진은 검색이 가장 빠른 경로다(구글 공식 권장 UX).
  function _photoSearchTerm(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return '';
    return `${m[1]}년 ${parseInt(m[2], 10)}월 ${parseInt(m[3], 10)}일`;
  }

  // 구글 포토 Picker로 직접 선택 → base64 [{mime,data,name,id:''}]
  //  포토 baseUrl은 만료되어 재참조 불가 → 히스토리 썸네일용 영구 id는 비움.
  async function _gatherFromPhotos(cfg, candCount, dateStr) {
    // 과거 날짜 안내: 검색어를 미리 복사해 두고(제스처 컨텍스트), 안내 + 재복사 버튼 표시
    const term = _photoSearchTerm(dateStr);
    if (term) {
      try { navigator.clipboard.writeText(term).catch(() => {}); } catch (_) {}
      const tip = _step('', false);
      if (tip) {
        tip.innerHTML = `<span>💡</span><span>옛날 사진은 포토 창 <b>검색창</b>에 <b>「${term}」</b>을 붙여넣으면 바로 찾을 수 있어요(복사해 뒀어요). `
          + `<button type="button" class="btn btn-ghost tip-copy" style="padding:2px 8px; font-size:11px;">📋 다시 복사</button></span>`;
        const cb = tip.querySelector('.tip-copy');
        if (cb) cb.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(term); showToast('📋 검색어 복사됨 — 포토 검색창에 붙여넣으세요.'); }
          catch (_) { showToast('복사 실패 — 직접 입력해 주세요.', 'error'); }
        });
      }
    }

    let s = _step('📷 구글 포토에서 사진 선택 창 여는 중...', true);
    // 포토 창을 닫아버리면 폴링 타임아웃까지 잠기므로 명시적 취소 버튼 제공
    const cancelRef = { cancelled: false };
    const cstep = _step('', false);
    if (cstep) {
      cstep.innerHTML = `<span>✖</span><span><button type="button" class="btn btn-ghost picker-cancel" style="padding:2px 10px; font-size:11px;">선택 취소</button> 포토 창을 닫았다면 누르세요</span>`;
      const cbtn = cstep.querySelector('.picker-cancel');
      if (cbtn) cbtn.addEventListener('click', () => { cancelRef.cancelled = true; cbtn.disabled = true; cbtn.textContent = '취소 중...'; });
    }
    let picked;
    try { picked = await PhotosPicker.pick(msg => { if (s) s.querySelector('span:last-child').textContent = msg; }, cancelRef); }
    catch (e) { _done(s, '선택 취소/실패'); showToast('사진 선택 실패: ' + (e.message || e), 'error'); return null; }
    finally { if (cstep) cstep.remove(); }
    if (!picked || !picked.length) { _done(s, '선택된 사진 없음'); showToast('선택된 사진이 없습니다.', 'error'); return null; }
    // 해상도 메타가 있으면 큰 순으로 정렬 후 candCount장으로 제한(없으면 선택 순서 유지)
    picked.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const capped = picked.slice(0, candCount);
    _done(s, `${picked.length}장 선택됨 (후보 ${capped.length}장 사용)`);

    s = _step('⬇️ 선택한 사진 불러오는 중...', true);
    const out = [];
    for (let i = 0; i < capped.length; i++) {
      const it = capped[i];
      const img = await PhotosPicker.fetchImageBase64(it.baseUrl, 1024);
      // baseUrl 보존(저장 시 고화질 재취득용) + createTime 보존(촬영일 자동 감지용)
      out.push({ ...img, name: it.filename || '', id: '', baseUrl: it.baseUrl, createTime: it.createTime || '' });
      if (s) s.querySelector('span:last-child').textContent = `⬇️ 선택한 사진 불러오는 중... (${i + 1}/${capped.length})`;
    }
    _done(s, `${out.length}장 로드 완료`);
    return out;
  }

  // ── 실패/우회 이력(최근 30건) — 토스트는 순간 표시·콘솔은 새로고침에 소실되어
  //    나중에 원인 확인이 불가능한 문제 보완. 확인: 브라우저 콘솔에서 DiaryAgent.failLog()
  const FAIL_LOG_KEY = 'dachangi_fail_log';
  function _logFail(stage, msg) {
    console.warn(`[Diary:${stage}]`, msg);
    try {
      const log = JSON.parse(localStorage.getItem(FAIL_LOG_KEY) || '[]');
      log.push({ t: new Date().toISOString().slice(0, 19).replace('T', ' '), stage, msg: String(msg) });
      localStorage.setItem(FAIL_LOG_KEY, JSON.stringify(log.slice(-30)));
    } catch (_) {}
  }
  function failLog() { try { return JSON.parse(localStorage.getItem(FAIL_LOG_KEY) || '[]'); } catch (_) { return []; } }

  async function run(opts) {
    if (_busy) return;
    const cfg = window.DACHANGI_CONFIG || {};
    let dateStr = opts.dateStr; // 촬영일 자동 감지로 도중에 교정될 수 있음
    const candCount = Math.max(3, Math.min(20, opts.candCount || 10));
    const topCount = Math.max(1, Math.min(5, opts.topCount || 3));
    const source = cfg.PHOTO_SOURCE || 'photos';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { showToast('날짜를 선택하세요.', 'error'); return; }

    _busy = true;
    _clearProgress();
    document.getElementById('result-card').style.display = 'none';
    // 실패/취소로 중단될 때 직전 결과 카드를 되살려, 수정 중이던 텍스트 접근이 막히지 않게 한다
    const restoreCard = () => { if (_last) { const rc = document.getElementById('result-card'); if (rc) rc.style.display = 'block'; } };
    const genBtn = document.getElementById('generate-btn');
    if (genBtn) { genBtn.disabled = true; }
    const manualBtnR = document.getElementById('manual-btn');
    if (manualBtnR) { manualBtnR.disabled = true; }

    try {
      // 파이프라인이 수 분 걸릴 수 있어, 토큰 잔여 수명이 짧으면 클릭 제스처 안에서 선제 갱신.
      //  단 photos 소스는 갱신 팝업이 포토 선택 팝업의 제스처를 소모해 차단시키므로 건너뛴다
      //  (포토 흐름 중 401은 photos_picker가 중단 처리하고, 이후 Drive/Sheets 호출은 _req가 401 자동 재시도).
      if (source !== 'photos') { try { if (Auth.ensureFreshToken) await Auth.ensureFreshToken(10 * 60 * 1000); } catch (_) {} }

      const candImages = source === 'photos'
        ? await _gatherFromPhotos(cfg, candCount, dateStr)
        : await _gatherFromDrive(cfg, dateStr, candCount);
      if (!candImages) { restoreCard(); return; }

      // 촬영일 자동 감지(포토 소스 전용): 고른 사진들의 실제 촬영일이 선택한 날짜와 다르면 교정 제안.
      //  사진을 보고서야 날짜를 깨닫는 경우, 잘못된 날짜로 자동 저장되기 전에 잡는다.
      if (source === 'photos') {
        const counts = {};
        candImages.forEach(im => { const d = _localDateFromIso(im.createTime); if (d) counts[d] = (counts[d] || 0) + 1; });
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (top && top[0] !== dateStr) {
          const [photoDate, n] = top;
          if (confirm(`고른 사진 ${candImages.length}장 중 ${n}장이 ${photoDate} 촬영입니다.\n(선택한 날짜: ${dateStr})\n\n[확인] ${photoDate} 일기로 작성 / [취소] ${dateStr} 그대로`)) {
            dateStr = photoDate;
            const dEl = document.getElementById('diary-date'); if (dEl) dEl.value = dateStr;
            showToast(`작성 날짜를 촬영일(${dateStr})로 바꿨어요.`);
          }
        }
      }

      let s = _step('🤖 Gemini로 대표 사진 랭킹 중...', true);
      const rankRes = await GeminiAPI.rankPhotos(candImages, topCount);
      // 1-based → 후보 인덱스 매핑 (중복 번호 응답 방어)
      const topImages = [];
      const seen = new Set();
      if (!rankRes.skip && Array.isArray(rankRes.ranking)) {
        for (const oneBased of rankRes.ranking) {
          const idx = oneBased - 1;
          if (idx >= 0 && idx < candImages.length && !seen.has(idx)) { seen.add(idx); topImages.push(candImages[idx]); }
          if (topImages.length >= topCount) break;
        }
      }
      // 랭킹 SKIP/매핑 실패로 더는 중단하지 않는다 — 직접 고른(또는 그날 찍은) 사진이므로
      // 해상도순 상위로 계속 진행(밀린 일기 일괄 생성과 동일 정책). 사유는 토스트+실패 로그에 남긴다.
      if (!topImages.length) {
        const why = rankRes.reason || '적합한 사진 없음';
        _logFail('랭킹', `${dateStr}: AI 랭킹 SKIP(${why}) → 해상도순 상위 사진으로 계속 진행`);
        showToast(`AI가 대표 사진을 못 골랐어요(${why}) — 해상도 순으로 계속 진행합니다.`);
        for (let i = 0; i < Math.min(topCount, candImages.length); i++) topImages.push(candImages[i]);
        _done(s, `랭킹 SKIP(${why}) → 해상도순 ${topImages.length}장으로 진행`);
      } else {
        _done(s, `대표 사진 ${topImages.length}장 선정`);
      }

      // 등록된 인물(얼굴+이름)을 참조로 전달 → 사진 속 인물 인지
      let people = [];
      try { if (typeof PeopleStore !== 'undefined') people = await PeopleStore.loadForPrompt(); } catch (_) {}

      const style = await _resolveStyle(opts.style, dateStr);
      const keywords = (opts.keywords || '').trim();
      const learnNote = (style.styleKey === 'junghyun' && style.samples && style.samples.length) ? ` · 직접 쓴 일기 ${style.samples.length}편 문체 학습` : '';
      s = _step(`✍️ Gemini로 일기 작성 중...${people.length ? ` (인물 ${people.length}명 참조)` : ''}${keywords ? ' · 키워드 반영' : ''}${learnNote}`, true);
      const diary = await GeminiAPI.generateDiary(topImages, dateStr, cfg.DIARY_PROMPT || '', people, style, keywords);
      if (!diary || diary.trim().toUpperCase() === 'SKIP') { _logFail('작성', `${dateStr}: AI가 일기 작성을 SKIP`); _done(s, 'AI가 작성 SKIP'); showToast('AI가 일기 작성을 SKIP 했습니다.', 'error'); restoreCard(); return; }
      _done(s, '일기 작성 완료');

      // 사이드바 날짜 옆에 표시할 짧은 제목(10자 이내) 생성. 실패해도 일기 저장은 진행.
      let title = '';
      try { const ts = _step('🏷️ 제목 짓는 중...', true); title = await GeminiAPI.generateTitle(diary); _done(ts, title ? `제목: ${title}` : '제목 생략'); }
      catch (e) { console.warn('[Diary] 제목 생성 실패:', e); }

      // 사용자가 대표 사진을 직접 고를 수 있도록 후보 전체를 보관(기본 대표 = Gemini 1순위)
      const allImages = candImages;
      const repDefaultIdx = Math.max(0, allImages.indexOf(topImages[0]));
      // 첨부 기본값 = AI 상위 최대 3장(allImages 인덱스). 사용자가 결과 카드에서 클릭으로 바꿈.
      const _attachDefault = topImages.slice(0, 3).map(t => allImages.indexOf(t)).filter(i => i >= 0);
      _last = { dateStr, diary, source, allImages, topImages, bestIndex: repDefaultIdx, attachIdxs: _attachDefault.length ? _attachDefault : [repDefaultIdx], _uploadCache: {}, bestId: '', bestThumb: '', style, keywords, title };

      // 기본 대표 사진을 영구·고화질로 보관(포토=드라이브 업로드, 실패 시 시트 썸네일 폴백)
      let bestThumb = '';
      let bestId = (topImages[0] || {}).id || '';
      if (source === 'photos' && topImages[0]) {
        const rep = topImages[0];
        s = _step('☁️ 대표 사진 고화질로 드라이브에 저장 중...', true);
        try {
          const hi = rep.baseUrl ? await PhotosPicker.fetchImageBase64(rep.baseUrl, 2048) : { mime: rep.mime, data: rep.data };
          bestId = await DriveAPI.uploadPhoto(`${dateStr} 대표.jpg`, hi.data, hi.mime);
          _last._uploadCache[repDefaultIdx] = bestId;
          _done(s, '드라이브에 고화질 저장 완료');
        } catch (e) {
          console.warn('[Diary] 드라이브 사진 업로드 실패, 시트 썸네일 폴백:', e);
          _done(s, '드라이브 저장 실패 — 시트 썸네일로 대체');
          bestId = '';
          try { bestThumb = await _makeThumb(rep, 512); } catch (_) {}
        }
      }
      _last.bestId = bestId;
      _last.bestThumb = bestThumb;

      _render(dateStr, allImages, repDefaultIdx, diary);

      // 자동 저장 (이후 결과 카드에서 텍스트 수정·대표 사진 변경 후 💾로 재등록 가능)
      //  저장 중에는 💾 버튼을 잠가 자동 저장과의 동시 실행(중복 행)을 방지
      s = _step('💾 구글 시트에 자동 저장 중...', true);
      const saveBtn = document.getElementById('save-diary-btn');
      if (saveBtn) saveBtn.disabled = true;
      try {
        // 첨부로 고른 사진(기본=AI 상위, 최대 3장)을 영구 보관 → photoIds 로 저장
        const _photoIds = await _persistAttached(_last, dateStr);
        const _fallbackId = bestId || (topImages[0] || {}).id || '';
        await DiaryStore.saveEntry({
          date: dateStr,
          text: diary.trim(),
          bestPhotoId: _photoIds[0] || _fallbackId,
          photoIds: _photoIds.length ? _photoIds : (_fallbackId ? [_fallbackId] : []),
          thumb: _photoIds.length ? '' : (bestThumb || ''),
          title,
        });
        if (saveBtn) saveBtn.disabled = false;
        _done(s, '시트에 자동 저장 완료');
        if (typeof renderMonthList === 'function') renderMonthList();
        showToast('✅ 일기 생성 + 자동 저장 완료!');
        // 인물 대조·감지(비차단). 처리 완료를 표시해, 이후 이 일기를 '수동'으로 바꿔 💾(finalize)해도 중복 카운트되지 않게 한다.
        if (_last) _last._facesProcessed = true;
        try { await _processFaces(topImages); } catch (_) {}
      } catch (e) {
        if (saveBtn) saveBtn.disabled = false;
        _logFail('저장', `${dateStr}: 자동 저장 실패 — ${e.message || e}`);
        console.error('[Diary] 자동 저장 실패:', e);
        _done(s, '자동 저장 실패 — 💾 버튼으로 저장하세요');
        showToast('일기는 생성됐지만 자동 저장 실패: ' + (e.message || e), 'error');
      }
    } catch (e) {
      _logFail('생성', `${dateStr}: ${e.message || e}`);
      console.error('[Diary] 실패:', e);
      showToast('❌ 생성 실패: ' + (e.message || e), 'error');
      restoreCard();
    } finally {
      _busy = false;
      const b = document.getElementById('generate-btn'); if (b) b.disabled = false;
      const mb = document.getElementById('manual-btn'); if (mb) mb.disabled = false;
    }
  }

  // 수동 작성 — Gemini 랭킹/일기 생성을 건너뛰고 사진만 준비해 결과 카드를 연다.
  //  사진 선택·촬영일 자동감지·대표 사진 선택은 자동(run)과 동일. 본문은 사용자가 직접 쓰고
  //  💾로 저장(자동 저장하지 않음). 저장된 일기는 '수동'으로 표기되고, 사람 감지는 저장 시 동작.
  async function runManual(opts) {
    if (_busy) return;
    const cfg = window.DACHANGI_CONFIG || {};
    let dateStr = opts.dateStr; // 촬영일 자동 감지로 교정될 수 있음
    const candCount = Math.max(3, Math.min(20, opts.candCount || 10));
    const topCount = Math.max(1, Math.min(5, opts.topCount || 3));
    const source = cfg.PHOTO_SOURCE || 'photos';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { showToast('날짜를 선택하세요.', 'error'); return; }

    _busy = true;
    _clearProgress();
    document.getElementById('result-card').style.display = 'none';
    const restoreCard = () => { if (_last) { const rc = document.getElementById('result-card'); if (rc) rc.style.display = 'block'; } };
    const genBtn = document.getElementById('generate-btn'); if (genBtn) genBtn.disabled = true;
    const manualBtn = document.getElementById('manual-btn'); if (manualBtn) manualBtn.disabled = true;

    try {
      // photos 소스는 토큰 갱신 팝업이 포토 선택 팝업의 제스처를 소모하므로 선제 갱신을 건너뜀(run과 동일)
      if (source !== 'photos') { try { if (Auth.ensureFreshToken) await Auth.ensureFreshToken(10 * 60 * 1000); } catch (_) {} }

      const candImages = source === 'photos'
        ? await _gatherFromPhotos(cfg, candCount, dateStr)
        : await _gatherFromDrive(cfg, dateStr, candCount);
      if (!candImages) { restoreCard(); return; }

      // 촬영일 자동 감지(포토 소스 전용) — 자동 생성과 동일하게, 직접 쓰기 전에 날짜를 바로잡는다
      if (source === 'photos') {
        const counts = {};
        candImages.forEach(im => { const d = _localDateFromIso(im.createTime); if (d) counts[d] = (counts[d] || 0) + 1; });
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (top && top[0] !== dateStr) {
          const [photoDate, n] = top;
          if (confirm(`고른 사진 ${candImages.length}장 중 ${n}장이 ${photoDate} 촬영입니다.\n(선택한 날짜: ${dateStr})\n\n[확인] ${photoDate} 일기로 작성 / [취소] ${dateStr} 그대로`)) {
            dateStr = photoDate;
            const dEl = document.getElementById('diary-date'); if (dEl) dEl.value = dateStr;
            showToast(`작성 날짜를 촬영일(${dateStr})로 바꿨어요.`);
          }
        }
      }

      // 랭킹/작성 없이 사진만 준비. 대표 기본 = 해상도 1위(첫 장), 사진ID 저장 대상 = 상위 topCount장.
      //  사용자가 결과 카드에서 대표 사진을 직접 클릭해 바꿀 수 있다.
      const allImages = candImages;
      const topImages = candImages.slice(0, topCount);
      const s = _step('✍️ 직접 작성 모드 — 사진 준비 완료', true);
      _done(s, '사진 준비 완료 — 아래에 일기를 직접 쓰고 💾로 저장하세요');

      _last = { dateStr, diary: '', source, allImages, topImages, bestIndex: 0, attachIdxs: topImages.slice(0, 3).map((_, i) => i), _uploadCache: {}, bestId: (topImages[0] || {}).id || '', bestThumb: '', style: {}, keywords: '', type: 'manual', title: '' };
      _render(dateStr, allImages, 0, '');
      const ta = document.getElementById('diary-text'); if (ta) ta.focus();
    } catch (e) {
      _logFail('수동작성', `${dateStr}: ${e.message || e}`);
      console.error('[Diary] 수동 작성 준비 실패:', e);
      showToast('❌ 사진 준비 실패: ' + (e.message || e), 'error');
      restoreCard();
    } finally {
      _busy = false;
      if (genBtn) genBtn.disabled = false;
      if (manualBtn) manualBtn.disabled = false;
    }
  }

  // 메모리의 큰 사진(base64) → JPEG 썸네일 base64 (시트 셀 한도 안에서 화질 최대화).
  //  시트 셀은 5만 자 한도라 maxLen(≈46000) 이하가 되도록 품질을, 그래도 크면 해상도를 단계적으로 낮춤.
  function _makeThumb(img, maxDim) {
    maxDim = maxDim || 512;
    const maxLen = 46000;
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const draw = (dim) => {
            const scale = Math.min(1, dim / Math.max(image.width, image.height));
            const w = Math.max(1, Math.round(image.width * scale));
            const h = Math.max(1, Math.round(image.height * scale));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(image, 0, 0, w, h);
            return c;
          };
          let best = '';
          // 해상도를 512→410→328로 낮춰가며, 각 단계에서 높은 품질부터 시도해 한도 이하 중 최고 화질 선택
          for (const dim of [maxDim, Math.round(maxDim * 0.8), Math.round(maxDim * 0.64)]) {
            const c = draw(dim);
            for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
              const b64 = c.toDataURL('image/jpeg', q).split(',')[1] || '';
              best = b64;
              if (b64.length <= maxLen) { resolve(b64); return; }
            }
          }
          resolve(best.length <= maxLen ? best : ''); // 끝까지 못 맞추면 저장 생략
        } catch (_) { resolve(''); }
      };
      image.onerror = () => resolve('');
      image.src = `data:${img.mime};base64,${img.data}`;
    });
  }

  // 대표 외 '선택 사진'들도 영구 보관 → 드라이브 fileId 배열 반환.
  //  · 포토 소스: 각 사진을 드라이브에 업로드(대표보다 작은 1280px). cache가 있으면(=자동저장·💾 재저장)
  //    allImages 인덱스 기준으로 이미 올린 건 재사용해 중복 업로드를 막는다.
  //  · 드라이브 소스: 원본 파일ID가 영구이므로 그대로 사용(업로드 없음).
  //  실패한 사진은 조용히 건너뛴다(대표 1장은 이 함수와 무관하게 이미 저장됨).
  async function _persistExtras(source, dateStr, extras, cache, allImages) {
    const ids = [];
    for (let i = 0; i < (extras || []).length; i++) {
      const img = extras[i];
      if (!img) continue;
      let id = '';
      if (source === 'photos') {
        const idx = (cache && allImages) ? allImages.indexOf(img) : -1;
        if (idx >= 0 && cache[idx]) { id = cache[idx]; }
        else {
          try {
            const hi = img.baseUrl ? await PhotosPicker.fetchImageBase64(img.baseUrl, 1280) : { mime: img.mime, data: img.data };
            id = await DriveAPI.uploadPhoto(`${dateStr} (${i + 2}).jpg`, hi.data, hi.mime);
            if (idx >= 0) cache[idx] = id;
          } catch (e) { console.warn('[Diary] 추가 사진 저장 실패:', e); }
        }
      } else {
        id = img.id || '';
      }
      if (id) ids.push(id);
    }
    return ids;
  }

  // 첨부로 고른 사진(attachIdxs 순서, ①=표지)을 전부 영구 보관 → [표지, ...] drive fileId 배열(최대 3).
  //  포토 소스: 각 사진 드라이브 업로드(표지 2048px·나머지 1280px, _uploadCache 재사용). 드라이브 소스: 원본 파일ID.
  async function _persistAttached(snap, dateStr) {
    const idxs = (snap.attachIdxs && snap.attachIdxs.length ? snap.attachIdxs : [snap.bestIndex || 0]).slice(0, 3);
    const ids = [];
    for (let n = 0; n < idxs.length; n++) {
      const img = snap.allImages[idxs[n]];
      if (!img) continue;
      const isCover = (n === 0);
      let id = '';
      if (snap.source === 'photos') {
        if (snap._uploadCache[idxs[n]]) { id = snap._uploadCache[idxs[n]]; }
        else {
          try {
            const hi = img.baseUrl ? await PhotosPicker.fetchImageBase64(img.baseUrl, isCover ? 2048 : 1280) : { mime: img.mime, data: img.data };
            id = await DriveAPI.uploadPhoto(`${dateStr}${isCover ? ' 대표' : ' ' + (n + 1)}.jpg`, hi.data, hi.mime);
            snap._uploadCache[idxs[n]] = id;
          } catch (e) { console.warn('[Diary] 첨부 사진 저장 실패:', e); }
        }
      } else {
        id = img.id || '';
      }
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    return ids;
  }

  // [대표ID, ...추가ID] 를 중복 제거하고 최대 maxN장으로 — 저장할 photoIds 구성(배치 전용)
  function _mergePhotoIds(repId, extraIds, maxN) {
    const out = [];
    [repId].concat(extraIds || []).forEach(v => { if (v && out.indexOf(v) === -1) out.push(v); });
    return out.slice(0, Math.max(1, maxN || 3));
  }

  // 경계상자(box: [ymin,xmin,ymax,xmax] 0~1000)로 얼굴 부분을 잘라 작은 JPEG base64로
  function _cropFace(img, box, outDim) {
    outDim = outDim || 256;
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const W = image.width, H = image.height;
          let x = (box[1] / 1000) * W, y = (box[0] / 1000) * H;
          let w = Math.max(1, ((box[3] - box[1]) / 1000) * W);
          let h = Math.max(1, ((box[2] - box[0]) / 1000) * H);
          const px = w * 0.25, py = h * 0.25; // 여유 패딩
          x = Math.max(0, x - px); y = Math.max(0, y - py);
          w = Math.min(W - x, w + 2 * px); h = Math.min(H - y, h + 2 * py);
          const scale = Math.min(1, outDim / Math.max(w, h));
          const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
          const c = document.createElement('canvas');
          c.width = ow; c.height = oh;
          c.getContext('2d').drawImage(image, x, y, w, h, 0, 0, ow, oh);
          resolve(c.toDataURL('image/jpeg', 0.8).split(',')[1] || '');
        } catch (_) { resolve(''); }
      };
      image.onerror = () => resolve('');
      image.src = `data:${img.mime};base64,${img.data}`;
    });
  }

  // 사진 속 인물을 기존 얼굴과 대조 → 같은 사람은 감지횟수 +1, 신규는 '관찰'로 추가.
  //  감지횟수가 임계치(THRESHOLD)에 도달하면 '확인 필요'로 승격해 사용자에게 물어봄. (비차단)
  async function _processFaces(topImages) {
    if (typeof PeopleStore === 'undefined' || !GeminiAPI.analyzeFaces) return;
    const s = _step('🔎 사진 속 인물 분석 중...', true);
    let known = [];
    try { known = await PeopleStore.loadAllFaces(); } catch (_) {}
    let res;
    try { res = await GeminiAPI.analyzeFaces(topImages, known); }
    catch (e) { _done(s, '인물 분석 건너뜀'); return; }
    const results = (res && res.results) || [];
    let promoted = 0, observed = 0;
    for (const r of results.slice(0, 5)) {
      if (typeof r.match === 'number' && r.match >= 0 && r.match < known.length) {
        const k = known[r.match];
        if (!k.name && k.count != null) { // 미명명 관찰 대상만 카운트(이미 확인/대기는 제외)
          try { await PeopleStore.incrementSighting(k.rowIndex, k.count); if (k.count + 1 === PeopleStore.THRESHOLD) promoted++; } catch (_) {}
        }
      } else if (r.match === -1 && Array.isArray(r.box) && r.box.length >= 4) {
        const img = topImages[(r.image || 1) - 1];
        if (!img) continue;
        const crop = await _cropFace(img, r.box, 256);
        if (crop) { try { await PeopleStore.addObservation(crop); observed++; } catch (_) {} }
      }
    }
    _done(s, promoted ? `자주 보이는 인물 ${promoted}명 확인 필요` : (observed ? '새 얼굴 관찰 시작' : '인물 분석 완료'));
    if (typeof updatePeopleBadge === 'function') updatePeopleBadge();
    if (promoted) showToast(`👤 ${PeopleStore.THRESHOLD}회 이상 등장한 인물 ${promoted}명! 👥 인물 관리에서 누군지 입력해 주세요.`);
  }

  function _render(dateStr, images, bestIdx, diary) {
    const rd = document.getElementById('result-date');
    if (rd) rd.value = dateStr; // 날짜를 바꾸고 💾를 누르면 그 날짜로 이동 등록(_finalizeImpl)
    _renderStrip(document.getElementById('photo-strip'), images);
    document.getElementById('diary-text').value = diary.trim();
    _markManualCard(_last && _last.type === 'manual'); // 수동/자동에 따라 결과 카드 표기 전환
    // CSS에 #result-card{display:none}이 있어 ''로 두면 다시 숨겨짐 → 'block'으로 명시해야 저장 버튼이 보임
    document.getElementById('result-card').style.display = 'block';
    document.getElementById('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 사진 줄(strip)을 '첨부 선택기'로 렌더 — 클릭으로 일기에 넣을 사진 1~3장 토글, 번호(①②③) 표시(①=표지).
  function _renderStrip(strip, images) {
    if (!strip) return;
    const attach = (_last && _last.attachIdxs) || [];
    strip.innerHTML = images.map((im, i) => {
      const pos = attach.indexOf(i);
      const sel = pos >= 0;
      const badge = sel ? `<span class="ph-badge">${pos + 1}</span>` : '';
      return `<span class="ph-wrap${sel ? ' sel' : ''}${pos === 0 ? ' cover' : ''}" data-idx="${i}"><img src="data:${im.mime};base64,${im.data}" title="${_escAttr(im.name || '')}" />${badge}</span>`;
    }).join('');
    strip.querySelectorAll('.ph-wrap').forEach(w => w.addEventListener('click', () => {
      _toggleAttach(parseInt(w.dataset.idx, 10));
      _renderStrip(strip, images);
    }));
  }

  // 첨부 토글 — 최대 3장, 최소 1장. 선택 순서가 곧 표시 순서이며 첫 번째가 표지(대표).
  function _toggleAttach(idx) {
    if (!_last) return;
    const arr = _last.attachIdxs = (_last.attachIdxs || []);
    const at = arr.indexOf(idx);
    if (at >= 0) {
      if (arr.length <= 1) { if (typeof showToast === 'function') showToast('최소 1장은 넣어야 해요.'); return; }
      arr.splice(at, 1);
    } else {
      if (arr.length >= 3) { if (typeof showToast === 'function') showToast('사진은 최대 3장까지 넣을 수 있어요.'); return; }
      arr.push(idx);
    }
    _last.bestIndex = arr[0]; // 표지 = 첫 번째 선택
  }

  // 결과 카드를 '수동 작성' 모드로 표기 전환 — 뱃지/안내문/플레이스홀더를 바꾸고,
  //  수동 일기엔 의미 없는 'AI 다시 생성' 버튼은 숨긴다.
  function _markManualCard(isManual) {
    const badge = document.getElementById('manual-badge');
    if (badge) badge.style.display = isManual ? '' : 'none';
    const meta = document.getElementById('result-meta');
    if (meta) meta.innerHTML = isManual
      ? '사진 — <b>일기에 넣을 사진을 1~3장 클릭해 고르세요</b> (번호 = 순서, ①=표지). 아래에 <b>오늘의 일기를 직접 작성</b>하고 💾로 저장하세요.'
      : '사진 — <b>일기에 넣을 사진을 1~3장 클릭해 고르세요</b> (번호 = 순서, ①=표지). 일기 내용도 아래에서 수정할 수 있어요.';
    const ta = document.getElementById('diary-text');
    if (ta) ta.placeholder = isManual ? '여기에 오늘의 일기를 직접 작성하세요...' : '일기가 여기에 표시됩니다.';
    const regen = document.getElementById('regenerate-btn');
    if (regen) regen.style.display = isManual ? 'none' : '';
    // 수동 표시 체크박스도 현재 작성방식에 맞춰 동기화(직접 쓰기=항상 켜짐, 자동=꺼짐으로 시작)
    const toggle = document.getElementById('manual-toggle');
    if (toggle) toggle.checked = isManual;
  }

  // 결과 카드의 '수동 표시' 토글 — 자동 생성한 일기를 직접 고친 뒤 '수동(정현체 학습 대상)'으로
  //  표시할 때 호출. 카드 레이아웃(다시 생성 버튼 등)은 그대로 두고 저장될 작성방식만 바꾼다.
  function setManual(on) {
    if (!_last) return;
    _last.type = on ? 'manual' : '';
    const badge = document.getElementById('manual-badge');
    if (badge) badge.style.display = on ? '' : 'none';
    const toggle = document.getElementById('manual-toggle');
    if (toggle && toggle.checked !== on) toggle.checked = on;
  }

  function _escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function getLast() { return _last; }
  function setBestIndex(i) { if (_last) _last.bestIndex = i; }

  // 히스토리에서 일기 날짜를 바꾸면 _last를 동기화 — 안 하면 💾가 옛 날짜로 중복 행을 만든다
  function onEntryDateChanged(oldDate, newDate) {
    if (_last && _last.dateStr === oldDate) _last.dateStr = newDate;
  }
  // 히스토리에서 일기를 삭제하면 _last를 무효화 — 안 하면 💾 한 번에 삭제한 일기가 부활한다
  function onEntryDeleted(date) {
    if (_last && _last.dateStr === date) {
      _last = null;
      const rc = document.getElementById('result-card');
      if (rc) rc.style.display = 'none';
    }
  }

  // 같은 사진(직전 생성의 대표 후보)으로 본문만 다시 생성 — 문체·어투 변경을 빠르게 비교.
  //  자동 저장하지 않음: 마음에 들면 💾 버튼으로 등록.
  async function regenerateText(styleOpts, keywords) {
    if (_busy) return;
    if (!_last) { showToast('먼저 일기를 생성하세요.', 'error'); return; }
    const cfg = window.DACHANGI_CONFIG || {};
    _busy = true;
    _clearProgress();
    const genBtn = document.getElementById('generate-btn');
    if (genBtn) genBtn.disabled = true;
    try {
      const style = await _resolveStyle(styleOpts, _last.dateStr);
      // 키워드 미전달(undefined)이면 직전 생성 때 값을 유지, 전달되면(빈 문자열 포함) 그 값을 사용
      const kw = keywords === undefined ? (_last.keywords || '') : String(keywords || '').trim();
      let people = [];
      try { if (typeof PeopleStore !== 'undefined') people = await PeopleStore.loadForPrompt(); } catch (_) {}
      const s = _step(`✍️ 같은 사진으로 일기 다시 쓰는 중...${kw ? ' (키워드 반영)' : ''}`, true);
      const diary = await GeminiAPI.generateDiary(_last.topImages, _last.dateStr, cfg.DIARY_PROMPT || '', people, style, kw);
      if (!diary || diary.trim().toUpperCase() === 'SKIP') { _done(s, 'AI가 작성 SKIP'); showToast('AI가 일기 작성을 SKIP 했습니다.', 'error'); return; }
      _done(s, '다시 작성 완료 — 마음에 들면 💾 버튼으로 등록');
      _last.diary = diary;
      _last.style = style;
      _last.keywords = kw;
      document.getElementById('diary-text').value = diary.trim();
      document.getElementById('result-card').style.display = 'block';
      showToast('✅ 새 문체로 다시 썼어요. 등록하려면 💾를 누르세요.');
    } catch (e) {
      console.error('[Diary] 재생성 실패:', e);
      showToast('❌ 재생성 실패: ' + (e.message || e), 'error');
    } finally {
      _busy = false;
      const b = document.getElementById('generate-btn'); if (b) b.disabled = false;
    }
  }

  // ── 여러 날 일괄 생성 (밀린 일기) ───────────────────────────
  function _localDateFromIso(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function _monthsBetween(start, end) {
    const out = [];
    let y = parseInt(start.slice(0, 4), 10), m = parseInt(start.slice(5, 7), 10);
    const ey = parseInt(end.slice(0, 4), 10), em = parseInt(end.slice(5, 7), 10);
    for (let guard = 0; guard < 240 && (y < ey || (y === ey && m <= em)); guard++) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  function _batchStep(prog, msg, spinner) {
    if (prog) prog.innerHTML = `<div class="step"><span>${spinner ? '<span class="spinner"></span>' : '✅'}</span><span>${_escAttr(msg)}</span></div>`;
  }

  // 포토: 여러 날 사진을 한 번에 골라 촬영일(createTime)별로 그룹핑 → { 'yyyy-MM-dd': [items] }
  async function _batchGatherPhotos(cfg, prog) {
    const cancelRef = { cancelled: false };
    const render = (msg) => {
      if (!prog) return;
      prog.innerHTML = `<div class="step"><span class="spinner"></span><span>${_escAttr(msg)}</span> <button type="button" class="btn btn-ghost batch-cancel" style="padding:2px 10px; font-size:11px;">취소</button></div>`;
      const cb = prog.querySelector('.batch-cancel');
      if (cb) cb.addEventListener('click', () => { cancelRef.cancelled = true; cb.disabled = true; cb.textContent = '취소 중...'; });
    };
    render('📷 포토에서 여러 날 사진을 한 번에 고르고 "완료"를 누르세요...');
    let picked;
    try { picked = await PhotosPicker.pick(m => render(m), cancelRef); }
    catch (e) { showToast('사진 선택 실패: ' + (e.message || e), 'error'); return null; }
    if (!picked || !picked.length) { showToast('선택된 사진이 없습니다.', 'error'); return null; }
    const groups = {};
    let undated = 0;
    picked.forEach(it => {
      const d = _localDateFromIso(it.createTime);
      if (!d) { undated++; return; }
      (groups[d] = groups[d] || []).push({ baseUrl: it.baseUrl, width: it.width || 0, height: it.height || 0, filename: it.filename || '' });
    });
    if (undated) showToast(`촬영일을 알 수 없는 ${undated}장은 제외했습니다.`);
    return groups;
  }

  // 드라이브: 기간(start~end)에 걸친 월 폴더들을 훑어 날짜별 그룹핑
  async function _batchGatherDrive(cfg, startDate, endDate, prog) {
    if (!cfg.MAIN_PHOTO_FOLDER_ID) { showToast('설정에서 사진 메인 폴더 ID를 입력하세요.', 'error'); return null; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) { showToast('시작/끝 날짜를 선택하세요.', 'error'); return null; }
    if (startDate > endDate) { showToast('시작 날짜가 끝 날짜보다 늦습니다.', 'error'); return null; }
    const groups = {};
    for (const m of _monthsBetween(startDate, endDate)) {
      _batchStep(prog, `📁 ${m} 폴더 사진 조회 중...`, true);
      const folder = await DriveAPI.findMonthFolder(cfg.MAIN_PHOTO_FOLDER_ID, m);
      if (!folder) continue;
      const all = await DriveAPI.listImages(folder.id);
      all.forEach(p => {
        const d = DriveAPI.photoDateStr(p);
        if (d >= startDate && d <= endDate) (groups[d] = groups[d] || []).push(p);
      });
    }
    return groups;
  }

  // 일괄 생성용 키워드 파싱 — 한 줄에 하나씩. "yyyy-MM-dd: 키워드"는 그날 전용, 날짜 없는 줄은 전체 공통.
  function _parseBatchKeywords(raw) {
    const perDate = {}; const common = [];
    String(raw || '').split('\n').forEach(line => {
      const t = line.trim(); if (!t) return;
      const m = t.match(/^(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.+)$/);
      if (m) perDate[m[1]] = (perDate[m[1]] ? perDate[m[1]] + ', ' : '') + m[2].trim();
      else common.push(t);
    });
    return { perDate, common: common.join(', ') };
  }

  // 한 날짜의 사진들로 일기 1편 작성·저장(결과 카드 없이 바로 저장). 단건 run()의 축약판.
  async function _batchGenerateOne(cfg, source, date, items, candCount, topCount, style, people, keywords) {
    let cands;
    if (source === 'photos') {
      const sorted = items.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height)).slice(0, candCount);
      cands = [];
      for (const it of sorted) {
        const img = await PhotosPicker.fetchImageBase64(it.baseUrl, 1024);
        cands.push({ mime: img.mime, data: img.data, id: '', baseUrl: it.baseUrl, name: it.filename || '' });
      }
    } else {
      const sel = DriveAPI.selectByResolution(items, candCount);
      cands = [];
      for (const c of sel) {
        const img = await DriveAPI.fetchImageBase64(c.id, 1024);
        cands.push({ mime: img.mime, data: img.data, id: c.id, name: c.name });
      }
    }
    if (!cands.length) throw new Error('사진 로드 실패');

    const rankRes = await GeminiAPI.rankPhotos(cands, topCount);
    const topImages = [];
    const seen = new Set();
    if (!rankRes.skip && Array.isArray(rankRes.ranking)) {
      for (const ob of rankRes.ranking) {
        const idx = ob - 1;
        if (idx >= 0 && idx < cands.length && !seen.has(idx)) { seen.add(idx); topImages.push(cands[idx]); }
        if (topImages.length >= topCount) break;
      }
    }
    // 랭킹 실패/SKIP이어도 그날 찍은(또는 직접 고른) 사진이므로 해상도순 상위로 진행
    if (!topImages.length) {
      if (rankRes.skip) _logFail('랭킹', `${date}: AI 랭킹 SKIP(${rankRes.reason || '사유 없음'}) → 해상도순으로 진행`);
      for (let i = 0; i < Math.min(topCount, cands.length); i++) topImages.push(cands[i]);
    }

    const diary = await GeminiAPI.generateDiary(topImages, date, cfg.DIARY_PROMPT || '', people, style, keywords);
    if (!diary || diary.trim().toUpperCase() === 'SKIP') throw new Error('AI 작성 SKIP');

    let title = '';
    try { title = await GeminiAPI.generateTitle(diary); } catch (_) {} // 제목 실패는 일기 저장을 막지 않음

    let bestId = (topImages[0] || {}).id || '';
    let thumb = '';
    if (source === 'photos' && topImages[0]) {
      const rep = topImages[0];
      try {
        const hi = rep.baseUrl ? await PhotosPicker.fetchImageBase64(rep.baseUrl, 2048) : { mime: rep.mime, data: rep.data };
        bestId = await DriveAPI.uploadPhoto(`${date} 대표.jpg`, hi.data, hi.mime);
      } catch (e) { bestId = ''; try { thumb = await _makeThumb(rep, 512); } catch (_) {} }
    }
    // 대표 외 선택 사진도 영구 보관(배치는 캐시 없음 — 각 날짜 1회 생성이라 그대로 업로드)
    const _repIdB = bestId || (topImages[0] || {}).id || '';
    const _extraIdsB = await _persistExtras(source, date, topImages.slice(1), null, null);
    await DiaryStore.saveEntry({
      date, text: diary.trim(),
      bestPhotoId: _repIdB,
      photoIds: _mergePhotoIds(_repIdB, _extraIdsB, topImages.length),
      thumb,
      title,
    });
  }

  // 여러 날을 한 번에 — 포토는 다중 선택, 드라이브는 기간. 이미 일기가 있는 날은 건너뜀.
  async function runBatch(opts) {
    if (_busy) return;
    const cfg = window.DACHANGI_CONFIG || {};
    const candCount = Math.max(3, Math.min(20, opts.candCount || 10));
    const topCount = Math.max(1, Math.min(5, opts.topCount || 3));
    const source = cfg.PHOTO_SOURCE || 'photos';
    const prog = document.getElementById('batch-progress');
    _busy = true;
    const btn = document.getElementById('batch-btn'); if (btn) btn.disabled = true;
    const genBtn = document.getElementById('generate-btn'); if (genBtn) genBtn.disabled = true;
    try {
      // 드라이브만 선제 토큰 갱신(포토는 갱신 팝업이 선택 팝업 제스처를 소모하므로 건너뜀)
      if (source !== 'photos') { try { if (Auth.ensureFreshToken) await Auth.ensureFreshToken(10 * 60 * 1000); } catch (_) {} }

      const groups = source === 'photos'
        ? await _batchGatherPhotos(cfg, prog)
        : await _batchGatherDrive(cfg, opts.startDate, opts.endDate, prog);
      if (!groups) return;
      const dates = Object.keys(groups).sort();
      if (!dates.length) { _batchStep(prog, '대상 날짜의 사진이 없습니다.', false); showToast('처리할 사진이 없습니다.', 'error'); return; }

      // 이미 있는 날짜는 건너뜀(최신 시트 기준)
      let existing = new Set();
      try { existing = new Set((await DiaryStore.loadEntries()).map(e => e.date)); } catch (_) {}
      let people = [];
      try { if (typeof PeopleStore !== 'undefined') people = await PeopleStore.loadForPrompt(); } catch (_) {}
      const style = await _resolveStyle(opts.style, dates[0]); // 'mine' 문체 예시는 한 번만 로드
      const kw = _parseBatchKeywords(opts.keywords); // 공통 + 날짜별 키워드

      let made = 0, skipped = 0, failed = 0; const failedDates = [];
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        if (existing.has(date)) { skipped++; continue; }
        const dayKw = [kw.common, kw.perDate[date]].filter(Boolean).join(', ');
        _batchStep(prog, `(${i + 1}/${dates.length}) ${date} — 사진 ${groups[date].length}장으로 일기 쓰는 중...${dayKw ? ' (키워드 반영)' : ''}`, true);
        try { await _batchGenerateOne(cfg, source, date, groups[date], candCount, topCount, style, people, dayKw); made++; }
        catch (e) { console.warn('[Batch]', date, e.message || e); failed++; failedDates.push(date); }
      }
      _batchStep(prog, `완료 — 새 일기 ${made}편 · 건너뜀 ${skipped}${failed ? ` · 실패 ${failed} (${failedDates.join(', ')})` : ''}`, false);
      if (typeof renderMonthList === 'function') renderMonthList();
      showToast(`✅ 밀린 일기 ${made}편 작성 (건너뜀 ${skipped}, 실패 ${failed})`);
    } catch (e) {
      console.error('[Batch] 실패:', e);
      if (prog) prog.innerHTML = `<div class="step"><span>❌</span><span>${_escAttr(e.message || e)}</span></div>`;
      showToast('❌ 일괄 생성 실패: ' + (e.message || e), 'error');
    } finally {
      _busy = false;
      if (btn) btn.disabled = false;
      if (genBtn) genBtn.disabled = false;
    }
  }

  // 결과 카드의 수정 텍스트 + 선택한 대표 사진으로 최종 등록(같은 날짜 덮어쓰기)
  let _finalizing = false;
  async function finalize(text) {
    if (!_last) throw new Error('생성된 일기가 없습니다.');
    if (_finalizing) throw new Error('등록이 이미 진행 중입니다.');
    _finalizing = true;
    try {
      return await _finalizeImpl(text);
    } finally { _finalizing = false; }
  }
  async function _finalizeImpl(text) {
    const snap = _last; // 도중에 onEntryDeleted 등이 _last를 null로 바꿔도 동일 객체를 끝까지 참조(크래시 방지)
    const { allImages, topImages, source } = snap;
    // 결과 카드에서 날짜를 바꿨으면 그 날짜로 등록 — 자동 저장된 옛 날짜 행을 이동.
    //  새 날짜에 이미 일기가 있으면 updateEntry가 거부(다른 날 일기를 모르고 덮어쓰는 사고 방지).
    const rd = document.getElementById('result-date');
    const newDate = (rd && /^\d{4}-\d{2}-\d{2}$/.test(rd.value || '')) ? rd.value : snap.dateStr;
    if (newDate !== snap.dateStr) {
      try {
        await DiaryStore.updateEntry(snap.dateStr, newDate, (text || '').trim());
      } catch (e) {
        // 자동 저장이 실패해 옛 행이 없으면 새 날짜로 새로 저장(아래 saveEntry가 수행). 날짜 충돌 등은 그대로 알림.
        if (!/찾을 수 없/.test(e.message || '')) throw e;
      }
      snap.dateStr = newDate;
      const dEl = document.getElementById('diary-date'); if (dEl) dEl.value = newDate;
    }
    const dateStr = snap.dateStr;
    // 제목: 본문이 바뀌었거나 아직 제목이 없을 때만 새로 생성(불필요한 Gemini 호출 절약).
    //  수동 일기의 첫 저장(snap.diary='')도 여기서 본문 기준으로 제목을 만든다.
    const curText = (text || '').trim();
    let title = snap.title || '';
    if (!title || curText !== (snap.diary || '').trim()) {
      try { title = await GeminiAPI.generateTitle(curText); } catch (e) { console.warn('[Diary] finalize 제목 생성 실패:', e); }
    }
    // 첨부로 고른 사진(최대 3장, ①=표지)을 영구 보관 → photoIds
    const photoIds = await _persistAttached(snap, dateStr);
    let thumb = '';
    if (!photoIds.length) { // 전부 업로드 실패 → 표지 썸네일 폴백
      const cover = allImages[(snap.attachIdxs && snap.attachIdxs.length) ? snap.attachIdxs[0] : (snap.bestIndex || 0)];
      if (cover) try { thumb = await _makeThumb(cover, 512); } catch (_) {}
    }
    await DiaryStore.saveEntry({
      date: dateStr,
      text: curText,
      bestPhotoId: photoIds[0] || '',
      photoIds: photoIds,
      thumb: thumb,
      type: snap.type || '', // 'manual'이면 '수동'으로 표기 저장
      title,
    });
    snap.diary = text;
    snap.title = title;
    snap.bestId = photoIds[0] || '';
    snap.bestThumb = thumb;
    // 수동 일기는 자동 저장이 없어 여기서 인물 감지를 1회 실행(자동 생성의 _processFaces와 동일 역할, 비차단)
    if (snap.type === 'manual' && !snap._facesProcessed) {
      snap._facesProcessed = true;
      try { _processFaces(topImages).catch(() => {}); } catch (_) {}
    }
    return { ok: true };
  }

  return { run, runManual, runBatch, getLast, setBestIndex, setManual, finalize, regenerateText, onEntryDateChanged, onEntryDeleted, failLog };
})();
