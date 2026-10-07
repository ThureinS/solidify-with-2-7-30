import { ResponsiveLine } from '@nivo/line';
import { NIVO_THEME, useChartWidth } from './nivoTheme';

const CURVE_MARGIN = { top: 24, right: 30, bottom: 50, left: 55 };
// Room for one day-number label ("120") plus a gap.
const PX_PER_DAY_LABEL = 50;

// curve is { points: [{day, retrievability}], today?: {day, retrievability} }
// from GET /items/:id/curve -- the item's own real Difficulty/Stability run
// through FSRS's formula server-side (ADR 0003: never a mocked line).
// retrievability arrives as a 0-1 fraction; only ever converted to a percent
// here for display, never invented.
export default function RetrievabilityCurve({ curve }) {
  const [wrapperRef, width] = useChartWidth();
  const data = [
    {
      id: 'retrievability',
      data: curve.points.map((p) => ({ x: p.day, y: Math.round(p.retrievability * 1000) / 10 })),
    },
  ];

  // A hint, not an exact count: Nivo rounds it to "nice" day numbers
  // (0, 20, 40...). Fewer on a phone, so the numbers don't overlap.
  const plotWidth = width - CURVE_MARGIN.left - CURVE_MARGIN.right;
  const dayTickCount = Math.max(3, Math.floor(plotWidth / PX_PER_DAY_LABEL));

  // Horizontal label beside the line, on whichever side has more room --
  // a "today" near the right end would otherwise run off the chart.
  const lastDay = curve.points[curve.points.length - 1].day;
  const todayOnRightHalf = curve.today && curve.today.day > lastDay / 2;

  const markers = curve.today
    ? [
        {
          axis: 'x',
          value: curve.today.day,
          lineStyle: { stroke: 'var(--color-almanac-danger)', strokeWidth: 2, strokeDasharray: '4 4' },
          legend: `Today · ${Math.round(curve.today.retrievability * 100)}%`,
          legendOrientation: 'horizontal',
          legendPosition: todayOnRightHalf ? 'top-left' : 'top-right',
          textStyle: { fill: 'var(--color-almanac-danger)', fontSize: 12, fontWeight: 600 },
        },
      ]
    : [];

  return (
    <div ref={wrapperRef} style={{ height: 260 }}>
      <ResponsiveLine
        data={data}
        theme={NIVO_THEME}
        colors={['var(--color-almanac-accent)']}
        margin={CURVE_MARGIN}
        xScale={{ type: 'linear' }}
        yScale={{ type: 'linear', min: 0, max: 100 }}
        curve="monotoneX"
        lineWidth={3}
        enablePoints={false}
        enableArea
        areaOpacity={0.12}
        enableGridX={false}
        axisBottom={{
          legend: 'Days since last review',
          legendPosition: 'middle',
          legendOffset: 36,
          tickValues: dayTickCount,
        }}
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
