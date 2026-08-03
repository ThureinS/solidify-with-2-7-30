const BASE_URL = import.meta.env.VITE_API_URL;
const REFRESH_TOKEN_KEY = 'refreshToken';

// The backend's "today" must be the user's local calendar date, not UTC --
// new Date().toISOString() gives the UTC date, which is a day off from the
// user's actual local date near midnight. This is the same date-safety
// concern the backend was built around, now on the client side of it.
export function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// api.js owns the refresh token in storage: it's the only code that needs to
// read it (to refresh) or write it (after login/rotation/change-password).
export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function storeRefreshToken(refreshToken) {
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearRefreshToken() {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

// App.jsx registers these once so this module can hand back a refreshed
// access token (same shape as a successful login) or end the session
// (refresh token missing/invalid/reused) without importing App.jsx itself.
let onTokensRefreshed = () => {};
let onAuthExpired = () => {};

export function setAuthHandlers(handlers) {
  onTokensRefreshed = handlers.onTokensRefreshed;
  onAuthExpired = handlers.onAuthExpired;
}

// Single-flight: every 401 that arrives while a refresh is already in
// flight shares this one promise instead of firing its own /auth/refresh.
// Two concurrent refreshes would both rotate the same token -- the second
// to land would see the first's replacement as "already used" and treat it
// as a leak, killing the whole session. See developer-handover.md §12b.
let refreshPromise = null;

function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    onAuthExpired();
    return Promise.reject(new Error('No refresh token'));
  }

  refreshPromise = fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Refresh failed');
      storeRefreshToken(data.refreshToken);
      onTokensRefreshed(data.accessToken);
      return data.accessToken;
    })
    .catch((err) => {
      clearRefreshToken();
      onAuthExpired();
      throw err;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

async function request(path, { token, retry = true, ...options } = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  // A 401 on an authenticated call means the access token expired (or was
  // otherwise invalidated) -- try one silent refresh-and-retry before
  // surfacing it. `retry: false` on the retried call stops this from
  // looping if the fresh token somehow 401s again.
  if (res.status === 401 && token && retry) {
    const newToken = await refreshAccessToken();
    return request(path, { ...options, token: newToken, retry: false });
  }

  const data = res.status === 204 ? null : await res.json();

  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.status = res.status; // so callers can tell 401/403 from a 5xx/network blip
    throw err;
  }
  return data;
}

export function register(email, password) {
  return request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
}

// Returns { accessToken, refreshToken }.
export function login(email, password) {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

// Best-effort: revokes the refresh token server-side. No `token` param, since
// the refresh token itself is the credential this route needs.
export function logout(refreshToken) {
  return request('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
}

export function createItem(token, text) {
  return request('/items', {
    token,
    method: 'POST',
    body: JSON.stringify({ text, date: todayLocal() }),
  });
}

export function getDueItems(token) {
  return request(`/items/due?date=${todayLocal()}`, { token });
}

// date anchors the response's currentStreak (see reviewHistoryQuerySchema on
// the backend) -- omit it and the server just won't include that field.
export function getReviewHistory(token, year, date) {
  const dateParam = date ? `&date=${date}` : '';
  return request(`/items/review-history?year=${year}${dateParam}`, { token });
}

export function listItems(token, { status = 'active', page = 1 } = {}) {
  return request(`/items?status=${status}&page=${page}`, { token });
}

export function getItem(token, itemId) {
  return request(`/items/${itemId}`, { token });
}

export function updateItem(token, itemId, text) {
  return request(`/items/${itemId}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

// Soft delete on the backend; returns 204 -> request() resolves to null.
export function deleteItem(token, itemId) {
  return request(`/items/${itemId}`, { token, method: 'DELETE' });
}

export function reviewItem(token, itemId) {
  return request(`/items/${itemId}/review`, {
    token,
    method: 'POST',
    body: JSON.stringify({ date: todayLocal() }),
  });
}

export function skipItem(token, itemId) {
  return request(`/items/${itemId}/skip`, {
    token,
    method: 'POST',
    body: JSON.stringify({ date: todayLocal() }),
  });
}

// --- Current user + admin ---

// How the client learns its own role/id. Same user shape as the admin list.
export function getMe(token) {
  return request('/auth/me', { token });
}

// Returns a fresh { accessToken, refreshToken } pair: the backend bumps
// tokenVersion and revokes existing refresh tokens on change, which
// invalidates the credentials used to make this very request too.
export function changePassword(token, currentPassword, newPassword) {
  return request('/auth/change-password', {
    token,
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// limit is omitted -- the backend defaults to 20, matching listItems.
export function listUsers(token, { page = 1 } = {}) {
  return request(`/admin/users?page=${page}`, { token });
}

// GET /export returns JSON { user, items } (not a file stream), so request()
// parses it like any other call; the component turns that object into a Blob
// download. includeDeleted is sent as the literal string 'true'/'false' the
// backend enum expects.
export function exportData(token, includeDeleted = false) {
  return request(`/export?includeDeleted=${includeDeleted}`, { token });
}

// suspend/unsuspend return 204 -> request() resolves to null, like deleteItem.
export function suspendUser(token, userId) {
  return request(`/admin/users/${userId}/suspend`, { token, method: 'POST' });
}

export function unsuspendUser(token, userId) {
  return request(`/admin/users/${userId}/unsuspend`, { token, method: 'POST' });
}
