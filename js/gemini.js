/**
 * 다챙이 - Gemini 호출 (사진 랭킹 + 일기 생성). 이미지는 미리 base64로 준비해 전달.
 *   images: [{ mime, data(base64), name }]
 */
const GeminiAPI = (() => {
  function _cfg() { return window.DACHANGI_CONFIG || {}; }

  function _hasKey() { const k = _cfg().GEMINI_API_KEY; return !!(k && k.indexOf('YOUR_') !== 0); }
  function _oauthToken() {
    const cfg = _cfg();
    return (cfg.GEMINI_USE_OAUTH && typeof Auth !== 'undefined' && Auth.getToken) ? Auth.getToken() : null;
  }
  // OAuth 호출 시 쿼터 프로젝트(x-goog-user-project). CLIENT_ID 앞 숫자 = 프로젝트 번호.
  function _gcpProject() {
    const cfg = _cfg();
    if (cfg.GCP_PROJECT) return String(cfg.GCP_PROJECT).trim();
    const m = String(cfg.CLIENT_ID || '').match(/^(\d+)-/);
    return m ? m[1] : '';
  }
  // OAuth(Bearer) 우선 → 401/403 시 API 키 폴백. (GEMINI_USE_OAUTH 켜졌을 때만 OAuth 시도)
  async function _gFetch(urlBase, payload) {
    const hasKey = _hasKey();
    const token = _oauthToken();
    if (token) {
      try {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
        const proj = _gcpProject(); if (proj) headers['x-goog-user-project'] = proj;
        const res = await fetch(urlBase, { method: 'POST', headers, body: payload });
        if (res.ok) return res;
        if (!(hasKey && (res.status === 401 || res.status === 403))) return res;
        console.warn(`[Gemini] OAuth 호출 실패(${res.status}) → API 키 폴백`);
      } catch (e) { if (!hasKey) throw e; console.warn('[Gemini] OAuth 예외 → 키 폴백:', e.message); }
    }
    if (!hasKey) throw new Error('Gemini 인증이 없습니다. 설정에서 OAuth를 켜고 재로그인하거나 API 키를 입력하세요.');
    return fetch(`${urlBase}?key=${_cfg().GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
    });
  }

  async function _call(parts, generationConfig) {
    const model = _cfg().GEMINI_MODEL || 'gemini-2.5-flash';
    const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await _gFetch(base, JSON.stringify({ contents: [{ parts }], generationConfig }));
    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch (_) {}
      throw new Error(`Gemini 오류 (${res.status}) ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const cand = json.candidates && json.candidates[0];
    const text = (cand && cand.content && cand.content.parts || [])
      .filter(p => p && p.text).map(p => p.text).join('').trim();
    return text || '';
  }

  // 사용 가능한 모델(generateContent 지원) 목록. OAuth 우선/키 폴백.
  async function listAvailableModels() {
    const cfg = _cfg();
    const base = 'https://generativelanguage.googleapis.com/v1beta/models';
    const hasKey = _hasKey(); const token = _oauthToken(); const proj = _gcpProject();
    async function page(pt) {
      const params = new URLSearchParams({ pageSize: '200' }); if (pt) params.set('pageToken', pt);
      if (token) {
        const headers = { Authorization: `Bearer ${token}` }; if (proj) headers['x-goog-user-project'] = proj;
        const r = await fetch(`${base}?${params.toString()}`, { headers });
        if (r.ok) return r.json();
        if (!(hasKey && (r.status === 401 || r.status === 403))) { const t = await r.text().catch(() => ''); throw new Error(`모델 목록 실패(${r.status}) ${t.replace(/\s+/g, ' ').slice(0, 180)}`); }
      }
      if (!hasKey) throw new Error('Gemini 인증이 없습니다(OAuth/키).');
      const r2 = await fetch(`${base}?${params.toString()}&key=${cfg.GEMINI_API_KEY}`);
      if (!r2.ok) { const t = await r2.text().catch(() => ''); throw new Error(`모델 목록 실패(${r2.status}) ${t.replace(/\s+/g, ' ').slice(0, 180)}`); }
      return r2.json();
    }
    const out = []; let pt = '';
    for (let i = 0; i < 10; i++) {
      const d = await page(pt);
      (d.models || []).forEach(m => {
        const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
        if (methods.indexOf('generateContent') !== -1) out.push({ id: String(m.name || '').replace(/^models\//, ''), displayName: m.displayName || m.display_name || '' });
      });
      pt = d.nextPageToken || d.next_page_token || ''; if (!pt) break;
    }
    const seen = new Set();
    return out.filter(m => m.id && !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  }

  function _imageParts(images) {
    return images.map(im => ({ inline_data: { mime_type: im.mime, data: im.data } }));
  }

  // 1차 후보 중 대표 사진 랭킹 → { ranking:[1-based...], skip, reason }
  async function rankPhotos(images) {
    if (!images.length) return { ranking: [], skip: true, reason: '사진 없음' };
    const prompt = [
      `아래 ${images.length}장의 사진은 같은 날 촬영된 사진들이야.`,
      "이 중에서 '오늘 하루를 기록하는 일기의 대표 사진'으로 가장 적합한 것들을 골라줘.",
      '',
      '【선택 기준 — 우선순위 순서】',
      '1순위: 사람이 등장하는 사진 (표정, 행동, 모임, 셀피 등)',
      '2순위: 장소·분위기가 명확한 사진 (카페 내부, 여행지, 행사장, 식당 등)',
      '3순위: 음식·사물이더라도 특정 이야기·맥락이 읽히는 사진',
      '',
      '【절대 선택 금지 — 아래 중 하나라도 해당하면 제외】',
      '- 단순 제품·포장지 클로즈업, 영수증/바코드/택배 라벨/가격표',
      '- 스크린샷 또는 모니터/화면 촬영, 배경 없는 실내 사물만, 의미 없는 벽/바닥',
      '',
      `사진은 1번부터 ${images.length}번 순서로 첨부됩니다.`,
      '반드시 아래 JSON 형식으로만 답하세요. 다른 말은 절대 하지 마세요.',
      '선택 가능: {"ranking": [1위번호, 2위번호, 3위번호]}',
      '선택 불가: {"ranking": [], "skip": true, "reason": "이유"}',
    ].join('\n');

    const parts = [{ text: prompt }, ..._imageParts(images)];
    const text = await _call(parts, {
      temperature: 0.1, maxOutputTokens: 256,
      responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 },
    });
    try {
      const r = JSON.parse(text);
      if (r.skip || !r.ranking || !r.ranking.length) return { ranking: [], skip: true, reason: r.reason || '적합한 사진 없음' };
      return { ranking: r.ranking, skip: false };
    } catch (e) {
      return { ranking: [], skip: true, reason: '랭킹 응답 파싱 실패' };
    }
  }

  // Top 사진들로 일기 생성. people: [{name, relation, mime, data}] (선택) — 사진 속 인물 인지용 참조.
  async function generateDiary(images, dateStr, promptTemplate, people) {
    let finalPrompt = (promptTemplate || '').replace(/\{\{DATE\}\}/g, dateStr);
    finalPrompt += `\n\n위 가이드라인을 바탕으로, 첨부된 ${images.length}장의 사진을 종합하여 하나의 매끄러운 일기를 작성해 줘.`
      + '\n[중요] 글이 중간에 끊기지 않도록 반드시 문장을 끝까지 완성하고, 기승전결이 있게 자연스럽게 마무리해.';

    const parts = [{ text: finalPrompt }];
    const refs = (people || []).filter(p => p && p.data && p.name);
    if (refs.length) {
      parts.push({ text: '\n\n[등장 인물 참고] 아래는 자주 등장하는 인물들의 얼굴 사진과 이름이야. '
        + '오늘의 일기 사진 속에 이 사람이 보이면 어색하지 않게 이름(또는 관계)으로 자연스럽게 불러줘. '
        + '얼굴이 확실하지 않으면 억지로 이름을 붙이지 말고 추측하지 마.' });
      refs.forEach(p => {
        parts.push({ text: `· 인물: ${p.name}${p.relation ? ` (${p.relation})` : ''}` });
        parts.push({ inline_data: { mime_type: p.mime || 'image/jpeg', data: p.data } });
      });
      parts.push({ text: '\n[오늘의 일기 사진] (아래 사진들로 일기를 작성)' });
    }
    parts.push(..._imageParts(images));

    const text = await _call(parts, { temperature: 0.5, maxOutputTokens: 8192 });
    return text;
  }

  // 오늘 사진 속 인물을 기존 얼굴과 대조 + 신규 구분. knownFaces:[{name?, mime, data}] (인덱스 0..N-1)
  //  → { results: [{match: <인덱스 or -1>, image?, box?}] }  (-1 = 신규, box=[ymin,xmin,ymax,xmax] 0~1000)
  async function analyzeFaces(images, knownFaces) {
    if (!images || !images.length) return { results: [] };
    const known = (knownFaces || []).filter(k => k && k.data).slice(0, 25);
    let intro = '너는 사진 속 인물 얼굴을 구분·대조하는 비전 분석기야.\n';
    intro += known.length
      ? `[등록된 얼굴]은 이미 알고 있는 얼굴들이야(인덱스 0~${known.length - 1}).\n`
      : '아직 등록된 얼굴이 없어.\n';
    intro += `[오늘 사진](1~${images.length}번)에 등장하는 '서로 다른 사람'을 찾아 각 사람마다:\n`
      + '- [등록된 얼굴] 중 같은 사람이 있으면 그 인덱스를 "match"에.\n'
      + '- 등록된 얼굴에 없는 새 얼굴이면 "match": -1 과 함께 가장 또렷한 사진번호 "image"와 얼굴상자 "box":[ymin,xmin,ymax,xmax](0~1000)를.\n'
      + '배경에 작게/흐릿한 얼굴은 무시. 최대 5명. 애매하면 제외(거짓 양성 금지).\n'
      + 'JSON만: {"results":[{"match":2},{"match":-1,"image":1,"box":[120,300,460,560]}]}';
    const parts = [{ text: intro }];
    if (known.length) {
      parts.push({ text: '\n[등록된 얼굴]' });
      known.forEach((k, i) => { parts.push({ text: `얼굴 ${i}${k.name ? ' = ' + k.name : ''}` }); parts.push({ inline_data: { mime_type: k.mime || 'image/jpeg', data: k.data } }); });
    }
    parts.push({ text: '\n[오늘 사진]' });
    parts.push(..._imageParts(images));
    const text = await _call(parts, {
      temperature: 0.1, maxOutputTokens: 600,
      responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 },
    });
    try { const r = JSON.parse(text); return { results: Array.isArray(r.results) ? r.results : [] }; }
    catch (_) { return { results: [] }; }
  }

  return { rankPhotos, generateDiary, listAvailableModels, analyzeFaces };
})();
