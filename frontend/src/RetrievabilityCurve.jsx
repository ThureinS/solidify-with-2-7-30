import { ResponsiveLine } from '@nivo/line';

// Reads the Almanac design tokens (src/index.css) as CSS custom properties,
// so the chart re-themes for free when the dark/light toggle flips them --
// no separate light/dark chart config to keep in sync.
const NIVO_THEME = {
  text: { fill: 'var(--color-almanac-mute)', fontFamily: 'var(--font-body)', fontSize: 11 },
  axis: {
    ticks: { text: { fill: 'var(--color-almanac-mute)' } },
    legend: { text: { fill: 'var(--color-almanac-mute)' } },
  },
  grid: { line: { stroke: 'var(--color-almanac-border)' } },
  crosshair: { line: { stroke: 'var(--color-almanac-accent)' } },
  tooltip: {
    container: {
      background: 'var(--color-almanac-panel)',
      color: 'var(--color-almanac-ink)',
      border: '1px solid var(--color-almanac-border)',
    },
  },
};

// curve is { points: [{day, retrievability}], today?: {day, retrievability} }
// from GET /items/:id/curve -- the item's own real Difficulty/Stability run
// through FSRS's formula server-side (ADR 0003: never a mocked line).
// retrievability arrives as a 0-1 fraction; only ever converted to a percent
// here for display, never invented.
export default function RetrievabilityCurve({ curve }) {
  const data = [
    {
      id: 'retrievability',
      data: curve.points.map((p) => ({ x: p.day, y: Math.round(p.retrievability * 1000) / 10 })),
    },
  ];

  const markers = curve.today
    ? [
        {
          axis: 'x',
          value: curve.today.day,
          lineStyle: { stroke: 'var(--color-almanac-danger)', strokeWidth: 2, strokeDasharray: '4 4' },
          legend: `Today · ${Math.round(curve.today.retrievability * 100)}%`,
          legendOrientation: 'vertical',
          textStyle: { fill: 'var(--color-almanac-danger)', fontSize: 11 },
        },
      ]
    : [];

  return (
    <div style={{ height: 260 }}>
      <ResponsiveLine
        data={data}
        theme={NIVO_THEME}
        colors={['var(--color-almanac-accent)']}
        margin={{ top: 20, right: 30, bottom: 50, left: 55 }}
        xScale={{ type: 'linear' }}
        yScale={{ type: 'linear', min: 0, max: 100 }}
        curve="monotoneX"
        lineWidth={3}
        enablePoints={false}
        enableArea
        areaOpacity={0.12}
        enableGridX={false}
        axisBottom={{ legend: 'Days since last review', legendPosition: 'middle', legendOffset: 36 }}
        axisLeft={{
          legend: 'Recall probability',
          legendPosition: 'middle',
          legendOffset: -45,
          format: (v) => `${v}%`,
        }}
        markers={markers}
        useMesh
        animate
      />
    </div>
  );
}
