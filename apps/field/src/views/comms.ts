import {
  api,
  postForm,
  ApiError,
  getApiBase,
  type ConversationRecord,
  type DirectoryContactRecord,
  type MeUser,
  type MessageRecord,
  type TimeOffRecord,
  type WeeklyReport,
} from '../api.js';
import { esc, topbar, tabbar, notice, wireNav } from '../ui.js';

/**
 * "💬 Comms" — the company runs a day from here.
 *
 * 💬 Messages: direct + company-wide threads, text + photo/video attach.
 * 📇 Directory: the shared searchable company contact directory.
 * 🗓️ Time off: request time off, see your requests; managers approve.
 * Managers also get the weekly numbers here.
 */

type Tab = 'chat' | 'directory' | 'timeoff';

const todayISO = () => new Date().toISOString().slice(0, 10);

export async function renderComms(root: HTMLElement, tab: Tab = 'chat', arg = ''): Promise<void> {
  root.innerHTML = `<div class="screen">
    ${topbar('Comms')}
    <div class="subtabs">
      <a href="#/comms/chat" class="${tab === 'chat' ? 'active' : ''}">💬 Messages</a>
      <a href="#/comms/directory" class="${tab === 'directory' ? 'active' : ''}">📇 Directory</a>
      <a href="#/comms/timeoff" class="${tab === 'timeoff' ? 'active' : ''}">🗓️ Time off</a>
    </div>
    <div class="body" id="body"><div class="center">Loading…</div></div>
    ${tabbar('comms')}
  </div>`;
  wireNav(root);
  const body = root.querySelector<HTMLElement>('#body')!;

  let me: MeUser;
  try {
    me = (await api.get<{ user: MeUser }>('/auth/me')).user;
  } catch (e) {
    body.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load profile', 'bad');
    return;
  }
  const isManager = me.role === 'manager';

  try {
    if (tab === 'chat') await renderChatList(body, arg);
    else if (tab === 'directory') await renderDirectory(body, isManager);
    else await renderTimeOff(body, isManager, me);
  } catch (e) {
    console.error(e);
    body.innerHTML = notice('Could not load this tab.', 'bad');
  }
  wireNav(body);
}

// ------------------------------------------------------------------
// 💬 Messages
// ------------------------------------------------------------------

async function renderChatList(body: HTMLElement, arg: string): Promise<void> {
  if (arg) {
    await renderThread(body, decodeURIComponent(arg));
    return;
  }
  const { conversations } = await api.get<{ conversations: ConversationRecord[] }>('/conversations');
  const items = conversations
    .map(
      (c) => `<button class="rowlink" data-thread="${esc(c.id)}">
        <span class="ico">${c.kind === 'company_wide' ? '📢' : '💬'}</span>
        <span>${esc(c.title || (c.kind === 'company_wide' ? 'Company wide' : 'Direct'))}
          <small>${c.memberCount} member${c.memberCount === 1 ? '' : 's'}${c.lastMessagePreview ? ' · ' + esc(c.lastMessagePreview) : ''}</small></span>
      </button>`,
    )
    .join('');
  body.innerHTML = `
    <div id="chat-msg"></div>
    ${items || `<div class="center">No conversations yet.</div>`}
    <div class="card"><h3>New direct message</h3>
      <p style="color:var(--muted);font-size:.85rem">Enter the other person's user id (ask a manager for the directory of user ids).</p>
      <input id="dm-user" placeholder="User id" autocomplete="off" />
      <input id="dm-title" placeholder="Title (optional)" autocomplete="off" />
      <button class="primary" id="dm-start">Start conversation</button>
    </div>`;
  const say = (t: string, k: 'bad' | 'good' | '' = '') => {
    body.querySelector('#chat-msg')!.innerHTML = notice(t, k);
  };
  body.querySelectorAll<HTMLElement>('[data-thread]').forEach((el) =>
    el.addEventListener('click', () => {
      location.hash = `#/comms/chat/${encodeURIComponent(el.dataset.thread!)}`;
    }),
  );
  body.querySelector('#dm-start')!.addEventListener('click', async () => {
    const memberId = (body.querySelector('#dm-user') as HTMLInputElement).value.trim();
    const title = (body.querySelector('#dm-title') as HTMLInputElement).value.trim();
    if (!memberId) {
      say('Enter a user id first.', 'bad');
      return;
    }
    try {
      const res = await api.post<{ conversation: ConversationRecord }>('/conversations', {
        kind: 'direct',
        memberIds: [memberId],
        title: title || undefined,
      });
      location.hash = `#/comms/chat/${encodeURIComponent(res.conversation.id)}`;
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Could not start the conversation.', 'bad');
    }
  });
}

async function renderThread(body: HTMLElement, convId: string): Promise<void> {
  body.innerHTML = `
    <button class="back" data-nav="#/comms/chat">‹ All messages</button>
    <div id="thread"><div class="center">Loading…</div></div>
    <div class="composer">
      <div id="attach-preview"></div>
      <div class="composer-row">
        <input id="msg-body" placeholder="Message…" autocomplete="off" />
        <label class="attach-btn" title="Attach photo/video">📎<input id="msg-file" type="file" accept="image/*,video/*,.pdf" hidden /></label>
        <button class="primary" id="msg-send">Send</button>
      </div>
      <div id="msg-err"></div>
    </div>`;
  const thread = body.querySelector<HTMLElement>('#thread')!;
  const errEl = body.querySelector<HTMLElement>('#msg-err')!;
  const preview = body.querySelector<HTMLElement>('#attach-preview')!;
  let attachments: Array<{ ref: string; name?: string; mimeType?: string }> = [];

  const load = async (before?: string) => {
    const q = before ? `?limit=30&before=${encodeURIComponent(before)}` : '?limit=30';
    const res = await api.get<{ messages: MessageRecord[]; nextBefore: string | null }>(
      `/conversations/${encodeURIComponent(convId)}/messages${q}`,
    );
    const html = res.messages
      .slice()
      .reverse()
      .map((m) => {
        const atts = (m.attachmentRefs ?? [])
          .map(
            (a) =>
              `<a class="att" href="${esc(getApiBase())}/uploads/${esc(a.ref)}" target="_blank" rel="noopener">📎 ${esc(a.name || a.ref)}</a>`,
          )
          .join('');
        return `<div class="msg"><div class="msg-head">${esc(m.senderName)}${m.senderRole ? ` · ${esc(m.senderRole)}` : ''}</div>
          <div class="msg-body">${esc(m.body)}</div>${atts ? `<div class="msg-atts">${atts}</div>` : ''}</div>`;
      })
      .join('');
    thread.innerHTML =
      (res.nextBefore
        ? `<button class="rowlink" id="older" data-before="${esc(res.nextBefore)}"><span>↑ Older messages</span></button>`
        : '') + (html || `<div class="center">No messages yet — say hello.</div>`);
    thread.querySelector('#older')?.addEventListener('click', async (e) => {
      const b = (e.currentTarget as HTMLElement).dataset.before!;
      const older = await api.get<{ messages: MessageRecord[]; nextBefore: string | null }>(
        `/conversations/${encodeURIComponent(convId)}/messages?limit=30&before=${encodeURIComponent(b)}`,
      );
      const more = older.messages
        .slice()
        .reverse()
        .map((m) => `<div class="msg"><div class="msg-head">${esc(m.senderName)}</div><div class="msg-body">${esc(m.body)}</div></div>`)
        .join('');
      const btn = thread.querySelector('#older')!;
      btn.insertAdjacentHTML('afterend', more);
      if (older.nextBefore) btn.setAttribute('data-before', older.nextBefore);
      else btn.remove();
    });
  };

  try {
    await load();
  } catch (e) {
    thread.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load messages.', 'bad');
    return;
  }

  (body.querySelector('#msg-file') as HTMLInputElement).addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    errEl.innerHTML = '';
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await postForm<{ upload: { ref: string; mimeType: string } }>('/uploads', form);
      attachments.push({ ref: res.upload.ref, name: file.name, mimeType: res.upload.mimeType });
      preview.innerHTML = attachments.map((a) => `<span class="att">📎 ${esc(a.name || a.ref)}</span>`).join(' ');
    } catch (err) {
      errEl.innerHTML = notice(err instanceof ApiError ? err.message : 'Upload failed.', 'bad');
    }
  });

  const send = async () => {
    const input = body.querySelector('#msg-body') as HTMLInputElement;
    const text = input.value.trim();
    if (!text && attachments.length === 0) return;
    errEl.innerHTML = '';
    try {
      await api.post(`/conversations/${encodeURIComponent(convId)}/messages`, {
        body: text || '(attachment)',
        attachmentRefs: attachments.length ? attachments : undefined,
      });
      input.value = '';
      attachments = [];
      preview.innerHTML = '';
      await load();
      thread.scrollTop = thread.scrollHeight;
    } catch (e) {
      errEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not send.', 'bad');
    }
  };
  body.querySelector('#msg-send')!.addEventListener('click', send);
  (body.querySelector('#msg-body') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
}

// ------------------------------------------------------------------
// 📇 Directory
// ------------------------------------------------------------------

async function renderDirectory(body: HTMLElement, isManager: boolean): Promise<void> {
  body.innerHTML = `
    <div class="searchrow"><input id="dir-q" placeholder="Search name, company, role…" autocomplete="off" /></div>
    <div id="dir-list"><div class="center">Type to search.</div></div>
    <div class="card"><h3>Add a contact</h3>
      <div id="dir-msg"></div>
      <input id="dir-name" placeholder="Name *" autocomplete="off" />
      <input id="dir-company" placeholder="Company" autocomplete="off" />
      <input id="dir-role" placeholder="Role" autocomplete="off" />
      <input id="dir-phone" placeholder="Phone" inputmode="tel" autocomplete="off" />
      <input id="dir-email" placeholder="Email" inputmode="email" autocomplete="off" />
      <input id="dir-notes" placeholder="Notes" autocomplete="off" />
      <button class="primary" id="dir-add">Add contact</button>
    </div>`;
  const list = body.querySelector<HTMLElement>('#dir-list')!;
  const q = body.querySelector<HTMLInputElement>('#dir-q')!;
  let timer: number | undefined;

  const search = async () => {
    const term = q.value.trim();
    if (!term) {
      list.innerHTML = `<div class="center">Type to search.</div>`;
      return;
    }
    try {
      const res = await api.get<{ contacts: DirectoryContactRecord[] }>(
        `/directory?q=${encodeURIComponent(term)}`,
      );
      list.innerHTML =
        res.contacts
          .map((c) => {
            const tel = c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '';
            const mail = c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '';
            return `<div class="card slim"><h3>${esc(c.name)}</h3>
              <div class="muted">${esc(c.role || '')}${c.company ? ` · ${esc(c.company)}` : ''}</div>
              <div class="contactlines">${tel}${mail}</div>
              ${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ''}</div>`;
          })
          .join('') || `<div class="center">No matches.</div>`;
    } catch (e) {
      list.innerHTML = notice(e instanceof ApiError ? e.message : 'Search failed.', 'bad');
    }
  };
  q.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(search, 250);
  });

  const say = (t: string, k: 'bad' | 'good' | '' = '') => {
    body.querySelector('#dir-msg')!.innerHTML = notice(t, k);
  };
  body.querySelector('#dir-add')!.addEventListener('click', async () => {
    const val = (id: string) => (body.querySelector(id) as HTMLInputElement).value.trim();
    const name = val('#dir-name');
    if (!name) {
      say('Name is required.', 'bad');
      return;
    }
    try {
      await api.post('/directory', {
        name,
        company: val('#dir-company') || undefined,
        role: val('#dir-role') || undefined,
        phone: val('#dir-phone') || undefined,
        email: val('#dir-email') || undefined,
        notes: val('#dir-notes') || undefined,
      });
      say('Contact added.', 'good');
      (['#dir-name', '#dir-company', '#dir-role', '#dir-phone', '#dir-email', '#dir-notes'] as const).forEach(
        (id) => ((body.querySelector(id) as HTMLInputElement).value = ''),
      );
      await search();
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Could not add contact.', 'bad');
    }
  });
  void isManager;
}

// ------------------------------------------------------------------
// 🗓️ Time off
// ------------------------------------------------------------------

async function renderTimeOff(body: HTMLElement, isManager: boolean, me: MeUser): Promise<void> {
  body.innerHTML = `
    <div id="to-msg"></div>
    <div class="card"><h3>Request time off</h3>
      <label class="fld">Start<input id="to-start" type="date" value="${todayISO()}" /></label>
      <label class="fld">End<input id="to-end" type="date" value="${todayISO()}" /></label>
      <input id="to-reason" placeholder="Reason (optional)" autocomplete="off" />
      <button class="primary" id="to-submit">Submit request</button>
    </div>
    <div class="card"><h3>My requests</h3><div id="to-mine"><div class="center">Loading…</div></div></div>
    ${isManager ? `<div class="card"><h3>Pending approvals</h3><div id="to-pending"><div class="center">Loading…</div></div></div>` : ''}
    ${isManager ? `<div class="card"><h3>This week's numbers</h3><div id="to-report"><div class="center">Loading…</div></div></div>` : ''}`;
  const say = (t: string, k: 'bad' | 'good' | '' = '') => {
    body.querySelector('#to-msg')!.innerHTML = notice(t, k);
  };

  const pill = (s: string) => `<span class="pill ${s}">${esc(s)}</span>`;

  const loadMine = async () => {
    const el = body.querySelector('#to-mine')!;
    try {
      const res = await api.get<{ requests: TimeOffRecord[] }>('/time-off');
      el.innerHTML =
        res.requests
          .map((r) => `<div class="toline">${pill(r.status)}<span>${esc(r.startDate)} → ${esc(r.endDate)}${r.reason ? ` · ${esc(r.reason)}` : ''}</span></div>`)
          .join('') || `<div class="center">No requests yet.</div>`;
    } catch (e) {
      el.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load requests.', 'bad');
    }
  };

  const loadPending = async () => {
    const el = body.querySelector('#to-pending');
    if (!el) return;
    try {
      const res = await api.get<{ requests: TimeOffRecord[] }>('/time-off?status=pending');
      el.innerHTML =
        res.requests
          .map(
            (r) => `<div class="toline">${esc(r.userName || r.userId)}<span>${esc(r.startDate)} → ${esc(r.endDate)}${r.reason ? ` · ${esc(r.reason)}` : ''}</span>
              <span class="decide"><button class="primary sm" data-approve="${esc(r.id)}">Approve</button>
              <button class="sm" data-deny="${esc(r.id)}">Deny</button></span></div>`,
          )
          .join('') || `<div class="center">Nothing pending.</div>`;
      el.querySelectorAll<HTMLElement>('[data-approve]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api.post(`/time-off/${encodeURIComponent(b.dataset.approve!)}/approve`, {});
          await loadPending();
          await loadMine();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-deny]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api.post(`/time-off/${encodeURIComponent(b.dataset.deny!)}/deny`, {});
          await loadPending();
          await loadMine();
        }),
      );
    } catch (e) {
      el.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load pending requests.', 'bad');
    }
  };

  const loadReport = async () => {
    const el = body.querySelector('#to-report');
    if (!el) return;
    try {
      const { report } = await api.get<{ report: WeeklyReport }>('/reports/week');
      const statuses = Object.entries(report.casesByStatus)
        .map(([s, n]) => `<div class="stat"><b>${n}</b><span>${esc(s)}</span></div>`)
        .join('');
      el.innerHTML = `
        <div class="muted">Week of ${esc(report.weekStart)}</div>
        <div class="statgrid">${statuses}</div>
        <div class="statgrid">
          <div class="stat"><b>${report.possessions}</b><span>possessions</span></div>
          <div class="stat"><b>${report.deliveries}</b><span>deliveries</span></div>
          <div class="stat"><b>${report.invoicesCreated}</b><span>invoices created</span></div>
          <div class="stat"><b>${report.invoicesApproved}</b><span>invoices approved</span></div>
          <div class="stat"><b>${report.avgDaysIntakeToPossession ?? '—'}</b><span>avg days intake→possession</span></div>
        </div>
        <h4>Per agent</h4>
        ${report.perAgent.map((a) => `<div class="toline"><span>${esc(a.agentName)}</span><span>${a.assignedCases} assigned · ${a.possessions} possessions</span></div>`).join('') || '<div class="center">No agents.</div>'}`;
    } catch (e) {
      el.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load the report.', 'bad');
    }
  };

  body.querySelector('#to-submit')!.addEventListener('click', async () => {
    const start = (body.querySelector('#to-start') as HTMLInputElement).value;
    const end = (body.querySelector('#to-end') as HTMLInputElement).value;
    const reason = (body.querySelector('#to-reason') as HTMLInputElement).value.trim();
    if (!start || !end) {
      say('Pick a start and end date.', 'bad');
      return;
    }
    try {
      await api.post('/time-off', { startDate: start, endDate: end, reason: reason || undefined });
      say('Request submitted.', 'good');
      await loadMine();
      await loadPending();
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Could not submit.', 'bad');
    }
  });

  await loadMine();
  await loadPending();
  await loadReport();
  void me;
}
