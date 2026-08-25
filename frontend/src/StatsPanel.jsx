import { ResponsiveLine } from '@nivo/line';
import { NIVO_THEME } from './nivoTheme';

// Raw counts, never a ratio -- see items.service.js's deriveWeeklyStats
// comment. A reviewed/skipped fraction needs a denominator ("items due that
// week") this app doesn't store, so charting one would claim a rate the
// data can't support (ADR 0003).
function WeeklyReviewsChart({ weekly }) {
  const data = [
    { id: 'Reviewed', data: weekly.map((w) => ({ x: w.weekStart, y: w.reviewed })) },
    { id: 'Skipped', data: weekly.map((w) => ({ x: w.weekStart, y: w.skipped })) },
  ];

  return (
    <div style={{ height: 260 }}>
      <ResponsiveLine
        data={data}
        theme={NIVO_THEME}
        colors={['var(--color-almanac-accent)', 'var(--color-almanac-mute)']}
        margin={{ top: 20, right: 30, bottom: 50, left: 40 }}
        xScale={{ type: 'point' }}
        yScale={{ type: 'linear', min: 0 }}
        curve="monotoneX"
        lineWidth={3}
        pointSize={6}
        enableGridX={false}
        axisBottom={{ tickRotation: -30 }}
        axisLeft={{ legend: 'Actions', legendPosition: 'middle', legendOffset: -32, tickValues: 5 }}
        legends={[
          {
            anchor: 'top-right',
            direction: 'row',
            translateY: -20,
            itemWidth: 80,
            itemHeight: 20,
            symbolSize: 10,
            symbolShape: 'circle',
          },
        ]}
        useMesh
        animate
      />
    </div>
  );
}

// A plain CSS bar row per category -- four static counts don't earn a
// charting library on top of the one already pulled in for the line chart
// above (@nivo/bar would be a second dependency for two/four numbers).
function CountBars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3 text-sm">
          <span className="w-20 shrink-0 text-almanac-mute">{r.label}</span>
          <div className="flex-1 h-4 bg-almanac-panel border border-almanac-border rounded-full overflow-hidden">
            <div
              className="h-full bg-almanac-accent transition-all duration-500"
              style={{ width: `${(100 * r.value) / max}%` }}
            />
          </div>
          <span className="w-6 shrink-0 text-right text-almanac-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const GRADE_LABELS = { AGAIN: 'Again', HARD: 'Hard', GOOD: 'Good', EASY: 'Easy' };

// stats is GET /items/stats's response: { weekly, itemsByMode, adaptiveGrades }
// -- every number here is a real stored count, never a mock (ADR 0003), so
// this same component serves both the authenticated stats page and the
// public read-only demo page unchanged.
export default function StatsPanel({ stats }) {
  const hasWeekly = stats.weekly.length > 0;
  const hasAdaptiveReviews = Object.values(stats.adaptiveGrades).some((n) => n > 0);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="font-display text-lg font-medium mb-1">Reviews per week</h2>
        <p className="text-xs text-almanac-mute mb-3">
          Raw counts of reviewed vs. skipped actions, all time. Not a rate -- there's no record of how
          many items were due each week to divide by.
        </p>
        {hasWeekly ? (
          <WeeklyReviewsChart weekly={stats.weekly} />
        ) : (
          <p className="text-sm text-almanac-mute">No reviews logged yet.</p>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg font-medium mb-3">Items by mode</h2>
        <CountBars
          rows={[
            { label: 'Fixed', value: stats.itemsByMode.FIXED },
            { label: 'Adaptive', value: stats.itemsByMode.ADAPTIVE },
          ]}
        />
      </section>

      <section>
        <h2 className="font-display text-lg font-medium mb-1">Adaptive grades</h2>
        <p className="text-xs text-almanac-mute mb-3">
          How Adaptive reviews were graded. Fixed reviews have no grade, so they aren't part of this
          count.
        </p>
        {hasAdaptiveReviews ? (
          <CountBars
            rows={Object.entries(GRADE_LABELS).map(([grade, label]) => ({
              label,
              value: stats.adaptiveGrades[grade],
            }))}
          />
        ) : (
          <p className="text-sm text-almanac-mute">No graded Adaptive reviews yet.</p>
        )}
      </section>
    </div>
  );
}
