import { useState } from 'react';
import AuthForm from './AuthForm';
import Dashboard from './Dashboard';
import './App.css';

const TOKEN_KEY = 'token';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));

  function handleLoggedIn(newToken) {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }

  return (
    <main className="app">
      {token ? (
        <Dashboard token={token} onLogout={handleLogout} />
      ) : (
        <AuthForm onLoggedIn={handleLoggedIn} />
      )}
    </main>
  );
}

export default App;
