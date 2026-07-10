/**
 * 앱 브랜딩 — 아이별 배포 시 이 파일만 교체된다(deploy.sh 가 brand/<child>/brand.js 로 덮어씀).
 * 기본값은 다챙이. 아래 CHILD.name 하나만 바꾸면 문서 제목·홈화면 이름·시트명·사진 폴더명·
 * 로그인 표시명·백업 파일명이 모두 따라 바뀐다.
 * nameCall = 일기 본문에서 '이름 그대로' 부를 사람들(아기 호칭 포함). 그 외는 관계로 불린다.
 *
 * ⚠️ localStorage/캐시 키(dachangi_*)·전역명(DACHANGI_CONFIG)은 브랜드와 무관한 내부 식별자다.
 *    아이별 앱은 서로 다른 도메인(origin)에 배포되므로 이 키들이 같아도 데이터가 섞이지 않는다.
 */
(function () {
  // ── 아이별로 바꾸는 값 (여기만 수정) ─────────────────────────────
  var CHILD = {
    name: '다챙이',
    nameCall: ['나', '혜영', '아가'],
  };
  // ────────────────────────────────────────────────────────────────

  var name = CHILD.name;
  window.APP_BRAND = {
    name: name,
    title: CHILD.title || (name + ' 📔 AI 일기'),
    userLabel: CHILD.userLabel || (name + ' 사용자'),
    sheetTitle: CHILD.sheetTitle || (name + ' 일기 DB'),
    photoFolder: CHILD.photoFolder || (name + ' 일기 사진'),
    photoFile: CHILD.photoFile || (name + ' 사진.jpg'),
    exportTitle: CHILD.exportTitle || (name + ' 일기'),
    nameCall: CHILD.nameCall || ['나', '혜영', '아가'],
  };

  // 즉시 적용(head 파싱 시점) — 문서 제목 + iOS 홈화면 이름
  try {
    document.title = window.APP_BRAND.title;
    var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (meta) meta.setAttribute('content', window.APP_BRAND.name);
  } catch (_) {}

  // 본문 요소는 로드 후 적용 — [data-brand-name] 텍스트를 앱 이름으로
  function applyBody() {
    try {
      var els = document.querySelectorAll('[data-brand-name]');
      for (var i = 0; i < els.length; i++) els[i].textContent = window.APP_BRAND.name;
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBody);
  else applyBody();
})();
