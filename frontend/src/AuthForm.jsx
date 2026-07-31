import { useState } from 'react';
import { register, login } from './api';

function segmentClass(active) {
  return active
    ? 'flex-1 rounded-full py-2 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer'
    : 'flex-1 rounded-full py-2 text-sm bg-transparent text-almanac-mute border-0 cursor-pointer';
}

export default function AuthForm({ onLoggedIn }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'register') {
        await register(email, password);
      }
      const { token } = await login(email, password);
      onLoggedIn(token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex justify-center pt-10">
      <div className="w-full max-w-[340px] bg-almanac-panel border border-almanac-border rounded-2xl px-8 py-8 flex flex-col gap-5">
        <div className="flex border border-almanac-border rounded-full p-1">
          <button type="button" onClick={() => setMode('login')} className={segmentClass(mode === 'login')}>
            Log in
          </button>
          <button
            type="button"
            onClick={() => setMode('register')}
            className={segmentClass(mode === 'register')}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-sm text-almanac-mute">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-bg border border-almanac-border rounded-lg"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-almanac-mute">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-bg border border-almanac-border rounded-lg"
            />
          </label>
          {error && <p className="text-sm text-almanac-accent">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-full py-2.5 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {mode === 'login' ? 'Log in' : 'Register & log in'}
          </button>
        </form>
      </div>
    </div>
  );
}
