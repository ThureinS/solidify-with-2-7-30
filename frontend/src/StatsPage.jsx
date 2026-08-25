import { useEffect, useState } from 'react';
import { getStats } from './api';
import StatsPanel from './StatsPanel';

export default function StatsPage({ token }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getStats(token)
      .then(setStats)
      .catch((err) => setError(err.message));
  }, [token]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl font-medium">Stats</h1>
      {error && <p className="text-sm text-almanac-accent">{error}</p>}
      {stats ? <StatsPanel stats={stats} /> : !error && <p className="text-sm text-almanac-mute">Loading…</p>}
    </div>
  );
}
