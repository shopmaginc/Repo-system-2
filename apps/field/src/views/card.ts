import { api, addrLine, type CaseCard, ApiError } from '../api.js';
import { esc, topbar, tabbar, notice, wireNav, debtorName } from '../ui.js';
import { renderLotDocs } from './lotdocs.js';
import { renderSkipEmail } from './skiptab.js';

export async function renderCard(root: HTMLElement, id: string): Promise<void> {
  root.innerHTML = `<div class="screen">
    ${topbar('Case', '#/map')}
    <div class="body" id="body"><div class="center">Loading…</div></div>
    ${tabbar('map')}
  </div>`;
  const body = root.querySelector<HTMLElement>('#body')!;

  let card: CaseCard;
  try {
    card = (await api.get<{ card: CaseCard }>(`/field/cases/${encodeURIComponent(id)}/card`)).card;
  } catch (e) {
    body.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load case', 'bad');
    return;
  }

  const rep = card.client;
  const repLines: string[] = [];
  if (rep?.contactName) repLines.push(`<dt>Rep</dt><dd>${esc(rep.contactName)}</dd>`);
  if (rep?.contactPhone)
    repLines.push(`<dt>Phone</dt><dd><a class="tel" href="tel:${esc(rep.contactPhone)}">${esc(rep.contactPhone)}</a></dd>`);
  if (rep?.contactCell)
    repLines.push(`<dt>Cell</dt><dd><a class="tel" href="tel:${esc(rep.contactCell)}">${esc(rep.contactCell)}</a> · <a class="tel" href="sms:${esc(rep.contactCell)}">text</a></dd>`);
  if (rep?.contactEmail)
    repLines.push(`<dt>Email</dt><dd><a class="tel" href="mailto:${esc(rep.contactEmail)}">${esc(rep.contactEmail)}</a></dd>`);

  body.innerHTML = `
    <h2 style="margin:0 0 4px">${esc(card.caseNumber)} <span class="pill">${esc(card.status.replace(/_/g, ' '))}</span></h2>
    <div class="card"><h3>Asset</h3>
      <div class="kv">
        <dt>VIN</dt><dd class="mono">${esc(card.asset?.vin ?? '—')}</dd>
        <dt>Year/Make/Model</dt><dd>${esc([card.asset?.year, card.asset?.make, card.asset?.model].filter(Boolean).join(' ') || '—')}</dd>
        <dt>Color</dt><dd>${esc(card.asset?.color ?? '—')}</dd>
        <dt>Plate</dt><dd class="mono">${esc(card.asset?.plate ?? '—')}</dd>
      </div>
    </div>
    <div class="card"><h3>Debtor</h3>
      <div class="kv"><dt>Name</dt><dd>${esc(debtorName(card.debtor))}</dd></div>
    </div>
    <div class="card"><h3>Client</h3>
      <div class="kv">
        <dt>Client</dt><dd>${esc(card.client?.name ?? '—')}</dd>
        <dt>Bank</dt><dd>${esc(card.lender?.name ?? '—')}</dd>
        ${repLines.join('')}
      </div>
    </div>
    <div class="card"><h3>Addresses</h3>
      ${card.addresses.map((a) => `<div style="margin:6px 0"><span class="pill">${esc(a.label)}</span><br>${esc(addrLine(a))}</div>`).join('') || '<div class="center">None on file</div>'}
    </div>
    <div class="card"><h3>📸 Lot &amp; docs</h3>
      <div id="lotdocs"><div class="center">Loading…</div></div>
    </div>
    <div id="skipemail"><div class="card"><div class="center">Loading…</div></div></div>
    <div id="msg"></div>
    <div class="btnrow">
      <button class="btn secondary" id="nav">🧭 Navigate</button>
      <button class="btn secondary" id="checkin">📍 Check in</button>
    </div>
    <div class="btnrow">
      <button class="btn secondary" id="note">📝 Note</button>
      <button class="btn secondary" id="scan">🔎 Scan VIN</button>
    </div>
    <button class="btn good" id="possess">✅ Take possession</button>`;

  const msg = body.querySelector<HTMLElement>('#msg')!;
  const say = (t: string, k: 'bad' | 'good' | '' = '') => (msg.innerHTML = notice(t, k));

  // Navigate: first geocoded address, geo: URI (native maps on Android).
  body.querySelector('#nav')!.addEventListener('click', () => {
    const a = card.addresses.find((x) => x.lat != null && x.lng != null);
    if (!a) return say('No geocoded address on this case.', 'bad');
    location.href = `geo:${a.lat},${a.lng}?q=${a.lat},${a.lng}(${encodeURIComponent(a.street)})`;
  });

  const locate = (): Promise<{ lat: number; lng: number }> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: 0, lng: 0 });
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve({ lat: 0, lng: 0 }),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });

  body.querySelector('#checkin')!.addEventListener('click', async () => {
    const note = prompt('Check-in note (optional):') ?? undefined;
    const { lat, lng } = await locate();
    try {
      await api.post(`/field/cases/${encodeURIComponent(id)}/check-in`, { lat, lng, note: note || undefined });
      say('Checked in.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Check-in failed', 'bad');
    }
  });

  body.querySelector('#note')!.addEventListener('click', async () => {
    const text = prompt('Field note:');
    if (!text || !text.trim()) return;
    try {
      await api.post(`/field/cases/${encodeURIComponent(id)}/notes`, { text: text.trim() });
      say('Note saved to the case timeline.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Note failed', 'bad');
    }
  });

  body.querySelector('#scan')!.addEventListener('click', () => {
    location.hash = `#/scan/${encodeURIComponent(id)}`;
  });

  body.querySelector('#possess')!.addEventListener('click', async () => {
    if (!confirm(`Take physical possession of ${card.caseNumber}?\n\nThis moves the case forward and alerts dispatch for transport.`)) return;
    const { lat, lng } = await locate();
    try {
      await api.post(`/field/cases/${encodeURIComponent(id)}/possession`, { lat, lng });
      say('Possession recorded. Transport handoff task created.', 'good');
      setTimeout(() => location.hash = '#/map', 1200);
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Possession failed', 'bad');
    }
  });

  // Lot & docs: photos, scans, delivery, condition report, inspection.
  // Fire-and-forget on purpose — it self-reports load failures.
  renderLotDocs(body.querySelector<HTMLElement>('#lotdocs')!, id).catch(() => {});

  // Skip + email: cross-reference, worksheet, deep pulls, client emails.
  // Renders its own two card sections; self-reports load failures.
  renderSkipEmail(body.querySelector<HTMLElement>('#skipemail')!, id, card.client?.id ?? null).catch(() => {});

  wireNav(root);
}
