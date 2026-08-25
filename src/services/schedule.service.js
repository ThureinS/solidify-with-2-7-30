const { parseDate, addDays, daysBetween } = require('../lib/dates');
const { AppError } = require('../middleware/errorHandler');
const fsrs = require('./fsrs.service');

const FIXED_FIRST_OFFSET_DAYS = 2; // dateAdded -> stage 0's nextReviewDate
const FIXED_SECOND_INTERVAL_DAYS = 7; // stage 0 -> 1
const SKIP_INTERVAL_DAYS = 1;

function isDueOn(item, dateStr) {
  return !item.isComplete && item.nextReviewDate <= parseDate(dateStr);
}

// Pure: decides whether a review is allowed on this item today, and if so,
// what its new state should be. Throws AppError (never touches the
// database) when a review isn't allowed right now. Dispatches on
// item.mode -- the two modes' review math don't share any logic beyond the
// due-date check.
function applyReview(item, dateStr, grade) {
  if (item.mode === 'ADAPTIVE') {
    if (!grade) throw new AppError(400, 'GRADE_REQUIRED', 'Adaptive Mode reviews require a grade');
    return applyAdaptiveReview(item, dateStr, grade);
  }
  if (grade) throw new AppError(400, 'GRADE_NOT_ALLOWED', 'Fixed Mode reviews do not take a grade');
  return applyFixedReview(item, dateStr);
}

// Intervals count from the completion date passed in, not from dateAdded.
function applyFixedReview(item, dateStr) {
  if (item.isComplete) {
    throw new AppError(409, 'ITEM_ARCHIVED', 'Item is already archived');
  }
  if (!isDueOn(item, dateStr)) {
    throw new AppError(409, 'ITEM_NOT_DUE', 'Item is not due yet');
  }

  const completionDate = parseDate(dateStr);

  if (item.stage === 0) {
    return { stage: 1, nextReviewDate: addDays(completionDate, FIXED_SECOND_INTERVAL_DAYS), isComplete: false };
  }
  if (item.stage === 1) {
    return { stage: 2, nextReviewDate: addDays(completionDate, item.finalIntervalDays), isComplete: false };
  }
  // stage 2's review just happened: archive. nextReviewDate is no longer
  // used once isComplete is true, so it's left as-is.
  return { stage: 2, nextReviewDate: item.nextReviewDate, isComplete: true };
}

// Adaptive items never archive (CONTEXT.md), so there's no isComplete/
// ITEM_ARCHIVED check here -- only the shared due-date rule applies.
function applyAdaptiveReview(item, dateStr, grade) {
  if (!isDueOn(item, dateStr)) {
    throw new AppError(409, 'ITEM_NOT_DUE', 'Item is not due yet');
  }

  const reviewDate = parseDate(dateStr);
  let difficulty;
  let stability;

  if (item.stability == null) {
    stability = fsrs.initialStability(grade);
    difficulty = fsrs.initialDifficulty(grade);
  } else {
    // "No early reviews" (CONTEXT.md) guarantees reviewDate > lastReviewDate:
    // nextIntervalDays() never returns less than 1, so nextReviewDate is
    // always at least lastReviewDate + 1, and isDueOn requires
    // reviewDate >= nextReviewDate. elapsedDays is therefore always >= 1 --
    // FSRS's same-day short-term-stability formula never applies here.
    const elapsedDays = daysBetween(item.lastReviewDate, reviewDate);
    const r = fsrs.retrievability(item.stability, elapsedDays);
    stability = fsrs.nextStability(item.difficulty, item.stability, r, grade);
    difficulty = fsrs.nextDifficulty(item.difficulty, grade);
  }

  const intervalDays = fsrs.nextIntervalDays(stability);
  return {
    difficulty,
    stability,
    lastReviewDate: reviewDate,
    nextReviewDate: addDays(reviewDate, intervalDays),
  };
}

// Pure: same due-check as applyReview, but skipping never changes stage or
// FSRS state -- it just pushes the item to the back of tomorrow's queue.
// Mode-agnostic: identical behavior for Fixed and Adaptive items.
function applySkip(item, dateStr) {
  if (item.isComplete) {
    throw new AppError(409, 'ITEM_ARCHIVED', 'Item is already archived');
  }
  if (!isDueOn(item, dateStr)) {
    throw new AppError(409, 'ITEM_NOT_DUE', 'Item is not due yet');
  }

  return { nextReviewDate: addDays(parseDate(dateStr), SKIP_INTERVAL_DAYS) };
}

// Start-of-life state for a Fixed Mode item, as of dateStr: stage 0, first
// review due in 2 days (the fixed part of the 2-7-30 ladder -- only the
// final rung is configurable). Used by item creation, Reset, and Mode
// switch alike (CONTEXT.md: Reset is Mode switch landing on the same mode).
function fixedStartOfLife(dateStr, finalIntervalDays) {
  return {
    mode: 'FIXED',
    stage: 0,
    isComplete: false,
    nextReviewDate: addDays(parseDate(dateStr), FIXED_FIRST_OFFSET_DAYS),
    finalIntervalDays,
    difficulty: null,
    stability: null,
    lastReviewDate: null,
  };
}

// Start-of-life state for an Adaptive Mode item, as of dateStr: no
// Difficulty/Stability yet, due today. FSRS has no "first interval"
// concept of its own -- a new card is simply due for its first study
// session (confirmed as this app's convention; see implementation-journey.md).
function adaptiveStartOfLife(dateStr) {
  return {
    mode: 'ADAPTIVE',
    stage: 0,
    isComplete: false,
    nextReviewDate: parseDate(dateStr),
    difficulty: null,
    stability: null,
    lastReviewDate: null,
  };
}

module.exports = { isDueOn, applyReview, applySkip, fixedStartOfLife, adaptiveStartOfLife };
