import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, fmtDistance, addrLine, type FieldAssignment, ApiError } from '../api.js';
import { esc, topbar, tabbar, notice, wireNav, debtorName } from '../ui.js';

const LAREDO: [number, number] = [27.5306, -99.4861]; // graceful fallback

export async function renderMap(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="screen">
    ${topbar('Field map')}
    <div id="map"></div>
    <div class="stoplist" id="stops"><div class="center">Loading assignments…</div></div>
    ${tabbar('map')}
  </div>`;

  const stopsEl = root.querySelector<HTMLElement>('#stops')!;

  // Position: browser geolocation, fall back to Laredo when denied.
  const pos = await new Promise<{ lat: number; lng: number }>((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: LAREDO[0], lng: LAREDO[1] });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: LAREDO[0], lng: LAREDO[1] }),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });

  let list: FieldAssignment[];
  try {
    const res = await api.get<{ assignments: FieldAssignment[] }>(
      `/field/assignments?lat=${pos.lat}&lng=${pos.lng}`,
    );
    list = res.assignments;
  } catch (e) {
    stopsEl.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load assignments', 'bad');
    list = [];
  }

  const map = L.map('map').setView([pos.lat, pos.lng], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  L.marker([pos.lat, pos.lng], { title: 'You' })
    .addTo(map)
    .bindPopup('You are here');

  const bounds: Array<[number, number]> = [[pos.lat, pos.lng]];

  for (const a of list) {
    for (const addr of a.addresses) {
      if (addr.lat == null || addr.lng == null) continue;
      const m = L.marker([addr.lat, addr.lng], { title: a.caseNumber }).addTo(map);
      m.bindPopup(`<b>${esc(a.caseNumber)}</b><br>${esc(addrLine(addr))}<br>${esc(debtorName(a.debtor))}`);
      m.on('click', () => openSheet(a));
      bounds.push([addr.lat, addr.lng]);
    }
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [32, 32] });

  // Below-map stop list, nearest first (server already sorted).
  if (!list.length) {
    stopsEl.innerHTML = `<div class="center">No active assignments.</div>`;
    return;
  }
  stopsEl.innerHTML = list
    .map(
      (a) => `<button class="stop" data-id="${esc(a.id)}">
        <div><b>${esc(a.caseNumber)}</b> <span class="pill">${esc(a.status.replace(/_/g, ' '))}</span><br>
        <span style="color:var(--muted);font-size:.85rem">${esc(addrLine(a.addresses[0] ?? { street: 'No address on file' } as never))}</span></div>
        <span class="dist">${esc(fmtDistance(a.distanceMeters))}</span>
      </button>`,
    )
    .join('');
  stopsEl.querySelectorAll<HTMLButtonElement>('.stop').forEach((b) => {
    b.addEventListener('click', () => {
      location.hash = `#/card/${b.dataset.id}`;
    });
  });

  // Bottom-sheet mini card on pin tap.
  function openSheet(a: FieldAssignment): void {
    const old = document.querySelector('.sheet-backdrop');
    if (old) old.remove();
    const bd = document.createElement('div');
    bd.className = 'sheet-backdrop';
    bd.innerHTML = `<div class="sheet" role="dialog">
      <div class="grab"></div>
      <h3 style="margin:0 0 4px">${esc(a.caseNumber)} <span class="pill">${esc(a.status.replace(/_/g, ' '))}</span></h3>
      <div class="kv">
        <dt>VIN</dt><dd class="mono">${esc(a.asset?.vin ?? '—')}</dd>
        <dt>Debtor</dt><dd>${esc(debtorName(a.debtor))}</dd>
        <dt>Vehicle</dt><dd>${esc([a.asset?.year, a.asset?.make, a.asset?.model, a.asset?.color].filter(Boolean).join(' ') || '—')}</dd>
        <dt>Plate</dt><dd class="mono">${esc(a.asset?.plate ?? '—')}</dd>
      </div>
      <button class="btn" data-nav="#/card/${esc(a.id)}">Open case</button>
      <button class="btn secondary" id="sheetclose">Close</button>
    </div>`;
    bd.addEventListener('click', (e) => {
      if (e.target === bd) bd.remove();
    });
    document.body.appendChild(bd);
    wireNav(bd);
    bd.querySelector('#sheetclose')!.addEventListener('click', () => bd.remove());
  }

  wireNav(root);
}
