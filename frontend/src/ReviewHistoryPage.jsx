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
  // The day whose details show under its month. A tap works on a phone,
  // where hover (the `title` tooltip) doesn't exist.
  const [selectedDate, setSelectedDate] = useState(null);

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
          Each circle is one day. A filled circle means you reviewed and
          skipped nothing. A half-filled circle means you skipped at least one
          item that day. Skipping is fine. An empty ring means no activity.
        </p>
      </header>

      {error && <p className="text-almanac-danger">{error}</p>}

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
            Everything due today, including overdue items. The circle fills
            up as you work through them.
          </span>
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="font-display text-xl font-medium">Month by month</h2>
          <div className="flex items-center gap-3 text-sm text-almanac-mute">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => {
                setYear((y) => y - 1);
                setSelectedDate(null);
              }}
              className="bg-transparent border-0 p-0 cursor-pointer [font:inherit] text-inherit hover:text-almanac-accent"
            >
              &larr;
            </button>
            <span className="tabular-nums">{year}</span>
            <button
              type="button"
              aria-label="Next year"
              onClick={() => {
                setYear((y) => Math.min(y + 1, currentYear));
                setSelectedDate(null);
              }}
              disabled={year >= currentYear}
              className="bg-transparent border-0 p-0 cursor-pointer [font:inherit] text-inherit hover:text-almanac-accent disabled:opacity-30 disabled:cursor-default disabled:hover:text-almanac-mute"
            >
              &rarr;
            </button>
          </div>
        </div>
        <p className="text-almanac-mute text-sm mb-5 max-w-xl leading-relaxed">
          One row per month. Tap or click a day to see how many items you
          reviewed and skipped.
        </p>

        {days === null ? (
          <p className="text-almanac-mute text-sm">Loading...</p>
        ) : (
          <div className="flex flex-col gap-4">
            {MONTHS.slice(0, monthsToShow).map((label, monthIndex) => (
              <MonthRow
                key={label}
                label={label}
                year={year}
                monthIndex={monthIndex}
                days={days}
                today={today}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
              />
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
          <span className="w-3.5 h-3.5 rounded-full border border-dashed border-almanac-border ml-3" />
          <span>Upcoming</span>
        </div>
      </div>
    </div>
  );
}

// "Oct 3, 2026: 2 reviewed, 1 skipped" -- shown on hover, on tap, and read
// out by screen readers.
function describeDay(label, day, year, entry) {
  const when = `${label} ${day}, ${year}`;
  return entry
    ? `${when}: ${entry.reviewCount} reviewed, ${entry.skipCount} skipped`
    : `${when}: no activity`;
}

function MonthRow({ label, year, monthIndex, days, today, selectedDate, onSelect }) {
  const total = daysInMonth(year, monthIndex);
  const cells = [];
  let selectedText = null;
  for (let d = 1; d <= total; d++) {
    const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const entry = days.get(date);
    const description = describeDay(label, d, year, entry);
    const isSelected = date === selectedDate;
    if (isSelected) selectedText = description;
    cells.push(
      <DayCell
        key={date}
        day={d}
        entry={entry}
        description={description}
        // Plain string compare works because both are YYYY-MM-DD.
        isFuture={date > today}
        isSelected={isSelected}
        onSelect={() => onSelect(isSelected ? null : date)}
      />,
    );
  }
  return (
    <div className="flex items-start gap-3.5">
      <div className="w-9 flex-none text-xs text-almanac-mute text-right pt-0.5">{label}</div>
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex gap-1.5 overflow-x-auto p-1">{cells}</div>
        {selectedText && <p className="m-0 text-sm text-almanac-ink">{selectedText}</p>}
      </div>
    </div>
  );
}

function DayCell({ day, entry, description, isFuture, isSelected, onSelect }) {
  // Upcoming days: a faint dashed ring, so they don't look like a missed day.
  // Not tappable -- there is nothing to show yet.
  if (isFuture) {
    return (
      <div className="flex flex-col items-center gap-0.5 flex-none" title="Upcoming">
        <div className="w-3.5 h-3.5 rounded-full border border-dashed border-almanac-border" />
        <span className="text-[0.58rem] text-almanac-mute tabular-nums opacity-50">{day}</span>
      </div>
    );
  }

  const state = entry ? entry.state : 'none';

  let cellClass = 'w-3.5 h-3.5 rounded-full border';
  if (isSelected) cellClass += ' outline-2 outline-offset-2 outline-almanac-ink';
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

  // A button so a tap or click shows the details under the month. tabIndex -1
  // keeps ~300 days out of the Tab order; screen readers still reach each
  // day and read its aria-label.
  return (
    <button
      type="button"
      tabIndex={-1}
      title={description}
      aria-label={description}
      aria-pressed={isSelected}
      onClick={onSelect}
      className="flex flex-col items-center gap-0.5 flex-none bg-transparent border-0 p-0 cursor-pointer [font:inherit]"
    >
      <span className={`block ${cellClass}`} style={style} />
      <span className="text-[0.58rem] text-almanac-mute tabular-nums">{day}</span>
    </button>
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
