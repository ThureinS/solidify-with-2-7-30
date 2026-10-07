import { ResponsiveLine } from '@nivo/line';
import { NIVO_THEME, useChartWidth } from './nivoTheme';

const WEEKLY_MARGIN = { top: 20, right: 40, bottom: 40, left: 40 };
// Room for one "2025-07-21" label (~60px at 11px) plus a gap.
const PX_PER_DATE_LABEL = 80;

// One tooltip for the whole week (both series), so it's clear the two
// numbers are counts for that one week, not points on a continuous line.
function WeekTooltip({ slice }) {
  const countFor = (id) => slice.points.find((p) => p.seriesId === id)?.data.y ?? 0;
  return (
    <div style={NIVO_THEME.tooltip.container} className="rounded-md px-3 py-2 text-xs">
      <div className="font-medium mb-0.5">Week of {slice.points[0].data.x}</div>
      <div>
        Reviewed {countFor('Reviewed')} · Skipped {countFor('Skipped')}
      </div>
    </div>
  );
}

// Raw counts, never a ratio -- see items.service.js's deriveWeeklyStats
// comment. A reviewed/skipped fraction needs a denominator ("items due that
// week") this app doesn't store, so charting one would claim a rate the
// data can't support (ADR 0003).
//
// The API sends every week, empty ones as 0, so equal spacing on the x-axis
// is equal time. A step line keeps each week's count flat across its week:
// a smooth or sloped line would draw in-between values that never existed.
function WeeklyReviewsChart({ weekly }) {
  const [wrapperRef, width] = useChartWidth();
  const data = [
    { id: 'Reviewed', data: weekly.map((w) => ({ x: w.weekStart, y: w.reviewed })) },
    { id: 'Skipped', data: weekly.map((w) => ({ x: w.weekStart, y: w.skipped })) },
  ];

  // Label only every Nth week, as many as fit the current width without
  // overlapping -- 60+ weeks on a phone leaves room for about 2-3 labels.
  const plotWidth = width - WEEKLY_MARGIN.left - WEEKLY_MARGIN.right;
  const maxLabels = Math.max(2, Math.floor(plotWidth / PX_PER_DATE_LABEL));
  const every = Math.ceil(weekly.length / maxLabels);
  const dateTicks = weekly.filter((_, i) => i % every === 0).map((w) => w.weekStart);

  return (
    <div ref={wrapperRef} style={{ height: 260 }}>
      <ResponsiveLine
        data={data}
        theme={NIVO_THEME}
        colors={['var(--color-almanac-accent)', 'var(--color-almanac-mute)']}
        margin={WEEKLY_MARGIN}
        xScale={{ type: 'point' }}
        yScale={{ type: 'linear', min: 0 }}
        curve="step"
        lineWidth={2}
        enablePoints={false}
        enableGridX={false}
        axisBottom={{ tickValues: dateTicks }}
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
        enableSlices="x"
        sliceTooltip={WeekTooltip}
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
          Raw counts of reviewed vs. skipped actions per week, all time. Weeks with no activity show
          as 0. Not a rate -- there's no record of how many items were due each week to divide by.
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
