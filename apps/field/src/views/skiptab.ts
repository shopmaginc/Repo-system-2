import {
  api,
  ApiError,
  type ClientContactRecord,
  type CrossRefHit,
  type EmailDraftRecord,
  type EmailTemplateRecord,
  type MeUser,
  type SkipPullRecord,
  type SkipWorksheet,
} from '../api.js';
import { esc, notice } from '../ui.js';

/**
 * "Skip" and "Email" sections for the case card.
 *
 * 🔎 Skip: one-tap internal cross-reference (tap a hit to open that case),
 * a structured skip-worksheet editor, and deep-pull requests with status.
 *
 * ✉️ Email: template picker → draft → preview → submit for approval.
 * Managers see approve / reject / send. Sending is manager-only and only
 * from approved drafts. Desktop-friendly: the same app in a browser is the
 * office interface.
 */

const PULL_PROVIDERS: Array<[string, string]> = [
  ['infotracer', 'InfoTracer'],
  ['beenverified', 'BeenVerified'],
  ['opencorporates', 'OpenCorporates'],
];

const STATUS_PILL: Record<string, string> = {
  draft: 'pill',
  pending_approval: 'pill',
  approved: 'pill',
  sent: 'pill',
  rejected: 'pill',
  requested: 'pill',
  complete: 'pill',
};

const emptyWorksheet = (): SkipWorksheet => ({
  knownAddresses: [],
  phones: [],
  associates: [],
  vehicles: [],
  notes: '',
});

const linesOf = (rows: Array<Record<string, string | undefined>>, fields: string[]): string =>
  rows.map((r) => fields.map((f) => r[f] ?? '').join(' | ')).join('\n');

/** Parse "a | b | c" textarea lines; rows missing every required field are dropped. */
const parseLines = (text: string, fields: string[], required: string | string[]): Array<Record<string, string>> => {
  const req = Array.isArray(required) ? required : [required];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split('|').map((p) => p.trim());
      const obj: Record<string, string> = {};
      fields.forEach((f, i) => {
        if (parts[i]) obj[f] = parts[i];
      });
      return obj;
    })
    .filter((o) => req.some((f) => o[f]));
};

export async function renderSkipEmail(
  root: HTMLElement,
  caseId: string,
  clientId: string | null,
): Promise<void> {
  const cid = encodeURIComponent(caseId);
  let me: MeUser | null = null;
  try {
    me = (await api.get<{ user: MeUser }>('/auth/me')).user;
  } catch {
    root.innerHTML = notice('Could not load your permissions.', 'bad');
    return;
  }
  const role = me.role;
  const isManager = role === 'manager';
  const canCompletePull = isManager || role === 'office_clerk';
  const canResearch = isManager || role === 'agent' || role === 'office_clerk';

  const say = (t: string, k: 'bad' | 'good' | '' = '') => {
    const el = root.querySelector<HTMLElement>('#se-msg');
    if (el) el.innerHTML = notice(t, k);
  };

  if (!canResearch) {
    root.innerHTML = `
      <div class="card"><h3>🔎 Skip</h3>
        <div class="center">Skip research is available to agents, clerks, and managers.</div></div>
      <div class="card"><h3>✉️ Email</h3>
        <div class="center">Client email is available to agents, clerks, and managers.</div></div>`;
    return;
  }

  root.innerHTML = `
    <div id="se-msg"></div>
    <div class="card"><h3>🔎 Skip</h3>
      <button class="btn secondary" id="se-crossref" style="width:100%">Run cross-reference</button>
      <div id="se-hits" style="margin-top:8px"></div>
      <div id="se-ws"><div class="center">Loading worksheet…</div></div>
      <div id="se-pulls"><div class="center">Loading pulls…</div></div>
      <div class="btnrow">
        <select id="se-provider" style="flex:1">${PULL_PROVIDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <button class="btn secondary" id="se-pullgo">Request deep pull</button>
      </div>
    </div>
    <div class="card"><h3>✉️ Email</h3>
      <div id="se-email"><div class="center">Loading…</div></div>
    </div>`;

  // ---------------------------------------------------------------
  // Cross-reference
  // ---------------------------------------------------------------
  const hitsEl = root.querySelector<HTMLElement>('#se-hits')!;
  root.querySelector('#se-crossref')!.addEventListener('click', async () => {
    hitsEl.innerHTML = '<div class="center">Searching company history…</div>';
    try {
      const { hits } = await api.get<{ hits: CrossRefHit[] }>(`/cases/${cid}/skip/crossref`);
      if (!hits.length) {
        hitsEl.innerHTML = '<div class="center">No matches in company history.</div>';
        return;
      }
      hitsEl.innerHTML = hits
        .map(
          (h) => `<a href="#/card/${encodeURIComponent(h.caseId)}" class="hitrow">
            <strong>${esc(h.caseNumber)}</strong>
            <span class="pill">${esc(h.status.replace(/_/g, ' '))}</span>
            <div class="muted">${esc(h.matchedOn.join(', '))}</div>
          </a>`,
        )
        .join('');
    } catch (e) {
      hitsEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Search failed', 'bad');
    }
  });

  // ---------------------------------------------------------------
  // Worksheet
  // ---------------------------------------------------------------
  const wsEl = root.querySelector<HTMLElement>('#se-ws')!;
  let ws: SkipWorksheet = emptyWorksheet();
  try {
    ws = (await api.get<{ worksheet: SkipWorksheet }>(`/cases/${cid}/skip/worksheet`)).worksheet;
  } catch (e) {
    wsEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Worksheet failed to load', 'bad');
  }
  wsEl.innerHTML = `
    <label class="f">Known addresses <span class="muted">(street | city | state | zip — one per line)</span>
      <textarea id="se-w-addr" rows="3">${esc(linesOf(ws.knownAddresses, ['street', 'city', 'state', 'zip']))}</textarea></label>
    <label class="f">Phones <span class="muted">(number | source)</span>
      <textarea id="se-w-ph" rows="2">${esc(linesOf(ws.phones, ['number', 'source']))}</textarea></label>
    <label class="f">Associates <span class="muted">(name | relation | notes)</span>
      <textarea id="se-w-as" rows="2">${esc(linesOf(ws.associates, ['name', 'relation', 'notes']))}</textarea></label>
    <label class="f">Vehicles <span class="muted">(vin | plate | description)</span>
      <textarea id="se-w-ve" rows="2">${esc(linesOf(ws.vehicles, ['vin', 'plate', 'description']))}</textarea></label>
    <label class="f">Notes
      <textarea id="se-w-no" rows="3">${esc(ws.notes)}</textarea></label>
    <button class="btn secondary" id="se-wsave" style="width:100%">💾 Save worksheet</button>`;

  wsEl.querySelector('#se-wsave')!.addEventListener('click', async () => {
    const val = (id: string) => (wsEl.querySelector<HTMLTextAreaElement>(id)?.value ?? '');
    const payload: SkipWorksheet = {
      knownAddresses: parseLines(val('#se-w-addr'), ['street', 'city', 'state', 'zip'], 'street') as SkipWorksheet['knownAddresses'],
      phones: parseLines(val('#se-w-ph'), ['number', 'source'], 'number') as SkipWorksheet['phones'],
      associates: parseLines(val('#se-w-as'), ['name', 'relation', 'notes'], 'name') as SkipWorksheet['associates'],
      vehicles: parseLines(val('#se-w-ve'), ['vin', 'plate', 'description'], ['vin', 'plate', 'description']) as SkipWorksheet['vehicles'],
      notes: val('#se-w-no').trim(),
    };
    try {
      await api.put(`/cases/${cid}/skip/worksheet`, payload);
      say('Worksheet saved.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Save failed', 'bad');
    }
  });

  // ---------------------------------------------------------------
  // Deep pulls
  // ---------------------------------------------------------------
  const pullsEl = root.querySelector<HTMLElement>('#se-pulls')!;
  const loadPulls = async () => {
    try {
      const { pulls } = await api.get<{ pulls: SkipPullRecord[] }>(`/cases/${cid}/skip/pulls`);
      pullsEl.innerHTML = pulls.length
        ? pulls
            .map(
              (p) => `<div class="pullrow">
                <strong>${esc(p.provider)}</strong>
                <span class="${STATUS_PILL[p.status] ?? 'pill'}">${esc(p.status.replace(/_/g, ' '))}</span>
                ${p.summary ? `<div class="muted">${esc(p.summary.slice(0, 200))}</div>` : ''}
                ${canCompletePull && p.status === 'requested' ? `<button class="btn secondary" data-complete="${esc(p.id)}">Mark complete</button>` : ''}
              </div>`,
            )
            .join('')
        : '<div class="center">No deep pulls requested.</div>';
      pullsEl.querySelectorAll('[data-complete]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const summary = prompt('Pull summary (key findings):');
          if (!summary || !summary.trim()) return;
          try {
            await api.post(`/cases/${cid}/skip/pulls/${encodeURIComponent(btn.getAttribute('data-complete')!)}/complete`, {
              summary: summary.trim(),
            });
            say('Pull marked complete.', 'good');
            await loadPulls();
          } catch (e) {
            say(e instanceof ApiError ? e.message : 'Complete failed', 'bad');
          }
        }),
      );
    } catch (e) {
      pullsEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Pulls failed to load', 'bad');
    }
  };
  await loadPulls();

  root.querySelector('#se-pullgo')!.addEventListener('click', async () => {
    const provider = root.querySelector<HTMLSelectElement>('#se-provider')!.value;
    try {
      await api.post(`/cases/${cid}/skip/pulls`, { provider });
      say('Deep pull requested — a manager task was raised.', 'good');
      await loadPulls();
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Request failed', 'bad');
    }
  });

  // ---------------------------------------------------------------
  // Email
  // ---------------------------------------------------------------
  const emailEl = root.querySelector<HTMLElement>('#se-email')!;
  let templates: EmailTemplateRecord[] = [];
  let contacts: ClientContactRecord[] = [];
  try {
    templates = (await api.get<{ templates: EmailTemplateRecord[] }>('/email/templates')).templates;
    if (clientId) {
      contacts = (
        await api.get<{ contacts: ClientContactRecord[] }>(
          `/clients/${encodeURIComponent(clientId)}/contacts`,
        )
      ).contacts;
    }
  } catch (e) {
    emailEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Email failed to load', 'bad');
    return;
  }

  const contactOpts = contacts
    .filter((c) => c.email)
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(c.email ?? '')}</option>`)
    .join('');

  emailEl.innerHTML = `
    <label class="f">Template
      <select id="se-tpl">${templates.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join('')}</select></label>
    ${contactOpts ? `<label class="f">To (client contact)<select id="se-tocontact">${contactOpts}</select></label>` : ''}
    <label class="f">…or manual recipient
      <input id="se-tomanual" type="email" autocomplete="off" placeholder="name@client.com"></label>
    <button class="btn secondary" id="se-newdraft" style="width:100%">✉️ Create draft</button>
    <div id="se-drafts" style="margin-top:12px"><div class="center">Loading drafts…</div></div>`;

  const draftsEl = emailEl.querySelector<HTMLElement>('#se-drafts')!;
  const loadDrafts = async () => {
    try {
      const { drafts } = await api.get<{ drafts: EmailDraftRecord[] }>(`/cases/${cid}/email/drafts`);
      draftsEl.innerHTML = drafts.length
        ? drafts
            .map(
              (d) => `<div class="pullrow">
                <strong>${esc(d.subject)}</strong>
                <span class="${STATUS_PILL[d.status] ?? 'pill'}">${esc(d.status.replace(/_/g, ' '))}</span>
                <div class="muted">To: ${esc(d.to)}${d.rejectionNote ? ` · Rejected: ${esc(d.rejectionNote)}` : ''}</div>
                <details><summary>Preview</summary>
                  <div class="pre">${esc(d.body)}</div>
                </details>
                <div class="btnrow" style="margin-top:6px">
                  ${['draft', 'rejected'].includes(d.status) ? `<button class="btn secondary" data-act="submit" data-id="${esc(d.id)}">Submit for approval</button>` : ''}
                  ${isManager && d.status === 'pending_approval' ? `<button class="btn good" data-act="approve" data-id="${esc(d.id)}">Approve</button>` : ''}
                  ${isManager && ['draft', 'pending_approval'].includes(d.status) ? `<button class="btn secondary" data-act="reject" data-id="${esc(d.id)}">Reject</button>` : ''}
                  ${isManager && d.status === 'approved' ? `<button class="btn good" data-act="send" data-id="${esc(d.id)}">Send</button>` : ''}
                </div>
              </div>`,
            )
            .join('')
        : '<div class="center">No drafts yet.</div>';
      draftsEl.querySelectorAll('[data-act]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const act = btn.getAttribute('data-act')!;
          const draftId = btn.getAttribute('data-id')!;
          try {
            if (act === 'reject') {
              const note = prompt('Rejection note (required):');
              if (!note || !note.trim()) return;
              await api.post(`/cases/${cid}/email/drafts/${encodeURIComponent(draftId)}/reject`, { note: note.trim() });
            } else {
              if (act === 'send' && !confirm('Send this email to the client?')) return;
              await api.post(`/cases/${cid}/email/drafts/${encodeURIComponent(draftId)}/${act}`);
            }
            say(`Draft ${act === 'send' ? 'sent' : act + 'd'}.`, 'good');
            await loadDrafts();
          } catch (e) {
            say(e instanceof ApiError ? e.message : 'Action failed', 'bad');
          }
        }),
      );
    } catch (e) {
      draftsEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Drafts failed to load', 'bad');
    }
  };
  await loadDrafts();

  emailEl.querySelector('#se-newdraft')!.addEventListener('click', async () => {
    const templateKey = emailEl.querySelector<HTMLSelectElement>('#se-tpl')!.value;
    const toContactId = emailEl.querySelector<HTMLSelectElement>('#se-tocontact')?.value;
    const manual = emailEl.querySelector<HTMLInputElement>('#se-tomanual')!.value.trim();
    try {
      await api.post(`/cases/${cid}/email/drafts`, {
        templateKey,
        ...(toContactId && !manual ? { toContactId } : {}),
        ...(manual ? { to: manual } : {}),
      });
      say('Draft created — review the preview, then submit for approval.', 'good');
      await loadDrafts();
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Draft failed', 'bad');
    }
  });
}
