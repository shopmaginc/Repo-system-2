import { api, postForm, type MeUser, ApiError } from '../api.js';
import { notice } from '../ui.js';

/**
 * "Lot & docs" section for the case card: condition photo capture
 * (four-side quick flow), document scans, delivery confirmation,
 * condition report and inspection checklist. Mobile-first, same
 * card/button style as the rest of the app.
 */

const SCAN_KINDS: Array<[string, string]> = [
  ['delivery_sheet', 'Delivery sheet'],
  ['condition_report', 'Condition report'],
  ['post_recovery_photos', 'Post-recovery photos'],
];

const INSPECTION_ITEMS: Array<[string, string]> = [
  ['tires', 'Tires'],
  ['brakes', 'Brakes'],
  ['airlines', 'Airlines'],
  ['reefer_unit', 'Reefer unit'],
  ['upfits', 'Upfits / accessories'],
];

export async function renderLotDocs(root: HTMLElement, caseId: string): Promise<void> {
  let me: MeUser | null = null;
  try {
    me = (await api.get<{ user: MeUser }>('/auth/me')).user;
  } catch {
    root.innerHTML = notice('Could not load your permissions.', 'bad');
    return;
  }

  const role = me.role;
  const canPhoto = me.canCaptureLotPhotos || role === 'manager' || role === 'office_clerk';
  const canOps = role === 'agent' || role === 'transport_driver' || role === 'manager';

  const cid = encodeURIComponent(caseId);
  const say = (t: string, k: 'bad' | 'good' | '' = '') => {
    root.querySelector<HTMLElement>('#ld-msg')!.innerHTML = notice(t, k);
  };

  let html = '<div id="ld-msg"></div>';
  if (canPhoto) {
    html += `
      <div class="btnrow">
        <button class="btn secondary" data-photo="front">📷 Front</button>
        <button class="btn secondary" data-photo="rear">📷 Rear</button>
      </div>
      <div class="btnrow">
        <button class="btn secondary" data-photo="left">📷 Left</button>
        <button class="btn secondary" data-photo="right">📷 Right</button>
      </div>
      <div class="btnrow">
        <button class="btn secondary" data-photo="vin_plate">🔢 VIN plate</button>
        <button class="btn secondary" data-photo="odometer">⏱ Odometer</button>
      </div>
      <div class="btnrow">
        <button class="btn secondary" data-photo="damage">⚠️ Damage</button>
        <button class="btn secondary" id="ld-scan">📄 Scan doc</button>
      </div>
      <div id="ld-scanform" style="display:none;margin:8px 0">
        <label class="f">Document kind
          <select id="ld-kind">${SCAN_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </label>
      </div>`;
  }
  if (canOps) {
    html += `
      <div class="btnrow">
        <button class="btn secondary" id="ld-deliver">✍️ Deliver</button>
        <button class="btn secondary" id="ld-condition">🧾 Condition</button>
      </div>
      <div id="ld-deliverform" style="display:none;margin:8px 0">
        <label class="f">Signed by (printed name)
          <input id="ld-signer" type="text" autocomplete="off" placeholder="Receiver name">
        </label>
        <button class="btn good" id="ld-delivergo">Confirm delivery</button>
      </div>
      <div id="ld-conditionform" style="display:none;margin:8px 0">
        ${['exterior', 'interior', 'mechanical', 'notes']
          .map((s) => `<label class="f">${s[0].toUpperCase() + s.slice(1)}<textarea id="ld-c-${s}" rows="2"></textarea></label>`)
          .join('')}
        <button class="btn good" id="ld-conditionsave">Save condition report</button>
      </div>
      <button class="btn secondary" id="ld-inspect" style="width:100%">🔧 Inspection checklist</button>
      <div id="ld-inspectform" style="display:none;margin:8px 0">
        <label class="f">Asset type
          <select id="ld-assettype"><option value="tractor">Tractor</option><option value="trailer">Trailer</option></select>
        </label>
        ${INSPECTION_ITEMS.map(
          ([key, label]) => `
          <div style="margin:6px 0;padding:6px;border:1px solid var(--border);border-radius:8px">
            <div style="font-weight:600">${label}</div>
            <div class="btnrow" style="margin:4px 0">
              ${['pass', 'fail', 'na']
                .map((r) => `<button class="btn secondary ld-res${r === 'pass' ? ' good' : ''}" data-item="${key}" data-res="${r}">${r === 'na' ? 'N/A' : r[0].toUpperCase() + r.slice(1)}</button>`)
                .join('')}
            </div>
            <input id="ld-i-${key}" type="text" placeholder="Notes (optional)" autocomplete="off">
          </div>`,
        ).join('')}
        <button class="btn good" id="ld-inspectsave">Save inspection</button>
      </div>`;
  }
  if (!canPhoto && !canOps) {
    html += '<div class="center">No lot &amp; docs actions for your role.</div>';
  }
  root.innerHTML = html;

  // ---- Photo capture -------------------------------------------------
  const photoInput = document.createElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.setAttribute('capture', 'environment'); // rear camera on Android
  root.appendChild(photoInput);
  photoInput.style.display = 'none';

  let pendingCategory = 'four_side';
  let pendingCaption = '';
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file, file.name || 'photo.jpg');
    form.append('category', pendingCategory);
    if (pendingCaption) form.append('caption', pendingCaption);
    say('Uploading…');
    try {
      await postForm(`/cases/${cid}/photos`, form);
      say('Photo saved.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Upload failed', 'bad');
    }
  });

  const capture = (category: string, caption: string) => {
    pendingCategory = category;
    pendingCaption = caption;
    photoInput.click();
  };

  root.querySelectorAll<HTMLButtonElement>('[data-photo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.photo!;
      const category = kind === 'front' || kind === 'rear' || kind === 'left' || kind === 'right' ? 'four_side' : kind;
      capture(category, kind);
    });
  });

  // ---- Document scan ---------------------------------------------------
  const scanInput = document.createElement('input');
  scanInput.type = 'file';
  scanInput.accept = 'application/pdf,image/*'; // camera OR gallery: signed docs may already be photos
  scanInput.style.display = 'none';
  root.appendChild(scanInput);
  scanInput.addEventListener('change', async () => {
    const file = scanInput.files?.[0];
    scanInput.value = '';
    if (!file) return;
    const kind = root.querySelector<HTMLSelectElement>('#ld-kind')!.value;
    const form = new FormData();
    form.append('file', file, file.name || 'scan.pdf');
    say('Uploading scan…');
    try {
      await postForm(`/cases/${cid}/documents/${encodeURIComponent(kind)}/scan`, form);
      say('Scan sent to the office review queue.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Scan failed', 'bad');
    }
  });
  root.querySelector('#ld-scan')?.addEventListener('click', () => {
    const f = root.querySelector<HTMLElement>('#ld-scanform')!;
    f.style.display = f.style.display === 'none' ? '' : 'none';
    if (f.style.display !== 'none') scanInput.click();
  });

  // ---- Delivery confirmation -------------------------------------------
  const locate = (): Promise<{ lat: number; lng: number }> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: 0, lng: 0 });
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve({ lat: 0, lng: 0 }),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });

  root.querySelector('#ld-deliver')?.addEventListener('click', () => {
    const f = root.querySelector<HTMLElement>('#ld-deliverform')!;
    f.style.display = f.style.display === 'none' ? '' : 'none';
  });
  root.querySelector('#ld-delivergo')?.addEventListener('click', async () => {
    const signedByName = root.querySelector<HTMLInputElement>('#ld-signer')!.value.trim();
    if (!signedByName) return say('Enter the receiver’s printed name.', 'bad');
    const { lat, lng } = await locate();
    say('Confirming delivery…');
    try {
      await api.post(`/cases/${cid}/deliver`, {
        signedByName,
        ...(lat ? { lat, lng } : {}),
      });
      say('Delivery confirmed.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Delivery failed', 'bad');
    }
  });

  // ---- Condition report --------------------------------------------------
  root.querySelector('#ld-condition')?.addEventListener('click', () => {
    const f = root.querySelector<HTMLElement>('#ld-conditionform')!;
    f.style.display = f.style.display === 'none' ? '' : 'none';
  });
  root.querySelector('#ld-conditionsave')?.addEventListener('click', async () => {
    const sections: Record<string, string> = {};
    for (const s of ['exterior', 'interior', 'mechanical', 'notes']) {
      const v = root.querySelector<HTMLTextAreaElement>(`#ld-c-${s}`)!.value.trim();
      if (v) sections[s] = v;
    }
    if (!Object.keys(sections).length) return say('Fill in at least one section.', 'bad');
    say('Saving…');
    try {
      await api.post(`/cases/${cid}/condition-report`, { sections });
      say('Condition report saved and sent for review.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Save failed', 'bad');
    }
  });

  // ---- Inspection checklist ----------------------------------------------
  const results = new Map<string, string>(INSPECTION_ITEMS.map(([k]) => [k, 'pass']));
  root.querySelector('#ld-inspect')?.addEventListener('click', () => {
    const f = root.querySelector<HTMLElement>('#ld-inspectform')!;
    f.style.display = f.style.display === 'none' ? '' : 'none';
  });
  root.querySelectorAll<HTMLButtonElement>('.ld-res').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const item = btn.dataset.item!;
      results.set(item, btn.dataset.res!);
      root.querySelectorAll<HTMLButtonElement>(`.ld-res[data-item="${item}"]`).forEach((b) => b.classList.remove('good'));
      btn.classList.add('good');
    });
  });
  root.querySelector('#ld-inspectsave')?.addEventListener('click', async () => {
    const assetType = root.querySelector<HTMLSelectElement>('#ld-assettype')!.value as 'tractor' | 'trailer';
    const items = INSPECTION_ITEMS.map(([key, label]) => ({
      key,
      label,
      result: results.get(key) as 'pass' | 'fail' | 'na',
      notes: root.querySelector<HTMLInputElement>(`#ld-i-${key}`)!.value.trim() || undefined,
    }));
    say('Saving…');
    try {
      await api.post(`/cases/${cid}/inspection`, { assetType, items });
      say('Inspection saved.', 'good');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Save failed', 'bad');
    }
  });
}
