import { h, mount, toast } from './dom.js';
import { get, post, getToken, setToken, onAuthChange } from './api.js';
import { store } from './store.js';
import { errorMessage } from './format.js';
import { renderLogin } from './views/login.js';
import { renderDevices } from './views/devices.js';
import { renderDevice } from './views/device.js';
import { renderScenarios, renderScenarioEditor } from './views/scenarios.js';
import { renderBridges } from './views/bridges.js';
import { renderNotifications } from './views/notifications.js';
import { renderSettings } from './views/settings.js';

const app = document.getElementById('app');
let cleanup = () => {};
let shell = null;

const ROUTES = [
  [/^#\/devices\/([^/]+)$/, (m) => [renderDevice, { id: m[1] }], 'devices'],
  [/^#\/devices$/, () => [renderDevices, {}], 'devices'],
  [/^#\/scenarios\/([^/]+)$/, (m) => [renderScenarioEditor, { id: m[1] }], 'scenarios'],
  [/^#\/scenarios$/, () => [renderScenarios, {}], 'scenarios'],
  [/^#\/bridges$/, () => [renderBridges, {}], 'bridges'],
  [/^#\/notifications$/, () => [renderNotifications, {}], 'notifications'],
  [/^#\/settings$/, () => [renderSettings, {}], 'settings'],
];

const NAV = [
  ['devices', '#/devices', 'Устройства'],
  ['scenarios', '#/scenarios', 'Сценарии'],
  ['bridges', '#/bridges', 'Мосты'],
  ['notifications', '#/notifications', 'Уведомления'],
  ['settings', '#/settings', 'Настройки'],
];

const LIVE_LABELS = { online: 'на связи', connecting: 'подключение…', offline: 'нет связи', error: 'ошибка доступа' };

async function logout() {
  try { await post('/api/auth/logout'); } catch { /* сессия могла уже истечь */ }
  setToken(null);
}

function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Разделы' },
    ...NAV.map(([key, href, label]) => h('a', { href, dataset: { key } }, label,
      key === 'notifications' ? h('span', { class: 'badge', hidden: true }) : null)));
  const live = h('span', { class: 'live', title: 'Живые данные по MQTT' }, h('span', { class: 'live-dot' }), h('span', { class: 'live-text' }));
  const main = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const header = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/devices' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Домашний IoT'),
    nav,
    h('div', { class: 'topbar-end' },
      live,
      h('span', { class: 'who' }, store.me?.email || ''),
      h('button', { class: 'btn btn-small', type: 'button', onclick: logout }, 'Выйти')));
  mount(app, h('a', { class: 'skip', href: '#main' }, 'К содержимому'), header, main);

  const setLive = (s) => {
    live.dataset.status = s;
    live.querySelector('.live-text').textContent = LIVE_LABELS[s] || s;
  };
  setLive(store.liveStatus);
  store.subscribe((ev, s) => { if (ev === 'live') setLive(s); });
  return { nav, main };
}

async function refreshBadge() {
  if (!shell) return;
  try {
    const { unread } = await get('/api/notifications?unread=true&limit=1');
    const badge = shell.nav.querySelector('.badge');
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  } catch { /* не критично */ }
}

function route() {
  if (!getToken()) return;
  if (!location.hash || location.hash === '#' || location.hash === '#/') { location.hash = '#/devices'; return; }
  let found = null;
  for (const [re, make, key] of ROUTES) {
    const m = re.exec(location.hash);
    if (m) { found = [...make(m), key]; break; }
  }
  if (!found) { location.hash = '#/devices'; return; }
  const [view, params, key] = found;
  for (const a of shell.nav.querySelectorAll('a')) {
    if (a.dataset.key === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  cleanup();
  cleanup = view(shell.main, params, { refreshBadge }) || (() => {});
  window.scrollTo(0, 0);
}

let badgeTimer;
async function start() {
  cleanup();
  cleanup = () => {};
  clearInterval(badgeTimer);
  store.stop();
  shell = null;

  if (!getToken()) {
    renderLogin(app);
    return;
  }
  mount(app, h('p', { class: 'loading' }, 'Загрузка…'));
  try {
    await store.init();
  } catch (e) {
    if (getToken()) {
      mount(app, h('div', { class: 'empty' }, h('h2', null, 'Не удалось загрузить данные'), h('p', null, errorMessage(e)),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: start }, 'Повторить')));
    }
    return;
  }
  shell = buildShell();
  route();
  refreshBadge();
  badgeTimer = setInterval(refreshBadge, 30000);
}

window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.code) toast(errorMessage(e.reason), 'error');
});
onAuthChange(() => start());
start();

// PWA: установка на главный экран, работа без сети, push-уведомления
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e.message));
}
