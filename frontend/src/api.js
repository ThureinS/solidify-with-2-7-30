const BASE_URL = import.meta.env.VITE_API_URL;

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

async function request(path, { token, ...options } = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
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

export function login(email, password) {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
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
