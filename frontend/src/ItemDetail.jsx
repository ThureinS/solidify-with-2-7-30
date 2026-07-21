import { useEffect, useState } from 'react';
import { getItem, updateItem, deleteItem } from './api';

// ponytail: duplicated from Dashboard; a shared constants module isn't worth it for one array.
const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];

export default function ItemDetail({ token, itemId, onBack, onChanged }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    getItem(token, itemId)
      .then(setItem)
      .catch((err) => setError(err.message));
  }, [token, itemId]);

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

  if (!item) {
    return (
      <div>
        <button type="button" className="link" onClick={onBack}>
          &larr; Back
        </button>
        {error ? <p className="error">{error}</p> : <p>Loading&hellip;</p>}
      </div>
    );
  }

  const statusLabel = item.deletedAt
    ? 'Deleted'
    : item.isComplete
      ? 'Archived'
      : STAGE_LABELS[item.stage];

  return (
    <div>
      <button type="button" className="link" onClick={onBack}>
        &larr; Back to list
      </button>

      {editing ? (
        <form onSubmit={handleSave}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            required
          />
          <div className="item-actions">
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="item-text">{item.text}</p>
          <p className="stage-label">
            {statusLabel} &middot; added {item.dateAdded} &middot; next review {item.nextReviewDate}
          </p>

          {!item.deletedAt && (
            <div className="item-actions">
              <button type="button" onClick={startEditing}>
                Edit
              </button>
              <button type="button" className="danger" onClick={handleDelete}>
                Delete
              </button>
            </div>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}

      {item.reviews.length > 0 && (
        <>
          <h2 className="detail-subhead">Review history</h2>
          <ul className="due-list">
            {item.reviews.map((review) => (
              <li key={review.id}>
                <span>{review.date}</span>
                <span className="stage-label">{review.result}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
