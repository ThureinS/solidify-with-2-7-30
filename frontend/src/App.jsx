import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AuthForm from './AuthForm';
import Dashboard from './Dashboard';
import ReviewHistoryPage from './ReviewHistoryPage';
import AlmanacShell from './AlmanacShell';
import {
  getMe,
  logout,
  getRefreshToken,
  storeRefreshToken,
  clearRefreshToken,
  setAuthHandlers,
} from './api';

const TOKEN_KEY = 'token';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  // Lives here, not on a per-page component, so it survives navigating
  // between screens instead of resetting -- null follows the OS preference,
  // 'light'/'dark' is an explicit override via the shell's toggle.
  const [mode, setMode] = useState(null);

  useEffect(() => {
    if (mode) document.documentElement.setAttribute('data-mode', mode);
    else document.documentElement.removeAttribute('data-mode');
  }, [mode]);

  function toggleMode() {
    setMode((m) => (m === 'light' ? 'dark' : 'light'));
  }

  // Also used by login and change-password, both of which hand back a fresh
  // { accessToken, refreshToken } pair the same way a token refresh does.
  function handleLoggedIn(accessToken, refreshToken) {
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) storeRefreshToken(refreshToken);
    setToken(accessToken);
  }

  function handleLogout() {
    const refreshToken = getRefreshToken();
    // Best-effort: revokes server-side, but the session ends client-side
    // either way -- a network blip here shouldn't trap the user logged in.
    if (refreshToken) logout(refreshToken).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    clearRefreshToken();
    setToken(null);
    setUser(null);
  }

  // Re-registered every render (cheap: two variable assignments) rather than
  // once in a useEffect, so api.js's single-flight refresh always calls the
  // current closures instead of ones captured stale from an earlier render.
  setAuthHandlers({ onTokensRefreshed: handleLoggedIn, onAuthExpired: handleLogout });

  // Learn who we are whenever the token changes (mount + after login).
  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    // `cancelled` ignores a stale response if the token changes again mid-flight
    // (e.g. fast logout -> login), so an older /auth/me can't overwrite a newer user.
    let cancelled = false;
    getMe(token)
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((err) => {
        if (cancelled) return;
        // 401/403 = token expired or account suspended -> session is over, log out.
        // Other errors (5xx, offline) are transient: keep the token, retry next change.
        if (err.status === 401 || err.status === 403) handleLogout();
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <AlmanacShell onToggleMode={toggleMode} loggedIn={false}>
        <AuthForm onLoggedIn={handleLoggedIn} />
      </AlmanacShell>
    );
  }

  return (
    <AlmanacShell onToggleMode={toggleMode} loggedIn onLogout={handleLogout}>
      <Routes>
        <Route
          path="/"
          element={<Dashboard token={token} user={user} onTokenRefresh={handleLoggedIn} />}
        />
        <Route path="/history" element={<ReviewHistoryPage token={token} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AlmanacShell>
  );
}

export default App;
