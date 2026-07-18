// All schedule dates are calendar dates (YYYY-MM-DD), never timestamps.
// We anchor every Date object at UTC midnight so day-arithmetic never
// drifts across a local timezone's daylight-saving boundary.

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

module.exports = { parseDate, addDays, toDateString };
