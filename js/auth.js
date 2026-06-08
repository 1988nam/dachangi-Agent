/**
 * 다챙이 - Google OAuth 모듈 (브라우저 직접, 서버리스). 토큰 자동 갱신 포함.
 */
const Auth = (() => {
  let accessToken = null;
  let tokenClient = null;
  let onLoginCallback = null;
  let onLogoutCallback = null;
  let gapiInited = false;
  let gisInited = false;
  let _refreshTimer = null;
  let _silentRefresh = false;

  function _scheduleTokenRefresh(expiryMs) {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    const delay = Math.max(expiryMs - Date.now() - 5 * 60 * 1000, 20 * 1000);
    _refreshTimer = setTimeout(() => {
      if (!tokenClient) return;
      _silentRefresh = true;
      try { tokenClient.requestAccessToken({ prompt: '' }); }
      catch (e) { _silentRefresh = false; console.warn('[Auth] 토큰 자동 갱신 실패:', e); }
    }, delay);
  }

  async function initGapi() {
    const cfg = window.DACHANGI_CONFIG || {};
    if (!cfg.API_KEY || cfg.API_KEY.indexOf('YOUR_') === 0) {
      console.warn('[Auth] API_KEY 미설정 — 초기화 유예.'); return;
    }
    await new Promise((resolve) => gapi.load('client', resolve));
    await gapi.client.init({
      apiKey: cfg.API_KEY,
      discoveryDocs: [
        'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
        'https://sheets.googleapis.com/$discovery/rest?version=v4',
      ],
    });
    gapiInited = true;
    console.log('[Auth] GAPI 초기화 완료.');
    _tryLocalLogin();
  }

  function initGis() {
    const cfg = window.DACHANGI_CONFIG || {};
    if (!cfg.CLIENT_ID || cfg.CLIENT_ID.indexOf('YOUR_') === 0) {
      console.warn('[Auth] CLIENT_ID 미설정 — GIS 초기화 유예.'); return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.CLIENT_ID,
      scope: cfg.SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse.error !== undefined) {
          _silentRefresh = false;
          console.warn('[Auth] 토큰 요청 오류:', tokenResponse.error);
          return;
        }
        accessToken = tokenResponse.access_token;
        const expiry = Date.now() + (tokenResponse.expires_in || 3600) * 1000;
        localStorage.setItem('dachangi_access_token', accessToken);
        localStorage.setItem('dachangi_token_expiry', expiry);
        gapi.client.setToken({ access_token: accessToken });
        _scheduleTokenRefresh(expiry);
        if (_silentRefresh) {
          _silentRefresh = false;
          console.log('🔄 액세스 토큰 자동 갱신 완료.');
        } else {
          console.log('✅ 구글 로그인 완료.');
          if (onLoginCallback) onLoginCallback({ name: '다챙이 사용자' });
        }
      },
    });
    gisInited = true;
    console.log('[Auth] GIS 초기화 완료.');
    _tryLocalLogin();
  }

  function _tryLocalLogin() {
    if (!gapiInited || !gisInited) return;
    try {
      const storedToken = localStorage.getItem('dachangi_access_token');
      const expiry = localStorage.getItem('dachangi_token_expiry');
      if (storedToken && expiry && parseInt(expiry, 10) > Date.now()) {
        accessToken = storedToken;
        gapi.client.setToken({ access_token: accessToken });
        _scheduleTokenRefresh(parseInt(expiry, 10));
        console.log('✅ 캐시 토큰 자동 로그인.');
        if (onLoginCallback) onLoginCallback({ name: '다챙이 사용자' });
      } else {
        localStorage.removeItem('dachangi_access_token');
        localStorage.removeItem('dachangi_token_expiry');
      }
    } catch (e) { console.error('[Auth] 로컬 로그인 시도 에러:', e); }
  }

  function login() {
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
    else console.error('[Auth] GIS 미초기화 (설정 먼저 완료).');
  }

  function logout() {
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    if (accessToken) { try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (_) {} }
    accessToken = null;
    localStorage.removeItem('dachangi_access_token');
    localStorage.removeItem('dachangi_token_expiry');
    try { gapi.client.setToken(null); } catch (_) {}
    if (onLogoutCallback) onLogoutCallback();
  }

  function onLogin(cb) { onLoginCallback = cb; _tryLocalLogin(); }
  function onLogout(cb) { onLogoutCallback = cb; }
  function isLoggedIn() { return !!accessToken; }
  function getToken() { return accessToken; }

  return { initGapi, initGis, login, logout, onLogin, onLogout, isLoggedIn, getToken };
})();

function gapiLoaded() { Auth.initGapi(); }
function gisLoaded() { Auth.initGis(); }
