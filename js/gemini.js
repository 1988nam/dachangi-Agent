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

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 일시적 서버 오류(429 rate limit, 500/502/503/504 overload)엔 지수 백오프로 자동 재시도.
  //  503 'high demand'처럼 몇 초 뒤면 풀리는 스파이크를 통째 실패시키지 않기 위함.
  //  400/401/403 등 확정 오류는 재시도하지 않고 그대로 반환(호출부가 처리).
  async function _gFetchResilient(base, payloadStr, maxRetries) {
    // 429(할당량/속도제한)는 재시도하지 않는다 — 재시도해봐야 할당량만 더 태우고, 원인은 결제·플랜이라 즉시 알림이 낫다.
    const RETRIABLE = [500, 502, 503, 504];
    const max = (maxRetries == null) ? 2 : maxRetries;
    let attempt = 0;
    while (true) {
      const res = await _gFetch(base, payloadStr);
      if (res.ok || RETRIABLE.indexOf(res.status) === -1 || attempt >= max) return res;
      attempt++;
      const wait = Math.min(16000, 1200 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);
      console.warn(`[Gemini] ${res.status} 일시 오류 — ${attempt}/${max}차 재시도 (${wait}ms 후)`);
      try { await res.text(); } catch (_) {} // 연결 정리
      await _sleep(wait);
    }
  }

  async function _call(parts, generationConfig) {
    const model = _cfg().GEMINI_MODEL || 'gemini-3.5-flash';
    const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    // thinking 제어: 2.5-flash만 thinkingBudget:0 로 확실히 끌 수 있고, 그 외(3.x 포함)는 못 끄거나
    //  파라미터(thinkingLevel)가 달라 예측이 어렵다 → thinkingConfig를 빼고 출력 토큰 하한을 크게 확보한다.
    //  (thinking이 작은 출력 한도(랭킹·제목 1024 등)를 다 써 응답이 잘리거나 빈 응답=MAX_TOKENS 되는 것 방지.
    //   비용 차이는 편당 몇 원 수준이라 안정성 우선.)
    let gc = generationConfig;
    if (gc && gc.thinkingConfig && !/gemini-2\.5-flash/.test(model)) {
      gc = { ...gc };
      delete gc.thinkingConfig;
      gc.maxOutputTokens = Math.max(gc.maxOutputTokens || 0, 8192);
    }

    let res = await _gFetchResilient(base, JSON.stringify({ contents: [{ parts }], generationConfig: gc }));
    if (!res.ok && res.status === 400 && gc && gc.thinkingConfig) {
      // '모델 불러오기'로 추가된 임의 모델 방어: thinking 관련 400이면 빼고 1회 재시도
      let body = ''; try { body = await res.text(); } catch (_) {}
      if (/think/i.test(body)) {
        const gc2 = { ...gc }; delete gc2.thinkingConfig; gc2.maxOutputTokens = Math.max(gc2.maxOutputTokens || 0, 8192);
        res = await _gFetchResilient(base, JSON.stringify({ contents: [{ parts }], generationConfig: gc2 }));
      } else {
        throw new Error(`Gemini 오류 (400) ${body.slice(0, 200)}`);
      }
    }
    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch (_) {}
      if (res.status === 429) {
        throw new Error('Gemini 사용량 한도(429)에 걸렸습니다 — 무료 한도 소진 또는 결제/플랜 문제일 수 있어요. 잠시 후 재시도하거나, ⚙️ 설정에서 OAuth를 끄고 유료 API 키를 쓰거나 결제 상태를 확인하세요.');
      }
      if (res.status >= 500) {
        throw new Error(`Gemini 서버가 잠시 혼잡합니다 (${res.status}) — 자동 재시도했지만 계속 실패했어요. 1~2분 뒤 다시 시도하거나, ⚙️ 설정에서 모델을 gemini-3.1-flash-lite 로 바꿔보세요.`);
      }
      throw new Error(`Gemini 오류 (${res.status}) ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // 빈 응답을 조용히 ''로 돌리면 'AI가 SKIP'으로 오표시됨 — 차단/절단 사유를 구분해 알린다
    const pf = json.promptFeedback;
    if (pf && pf.blockReason) throw new Error(`Gemini가 요청을 차단했습니다 (사유: ${pf.blockReason}) — 다른 사진으로 시도해 보세요.`);
    const cand = json.candidates && json.candidates[0];
    if (!cand) throw new Error('Gemini 응답에 결과가 없습니다 — 잠시 후 다시 시도하세요.');
    const text = (cand.content && cand.content.parts || [])
      .filter(p => p && p.text).map(p => p.text).join('').trim();
    if (!text) {
      const fr = cand.finishReason || '';
      if (fr === 'MAX_TOKENS') throw new Error('Gemini 출력이 토큰 한도에서 끊겼습니다 — 다시 시도하거나 모델을 바꿔보세요.');
      if (fr && fr !== 'STOP') throw new Error(`Gemini가 응답을 완성하지 못했습니다 (사유: ${fr})`);
    }
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
  //  topCount: 원하는 대표 사진 수(1~5). 프롬프트 예시를 동적으로 만들어 그 수만큼 받아낸다.
  async function rankPhotos(images, topCount) {
    if (!images.length) return { ranking: [], skip: true, reason: '사진 없음' };
    const k = Math.max(1, Math.min(5, topCount || 3, images.length));
    const example = Array.from({ length: k }, (_, i) => `${i + 1}위번호`).join(', ');
    const prompt = [
      `아래 ${images.length}장의 사진은 같은 날 촬영된 사진들이야.`,
      `이 중에서 '오늘 하루를 기록하는 일기의 대표 사진'으로 가장 적합한 것을 ${k}장 골라줘.`,
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
      '【중요】 선택 불가(skip)는 최후의 수단이야. 금지 항목이 아닌 사진이 한 장이라도 있으면',
      '반드시 그중에서 골라 ranking을 채워. 모든 사진이 금지 항목에 해당할 때만 skip 해.',
      '',
      `사진은 1번부터 ${images.length}번 순서로 첨부됩니다. 같은 번호를 두 번 쓰지 마.`,
      '반드시 아래 JSON 형식으로만 답하세요. 다른 말은 절대 하지 마세요.',
      `선택 가능: {"ranking": [${example}]}`,
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

  // 문체 프리셋 — index.html #style-select 의 value와 1:1 대응
  const STYLE_GUIDES = {
    junghyun: '정현체 — 사용자가 평소 쓰는 일기 문체. 반말 기록체(~했다, ~인 것 같다, ~할 예정이다)로 '
      + '사건을 시간 순서대로 담백하게 서술하고, 단락 끝에 짧은 감상 한 줄로 마무리해(예: "~해서 웃긴 것 같다", "다사다난했던 하루였다"). '
      + '사람은 이름·호칭으로 구체적으로 부르고 필요하면 괄호로 짧게 부연해(예: 둘째처형 (회색옷)). 숫자·디테일은 구체적으로 적어. '
      + '말줄임표(..)는 가끔 자연스럽게 써도 되지만, "ㅋㅋ"나 "ㅎㅎ" 같은 웃음 표현은 절대 쓰지 마. '
      + '화려한 미사여구 없이 수수하고 솔직하게, 아래 [문체 참고]의 말투·호흡을 최대한 닮게 써.',
    mine: '아래 [문체 참고]에 첨부된, 사용자가 직접 쓴 일기들의 말투·문장 호흡·어휘 선택을 최대한 닮게 써.',
    emotional: '감성 에세이 — 하루의 장면과 감정을 섬세하고 서정적으로 풀어내되, 과하지 않게 잔잔한 여운을 남겨.',
    humor: '유쾌하고 재치 있는 글 — 가볍게 웃음이 나는 표현과 위트를 섞되, 비꼬지 않고 다정하게.',
    concise: '간결한 기록체 — 군더더기 없이 짧은 문장으로 사실과 느낌만 담백하게. 3~5문장이면 충분해.',
    poetic: '시적이고 서정적인 글 — 비유와 이미지 중심으로, 산문시처럼 리듬감 있게.',
    kid: '어린이 그림일기 — 쉬운 단어와 순수한 시선으로, 솔직하고 천진하게.',
  };
  // 정현체 few-shot 예시 — 사용자가 직접 쓴 일기에서 발췌. 문체/어투 어느 쪽이든 junghyun 선택 시 [문체 참고]로 첨부.
  //  학습용 실제 일기(수동 + 2025 이전 옛 일기)가 부족할 때의 폴백.
  const JUNGHYUN_SAMPLES = [
    '셋째 처형네가 서울에 와서 같이 어딜갈까 고민하다가, 파주 DMZ를 가게 되었다.\n'
    + '예전에 혜영이랑도 갔었는데 그 때 못 탄 케이블카를 타고 넓게 펼쳐진 겨울 풍경을 감상했다.\n'
    + '화려한 빛으로 가득한 미디어아트 전시관에서 조카들과 처형, 혜영이랑 함께 즐거운 순간을 사진으로 남겼다.\n'
    + '혜영이가 무슨 소라게처럼 사진이 나와서 웃긴 것 같다.',
    '어제도 정말 10년만에 만난 송욱이형과 (상무형 친구) 둘이 배스 낚시를 했는데,\n'
    + '새벽 일찍 나가서 낚시하고 같이 구이바다에 라면 끓여 먹고, 송욱이형 간 뒤에도 나는 3마리 더 잡아서 10마리 채우고 집으로 귀가, 그리고서는 그냥 바로 뻗어버렸다.\n'
    + '근데도 또 가고 싶어서 내일 엄마와 등산을 가지 않는다면 새벽에 또 포천쪽으로 가서 낚시를 할까 계속 고민중 이다.',
    '이번에는 명절이 짧고, 설 당일 이후 쉬는날이 하루뿐이라 장인,장모님이나 형님들 처형들과는 많은 시간은 보내지 못하고 왔다. (다음날 출근을 해야해서)\n'
    + '그래도 지난번과 같이 조카들의 용돈 게임을 위해 개구리 멀리뛰기 게임과 꿀벌 자석게임을 준비해갔고, 어머니와 큰 처형까지 재미있게 게임 하는 모습의 사진이다.\n'
    + '확실히 고창은 직계가족이 많으니 뭘 하든 북적북적 시끄러운 느낌이다.',
  ];

  // 문체 예시(few-shot) 해석 — [문체 참고]로 첨부할 예시 본문 배열을 고른다.
  //  · mine    : 호출 측이 넘긴 최근 일기(st.samples) 그대로.
  //  · junghyun(문체 또는 어투): 사용자가 '직접 쓴' 일기(st.samples)를 우선 학습하고, 부족하면 내장 정현체
  //              예시로 보충(최대 4편). 학습 일기가 없으면 내장 예시만 사용 → 폴백 안전.
  function _styleSamples(st) {
    if (!st) return [];
    const learned = Array.isArray(st.samples) ? st.samples.filter(Boolean) : [];
    if (st.styleKey === 'mine') return learned; // 'mine'은 내장 예시를 섞지 않고 넘겨받은 일기 그대로
    if (st.styleKey === 'junghyun' || st.toneKey === 'junghyun') {
      return learned.concat(JUNGHYUN_SAMPLES).slice(0, 4);
    }
    return [];
  }

  // 어투(말끝) 프리셋 — index.html #tone-select / #restyle-tone / 수정모드 .hist-tone 의 value와 1:1 대응
  const TONE_GUIDES = {
    junghyun: '아래 [문체 참고]에 첨부된, 사용자가 직접 쓴 일기의 말끝·종결어미·문장 호흡을 그대로 따라가. '
      + '특정 어미를 새로 강요하지 말고, 예시에서 드러나는 본인 말투(주로 ~했다 기록체에 가끔 ~인 것 같다·~할 예정이다로 마무리)를 자연스럽게 닮게 써.',
    plain: "간결한 기록체로, 문장을 '~했다', '~였다', '~인 것 같다'처럼 담백하게 끝맺어.",
    banmal: "친근한 반말 구어체로, 문장을 '~했어', '~더라', '~지 뭐야'처럼 친구에게 말하듯 끝맺어.",
    polite: "부드러운 존댓말로, 문장을 '~했어요', '~네요'처럼 끝맺어.",
    formal: "정중한 격식체로, 문장을 '~했습니다', '~입니다'로 끝맺어.",
  };

  // Top 사진들로 일기 생성. people: [{name, relation, callAs?, mime, data}] (선택) — 사진 속 인물 인지용 참조.
  //  style: { styleKey, toneKey, customText, samples:[본문...] } (선택) — 문체/어투 지시.
  //  keywords: 사용자가 입력한 그날의 맥락 키워드(선택) — 사진 해석보다 우선하는 사실로 취급.
  async function generateDiary(images, dateStr, promptTemplate, people, style, keywords) {
    let finalPrompt = (promptTemplate || '').replace(/\{\{DATE\}\}/g, dateStr);
    finalPrompt += `\n\n위 가이드라인을 바탕으로, 첨부된 ${images.length}장의 사진을 종합하여 하나의 매끄러운 일기를 작성해 줘.`
      + '\n[중요] 글이 중간에 끊기지 않도록 반드시 문장을 끝까지 완성하고, 기승전결이 있게 자연스럽게 마무리해.';

    const kw = (keywords || '').trim();
    if (kw) {
      finalPrompt += '\n\n[오늘의 맥락 키워드 — 사용자가 직접 알려준 사실이므로, 사진에서 받은 인상과 다르면 이 키워드를 우선해]'
        + `\n${kw}`
        + '\n이 키워드를 그날의 사실(누구와·어디서·무슨 일)의 뼈대로 삼고, 사진은 그 장면을 보여주는 근거로 해석해서 자연스럽게 엮어. '
        + '예를 들어 키워드가 "회사 워크샵"이면 사진 속 모임을 친구 모임으로 단정하지 마. 키워드에 없는 사실을 새로 지어내지는 마.';
    }

    const st = style || {};
    const styleLines = [];
    const sg = st.styleKey === 'custom' ? (st.customText || '').trim() : STYLE_GUIDES[st.styleKey];
    if (sg) styleLines.push(`- 문체: ${sg}`);
    const tg = TONE_GUIDES[st.toneKey];
    if (tg) styleLines.push(`- 어투: ${tg}`);
    if (styleLines.length) {
      finalPrompt += '\n\n[문체·어투 지시 — 위 가이드의 문체 관련 내용과 충돌하면 이 지시를 우선해]\n' + styleLines.join('\n');
    }

    const parts = [{ text: finalPrompt }];
    const samples = _styleSamples(st);
    if (samples.length) {
      parts.push({ text: '\n[문체 참고 — 사용자가 직접 쓴 최근 일기. 말투·호흡·어휘만 닮게 쓰고, 내용·소재는 절대 가져오지 마.]\n'
        + samples.map((s, i) => `〈예시 ${i + 1}〉\n${s}`).join('\n\n') });
    }
    const refs = (people || []).filter(p => p && p.data && p.name);
    if (refs.length) {
      parts.push({ text: '\n\n[등장 인물 참고] 아래는 자주 등장하는 인물들의 얼굴 사진과 호칭이야. '
        + '오늘의 일기 사진 속에 이 사람이 보이면 일기에서는 반드시 표기된 호칭 그대로 자연스럽게 불러줘(다른 이름·호칭을 지어내지 마). '
        + '호칭 뒤 괄호 안은 누구인지 알려주는 참고 정보일 뿐이니 본문에 그대로 옮겨 쓰지 마. '
        + '얼굴이 확실하지 않으면 억지로 이름을 붙이지 말고 추측하지 마.' });
      // 호칭은 people_store의 callAs가 결정(나·혜영·아가·친구는 이름, 다른 가족은 관계).
      //  호칭이 관계(예: 장모님)면 실명은 프롬프트에서 숨겨 모델이 이름을 쓰는 사고를 막고,
      //  같은 호칭이 여러 명(처형 등)이면 메모를 구분 단서로 병기해 인물이 합쳐지지 않게 한다.
      const dupCount = {};
      refs.forEach(p => { const c = p.callAs || p.name; dupCount[c] = (dupCount[c] || 0) + 1; });
      refs.forEach(p => {
        const callAs = p.callAs || p.name;
        const hints = [];
        if (callAs === p.name && p.relation && p.relation !== p.name) hints.push(p.relation);
        if (dupCount[callAs] > 1 && p.memo) hints.push(`구분: ${p.memo}`);
        parts.push({ text: `· 호칭: ${callAs}${hints.length ? ` (${hints.join(', ')})` : ''}` });
        parts.push({ inline_data: { mime_type: p.mime || 'image/jpeg', data: p.data } });
      });
      parts.push({ text: '\n[오늘의 일기 사진] (아래 사진들로 일기를 작성)' });
    }
    parts.push(..._imageParts(images));

    const text = await _call(parts, { temperature: 0.5, maxOutputTokens: 8192 });
    return text;
  }

  // 기존 일기 본문을 다른 문체/어투로 다시 쓰기(사진 없이 텍스트만).
  //  style: { styleKey, toneKey, samples } — STYLE_GUIDES/TONE_GUIDES 키. 'mine'은 samples 필요.
  //  keywords: 사용자가 알려준 실제 맥락 — 원본이 잘못 서술한 부분을 이 사실에 맞게 교정(단건 생성의 키워드와 동일 철학).
  async function rewriteDiary(text, style, keywords) {
    const st = style || {};
    const lines = [];
    const sg = STYLE_GUIDES[st.styleKey];
    if (sg) lines.push(`- 문체: ${sg}`);
    const tg = TONE_GUIDES[st.toneKey];
    if (tg) lines.push(`- 어투: ${tg}`);
    const kw = (keywords || '').trim();
    const samples = _styleSamples(st);
    const prompt = '아래 [원본 일기]를 다시 써줘.\n'
      + '[규칙]\n'
      + '- 사실·사건·인물·시간 순서 등 내용은 그대로 유지하고, 문장 표현만 바꿔.\n'
      + (kw
        ? '- 단, [맥락 키워드]는 사용자가 직접 알려준 실제 사실이다. 원본이 이와 다르게 서술한 부분은 이 사실에 맞게 자연스럽게 고쳐 써.\n'
          + '- 키워드에 근거한 교정 외에는 새로운 사실을 추가하거나 있던 내용을 빼지 마. 분량은 원본과 비슷하게.\n'
        : '- 새로운 사실을 추가하거나 있던 내용을 빼지 마. 분량은 원본과 비슷하게.\n')
      + '- 다시 쓴 일기 본문만 출력해(제목·설명·따옴표 금지).\n'
      + (lines.length ? '[문체·어투 지시]\n' + lines.join('\n') + '\n' : '')
      + (kw ? '[맥락 키워드]\n' + kw + '\n' : '')
      + (samples.length ? '[문체 참고 — 아래 예시의 말투·호흡만 닮게 쓰고, 내용은 절대 가져오지 마]\n' + samples.join('\n\n') + '\n' : '')
      + '\n[원본 일기]\n' + (text || '');
    return await _call([{ text: prompt }], { temperature: 0.5, maxOutputTokens: 8192 });
  }

  // 제목 정리 — 따옴표·문장부호·이모지·줄바꿈 제거 후 10자(코드포인트 기준)로 컷.
  function _clipTitle(s) {
    let t = String(s == null ? '' : s)
      .replace(/[\r\n]+/g, ' ')
      .replace(/["'`«»“”‘’\[\]{}()<>]/g, '')
      .replace(/[.!?。…]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cp = Array.from(t); // 서러게이트(이모지 등) 안전 길이
    if (cp.length > 10) t = cp.slice(0, 10).join('');
    return t;
  }

  // 여러 일기 본문을 각각 10자 이내의 짧은 한국어 제목으로 압축 → [제목...] (입력 순서·개수 보존).
  //  배치로 한 번에 처리해 호출 수를 줄인다(백필용). 실패 시 같은 길이의 빈 문자열 배열을 반환.
  async function generateTitles(texts) {
    const arr = (texts || []).map(t => (t || '').trim());
    if (!arr.length) return [];
    const prompt = [
      `아래 ${arr.length}편의 일기를, 각각 그날을 한눈에 떠올릴 수 있는 아주 짧은 한국어 제목으로 압축해줘.`,
      '【규칙】',
      '- 각 제목은 공백 포함 10자 이내(필수). 핵심 사건·장소·인물 위주의 명사구로.',
      '- 따옴표·마침표·이모지 없이 제목 텍스트만.',
      '- 입력과 같은 순서로, 정확히 같은 개수(빠짐없이)만큼.',
      '반드시 JSON만 출력: {"titles": ["제목1", "제목2", ...]}',
      '',
      ...arr.map((t, i) => `[일기 ${i + 1}]\n${t.slice(0, 1500)}`),
    ].join('\n');
    const text = await _call([{ text: prompt }], {
      temperature: 0.4, maxOutputTokens: 1024, // thinking 못 끄는 모델은 _call이 8192로 상향
      responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 },
    });
    // 파싱 실패를 조용히 빈 제목으로 넘기면 '왜 실패했는지'를 알 수 없다 → 원인을 던져 호출 측이 표시하게.
    //  일부 모델이 ```json 펜스로 감싸는 경우까지 견디도록 펜스를 벗긴 뒤 파싱.
    const cleaned = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let r;
    try { r = JSON.parse(cleaned); }
    catch (e) {
      // 응답이 끝에서 잘린 경우(출력 한도 초과 등) — titles 배열의 문자열만 최대한 건져 복구
      const salvaged = (cleaned.match(/"([^"\\]{1,40})"/g) || [])
        .map(s => s.slice(1, -1)).filter(s => s && s !== 'titles');
      if (salvaged.length) r = { titles: salvaged };
      else throw new Error(`제목 응답 파싱 실패: ${cleaned.replace(/\s+/g, ' ').slice(0, 120) || '(빈 응답 — 토큰 한도/모델 확인)'}`);
    }
    const titles = Array.isArray(r) ? r : (Array.isArray(r && r.titles) ? r.titles : []);
    return arr.map((_, i) => _clipTitle(titles[i]));
  }

  // 일기 한 편 → 10자 이내 제목. (배치 함수의 단건 래퍼)
  async function generateTitle(text) {
    if (!(text || '').trim()) return '';
    const r = await generateTitles([text]);
    return r[0] || '';
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

  return { rankPhotos, generateDiary, rewriteDiary, generateTitle, generateTitles, listAvailableModels, analyzeFaces };
})();
