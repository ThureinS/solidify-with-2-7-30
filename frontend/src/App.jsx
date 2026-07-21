import { useEffect, useState } from 'react';
import AuthForm from './AuthForm';
import Dashboard from './Dashboard';
import { getMe } from './api';
import './App.css';

const TOKEN_KEY = 'token';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);

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

  return (
    <main className="app">
      {token ? (
        <Dashboard token={token} user={user} onLogout={handleLogout} />
      ) : (
        <AuthForm onLoggedIn={handleLoggedIn} />
      )}
    </main>
  );
}

export default App;
