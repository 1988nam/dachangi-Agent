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

  // 문체 옵션 해석 — 'mine'(내 일기 문체)은 시트에 저장된 최근 일기 본문을 예시로 로드.
  //  예시가 없으면 기본 문체로 폴백(빈 styleKey).
  async function _resolveStyle(style, dateStr) {
    const st = Object.assign({}, style || {});
    if (st.styleKey !== 'mine') return st;
    try {
      const entries = await DiaryStore.loadEntries(); // 최신순
      st.samples = entries
        .filter(e => e.date !== dateStr && (e.text || '').trim().length >= 50)
        .slice(0, 3)
        .map(e => e.text.slice(0, 1200));
    } catch (e) { console.warn('[Diary] 문체 예시 로드 실패:', e); st.samples = []; }
    if (!st.samples.length) {
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
      out.push({ ...img, name: it.filename || '', id: '', baseUrl: it.baseUrl }); // baseUrl 보존(저장 시 고화질 재취득용)
      if (s) s.querySelector('span:last-child').textContent = `⬇️ 선택한 사진 불러오는 중... (${i + 1}/${capped.length})`;
    }
    _done(s, `${out.length}장 로드 완료`);
    return out;
  }

  async function run(opts) {
    if (_busy) return;
    const cfg = window.DACHANGI_CONFIG || {};
    const dateStr = opts.dateStr;
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

    try {
      // 파이프라인이 수 분 걸릴 수 있어, 토큰 잔여 수명이 짧으면 클릭 제스처 안에서 선제 갱신.
      //  단 photos 소스는 갱신 팝업이 포토 선택 팝업의 제스처를 소모해 차단시키므로 건너뛴다
      //  (포토 흐름 중 401은 photos_picker가 중단 처리하고, 이후 Drive/Sheets 호출은 _req가 401 자동 재시도).
      if (source !== 'photos') { try { if (Auth.ensureFreshToken) await Auth.ensureFreshToken(10 * 60 * 1000); } catch (_) {} }

      const candImages = source === 'photos'
        ? await _gatherFromPhotos(cfg, candCount, dateStr)
        : await _gatherFromDrive(cfg, dateStr, candCount);
      if (!candImages) { restoreCard(); return; }

      let s = _step('🤖 Gemini로 대표 사진 랭킹 중...', true);
      const rankRes = await GeminiAPI.rankPhotos(candImages, topCount);
      if (rankRes.skip) { _done(s, '적합한 사진 없음'); showToast(`일기 작성 SKIP: ${rankRes.reason || '적합한 사진 없음'}`, 'error'); restoreCard(); return; }
      // 1-based → 후보 인덱스 매핑 (중복 번호 응답 방어)
      const topImages = [];
      const seen = new Set();
      for (const oneBased of rankRes.ranking) {
        const idx = oneBased - 1;
        if (idx >= 0 && idx < candImages.length && !seen.has(idx)) { seen.add(idx); topImages.push(candImages[idx]); }
        if (topImages.length >= topCount) break;
      }
      if (topImages.length === 0) { _done(s, '매핑된 사진 없음'); showToast('랭킹 결과를 사진에 매핑하지 못했습니다.', 'error'); restoreCard(); return; }
      _done(s, `대표 사진 ${topImages.length}장 선정`);

      // 등록된 인물(얼굴+이름)을 참조로 전달 → 사진 속 인물 인지
      let people = [];
      try { if (typeof PeopleStore !== 'undefined') people = await PeopleStore.loadForPrompt(); } catch (_) {}

      const style = await _resolveStyle(opts.style, dateStr);
      s = _step(`✍️ Gemini로 일기 작성 중...${people.length ? ` (인물 ${people.length}명 참조)` : ''}`, true);
      const diary = await GeminiAPI.generateDiary(topImages, dateStr, cfg.DIARY_PROMPT || '', people, style);
      if (!diary || diary.trim().toUpperCase() === 'SKIP') { _done(s, 'AI가 작성 SKIP'); showToast('AI가 일기 작성을 SKIP 했습니다.', 'error'); restoreCard(); return; }
      _done(s, '일기 작성 완료');

      // 사용자가 대표 사진을 직접 고를 수 있도록 후보 전체를 보관(기본 대표 = Gemini 1순위)
      const allImages = candImages;
      const repDefaultIdx = Math.max(0, allImages.indexOf(topImages[0]));
      _last = { dateStr, diary, source, allImages, topImages, bestIndex: repDefaultIdx, _uploadCache: {}, bestId: '', bestThumb: '', style };

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
        await DiaryStore.saveEntry({
          date: dateStr,
          text: diary.trim(),
          bestPhotoId: bestId || (topImages[0] || {}).id || '',
          photoIds: topImages.map(t => t.id).filter(Boolean),
          thumb: bestThumb || '',
        });
        if (saveBtn) saveBtn.disabled = false;
        _done(s, '시트에 자동 저장 완료');
        if (typeof renderMonthList === 'function') renderMonthList();
        showToast('✅ 일기 생성 + 자동 저장 완료!');
        try { await _processFaces(topImages); } catch (_) {} // 인물 대조·감지(비차단)
      } catch (e) {
        if (saveBtn) saveBtn.disabled = false;
        console.error('[Diary] 자동 저장 실패:', e);
        _done(s, '자동 저장 실패 — 💾 버튼으로 저장하세요');
        showToast('일기는 생성됐지만 자동 저장 실패: ' + (e.message || e), 'error');
      }
    } catch (e) {
      console.error('[Diary] 실패:', e);
      showToast('❌ 생성 실패: ' + (e.message || e), 'error');
      restoreCard();
    } finally {
      _busy = false;
      const b = document.getElementById('generate-btn'); if (b) b.disabled = false;
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
    document.getElementById('result-date').textContent = `· ${dateStr}`;
    const strip = document.getElementById('photo-strip');
    strip.innerHTML = images.map((im, i) =>
      `<img src="data:${im.mime};base64,${im.data}" data-idx="${i}" class="${i === bestIdx ? 'best' : ''}" title="${_escAttr(im.name || '')}" />`
    ).join('');
    strip.querySelectorAll('img').forEach(im => im.addEventListener('click', () => {
      const idx = parseInt(im.dataset.idx, 10);
      setBestIndex(idx);
      strip.querySelectorAll('img').forEach(x => x.classList.toggle('best', parseInt(x.dataset.idx, 10) === idx));
    }));
    document.getElementById('diary-text').value = diary.trim();
    // CSS에 #result-card{display:none}이 있어 ''로 두면 다시 숨겨짐 → 'block'으로 명시해야 저장 버튼이 보임
    document.getElementById('result-card').style.display = 'block';
    document.getElementById('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  async function regenerateText(styleOpts) {
    if (_busy) return;
    if (!_last) { showToast('먼저 일기를 생성하세요.', 'error'); return; }
    const cfg = window.DACHANGI_CONFIG || {};
    _busy = true;
    _clearProgress();
    const genBtn = document.getElementById('generate-btn');
    if (genBtn) genBtn.disabled = true;
    try {
      const style = await _resolveStyle(styleOpts, _last.dateStr);
      let people = [];
      try { if (typeof PeopleStore !== 'undefined') people = await PeopleStore.loadForPrompt(); } catch (_) {}
      const s = _step('✍️ 같은 사진으로 일기 다시 쓰는 중...', true);
      const diary = await GeminiAPI.generateDiary(_last.topImages, _last.dateStr, cfg.DIARY_PROMPT || '', people, style);
      if (!diary || diary.trim().toUpperCase() === 'SKIP') { _done(s, 'AI가 작성 SKIP'); showToast('AI가 일기 작성을 SKIP 했습니다.', 'error'); return; }
      _done(s, '다시 작성 완료 — 마음에 들면 💾 버튼으로 등록');
      _last.diary = diary;
      _last.style = style;
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
    const { dateStr, allImages, topImages, source } = snap;
    const idx = snap.bestIndex || 0;
    const rep = allImages[idx];
    let bestId = '';
    let thumb = '';
    if (source === 'photos') {
      if (snap._uploadCache[idx]) {
        bestId = snap._uploadCache[idx]; // 이미 업로드한 후보면 재사용
      } else if (rep) {
        try {
          const hi = rep.baseUrl ? await PhotosPicker.fetchImageBase64(rep.baseUrl, 2048) : { mime: rep.mime, data: rep.data };
          bestId = await DriveAPI.uploadPhoto(`${dateStr} 대표.jpg`, hi.data, hi.mime);
          snap._uploadCache[idx] = bestId;
        } catch (e) {
          console.warn('[Diary] finalize 업로드 실패, 시트 썸네일 폴백:', e);
          try { thumb = await _makeThumb(rep, 512); } catch (_) {}
        }
      }
    } else {
      bestId = (rep || {}).id || '';
    }
    await DiaryStore.saveEntry({
      date: dateStr,
      text: (text || '').trim(),
      bestPhotoId: bestId || (rep || {}).id || '',
      photoIds: topImages.map(t => t.id).filter(Boolean),
      thumb: thumb,
    });
    snap.diary = text;
    snap.bestId = bestId;
    snap.bestThumb = thumb;
    return { ok: true };
  }

  return { run, getLast, setBestIndex, finalize, regenerateText, onEntryDateChanged, onEntryDeleted };
})();
