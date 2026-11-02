import { h, mount, toast, modal, field, copyText, actionButton } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { store } from '../store.js';
import { relativeTime, errorMessage, STATE_LABELS } from '../format.js';
import { stateBadge } from './devices.js';
import { homeSelect, homeLabel, sharedMode } from '../access.js';

const TYPES = {
  zigbee2mqtt: { label: 'Zigbee (zigbee2mqtt)', hint: 'Устройства и их свойства мост возьмёт из zigbee2mqtt сам.', profile: 'zigbee' },
  esphome: { label: 'ESPHome (MQTT discovery)', hint: 'В конфигурации ESPHome должен быть компонент mqtt: с discovery. Подходит и для других прошивок с discovery Home Assistant.', profile: 'esphome' },
  tasmota: { label: 'Tasmota', hint: 'Устройства находятся сами (discovery Tasmota 9+). Старые прошивки — перечислите их Topic.', profile: 'tasmota' },
  shelly: { label: 'Shelly (Gen1, Plus, Pro)', hint: 'В Shelly включите MQTT, для Plus/Pro — ещё «Generic status update over MQTT». Устройства находятся сами.', profile: 'shelly' },
  generic: { label: 'Любой MQTT по правилам', hint: 'Каждое правило связывает внешний топик со свойством устройства.', profile: 'generic' },
};

const GENERIC_EXAMPLE = JSON.stringify([
  { topic: 'home/boiler/state', device_key: 'boiler', device_name: 'Котёл', property: 'temperature', type: 'float', json_key: 't', unit: '°C' },
  { topic: 'home/boiler/state', device_key: 'boiler', property: 'pump', type: 'boolean', json_key: 'pump', payload_on: 'ON', payload_off: 'OFF', command_topic: 'home/boiler/pump/set' },
], null, 2);

function configFields(type, config = {}) {
  if (type === 'zigbee2mqtt') {
    const base = h('input', { value: config.base_topic ?? 'zigbee2mqtt' });
    return { el: field('Базовый топик zigbee2mqtt', base), read: () => ({ base_topic: base.value.trim() }) };
  }
  if (type === 'esphome') {
    const prefix = h('input', { value: config.discovery_prefix ?? 'homeassistant' });
    return { el: field('Префикс discovery', prefix, 'В ESPHome это mqtt → discovery_prefix, по умолчанию homeassistant.'), read: () => ({ discovery_prefix: prefix.value.trim() }) };
  }
  const list = (label, value, hint, key) => {
    const input = h('input', { value: (value || []).join(', '), placeholder: 'через запятую, необязательно' });
    return { el: field(label, input, hint), read: () => ({ [key]: input.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) }) };
  };
  if (type === 'tasmota') {
    const prefix = h('input', { value: config.discovery_prefix ?? 'tasmota/discovery' });
    const topics = list('Топики устройств без discovery', config.topics, 'Значение Topic из настроек Tasmota, например kitchen_plug', 'topics');
    return {
      el: h('div', { class: 'stack' }, field('Префикс discovery', prefix), topics.el),
      read: () => ({ discovery_prefix: prefix.value.trim(), ...topics.read() }),
    };
  }
  if (type === 'shelly') {
    const prefixes = list('Только эти устройства', config.prefixes, 'Пусто — все, чей топик начинается с shelly. Иначе — их MQTT-префиксы', 'prefixes');
    const gen1 = h('input', { type: 'checkbox', checked: config.gen1 !== false });
    return {
      el: h('div', { class: 'stack' }, prefixes.el, h('label', { class: 'check' }, gen1, ' Старые Shelly Gen1 (топики shellies/…)')),
      read: () => ({ ...prefixes.read(), gen1: gen1.checked }),
    };
  }
  const area = h('textarea', { spellcheck: 'false', 'aria-label': 'Правила (JSON)' });
  area.value = config.mappings ? JSON.stringify(config.mappings, null, 2) : GENERIC_EXAMPLE;
  return {
    el: field('Правила (JSON)', area, 'Поля: topic, device_key, property, type (boolean|integer|float|string), json_key, unit, command_topic, payload_on/off.'),
    read: () => {
      try { return { mappings: JSON.parse(area.value) }; } catch { throw Object.assign(new Error('validation'), { code: 'validation', details: { field: 'JSON правил' } }); }
    },
  };
}

function envSnippet(bridge, token) {
  const profile = TYPES[bridge.type]?.profile || 'generic';
  return [
    `# .env рядом с docker-compose.yml`,
    `${profile.toUpperCase()}_BRIDGE_ID=${bridge.id}`,
    `${profile.toUpperCase()}_BRIDGE_TOKEN=${token}`,
    '',
    `docker compose --profile ${profile} up -d`,
  ].join('\n');
}

function showToken(bridge, token) {
  const text = envSnippet(bridge, token);
  modal(`Мост «${bridge.name}» создан`, h('div', { class: 'stack' },
    h('p', null, 'Токен показывается один раз. Сохраните его в .env на машине, где будет работать мост.'),
    h('div', { class: 'secret' }, h('code', null, token),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(token) }, 'Копировать')),
    h('pre', { class: 'snippet' }, text),
    h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(text) }, 'Копировать настройки'),
    h('p', { class: 'muted' }, 'Устройства моста появятся в разделе «Устройства», как только он подключится.')));
}

function editDialog(bridge, onSaved) {
  const isNew = !bridge;
  const name = h('input', { value: bridge?.name ?? '', maxlength: 64, required: true, placeholder: 'Например, «Zigbee дома»' });
  const typeSel = h('select', { disabled: !isNew }, ...Object.entries(TYPES).map(([k, t]) => h('option', { value: k }, t.label)));
  typeSel.value = bridge?.type ?? 'zigbee2mqtt';
  const hint = h('p', { class: 'muted' });
  const cfgHost = h('div');
  let cfg;
  const drawCfg = () => {
    cfg = configFields(typeSel.value, bridge?.type === typeSel.value ? bridge.config : {});
    mount(cfgHost, cfg.el);
    hint.textContent = TYPES[typeSel.value].hint;
  };
  typeSel.addEventListener('change', drawCfg);
  drawCfg();
  const error = h('p', { class: 'form-error', role: 'alert' });
  const home = isNew ? homeSelect('admin') : null;
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isNew ? 'Создать мост' : 'Сохранить');
  const dlg = modal(isNew ? 'Новый мост' : `Настройки: ${bridge.name}`,
    h('div', { class: 'stack' }, field('Название', name), home ? field('Дом', home) : null, field('Тип', typeSel), hint, cfgHost, error), [saveBtn]);
  saveBtn.addEventListener('click', async () => {
    error.textContent = '';
    try {
      const body = { name: name.value.trim(), type: typeSel.value, config: cfg.read(), ...(home ? { home: home.value } : {}) };
      if (isNew) {
        const res = await post('/api/bridges', body);
        dlg.close();
        showToken(res.bridge, res.token);
      } else {
        await put(`/api/bridges/${bridge.id}`, body);
        dlg.close();
        toast('Настройки сохранены. Перезапустите контейнер моста, чтобы он их применил.');
      }
      onSaved();
    } catch (e) {
      error.textContent = e.details?.reason ? `${errorMessage(e)}: ${e.details.field} — ${e.details.reason}` : errorMessage(e);
    }
  });
}

/** Устройства моста, удалённые в панели: мост их больше не регистрирует. Здесь их можно вернуть. */
async function ignoredDialog(bridge) {
  const body = h('div', { class: 'stack' });
  const load = async () => {
    try {
      const { ignored } = await get(`/api/bridges/${bridge.id}/ignored`);
      mount(body, ignored.length ? h('div', { class: 'list' }, ...ignored.map((x) => h('div', { class: 'list-row' },
        h('span'),
        h('div', null, h('span', { class: 'title' }, x.name), h('div', { class: 'list-sub' }, h('code', null, x.key))),
        actionButton('Вернуть', async () => {
          try { await del(`/api/bridges/${bridge.id}/ignored/${encodeURIComponent(x.key)}`); toast('Устройство появится, когда мост получит от него данные'); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
        }, 'btn btn-small'))))
        : h('p', { class: 'muted' }, 'Скрытых устройств нет. Устройство моста попадает сюда, когда его удаляют в панели, — чтобы мост не добавил его снова.'));
    } catch (e) { mount(body, h('p', { class: 'form-error' }, errorMessage(e))); }
  };
  await load();
  modal(`Скрытые устройства: ${bridge.name}`, body);
}

export function renderBridges(root) {
  const list = h('div', { class: 'list' });
  const host = h('div');

  const load = async () => {
    try {
      const { bridges } = await get('/api/bridges');
      if (bridges.length === 0) {
        mount(host, h('div', { class: 'empty' },
          h('h2', null, 'Мостов пока нет'),
          h('p', null, 'Мост подключает к платформе устройства, которые не умеют работать с ней напрямую: Zigbee через zigbee2mqtt, прошивки ESPHome и Tasmota, реле Shelly, любые MQTT-устройства по правилам.'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editDialog(null, load) }, 'Добавить мост')));
        return;
      }
      mount(list, ...bridges.map((b) => h('div', { class: 'list-row' },
        stateBadge(b.state === 'new' ? 'new' : b.state),
        h('div', null,
          h('span', { class: 'title' }, b.name),
          h('div', { class: 'list-sub' },
            sharedMode() ? `${homeLabel(b.owner_id)} · ` : '',
            `${TYPES[b.type]?.label || b.type}, устройств: ${b.device_count}, `,
            b.last_seen ? `на связи ${relativeTime(b.last_seen)}` : 'ещё не подключался'),
          h('div', { class: 'list-sub' }, h('code', null, b.id))),
        h('div', { class: 'row-actions', style: { marginTop: 0 } },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => editDialog(b, load) }, 'Настроить'),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => ignoredDialog(b) }, 'Скрытые'),
          actionButton('Новый токен', async () => {
            if (!confirm('Старый токен перестанет работать. Мост нужно будет перезапустить с новым. Продолжить?')) return;
            try { const { token } = await post(`/api/bridges/${b.id}/token`); showToken(b, token); } catch (e) { toast(errorMessage(e), 'error'); }
          }, 'btn btn-small'),
          actionButton('Удалить', async () => {
            if (!confirm(`Удалить мост «${b.name}» и все его устройства (${b.device_count}) вместе с историей?`)) return;
            try { await del(`/api/bridges/${b.id}`); await store.loadDevices(); await load(); toast('Мост удалён'); } catch (e) { toast(errorMessage(e), 'error'); }
          }, 'btn btn-small btn-danger')))));
      mount(host, list);
    } catch (e) {
      mount(host, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };

  mount(root,
    h('header', { class: 'page-head' }, h('h1', null, 'Мосты'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editDialog(null, load) }, 'Добавить мост')),
    host);
  load();
  return () => {};
}

export { STATE_LABELS };
