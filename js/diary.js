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

  async function run(opts) {
    if (_busy) return;
    const cfg = window.DACHANGI_CONFIG || {};
    const dateStr = opts.dateStr;
    const candCount = Math.max(3, Math.min(20, opts.candCount || 10));
    const topCount = Math.max(1, Math.min(5, opts.topCount || 3));

    if (!cfg.MAIN_PHOTO_FOLDER_ID) { showToast('설정에서 사진 메인 폴더 ID를 입력하세요.', 'error'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { showToast('날짜를 선택하세요.', 'error'); return; }

    _busy = true;
    _clearProgress();
    document.getElementById('result-card').style.display = 'none';
    const genBtn = document.getElementById('generate-btn');
    if (genBtn) { genBtn.disabled = true; }

    try {
      const monthStr = dateStr.slice(0, 7);

      let s = _step(`📁 월별 폴더(${monthStr}) 찾는 중...`, true);
      const folder = await DriveAPI.findMonthFolder(cfg.MAIN_PHOTO_FOLDER_ID, monthStr);
      if (!folder) { _done(s, `폴더 '${monthStr}' 없음`); showToast(`메인 폴더 안에 '${monthStr}' 폴더가 없습니다.`, 'error'); return; }
      _done(s, `월별 폴더 발견: ${monthStr}`);

      s = _step('🖼️ 사진 목록 조회 중...', true);
      const all = await DriveAPI.listImages(folder.id);
      const dayPhotos = DriveAPI.filterByDate(all, dateStr);
      _done(s, `${monthStr} 폴더 ${all.length}장 중, ${dateStr} 촬영 ${dayPhotos.length}장`);
      if (dayPhotos.length === 0) { showToast('해당 날짜에 찍은 사진이 없습니다.', 'error'); return; }

      s = _step(`🔎 1차 선별(해상도+용량) 상위 ${candCount}장...`, true);
      const candidates = DriveAPI.selectByResolution(dayPhotos, candCount);
      _done(s, `1차 후보 ${candidates.length}장 선정`);

      s = _step('⬇️ 후보 사진 불러오는 중...', true);
      const candImages = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const img = await DriveAPI.fetchImageBase64(c.id, 1024);
        candImages.push({ ...img, name: c.name, id: c.id });
        if (s) s.querySelector('span:last-child').textContent = `⬇️ 후보 사진 불러오는 중... (${i + 1}/${candidates.length})`;
      }
      _done(s, `후보 ${candImages.length}장 로드 완료`);

      s = _step('🤖 Gemini로 대표 사진 랭킹 중...', true);
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

      s = _step('✍️ Gemini로 일기 작성 중...', true);
      const diary = await GeminiAPI.generateDiary(topImages, dateStr, cfg.DIARY_PROMPT || '');
      if (!diary || diary.trim().toUpperCase() === 'SKIP') { _done(s, 'AI가 작성 SKIP'); showToast('AI가 일기 작성을 SKIP 했습니다.', 'error'); return; }
      _done(s, '일기 작성 완료');

      _last = { dateStr, topImages, diary };
      _render(dateStr, topImages, diary);
      showToast('✅ 일기 생성 완료! (💾 시트에 저장하면 영구 보관)');
    } catch (e) {
      console.error('[Diary] 실패:', e);
      showToast('❌ 생성 실패: ' + (e.message || e), 'error');
    } finally {
      _busy = false;
      const b = document.getElementById('generate-btn'); if (b) b.disabled = false;
    }
  }

  function _render(dateStr, topImages, diary) {
    document.getElementById('result-date').textContent = `· ${dateStr}`;
    const strip = document.getElementById('photo-strip');
    strip.innerHTML = topImages.map((im, i) =>
      `<img src="data:${im.mime};base64,${im.data}" class="${i === 0 ? 'best' : ''}" title="${i === 0 ? '대표 사진' : ''} ${im.name || ''}" />`
    ).join('');
    document.getElementById('diary-text').value = diary.trim();
    document.getElementById('result-card').style.display = '';
    document.getElementById('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function getLast() { return _last; }

  return { run, getLast };
})();
