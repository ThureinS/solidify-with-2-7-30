import { useEffect, useState } from 'react';
import { createItem, getDueItems, reviewItem, skipItem } from './api';

const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];

export default function Dashboard({ token, onLogout }) {
  const [dueItems, setDueItems] = useState([]);
  const [newText, setNewText] = useState('');
  const [error, setError] = useState('');
  const [addedMessage, setAddedMessage] = useState('');

  async function refreshDueItems() {
    try {
      setDueItems(await getDueItems(token));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refreshDueItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAddItem(e) {
    e.preventDefault();
    setError('');
    setAddedMessage('');
    try {
      await createItem(token, newText);
      setNewText('');
      setAddedMessage('Added -- first review is due in 2 days.');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReview(itemId) {
    try {
      await reviewItem(token, itemId);
      await refreshDueItems();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSkip(itemId) {
    try {
      await skipItem(token, itemId);
      await refreshDueItems();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <header className="dashboard-header">
        <h1>Due today</h1>
        <button type="button" className="link" onClick={onLogout}>
          Log out
        </button>
      </header>

      <form onSubmit={handleAddItem} className="add-item-form">
        <input
          type="text"
          placeholder="What did you learn?"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          required
        />
        <button type="submit">Add item</button>
      </form>
      {addedMessage && <p className="success">{addedMessage}</p>}
      {error && <p className="error">{error}</p>}

      {dueItems.length === 0 ? (
        <p>Nothing due today.</p>
      ) : (
        <ul className="due-list">
          {dueItems.map((item) => (
            <li key={item.id}>
              <div>
                <p>{item.preview}</p>
                <span className="stage-label">{STAGE_LABELS[item.stage]}</span>
              </div>
              <div className="item-actions">
                <button type="button" onClick={() => handleReview(item.id)}>
                  Review
                </button>
                <button type="button" className="secondary" onClick={() => handleSkip(item.id)}>
                  Skip
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
