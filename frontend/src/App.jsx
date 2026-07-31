import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AuthForm from './AuthForm';
import Dashboard from './Dashboard';
import ReviewHistoryPage from './ReviewHistoryPage';
import AlmanacShell from './AlmanacShell';
import { getMe } from './api';
import './App.css';

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

  function handleLoggedIn(newToken) {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }

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
        <Route path="/" element={<Dashboard token={token} user={user} />} />
        <Route path="/history" element={<ReviewHistoryPage token={token} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AlmanacShell>
  );
}

export default App;
