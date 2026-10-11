/**
 * Login view — centered sign-in card with configurable API base URL.
 */
import { login, getApiBase, setApiBase } from '../api.js';

export async function renderLogin(container: HTMLElement): Promise<void> {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;';

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'width:100%;max-width:400px;margin:0;';
  card.innerHTML = `
    <div class="brand" style="color:var(--text);padding:0;margin-bottom:2px;">Repo System</div>
    <p class="page-sub">Manager sign in</p>
    <div class="error" id="loginError" style="display:none;"></div>
    <div class="form-group">
      <label for="loginEmail">Email</label>
      <input id="loginEmail" type="email" autocomplete="username" autofocus />
    </div>
    <div class="form-group">
      <label for="loginPassword">Password</label>
      <input id="loginPassword" type="password" autocomplete="current-password" />
    </div>
    <div class="form-group">
      <label for="loginApiBase">API URL</label>
      <input id="loginApiBase" type="text" spellcheck="false" />
    </div>
    <button class="btn" id="loginBtn" style="width:100%;">Log in</button>
  `;
  wrap.appendChild(card);
  container.appendChild(wrap);

  const emailEl = card.querySelector<HTMLInputElement>('#loginEmail')!;
  const passEl = card.querySelector<HTMLInputElement>('#loginPassword')!;
  const baseEl = card.querySelector<HTMLInputElement>('#loginApiBase')!;
  const btn = card.querySelector<HTMLButtonElement>('#loginBtn')!;
  const errEl = card.querySelector<HTMLElement>('#loginError')!;

  baseEl.value = getApiBase();

  const showError = (msg: string): void => {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  };

  const submit = async (): Promise<void> => {
    errEl.style.display = 'none';
    const email = emailEl.value.trim();
    const password = passEl.value;
    const base = baseEl.value.trim();
    if (!email || !password) {
      showError('Enter your email and password.');
      return;
    }
    if (base) setApiBase(base);
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    try {
      await login(email, password);
      window.location.hash = '#/dashboard';
    } catch (e: unknown) {
      showError(e instanceof Error ? e.message : 'Login failed.');
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  };

  btn.addEventListener('click', () => void submit());
  for (const el of [emailEl, passEl, baseEl]) {
    el.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') void submit();
    });
  }
}
