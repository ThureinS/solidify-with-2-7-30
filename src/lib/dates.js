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

// Both dates must be UTC-midnight Date objects (parseDate/addDays output),
// so this is exact integer division -- no DST rounding to guard against.
function daysBetween(from, to) {
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

module.exports = { parseDate, addDays, toDateString, daysBetween };
