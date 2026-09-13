(() => {
  // Personal records stay in this browser tab. Credentials are only hashed, never cached.
  const PREFIX = 'olchangi_read_v1:', EPOCH = 'olchangi_read_epoch_v1', TTL = 120000;
  const pending = new Map();
  let epoch = '';
  function generation() { try { return localStorage.getItem(EPOCH) || ''; } catch { return epoch; } }
  function clear() {
    epoch = String(Date.now()) + Math.random();
    try { localStorage.setItem(EPOCH, epoch); } catch {}
    try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key); } catch {}
    pending.clear();
    window.dispatchEvent(new Event('olchangi-cache-clear'));
  }
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  async function read(scope, name, args, loader) {
    const token = window.Olchangi ? Olchangi.session()?.access_token
      : typeof Auth !== 'undefined' && typeof Auth.getToken === 'function' ? Auth.getToken()
      : typeof Auth !== 'undefined' && Auth.isLoggedIn?.() ? window.gapi?.client?.getToken?.()?.access_token : null;
    if (!token || !window.crypto?.subtle) return loader();
    const revision = generation();
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([token, scope, name, args, revision])));
    const key = PREFIX + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved && saved.at <= Date.now() && Date.now() - saved.at < TTL && revision === generation()) {
        window.dispatchEvent(new CustomEvent('olchangi-cache-hit', { detail: { at: saved.at } }));
        return clone(saved.value);
      }
      sessionStorage.removeItem(key);
    } catch {}
    if (pending.has(key)) return pending.get(key).then(clone);
    const request = Promise.resolve().then(loader).then(value => {
      if (revision === generation() && value !== undefined) {
        try {
          // Bound tab storage, including diary thumbnails; quota failures never block reads.
          for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) {
            try { if (Date.now() - JSON.parse(sessionStorage.getItem(k)).at >= TTL) sessionStorage.removeItem(k); } catch { sessionStorage.removeItem(k); }
          }
          const encoded = JSON.stringify({ at: Date.now(), value });
          if (encoded.length < 1500000) sessionStorage.setItem(key, encoded);
        } catch {}
      }
      return value;
    }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
    pending.set(key, request);
    return request.then(clone);
  }
  function wrap(api, scope, reads, writes) {
    for (const name of reads) {
      const original = api[name];
      if (typeof original === 'function') api[name] = (...args) => read(scope(), name, args, () => original(...args));
    }
    for (const name of writes) {
      const original = api[name];
      if (typeof original === 'function') api[name] = async (...args) => {
        clear();
        try { return await original(...args); } finally { clear(); }
      };
    }
    return api;
  }
  window.addEventListener('storage', event => {
    if (event.key === EPOCH) { pending.clear(); window.dispatchEvent(new Event('olchangi-cache-clear')); }
  });
  document.addEventListener('click', event => {
    if (event.target.closest?.('#refresh-btn, #side-refresh, #logout-btn, #legacy-data-connect')) clear();
  }, true);
  window.OlchangiCache = { read, wrap, clear, TTL };
})();
