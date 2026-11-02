// Алиса: экран согласия при связке аккаунтов (#/oauth?...) и раздел настроек.
import { h, mount, toast, copyText, actionButton } from '../dom.js';
import { get, post, del } from '../api.js';
import { store } from '../store.js';
import { relativeTime, errorMessage } from '../format.js';

export function renderOauth(root) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const params = { client_id: q.get('client_id') || '', redirect_uri: q.get('redirect_uri') || '', state: q.get('state') || '' };
  const error = h('p', { class: 'form-error', role: 'alert' });
  mount(root, h('section', { class: 'panel consent' },
    h('h1', null, 'Подключить к Алисе?'),
    h('p', null, `Умный дом Яндекса получит доступ к устройствам аккаунта ${store.me?.email || ''}: сможет показывать их показания и управлять ими по вашим голосовым командам и в приложении «Дом с Алисой».`),
    h('p', { class: 'muted' }, 'Доступ можно отозвать в любой момент: Настройки → Алиса, или удалив навык в приложении Яндекса.'),
    error,
    h('div', { class: 'row-actions' },
      actionButton('Разрешить', async () => {
        try {
          const { redirect } = await post('/api/oauth/authorize', params);
          location.href = redirect;
        } catch (e) { error.textContent = errorMessage(e); }
      }, 'btn btn-primary'),
      h('a', { class: 'btn', href: '#/home' }, 'Отмена'))));
  return () => {};
}

export function aliceSection() {
  const host = h('div', { class: 'stack' });
  const base = `${location.protocol}//${location.host}`;
  const row = (label, value) => h('div', { class: 'secret' }, h('span', { class: 'muted', style: { minWidth: '11em' } }, label), h('code', null, value),
    h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(value) }, 'Копировать'));
  const load = async () => {
    let data;
    try {
      data = await get('/api/oauth/links');
    } catch (e) {
      if (e.status === 404) {
        mount(host, h('p', { class: 'muted' }, 'Интеграция выключена на сервере. Чтобы включить, придумайте YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET, впишите их в .env и перезапустите backend. Пошаговая инструкция — в README, раздел «Алиса».'));
        return;
      }
      mount(host, h('p', { class: 'form-error' }, errorMessage(e)));
      return;
    }
    const linked = data.links.length > 0;
    mount(host,
      h('p', null, linked
        ? h('span', { class: 'state state-ok' }, h('span', { class: 'state-dot', 'aria-hidden': 'true' }), `аккаунт связан${data.links[0].last_used_at ? `, Яндекс обращался ${relativeTime(data.links[0].last_used_at)}` : ''}`)
        : 'Аккаунт не связан. В приложении «Дом с Алисой»: «+» → «Устройство умного дома» → найдите свой навык → «Привязать к Яндексу».'),
      linked ? h('div', { class: 'row-actions', style: { marginTop: 0 } }, actionButton('Отвязать', async () => {
        if (!confirm('Отвязать аккаунт от Алисы? Устройства пропадут из приложения Яндекса.')) return;
        try { await del('/api/oauth/links'); toast('Отвязано'); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
      }, 'btn btn-danger')) : null,
      h('details', null, h('summary', null, 'Адреса для консоли Яндекс Диалогов (для владельца сервера)'),
        h('div', { class: 'stack', style: { marginTop: '10px' } },
          row('Endpoint URL', `${base}/yandex`),
          row('URL авторизации', `${base}/oauth/authorize`),
          row('URL для получения токена', `${base}/oauth/token`),
          row('URL для обновления токена', `${base}/oauth/token`),
          h('p', { class: 'field-hint' }, 'Идентификатор и секрет приложения — значения YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET из .env.'))));
  };
  load();
  return h('section', { class: 'panel', 'aria-labelledby': 'alice-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'alice-title', class: 'section-title' }, 'Алиса')),
    h('p', { class: 'muted' }, 'Управление голосом и в приложении «Дом с Алисой»: реле и свет — вкл/выкл, яркость и шторы — проценты, датчики — показания. Каждое второе и следующее реле устройства — отдельное устройство в Яндексе.'),
    host);
}
