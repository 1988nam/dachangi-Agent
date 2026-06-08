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
    })).filter(p => p.name);
  }

  async function addPerson(p) {
    const sid = await _sid();
    await _ensureTab(sid);
    const photo = (p.photo || '').length <= MAX_PHOTO ? (p.photo || '') : '';
    const row = [p.name || '', p.relation || '', p.memo || '', photo, new Date().toLocaleString('ko-KR')];
    await REST.valuesAppend(sid, `${TAB}!A:E`, [row]);
    return { added: p.name };
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

  // Gemini 전달용: 사진 있는 인물만 {name, relation, mime, data}
  async function loadForPrompt() {
    const people = await loadPeople();
    return people.filter(p => p.photo).map(p => ({ name: p.name, relation: p.relation, mime: 'image/jpeg', data: p.photo }));
  }

  return { loadPeople, addPerson, deleteByRow, loadForPrompt };
})();
