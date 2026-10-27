import { h, mount, modal, field, copyText, toast } from '../dom.js';
import { post } from '../api.js';
import { store } from '../store.js';
import {
  deviceProps, coerce, formatValue, relativeTime, STATE_LABELS, stateTone, errorMessage,
} from '../format.js';

export function stateBadge(state) {
  return h('span', { class: `state state-${stateTone(state)}` },
    h('span', { class: 'state-dot', 'aria-hidden': 'true' }), STATE_LABELS[state] || state || '—');
}

function readouts(device, limit) {
  const props = deviceProps(device).slice(0, limit);
  return props.map((p) => {
    const v = coerce(device.last_values?.[p.name], p.type);
    const fresh = Date.now() - (store.flash.get(`${device.id}/${p.name}`) || 0) < 1500;
    return h('div', { class: `readout${fresh ? ' is-fresh' : ''}` },
      h('span', { class: 'readout-value' }, formatValue(v, p.type),
        p.unit && v !== null ? h('span', { class: 'readout-unit' }, p.unit) : null),
      h('span', { class: 'readout-name' }, p.name));
  });
}

function row(device) {
  const hiddenCount = Math.max(0, deviceProps(device).length - 4);
  return h('a', { class: 'device-row', href: `#/devices/${device.id}`, dataset: { id: device.id } },
    h('div', { class: 'device-row-head' },
      h('span', { class: 'device-name' }, device.name),
      stateBadge(device.state),
      h('span', { class: 'device-seen' }, relativeTime(device.last_seen))),
    h('div', { class: 'device-row-values' },
      ...readouts(device, 4),
      hiddenCount ? h('span', { class: 'more' }, `+${hiddenCount}`) : null,
      deviceProps(device).length === 0
        ? h('span', { class: 'muted' }, device.provisioned ? 'Данных пока нет' : 'Ждёт привязки') : null));
}

export function showClaimToken(device, claim) {
  const expires = new Date(claim.claim_expires_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  modal(`Привязка: ${device.name}`, h('div', { class: 'stack' },
    h('p', null, `Одноразовый токен действует до ${expires}. Передайте его устройству: через портал настройки или в прошивке.`),
    h('div', { class: 'secret' },
      h('code', null, claim.claim_token),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(claim.claim_token) }, 'Копировать')),
    h('pre', { class: 'snippet' }, `device.setClaimToken("${claim.claim_token}");`),
    h('p', { class: 'muted' }, 'После привязки токен больше не нужен. Устройство появится в списке, как только подключится.')));
}

function addDeviceDialog() {
  const name = h('input', { name: 'name', required: true, maxlength: 64, placeholder: 'Например, «Теплица»', autocomplete: 'off' });
  const submit = h('button', { class: 'btn btn-primary', value: 'ok' }, 'Создать');
  const dlg = modal('Новое устройство', h('div', { class: 'stack' }, field('Название', name)), [submit]);
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok' || !name.value.trim()) return;
    try {
      const res = await post('/api/devices', { name: name.value.trim() });
      store.upsert(res.device);
      showClaimToken(res.device, res);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  });
  setTimeout(() => name.focus(), 0);
}

export function renderDevices(root) {
  const list = h('div', { class: 'device-list' });
  const draw = () => {
    const devices = [...store.devices.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    if (devices.length === 0) {
      mount(list, h('div', { class: 'empty' },
        h('h2', null, 'Устройств пока нет'),
        h('p', null, 'Создайте устройство, получите токен привязки и прошейте ESP32 с SDK IotDevice. Устройства из Zigbee и ESPHome появятся сами после настройки моста.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: addDeviceDialog }, 'Добавить устройство')));
      return;
    }
    mount(list, ...devices.map(row));
  };

  mount(root,
    h('header', { class: 'page-head' },
      h('h1', null, 'Устройства'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: addDeviceDialog }, 'Добавить устройство')),
    list);
  draw();

  const unsub = store.subscribe((ev, p) => {
    if (ev === 'devices') draw();
    if (ev === 'device') {
      const old = list.querySelector(`[data-id="${p.id}"]`);
      const d = store.devices.get(p.id);
      if (old && d) old.replaceWith(row(d));
    }
  });
  const tick = setInterval(draw, 30000); // «N мин назад»
  return () => { unsub(); clearInterval(tick); };
}
