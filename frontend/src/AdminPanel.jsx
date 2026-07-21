import { useEffect, useState } from 'react';
import { listUsers, suspendUser, unsuspendUser } from './api';
import Pagination from './Pagination';

export default function AdminPanel({ token, currentUserId }) {
  const [users, setUsers] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const limit = 20;

  async function refreshUsers() {
    try {
      const data = await listUsers(token, { page });
      setUsers(data.users);
      setTotal(data.total);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refreshUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // No confirm dialog: suspend/unsuspend is reversible (unlike item delete).
  async function handleSuspend(userId) {
    try {
      await suspendUser(token, userId);
      await refreshUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUnsuspend(userId) {
    try {
      await unsuspendUser(token, userId);
      await refreshUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}

      {users.length === 0 ? (
        <p>No users.</p>
      ) : (
        <ul className="due-list">
          {users.map((u) => (
            <li key={u.id}>
              <div>
                <p>{u.email}</p>
                <span className="stage-label">
                  {u.role} · {u.isSuspended ? 'Suspended' : 'Active'} · joined{' '}
                  {u.createdAt.slice(0, 10)}
                </span>
              </div>
              {/* Own row has no button -- the backend forbids self-suspend. */}
              {u.id !== currentUserId && (
                <div className="item-actions">
                  {u.isSuspended ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleUnsuspend(u.id)}
                    >
                      Unsuspend
                    </button>
                  ) : (
                    <button type="button" className="danger" onClick={() => handleSuspend(u.id)}>
                      Suspend
                    </button>
                  )}
                </div>
              )}
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
    </div>
  );
}
