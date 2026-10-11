/**
 * Directory view — shared company contacts: search, add, edit, delete.
 */
import { api } from '../api.js';

interface Contact {
  id: string;
  name: string;
  company?: string | null;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  addedByName?: string | null;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function openContactModal(
  container: HTMLElement,
  existing: Contact | null,
  onSaved: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${existing ? 'Edit contact' : 'Add contact'}</h3>
      <div id="err"></div>
      <form id="f">
        <div class="form-group"><label>Name *</label><input id="name" required maxlength="160" value="${esc(existing?.name ?? '')}" /></div>
        <div class="form-row">
          <div class="form-group"><label>Company</label><input id="company" maxlength="160" value="${esc(existing?.company ?? '')}" /></div>
          <div class="form-group"><label>Role</label><input id="role" maxlength="80" value="${esc(existing?.role ?? '')}" /></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Phone</label><input id="phone" maxlength="32" value="${esc(existing?.phone ?? '')}" /></div>
          <div class="form-group"><label>Email</label><input id="email" type="email" maxlength="254" value="${esc(existing?.email ?? '')}" /></div>
        </div>
        <div class="form-group"><label>Notes</label><textarea id="notes" rows="3" maxlength="1000">${esc(existing?.notes ?? '')}</textarea></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn">${existing ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.querySelector('#cancelBtn')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#f')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = overlay.querySelector('#err')!;
    const val = (id: string) => (overlay.querySelector<HTMLInputElement>(`#${id}`)!.value.trim() || undefined);
    const body = {
      name: overlay.querySelector<HTMLInputElement>('#name')!.value.trim(),
      company: val('company'),
      role: val('role'),
      phone: val('phone'),
      email: val('email'),
      notes: (overlay.querySelector<HTMLTextAreaElement>('#notes')!.value.trim() || undefined),
    };
    try {
      if (existing) {
        await api(`/directory/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api('/directory', { method: 'POST', body: JSON.stringify(body) });
      }
      close();
      onSaved();
    } catch (ex: any) {
      err.innerHTML = `<div class="error">${esc(ex.message)}</div>`;
    }
  });
  container.appendChild(overlay);
  overlay.querySelector<HTMLInputElement>('#name')?.focus();
}

export async function renderDirectory(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Directory</h1>
    <p class="page-sub">Shared company contacts.</p>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <input id="search" placeholder="Search name, company, or role…" style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px" />
      <button class="btn" id="addBtn">Add contact</button>
    </div>
    <div id="content"><div class="card">Loading…</div></div>
  `;

  const content = container.querySelector<HTMLElement>('#content')!;
  const search = container.querySelector<HTMLInputElement>('#search')!;
  let contacts: Contact[] = [];

  const load = async (): Promise<void> => {
    try {
      const data = await api<{ contacts: Contact[] }>('/directory');
      contacts = data.contacts ?? [];
    } catch (e: any) {
      content.innerHTML = `<div class="error">Could not load directory: ${esc(e.message)}</div>`;
      return;
    }
    draw();
  };

  const draw = (): void => {
    const q = search.value.trim().toLowerCase();
    const rows = q
      ? contacts.filter((c) =>
          [c.name, c.company, c.role, c.email].some((v) => String(v ?? '').toLowerCase().includes(q)),
        )
      : contacts;

    if (rows.length === 0) {
      content.innerHTML = `<div class="card">${contacts.length === 0 ? 'No contacts yet. Add the first one above.' : 'No contacts match your search.'}</div>`;
      return;
    }

    content.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr>
            <th>Name</th><th>Company</th><th>Role</th><th>Phone</th><th>Email</th><th>Notes</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.map((c) => `
              <tr>
                <td><strong>${esc(c.name)}</strong>${c.addedByName ? `<div style="color:var(--muted);font-size:12px">added by ${esc(c.addedByName)}</div>` : ''}</td>
                <td>${esc(c.company ?? '—')}</td>
                <td>${esc(c.role ?? '—')}</td>
                <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</td>
                <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</td>
                <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${esc(c.notes ?? '—')}</td>
                <td style="white-space:nowrap">
                  <button class="btn btn-small btn-secondary" data-edit="${c.id}">Edit</button>
                  <button class="btn btn-small btn-danger" data-del="${c.id}">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    content.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = contacts.find((x) => x.id === (b as HTMLElement).dataset.edit);
        if (c) openContactModal(container, c, load);
      })
    );
    content.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = (b as HTMLElement).dataset.del!;
        const c = contacts.find((x) => x.id === id);
        if (!window.confirm(`Delete contact "${c?.name ?? id}"?`)) return;
        try {
          await api(`/directory/${id}`, { method: 'DELETE' });
          await load();
        } catch (e: any) {
          content.insertAdjacentHTML('afterbegin', `<div class="error">Delete failed: ${esc(e.message)}</div>`);
        }
      })
    );
  };

  search.addEventListener('input', draw);
  container.querySelector('#addBtn')?.addEventListener('click', () => openContactModal(container, null, load));
  await load();
}
