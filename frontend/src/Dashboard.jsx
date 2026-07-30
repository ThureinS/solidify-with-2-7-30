import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createItem,
  exportData,
  getDueItems,
  getReviewHistory,
  listItems,
  reviewItem,
  skipItem,
  todayLocal,
} from './api';
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
  const [completionRate, setCompletionRate] = useState(null); // null while loading / no data yet
  const [streak, setStreak] = useState(null);
  const [handledToday, setHandledToday] = useState(0);
  const goalKey = `dailyGoal:${user?.id ?? 'anon'}`;
  const [dailyGoal, setDailyGoal] = useState(0);
  const limit = 20;

  // user loads asynchronously (starts null, see App.jsx's getMe effect), so
  // goalKey isn't known yet on the first render -- read localStorage here
  // once the real id shows up, rather than in useState's one-shot initializer.
  useEffect(() => {
    if (user?.id) setDailyGoal(Number(localStorage.getItem(goalKey)) || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Re-run after every review/skip, not just on mount: all three numbers come
  // from this one endpoint, so refetching is simpler than nudging each stat by
  // hand -- and it can't drift. (Bumping the streak locally would be wrong
  // anyway: if today was already active at load, the server's number already
  // counts today, so a local +1 would sometimes double-count.)
  async function refreshStats() {
    const today = todayLocal();
    try {
      const history = await getReviewHistory(token, Number(today.slice(0, 4)), today);
      let reviewed = 0;
      let skipped = 0;
      for (const day of history.days) {
        reviewed += day.reviewCount;
        skipped += day.skipCount;
      }
      setCompletionRate(reviewed + skipped === 0 ? null : Math.round((100 * reviewed) / (reviewed + skipped)));
      setStreak(history.currentStreak);
      const todayEntry = history.days.find((d) => d.date === today);
      setHandledToday((todayEntry?.reviewCount ?? 0) + (todayEntry?.skipCount ?? 0));
    } catch {
      // a stat row failing silently isn't worth surfacing as a page error
    }
  }

  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function handleGoalChange(e) {
    const value = Math.max(0, Number(e.target.value) || 0);
    setDailyGoal(value);
    if (value) localStorage.setItem(goalKey, String(value));
    else localStorage.removeItem(goalKey);
  }

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
    if (view === 'due') refreshDueItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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
      await Promise.all([refreshDueItems(), refreshStats()]);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSkip(itemId) {
    try {
      await skipItem(token, itemId);
      await Promise.all([refreshDueItems(), refreshStats()]);
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
        onChanged={view === 'due' ? refreshDueItems : refreshAllItems}
      />
    );
  }

  return (
    <div>
      <header className="dashboard-header">
        <div>
          <h1>{view === 'due' ? 'Due today' : view === 'all' ? 'All items' : 'Admin'}</h1>
          <span className="stage-label">
            {dueItems.length} due today
            {completionRate !== null && ` · ${completionRate}% completion this year`}
            {!!streak && (
              <span title="Any day you reviewed or skipped something keeps the streak going.">
                {` · ${streak} day${streak === 1 ? '' : 's'} streak`}
              </span>
            )}
          </span>
        </div>
        <div className="dashboard-header-links">
          <Link to="/history" className="link">
            Review history
          </Link>
          <button type="button" className="link" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      {/* Hidden until we know who we are: goalKey needs the real user id, so a
          goal typed while /auth/me is still in flight -- or while it's failing
          with a 5xx, which App.jsx keeps the session alive through -- would save
          under 'dailyGoal:anon' and silently vanish on the next good load. */}
      {user?.id && (
        <div className="goal-row">
          <label>
            Daily goal
            <input
              type="number"
              min="0"
              step="1"
              className="goal-input"
              value={dailyGoal || ''}
              onChange={handleGoalChange}
              placeholder="off"
            />
          </label>
          {dailyGoal > 0 && (
            <>
              <progress
                value={Math.min(handledToday, dailyGoal)}
                max={dailyGoal}
                aria-label="Daily goal progress"
              />
              <span className="stage-label">
                {handledToday} / {dailyGoal}
              </span>
            </>
          )}
        </div>
      )}

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
              <li
                key={item.id}
                className="clickable"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (!e.target.closest('button')) setSelectedId(item.id);
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) {
                    e.preventDefault();
                    setSelectedId(item.id);
                  }
                }}
              >
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
