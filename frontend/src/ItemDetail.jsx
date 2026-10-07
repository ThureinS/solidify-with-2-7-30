import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getItem, updateItem, deleteItem, getRetrievabilityCurve, resetItem, switchItemMode, todayLocal } from './api';
import ConfirmDialog from './ConfirmDialog';
import RetrievabilityCurve from './RetrievabilityCurve';

// ponytail: duplicated from Dashboard; a shared constants module isn't worth it for one array.
const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];
const GRADE_LABELS = { AGAIN: 'Again', HARD: 'Hard', GOOD: 'Good', EASY: 'Easy' };

// "overdue by N days", or '' when not late. Both dates are calendar dates
// (YYYY-MM-DD); "today" is the client's local date (todayLocal), never the
// server's clock. Date.UTC turns each into midnight UTC, so the difference
// is whole days with no time-zone or daylight-saving drift.
function overdueLabel(nextReviewDate, today) {
  const [y1, m1, d1] = nextReviewDate.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  const days = (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000;
  if (days <= 0) return '';
  return `overdue by ${days} day${days === 1 ? '' : 's'}`;
}

// Appended to a button's classes so a disabled one (demo account) looks inactive.
const DISABLED = ' disabled:opacity-40 disabled:cursor-not-allowed';

// readOnly: the demo account. Its writes would get 403 from the server, so
// the write buttons are disabled instead (see Dashboard's banner).
export default function ItemDetail({ token, readOnly, onChanged }) {
  const { id: itemId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [curve, setCurve] = useState(null);
  // The action waiting for a yes/no in the dialog: 'delete', 'reset', 'switch', or null.
  const [pending, setPending] = useState(null);

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

  // location.key is 'default' only on the first page of this tab's visit
  // (a refresh or a shared link). Going -1 there would leave the app, so go
  // to the list instead.
  function onBack() {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  }

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

  // Delete, Reset and Switch each ask first. The buttons only set `pending`
  // to which action is waiting; the dialog's Confirm runs it.
  async function handleConfirm() {
    const action = pending;
    // Close first, so a double click can't send the request twice.
    setPending(null);
    if (action === 'delete') await handleDelete();
    else if (action === 'reset') await handleReset();
    else if (action === 'switch') await handleSwitchMode();
  }

  async function handleDelete() {
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
  // Archived and deleted items have no review coming, so they can't be late.
  const overdue = item.deletedAt || item.isComplete ? '' : overdueLabel(item.nextReviewDate, todayLocal());

  const nextModeLabel = item.mode === 'ADAPTIVE' ? 'Fixed' : 'Adaptive';
  // All three use the red (danger) Confirm: none can be undone. Switching
  // back doesn't bring the old schedule back -- it starts over again.
  const confirmText = {
    delete: { title: 'Delete item', message: 'Delete this item? It will be moved to deleted.', label: 'Delete' },
    reset: {
      title: 'Reset item',
      message: 'Reset this item? Its schedule starts over from day one — review history stays.',
      label: 'Reset',
    },
    switch: {
      title: 'Switch mode',
      message: `Switch to ${nextModeLabel} mode? Its schedule starts over from day one — review history stays.`,
      label: `Switch to ${nextModeLabel}`,
    },
  }[pending];

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-7">
      <ConfirmDialog
        open={pending !== null}
        title={confirmText?.title}
        message={confirmText?.message}
        confirmLabel={confirmText?.label}
        onConfirm={handleConfirm}
        onCancel={() => setPending(null)}
      />

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
              {overdue && <span className="text-almanac-danger"> &middot; {overdue}</span>}
            </p>

            {!item.deletedAt && (
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={startEditing}
                  disabled={readOnly}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer${DISABLED}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setPending('delete')}
                  disabled={readOnly}
                  className={`rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-danger border border-almanac-danger cursor-pointer${DISABLED}`}
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
                    {/* grade is set only for Adaptive reviews; Fixed reviews and skips have null */}
                    {review.result === 'REVIEWED' ? 'Reviewed' : 'Skipped'}
                    {review.grade && ` · ${GRADE_LABELS[review.grade]}`}
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
              onClick={() => setPending('reset')}
              disabled={readOnly}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer${DISABLED}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              Reset
            </button>
            <button
              type="button"
              onClick={() => setPending('switch')}
              disabled={readOnly}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer${DISABLED}`}
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
