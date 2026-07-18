const { toDateString } = require('../lib/dates');

function toItemSummary(item) {
  const firstLine = item.text.split('\n')[0];
  return {
    id: item.id,
    preview: firstLine.slice(0, 80),
    stage: item.stage,
    dateAdded: toDateString(item.dateAdded),
    nextReviewDate: toDateString(item.nextReviewDate),
    isComplete: item.isComplete,
  };
}

function toItemDetail(item) {
  return {
    id: item.id,
    text: item.text,
    stage: item.stage,
    dateAdded: toDateString(item.dateAdded),
    nextReviewDate: toDateString(item.nextReviewDate),
    isComplete: item.isComplete,
    deletedAt: item.deletedAt ? toDateString(item.deletedAt) : null,
    reviews: (item.reviews || []).map((review) => ({
      id: review.id,
      date: toDateString(review.date),
      result: review.result,
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
