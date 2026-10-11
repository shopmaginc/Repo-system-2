/**
 * Dashboard view — operation overview: stat cards, recent cases, needs attention.
 */
import { api } from '../api.js';

interface CaseRow {
  id: string;
  caseNumber?: string;
  status?: string;
  asset?: { vin?: string } | null;
  assignedAgent?: { name?: string } | null;
}

interface ReviewItem {
  documentId?: string;
  kind?: string;
  caseId?: string;
  caseNumber?: string;
}

const CLOSED_STATUSES = new Set(['closed', 'cancelled']);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const m: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return m[c] ?? c;
  });
}

function prettyStatus(s: string): string {
  return s
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

async function safeCount<T>(promise: Promise<T>, pick: (v: T) => number): Promise<number> {
  try {
    return pick(await promise);
  } catch {
    return 0;
  }
}

export async function renderDashboard(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-title">Dashboard</div>
    <div class="page-sub">Operation overview</div>
    <div id="dashError"></div>
    <div class="stats" id="dashStats"><div class="stat"><div class="num">…</div><div class="label">Loading</div></div></div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;" id="dashCols">
      <div class="card"><h3 style="margin-bottom:12px;">Recent cases</h3><div id="dashCases">Loading…</div></div>
      <div class="card"><h3 style="margin-bottom:12px;">Needs attention</h3><div id="dashAttention">Loading…</div></div>
    </div>
  `;

  const errBox = container.querySelector<HTMLElement>('#dashError')!;
  const statsEl = container.querySelector<HTMLElement>('#dashStats')!;
  const casesEl = container.querySelector<HTMLElement>('#dashCases')!;
  const attnEl = container.querySelector<HTMLElement>('#dashAttention')!;

  const errors: string[] = [];

  // Fetch everything in parallel; each failure degrades gracefully.
  const [casesRes, reviewRes, usersRes] = await Promise.all([
    api<{ cases?: CaseRow[] }>('/cases').catch((e: unknown) => {
      errors.push(`Cases: ${e instanceof Error ? e.message : 'failed'}`);
      return { cases: [] as CaseRow[] };
    }),
    api<unknown>('/review-queue').catch((e: unknown) => {
      errors.push(`Review queue: ${e instanceof Error ? e.message : 'failed'}`);
      return [] as unknown;
    }),
    api<{ users?: unknown[] }>('/admin/users').catch((e: unknown) => {
      errors.push(`Users: ${e instanceof Error ? e.message : 'failed'}`);
      return { users: [] as unknown[] };
    }),
  ]);

  // Email drafts have no global endpoint in this API version — try, fall back to 0.
  const pendingEmails = await safeCount(
    api<{ drafts?: unknown[] } | unknown[]>('/email/drafts?status=pending'),
    (v) => (Array.isArray(v) ? v.length : (v as { drafts?: unknown[] }).drafts?.length ?? 0),
  );

  const cases = casesRes.cases ?? [];
  const reviewItems: ReviewItem[] = Array.isArray(reviewRes)
    ? (reviewRes as ReviewItem[])
    : ((reviewRes as { items?: ReviewItem[] }).items ?? []);
  const users = usersRes.users ?? [];

  const activeCases = cases.filter((c) => !CLOSED_STATUSES.has(c.status ?? '')).length;

  if (errors.length > 0) {
    errBox.innerHTML = `<div class="error">${errors.map(esc).join('<br>')}</div>`;
  }

  statsEl.innerHTML = `
    <div class="stat"><div class="num">${activeCases}</div><div class="label">Active cases</div></div>
    <div class="stat"><div class="num">${reviewItems.length}</div><div class="label">Docs awaiting review</div></div>
    <div class="stat"><div class="num">${pendingEmails}</div><div class="label">Emails awaiting approval</div></div>
    <div class="stat"><div class="num">${users.length}</div><div class="label">Staff users</div></div>
  `;

  if (cases.length === 0) {
    casesEl.textContent = 'No cases found.';
  } else {
    const rows = cases.slice(0, 8).map(
      (c) => `
      <tr>
        <td><a href="#/cases">${esc(c.caseNumber ?? c.id.slice(0, 8))}</a></td>
        <td style="font-family:monospace;">${esc(c.asset?.vin ?? '—')}</td>
        <td><span class="badge badge-info">${esc(prettyStatus(c.status ?? 'unknown'))}</span></td>
        <td>${esc(c.assignedAgent?.name ?? 'Unassigned')}</td>
      </tr>`,
    );
    casesEl.innerHTML = `
      <table>
        <thead><tr><th>Case #</th><th>VIN</th><th>Status</th><th>Agent</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`;
  }

  const attention: string[] = [];
  for (const item of reviewItems.slice(0, 5)) {
    attention.push(
      `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
        <span class="badge badge-pending">Review</span>
        ${esc(prettyStatus(item.kind ?? 'document'))} — <a href="#/review">${esc(item.caseNumber ?? 'case')}</a>
      </div>`,
    );
  }
  if (pendingEmails > 0) {
    attention.push(
      `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
        <span class="badge badge-pending">Email</span>
        ${pendingEmails} draft${pendingEmails === 1 ? '' : 's'} awaiting approval — <a href="#/emails">review</a>
      </div>`,
    );
  }
  attnEl.innerHTML =
    attention.length > 0 ? attention.join('') : '<p style="color:var(--muted);">All clear.</p>';
}
