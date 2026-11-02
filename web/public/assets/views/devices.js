import { h, mount, modal, field, copyText, toast } from '../dom.js';
import { post, put, del } from '../api.js';
import { store } from '../store.js';
import { homeLabel, homeSelect, sharedMode, ROLE_LABELS } from '../access.js';
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
  const home = homeSelect('admin');
  const submit = h('button', { class: 'btn btn-primary', value: 'ok' }, 'Создать');
  const dlg = modal('Новое устройство', h('div', { class: 'stack' }, field('Название', name), home ? field('Дом', home) : null), [submit]);
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok' || !name.value.trim()) return;
    try {
      const res = await post('/api/devices', { name: name.value.trim(), ...(home ? { home: home.value } : {}) });
      store.upsert(res.device);
      showClaimToken(res.device, res);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  });
  setTimeout(() => name.focus(), 0);
}

/** Комнаты: список, добавить, переименовать, порядок, удалить (только дома, где вы администратор) */
function roomsDialog() {
  const body = h('div', { class: 'stack' });
  const home = homeSelect('admin');
  const homeId = () => home?.value || store.me.id;
  const draw = () => {
    const rooms = store.rooms.filter((r) => r.owner_id === homeId());
    const name = h('input', { maxlength: 40, placeholder: 'Например, «Кухня»' });
    const add = async () => {
      if (!name.value.trim()) return;
      try { await post('/api/rooms', { name: name.value.trim(), ...(home ? { home: home.value } : {}) }); await store.loadRooms(); draw(); } catch (e) { toast(errorMessage(e), 'error'); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    mount(body,
      home ? field('Дом', home) : null,
      rooms.length ? h('div', { class: 'list' }, ...rooms.map((r, i) => {
        const input = h('input', { value: r.name, maxlength: 40, 'aria-label': 'Название комнаты' });
        input.addEventListener('change', async () => {
          try { await put(`/api/rooms/${r.id}`, { name: input.value.trim() }); await store.loadRooms(); } catch (e) { toast(errorMessage(e), 'error'); input.value = r.name; }
        });
        const swap = async (j) => {
          const other = rooms[j];
          try {
            await put(`/api/rooms/${r.id}`, { sort: j });
            await put(`/api/rooms/${other.id}`, { sort: i });
            await store.loadRooms(); draw();
          } catch (e) { toast(errorMessage(e), 'error'); }
        };
        return h('div', { class: 'room-row' }, input,
          h('button', { class: 'btn btn-small', type: 'button', disabled: i === 0, 'aria-label': 'Выше', onclick: () => swap(i - 1) }, '↑'),
          h('button', { class: 'btn btn-small', type: 'button', disabled: i === rooms.length - 1, 'aria-label': 'Ниже', onclick: () => swap(i + 1) }, '↓'),
          h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: async () => {
            if (!confirm(`Удалить комнату «${r.name}»? Устройства останутся, но без комнаты.`)) return;
            try { await del(`/api/rooms/${r.id}`); await store.loadRooms(); await store.loadDevices(); draw(); } catch (e) { toast(errorMessage(e), 'error'); }
          } }, 'Удалить'));
      })) : h('p', { class: 'muted' }, 'Комнат пока нет. Устройство попадает в комнату на своей странице, в блоке «Обслуживание».'),
      h('div', { class: 'inline-form' }, name, h('button', { class: 'btn btn-primary', type: 'button', onclick: add }, 'Добавить комнату')));
  };
  home?.addEventListener('change', draw);
  draw();
  modal('Комнаты', body);
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
    // группы: дом (если их несколько) → комнаты по порядку → «без комнаты»
    const shared = sharedMode();
    const homeOrder = shared ? store.homes.map((x) => x.owner_id) : [null];
    const parts = [];
    for (const owner of homeOrder) {
      const inHome = shared ? devices.filter((d) => d.owner_id === owner) : devices;
      if (!inHome.length) continue;
      const role = store.homes.find((x) => x.owner_id === owner)?.role;
      const rooms = store.rooms.filter((r) => !shared || r.owner_id === owner);
      const byRoom = rooms.map((r) => [r.name, inHome.filter((d) => d.room_id === r.id)]).filter(([, ds]) => ds.length);
      const loose = inHome.filter((d) => !d.room_id || !rooms.some((r) => r.id === d.room_id));
      const prefix = shared ? `${homeLabel(owner)}${role && role !== 'owner' ? ` (${ROLE_LABELS[role]})` : ''}` : '';
      if (!byRoom.length) {
        if (shared) parts.push(h('h2', { class: 'group-title' }, prefix));
        parts.push(...loose.map(row));
        continue;
      }
      for (const [room, ds] of byRoom) {
        parts.push(h('h2', { class: 'group-title' }, prefix ? `${prefix} · ${room}` : room));
        parts.push(...ds.map(row));
      }
      if (loose.length) {
        parts.push(h('h2', { class: 'group-title' }, prefix ? `${prefix} · без комнаты` : 'Без комнаты'));
        parts.push(...loose.map(row));
      }
    }
    mount(list, ...parts);
  };

  mount(root,
    h('header', { class: 'page-head' },
      h('h1', null, 'Устройства'),
      h('div', { class: 'panel-tools' },
        store.homes.some((x) => x.role === 'owner' || x.role === 'admin') ? h('button', { class: 'btn', type: 'button', onclick: roomsDialog }, 'Комнаты') : null,
        h('button', { class: 'btn btn-primary', type: 'button', onclick: addDeviceDialog }, 'Добавить устройство'))),
    list);
  draw();

  const unsub = store.subscribe((ev, p) => {
    if (ev === 'devices' || ev === 'rooms') draw();
    if (ev === 'device') {
      const old = list.querySelector(`[data-id="${p.id}"]`);
      const d = store.devices.get(p.id);
      if (old && d) old.replaceWith(row(d));
    }
  });
  const tick = setInterval(draw, 30000); // «N мин назад»
  return () => { unsub(); clearInterval(tick); };
}
