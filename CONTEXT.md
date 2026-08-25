# Scheduling

Terms specific to how items get scheduled for review. General app concepts (auth, admin, users, items-as-notes) aren't part of this glossary.

## Language

**Fixed Mode**:
Zero-interaction scheduling: a ladder of intervals (2 → 7 → a configurable final interval) that advances on every review, no rating required. This is the original 2-7-30 behavior, generalized so the final interval is a setting instead of a hardcoded 30.
_Avoid_: Standard, Extended (both were candidate names for what turned out to be the same mode with a different final-interval setting — see the final-interval note below)

**Adaptive Mode**:
Scheduling where the next interval is computed by FSRS from a Grade given at each review plus the item's own Difficulty/Stability, with no fixed ceiling — the item's own review history decides how far out it goes next. Uses FSRS's published default parameters, not personalized per user. Never auto-completes/archives — Stability can grow indefinitely, so "done" isn't a natural state the way it is for Fixed Mode; deleting the item is how you stop.
_Avoid_: Anki-like, Smart mode, SM-2 (an earlier, simpler algorithm considered and rejected in favor of FSRS — see the ADR)

**Final interval**:
The configurable longest gap (in days) a Fixed Mode item's ladder reaches before archiving. Default 30 — the original graded-spec value. Raising it is what "Extended" used to mean, before that turned out to be this one setting rather than a separate mode.

**Grade**:
The judgment given at each Adaptive Mode review: `Again` / `Hard` / `Good` / `Easy` (the Anki-standard 4-value scale). Feeds FSRS's recalculation of the item's Difficulty and Stability. Fixed Mode reviews never produce one — they stay the existing binary `REVIEWED`/`SKIPPED`.
_Avoid_: Difficulty rating (collides with FSRS's own "Difficulty," a different per-item value — see below)

**Difficulty** (FSRS):
FSRS's own tracked value for how intrinsically hard an item is to remember, updated after every Grade. Not the same thing as a Grade — a card's Difficulty is state that persists across reviews, a Grade is the one-off input for a single review.

**Stability** (FSRS):
FSRS's tracked estimate of how many days until recall probability decays to the target threshold. This is the number that actually determines an Adaptive item's next interval.

**Retrievability** (FSRS):
FSRS's estimate of the current probability of recalling an item right now, decaying from 100% since the last review as a function of Stability and elapsed time. Used internally by FSRS's own formulas; not something the UI necessarily needs to show.

**Mode switch**:
Changing an item's mode after creation. Always a full reset, never a converted carry-over — the two modes' progress isn't honestly comparable (a Fixed "stage" and Adaptive's Difficulty/Stability don't map onto each other). Adaptive → Fixed lands the item at Fixed's stage 0, as if newly added today (`nextReviewDate` = today + 2 days). Fixed → Adaptive lands it at Adaptive's own start-of-life state as of today. Safe to discard progress either way because Adaptive's next Grade self-corrects the interval within a review or two regardless of where it started.

**Reset**:
Wiping an item's progress back to its own mode's start-of-life state, as of today — the same underlying operation as Mode switch, just landing on the same mode instead of the other one. An escape hatch for "I don't trust/remember this at all anymore," available per item regardless of mode. Always goes all the way back to stage 0 (Fixed) or fresh Difficulty/Stability (Adaptive) — never a partial rewind.

**Skip**:
Marking a due item as not reviewed today without touching its schedule progress — `nextReviewDate` moves forward by 1 day, nothing else changes. Exists for both modes: it answers "I didn't engage with this today," which is a different question from Adaptive's `Again` grade ("I engaged and got it wrong").

**No early reviews**:
An item can't be reviewed or skipped before its own `nextReviewDate`. Applies identically to both modes, no exceptions — the review-history moon grid's "today" calculation is only honest because this holds for every item regardless of mode.
