import { useEffect, useState } from 'react';
import { getDemoStats, getDemoDueItems } from './api';
import StatsPanel from './StatsPanel';

const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];

// Same status logic as Dashboard.jsx's itemStatusLabel, kept local rather
// than shared -- this page never grows the review/skip actions that make
// Dashboard's version worth importing from.
function itemStatusLabel(item) {
  if (item.mode === 'ADAPTIVE') {
    return item.stability == null
      ? 'Adaptive · not yet reviewed'
      : `Adaptive · stability ${item.stability.toFixed(1)}d`;
  }
  return item.isComplete ? 'Archived' : STAGE_LABELS[item.stage];
}

// Public, unauthenticated (ADR 0004): always the same fixed seeded account,
// served through /api/v1/demo/* -- no token anywhere on this page, and the
// backend rejects any write against this account regardless. No review/skip
// buttons here on purpose: the read-only-ness is real, not just hidden UI.
export default function DemoPage() {
  const [stats, setStats] = useState(null);
  const [dueItems, setDueItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getDemoStats(), getDemoDueItems()])
      .then(([s, d]) => {
        setStats(s);
        setDueItems(d);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-2xl font-medium mb-1">Live demo</h1>
        <p className="text-sm text-almanac-mute">
          A real sample account, shown read-only. Every number on this page comes from stored
          data, not a mock-up.
        </p>
      </div>
      {error && <p className="text-sm text-almanac-danger">{error}</p>}

      {dueItems && (
        <section>
          <h2 className="font-display text-lg font-medium mb-3">Due today</h2>
          {dueItems.length === 0 ? (
            <p className="text-sm text-almanac-mute">Nothing due today.</p>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
              {dueItems.map((item) => (
                <li
                  key={item.id}
                  className="bg-almanac-panel border border-almanac-border rounded-2xl px-5 py-4"
                >
                  <p className="m-0 mb-1 whitespace-pre-wrap text-sm">{item.text}</p>
                  <span className="text-xs text-almanac-mute">{itemStatusLabel(item)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {stats && <StatsPanel stats={stats} />}
    </div>
  );
}
