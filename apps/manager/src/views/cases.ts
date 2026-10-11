/**
 * Cases view — list, filter, detail, assign, status changes, intake.
 */
import { api } from '../api.js';

interface CaseRow {
  id: string;
  caseNumber: string;
  status: string;
  vin?: string;
  year?: number | string;
  make?: string;
  model?: string;
  asset?: { vin?: string; year?: number; make?: string; model?: string; color?: string; plate?: string } | null;
  debtor?: { name?: string } | null;
  client?: { name?: string } | null;
  lender?: { name?: string } | null;
  assignedAgent?: { id: string; name: string } | null;
  addresses?: Array<{ label?: string; street?: string; city?: string; state?: string; zip?: string }>;
  documents?: Array<{ kind: string; status: string }>;
  notes?: string;
  updatedAt?: string;
  createdAt?: string;
}

const STATUSES = [
  'intake', 'assigned', 'field_work', 'verify', 'possession', 'transport',
  'lot_storage', 'condition_report', 'delivery', 'invoicing', 'closed', 'cancelled',
];

const TABS: Array<{ label: string; match: (s: string) => boolean }> = [
  { label: 'All', match: () => true },
  { label: 'Active', match: (s) => ['intake', 'assigned', 'field_work', 'verify', 'possession', 'transport'].includes(s) },
  { label: 'In Lot', match: (s) => ['lot_storage', 'condition_report'].includes(s) },
  { label: 'Delivered', match: (s) => ['delivery', 'invoicing'].includes(s) },
  { label: 'Closed', match: (s) => ['closed', 'cancelled'].includes(s) },
];

function statusBadge(status: string): string {
  const cls = status === 'closed' || status === 'cancelled' ? 'badge-suspended'
    : ['delivery', 'invoicing'].includes(status) ? 'badge-active'
    : ['lot_storage', 'condition_report'].includes(status) ? 'badge-info'
    : 'badge-pending';
  return `<span class="badge ${cls}">${esc(status.replace(/_/g, ' '))}</span>`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function ymm(c: CaseRow): string {
  const a = c.asset ?? {};
  return [a.year ?? c.year, a.make ?? c.make, a.model ?? c.model].filter(Boolean).join(' ') || '—';
}

function vin(c: CaseRow): string {
  return c.asset?.vin ?? c.vin ?? '—';
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function fetchCases(): Promise<CaseRow[]> {
  const data = await api<{ cases: CaseRow[] }>('/cases');
  return data.cases ?? [];
}

export async function renderCases(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Cases</h1>
    <div class="tabs" id="caseTabs"></div>
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn" id="newCaseBtn">+ New case</button>
      </div>
      <div id="caseTableWrap"><p>Loading…</p></div>
    </div>`;

  const tabsEl = container.querySelector('#caseTabs') as HTMLElement;
  const wrap = container.querySelector('#caseTableWrap') as HTMLElement;
  let all: CaseRow[] = [];
  let activeTab = 0;

  try {
    all = await fetchCases();
  } catch (e: any) {
    wrap.innerHTML = `<p class="error">Failed to load cases: ${esc(e.message)}</p>`;
    return;
  }

  function drawTabs() {
    tabsEl.innerHTML = TABS.map((t, i) => {
      const n = all.filter((c) => t.match(c.status)).length;
      return `<button class="${i === activeTab ? 'active' : ''}" data-tab="${i}">${t.label} (${n})</button>`;
    }).join('');
    tabsEl.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { activeTab = Number((b as HTMLElement).dataset.tab); drawTabs(); drawTable(); })
    );
  }

  function drawTable() {
    const rows = all.filter((c) => TABS[activeTab].match(c.status));
    if (!rows.length) {
      wrap.innerHTML = '<p>No cases in this view.</p>';
      return;
    }
    wrap.innerHTML = `
      <table><thead><tr>
        <th>Case #</th><th>VIN</th><th>Unit</th><th>Debtor</th><th>Status</th><th>Agent</th><th>Updated</th>
      </tr></thead><tbody>
      ${rows.map((c) => `
        <tr data-id="${c.id}" style="cursor:pointer">
          <td><strong>${esc(c.caseNumber)}</strong></td>
          <td style="font-family:monospace;font-size:12px">${esc(vin(c))}</td>
          <td>${esc(ymm(c))}</td>
          <td>${esc(c.debtor?.name ?? '—')}</td>
          <td>${statusBadge(c.status)}</td>
          <td>${esc(c.assignedAgent?.name ?? '—')}</td>
          <td>${esc(fmtDate(c.updatedAt))}</td>
        </tr>`).join('')}
      </tbody></table>`;
    wrap.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => renderCaseDetail(container, (tr as HTMLElement).dataset.id!, () => renderCases(container)))
    );
  }

  (container.querySelector('#newCaseBtn') as HTMLElement).addEventListener('click', () =>
    openIntakeModal(container, async () => { all = await fetchCases(); drawTabs(); drawTable(); })
  );

  drawTabs();
  drawTable();
}

async function renderCaseDetail(container: HTMLElement, id: string, onBack: () => void): Promise<void> {
  container.innerHTML = `<p>Loading case…</p>`;
  let c: CaseRow;
  try {
    const data = await api<{ case: CaseRow }>(`/cases/${id}`);
    c = data.case;
  } catch (e: any) {
    container.innerHTML = `<p class="error">Failed to load case: ${esc(e.message)}</p><button class="btn btn-secondary" id="backBtn">Back</button>`;
    (container.querySelector('#backBtn') as HTMLElement).addEventListener('click', onBack);
    return;
  }

  const a = c.asset ?? {};
  const addr = (c.addresses ?? []).map((x) =>
    [x.label, x.street, x.city, x.state, x.zip].filter(Boolean).join(', ')
  );

  container.innerHTML = `
    <button class="btn btn-secondary btn-small" id="backBtn">← All cases</button>
    <h1 class="page-title" style="margin-top:12px">${esc(c.caseNumber)} ${statusBadge(c.status)}</h1>
    <div class="card">
      <div class="stats">
        <div class="stat"><div>VIN</div><strong style="font-family:monospace">${esc(vin(c))}</strong></div>
        <div class="stat"><div>Unit</div><strong>${esc(ymm(c))}</strong></div>
        <div class="stat"><div>Color</div><strong>${esc(a.color ?? '—')}</strong></div>
        <div class="stat"><div>Plate</div><strong>${esc(a.plate ?? '—')}</strong></div>
      </div>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><div>Debtor</div><strong>${esc(c.debtor?.name ?? '—')}</strong></div>
        <div class="stat"><div>Client</div><strong>${esc(c.client?.name ?? '—')}</strong></div>
        <div class="stat"><div>Lender</div><strong>${esc(c.lender?.name ?? '—')}</strong></div>
        <div class="stat"><div>Agent</div><strong>${esc(c.assignedAgent?.name ?? 'Unassigned')}</strong></div>
      </div>
      ${addr.length ? `<p style="margin-top:12px"><strong>Addresses:</strong><br>${addr.map(esc).join('<br>')}</p>` : ''}
      ${c.notes ? `<p><strong>Notes:</strong> ${esc(c.notes)}</p>` : ''}
      ${(c.documents ?? []).length ? `
        <p><strong>Documents:</strong></p>
        <table><thead><tr><th>Kind</th><th>Status</th></tr></thead><tbody>
        ${(c.documents ?? []).map((d) => `<tr><td>${esc(d.kind.replace(/_/g, ' '))}</td><td>${statusBadge(d.status)}</td></tr>`).join('')}
        </tbody></table>` : ''}
    </div>
    <div class="card">
      <h3>Assign agent</h3>
      <div class="form-row">
        <div class="form-group"><select id="agentSel"><option>Loading agents…</option></select></div>
        <div class="form-group"><button class="btn" id="assignBtn">Assign</button></div>
      </div>
      <div id="assignMsg"></div>
    </div>
    <div class="card">
      <h3>Change status</h3>
      <div class="form-row">
        <div class="form-group"><select id="statusSel">${STATUSES.map((s) =>
          `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select></div>
        <div class="form-group"><input id="statusNote" placeholder="Note (optional)" style="width:100%"></div>
        <div class="form-group"><button class="btn" id="statusBtn">Update</button></div>
      </div>
      <div id="statusMsg"></div>
    </div>`;

  (container.querySelector('#backBtn') as HTMLElement).addEventListener('click', onBack);

  // Agents dropdown
  const agentSel = container.querySelector('#agentSel') as HTMLSelectElement;
  const assignMsg = container.querySelector('#assignMsg') as HTMLElement;
  try {
    const data = await api<{ users: Array<{ id: string; name: string; role: string | { name: string }; status: string }> }>('/admin/users');
    const agents = (data.users ?? []).filter((u) => {
      const role = typeof u.role === 'string' ? u.role : u.role?.name;
      return role === 'agent' && u.status === 'active';
    });
    agentSel.innerHTML = agents.length
      ? agents.map((u) => `<option value="${u.id}" ${c.assignedAgent?.id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')
      : '<option value="">No active agents</option>';
  } catch {
    agentSel.innerHTML = '<option value="">Could not load agents</option>';
  }

  (container.querySelector('#assignBtn') as HTMLElement).addEventListener('click', async () => {
    const agentId = agentSel.value;
    if (!agentId) { assignMsg.innerHTML = '<p class="error">Select an agent.</p>'; return; }
    assignMsg.innerHTML = '<p>Assigning…</p>';
    try {
      await api(`/cases/${id}/assign`, { method: 'POST', body: JSON.stringify({ agentId }) });
      assignMsg.innerHTML = '<p class="success">Assigned.</p>';
      setTimeout(() => renderCaseDetail(container, id, onBack), 600);
    } catch (e: any) {
      assignMsg.innerHTML = `<p class="error">Assign failed: ${esc(e.message)}</p>`;
    }
  });

  // Status change
  const statusMsg = container.querySelector('#statusMsg') as HTMLElement;
  (container.querySelector('#statusBtn') as HTMLElement).addEventListener('click', async () => {
    const to = (container.querySelector('#statusSel') as HTMLSelectElement).value;
    const note = (container.querySelector('#statusNote') as HTMLInputElement).value.trim();
    statusMsg.innerHTML = '<p>Updating…</p>';
    try {
      await api(`/cases/${id}/status`, { method: 'POST', body: JSON.stringify({ to, note: note || undefined }) });
      statusMsg.innerHTML = '<p class="success">Status updated.</p>';
      setTimeout(() => renderCaseDetail(container, id, onBack), 600);
    } catch (e: any) {
      statusMsg.innerHTML = `<p class="error">Update failed: ${esc(e.message)}</p>`;
    }
  });
}

function openIntakeModal(container: HTMLElement, onDone: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>New case</h2>
      <div class="form-group"><label>VIN *</label><input id="fVin" maxlength="17" style="font-family:monospace"></div>
      <div class="form-row">
        <div class="form-group"><label>Year</label><input id="fYear" inputmode="numeric"></div>
        <div class="form-group"><label>Make</label><input id="fMake"></div>
        <div class="form-group"><label>Model</label><input id="fModel"></div>
      </div>
      <div class="form-group"><label>Debtor name *</label><input id="fDebtor"></div>
      <div class="form-group"><label>Client name</label><input id="fClient"></div>
      <div class="form-group"><label>Notes</label><input id="fNotes"></div>
      <div id="intakeErr"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="intakeCancel">Cancel</button>
        <button class="btn" id="intakeSave">Create case</button>
      </div>
    </div>`;
  container.appendChild(overlay);
  const q = (id: string) => (overlay.querySelector(id) as HTMLInputElement).value.trim();
  (overlay.querySelector('#intakeCancel') as HTMLElement).addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  (overlay.querySelector('#intakeSave') as HTMLElement).addEventListener('click', async () => {
    const errEl = overlay.querySelector('#intakeErr') as HTMLElement;
    const vinVal = q('#fVin');
    const debtorName = q('#fDebtor');
    if (!vinVal || !debtorName) { errEl.innerHTML = '<p class="error">VIN and debtor name are required.</p>'; return; }
    const payload: Record<string, unknown> = {
      source: 'manual',
      debtor: { name: debtorName },
      asset: {
        vin: vinVal.toUpperCase(),
        ...(q('#fYear') ? { year: Number(q('#fYear')) } : {}),
        ...(q('#fMake') ? { make: q('#fMake') } : {}),
        ...(q('#fModel') ? { model: q('#fModel') } : {}),
      },
      ...(q('#fClient') ? { client: { name: q('#fClient') } } : {}),
      ...(q('#fNotes') ? { notes: q('#fNotes') } : {}),
    };
    errEl.innerHTML = '<p>Creating…</p>';
    try {
      await api('/cases/intake', { method: 'POST', body: JSON.stringify(payload) });
      overlay.remove();
      onDone();
    } catch (e: any) {
      errEl.innerHTML = `<p class="error">Create failed: ${esc(e.message)}</p>`;
    }
  });
}
