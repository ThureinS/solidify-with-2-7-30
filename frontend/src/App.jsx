import { useEffect, useLayoutEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AuthForm from './AuthForm';
import Dashboard from './Dashboard';
import ReviewHistoryPage from './ReviewHistoryPage';
import StatsPage from './StatsPage';
import DemoPage from './DemoPage';
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
const MODE_KEY = 'mode';

// Only 'light'/'dark' count as a saved choice; anything else (nothing saved
// yet, or a hand-edited value) means "follow the OS", same as before.
function readSavedMode() {
  const saved = localStorage.getItem(MODE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : null;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  // Set when /auth/me failed for a non-auth reason (server down, offline),
  // so the loading screen can offer a retry instead of spinning forever.
  // Bumping meAttempt re-runs the /auth/me effect below.
  const [meFailed, setMeFailed] = useState(false);
  const [meAttempt, setMeAttempt] = useState(0);
  // Lives here, not on a per-page component, so it survives navigating
  // between screens instead of resetting -- null follows the OS preference,
  // 'light'/'dark' is an explicit override via the shell's toggle, saved so
  // it survives a reload too.
  const [mode, setMode] = useState(readSavedMode);

  // Layout effect, not a plain effect: it runs before the browser paints,
  // so a saved choice is applied before the first frame instead of the OS
  // colors flashing for a moment on reload.
  useLayoutEffect(() => {
    if (mode) document.documentElement.setAttribute('data-mode', mode);
    else document.documentElement.removeAttribute('data-mode');
  }, [mode]);

  // Flip what the user actually SEES. With no override yet, that's the OS
  // preference -- so on a light-mode computer the first click goes to dark
  // (it used to always pick 'light' first, which changed nothing there).
  function toggleMode() {
    const osPrefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    const shown = mode ?? (osPrefersLight ? 'light' : 'dark');
    const next = shown === 'light' ? 'dark' : 'light';
    localStorage.setItem(MODE_KEY, next);
    setMode(next);
  }

  // Also used by login and change-password, both of which hand back a fresh
  // { accessToken, refreshToken } pair the same way a token refresh does.
  function handleLoggedIn(accessToken, refreshToken) {
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) storeRefreshToken(refreshToken);
    // A failed refresh logs out and THEN its /auth/me rejection lands with
    // no status, which sets meFailed -- clear it here, in the same render
    // as the new token, or the next login flashes "Can't reach the server".
    setMeFailed(false);
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
    setMeFailed(false);
    getMe(token)
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((err) => {
        if (cancelled) return;
        // 401/403 = token expired or account suspended -> session is over, log out.
        // Other errors (5xx, offline) are transient: keep the token, offer a retry.
        if (err.status === 401 || err.status === 403) handleLogout();
        else setMeFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, meAttempt]);

  // /demo (ADR 0004) is reachable either way: a link shared outside the app
  // shouldn't depend on whether the visitor happens to be logged in.
  if (!token) {
    return (
      <AlmanacShell onToggleMode={toggleMode} loggedIn={false}>
        <Routes>
          <Route path="/demo" element={<DemoPage loggedIn={false} />} />
          <Route path="*" element={<AuthForm onLoggedIn={handleLoggedIn} />} />
        </Routes>
      </AlmanacShell>
    );
  }

  // A token in storage isn't proof of a live session: it may have expired.
  // Until /auth/me answers, render no page at all -- before this, the
  // dashboard showed "Nothing due today" for a moment and then logged out.
  if (!user) {
    return (
      <AlmanacShell onToggleMode={toggleMode} loggedIn={false}>
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-almanac-mute">
          {meFailed ? (
            <>
              <p className="text-almanac-danger">Can&rsquo;t reach the server.</p>
              <div className="flex gap-5">
                <button
                  type="button"
                  onClick={() => setMeAttempt((n) => n + 1)}
                  className="bg-transparent border-0 p-0 cursor-pointer text-almanac-accent"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="bg-transparent border-0 p-0 cursor-pointer text-almanac-mute hover:text-almanac-accent"
                >
                  Log out
                </button>
              </div>
            </>
          ) : (
            <p role="status">Checking your session&hellip;</p>
          )}
        </div>
      </AlmanacShell>
    );
  }

  return (
    <AlmanacShell onToggleMode={toggleMode} loggedIn email={user.email} onLogout={handleLogout}>
      <Routes>
        {/* "/*", not "/": Dashboard owns the sub-routes under it (items/:id),
            so it stays mounted while an item is open and keeps its tab/page. */}
        <Route
          path="/*"
          element={<Dashboard token={token} user={user} onTokenRefresh={handleLoggedIn} />}
        />
        <Route path="/history" element={<ReviewHistoryPage token={token} />} />
        <Route path="/stats" element={<StatsPage token={token} />} />
        <Route path="/demo" element={<DemoPage loggedIn />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AlmanacShell>
  );
}

export default App;
