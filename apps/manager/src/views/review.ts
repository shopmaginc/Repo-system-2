/**
 * Review Queue view — document scans awaiting manager approval.
 */
import { api, getToken, getApiBase } from '../api.js';

interface QueueItem {
  documentId: string;
  kind: string;
  caseId: string;
  caseNumber: string;
  caseStatus: string;
  clientName?: string | null;
  submittedByName?: string | null;
  submittedAt?: string | null;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function authedFetch(path: string): Promise<Response> {
  const token = getToken();
  return fetch(`${getApiBase()}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function renderReview(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h1 class="page-title">Review Queue</h1>
    <p class="page-sub">Document scans awaiting approval</p>
    <div class="card"><div id="queueWrap"><p>Loading…</p></div></div>`;

  const wrap = container.querySelector('#queueWrap') as HTMLElement;
  await load();

  async function load() {
    wrap.innerHTML = '<p>Loading…</p>';
    let items: QueueItem[];
    try {
      const data = await api<{ queue: QueueItem[] }>('/review-queue');
      items = data.queue ?? [];
    } catch (e: any) {
      const msg = /404/.test(e.message) ? 'Review queue is not available on this API version.' : `Failed to load queue: ${e.message}`;
      wrap.innerHTML = `<p class="error">${esc(msg)}</p>`;
      return;
    }

    if (!items.length) {
      wrap.innerHTML = '<p class="success" style="font-size:16px">All caught up. 🎉</p>';
      return;
    }

    wrap.innerHTML = `
      <table><thead><tr>
        <th>Case #</th><th>Document</th><th>Client</th><th>Submitted by</th><th>Submitted</th><th></th>
      </tr></thead><tbody>
      ${items.map((it, i) => `
        <tr>
          <td><strong>${esc(it.caseNumber)}</strong></td>
          <td>${esc(it.kind.replace(/_/g, ' '))}</td>
          <td>${esc(it.clientName ?? '—')}</td>
          <td>${esc(it.submittedByName ?? '—')}</td>
          <td>${esc(fmtDate(it.submittedAt))}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-small btn-secondary" data-preview="${i}">Preview</button>
            <button class="btn btn-small" data-approve="${i}">Approve</button>
            <button class="btn btn-small btn-danger" data-reject="${i}">Reject</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;

    wrap.querySelectorAll('[data-preview]').forEach((b) =>
      b.addEventListener('click', () => previewDoc(container, items[Number((b as HTMLElement).dataset.preview)]))
    );
    wrap.querySelectorAll('[data-approve]').forEach((b) =>
      b.addEventListener('click', async () => {
        const it = items[Number((b as HTMLElement).dataset.approve)];
        if (!confirm(`Approve "${it.kind.replace(/_/g, ' ')}" on ${it.caseNumber}?`)) return;
        try {
          await api(`/cases/${it.caseId}/documents/${it.kind}/approve`, { method: 'POST' });
          await load();
        } catch (e: any) {
          alert(`Approve failed: ${e.message}`);
        }
      })
    );
    wrap.querySelectorAll('[data-reject]').forEach((b) =>
      b.addEventListener('click', async () => {
        const it = items[Number((b as HTMLElement).dataset.reject)];
        const note = prompt(`Reject "${it.kind.replace(/_/g, ' ')}" on ${it.caseNumber}.\nReason (required):`);
        if (!note || !note.trim()) return;
        try {
          await api(`/cases/${it.caseId}/documents/${it.kind}/reject`, {
            method: 'POST',
            body: JSON.stringify({ note: note.trim() }),
          });
          await load();
        } catch (e: any) {
          alert(`Reject failed: ${e.message}`);
        }
      })
    );
  }
}

async function previewDoc(container: HTMLElement, it: QueueItem): Promise<void> {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:720px">
      <h2>${esc(it.kind.replace(/_/g, ' '))} — ${esc(it.caseNumber)}</h2>
      <p class="page-sub">Submitted by ${esc(it.submittedByName ?? '—')} · ${esc(fmtDate(it.submittedAt))}</p>
      <div id="previewBody"><p>Loading document…</p></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="pvClose">Close</button></div>
    </div>`;
  container.appendChild(overlay);
  (overlay.querySelector('#pvClose') as HTMLElement).addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const body = overlay.querySelector('#previewBody') as HTMLElement;
  try {
    // Find the scan photo for this document kind.
    const photos = await api<{ photos: Array<{ id: string; category: string; caption?: string | null; mimeType: string }> }>(
      `/cases/${it.caseId}/photos`
    );
    const match = (photos.photos ?? []).filter((p) => p.category === 'document_scan')
      .find((p) => (p.caption ?? '').toLowerCase().includes(it.kind.replace(/_/g, ' ')))
      ?? (photos.photos ?? []).filter((p) => p.category === 'document_scan').pop();
    if (!match) {
      body.innerHTML = '<p class="error">Scan file not found for this document.</p>';
      return;
    }
    const res = await authedFetch(`/cases/${it.caseId}/photos/${match.id}/file`);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if ((match.mimeType || '').includes('pdf')) {
      body.innerHTML = `<iframe src="${url}" style="width:100%;height:480px;border:1px solid var(--border)"></iframe>`;
    } else {
      body.innerHTML = `<img src="${url}" style="max-width:100%;max-height:480px;border:1px solid var(--border)" alt="scan">`;
    }
    const dl = document.createElement('a');
    dl.href = url;
    dl.download = `${it.caseNumber}-${it.kind}`;
    dl.className = 'btn btn-secondary btn-small';
    dl.style.marginTop = '8px';
    dl.textContent = 'Download';
    body.appendChild(dl);
  } catch (e: any) {
    body.innerHTML = `<p class="error">Preview failed: ${esc(e.message)}</p>`;
  }
}
