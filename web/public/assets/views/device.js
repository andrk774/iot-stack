import { h, mount, toast, copyText, actionButton, modal, field } from '../dom.js';
import { get, post, put, del, getToken } from '../api.js';
import { store } from '../store.js';
import { seriesChart } from '../chart.js';
import {
  deviceProps, coerce, formatValue, relativeTime, errorMessage, RANGES, seriesFromTelemetry,
} from '../format.js';
import { stateBadge, showClaimToken } from './devices.js';
import { otaPanel } from './ota.js';
import { can, homeLabel, sharedMode, ROLE_LABELS } from '../access.js';

async function sendCommand(device, property, value) {
  try {
    await post(`/api/devices/${device.id}/commands`, { property, value });
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}

function control(device, p, current) {
  if (!p.settable || !can(device, 'control')) return null;
  if (p.enum) {
    const sel = h('select', { 'aria-label': `Новое значение ${p.name}` },
      ...p.enum.map((v) => h('option', { value: v }, v)));
    if (p.enum.includes(String(current))) sel.value = String(current);
    const send = actionButton('Отправить', async () => {
      if (await sendCommand(device, p.name, sel.value)) toast(`${p.name}: отправлено ${sel.value}`);
    }, 'btn btn-small');
    return h('div', { class: 'inline-form' }, sel, send);
  }
  if (p.type === 'boolean') {
    const on = current === true;
    const btn = h('button', {
      class: `switch${on ? ' is-on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on),
      'aria-label': `${p.name}: ${on ? 'выключить' : 'включить'}`,
    }, h('span', { class: 'switch-knob' }));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.classList.add('is-pending');
      const ok = await sendCommand(device, p.name, !on);
      // подтверждение придёт от устройства по MQTT; если нет — вернём кнопку через 5 с
      setTimeout(() => { btn.disabled = false; btn.classList.remove('is-pending'); }, ok ? 5000 : 0);
    });
    return btn;
  }

  const isNum = p.type === 'integer' || p.type === 'float';
  const input = h('input', {
    type: isNum ? 'number' : 'text',
    value: current ?? '',
    min: p.min ?? undefined,
    max: p.max ?? undefined,
    step: p.type === 'integer' ? 1 : isNum ? 'any' : undefined,
    maxlength: isNum ? undefined : 256,
    'aria-label': `Новое значение ${p.name}`,
  });
  const send = actionButton('Отправить', async () => {
    let v = input.value.trim();
    if (v === '') return;
    if (isNum) {
      v = Number(v);
      if (!Number.isFinite(v)) return toast('Введите число', 'error');
      if (p.min !== null && v < p.min) return toast(`Минимум ${p.min}`, 'error');
      if (p.max !== null && v > p.max) return toast(`Максимум ${p.max}`, 'error');
    }
    if (await sendCommand(device, p.name, v)) toast(`${p.name}: отправлено ${v}`);
  }, 'btn btn-small');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send.click(); });
  return h('div', { class: 'inline-form' }, input, send);
}

/** Звёздочка «на главную» для свойства */
function starButton(device, p) {
  const on = store.onDashboard(device.id, p.name);
  const b = h('button', {
    class: `star${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on),
    title: on ? 'Убрать с главной' : 'На главную', 'aria-label': `${p.name}: ${on ? 'убрать с главной' : 'на главную'}`,
  }, on ? '★' : '☆');
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    b.disabled = true;
    try { await store.toggleDashboard(device.id, p.name); } catch (err) { toast(errorMessage(err), 'error'); }
    b.disabled = false;
  });
  return b;
}

/** Плитка свойства. withDevice — для главной: над свойством имя устройства со ссылкой */
export function tile(device, p, { withDevice = false } = {}) {
  const v = coerce(device.last_values?.[p.name], p.type);
  const fresh = Date.now() - (store.flash.get(`${device.id}/${p.name}`) || 0) < 1500;
  return h('section', { class: `tile${p.settable && can(device, 'control') ? ' tile-control' : ''}${fresh ? ' is-fresh' : ''}`, dataset: { prop: p.name, device: device.id } },
    h('div', { class: 'tile-head' },
      h('h3', { class: 'tile-name' },
        withDevice ? h('a', { class: 'tile-device', href: `#/devices/${device.id}` }, device.name) : null,
        withDevice ? h('br') : null,
        p.name),
      starButton(device, p)),
    h('div', { class: 'tile-value' },
      formatValue(v, p.type),
      p.unit && v !== null ? h('span', { class: 'readout-unit' }, p.unit) : null),
    p.min !== null || p.max !== null
      ? h('div', { class: 'tile-range' }, `диапазон ${p.min ?? '−∞'} … ${p.max ?? '∞'}`) : null,
    control(device, p, v));
}

const MAX_SERIES = 4;

/** Скачать файл по API с токеном (ссылка с заголовком Authorization невозможна) */
async function downloadCsv(url, fallbackName) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw Object.assign(new Error('csv'), { code: res.status === 400 ? 'validation' : `http_${res.status}` });
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  if (res.headers.get('x-truncated')) toast('Выгружены первые 200 000 строк — сузьте период', 'error');
}

function chartPanel(device) {
  const numeric = deviceProps(device).filter((p) => p.type !== 'string');
  if (numeric.length === 0) return null;
  // выбранные серии: свойства этого устройства и, для сравнения, других
  let selected = [{ deviceId: device.id, prop: numeric[0].name }];
  let range = '24h';
  const body = h('div', { class: 'chart-body' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Свойства на графике' });
  const tabs = h('div', { class: 'segmented', role: 'tablist' });
  const compare = h('select', { 'aria-label': 'Сравнить с другим устройством' });

  const specOf = (deviceId, prop) => deviceProps(store.devices.get(deviceId)).find((p) => p.name === prop);
  const labelOf = (sel) => (sel.deviceId === device.id ? sel.prop : `${store.devices.get(sel.deviceId)?.name || '?'} · ${sel.prop}`);
  const isOn = (deviceId, prop) => selected.some((x) => x.deviceId === deviceId && x.prop === prop);

  const window_ = () => {
    const r = RANGES[range];
    const to = Date.now();
    return { r, to, from: to - r.ms };
  };

  const load = async () => {
    const { r, from, to } = window_();
    mount(body, h('p', { class: 'chart-empty' }, 'Загрузка…'));
    try {
      const series = await Promise.all(selected.map(async (sel) => {
        const q = new URLSearchParams({ property: sel.prop, from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: '5000' });
        if (r.bucket) q.set('bucket', r.bucket);
        const data = await get(`/api/devices/${sel.deviceId}/telemetry?${q}`);
        const spec = specOf(sel.deviceId, sel.prop);
        return { label: labelOf(sel), points: seriesFromTelemetry(data), type: spec?.type, unit: spec?.unit };
      }));
      mount(body, seriesChart(series, { from, to, width: body.clientWidth || 720 }));
    } catch (e) {
      mount(body, h('p', { class: 'chart-empty' }, errorMessage(e)));
    }
  };

  const drawChips = () => {
    mount(chips, ...numeric.map((p) => h('button', {
      type: 'button', class: `chip${isOn(device.id, p.name) ? ' is-on' : ''}`, 'aria-pressed': String(isOn(device.id, p.name)),
      onclick: () => {
        if (isOn(device.id, p.name)) {
          if (selected.length === 1) return;
          selected = selected.filter((x) => !(x.deviceId === device.id && x.prop === p.name));
        } else {
          if (selected.length >= MAX_SERIES) { toast(`На графике до ${MAX_SERIES} линий`); return; }
          selected.push({ deviceId: device.id, prop: p.name });
        }
        drawChips();
        load();
      },
    }, p.name)),
    ...selected.filter((x) => x.deviceId !== device.id).map((x) => h('button', {
      type: 'button', class: 'chip is-on', title: 'Убрать с графика',
      onclick: () => { selected = selected.filter((y) => y !== x); drawChips(); load(); },
    }, `${labelOf(x)} ✕`)));
    const others = [...store.devices.values()].filter((d) => d.id !== device.id)
      .flatMap((d) => deviceProps(d).filter((p) => p.type !== 'string' && !isOn(d.id, p.name)).map((p) => [d, p]))
      .sort(([a], [b]) => a.name.localeCompare(b.name, 'ru'));
    mount(compare, h('option', { value: '' }, 'сравнить с…'),
      ...others.map(([d, p]) => h('option', { value: `${d.id}|${p.name}` }, `${d.name} · ${p.name}`)));
    compare.hidden = others.length === 0;
  };
  compare.addEventListener('change', () => {
    if (!compare.value) return;
    if (selected.length >= MAX_SERIES) { toast(`На графике до ${MAX_SERIES} линий`); compare.value = ''; return; }
    const [deviceId, prop] = compare.value.split('|');
    selected.push({ deviceId, prop });
    drawChips();
    load();
  });

  const drawTabs = () => mount(tabs, ...Object.entries(RANGES).map(([k, r]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(k === range), class: k === range ? 'is-active' : '',
    onclick: () => { range = k; drawTabs(); load(); },
  }, r.label)));

  const csv = actionButton('CSV', async () => {
    const { r, from, to } = window_();
    const props = selected.filter((x) => x.deviceId === device.id).map((x) => x.prop);
    const q = new URLSearchParams({ properties: props.join(','), from: new Date(from).toISOString(), to: new Date(to).toISOString(), format: 'excel' });
    if (r.bucket) q.set('bucket', r.bucket);
    try { await downloadCsv(`/api/devices/${device.id}/telemetry.csv?${q}`, `${device.id}.csv`); } catch (e) { toast(errorMessage(e), 'error'); }
  }, 'btn btn-small');
  csv.title = 'Выгрузить выбранные свойства этого устройства за период (для Excel)';

  drawChips();
  drawTabs();
  load();
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'История'), h('div', { class: 'panel-tools' }, tabs, csv)),
    h('div', { class: 'panel-head', style: { marginBottom: '8px' } }, chips, compare),
    body);
}

function renameDialog(device) {
  const name = h('input', { value: device.name, maxlength: 64, required: true });
  const dlg = modal('Переименовать', field('Название', name), [h('button', { class: 'btn btn-primary', value: 'ok' }, 'Сохранить')]);
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    try {
      const d = await put(`/api/devices/${device.id}`, { name: name.value.trim() });
      store.upsert(d);
    } catch (e) { toast(errorMessage(e), 'error'); }
  });
}

export function renderDevice(root, { id }) {
  let device = store.devices.get(id);
  if (!device) {
    mount(root, h('div', { class: 'empty' }, h('h2', null, 'Устройство не найдено'),
      h('a', { class: 'btn', href: '#/devices' }, 'К списку устройств')));
    return () => {};
  }

  const tiles = h('div', { class: 'tiles' });
  const head = h('div');
  const drawHead = () => mount(head, h('header', { class: 'page-head' },
    h('div', null,
      h('a', { class: 'back', href: '#/devices' }, 'Устройства'),
      h('h1', null, device.name),
      h('div', { class: 'meta-line' },
        stateBadge(device.state),
        h('span', null, `обновлено ${relativeTime(device.last_seen)}`),
        device.meta?.fw ? h('span', null, `прошивка ${device.meta.fw}`) : null,
        device.bridge_id ? h('a', { href: '#/bridges' }, 'через мост') : null,
        sharedMode() ? h('span', null, homeLabel(device.owner_id)) : null,
        device.my_role && device.my_role !== 'owner' ? h('span', null, `ваш доступ: ${ROLE_LABELS[device.my_role]}`) : null)),
    can(device, 'admin') ? h('button', { class: 'btn', type: 'button', onclick: () => renameDialog(device) }, 'Переименовать') : null));

  const drawTiles = () => {
    const props = deviceProps(device);
    if (props.length === 0) {
      mount(tiles, h('div', { class: 'empty empty-inline' },
        h('p', null, device.provisioned
          ? 'Устройство привязано, но ещё ничего не прислало.'
          : 'Устройство ждёт привязки. Создайте токен и передайте его устройству.'),
        device.provisioned || device.bridge_id || !can(device, 'admin') ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: reclaim }, 'Получить токен привязки')));
      return;
    }
    mount(tiles, ...props.map((p) => tile(device, p)));
  };

  const reclaim = async () => {
    if (device.provisioned && !confirm('Старая учётка устройства перестанет работать. Продолжить?')) return;
    try {
      const claim = await post(`/api/devices/${device.id}/claim`);
      device.provisioned = false;
      device.state = 'new';
      drawHead();
      showClaimToken(device, claim);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const remove = async () => {
    const text = device.bridge_id
      ? `Удалить «${device.name}» вместе с историей? Мост больше не будет его добавлять; вернуть можно в «Мосты → Скрытые».`
      : `Удалить «${device.name}» вместе с историей?`;
    if (!confirm(text)) return;
    try {
      await del(`/api/devices/${device.id}`);
      store.remove(device.id);
      location.hash = '#/devices';
      toast('Устройство удалено');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  // комната: администратор выбирает, остальные видят
  const factsHost = h('div');
  const drawFacts = () => {
    const rooms = store.rooms.filter((r) => r.owner_id === device.owner_id || !device.owner_id);
    if (!can(device, 'admin')) {
      mount(factsHost, device.room_id ? h('p', null, `Комната: ${store.roomName(device.room_id) || '—'}`) : null);
      return;
    }
    const sel = h('select', { 'aria-label': 'Комната' }, h('option', { value: '' }, 'без комнаты'),
      ...rooms.map((r) => h('option', { value: r.id }, r.name)));
    sel.value = device.room_id || '';
    sel.addEventListener('change', async () => {
      try {
        const d = await put(`/api/devices/${device.id}`, { room_id: sel.value || null });
        store.upsert(d);
        toast('Комната сохранена');
      } catch (e) { toast(errorMessage(e), 'error'); sel.value = device.room_id || ''; }
    });
    mount(factsHost, h('div', { class: 'inline-form', style: { marginTop: 0, marginBottom: '12px', alignItems: 'center' } },
      h('span', null, 'Комната'), sel,
      rooms.length ? null : h('a', { href: '#/devices', class: 'muted' }, 'комнаты создаются на странице «Устройства»')));
  };

  const chartHost = h('div');
  const drawChart = () => mount(chartHost, chartPanel(device));
  // OTA — только для устройств со своей прошивкой на нашем SDK (не через мост)
  const ota = !device.bridge_id && device.provisioned && can(device, 'admin') ? otaPanel(device) : null;

  mount(root, head, tiles, chartHost, ota?.el,
    h('section', { class: 'panel panel-quiet' },
      h('h2', null, 'Обслуживание'),
      factsHost,
      h('dl', { class: 'facts' },
        h('dt', null, 'ID'), h('dd', null, h('code', null, device.id), ' ',
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(device.id) }, 'Копировать')),
        h('dt', null, 'Топики'), h('dd', null, h('code', null, `dev/${device.id}/…`)),
        h('dt', null, 'Создано'), h('dd', null, new Date(device.created_at).toLocaleString('ru-RU'))),
      can(device, 'admin') ? h('div', { class: 'row-actions' },
        device.bridge_id ? null : h('button', { class: 'btn', type: 'button', onclick: reclaim }, 'Перепривязать'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Удалить устройство')) : null));

  drawHead();
  drawTiles();
  drawChart();
  drawFacts();

  const unsub = store.subscribe((ev, p) => {
    if (ev === 'dashboard') { drawTiles(); return; }
    if ((ev === 'device' && p.id === id) || ev === 'devices') {
      device = store.devices.get(id);
      if (!device) return;
      if (p?.ota) { ota?.live(p.ota); return; }
      drawHead();
      if (p?.meta) ota?.setDevice(device);
      if (p?.meta || ev === 'devices') { drawTiles(); drawChart(); drawFacts(); return; }
      if (p?.prop) {
        const old = tiles.querySelector(`[data-prop="${CSS.escape(p.prop)}"]`);
        const spec = deviceProps(device).find((x) => x.name === p.prop);
        if (old && spec) old.replaceWith(tile(device, spec));
        else drawTiles();
      }
    }
  });
  return unsub;
}
