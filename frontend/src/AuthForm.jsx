import { useState } from 'react';
import { Link } from 'react-router-dom';
import { register, login } from './api';

// Server messages start lowercase ("password must be at least 8
// characters") because they're part of the API's error format, which
// other clients may rely on. Capitalize for display only.
function displayMessage(message) {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

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
      const { accessToken, refreshToken } = await login(email, password);
      onLoggedIn(accessToken, refreshToken);
    } catch (err) {
      setError(displayMessage(err.message));
    } finally {
      setBusy(false);
    }
  }

  // A login error ("Invalid email or password") means nothing on the
  // Register tab, so switching tabs starts with a clean form message.
  function switchMode(next) {
    setMode(next);
    setError('');
  }

  return (
    // min-h + centering, not a top pad: logged out the page is otherwise
    // empty, so a top-aligned card read as floating in dead space.
    <div className="flex justify-center items-center min-h-[70vh] py-10">
      <div className="w-full max-w-[340px] bg-almanac-panel border border-almanac-border rounded-2xl px-8 py-8 flex flex-col gap-5">
        <div className="flex flex-col gap-1.5 text-center">
          {/* Renamed 2-7-30 -> Interval (2026-08-26): the old tagline only
              described Fixed Mode's ladder, which stopped being the whole
              story once Adaptive Mode shipped -- this is still the one place
              a first-time visitor is told what the app actually does. */}
          <h1 className="font-display text-3xl font-medium tracking-wide">Interval</h1>
          <p className="text-sm text-almanac-mute leading-relaxed">
            Write down what you learned, then come back to review it &mdash; on a fixed schedule, or one that adapts to you.
          </p>
        </div>

        <div className="flex border border-almanac-border rounded-full p-1">
          <button type="button" onClick={() => switchMode('login')} className={segmentClass(mode === 'login')}>
            Log in
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
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
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5 text-sm text-almanac-mute">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                aria-describedby={mode === 'register' ? 'password-rule' : undefined}
                className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-bg border border-almanac-border rounded-lg"
              />
            </label>
            {/* Shown up front, not only after a failed try. Mirrors the
                backend's registerSchema (src/dto/auth.schemas.js) -- the
                server still checks it; this line is just the heads-up.
                Outside the <label> so it isn't read as part of the field's name. */}
            {mode === 'register' && (
              <p id="password-rule" className="m-0 text-xs text-almanac-mute">
                At least 8 characters, with a letter and a number.
              </p>
            )}
          </div>
          {error && <p className="text-sm text-almanac-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-full py-2.5 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {mode === 'login' ? 'Log in' : 'Register & log in'}
          </button>
        </form>

        {/* The public read-only demo (ADR 0004) -- a way to look around
            before signing up. /demo works without logging in. */}
        <p className="m-0 text-center text-sm text-almanac-mute">
          Just looking?{' '}
          <Link to="/demo" className="text-almanac-accent">
            Try the demo
          </Link>
        </p>
      </div>
    </div>
  );
}
