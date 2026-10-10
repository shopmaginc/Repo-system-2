import { api, type VinVerifyResult, ApiError } from '../api.js';
import { esc, topbar, tabbar, notice, wireNav } from '../ui.js';

/**
 * Two-capture VIN double-check: the agent captures the VIN twice
 * (e.g. plate OCR + door-jamb barcode, or two visual reads) and the
 * server checks both against each other and the case asset.
 */
export function renderScan(root: HTMLElement, id: string): void {
  root.innerHTML = `<div class="screen">
    ${topbar('Scan VIN', `#/card/${esc(id)}`)}
    <div class="body">
      <div class="notice">Capture the VIN <b>twice</b> — two different methods
      (plate read + barcode, or two visual reads). Both must match each other
      <i>and</i> the case file.</div>
      <div id="err"></div>
      <label class="f" for="a">Scan 1</label>
      <input id="a" class="mono" autocomplete="off" autocapitalize="characters"
        placeholder="17-character VIN" maxlength="24" />
      <label class="f" for="b">Scan 2</label>
      <input id="b" class="mono" autocomplete="off" autocapitalize="characters"
        placeholder="17-character VIN" maxlength="24" />
      <button class="btn" id="go">Verify</button>
      <div id="out"></div>
    </div>
    ${tabbar('map')}
  </div>`;

  const err = root.querySelector<HTMLElement>('#err')!;
  const out = root.querySelector<HTMLElement>('#out')!;
  const btn = root.querySelector<HTMLButtonElement>('#go')!;

  btn.addEventListener('click', async () => {
    err.innerHTML = '';
    out.innerHTML = '';
    const scanA = (root.querySelector('#a') as HTMLInputElement).value.trim();
    const scanB = (root.querySelector('#b') as HTMLInputElement).value.trim();
    if (!scanA || !scanB) {
      err.innerHTML = notice('Enter both scans.', 'bad');
      return;
    }
    btn.disabled = true;
    try {
      const r = (await api.post<{ verification: VinVerifyResult }>(
        `/cases/${encodeURIComponent(id)}/verify-vin`, { scanA, scanB },
      )).verification;
      out.innerHTML = `
        <div class="match ${r.match ? 'yes' : 'no'}">${r.match ? '✓ MATCH' : '✗ MISMATCH'}</div>
        <div class="card"><div class="kv">
          <dt>Scan 1</dt><dd class="mono">${esc(r.scanA) || '—'} ${r.aMatchesAsset ? '✓' : '✗'}</dd>
          <dt>Scan 2</dt><dd class="mono">${esc(r.scanB) || '—'} ${r.bMatchesAsset ? '✓' : '✗'}</dd>
          <dt>Case file</dt><dd class="mono">${esc(r.assetVin)}</dd>
          <dt>Scans agree</dt><dd>${r.aMatchesB ? 'Yes' : 'No'}</dd>
        </div></div>
        ${r.match ? '<div class="notice good">Verified. You can proceed to possession from the case card.</div>'
                  : '<div class="notice bad">Do not take possession — re-check the unit and paperwork.</div>'}`;
    } catch (e) {
      err.innerHTML = notice(e instanceof ApiError ? e.message : 'Verification failed', 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  wireNav(root);
}
