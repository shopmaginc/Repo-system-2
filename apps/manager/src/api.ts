/**
 * API client for the manager dashboard.
 * Mirrors the field app's client but with manager-specific endpoints.
 */

const TOKEN_KEY = 'manager.accessToken';
const REFRESH_KEY = 'manager.refreshToken';
const BASE_KEY = 'manager.apiBase';

export function getApiBase(): string {
  return (
    localStorage.getItem(BASE_KEY) ||
    import.meta.env.VITE_API_URL ||
    '/api'
  );
}
export function setApiBase(url: string): void {
  localStorage.setItem(BASE_KEY, url.replace(/\/$/, ''));
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
function setTokens(access: string, refresh: string): void {
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

async function refreshAccess(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;
  try {
    const res = await fetch(`${getApiBase()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const doFetch = async (): Promise<Response> => {
    const token = getToken();
    return fetch(`${getApiBase()}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await refreshAccess();
    if (refreshed) {
      res = await doFetch();
    } else {
      clearTokens();
      window.location.hash = '#/login';
      throw new Error('Session expired');
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(err.error?.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function login(email: string, password: string): Promise<void> {
  const data = await api<{ accessToken: string; refreshToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setTokens(data.accessToken, data.refreshToken);
}

export function logout(): void {
  clearTokens();
  window.location.hash = '#/login';
}
