// Reads the Almanac design tokens (src/index.css) as CSS custom properties,
// so every chart re-themes for free when the dark/light toggle flips them --
// no separate light/dark chart config to keep in sync. Shared by every Nivo
// chart in the app (currently RetrievabilityCurve and the stats dashboard).
export const NIVO_THEME = {
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
