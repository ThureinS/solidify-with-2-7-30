import { useEffect, useState } from 'react';
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
import AccountPanel from './AccountPanel';
import Pagination from './Pagination';
import { computeWeeklyRecap } from './weeklyRecap';

const STAGE_LABELS = ['2-day review', '7-day review', '30-day review'];

const ITEM_ROW_CLASS =
  'flex justify-between items-start gap-4 bg-almanac-panel border border-almanac-border rounded-2xl px-5 py-4 cursor-pointer hover:border-almanac-accent';

function tabClass(active) {
  return active
    ? 'rounded-full px-4 py-1.5 text-sm font-semibold bg-almanac-accent text-almanac-bg border border-almanac-accent cursor-pointer'
    : 'rounded-full px-4 py-1.5 text-sm bg-almanac-panel text-almanac-mute border border-almanac-border cursor-pointer hover:text-almanac-ink';
}

export default function Dashboard({ token, user, onTokenRefresh }) {
  const [view, setView] = useState('due'); // 'due' | 'all' | 'admin' | 'account'
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
  const [weeklyRecap, setWeeklyRecap] = useState(null); // null while loading / nothing to compare yet
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

      // The recap reaches back at most 13 days (on a Sunday: 6 days to this
      // week's Monday, then 7 more), so up to and including Jan 13 part of the
      // window sits in the previous calendar year. getReviewHistory is scoped
      // to one year, so those days would silently read as zero activity and the
      // comparison would look like a collapse in effort every New Year. Fetch
      // last year's tail only on the days it can actually matter.
      let recapDays = history.days;
      const [, month, dayOfMonth] = today.split('-').map(Number);
      if (month === 1 && dayOfMonth <= 13) {
        const previous = await getReviewHistory(token, Number(today.slice(0, 4)) - 1);
        recapDays = [...previous.days, ...history.days];
      }
      setWeeklyRecap(computeWeeklyRecap(recapDays, today));
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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-medium mb-1">
          {view === 'due' ? 'Due today' : view === 'all' ? 'All items' : view === 'admin' ? 'Admin' : 'Account'}
        </h1>
        <span className="text-sm text-almanac-mute">
          {/* "left", not "due": anything already reviewed/skipped today has
              dropped off this list, so this is the remainder -- History's
              "x of y handled" counts the same day's full workload. */}
          {dueItems.length} left today
          {/* NOT "completion": this is reviewed / (reviewed + skipped) across the
              actions you logged. It has no idea what was due, so it can't be a
              completion rate -- review 3 items all year and skip nothing and it
              reads 100%. Items you never opened write no row and are invisible
              here, by the same limitation as the history grid's legend. */}
          {completionRate !== null && (
            <span title="Of the actions you logged this year, this share were reviews rather than skips. It can't count items you never opened -- nothing is recorded for those.">
              {` · ${completionRate}% reviewed rather than skipped this year`}
            </span>
          )}
          {!!streak && (
            <span title="Any day you reviewed or skipped something keeps the streak going.">
              {` · ${streak} day${streak === 1 ? '' : 's'} streak`}
            </span>
          )}
          {weeklyRecap &&
            ` · ${weeklyRecap.thisWeekCount} handled this week (${weeklyRecap.rangeLabel}), ${weeklyRecap.verb} ${weeklyRecap.lastWeekCount} by this point last week`}
        </span>
      </div>

      {/* Hidden until we know who we are: goalKey needs the real user id, so a
          goal typed while /auth/me is still in flight -- or while it's failing
          with a 5xx, which App.jsx keeps the session alive through -- would save
          under 'dailyGoal:anon' and silently vanish on the next good load. */}
      {user?.id && (
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-almanac-mute">
            Daily goal
            <input
              type="number"
              min="0"
              step="1"
              value={dailyGoal || ''}
              onChange={handleGoalChange}
              placeholder="off"
              className="w-16 px-2.5 py-1.5 text-sm text-almanac-ink bg-almanac-panel border border-almanac-border rounded-lg"
            />
          </label>
          {dailyGoal > 0 && (
            <>
              <progress
                value={Math.min(handledToday, dailyGoal)}
                max={dailyGoal}
                aria-label="Daily goal progress"
                className="flex-1 min-w-[120px] h-2 accent-almanac-accent"
              />
              <span className="text-sm text-almanac-mute">
                {handledToday} / {dailyGoal}
              </span>
            </>
          )}
        </div>
      )}

      <div className="flex gap-1.5">
        <button type="button" className={tabClass(view === 'due')} onClick={() => setView('due')}>
          Due today
        </button>
        <button type="button" className={tabClass(view === 'all')} onClick={() => setView('all')}>
          All items
        </button>
        {user?.role === 'ADMIN' && (
          <button type="button" className={tabClass(view === 'admin')} onClick={() => setView('admin')}>
            Admin
          </button>
        )}
        <button type="button" className={tabClass(view === 'account')} onClick={() => setView('account')}>
          Account
        </button>
      </div>

      {view !== 'admin' && view !== 'account' && (
        <>
          <form onSubmit={handleAddItem} className="flex gap-2.5">
            <input
              type="text"
              placeholder="What did you learn?"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              required
              className="flex-1 px-3.5 py-2.5 text-sm text-almanac-ink bg-almanac-panel border border-almanac-border rounded-lg"
            />
            <button
              type="submit"
              className="rounded-lg px-4 py-2.5 text-sm font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer"
            >
              Add item
            </button>
          </form>
          {addedMessage && <p className="text-sm text-almanac-accent">{addedMessage}</p>}
          {error && <p className="text-sm text-almanac-accent">{error}</p>}
        </>
      )}

      {view === 'due' ? (
        dueItems.length === 0 ? (
          <p className="text-sm text-almanac-mute">Nothing due today.</p>
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
            {dueItems.map((item) => (
              <li
                key={item.id}
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
                className={ITEM_ROW_CLASS}
              >
                <div>
                  <p className="m-0 mb-1 whitespace-pre-wrap text-sm">{item.text}</p>
                  <span className="text-xs text-almanac-mute">{STAGE_LABELS[item.stage]}</span>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleReview(item.id)}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer"
                  >
                    Review
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSkip(item.id)}
                    className="rounded-lg px-3 py-1.5 text-xs bg-transparent text-almanac-ink border border-almanac-border cursor-pointer"
                  >
                    Skip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : view === 'all' ? (
        <>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <label className="flex flex-col gap-1 text-xs text-almanac-mute">
              Status
              <select
                value={statusFilter}
                onChange={(e) => {
                  setPage(1);
                  setStatusFilter(e.target.value);
                }}
                className="px-3 py-2 text-sm text-almanac-ink bg-almanac-panel border border-almanac-border rounded-lg"
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </label>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-almanac-ink">
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(e) => setIncludeDeleted(e.target.checked)}
                  className="w-4 h-4 accent-almanac-accent"
                />
                Include deleted
              </label>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="rounded-lg px-3.5 py-2 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                {exporting ? 'Exporting…' : 'Download my items'}
              </button>
            </div>
          </div>

          {allItems.length === 0 ? (
            <p className="text-sm text-almanac-mute">No items.</p>
          ) : (
            <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
              {allItems.map((item) => (
                <li
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(item.id);
                    }
                  }}
                  className={ITEM_ROW_CLASS}
                >
                  <div>
                    <p className="m-0 mb-1 whitespace-pre-wrap text-sm">{item.preview}</p>
                    <span className="text-xs text-almanac-mute">
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
      ) : view === 'admin' ? (
        <AdminPanel token={token} currentUserId={user.id} />
      ) : (
        <AccountPanel token={token} onTokenRefresh={onTokenRefresh} />
      )}
    </div>
  );
}
