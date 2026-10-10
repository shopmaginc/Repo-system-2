import './styles.css';
import { isLoggedIn } from './api.js';
import { renderLogin } from './views/login.js';
import { renderMap } from './views/map.js';
import { renderCard } from './views/card.js';
import { renderScan } from './views/scan.js';
import { renderMore } from './views/more.js';
import { renderComms } from './views/comms.js';

const root = document.getElementById('app')!;

async function route(): Promise<void> {
  const hash = location.hash || '#/map';
  window.scrollTo(0, 0);

  if (!isLoggedIn() && !hash.startsWith('#/login')) {
    location.hash = '#/login';
    return;
  }

  try {
    if (hash.startsWith('#/login')) {
      renderLogin(root);
    } else if (hash.startsWith('#/map')) {
      await renderMap(root);
    } else if (hash.startsWith('#/card/')) {
      await renderCard(root, decodeURIComponent(hash.slice('#/card/'.length)));
    } else if (hash.startsWith('#/scan/')) {
      renderScan(root, decodeURIComponent(hash.slice('#/scan/'.length)));
    } else if (hash.startsWith('#/comms')) {
      const rest = hash.slice('#/comms'.length).replace(/^\//, '');
      const [tab, arg] = rest.split('/');
      const t = tab === 'directory' || tab === 'timeoff' ? tab : 'chat';
      await renderComms(root, t, arg ?? '');
    } else if (hash.startsWith('#/more')) {
      await renderMore(root);
    } else {
      location.hash = '#/map';
    }
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="screen"><div class="body"><div class="notice bad">Something went wrong loading this screen.</div></div></div>`;
  }
}

window.addEventListener('hashchange', route);

// PWA service worker (production builds; harmless in dev).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

route();
