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
  let _loggedIn = false;       // 앱 진입(로그인 콜백 발화) 여부 — 중복 발화/배경 갱신 구분
  let _silentAttempted = false; // 로드 시 조용한 재로그인 1회만 시도

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
    await new Promise((resolve) => gapi.load('client', resolve));
    // 디스커버리/API키 없이 클라이언트만 초기화. 모든 Drive/Sheets 호출은 OAuth Bearer로 직접 REST(REST 헬퍼).
    // → API 키 HTTP 리퍼러/제한과 무관하게 동작.
    try { await gapi.client.init({}); } catch (e) { console.warn('[Auth] gapi.client.init 경고:', e); }
    gapiInited = true;
    console.log('[Auth] GAPI 초기화 완료(키/디스커버리 없이, REST 직접 호출).');
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
        _silentRefresh = false;
        if (!_loggedIn) {
          _loggedIn = true;
          console.log('✅ 구글 로그인 완료.');
          if (onLoginCallback) onLoginCallback({ name: '다챙이 사용자' });
        } else {
          console.log('🔄 액세스 토큰 자동 갱신 완료.');
        }
      },
    });
    gisInited = true;
    console.log('[Auth] GIS 초기화 완료.');
    _tryLocalLogin();
  }

  function _tryLocalLogin() {
    if (!gapiInited || !gisInited || _loggedIn) return;
    try {
      const storedToken = localStorage.getItem('dachangi_access_token');
      const expiry = localStorage.getItem('dachangi_token_expiry');
      if (storedToken && expiry && parseInt(expiry, 10) > Date.now()) {
        accessToken = storedToken;
        gapi.client.setToken({ access_token: accessToken });
        _scheduleTokenRefresh(parseInt(expiry, 10));
        _loggedIn = true;
        console.log('✅ 캐시 토큰 자동 로그인.');
        if (onLoginCallback) onLoginCallback({ name: '다챙이 사용자' });
        return;
      }
      localStorage.removeItem('dachangi_access_token');
      localStorage.removeItem('dachangi_token_expiry');
      // 캐시 토큰 없음/만료 → 팝업 없이 조용히 재발급 시도(1회).
      //  이전에 동의했고 추적 허용이면 자동 로그인됨. iOS ITP면 조용히 실패 → 로그인 화면 유지(수동 탭).
      if (tokenClient && !_silentAttempted) {
        _silentAttempted = true;
        _silentRefresh = true;
        try { tokenClient.requestAccessToken({ prompt: '' }); }
        catch (_) { _silentRefresh = false; }
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
    _loggedIn = false;
    _silentAttempted = false;
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
