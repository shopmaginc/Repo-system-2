/**
 * Users view — staff account management: list, invite, change role, suspend/reinstate.
 */
import { api } from '../api.js';

const ROLES = ['agent', 'transport_driver', 'lot_attendant', 'office_clerk', 'manager'] as const;
type RoleName = (typeof ROLES)[number];

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  status: string;
  role: { name: string };
}

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

export function prettyRole(role: string): string {
  return role
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function statusBadge(status: string): string {
  const cls = status === 'active' ? 'badge-active' : 'badge-suspended';
  return `<span class="badge ${cls}">${esc(prettyRole(status))}</span>`;
}

function openModal(title: string, bodyHtml: string): { overlay: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="modal-body">${bodyHtml}</div></div>`;
  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (e: Event) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  return { overlay, close };
}

export async function renderUsers(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-title">Users</div>
    <div class="page-sub">Manage staff accounts</div>
    <div id="usersMsg"></div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3>Staff</h3>
        <button class="btn" id="addUserBtn">Add user</button>
      </div>
      <div id="usersTable">Loading…</div>
    </div>
  `;

  const msgBox = container.querySelector<HTMLElement>('#usersMsg')!;
  const tableBox = container.querySelector<HTMLElement>('#usersTable')!;
  container.querySelector<HTMLButtonElement>('#addUserBtn')!.addEventListener('click', () => {
    showAddUserModal(() => void loadUsers());
  });

  const showMsg = (kind: 'error' | 'success', text: string): void => {
    msgBox.innerHTML = `<div class="${kind}">${esc(text)}</div>`;
    window.setTimeout(() => {
      msgBox.innerHTML = '';
    }, 5000);
  };

  async function loadUsers(): Promise<void> {
    tableBox.textContent = 'Loading…';
    let users: UserRow[];
    try {
      const res = await api<{ users: UserRow[] }>('/admin/users');
      users = res.users ?? [];
    } catch (e: unknown) {
      tableBox.innerHTML = `<div class="error">${esc(e instanceof Error ? e.message : 'Failed to load users.')}</div>`;
      return;
    }

    if (users.length === 0) {
      tableBox.innerHTML = '<p style="color:var(--muted);">No users yet.</p>';
      return;
    }

    const rows = users.map((u) => {
      const isActive = u.status === 'active';
      const toggleBtn = isActive
        ? `<button class="btn btn-small btn-danger" data-act="suspend" data-id="${esc(u.id)}" data-name="${esc(u.name)}">Suspend</button>`
        : `<button class="btn btn-small" data-act="reinstate" data-id="${esc(u.id)}" data-name="${esc(u.name)}">Reinstate</button>`;
      const roleOptions = ROLES.map(
        (r) => `<option value="${r}"${r === u.role.name ? ' selected' : ''}>${esc(prettyRole(r))}</option>`,
      ).join('');
      return `
        <tr>
          <td>${esc(u.name)}</td>
          <td>${esc(u.email)}</td>
          <td><span class="badge badge-info">${esc(prettyRole(u.role.name))}</span></td>
          <td>${statusBadge(u.status)}</td>
          <td style="white-space:nowrap;">
            <select data-role-for="${esc(u.id)}" class="btn-small" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;margin-right:6px;" title="Change role">
              ${roleOptions}
            </select>
            ${toggleBtn}
          </td>
        </tr>`;
    });

    tableBox.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`;

    tableBox.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => void handleToggle(btn));
    });
    tableBox.querySelectorAll<HTMLSelectElement>('select[data-role-for]').forEach((sel) => {
      const original = sel.value;
      sel.addEventListener('change', () => void handleRoleChange(sel, original));
    });
  }

  async function handleToggle(btn: HTMLButtonElement): Promise<void> {
    const act = btn.dataset.act!;
    const id = btn.dataset.id!;
    const name = btn.dataset.name ?? 'this user';
    const verb = act === 'suspend' ? 'Suspend' : 'Reinstate';
    if (!window.confirm(`${verb} ${name}?`)) return;
    btn.disabled = true;
    try {
      await api(`/admin/users/${encodeURIComponent(id)}/${act}`, { method: 'POST' });
      showMsg('success', `${name} ${act === 'suspend' ? 'suspended' : 'reinstated'}.`);
      await loadUsers();
    } catch (e: unknown) {
      showMsg('error', e instanceof Error ? e.message : 'Action failed.');
      btn.disabled = false;
    }
  }

  async function handleRoleChange(sel: HTMLSelectElement, original: string): Promise<void> {
    const id = sel.dataset.roleFor!;
    const role = sel.value as RoleName;
    if (role === original) return;
    if (!window.confirm(`Change role to ${prettyRole(role)}?`)) {
      sel.value = original;
      return;
    }
    sel.disabled = true;
    try {
      await api(`/admin/users/${encodeURIComponent(id)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      showMsg('success', 'Role updated.');
      await loadUsers();
    } catch (e: unknown) {
      showMsg('error', e instanceof Error ? e.message : 'Role change failed.');
      sel.value = original;
      sel.disabled = false;
    }
  }

  function showAddUserModal(onDone: () => void): void {
    const roleOptions = ROLES.map(
      (r) => `<option value="${r}">${esc(prettyRole(r))}</option>`,
    ).join('');
    const { overlay, close } = openModal(
      'Add user',
      `
      <div class="error" id="addUserErr" style="display:none;"></div>
      <div class="form-group"><label for="nuName">Name</label><input id="nuName" type="text" /></div>
      <div class="form-group"><label for="nuEmail">Email</label><input id="nuEmail" type="email" /></div>
      <div class="form-group"><label for="nuPassword">Password <span style="color:var(--muted);font-weight:400;">(optional — one is generated if blank)</span></label><input id="nuPassword" type="password" autocomplete="new-password" /></div>
      <div class="form-group"><label for="nuRole">Role</label><select id="nuRole">${roleOptions}</select></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="nuCancel">Cancel</button>
        <button class="btn" id="nuSave">Create user</button>
      </div>
      `,
    );

    const errEl = overlay.querySelector<HTMLElement>('#addUserErr')!;
    overlay.querySelector<HTMLButtonElement>('#nuCancel')!.addEventListener('click', close);
    overlay.querySelector<HTMLButtonElement>('#nuSave')!.addEventListener('click', () => {
      const name = overlay.querySelector<HTMLInputElement>('#nuName')!.value.trim();
      const email = overlay.querySelector<HTMLInputElement>('#nuEmail')!.value.trim();
      const password = overlay.querySelector<HTMLInputElement>('#nuPassword')!.value;
      const role = overlay.querySelector<HTMLSelectElement>('#nuRole')!.value;
      if (!name || !email) {
        errEl.textContent = 'Name and email are required.';
        errEl.style.display = 'block';
        return;
      }
      const payload: Record<string, string> = { name, email, role };
      if (password) payload.password = password;
      const saveBtn = overlay.querySelector<HTMLButtonElement>('#nuSave')!;
      saveBtn.disabled = true;
      api<{ user?: UserRow; tempPassword?: string }>('/admin/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
        .then((res) => {
          close();
          const temp = res.tempPassword ? ` Temporary password: ${res.tempPassword}` : '';
          showMsg('success', `User ${email} created.${temp}`);
          onDone();
        })
        .catch((e: unknown) => {
          errEl.textContent = e instanceof Error ? e.message : 'Create failed.';
          errEl.style.display = 'block';
          saveBtn.disabled = false;
        });
    });
  }

  await loadUsers();
}
