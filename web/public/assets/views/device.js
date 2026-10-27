import { h, mount, toast, copyText, actionButton, modal, field } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { store } from '../store.js';
import { lineChart } from '../chart.js';
import {
  deviceProps, coerce, formatValue, relativeTime, errorMessage, RANGES, seriesFromTelemetry,
} from '../format.js';
import { stateBadge, showClaimToken } from './devices.js';

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
  if (!p.settable) return null;
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

function tile(device, p) {
  const v = coerce(device.last_values?.[p.name], p.type);
  const fresh = Date.now() - (store.flash.get(`${device.id}/${p.name}`) || 0) < 1500;
  return h('section', { class: `tile${p.settable ? ' tile-control' : ''}${fresh ? ' is-fresh' : ''}`, dataset: { prop: p.name } },
    h('h3', { class: 'tile-name' }, p.name),
    h('div', { class: 'tile-value' },
      formatValue(v, p.type),
      p.unit && v !== null ? h('span', { class: 'readout-unit' }, p.unit) : null),
    p.min !== null || p.max !== null
      ? h('div', { class: 'tile-range' }, `диапазон ${p.min ?? '−∞'} … ${p.max ?? '∞'}`) : null,
    control(device, p, v));
}

function chartPanel(device) {
  const numeric = deviceProps(device).filter((p) => p.type !== 'string');
  if (numeric.length === 0) return null;
  let prop = numeric[0];
  let range = '24h';
  const body = h('div', { class: 'chart-body' });
  const select = h('select', { 'aria-label': 'Свойство' },
    ...numeric.map((p) => h('option', { value: p.name }, p.name)));
  const tabs = h('div', { class: 'segmented', role: 'tablist' });

  const load = async () => {
    const r = RANGES[range];
    const to = Date.now();
    const from = to - r.ms;
    const q = new URLSearchParams({ property: prop.name, from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: '5000' });
    if (r.bucket) q.set('bucket', r.bucket);
    mount(body, h('p', { class: 'chart-empty' }, 'Загрузка…'));
    try {
      const data = await get(`/api/devices/${device.id}/telemetry?${q}`);
      mount(body, lineChart(seriesFromTelemetry(data), { type: prop.type, unit: prop.unit, from, to, width: body.clientWidth || 720 }));
    } catch (e) {
      mount(body, h('p', { class: 'chart-empty' }, errorMessage(e)));
    }
  };

  const drawTabs = () => mount(tabs, ...Object.entries(RANGES).map(([k, r]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(k === range), class: k === range ? 'is-active' : '',
    onclick: () => { range = k; drawTabs(); load(); },
  }, r.label)));

  select.addEventListener('change', () => { prop = numeric.find((p) => p.name === select.value); load(); });
  drawTabs();
  load();
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'История'), h('div', { class: 'panel-tools' }, select, tabs)),
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
        device.bridge_id ? h('a', { href: '#/bridges' }, 'через мост') : null)),
    h('button', { class: 'btn', type: 'button', onclick: () => renameDialog(device) }, 'Переименовать')));

  const drawTiles = () => {
    const props = deviceProps(device);
    if (props.length === 0) {
      mount(tiles, h('div', { class: 'empty empty-inline' },
        h('p', null, device.provisioned
          ? 'Устройство привязано, но ещё ничего не прислало.'
          : 'Устройство ждёт привязки. Создайте токен и передайте его устройству.'),
        device.provisioned || device.bridge_id ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: reclaim }, 'Получить токен привязки')));
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
    if (!confirm(`Удалить «${device.name}» вместе с историей?`)) return;
    try {
      await del(`/api/devices/${device.id}`);
      store.remove(device.id);
      location.hash = '#/devices';
      toast('Устройство удалено');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const chartHost = h('div');
  const drawChart = () => mount(chartHost, chartPanel(device));

  mount(root, head, tiles, chartHost,
    h('section', { class: 'panel panel-quiet' },
      h('h2', null, 'Обслуживание'),
      h('dl', { class: 'facts' },
        h('dt', null, 'ID'), h('dd', null, h('code', null, device.id), ' ',
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(device.id) }, 'Копировать')),
        h('dt', null, 'Топики'), h('dd', null, h('code', null, `dev/${device.id}/…`)),
        h('dt', null, 'Создано'), h('dd', null, new Date(device.created_at).toLocaleString('ru-RU'))),
      h('div', { class: 'row-actions' },
        device.bridge_id ? null : h('button', { class: 'btn', type: 'button', onclick: reclaim }, 'Перепривязать'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Удалить устройство'))));

  drawHead();
  drawTiles();
  drawChart();

  const unsub = store.subscribe((ev, p) => {
    if ((ev === 'device' && p.id === id) || ev === 'devices') {
      device = store.devices.get(id);
      if (!device) return;
      drawHead();
      if (p?.meta || ev === 'devices') { drawTiles(); drawChart(); return; }
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
