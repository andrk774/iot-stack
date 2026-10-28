import { h, mount, toast, actionButton } from '../dom.js';
import { get, post } from '../api.js';
import { relativeTime, errorMessage } from '../format.js';

const LEVELS = { info: 'Инфо', warning: 'Внимание', alert: 'Тревога' };

export function renderNotifications(root, _params, { refreshBadge }) {
  const list = h('div', { class: 'notes' });

  const load = async () => {
    try {
      const { notifications } = await get('/api/notifications?limit=100');
      if (notifications.length === 0) {
        mount(list, h('div', { class: 'empty' }, h('h2', null, 'Уведомлений нет'),
          h('p', null, 'Сюда пишут сценарии с действием «Уведомить». Telegram, вебхук и push в браузер подключаются в ', h('a', { href: '#/settings' }, 'настройках'), '.')));
        return;
      }
      mount(list, ...notifications.map((n) => h('article', { class: `note note-${n.level}${n.read_at ? '' : ' is-unread'}` },
        h('div', { class: 'note-head' },
          h('span', { class: 'note-level' }, LEVELS[n.level] || n.level),
          n.scenario_id ? h('a', { href: `#/scenarios/${n.scenario_id}` }, n.scenario_name || 'сценарий') : null,
          h('time', { datetime: n.created_at, title: new Date(n.created_at).toLocaleString('ru-RU') }, relativeTime(n.created_at))),
        h('p', null, n.message))));
    } catch (e) {
      mount(list, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };

  mount(root,
    h('header', { class: 'page-head' },
      h('h1', null, 'Уведомления'),
      actionButton('Отметить все прочитанными', async () => {
        try {
          await post('/api/notifications/read', {});
          await load();
          refreshBadge();
        } catch (e) { toast(errorMessage(e), 'error'); }
      })),
    list);
  load();
  return () => {};
}
