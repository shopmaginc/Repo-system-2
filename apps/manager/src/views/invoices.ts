/**
 * Invoices view — list, filter by status tab, detail modal, mark paid.
 */
import { api } from '../api.js';

interface Invoice {
  id: string;
  caseId: string;
  invoiceNumber: string;
  amount: number | null;
  status: string;
  createdAt: string;
  caseNumber?: string;
}

interface CaseRow {
  id: string;
  caseNumber?: string;
  status?: string;
}

const TABS = [
  { key: 'draft', label: 'Draft', match: (s: string) => ['pending', 'draft'].includes(s) },
  { key: 'sent', label: 'Sent', match: (s: string) => ['approved', 'sent'].includes(s) },
  { key: 'paid', label: 'Paid', match: (s: string) => s === 'paid' },
];

const usd = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function statusBadge(status: string): string {
  const cls =
    status === 'paid' ? 'badge-active' :
    ['approved', 'sent'].includes(status) ? 'badge-info' :
    'badge-pending';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

async function loadInvoices(): Promise<Invoice[]> {
  // Prefer a global list endpoint if it exists.
  try {
    const data = await api<{ invoices: Invoice[] }>('/invoices');
    return data.invoices ?? [];
  } catch (e: any) {
    if (!/404|not found/i.test(e.message)) throw e;
  }
  // Fallback: aggregate per-case (limit to first 20 cases for performance).
  const casesData = await api<{ cases: CaseRow[] } | CaseRow[]>('/cases');
  const cases: CaseRow[] = Array.isArray(casesData) ? casesData : casesData.cases ?? [];
  const out: Invoice[] = [];
  for (const c of cases.slice(0, 20)) {
    try {
      const d = await api<{ invoices: Invoice[] }>(`/cases/${c.id}/invoices`);
      for (const inv of d.invoices ?? []) {
        out.push({ ...inv, caseNumber: c.caseNumber ?? c.id.slice(0, 8) });
      }
    } catch {
      // Skip cases we can't read invoices for.
    }
  }
  return out.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

function openModal(container: HTMLElement, inv: Invoice, onPaid: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Invoice ${esc(inv.invoiceNumber)}</h3>
      <table>
        <tr><th>Case</th><td>${esc(inv.caseNumber ?? inv.caseId.slice(0, 8))}</td></tr>
        <tr><th>Amount</th><td><strong>${usd(inv.amount)}</strong></td></tr>
        <tr><th>Status</th><td>${statusBadge(inv.status)}</td></tr>
        <tr><th>Created</th><td>${esc(new Date(inv.createdAt).toLocaleString())}</td></tr>
      </table>
      <div id="payMsg"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="closeBtn">Close</button>
        ${inv.status !== 'paid' ? '<button class="btn" id="payBtn">Mark paid</button>' : ''}
      </div>
    </div>
  `;
  overlay.querySelector('#closeBtn')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#payBtn')?.addEventListener('click', async () => {
    const msg = overlay.querySelector('#payMsg')!;
    try {
      try {
        await api(`/invoices/${inv.id}/pay`, { method: 'POST' });
      } catch (e: any) {
        if (!/404|not found/i.test(e.message)) throw e;
        await api(`/invoices/${inv.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) });
      }
      overlay.remove();
      onPaid();
    } catch (e: any) {
      msg.innerHTML = `<div class="error">${/404|not found/i.test(e.message) ? 'Mark-paid is not available on this server.' : esc(e.message)}</div>`;
    }
  });
  container.appendChild(overlay);
}

export async function renderInvoices(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Invoices</h1>
    <p class="page-sub">Billing across recovered cases.</p>
    <div class="tabs" id="tabs"></div>
    <div id="content"><div class="card">Loading…</div></div>
  `;

  const tabsEl = container.querySelector('#tabs')!;
  const content = container.querySelector<HTMLElement>('#content')!;
  let invoices: Invoice[] = [];
  let activeTab = 'draft';

  try {
    invoices = await loadInvoices();
  } catch (e: any) {
    content.innerHTML = `<div class="error">Could not load invoices: ${esc(e.message)}</div>`;
    return;
  }

  const render = (): void => {
    tabsEl.innerHTML = TABS.map((t) => {
      const n = invoices.filter((i) => t.match(i.status)).length;
      return `<button class="${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}">${t.label} (${n})</button>`;
    }).join('');
    tabsEl.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { activeTab = b.dataset.tab!; render(); })
    );

    const tab = TABS.find((t) => t.key === activeTab)!;
    const rows = invoices.filter((i) => tab.match(i.status));

    if (rows.length === 0) {
      content.innerHTML = `<div class="card">No ${tab.label.toLowerCase()} invoices.</div>`;
      return;
    }

    content.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr>
            <th>Invoice #</th><th>Case #</th><th>Amount</th><th>Status</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.map((inv, idx) => `
              <tr>
                <td><strong>${esc(inv.invoiceNumber)}</strong></td>
                <td>${esc(inv.caseNumber ?? inv.caseId.slice(0, 8))}</td>
                <td>${usd(inv.amount)}</td>
                <td>${statusBadge(inv.status)}</td>
                <td>${esc(new Date(inv.createdAt).toLocaleDateString())}</td>
                <td style="white-space:nowrap">
                  <button class="btn btn-small btn-secondary" data-view="${idx}">View</button>
                  ${inv.status !== 'paid' ? `<button class="btn btn-small" data-pay="${idx}">Mark paid</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    content.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        const inv = rows[Number((b as HTMLElement).dataset.view)];
        openModal(container, inv, () => renderInvoices(container));
      })
    );
    content.querySelectorAll('[data-pay]').forEach((b) =>
      b.addEventListener('click', () => {
        const inv = rows[Number((b as HTMLElement).dataset.pay)];
        openModal(container, inv, () => renderInvoices(container));
        // Jump straight to paying.
        (container.querySelector('#payBtn') as HTMLButtonElement | null)?.click();
      })
    );
  };

  render();
}
