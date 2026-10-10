import { getApiBase, isLoggedIn, login, setApiBase, ApiError } from '../api.js';
import { esc, notice } from '../ui.js';

export function renderLogin(root: HTMLElement): void {
  if (isLoggedIn()) {
    location.hash = '#/map';
    return;
  }
  root.innerHTML = `<div class="screen">
    <div class="topbar"><h1>Field sign in</h1></div>
    <div class="body">
      <div class="card">
        <h3>Repo Field</h3>
        <p style="color:var(--muted);font-size:.9rem;margin:0 0 8px">Sign in with your company account.</p>
        <div id="err"></div>
        <form id="f">
          <label class="f" for="email">Email</label>
          <input id="email" type="email" autocomplete="username" required />
          <label class="f" for="pw">Password</label>
          <input id="pw" type="password" autocomplete="current-password" required />
          <button class="btn" type="submit">Sign in</button>
        </form>
      </div>
      <div class="card">
        <h3>Server</h3>
        <label class="f" for="base">API address</label>
        <input id="base" class="mono" value="${esc(getApiBase())}" />
        <button class="btn secondary" id="savebase">Save</button>
      </div>
    </div>
  </div>`;

  const form = root.querySelector<HTMLFormElement>('#f')!;
  const err = root.querySelector('#err')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.innerHTML = '';
    const email = (root.querySelector('#email') as HTMLInputElement).value.trim();
    const password = (root.querySelector('#pw') as HTMLInputElement).value;
    try {
      await login(email, password);
      location.hash = '#/map';
    } catch (ex) {
      err.innerHTML = notice(ex instanceof ApiError ? ex.message : 'Sign in failed', 'bad');
    }
  });
  root.querySelector('#savebase')!.addEventListener('click', () => {
    const v = (root.querySelector('#base') as HTMLInputElement).value.trim();
    if (v) {
      setApiBase(v);
      err.innerHTML = notice('Server address saved.', 'good');
    }
  });
}
