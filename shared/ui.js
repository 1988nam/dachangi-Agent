/* Progressive interaction fixes only. No data, authentication or AI calls. */
(() => {
  const visible = element => element && element.checkVisibility() && element.getBoundingClientRect().width > 0;
  const focusables = element => [...element.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(el => visible(el) && !el.disabled && !el.closest('[inert]'));
  function enhanceFields(root = document) {
    root.querySelectorAll('label:not([for])').forEach(label => {
      if (label.querySelector('input,select,textarea')) return;
      const fields = label.parentElement.querySelectorAll('input,select,textarea');
      if (fields.length === 1 && fields[0].id) label.htmlFor = fields[0].id;
    });
    root.querySelectorAll('button[title]:not([aria-label])').forEach(button => button.setAttribute('aria-label', button.title));
    root.querySelectorAll('.btn-close,[id$="close-btn"]').forEach(button => button.setAttribute('aria-label', '닫기'));
    root.querySelectorAll('.table-wrap,.table-container').forEach(table => { table.tabIndex = 0; table.setAttribute('role', 'region'); table.setAttribute('aria-label', '표 · 좌우로 스크롤'); });
  }
  const login = document.querySelector('#login-screen');
  if (login) {
    const feedback = document.createElement('p'); feedback.id = 'login-feedback'; feedback.className = 'login-feedback'; feedback.setAttribute('role', 'alert');
    login.querySelector('.login-card')?.append(feedback);
  }
  const toast = document.querySelector('#toast'); if (toast) { toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); }
  const sidebar = document.querySelector('.sidebar');
  const mobile = matchMedia('(max-width:860px)');
  const toggle = document.querySelector('#sidebar-toggle-btn') || document.querySelector('.mobile-topbar #sidebar-toggle');
  const close = document.querySelector('#sidebar-close-btn,#sidebar-close');
  let backdrop;
  if (sidebar && toggle) {
    sidebar.id ||= 'app-sidebar';
    toggle.setAttribute('aria-label', '메뉴 열기'); toggle.setAttribute('aria-controls', sidebar.id);
    close?.setAttribute('aria-label', '메뉴 닫기');
    backdrop = document.createElement('div'); backdrop.className = 'sidebar-backdrop'; backdrop.hidden = true; backdrop.setAttribute('aria-hidden', 'true'); document.body.append(backdrop);
    function closeSidebar() {
      sidebar.classList.remove('active', 'open');
      document.querySelector('#sidebar-overlay')?.classList.remove('show');
      document.body.style.overflow = '';
      toggle.focus();
    }
    backdrop.addEventListener('click', closeSidebar);
    sidebar.addEventListener('click', event => { if (mobile.matches && event.target.closest('.nav-item,.side-item,.date-item,.month-item')) closeSidebar(); });
    function syncSidebar() {
      const open = mobile.matches && (sidebar.classList.contains('active') || sidebar.classList.contains('open'));
      sidebar.inert = mobile.matches && !open;
      toggle.setAttribute('aria-expanded', String(open)); backdrop.hidden = !open;
      if (open && !sidebar.contains(document.activeElement)) (close || focusables(sidebar)[0])?.focus();
    }
    new MutationObserver(syncSidebar).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    mobile.addEventListener('change', () => { closeSidebar(); syncSidebar(); }); syncSidebar();
    document.addEventListener('keydown', event => {
      if (!mobile.matches || backdrop.hidden || activeDialog()) return;
      if (event.key === 'Escape') { event.preventDefault(); closeSidebar(); }
      if (event.key === 'Tab') trapFocus(event, sidebar);
    });
  }
  function activeDialog() { return [...document.querySelectorAll('.modal-overlay')].filter(visible).at(-1); }
  function trapFocus(event, element) {
    const items = focusables(element); if (!items.length) { event.preventDefault(); element.focus(); return; }
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  function watchModal(overlay) {
    let wasOpen = false, previousFocus;
    const panel = overlay.querySelector('.modal,.modal-content') || overlay;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.tabIndex = -1;
    const heading = panel.querySelector('h2,h3,.modal-title');
    if (heading) { heading.id ||= `${overlay.id || 'olchangi-dialog'}-title`; panel.setAttribute('aria-labelledby', heading.id); }
    else panel.setAttribute('aria-label', '설정 및 편집');
    function syncModal() {
      const open = visible(overlay);
      if (open && !wasOpen) { previousFocus = document.activeElement; enhanceFields(panel); (focusables(panel)[0] || panel).focus(); }
      if (!open && wasOpen && visible(previousFocus)) previousFocus.focus();
      wasOpen = open;
    }
    new MutationObserver(syncModal).observe(overlay, { attributes: true, attributeFilter: ['class', 'style'] }); syncModal();
  }
  document.querySelectorAll('.modal-overlay').forEach(watchModal);
  document.addEventListener('keydown', event => {
    const overlay = activeDialog(); if (!overlay) return;
    if (event.key === 'Tab') trapFocus(event, overlay);
    if (event.key === 'Escape') {
      const cancel = [...overlay.querySelectorAll('button')].find(button => visible(button) && !button.disabled && /취소|닫기/.test(`${button.textContent} ${button.getAttribute('aria-label') || ''} ${button.title}`));
      if (cancel) { event.preventDefault(); cancel.click(); }
    }
  });
  const navItems = document.querySelectorAll('.nav-item[data-tab]');
  function updateCurrent() { navItems.forEach(item => { if (item.classList.contains('active')) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }); }
  navItems.forEach(item => new MutationObserver(updateCurrent).observe(item, { attributes: true, attributeFilter: ['class'] }));
  updateCurrent(); enhanceFields();
  // Dynamic tables and fields need the same accessible labels as initial HTML.
  const fieldObserver = new MutationObserver(records => {
    if (records.some(record => record.addedNodes.length)) enhanceFields();
  });
  fieldObserver.observe(document.body, { childList: true, subtree: true });
})();
