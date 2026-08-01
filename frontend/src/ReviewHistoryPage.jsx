import { useEffect, useState } from 'react';
import { getDueItems, getReviewHistory, todayLocal } from './api';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Same discrete thresholds as the approved reference file -- a deliberate
// 5-phase read of the ratio, not a smooth/continuous fill.
function phaseForRatio(ratio) {
  if (ratio <= 0) return 0;
  if (ratio < 0.3) return 1;
  if (ratio < 0.55) return 2;
  if (ratio < 0.85) return 3;
  return 4;
}

function daysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

export default function ReviewHistoryPage({ token }) {
  const today = todayLocal();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [days, setDays] = useState(null); // Map<date, {reviewCount, skipCount, state}>
  const [dueCount, setDueCount] = useState(null);
  // Kept OUT of the year-scoped `days` map on purpose: `days` is refetched for
  // whichever year the arrows land on, so looking today up in it made the Today
  // card read 0 handled as soon as you browsed to a past year.
  const [handledToday, setHandledToday] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([getReviewHistory(token, year), getDueItems(token)])
      .then(([history, due]) => {
        if (cancelled) return;
        setDays(new Map(history.days.map((d) => [d.date, d])));
        setDueCount(due.length);
        if (year === currentYear) {
          const entry = history.days.find((d) => d.date === today);
          setHandledToday((entry?.reviewCount ?? 0) + (entry?.skipCount ?? 0));
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // `today`/`currentYear` are plain values derived from todayLocal(), constant
    // for the life of the page -- listed only to satisfy exhaustive-deps.
  }, [token, year, today, currentYear]);

  // dueCount is what's still outstanding right now; adding back what's
  // already been handled today recovers today's total workload, since
  // reviewing/skipping an item removes it from the due list.
  const totalToday =
    dueCount === null || handledToday === null ? null : dueCount + handledToday;
  const ratio = !totalToday ? 0 : handledToday / totalToday;
  const phase = phaseForRatio(ratio);

  const monthsToShow = year === currentYear ? Number(today.slice(5, 7)) : 12;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2 border-b border-almanac-border pb-7">
        <h1 className="font-display text-3xl font-medium">Your review history</h1>
        <p className="text-almanac-mute max-w-md leading-relaxed text-sm">
          Full moon: reviewed, nothing skipped. Half moon: a skip was
          involved that day -- skipping is a legitimate move here, not a
          failure. Blank: no activity.
        </p>
      </header>

      {error && <p className="text-almanac-accent">{error}</p>}

      <div className="bg-almanac-panel border border-almanac-border rounded-2xl px-7 py-6 flex items-center gap-6 flex-wrap">
        <div
          className="w-16 h-16 rounded-full border border-almanac-border flex-none transition-[box-shadow,background-color] duration-500"
          style={moonStyle(phase)}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs tracking-wider uppercase text-almanac-mute">Today</span>
          <span className="text-xl font-medium">
            {totalToday === null ? '...' : `${handledToday} of ${totalToday} handled`}
          </span>
          <span className="text-sm text-almanac-mute max-w-sm leading-relaxed">
            Today's workload, including anything overdue -- the one number
            on this page that's a true percentage, since it's the only day
            we can actually count what was due.
          </span>
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="font-display text-xl font-medium">Past months</h2>
          <div className="flex items-center gap-3 text-sm text-almanac-mute">
            <button
              type="button"
              onClick={() => setYear((y) => y - 1)}
              className="bg-transparent border-0 p-0 cursor-pointer [font:inherit] text-inherit hover:text-almanac-accent"
            >
              &larr;
            </button>
            <span className="tabular-nums">{year}</span>
            <button
              type="button"
              onClick={() => setYear((y) => Math.min(y + 1, currentYear))}
              disabled={year >= currentYear}
              className="bg-transparent border-0 p-0 cursor-pointer [font:inherit] text-inherit hover:text-almanac-accent disabled:opacity-30 disabled:cursor-default disabled:hover:text-almanac-mute"
            >
              &rarr;
            </button>
          </div>
        </div>
        <p className="text-almanac-mute text-sm mb-5 max-w-xl leading-relaxed">
          One row per month. Hover any day for the date, review count, and
          skip count.
        </p>

        {days === null ? (
          <p className="text-almanac-mute text-sm">Loading...</p>
        ) : (
          <div className="flex flex-col gap-4">
            {MONTHS.slice(0, monthsToShow).map((label, monthIndex) => (
              <MonthRow key={label} label={label} year={year} monthIndex={monthIndex} days={days} />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2.5 mt-6 flex-wrap text-xs text-almanac-mute">
          <span className="w-3.5 h-3.5 rounded-full bg-almanac-accent border border-almanac-accent" />
          {/* Not "all reviewed": a full moon only means every logged action that
              day was a review. Items you never touched leave no row at all, so
              they can't be counted here. */}
          <span>Reviewed, no skips</span>
          <span className="w-3.5 h-3.5 rounded-full bg-almanac-moon-dark border border-almanac-border ml-3" style={mixedShadow} />
          <span>Mixed (some skipped)</span>
          <span className="w-3.5 h-3.5 rounded-full border border-almanac-mute ml-3" />
          <span>No activity</span>
        </div>
      </div>
    </div>
  );
}

function MonthRow({ label, year, monthIndex, days }) {
  const total = daysInMonth(year, monthIndex);
  const cells = [];
  for (let d = 1; d <= total; d++) {
    const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(<DayCell key={date} date={date} day={d} entry={days.get(date)} />);
  }
  return (
    <div className="flex items-start gap-3.5">
      <div className="w-9 flex-none text-xs text-almanac-mute text-right pt-0.5">{label}</div>
      <div className="flex gap-1.5 overflow-x-auto p-0.5">{cells}</div>
    </div>
  );
}

function DayCell({ date, day, entry }) {
  const state = entry ? entry.state : 'none';
  const title = entry
    ? `${date} -- ${entry.reviewCount} reviewed, ${entry.skipCount} skipped`
    : `${date} -- no activity`;

  let cellClass = 'w-3.5 h-3.5 rounded-full border';
  let style;
  if (state === 'full') {
    cellClass += ' bg-almanac-accent border-almanac-accent';
  } else if (state === 'half') {
    cellClass += ' bg-almanac-moon-dark border-almanac-border';
    style = mixedShadow;
  } else {
    // Contrast fix (see design/review-history-demo.html's light-mode tokens):
    // the reference file gave the empty state a fill and border that were
    // nearly identical to each other and to the page background (~1.2:1
    // contrast in both modes, well under the 3:1 floor for a meaningful UI
    // shape). Reusing the existing "mute" token for the stroke, with no
    // fill, reads as a true outline and clears 3:1 in both modes without
    // introducing a new color or touching any other state.
    cellClass += ' bg-transparent border-almanac-mute';
  }

  return (
    <div className="flex flex-col items-center gap-0.5 flex-none" title={title}>
      <div className={cellClass} style={style} />
      <span className="text-[0.58rem] text-almanac-mute tabular-nums">{day}</span>
    </div>
  );
}

const mixedShadow = { boxShadow: 'inset 7px 0 0 0 var(--color-almanac-accent)' };

// Today's moon: a single larger instance, so a shape-encodes-fraction trick
// (an inset box-shadow "filling" the circle from one side) is legible --
// unlike the small per-day grid cells, this one only ever appears once.
// The fill ASCENDS with progress: new moon at 0 handled, waxing to a full
// gold disc when everything due is done. (The original reference file had
// this inverted -- see design/review-history-demo.html -- so 0 handled and
// 100% handled both rendered as an identical full moon.)
function moonStyle(phase) {
  if (phase === 4) {
    return { background: 'var(--color-almanac-accent)', borderColor: 'var(--color-almanac-accent)' };
  }
  const inset = [0, 18, 32, 44][phase];
  return {
    background: 'var(--color-almanac-moon-dark)',
    boxShadow: `inset ${inset}px 0 0 0 var(--color-almanac-accent)`,
  };
}
