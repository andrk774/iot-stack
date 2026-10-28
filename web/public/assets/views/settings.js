// Настройки: каналы уведомлений (и далее — безопасность аккаунта).
import { h, mount, toast, modal, field, copyText, actionButton } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { relativeTime, errorMessage } from '../format.js';
import { firmwaresSection } from './ota.js';

export const LEVEL_OPTIONS = { info: 'Все уведомления', warning: 'Внимание и тревога', alert: 'Только тревога' };
const TYPE_LABELS = { telegram: 'Telegram', webhook: 'Вебхук', webpush: 'Браузер' };

const levelSelect = (value) => {
  const sel = h('select', null, ...Object.entries(LEVEL_OPTIONS).map(([k, v]) => h('option', { value: k }, v)));
  sel.value = value || 'info';
  return sel;
};

function channelSub(c) {
  if (c.type === 'telegram') return c.own_bot ? `свой бот, чат ${c.chat_id}` : `чат ${c.chat_title || c.chat_id}`;
  if (c.type === 'webhook') return c.url;
  return c.device || c.endpoint_host || '';
}

function webhookDialog(onSaved) {
  const url = h('input', { type: 'url', placeholder: 'https://example.com/hook', required: true });
  const name = h('input', { maxlength: 64, placeholder: 'Необязательно' });
  const lvl = levelSelect('info');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Добавить');
  const dlg = modal('Вебхук', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Платформа отправит POST с JSON на этот адрес. Подпись — в заголовке X-Iot-Signature (HMAC-SHA256 от «timestamp.тело»).'),
    field('URL', url), field('Название', name), field('Что отправлять', lvl), error), [save]);
  save.addEventListener('click', async () => {
    error.textContent = '';
    try {
      const res = await post('/api/channels', { type: 'webhook', url: url.value.trim(), name: name.value.trim() || undefined, min_level: lvl.value });
      dlg.close();
      onSaved();
      modal('Секрет подписи', h('div', { class: 'stack' },
        h('p', null, 'Показывается один раз. Им проверяется подпись на стороне получателя.'),
        h('div', { class: 'secret' }, h('code', null, res.secret),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(res.secret) }, 'Копировать'))));
    } catch (e) {
      error.textContent = e.details?.reason ? `${errorMessage(e)}: ${e.details.reason}` : errorMessage(e);
    }
  });
}

function ownBotDialog(onSaved) {
  const token = h('input', { autocomplete: 'off', spellcheck: 'false', placeholder: '123456789:AA…' });
  const chat = h('input', { placeholder: '123456789 или -100…' });
  const lvl = levelSelect('info');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Добавить');
  const dlg = modal('Свой Telegram-бот', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Создайте бота у @BotFather, напишите ему что-нибудь и узнайте id чата (например, через @userinfobot).'),
    field('Токен бота', token), field('ID чата', chat), field('Что отправлять', lvl), error), [save]);
  save.addEventListener('click', async () => {
    error.textContent = '';
    try {
      await post('/api/channels', { type: 'telegram', bot_token: token.value.trim(), chat_id: chat.value.trim(), min_level: lvl.value });
      dlg.close();
      onSaved();
      toast('Канал добавлен. Нажмите «Проверить», чтобы отправить тестовое сообщение.');
    } catch (e) {
      error.textContent = errorMessage(e);
    }
  });
}

function notificationsSection() {
  const host = h('div');
  const tools = h('div', { class: 'panel-tools' });
  const section = h('section', { class: 'panel', 'aria-labelledby': 'notify-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'notify-title', class: 'section-title' }, 'Куда присылать уведомления'), tools),
    h('p', { class: 'muted' }, 'Уведомления создают сценарии с действием «Уведомить». В ленте панели они есть всегда, а здесь можно добавить Telegram, вебхук или push в браузер.'),
    host);

  const load = async () => {
    let data;
    try {
      data = await get('/api/channels');
    } catch (e) {
      mount(host, h('p', { class: 'form-error' }, errorMessage(e)));
      return;
    }
    const buttons = [];
    if (data.telegram_bot !== null) {
      buttons.push(actionButton('Подключить Telegram', async () => {
        try {
          const { url } = await post('/api/channels/telegram-link');
          window.open(url, '_blank', 'noopener');
          modal('Подключение Telegram', h('div', { class: 'stack' },
            h('p', null, 'В Telegram откройте бота и нажмите «Запустить» (Start). Ссылка действует 15 минут.'),
            h('p', null, h('a', { href: url, target: '_blank', rel: 'noopener' }, url)),
            h('p', { class: 'muted' }, 'Чат появится в списке после ответа бота.')),
          [h('button', { class: 'btn', value: 'close', onclick: () => setTimeout(load, 100) }, 'Готово')]);
        } catch (e) { toast(errorMessage(e), 'error'); }
      }, 'btn btn-primary'));
    }
    buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => ownBotDialog(load) }, data.telegram_bot !== null ? 'Свой бот' : 'Telegram (свой бот)'));
    buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => webhookDialog(load) }, 'Вебхук'));
    mount(tools, ...buttons);

    if (data.channels.length === 0) {
      mount(host, h('p', { class: 'empty-inline' }, 'Каналов пока нет: уведомления видны только в панели.'));
      return;
    }
    mount(host, h('div', { class: 'list' }, ...data.channels.map((c) => {
      const lvl = levelSelect(c.min_level);
      lvl.setAttribute('aria-label', `Что отправлять в «${c.name}»`);
      lvl.addEventListener('change', async () => {
        try { await put(`/api/channels/${c.id}`, { min_level: lvl.value }); toast('Сохранено'); } catch (e) { toast(errorMessage(e), 'error'); lvl.value = c.min_level; }
      });
      return h('div', { class: 'list-row' },
        h('span', { class: `state ${c.enabled ? 'state-ok' : 'state-muted'}` }, h('span', { class: 'state-dot', 'aria-hidden': 'true' }), TYPE_LABELS[c.type] || c.type),
        h('div', null,
          h('span', { class: 'title' }, c.name),
          h('div', { class: 'list-sub' }, channelSub(c)),
          h('div', { class: 'list-sub' }, c.enabled ? (c.last_sent_at ? `последняя отправка ${relativeTime(c.last_sent_at)}` : 'ещё ничего не отправлялось') : 'выключен'),
          c.last_error ? h('div', { class: 'list-error' }, c.last_error) : null),
        h('div', { class: 'row-actions', style: { marginTop: 0 } },
          lvl,
          actionButton('Проверить', async () => {
            try { await post(`/api/channels/${c.id}/test`); toast('Тестовое сообщение отправлено'); } catch (e) {
              toast(e.details?.reason ? `Не отправилось: ${e.details.reason}` : errorMessage(e), 'error');
            }
            load();
          }, 'btn btn-small'),
          actionButton(c.enabled ? 'Выключить' : 'Включить', async () => {
            try { await put(`/api/channels/${c.id}`, { enabled: !c.enabled }); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
          }, 'btn btn-small'),
          actionButton('Удалить', async () => {
            if (!confirm(`Удалить канал «${c.name}»?`)) return;
            try { await del(`/api/channels/${c.id}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
          }, 'btn btn-small btn-danger')));
    })));
  };
  load();
  return section;
}

export const settingsSections = [notificationsSection, firmwaresSection];

export function renderSettings(root) {
  mount(root, h('header', { class: 'page-head' }, h('h1', null, 'Настройки')), ...settingsSections.map((s) => s()));
  return () => {};
}
