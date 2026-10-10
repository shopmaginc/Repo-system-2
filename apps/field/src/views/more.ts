import QRCode from 'qrcode';
import { api, logout, type MeUser, ApiError } from '../api.js';
import { esc, topbar, tabbar, notice, wireNav } from '../ui.js';

/** Company name shown on badges and business cards. */
const COMPANY_NAME = 'Complete Recovery Solutions';

export async function renderMore(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="screen">
    ${topbar('More')}
    <div class="body" id="body"><div class="center">Loading…</div></div>
    ${tabbar('more')}
  </div>`;
  const body = root.querySelector<HTMLElement>('#body')!;

  let me: MeUser;
  try {
    me = (await api.get<{ user: MeUser }>('/auth/me')).user;
  } catch (e) {
    body.innerHTML = notice(e instanceof ApiError ? e.message : 'Could not load profile', 'bad');
    return;
  }

  const initials = me.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const badgeId = `CRS-${me.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()}`;

  body.innerHTML = `
    <div class="badge">
      <div class="face">${esc(initials)}</div>
      <h2>${esc(me.name)}</h2>
      <div class="role">${esc(prettyRole(me.role))}</div>
      <div style="color:var(--muted)">${esc(COMPANY_NAME)}</div>
      <div class="id">Badge ${esc(badgeId)}<br>Verify with dispatch — valid only while employed.</div>
    </div>
    <div class="card">
      <h3>Digital business card</h3>
      <div class="qrbox"><img id="qr" alt="Business card QR code" /></div>
      <p style="color:var(--muted);font-size:.85rem;margin:0">Have the person scan this with their phone camera to save your contact.</p>
    </div>
    <button class="rowlink" id="logout"><span class="ico">🚪</span><span>Sign out<small>End this session on this device</small></span></button>`;

  // vCard QR, generated on-device — nothing leaves the phone.
  const vcard = [
    'BEGIN:VCARD', 'VERSION:3.0',
    `FN:${me.name}`, `ORG:${COMPANY_NAME}`, `TITLE:${prettyRole(me.role)}`,
    `EMAIL:${me.email}`,
    'END:VCARD',
  ].join('\n');
  try {
    (body.querySelector('#qr') as HTMLImageElement).src = await QRCode.toDataURL(vcard, { width: 440, margin: 1 });
  } catch {
    body.querySelector('.qrbox')!.innerHTML = notice('Could not generate QR code.', 'bad');
  }

  body.querySelector('#logout')!.addEventListener('click', async () => {
    await logout();
    location.hash = '#/login';
  });

  wireNav(root);
}

function prettyRole(role: string): string {
  return role.split('_').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}
