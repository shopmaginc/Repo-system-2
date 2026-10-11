/**
 * Field Permissions view — edit the per-role visibility matrix.
 * PII is hidden by default; managers can grant read/write per field.
 */
import { api } from '../api.js';

interface FieldPermission {
  entity: string;
  field: string;
  access: 'hidden' | 'read' | 'write';
}

interface Role {
  id: string;
  name: string;
  description?: string;
  fieldPermissions: FieldPermission[];
}

const ACCESS: Array<'hidden' | 'read' | 'write'> = ['hidden', 'read', 'write'];

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function renderPermissions(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Field Permissions</h1>
    <p class="page-sub">Control what each role can see. PII is hidden by default.</p>
    <div id="content"><div class="card">Loading…</div></div>
  `;
  const content = container.querySelector<HTMLElement>('#content')!;

  let roles: Role[];
  try {
    const data = await api<{ roles: Role[] }>('/admin/roles');
    roles = data.roles ?? [];
  } catch (e: any) {
    content.innerHTML = `<div class="error">Could not load roles: ${esc(e.message)}. The permission matrix requires manager access.</div>`;
    return;
  }
  if (roles.length === 0) {
    content.innerHTML = `<div class="card">No roles found.</div>`;
    return;
  }

  // Union of all entity.field pairs across roles, sorted.
  const fieldKeys = new Set<string>();
  for (const r of roles) {
    for (const p of r.fieldPermissions ?? []) fieldKeys.add(`${p.entity}.${p.field}`);
  }
  const fields = [...fieldKeys].sort();

  // Local editable copy: roleName -> "entity.field" -> access
  const matrix = new Map<string, Map<string, 'hidden' | 'read' | 'write'>>();
  for (const r of roles) {
    const m = new Map<string, 'hidden' | 'read' | 'write'>();
    for (const f of fields) m.set(f, 'hidden');
    for (const p of r.fieldPermissions ?? []) m.set(`${p.entity}.${p.field}`, p.access);
    matrix.set(r.name, m);
  }

  const dirty = new Set<string>();

  const render = (): void => {
    content.innerHTML = `
      <div id="msg"></div>
      <div class="card" style="padding:0;overflow:auto">
        <table>
          <thead><tr>
            <th style="min-width:220px">Field</th>
            ${roles.map((r) => `<th>${esc(r.name)}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${fields.map((f) => `
              <tr>
                <td><code>${esc(f)}</code></td>
                ${roles.map((r) => {
                  const cur = matrix.get(r.name)!.get(f)!;
                  return `<td>
                    <select data-role="${esc(r.name)}" data-field="${esc(f)}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px">
                      ${ACCESS.map((a) => `<option value="${a}" ${a === cur ? 'selected' : ''}>${a}</option>`).join('')}
                    </select>
                  </td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="btn" id="saveBtn" ${dirty.size ? '' : 'disabled'}>Save${dirty.size ? ` (${dirty.size} role${dirty.size > 1 ? 's' : ''} changed)` : ''}</button>
        <span style="color:var(--muted);font-size:13px">Changes apply on save, per role.</span>
      </div>
    `;

    content.querySelectorAll('select[data-role]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const el = sel as HTMLSelectElement;
        matrix.get(el.dataset.role!)!.set(el.dataset.field!, el.value as 'hidden' | 'read' | 'write');
        dirty.add(el.dataset.role!);
        render();
      });
    });

    content.querySelector('#saveBtn')?.addEventListener('click', async () => {
      const msg = content.querySelector('#msg')!;
      msg.innerHTML = '';
      try {
        for (const roleName of dirty) {
          const m = matrix.get(roleName)!;
          const permissions = fields.map((f) => {
            const [entity, field] = f.split('.');
            return { entity, field, access: m.get(f)! };
          });
          await api(`/admin/roles/${encodeURIComponent(roleName)}/permissions`, {
            method: 'PUT',
            body: JSON.stringify({ permissions }),
          });
        }
        dirty.clear();
        msg.innerHTML = `<div class="success">Permissions saved.</div>`;
        render();
      } catch (e: any) {
        msg.innerHTML = `<div class="error">Save failed: ${esc(e.message)}</div>`;
      }
    });
  };

  render();
}
