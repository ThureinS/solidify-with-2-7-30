import { useEffect, useState } from 'react';
import { getItem, updateItem, deleteItem, getRetrievabilityCurve, resetItem, switchItemMode } from './api';
import RetrievabilityCurve from './RetrievabilityCurve';

// ponytail: duplicated from Dashboard; a shared constants module isn't worth it for one array.
const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];

export default function ItemDetail({ token, itemId, onBack, onChanged }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [curve, setCurve] = useState(null);

  useEffect(() => {
    getItem(token, itemId)
      .then(setItem)
      .catch((err) => setError(err.message));
  }, [token, itemId]);

  // Only an Adaptive item that's had at least one graded review has a real
  // stability to plot -- fetch the curve only then (see item.mode/stability
  // above; a brand-new/reset Adaptive item has stability: null and gets no
  // curve at all, never a flat mocked one).
  useEffect(() => {
    if (item?.mode === 'ADAPTIVE' && item.stability != null) {
      getRetrievabilityCurve(token, itemId)
        .then(setCurve)
        .catch((err) => setError(err.message));
    }
  }, [token, itemId, item?.mode, item?.stability]);

  function startEditing() {
    setDraft(item.text);
    setEditing(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    try {
      const updated = await updateItem(token, itemId, draft);
      setItem(updated);
      setEditing(false);
      onChanged(); // let the list refresh its preview
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete() {
    // ponytail: native confirm prevents accidental loss with zero extra state.
    // Upgrade to an inline two-step confirm if the browser dialog feels off-brand.
    if (!window.confirm('Delete this item? It will be moved to deleted.')) return;
    setError('');
    try {
      await deleteItem(token, itemId);
      onChanged(); // refresh the list
      onBack(); // return to it
    } catch (err) {
      setError(err.message);
    }
  }

  // Reset and Switch mode are the same backend operation (CONTEXT.md) --
  // both wipe the item's schedule state back to a start-of-life state and
  // return the updated item; review history is untouched by either.
  async function handleReset() {
    if (!window.confirm('Reset this item? Its schedule starts over from day one — review history stays.')) return;
    setError('');
    try {
      const updated = await resetItem(token, itemId);
      setItem(updated);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSwitchMode() {
    const nextMode = item.mode === 'ADAPTIVE' ? 'FIXED' : 'ADAPTIVE';
    if (
      !window.confirm(
        `Switch to ${nextMode === 'ADAPTIVE' ? 'Adaptive' : 'Fixed'} mode? Its schedule starts over from day one — review history stays.`,
      )
    )
      return;
    setError('');
    try {
      const updated = await switchItemMode(token, itemId, nextMode);
      setItem(updated);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!item) {
    return (
      <div className="max-w-2xl mx-auto flex flex-col gap-4">
        <button
          type="button"
          onClick={onBack}
          className="self-start bg-transparent border-0 p-0 text-sm text-almanac-mute cursor-pointer hover:text-almanac-accent"
        >
          &larr; Back
        </button>
        {error ? (
          <p className="text-sm text-almanac-danger">{error}</p>
        ) : (
          <p className="text-sm text-almanac-mute">Loading&hellip;</p>
        )}
      </div>
    );
  }

  const statusLabel = item.deletedAt
    ? 'Deleted'
    : item.mode === 'ADAPTIVE'
      ? item.stability == null
        ? 'Adaptive · not yet reviewed'
        : `Adaptive · stability ${item.stability.toFixed(1)}d`
      : item.isComplete
        ? 'Archived'
        : STAGE_LABELS[item.stage];

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-7">
      <button
        type="button"
        onClick={onBack}
        className="self-start bg-transparent border-0 p-0 text-sm text-almanac-mute cursor-pointer hover:text-almanac-accent"
      >
        &larr; Back to list
      </button>

      <div className="bg-almanac-panel border border-almanac-border rounded-2xl px-7 py-6 flex flex-col gap-3">
        {editing ? (
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              required
              className="px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-bg border border-almanac-border rounded-lg resize-y leading-relaxed"
            />
            <div className="flex gap-2.5">
              <button
                type="submit"
                className="rounded-lg px-4 py-2 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="text-base leading-relaxed whitespace-pre-wrap m-0">{item.text}</p>
            <p className="text-sm text-almanac-mute m-0">
              {statusLabel} &middot; added {item.dateAdded} &middot; next review {item.nextReviewDate}
            </p>

            {!item.deletedAt && (
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={startEditing}
                  className="rounded-lg px-4 py-2 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-danger border border-almanac-danger cursor-pointer"
                >
                  Delete
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {error && <p className="text-sm text-almanac-danger">{error}</p>}

      {item.mode === 'ADAPTIVE' && !item.deletedAt && (
        <div className="bg-almanac-panel border border-almanac-border rounded-2xl px-7 py-6">
          <h2 className="font-display text-lg font-medium mb-3">Memory-decay curve</h2>
          {item.stability == null ? (
            <p className="text-sm text-almanac-mute m-0">
              No review history yet -- review this item to start tracking its memory curve.
            </p>
          ) : curve ? (
            <RetrievabilityCurve curve={curve} />
          ) : (
            <p className="text-sm text-almanac-mute m-0">Loading&hellip;</p>
          )}
        </div>
      )}

      {item.reviews.length > 0 && (
        <div>
          <h2 className="font-display text-lg font-medium mb-3">Review history</h2>
          <ul className="list-none p-0 m-0">
            {item.reviews.map((review, i) => (
              <li key={review.id} className="flex gap-3.5 pb-4 last:pb-0">
                <div className="flex flex-col items-center flex-none">
                  <span
                    className={
                      review.result === 'REVIEWED'
                        ? 'w-2.5 h-2.5 rounded-full mt-1 flex-none bg-almanac-accent'
                        : 'w-2.5 h-2.5 rounded-full mt-1 flex-none bg-transparent border border-almanac-mute'
                    }
                  />
                  {i < item.reviews.length - 1 && (
                    <span className="flex-1 w-px bg-almanac-border mt-1" />
                  )}
                </div>
                <div>
                  <div className="text-sm">{review.date}</div>
                  <div className="text-xs text-almanac-mute">
                    {review.result === 'REVIEWED' ? 'Reviewed' : 'Skipped'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!item.deletedAt && (
        <div className="bg-almanac-panel border border-almanac-border rounded-2xl px-7 py-6">
          <h2 className="font-display text-base font-medium mb-1">Start over</h2>
          <p className="text-xs text-almanac-mute mb-4">
            Both wipe this item's schedule back to day one &mdash; review history stays either way.
          </p>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              Reset
            </button>
            <button
              type="button"
              onClick={handleSwitchMode}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 7h13l-4-4" />
                <path d="M17 17H4l4 4" />
              </svg>
              Switch to {item.mode === 'ADAPTIVE' ? 'Fixed' : 'Adaptive'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
