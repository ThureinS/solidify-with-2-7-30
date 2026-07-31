import { useEffect, useState } from 'react';
import { listUsers, suspendUser, unsuspendUser } from './api';
import Pagination from './Pagination';

// Grouped-by-status row: monogram badge, email, role + joined date, action.
// Status itself isn't repeated in the meta line -- it's already said by which
// group (Active/Suspended) the row is under.
function UserRow({ user, isSelf, onSuspend, onUnsuspend }) {
  return (
    <li className="flex items-center gap-3.5 bg-almanac-panel border border-almanac-border rounded-2xl px-4 py-3">
      <span className="w-9 h-9 rounded-full border border-almanac-accent flex items-center justify-center flex-shrink-0 font-display text-sm text-almanac-accent">
        {user.email[0].toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <p className="m-0 mb-0.5 text-sm break-words">{user.email}</p>
        <span className="text-xs text-almanac-mute">
          {user.role} · joined {user.createdAt.slice(0, 10)}
        </span>
      </div>
      {/* Own row has no button -- the backend forbids self-suspend. */}
      {isSelf ? (
        <span className="text-xs text-almanac-mute flex-shrink-0">You</span>
      ) : user.isSuspended ? (
        <button
          type="button"
          onClick={onUnsuspend}
          className="flex-shrink-0 rounded-lg px-3.5 py-1.5 text-xs font-semibold bg-almanac-accent text-almanac-bg border-0 cursor-pointer"
        >
          Unsuspend
        </button>
      ) : (
        <button
          type="button"
          onClick={onSuspend}
          className="flex-shrink-0 rounded-lg px-3.5 py-1.5 text-xs bg-transparent text-almanac-danger border border-almanac-danger cursor-pointer"
        >
          Suspend
        </button>
      )}
    </li>
  );
}

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

  const activeUsers = users.filter((u) => !u.isSuspended);
  const suspendedUsers = users.filter((u) => u.isSuspended);

  return (
    <div className="flex flex-col gap-5">
      {error && <p className="text-sm text-almanac-accent">{error}</p>}

      {users.length === 0 ? (
        <p className="text-sm text-almanac-mute">No users.</p>
      ) : (
        <>
          {activeUsers.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-almanac-mute">
                Active <span className="normal-case tracking-normal opacity-80">· {activeUsers.length}</span>
              </div>
              <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
                {activeUsers.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === currentUserId}
                    onSuspend={() => handleSuspend(u.id)}
                    onUnsuspend={() => handleUnsuspend(u.id)}
                  />
                ))}
              </ul>
            </div>
          )}

          {suspendedUsers.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-almanac-mute">
                Suspended <span className="normal-case tracking-normal opacity-80">· {suspendedUsers.length}</span>
              </div>
              <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
                {suspendedUsers.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === currentUserId}
                    onSuspend={() => handleSuspend(u.id)}
                    onUnsuspend={() => handleUnsuspend(u.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
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
