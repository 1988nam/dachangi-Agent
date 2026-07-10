/**
 * 시우챙이 브랜딩 오버레이. deploy.sh siu 실행 시 js/brand.js 로 복사된다.
 * 구조는 js/brand.js 와 동일 — CHILD 값만 시우챙이용.
 */
(function () {
  // ── 시우챙이 ─────────────────────────────────────────────────────
  var CHILD = {
    name: '시우챙이',
    nameCall: ['나', '혜영', '시우'],
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

  try {
    document.title = window.APP_BRAND.title;
    var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (meta) meta.setAttribute('content', window.APP_BRAND.name);
  } catch (_) {}

  function applyBody() {
    try {
      var els = document.querySelectorAll('[data-brand-name]');
      for (var i = 0; i < els.length; i++) els[i].textContent = window.APP_BRAND.name;
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBody);
  else applyBody();
})();
