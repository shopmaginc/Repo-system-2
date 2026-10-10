/**
 * API client for the field app.
 *
 * Base URL resolution (first wins):
 *  1. localStorage override (`field.apiBase`) — set on the login screen,
 *     so a phone can be pointed at any backend without rebuilding.
 *  2. VITE_API_URL build-time env — set this for Cloudflare Pages
 *     production builds (see .env.production.example).
 *  3. `/api` — dev (Vite proxies to the backend) and same-origin deploys.
 */

const TOKEN_KEY = 'field.accessToken';
const REFRESH_KEY = 'field.refreshToken';
const BASE_KEY = 'field.apiBase';

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
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}
export function isLoggedIn(): boolean {
  return !!getToken();
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    // Session dead (expired, suspended, revoked) — back to login.
    clearSession();
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new ApiError(401, 'unauthorized', 'Session expired. Please log in again.');
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'request_failed', err?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  return handleResponse<T>(res);
}

/** POST multipart/form-data (photo capture, document scans). Lets the
 *  browser set the Content-Type boundary; never set it manually. */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${getApiBase()}${path}`, { method: 'POST', headers, body: form });
  return handleResponse<T>(res);
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) }),
  put: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'PUT', body: payload === undefined ? undefined : JSON.stringify(payload) }),
  patch: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'PATCH', body: payload === undefined ? undefined : JSON.stringify(payload) }),
};

export async function login(email: string, password: string): Promise<void> {
  const res = await api.post<{ accessToken: string; refreshToken: string }>('/auth/login', {
    email,
    password,
  });
  setTokens(res.accessToken, res.refreshToken);
}

export async function logout(): Promise<void> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  try {
    if (refresh) await api.post('/auth/logout', { refreshToken: refresh });
  } catch {
    /* best effort */
  }
  clearSession();
}

/* ------------------------------------------------------------------ */
/* Typed shapes (mirror @repo/shared)                                  */
/* ------------------------------------------------------------------ */

export interface FieldAddress {
  id: string;
  label: string;
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface FieldAssignment {
  id: string;
  caseNumber: string;
  status: string;
  priority: string;
  asset: {
    vin: string;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    color?: string | null;
    plate?: string | null;
  } | null;
  debtor: Record<string, unknown> | null;
  clientName?: string | null;
  lenderName?: string | null;
  addresses: FieldAddress[];
  distanceMeters?: number | null;
}

export interface CaseCard {
  id: string;
  caseNumber: string;
  status: string;
  priority: string;
  asset: FieldAssignment['asset'];
  debtor: Record<string, unknown> | null;
  client: {
    id: string;
    name: string;
    contactName?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    contactCell?: string | null;
  } | null;
  lender: { id: string; name: string } | null;
  addresses: FieldAddress[];
}

export interface MeUser {
  id: string;
  name: string;
  email: string;
  role: string;
  canCaptureLotPhotos: boolean;
}

export interface VinVerifyResult {
  match: boolean;
  scanA: string;
  scanB: string;
  assetVin: string;
  aMatchesAsset: boolean;
  bMatchesAsset: boolean;
  aMatchesB: boolean;
}

export interface SkipWorksheet {
  knownAddresses: Array<{ street: string; city?: string; state?: string; zip?: string; source?: string }>;
  phones: Array<{ number: string; source?: string }>;
  associates: Array<{ name: string; relation?: string; notes?: string }>;
  vehicles: Array<{ vin?: string; plate?: string; description?: string }>;
  notes: string;
}

export interface SkipPullRecord {
  id: string;
  provider: string;
  status: string;
  summary?: string | null;
  resultRefs?: unknown;
  requestedByName?: string | null;
  requestedAt: string;
  completedAt?: string | null;
}

export interface CrossRefHit {
  caseId: string;
  caseNumber: string;
  status: string;
  matchedOn: string[];
  debtor?: Record<string, unknown>;
}

export interface EmailTemplateRecord {
  id: string;
  key: string;
  name: string;
  subject: string;
  body: string;
}

export interface EmailDraftRecord {
  id: string;
  templateKey: string;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  status: string;
  rejectionNote?: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  sentAt?: string | null;
  transport?: string | null;
  createdAt: string;
}

export interface ClientContactRecord {
  id: string;
  clientId: string;
  clientName?: string | null;
  name: string;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  cell?: string | null;
  notes?: string | null;
}

/* ------------------------------------------------------------------ */
/* Phase 5 — company operations                                        */
/* ------------------------------------------------------------------ */

export interface ConversationRecord {
  id: string;
  kind: 'direct' | 'company_wide';
  title?: string | null;
  memberCount: number;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole?: string | null;
  body: string;
  attachmentRefs?: Array<{ ref: string; name?: string; mimeType?: string }> | null;
  createdAt: string;
}

export interface DirectoryContactRecord {
  id: string;
  name: string;
  company?: string | null;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  addedByName?: string | null;
}

export interface TimeOffRecord {
  id: string;
  userId: string;
  userName?: string | null;
  startDate: string;
  endDate: string;
  reason?: string | null;
  status: 'pending' | 'approved' | 'denied';
  decidedByName?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
}

export interface WeeklyReport {
  weekStart: string;
  casesByStatus: Record<string, number>;
  possessions: number;
  deliveries: number;
  invoicesCreated: number;
  invoicesApproved: number;
  avgDaysIntakeToPossession: number | null;
  perAgent: Array<{ agentId: string; agentName: string; assignedCases: number; possessions: number }>;
}

export function fmtDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function addrLine(a: FieldAddress): string {
  return [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
}
