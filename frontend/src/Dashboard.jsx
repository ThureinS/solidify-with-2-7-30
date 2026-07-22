import { useEffect, useState } from 'react';
import { createItem, exportData, getDueItems, listItems, reviewItem, skipItem, todayLocal } from './api';
import ItemDetail from './ItemDetail';
import AdminPanel from './AdminPanel';
import Pagination from './Pagination';

const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];

export default function Dashboard({ token, user, onLogout }) {
  const [view, setView] = useState('due'); // 'due' | 'all' | 'admin'
  const [dueItems, setDueItems] = useState([]);
  const [newText, setNewText] = useState('');
  const [error, setError] = useState('');
  const [addedMessage, setAddedMessage] = useState('');

  const [allItems, setAllItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState('active');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [exporting, setExporting] = useState(false);
  const limit = 20;

  async function refreshDueItems() {
    try {
      setDueItems(await getDueItems(token));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshAllItems() {
    try {
      const data = await listItems(token, { status: statusFilter, page });
      setAllItems(data.items);
      setTotal(data.total);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refreshDueItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === 'all') refreshAllItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, statusFilter, page]);

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

  // Fetch the export JSON, then trigger a browser download of it as a file.
  // The Blob + temporary <a> is the standard client-side "save this data"
  // pattern -- the server just returns JSON, the browser does the saving.
  async function handleExport() {
    setExporting(true); // disable the button so a slow fetch can't be double-clicked into two downloads
    try {
      const data = await exportData(token, includeDeleted);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-items-${todayLocal()}.json`;
      a.click();
      URL.revokeObjectURL(url); // release the object URL once the download has started
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  if (selectedId) {
    return (
      <ItemDetail
        token={token}
        itemId={selectedId}
        onBack={() => setSelectedId(null)}
        onChanged={refreshAllItems}
      />
    );
  }

  return (
    <div>
      <header className="dashboard-header">
        <h1>{view === 'due' ? 'Due today' : view === 'all' ? 'All items' : 'Admin'}</h1>
        <button type="button" className="link" onClick={onLogout}>
          Log out
        </button>
      </header>

      <div className="tabs">
        <button
          type="button"
          className={view === 'due' ? '' : 'secondary'}
          onClick={() => setView('due')}
        >
          Due today
        </button>
        <button
          type="button"
          className={view === 'all' ? '' : 'secondary'}
          onClick={() => setView('all')}
        >
          All items
        </button>
        {user?.role === 'ADMIN' && (
          <button
            type="button"
            className={view === 'admin' ? '' : 'secondary'}
            onClick={() => setView('admin')}
          >
            Admin
          </button>
        )}
      </div>

      {view !== 'admin' && (
        <>
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
        </>
      )}

      {view === 'due' ? (
        dueItems.length === 0 ? (
          <p>Nothing due today.</p>
        ) : (
          <ul className="due-list">
            {dueItems.map((item) => (
              <li key={item.id}>
                <div>
                  <p>{item.text}</p>
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
        )
      ) : view === 'all' ? (
        <>
          <div className="all-toolbar">
            <label className="status-filter">
              Status
              <select
                value={statusFilter}
                onChange={(e) => {
                  setPage(1);
                  setStatusFilter(e.target.value);
                }}
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </label>

            <div className="export-controls">
              <label>
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(e) => setIncludeDeleted(e.target.checked)}
                />
                Include deleted
              </label>
              <button type="button" className="secondary" onClick={handleExport} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Download my items'}
              </button>
            </div>
          </div>

          {allItems.length === 0 ? (
            <p>No items.</p>
          ) : (
            <ul className="due-list">
              {allItems.map((item) => (
                <li
                  key={item.id}
                  className="clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(item.id);
                    }
                  }}
                >
                  <div>
                    <p>{item.preview}</p>
                    <span className="stage-label">
                      {item.isComplete ? 'Archived' : STAGE_LABELS[item.stage]} · next review{' '}
                      {item.nextReviewDate}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Pagination
            page={page}
            total={total}
            limit={limit}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
          />
        </>
      ) : (
        <AdminPanel token={token} currentUserId={user.id} />
      )}
    </div>
  );
}
