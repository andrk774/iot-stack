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
import { renderHome } from './views/home.js';
import { renderOauth } from './views/alice.js';
import { acceptPendingInvite } from './views/members.js';

const app = document.getElementById('app');
let cleanup = () => {};
let shell = null;

const ROUTES = [
  [/^#\/home$/, () => [renderHome, {}], 'home'],
  [/^#\/oauth\?/, () => [renderOauth, {}], 'settings'],
  [/^#\/devices\/([^/]+)$/, (m) => [renderDevice, { id: m[1] }], 'devices'],
  [/^#\/devices$/, () => [renderDevices, {}], 'devices'],
  [/^#\/scenarios\/([^/]+)$/, (m) => [renderScenarioEditor, { id: m[1] }], 'scenarios'],
  [/^#\/scenarios$/, () => [renderScenarios, {}], 'scenarios'],
  [/^#\/bridges$/, () => [renderBridges, {}], 'bridges'],
  [/^#\/notifications$/, () => [renderNotifications, {}], 'notifications'],
  [/^#\/settings$/, () => [renderSettings, {}], 'settings'],
];

const NAV = [
  ['home', '#/home', 'Главная'],
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
    h('a', { class: 'brand', href: '#/home' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Домашний IoT'),
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
  if (!location.hash || location.hash === '#' || location.hash === '#/') { location.hash = '#/home'; return; }
  let found = null;
  for (const [re, make, key] of ROUTES) {
    const m = re.exec(location.hash);
    if (m) { found = [...make(m), key]; break; }
  }
  if (!found) { location.hash = '#/home'; return; }
  const [view, params, key] = found;
  for (const a of shell.nav.querySelectorAll('a')) {
    if (a.dataset.key === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // окна прошлой страницы не должны оставаться поверх новой
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  cleanup();
  cleanup = view(shell.main, params, { refreshBadge }) || (() => {});
  window.scrollTo(0, 0);
}

let badgeTimer;
// Приглашение #/join/<код>: запоминаем до входа, принимаем после
const INVITE_KEY = 'iot.invite';
function takeInviteFromUrl() {
  const m = /^#\/join\/([A-Za-z0-9_-]{32})$/.exec(location.hash);
  if (!m) return;
  try { sessionStorage.setItem(INVITE_KEY, m[1]); } catch { /* приватный режим */ }
  history.replaceState(null, '', `${location.pathname}#/home`);
}
function pendingInvite() {
  try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; }
}
function clearInvite() {
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}

async function start() {
  takeInviteFromUrl();
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
  const invite = pendingInvite();
  if (invite) {
    clearInvite();
    await acceptPendingInvite(invite).catch((e) => toast(errorMessage(e), 'error'));
  }
  shell = buildShell();
  route();
  refreshBadge();
  badgeTimer = setInterval(refreshBadge, 30000);
}

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#/join/')) { start(); return; }
  route();
});
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.code) toast(errorMessage(e.reason), 'error');
});
onAuthChange(() => start());
start();

// PWA: установка на главный экран, работа без сети, push-уведомления
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e.message));
}
