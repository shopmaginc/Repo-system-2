/**
 * Manager dashboard — app shell and router.
 * Views are in ./views/. Each view exports a `render(container)` function.
 */
import { getToken, logout } from './api.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderUsers } from './views/users.js';
import { renderCases } from './views/cases.js';
import { renderReview } from './views/review.js';
import { renderEmails } from './views/emails.js';
import { renderInvoices } from './views/invoices.js';
import { renderReports } from './views/reports.js';
import { renderPermissions } from './views/permissions.js';
import { renderDirectory } from './views/directory.js';

const NAV = [
  { hash: '#/dashboard', label: 'Dashboard', view: renderDashboard },
  { hash: '#/cases', label: 'Cases', view: renderCases },
  { hash: '#/review', label: 'Review Queue', view: renderReview },
  { hash: '#/emails', label: 'Emails', view: renderEmails },
  { hash: '#/invoices', label: 'Invoices', view: renderInvoices },
  { hash: '#/users', label: 'Users', view: renderUsers },
  { hash: '#/directory', label: 'Directory', view: renderDirectory },
  { hash: '#/permissions', label: 'Permissions', view: renderPermissions },
  { hash: '#/reports', label: 'Reports', view: renderReports },
];

function renderShell(container: HTMLElement, activeHash: string): HTMLElement {
  container.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'shell';

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="brand">Repo System</div>
    <div class="brand-sub">Manager</div>
    <nav>${NAV.map(n => `
      <a href="${n.hash}" class="${n.hash === activeHash ? 'active' : ''}">${n.label}</a>
    `).join('')}</nav>
    <button class="logout-btn" id="logoutBtn">Log out</button>
  `;
  sidebar.querySelector('#logoutBtn')?.addEventListener('click', logout);

  const main = document.createElement('main');
  main.className = 'main';
  main.id = 'viewRoot';

  shell.appendChild(sidebar);
  shell.appendChild(main);
  container.appendChild(shell);
  return main;
}

async function route(): Promise<void> {
  const app = document.getElementById('app')!;
  const hash = window.location.hash || '#/dashboard';

  if (!getToken()) {
    if (hash !== '#/login') {
      window.location.hash = '#/login';
      return;
    }
    app.innerHTML = '';
    await renderLogin(app);
    return;
  }

  if (hash === '#/login') {
    window.location.hash = '#/dashboard';
    return;
  }

  const item = NAV.find(n => hash.startsWith(n.hash));
  const main = renderShell(app, item?.hash || '#/dashboard');
  if (item) {
    try {
      await item.view(main);
    } catch (e: any) {
      main.innerHTML = `<div class="error">Failed to load: ${e.message}</div>`;
    }
  } else {
    window.location.hash = '#/dashboard';
  }
}

window.addEventListener('hashchange', route);
route();
