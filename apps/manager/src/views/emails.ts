/**
 * Client Emails view — drafts awaiting approval, templates reference.
 */
import { api } from '../api.js';

interface Draft {
  id: string;
  caseId: string;
  caseNumber: string;
  templateKey: string;
  to: string;
  subject: string;
  body: string;
  status: string;
  createdByName?: string | null;
  approvedByName?: string | null;
  rejectionNote?: string | null;
  createdAt?: string;
  sentAt?: string | null;
}

interface Template {
  id: string;
  key: string;
  name: string;
  subject: string;
  body: string;
}

const TABS = ['Pending', 'Approved', 'Sent'] as const;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function matchTab(d: Draft, tab: (typeof TABS)[number]): boolean {
  if (tab === 'Pending') return d.status === 'pending_approval';
  if (tab === 'Approved') return d.status === 'approved';
  return d.status === 'sent';
}

export async function renderEmails(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Client Emails</h1>
    <p class="page-sub">Drafts awaiting approval</p>
    <div class="tabs" id="emailTabs"></div>
    <div class="card"><div id="draftWrap"><p>Loading…</p></div></div>
    <div class="card" style="margin-top:16px"><h3>Templates</h3><div id="tplWrap"><p>Loading…</p></div></div>`;

  const tabsEl = container.querySelector('#emailTabs') as HTMLElement;
  const wrap = container.querySelector('#draftWrap') as HTMLElement;
  const tplWrap = container.querySelector('#tplWrap') as HTMLElement;
  let all: Draft[] = [];
  let activeTab: (typeof TABS)[number] = 'Pending';

  // Aggregate drafts across cases (no global drafts endpoint).
  try {
    const casesData = await api<{ cases: Array<{ id: string; caseNumber: string }> }>('/cases');
    const cases = casesData.cases ?? [];
    const perCase = await Promise.all(
      cases.map(async (c) => {
        try {
          const d = await api<{ drafts: Draft[] }>(`/cases/${c.id}/email/drafts`);
          return (d.drafts ?? []).map((x) => ({ ...x, caseId: c.id, caseNumber: c.caseNumber }));
        } catch {
          return [] as Draft[];
        }
      })
    );
    all = perCase.flat().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  } catch (e: any) {
    wrap.innerHTML = `<p class="error">Failed to load drafts: ${esc(e.message)}</p>`;
  }

  // Templates (read-only reference).
  try {
    const t = await api<{ templates: Template[] }>('/email/templates');
    const list = t.templates ?? [];
    tplWrap.innerHTML = list.length
      ? `<table><thead><tr><th>Name</th><th>Subject</th><th></th></tr></thead><tbody>
        ${list.map((x, i) => `<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(x.subject)}</td>
          <td><button class="btn btn-small btn-secondary" data-tpl="${i}">View</button></td></tr>`).join('')}
        </tbody></table>`
      : '<p>No templates found.</p>';
    tplWrap.querySelectorAll('[data-tpl]').forEach((b) =>
      b.addEventListener('click', () => previewTemplate(container, list[Number((b as HTMLElement).dataset.tpl)]))
    );
  } catch {
    tplWrap.innerHTML = '<p class="error">Templates not available.</p>';
  }

  function drawTabs() {
    tabsEl.innerHTML = TABS.map((t) => {
      const n = all.filter((d) => matchTab(d, t)).length;
      return `<button class="${t === activeTab ? 'active' : ''}" data-tab="${t}">${t} (${n})</button>`;
    }).join('');
    tabsEl.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { activeTab = (b as HTMLElement).dataset.tab as (typeof TABS)[number]; drawTabs(); drawTable(); })
    );
  }

  function drawTable() {
    const rows = all.filter((d) => matchTab(d, activeTab));
    if (!rows.length) {
      wrap.innerHTML = '<p>Nothing here.</p>';
      return;
    }
    wrap.innerHTML = `
      <table><thead><tr>
        <th>Case #</th><th>To</th><th>Subject</th><th>Drafted by</th><th>Created</th><th></th>
      </tr></thead><tbody>
      ${rows.map((d, i) => `
        <tr>
          <td><strong>${esc(d.caseNumber)}</strong></td>
          <td>${esc(d.to)}</td>
          <td>${esc(d.subject)}</td>
          <td>${esc(d.createdByName ?? '—')}</td>
          <td>${esc(fmtDate(d.createdAt))}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-small btn-secondary" data-pv="${i}">Preview</button>
            ${activeTab === 'Pending' ? `<button class="btn btn-small" data-ap="${i}">Approve</button>
            <button class="btn btn-small btn-danger" data-rj="${i}">Reject</button>` : ''}
            ${activeTab === 'Approved' ? `<button class="btn btn-small" data-send="${i}">Send</button>` : ''}
          </td>
        </tr>`).join('')}
      </tbody></table>
      ${activeTab === 'Sent' ? '<p class="page-sub">Note: sending is recorded only until SMTP is configured.</p>' : ''}`;

    wrap.querySelectorAll('[data-pv]').forEach((b) =>
      b.addEventListener('click', () => previewDraft(container, rows[Number((b as HTMLElement).dataset.pv)]))
    );
    wrap.querySelectorAll('[data-ap]').forEach((b) =>
      b.addEventListener('click', async () => {
        const d = rows[Number((b as HTMLElement).dataset.ap)];
        if (!confirm(`Approve email "${d.subject}" to ${d.to}?`)) return;
        try {
          await api(`/cases/${d.caseId}/email/drafts/${d.id}/approve`, { method: 'POST' });
          await reload();
        } catch (e: any) { alert(`Approve failed: ${e.message}`); }
      })
    );
    wrap.querySelectorAll('[data-rj]').forEach((b) =>
      b.addEventListener('click', async () => {
        const d = rows[Number((b as HTMLElement).dataset.rj)];
        const note = prompt(`Reject email "${d.subject}".\nReason (required):`);
        if (!note || !note.trim()) return;
        try {
          await api(`/cases/${d.caseId}/email/drafts/${d.id}/reject`, {
            method: 'POST', body: JSON.stringify({ note: note.trim() }),
          });
          await reload();
        } catch (e: any) { alert(`Reject failed: ${e.message}`); }
      })
    );
    wrap.querySelectorAll('[data-send]').forEach((b) =>
      b.addEventListener('click', async () => {
        const d = rows[Number((b as HTMLElement).dataset.send)];
        if (!confirm(`Record "${d.subject}" as sent to ${d.to}?\n(No SMTP yet — this logs it as sent.)`)) return;
        try {
          await api(`/cases/${d.caseId}/email/drafts/${d.id}/send`, { method: 'POST' });
          await reload();
        } catch (e: any) { alert(`Send failed: ${e.message}`); }
      })
    );
  }

  async function reload() {
    await renderEmails(container);
  }

  drawTabs();
  drawTable();
}

function previewDraft(container: HTMLElement, d: Draft): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px">
      <h2>${esc(d.subject)}</h2>
      <p class="page-sub">To: ${esc(d.to)} · Case ${esc(d.caseNumber)} · ${esc(d.status)}</p>
      <div class="card"><pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(d.body)}</pre></div>
      ${d.rejectionNote ? `<p class="error"><strong>Rejection note:</strong> ${esc(d.rejectionNote)}</p>` : ''}
      <div class="modal-actions"><button class="btn btn-secondary" id="emClose">Close</button></div>
    </div>`;
  container.appendChild(overlay);
  (overlay.querySelector('#emClose') as HTMLElement).addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function previewTemplate(container: HTMLElement, t: Template): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px">
      <h2>${esc(t.name)}</h2>
      <p class="page-sub">Key: <code>${esc(t.key)}</code></p>
      <div class="form-group"><label>Subject</label><p>${esc(t.subject)}</p></div>
      <div class="form-group"><label>Body</label><div class="card"><pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(t.body)}</pre></div></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="tplClose">Close</button></div>
    </div>`;
  container.appendChild(overlay);
  (overlay.querySelector('#tplClose') as HTMLElement).addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
