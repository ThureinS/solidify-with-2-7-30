// FSRS-6 forgetting-curve math (see ADR 0002 and CONTEXT.md's Adaptive Mode
// entry). Pure: no DB, no dates-as-strings, just numbers in/out.
//
// Parameters are FSRS-6's 21 published defaults, copied verbatim from
// open-spaced-repetition/py-fsrs's `fsrs/scheduler.py` (DEFAULT_PARAMETERS,
// FSRS_DEFAULT_DECAY) -- never fitted to any user's data (ADR 0002). The
// parameter count (21) is what ties these formulas to FSRS-6 specifically;
// they are not interchangeable with an FSRS-4.5 weight set.
//
// This module deliberately implements only the "Review"-state subset of
// py-fsrs's Scheduler: no learning/relearning steps, no same-day
// short-term-stability branch. Those exist in Anki to handle multiple
// reviews of the same card within one sitting; this app's "no early
// reviews" rule (CONTEXT.md) means a due date is always at least 1 day
// after the previous review, so that branch can never be reached here.
const DEFAULT_PARAMETERS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
];

// FSRS's own default: schedule so recall probability is ~90% at the next
// review. Not a per-user setting (ADR 0002 rejected personalization).
const DESIRED_RETENTION = 0.9;

// FSRS's own default ceiling (100 years) -- effectively CONTEXT.md's "no
// fixed ceiling" for Adaptive Mode.
const MAXIMUM_INTERVAL_DAYS = 36500;

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;
const MIN_STABILITY = 0.001;

const GRADE_VALUES = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

const w = DEFAULT_PARAMETERS;
const DECAY = -w[20];
const FACTOR = 0.9 ** (1 / DECAY) - 1;

function clampDifficulty(difficulty) {
  return Math.min(Math.max(difficulty, MIN_DIFFICULTY), MAX_DIFFICULTY);
}

function clampStability(stability) {
  return Math.max(stability, MIN_STABILITY);
}

function initialStability(grade) {
  return clampStability(w[GRADE_VALUES[grade] - 1]);
}

// Unclamped version is also FSRS's mean-reversion target in nextDifficulty,
// so it's split out rather than inlined into initialDifficulty.
function initialDifficultyRaw(grade) {
  return w[4] - Math.E ** (w[5] * (GRADE_VALUES[grade] - 1)) + 1;
}

function initialDifficulty(grade) {
  return clampDifficulty(initialDifficultyRaw(grade));
}

function nextDifficulty(difficulty, grade) {
  const deltaDifficulty = -(w[6] * (GRADE_VALUES[grade] - 3));
  const linearDamping = ((10 - difficulty) * deltaDifficulty) / 9;
  const target = initialDifficultyRaw('EASY'); // mean-reversion anchor, unclamped
  const meanReverted = w[7] * target + (1 - w[7]) * (difficulty + linearDamping);
  return clampDifficulty(meanReverted);
}

// Predicted probability of recall right now, given how long it's been since
// the last review. Same formula the memory-decay curve (build step 2) plots.
function retrievability(stability, elapsedDays) {
  return (1 + (FACTOR * elapsedDays) / stability) ** DECAY;
}

function nextForgetStability(difficulty, stability, r) {
  return (
    w[11] *
    difficulty ** -w[12] *
    ((stability + 1) ** w[13] - 1) *
    Math.E ** ((1 - r) * w[14])
  );
}

function nextRecallStability(difficulty, stability, r, grade) {
  const hardPenalty = grade === 'HARD' ? w[15] : 1;
  const easyBonus = grade === 'EASY' ? w[16] : 1;
  return (
    stability *
    (1 +
      Math.E ** w[8] *
        (11 - difficulty) *
        stability ** -w[9] *
        (Math.E ** ((1 - r) * w[10]) - 1) *
        hardPenalty *
        easyBonus)
  );
}

// r (retrievability) must be computed by the caller via retrievability(),
// using the elapsed days since the item's last review.
function nextStability(difficulty, stability, r, grade) {
  const next =
    grade === 'AGAIN'
      ? nextForgetStability(difficulty, stability, r)
      : nextRecallStability(difficulty, stability, r, grade);
  return clampStability(next);
}

function nextIntervalDays(stability) {
  const interval = (stability / FACTOR) * (DESIRED_RETENTION ** (1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(interval), 1), MAXIMUM_INTERVAL_DAYS);
}

// How far out the memory-decay curve (build step 2) plots before recall
// probability drops to a level that reads as meaningfully decayed -- same
// inversion as nextIntervalDays, just aimed at a lower retention floor than
// the 90% FSRS schedules for. FSRS-6's forgetting curve is a fat-tailed
// power law (verified numerically, not assumed): the horizon needed to
// reach a floor is a fixed multiple of stability regardless of its value,
// but that multiple explodes fast below ~70% (9x stability -> 26x at 60% ->
// 90x at 50%), so 0.7 is the lowest floor that stays a legible chart width
// instead of an absurd multi-year axis for an everyday item.
const CURVE_FLOOR_RETENTION = 0.7;
const CURVE_POINTS = 30;

// Sampled points from day 0 (last review) out to the floor above. minDays
// stretches the horizon to at least cover a caller-supplied "elapsed since
// last review" (e.g. today), so a real elapsed marker is never off-chart.
function retrievabilityCurve(stability, minDays = 0) {
  const floorDays = (stability / FACTOR) * (CURVE_FLOOR_RETENTION ** (1 / DECAY) - 1);
  const horizon = Math.max(floorDays, minDays, 1);
  return Array.from({ length: CURVE_POINTS + 1 }, (_, i) => {
    const day = (horizon * i) / CURVE_POINTS;
    return { day: Math.round(day * 10) / 10, retrievability: retrievability(stability, day) };
  });
}

module.exports = {
  initialStability,
  initialDifficulty,
  nextDifficulty,
  retrievability,
  nextStability,
  nextIntervalDays,
  retrievabilityCurve,
  DEFAULT_PARAMETERS,
  DESIRED_RETENTION,
};
