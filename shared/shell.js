(() => {
  const id = document.body.dataset.agent || location.pathname.split('/')[1];
  document.body.dataset.agent = ['toochangi', 'gachangi', 'dachangi'].includes(id) ? id : 'home';
  const base = document.body.dataset.suiteBase || '';
  const nav = document.createElement('nav');
  nav.id = 'olchangi-nav'; nav.setAttribute('aria-label', '올챙이 시리즈');
  const mark = '<svg class="suite-mark" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M14 4a10 10 0 1 0 6.8 17.3C24 26 28 27 31 25c-5-.8-5-5-7-10A10 10 0 0 0 14 4Z"/><circle cx="11" cy="12" r="1.4" fill="white"/><circle cx="17" cy="12" r="1.4" fill="white"/></svg>';
  const brand = document.createElement('a'); brand.className = 'suite-brand'; brand.href = base + '/';
  brand.innerHTML = mark + '<span>올챙이 <small>Agent</small></span>';
  brand.setAttribute('aria-label', '올챙이 Agent 홈');
  if (document.body.dataset.agent === 'home' && location.hash !== '#settings') brand.setAttribute('aria-current', 'page');
  nav.append(brand);
  for (const [app, label] of [['toochangi', '투챙이'], ['gachangi', '가챙이'], ['dachangi', '다챙이']]) {
    const a = document.createElement('a'); a.href = `${base}/${app}/`; a.textContent = label; a.className = 'series-link';
    if (app === id) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  const settings = document.createElement('a'); settings.className = 'suite-settings'; settings.href = base + '/#settings'; settings.textContent = '공통 설정'; nav.append(settings);
  const skip = document.createElement('a'); skip.className = 'skip-link'; skip.href = '#main-content'; skip.textContent = '본문으로 바로가기';
  skip.addEventListener('click', event => {
    event.preventDefault();
    const login = document.querySelector('#login-screen');
    const target = login?.checkVisibility() ? login : document.querySelector('main');
    if (target) { target.tabIndex = -1; target.focus(); }
  });
  document.body.prepend(nav); document.body.prepend(skip);
  const main = document.querySelector('main'); if (main && !main.id) main.id = 'main-content';
})();
