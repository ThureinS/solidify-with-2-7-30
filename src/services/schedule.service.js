const { parseDate, addDays } = require('../lib/dates');
const { AppError } = require('../middleware/errorHandler');

const SECOND_INTERVAL_DAYS = 7;
const THIRD_INTERVAL_DAYS = 30;
const SKIP_INTERVAL_DAYS = 1;

function isDueOn(item, dateStr) {
  return !item.isComplete && item.nextReviewDate <= parseDate(dateStr);
}

// Pure: decides whether a review is allowed on this item today, and if so,
// what its new stage/nextReviewDate/isComplete should be. Throws AppError
// (never touches the database) when a review isn't allowed right now.
// Intervals count from the completion date passed in, not from dateAdded.
function applyReview(item, dateStr) {
  if (item.isComplete) {
    throw new AppError(409, 'ITEM_ARCHIVED', 'Item is already archived');
  }
  if (!isDueOn(item, dateStr)) {
    throw new AppError(409, 'ITEM_NOT_DUE', 'Item is not due yet');
  }

  const completionDate = parseDate(dateStr);

  if (item.stage === 0) {
    return { stage: 1, nextReviewDate: addDays(completionDate, SECOND_INTERVAL_DAYS), isComplete: false };
  }
  if (item.stage === 1) {
    return { stage: 2, nextReviewDate: addDays(completionDate, THIRD_INTERVAL_DAYS), isComplete: false };
  }
  // stage 2's review just happened: archive. nextReviewDate is no longer
  // used once isComplete is true, so it's left as-is.
  return { stage: 2, nextReviewDate: item.nextReviewDate, isComplete: true };
}

// Pure: same due-check as applyReview, but skipping never changes stage --
// it just pushes the item to the back of tomorrow's queue.
function applySkip(item, dateStr) {
  if (item.isComplete) {
    throw new AppError(409, 'ITEM_ARCHIVED', 'Item is already archived');
  }
  if (!isDueOn(item, dateStr)) {
    throw new AppError(409, 'ITEM_NOT_DUE', 'Item is not due yet');
  }

  return { nextReviewDate: addDays(parseDate(dateStr), SKIP_INTERVAL_DAYS) };
}

module.exports = { isDueOn, applyReview, applySkip };
