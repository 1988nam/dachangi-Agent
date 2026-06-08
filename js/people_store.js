/**
 * 다챙이 - 인물 DB (구글 시트 탭 '인물'). 일기 시트와 같은 스프레드시트를 사용.
 *   탭 '인물' : [이름, 관계, 메모, 사진(base64 JPEG), 생성시각]
 *   일기 생성 시 인물 얼굴 사진 + 이름을 Gemini에 함께 넘겨 사진 속 인물을 인지하게 함.
 */
const PeopleStore = (() => {
  const TAB = '인물';
  const HEADER = ['이름', '관계', '메모', '사진', '생성시각'];
  const MAX_PHOTO = 48000; // 시트 셀 한도 여유

  async function _sid() { return await DiaryStore.ensureSheet(); }

  async function _ensureTab(sid) {
    const meta = await REST.sheetGet(sid, 'sheets.properties.title');
    const titles = (meta.sheets || []).map(s => s.properties.title);
    if (!titles.includes(TAB)) {
      await REST.batchUpdate(sid, [{ addSheet: { properties: { title: TAB } } }]);
      await REST.valuesUpdate(sid, `${TAB}!A1:E1`, [HEADER]);
    }
  }

  async function _tabSheetId(sid) {
    const meta = await REST.sheetGet(sid, 'sheets.properties');
    const sh = (meta.sheets || []).find(s => s.properties.title === TAB);
    return sh ? sh.properties.sheetId : null;
  }

  async function loadPeople() {
    const sid = await _sid();
    await _ensureTab(sid);
    const res = await REST.valuesGet(sid, `${TAB}!A2:E`);
    const rows = res.values || [];
    return rows.map((r, i) => ({
      rowIndex: i + 2,
      name: r[0] || '',
      relation: r[1] || '',
      memo: r[2] || '',
      photo: r[3] || '',
      createdAt: r[4] || '',
    })).filter(p => p.name || p.photo); // 이름 없는 '미확인' 얼굴도 포함
  }

  async function addPerson(p) {
    const sid = await _sid();
    await _ensureTab(sid);
    const photo = (p.photo || '').length <= MAX_PHOTO ? (p.photo || '') : '';
    const row = [p.name || '', p.relation || '', p.memo || '', photo, new Date().toLocaleString('ko-KR')];
    await REST.valuesAppend(sid, `${TAB}!A:E`, [row]);
    return { added: p.name };
  }

  // 미확인 얼굴(이름 없이 사진만) 대기열에 추가
  async function addPending(photo) {
    return addPerson({ name: '', relation: '', memo: '', photo });
  }

  // 인물 정보(이름/관계/메모) 수정 — 사진은 유지
  async function updatePerson(rowIndex, p) {
    const sid = await _sid();
    await REST.valuesUpdate(sid, `${TAB}!A${rowIndex}:C${rowIndex}`, [[p.name || '', p.relation || '', p.memo || '']]);
    return { updated: rowIndex };
  }

  // 중복 감지용: 사진 있는 모든 얼굴(확인+미확인)
  async function loadAllFaces() {
    const people = await loadPeople();
    return people.filter(p => p.photo).map(p => ({ rowIndex: p.rowIndex, name: p.name, mime: 'image/jpeg', data: p.photo }));
  }

  // 미확인(이름 없음) 인물 수 — 메뉴 뱃지용
  async function countPending() {
    const people = await loadPeople();
    return people.filter(p => !p.name && p.photo).length;
  }

  async function deleteByRow(rowIndex) {
    const sid = await _sid();
    const sheetId = await _tabSheetId(sid);
    if (sheetId == null) throw new Error('인물 탭을 찾을 수 없습니다.');
    await REST.batchUpdate(sid, [{
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } },
    }]);
    return { deleted: rowIndex };
  }

  // 일기 작성 참조용: 이름이 있는(확인된) 인물만
  async function loadForPrompt() {
    const people = await loadPeople();
    return people.filter(p => p.photo && p.name).map(p => ({ name: p.name, relation: p.relation, mime: 'image/jpeg', data: p.photo }));
  }

  return { loadPeople, addPerson, addPending, updatePerson, deleteByRow, loadForPrompt, loadAllFaces, countPending };
})();
