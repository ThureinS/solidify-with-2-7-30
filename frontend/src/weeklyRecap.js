const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

// Calendar week = Monday-Sunday, and BOTH weeks are measured over the same
// slice: Monday through the current weekday. Comparing this week's Mon-Sat
// against last week's full Mon-Sun made the verb meaningless -- a partial week
// almost always loses to a complete one, so the line read "down from" on most
// days no matter how well the week was going. On a Monday morning it was
// guaranteed. Both sums come from the `days` array Dashboard already fetches
// for the other stats -- no extra request.
//
// Lives in its own file, not in Dashboard.jsx, purely so tests/weeklyRecap.test.js
// can import it without dragging in React and the API client.
//
// Known gap, accepted rather than fixed: `days` is scoped to one calendar year
// (see getReviewHistory), so in the first few days of January part of "last
// week" (sometimes "this week" too) can fall in December of the previous,
// un-fetched year and silently read as 0 activity there. Only matters ~1 week
// a year.
export function computeWeeklyRecap(days, today) {
  const [y, m, d] = today.split('-').map(Number);
  const todayDate = new Date(y, m - 1, d);
  const mondayOffset = (todayDate.getDay() + 6) % 7; // days since this week's Monday
  const weekStart = new Date(todayDate);
  weekStart.setDate(weekStart.getDate() - mondayOffset);
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  // Same weekday offset as today, not the end of last week -- that's what makes
  // the two numbers comparable.
  const lastWeekEnd = new Date(lastWeekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() + mondayOffset);

  const toDateStr = (dt) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const sum = (startStr, endStr) =>
    days
      .filter((day) => day.date >= startStr && day.date <= endStr)
      .reduce((total, day) => total + day.reviewCount + day.skipCount, 0);

  const thisWeekCount = sum(toDateStr(weekStart), today);
  const lastWeekCount = sum(toDateStr(lastWeekStart), toDateStr(lastWeekEnd));
  if (thisWeekCount + lastWeekCount === 0) return null; // nothing to compare yet

  const verb = thisWeekCount > lastWeekCount ? 'up from' : thisWeekCount < lastWeekCount ? 'down from' : 'same as';
  return {
    thisWeekCount,
    lastWeekCount,
    verb,
    rangeLabel: `${SHORT_DATE.format(weekStart)}–${SHORT_DATE.format(todayDate)}`,
  };
}
