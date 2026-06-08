/**
 * 다챙이 - 인물 DB (구글 시트 탭 '인물'). 일기 시트와 같은 스프레드시트를 사용.
 *   탭 '인물' : [이름, 관계, 메모, 사진(base64 JPEG), 생성시각, 감지횟수, 그룹]
 *   상태(파생): 이름 있음=확인(named) / 이름 없고 감지횟수≥임계치=확인필요(pending) / 그 미만=관찰중(observed, 숨김)
 *   일기 생성 시: 사진 속 얼굴을 기존 얼굴과 대조해 같은 사람은 감지횟수 +1, 신규는 관찰 대상으로 추가.
 *   여러 번(임계치 이상) 잡힌 얼굴만 사용자에게 "누구냐"고 물어봄(pending).
 */
const PeopleStore = (() => {
  const TAB = '인물';
  const HEADER = ['이름', '관계', '메모', '사진', '생성시각', '감지횟수', '그룹'];
  const GROUPS = ['가족', '친구', '직장'];
  const MAX_PHOTO = 48000;
  const THRESHOLD = 2; // 이 횟수 이상 감지되면 '확인 필요'로 승격

  async function _sid() { return await DiaryStore.ensureSheet(); }

  async function _ensureTab(sid) {
    const meta = await REST.sheetGet(sid, 'sheets.properties.title');
    const titles = (meta.sheets || []).map(s => s.properties.title);
    if (!titles.includes(TAB)) {
      await REST.batchUpdate(sid, [{ addSheet: { properties: { title: TAB } } }]);
      await REST.valuesUpdate(sid, `${TAB}!A1:G1`, [HEADER]);
    }
  }

  async function _tabSheetId(sid) {
    const meta = await REST.sheetGet(sid, 'sheets.properties');
    const sh = (meta.sheets || []).find(s => s.properties.title === TAB);
    return sh ? sh.properties.sheetId : null;
  }

  function _statusOf(name, count) {
    if (name) return 'named';
    if (count == null) return 'pending';        // 구버전(횟수 없음)·수동 미확인 → 노출
    return count >= THRESHOLD ? 'pending' : 'observed';
  }

  async function loadPeople() {
    const sid = await _sid();
    await _ensureTab(sid);
    const res = await REST.valuesGet(sid, `${TAB}!A2:G`);
    const rows = res.values || [];
    return rows.map((r, i) => {
      const name = r[0] || '';
      const raw = r[5];
      const count = (raw === undefined || raw === '' || raw === null) ? null : (parseInt(raw, 10) || 0);
      return {
        rowIndex: i + 2,
        name,
        relation: r[1] || '',
        memo: r[2] || '',
        photo: r[3] || '',
        createdAt: r[4] || '',
        count,
        group: r[6] || '',
        status: _statusOf(name, count),
      };
    }).filter(p => p.name || p.photo);
  }

  // 확인된 인물(수동) 추가
  async function addPerson(p) {
    const sid = await _sid();
    await _ensureTab(sid);
    const photo = (p.photo || '').length <= MAX_PHOTO ? (p.photo || '') : '';
    const row = [p.name || '', p.relation || '', p.memo || '', photo, new Date().toLocaleString('ko-KR'), (p.count == null ? '' : p.count), p.group || ''];
    await REST.valuesAppend(sid, `${TAB}!A:G`, [row]);
    return { added: p.name };
  }

  // 신규 관찰 얼굴(이름 없음, 감지횟수 1) 추가
  async function addObservation(photo) {
    return addPerson({ name: '', relation: '', memo: '', photo, count: 1 });
  }

  // 감지횟수 증가
  async function incrementSighting(rowIndex, currentCount) {
    const sid = await _sid();
    await REST.valuesUpdate(sid, `${TAB}!F${rowIndex}`, [[(currentCount || 0) + 1]]);
    return { row: rowIndex };
  }

  // 인물 정보(이름/관계/메모) 수정 — 사진/횟수 유지
  async function updatePerson(rowIndex, p) {
    const sid = await _sid();
    await REST.valuesUpdate(sid, `${TAB}!A${rowIndex}:C${rowIndex}`, [[p.name || '', p.relation || '', p.memo || '']]);
    return { updated: rowIndex };
  }

  // 그룹만 변경
  async function setGroup(rowIndex, group) {
    const sid = await _sid();
    await REST.valuesUpdate(sid, `${TAB}!G${rowIndex}`, [[group || '']]);
    return { row: rowIndex };
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

  // 대조용: 사진 있는 모든 얼굴(확인/관찰/대기 전부) {rowIndex, name, count, mime, data}
  async function loadAllFaces() {
    const people = await loadPeople();
    return people.filter(p => p.photo).map(p => ({ rowIndex: p.rowIndex, name: p.name, count: p.count, mime: 'image/jpeg', data: p.photo }));
  }

  // 확인 필요(pending) 인물 수 — 메뉴 뱃지용
  async function countPending() {
    const people = await loadPeople();
    return people.filter(p => p.status === 'pending').length;
  }

  // 일기 작성 참조용: 이름이 있는(확인된) 인물만
  async function loadForPrompt() {
    const people = await loadPeople();
    return people.filter(p => p.photo && p.name).map(p => ({ name: p.name, relation: p.relation, mime: 'image/jpeg', data: p.photo }));
  }

  return { THRESHOLD, GROUPS, loadPeople, addPerson, addObservation, incrementSighting, updatePerson, setGroup, deleteByRow, loadForPrompt, loadAllFaces, countPending };
})();
