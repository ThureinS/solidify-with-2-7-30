import { useState } from 'react';
import { changePassword } from './api';

export default function AccountPanel({ token, onTokenRefresh }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    // Client-side only -- catches a typo before it becomes the account's new
    // password. The backend has no opinion on this; it just takes newPassword.
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match');
      return;
    }

    setBusy(true);
    try {
      const { token: freshToken } = await changePassword(token, currentPassword, newPassword);
      // The old token is now invalid (tokenVersion bumped server-side) --
      // hand the new one to App.jsx the same way login does, or the very
      // next request logs this tab out.
      onTokenRefresh(freshToken);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Password changed. Other logged-in sessions have been signed out.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-[340px]">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5 text-sm text-almanac-mute">
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-panel border border-almanac-border rounded-lg"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-almanac-mute">
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-panel border border-almanac-border rounded-lg"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-almanac-mute">
          Confirm new password
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-panel border border-almanac-border rounded-lg"
          />
        </label>
        {error && <p className="text-sm text-almanac-accent">{error}</p>}
        {success && <p className="text-sm text-almanac-mute">{success}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg px-4 py-2.5 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer disabled:opacity-40 disabled:cursor-default self-start"
        >
          Change password
        </button>
      </form>
    </div>
  );
}
