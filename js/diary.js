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

  // 구글 포토 Picker로 직접 선택 → base64 [{mime,data,name,id:''}]
  //  포토 baseUrl은 만료되어 재참조 불가 → 히스토리 썸네일용 영구 id는 비움.
  async function _gatherFromPhotos(cfg, candCount) {
    let s = _step('📷 구글 포토에서 사진 선택 창 여는 중...', true);
    let picked;
    try { picked = await PhotosPicker.pick(msg => { if (s) s.querySelector('span:last-child').textContent = msg; }); }
    catch (e) { _done(s, '선택 취소/실패'); showToast('사진 선택 실패: ' + (e.message || e), 'error'); return null; }
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
    const genBtn = document.getElementById('generate-btn');
    if (genBtn) { genBtn.disabled = true; }

    try {
      const candImages = source === 'photos'
        ? await _gatherFromPhotos(cfg, candCount)
        : await _gatherFromDrive(cfg, dateStr, candCount);
      if (!candImages) return;

      let s = _step('🤖 Gemini로 대표 사진 랭킹 중...', true);
      const rankRes = await GeminiAPI.rankPhotos(candImages);
      if (rankRes.skip) { _done(s, '적합한 사진 없음'); showToast(`일기 작성 SKIP: ${rankRes.reason || '적합한 사진 없음'}`, 'error'); return; }
      // 1-based → 후보 인덱스 매핑
      const topImages = [];
      for (const oneBased of rankRes.ranking) {
        const idx = oneBased - 1;
        if (idx >= 0 && idx < candImages.length) topImages.push(candImages[idx]);
        if (topImages.length >= topCount) break;
      }
      if (topImages.length === 0) { _done(s, '매핑된 사진 없음'); showToast('랭킹 결과를 사진에 매핑하지 못했습니다.', 'error'); return; }
      _done(s, `대표 사진 ${topImages.length}장 선정`);

      // 등록된 인물(얼굴+이름)을 참조로 전달 → 사진 속 인물 인지
      let people = [];
      try { if (typeof PeopleStore !== 'undefined') people = await PeopleStore.loadForPrompt(); } catch (_) {}

      s = _step(`✍️ Gemini로 일기 작성 중...${people.length ? ` (인물 ${people.length}명 참조)` : ''}`, true);
      const diary = await GeminiAPI.generateDiary(topImages, dateStr, cfg.DIARY_PROMPT || '', people);
      if (!diary || diary.trim().toUpperCase() === 'SKIP') { _done(s, 'AI가 작성 SKIP'); showToast('AI가 일기 작성을 SKIP 했습니다.', 'error'); return; }
      _done(s, '일기 작성 완료');

      // 대표 사진을 영구·고화질로 보관:
      //  - 포토 소스: baseUrl이 만료되므로, 고해상도(2048)로 재취득해 드라이브에 업로드 → 영구 fileId 확보.
      //    실패하면 시트 썸네일(저화질)로 폴백.
      //  - 드라이브 소스: 이미 영구 fileId(topImages[0].id)가 있으므로 그대로 사용.
      let bestThumb = '';
      let bestId = (topImages[0] || {}).id || '';
      if (source === 'photos' && topImages[0]) {
        const rep = topImages[0];
        s = _step('☁️ 대표 사진 고화질로 드라이브에 저장 중...', true);
        try {
          const hi = rep.baseUrl ? await PhotosPicker.fetchImageBase64(rep.baseUrl, 2048) : { mime: rep.mime, data: rep.data };
          bestId = await DriveAPI.uploadPhoto(`${dateStr} 대표.jpg`, hi.data, hi.mime);
          _done(s, '드라이브에 고화질 저장 완료');
        } catch (e) {
          console.warn('[Diary] 드라이브 사진 업로드 실패, 시트 썸네일 폴백:', e);
          _done(s, '드라이브 저장 실패 — 시트 썸네일로 대체');
          bestId = '';
          try { bestThumb = await _makeThumb(rep, 512); } catch (_) {}
        }
      }

      _last = { dateStr, topImages, diary, bestThumb, bestId };
      _render(dateStr, topImages, diary);

      // 자동 저장 (수동 💾 버튼은 편집 후 재저장용으로 유지)
      s = _step('💾 구글 시트에 자동 저장 중...', true);
      try {
        await DiaryStore.saveEntry({
          date: dateStr,
          text: diary.trim(),
          bestPhotoId: bestId || (topImages[0] || {}).id || '',
          photoIds: topImages.map(t => t.id).filter(Boolean),
          thumb: bestThumb || '',
        });
        _done(s, '시트에 자동 저장 완료');
        if (typeof renderMonthList === 'function') renderMonthList();
        showToast('✅ 일기 생성 + 자동 저장 완료!');
        try { await _detectNewPeople(topImages); } catch (_) {} // 새 인물 자동 감지(비차단)
      } catch (e) {
        console.error('[Diary] 자동 저장 실패:', e);
        _done(s, '자동 저장 실패 — 💾 버튼으로 저장하세요');
        showToast('일기는 생성됐지만 자동 저장 실패: ' + (e.message || e), 'error');
      }
    } catch (e) {
      console.error('[Diary] 실패:', e);
      showToast('❌ 생성 실패: ' + (e.message || e), 'error');
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

  // 사진 속 '처음 보는 사람' 자동 감지 → 인물 DB 대기열에 추가(비차단 best-effort)
  async function _detectNewPeople(topImages) {
    if (typeof PeopleStore === 'undefined' || !GeminiAPI.detectNewFaces) return;
    const s = _step('🔎 사진에서 새 인물 확인 중...', true);
    let known = [];
    try { known = await PeopleStore.loadAllFaces(); } catch (_) {}
    let res;
    try { res = await GeminiAPI.detectNewFaces(topImages, known); }
    catch (e) { _done(s, '새 인물 확인 건너뜀'); return; }
    const news = (res && res.new_faces) || [];
    let added = 0;
    for (const nf of news.slice(0, 3)) {
      const img = topImages[(nf.image || 1) - 1];
      if (!img || !Array.isArray(nf.box) || nf.box.length < 4) continue;
      const crop = await _cropFace(img, nf.box, 256);
      if (crop) { try { await PeopleStore.addPending(crop); added++; } catch (_) {} }
    }
    _done(s, added ? `처음 보는 인물 ${added}명 발견 → 인물 관리에서 이름 입력` : '새 인물 없음');
    if (added) {
      if (typeof updatePeopleBadge === 'function') updatePeopleBadge();
      showToast(`👤 처음 보는 인물 ${added}명 발견! 👥 인물 관리에서 누군지 입력해 주세요.`);
    }
  }

  function _render(dateStr, topImages, diary) {
    document.getElementById('result-date').textContent = `· ${dateStr}`;
    const strip = document.getElementById('photo-strip');
    strip.innerHTML = topImages.map((im, i) =>
      `<img src="data:${im.mime};base64,${im.data}" class="${i === 0 ? 'best' : ''}" title="${i === 0 ? '대표 사진' : ''} ${im.name || ''}" />`
    ).join('');
    document.getElementById('diary-text').value = diary.trim();
    // CSS에 #result-card{display:none}이 있어 ''로 두면 다시 숨겨짐 → 'block'으로 명시해야 저장 버튼이 보임
    document.getElementById('result-card').style.display = 'block';
    document.getElementById('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function getLast() { return _last; }

  return { run, getLast };
})();
