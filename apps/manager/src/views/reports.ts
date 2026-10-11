/**
 * Reports view — weekly manager summary from GET /reports/week,
 * with client-side fallback and a print button.
 */
import { api } from '../api.js';

interface WeeklyReport {
  weekStart: string;
  casesByStatus: Record<string, number>;
  possessions: number;
  deliveries: number;
  invoicesCreated: number;
  invoicesApproved: number;
  avgDaysIntakeToPossession: number | null;
  perAgent: Array<{ agentId: string; agentName: string; assignedCases: number; possessions: number }>;
}

interface CaseRow {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function weekStartUtc(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x;
}

async function loadReport(): Promise<{ report: WeeklyReport; fallback: boolean }> {
  try {
    const data = await api<{ report: WeeklyReport }>('/reports/week');
    return { report: data.report, fallback: false };
  } catch (e: any) {
    if (!/404|not found/i.test(e.message)) throw e;
  }
  // Client-side fallback from case list.
  const data = await api<{ cases: CaseRow[] } | CaseRow[]>('/cases');
  const cases: CaseRow[] = Array.isArray(data) ? data : data.cases ?? [];
  const start = weekStartUtc(new Date());
  const inWeek = (iso?: string) => !!iso && new Date(iso) >= start;
  const casesByStatus: Record<string, number> = {};
  let deliveries = 0;
  for (const c of cases) {
    const s = String(c.status ?? 'unknown');
    casesByStatus[s] = (casesByStatus[s] ?? 0) + 1;
    if (['delivered', 'delivery', 'closed'].includes(s) && inWeek(c.updatedAt)) deliveries++;
  }
  return {
    fallback: true,
    report: {
      weekStart: start.toISOString().slice(0, 10),
      casesByStatus,
      possessions: 0,
      deliveries,
      invoicesCreated: 0,
      invoicesApproved: 0,
      avgDaysIntakeToPossession: null,
      perAgent: [],
    },
  };
}

export async function renderReports(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Reports</h1>
    <p class="page-sub">Weekly manager summaries.</p>
    <div style="margin-bottom:16px;display:flex;gap:8px">
      <button class="btn" id="genBtn">Generate report</button>
      <button class="btn btn-secondary" id="printBtn">Print</button>
    </div>
    <div id="content"><div class="card">Loading…</div></div>
  `;

  const content = container.querySelector<HTMLElement>('#content')!;

  const render = async (): Promise<void> => {
    content.innerHTML = `<div class="card">Loading…</div>`;
    try {
      const { report: r, fallback } = await loadReport();
      const activeCases = Object.entries(r.casesByStatus)
        .filter(([s]) => !['closed', 'cancelled'].includes(s))
        .reduce((a, [, n]) => a + n, 0);

      content.innerHTML = `
        ${fallback ? '<div class="error">Server report unavailable — showing a client-side summary from the case list.</div>' : ''}
        <div class="stats">
          <div class="stat"><div class="num">${r.possessions}</div><div class="label">Recoveries this week</div></div>
          <div class="stat"><div class="num">${r.deliveries}</div><div class="label">Deliveries this week</div></div>
          <div class="stat"><div class="num">${activeCases}</div><div class="label">Active cases</div></div>
          <div class="stat"><div class="num">${r.invoicesCreated - r.invoicesApproved}</div><div class="label">Invoices pending</div></div>
        </div>
        <div class="card" id="printArea">
          <h3>Weekly summary — week of ${esc(r.weekStart)}</h3>
          <table style="margin-top:12px">
            <tbody>
              <tr><th>Cases by status</th><td>${
                Object.entries(r.casesByStatus).map(([s, n]) => `${esc(s)}: <strong>${n}</strong>`).join(' · ') || '—'
              }</td></tr>
              <tr><th>Possessions</th><td>${r.possessions}</td></tr>
              <tr><th>Deliveries</th><td>${r.deliveries}</td></tr>
              <tr><th>Invoices created</th><td>${r.invoicesCreated}</td></tr>
              <tr><th>Invoices approved</th><td>${r.invoicesApproved}</td></tr>
              <tr><th>Avg intake → possession</th><td>${r.avgDaysIntakeToPossession == null ? '—' : r.avgDaysIntakeToPossession + ' days'}</td></tr>
            </tbody>
          </table>
          ${r.perAgent.length ? `
            <h3 style="margin-top:16px">Per-agent activity</h3>
            <table style="margin-top:8px">
              <thead><tr><th>Agent</th><th>Assigned cases</th><th>Possessions</th></tr></thead>
              <tbody>
                ${r.perAgent.map((a) => `
                  <tr><td>${esc(a.agentName)}</td><td>${a.assignedCases}</td><td>${a.possessions}</td></tr>
                `).join('')}
              </tbody>
            </table>
          ` : ''}
          <p style="color:var(--muted);font-size:12px;margin-top:12px">Generated ${esc(new Date().toLocaleString())}</p>
        </div>
      `;
    } catch (e: any) {
      content.innerHTML = `<div class="error">Could not load report: ${esc(e.message)}</div>`;
    }
  };

  container.querySelector('#genBtn')?.addEventListener('click', render);
  container.querySelector('#printBtn')?.addEventListener('click', () => window.print());
  await render();
}
