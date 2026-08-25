const { toDateString } = require('../lib/dates');

// Mode-specific fields only. `stage`/`isComplete` claim there's a 3-rung
// ladder underway -- true for Fixed, meaningless for Adaptive (which never
// archives and has no rungs). Emitting them for an Adaptive item would be
// exactly the "number not backed by real data" ADR 0003 exists to block, so
// each mode gets only the fields that mean something for it.
function modeFields(item) {
  if (item.mode === 'ADAPTIVE') {
    return {
      difficulty: item.difficulty,
      stability: item.stability,
      lastReviewDate: item.lastReviewDate ? toDateString(item.lastReviewDate) : null,
    };
  }
  return {
    stage: item.stage,
    finalIntervalDays: item.finalIntervalDays,
    isComplete: item.isComplete,
  };
}

function toItemSummary(item) {
  const firstLine = item.text.split('\n')[0];
  return {
    id: item.id,
    preview: firstLine.slice(0, 80),
    mode: item.mode,
    dateAdded: toDateString(item.dateAdded),
    nextReviewDate: toDateString(item.nextReviewDate),
    ...modeFields(item),
  };
}

function toItemDetail(item) {
  return {
    id: item.id,
    text: item.text,
    mode: item.mode,
    dateAdded: toDateString(item.dateAdded),
    nextReviewDate: toDateString(item.nextReviewDate),
    deletedAt: item.deletedAt ? toDateString(item.deletedAt) : null,
    ...modeFields(item),
    reviews: (item.reviews || []).map((review) => ({
      id: review.id,
      date: toDateString(review.date),
      result: review.result,
      grade: review.grade,
    })),
  };
}

function itemStatus(item) {
  if (item.deletedAt) return 'deleted';
  if (item.isComplete) return 'archived';
  return 'active';
}

function toExportItem(item) {
  return { ...toItemDetail(item), status: itemStatus(item) };
}

module.exports = { toItemSummary, toItemDetail, toExportItem };
