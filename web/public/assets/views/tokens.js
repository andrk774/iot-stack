// Настройки → API-токены: для скриптов, Home Assistant, Node-RED.
import { h, mount, toast, modal, copyText, actionButton } from '../dom.js';
import { get, post, del } from '../api.js';
import { store } from '../store.js';
import { relativeTime, errorMessage } from '../format.js';

export function tokensSection() {
  const list = h('div', { class: 'list' });
  const load = async () => {
    try {
      const { tokens } = await get('/api/tokens');
      if (tokens.length === 0) { mount(list, h('p', { class: 'empty-inline' }, 'Токенов нет.')); return; }
      mount(list, ...tokens.map((t) => h('div', { class: 'list-row' },
        h('span', { class: 'token-scope' }, t.scope === 'write' ? 'чтение и управление' : 'только чтение'),
        h('div', null,
          h('span', { class: 'title' }, t.name), ' ', h('code', null, `iot_…${t.hint}`),
          h('div', { class: 'list-sub' },
            `создан ${relativeTime(t.created_at)} · `,
            t.last_used_at ? `использован ${relativeTime(t.last_used_at)}` : 'ещё не использовался',
            t.expired ? ' · истёк' : t.expires_at ? ` · действует до ${new Date(t.expires_at).toLocaleDateString('ru-RU')}` : ' · бессрочный')),
        actionButton('Отозвать', async () => {
          if (!confirm(`Отозвать токен «${t.name}»? Скрипты с ним перестанут работать сразу.`)) return;
          try { await del(`/api/tokens/${t.id}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
        }, 'btn btn-small btn-danger'))));
    } catch (e) { mount(list, h('p', { class: 'form-error' }, errorMessage(e))); }
  };

  const name = h('input', { maxlength: 64, placeholder: 'например, «Home Assistant»', 'aria-label': 'Название' });
  const scope = h('select', { 'aria-label': 'Права' },
    h('option', { value: 'read' }, 'только чтение'), h('option', { value: 'write' }, 'чтение и управление'));
  const ttl = h('select', { 'aria-label': 'Срок' },
    h('option', { value: '' }, 'бессрочно'), h('option', { value: '30' }, '30 дней'),
    h('option', { value: '90' }, '90 дней'), h('option', { value: '365' }, 'год'));
  const create = actionButton('Создать токен', async () => {
    try {
      const t = await post('/api/tokens', { name: name.value.trim(), scope: scope.value, expires_days: ttl.value ? Number(ttl.value) : null });
      name.value = '';
      await load();
      const host = location.host;
      modal(`Токен «${t.name}»`, h('div', { class: 'stack' },
        h('p', null, 'Показывается один раз — сохраните его сейчас.'),
        h('div', { class: 'secret' }, h('code', null, t.token),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(t.token) }, 'Копировать')),
        h('pre', { class: 'snippet' }, `curl -H "Authorization: Bearer ${t.token}" https://${host}/api/devices`),
        h('p', { class: 'muted' }, `Живые данные по MQTT (wss://${host}/mqtt): логин u:${store.me?.id}, пароль — этот токен, client id — web-${store.me?.id}-<4–16 строчных букв и цифр>. Подписка только на чтение.`)));
    } catch (e) { toast(errorMessage(e), 'error'); }
  }, 'btn btn-primary');
  load();
  return h('section', { class: 'panel', 'aria-labelledby': 'tokens-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'tokens-title', class: 'section-title' }, 'API-токены')),
    h('p', { class: 'muted' }, 'Для скриптов, Home Assistant, Node-RED: заголовок Authorization: Bearer <токен>. Токен действует от вашего имени, но не даёт менять пароль, сеансы, токены, каналы и участников дома. «Только чтение» пропускает лишь GET-запросы.'),
    list,
    h('div', { class: 'inline-form' }, name, scope, ttl, create));
}
