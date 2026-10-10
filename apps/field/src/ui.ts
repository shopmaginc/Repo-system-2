/** Tiny DOM helpers — no framework, keep it readable. */

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function topbar(title: string, backHash?: string): string {
  return `<div class="topbar">${backHash ? `<button class="back" data-nav="${backHash}">‹ Back</button>` : ''}<h1>${esc(title)}</h1></div>`;
}

export function tabbar(active: 'map' | 'comms' | 'more'): string {
  return `<nav class="tabbar">
    <a href="#/map" class="${active === 'map' ? 'active' : ''}"><span class="ico">🗺️</span>Map</a>
    <a href="#/comms" class="${active === 'comms' ? 'active' : ''}"><span class="ico">💬</span>Comms</a>
    <a href="#/more" class="${active === 'more' ? 'active' : ''}"><span class="ico">⋯</span>More</a>
  </nav>`;
}

export function notice(msg: string, kind: 'bad' | 'good' | '' = ''): string {
  return `<div class="notice ${kind}">${esc(msg)}</div>`;
}

/** Wire [data-nav] taps to hash navigation (call after each render). */
export function wireNav(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-nav]').forEach((n) => {
    n.addEventListener('click', () => {
      location.hash = n.dataset.nav!;
    });
  });
}

/** Debtor display name — the API filters PII per the role matrix. */
export function debtorName(d: Record<string, unknown> | null): string {
  return (d?.name as string) || '—';
}
