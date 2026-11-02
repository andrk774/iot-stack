// Главная: сводка, свои плитки (избранные свойства устройств), быстрые сценарии.
import { h, mount, toast, modal, field, actionButton } from '../dom.js';
import { get, post } from '../api.js';
import { store } from '../store.js';
import { deviceProps, errorMessage } from '../format.js';
import { tile } from './device.js';
import { can } from '../access.js';

function addTileDialog() {
  const devices = [...store.devices.values()].filter((d) => deviceProps(d).length).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!devices.length) { toast('Пока нет устройств со свойствами'); return; }
  const devSel = h('select', null, ...devices.map((d) => h('option', { value: d.id }, d.name)));
  const propSel = h('select');
  const fill = () => {
    const d = store.devices.get(devSel.value);
    mount(propSel, ...deviceProps(d).map((p) => h('option', { value: p.name, disabled: store.onDashboard(d.id, p.name) },
      `${p.name}${p.unit ? `, ${p.unit}` : ''}${store.onDashboard(d.id, p.name) ? ' (уже на главной)' : ''}`)));
    const free = [...propSel.options].find((o) => !o.disabled);
    if (free) propSel.value = free.value;
  };
  devSel.addEventListener('change', fill);
  fill();
  const ok = h('button', { class: 'btn btn-primary', type: 'button' }, 'Добавить');
  const dlg = modal('Плитка на главную', h('div', { class: 'stack' }, field('Устройство', devSel), field('Свойство', propSel)), [ok]);
  ok.addEventListener('click', async () => {
    if (!propSel.value || store.onDashboard(devSel.value, propSel.value)) return;
    try {
      await store.saveDashboard([...store.dashboard, { device_id: devSel.value, property: propSel.value }]);
      dlg.close();
    } catch (e) { toast(errorMessage(e), 'error'); }
  });
}

export function renderHome(root) {
  let editing = false;
  const summary = h('div', { class: 'summary' });
  const tiles = h('div', { class: 'tiles' });
  const quick = h('div');
  const editBtn = h('button', { class: 'btn', type: 'button' });

  const drawSummary = () => {
    const all = [...store.devices.values()].filter((d) => d.provisioned);
    const bad = all.filter((d) => d.state === 'lost' || d.state === 'alert');
    mount(summary,
      h('span', { class: 'summary-item' }, h('strong', null, String(all.filter((d) => d.state === 'ready').length)), ' в сети'),
      h('span', { class: `summary-item${bad.length ? ' is-bad' : ''}` }, h('strong', null, String(bad.length)), ' без связи или в тревоге'),
      ...bad.slice(0, 5).map((d) => h('a', { class: 'summary-link', href: `#/devices/${d.id}` }, d.name)));
  };

  const move = async (i, delta) => {
    const items = [...store.dashboard];
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    try { await store.saveDashboard(items); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const drawTiles = () => {
    editBtn.textContent = editing ? 'Готово' : 'Настроить';
    const items = store.dashboard
      .map((it, i) => ({ it, i, d: store.devices.get(it.device_id) }))
      .filter(({ d }) => d);
    if (!items.length) {
      mount(tiles, h('div', { class: 'empty empty-inline' },
        h('h2', null, 'Здесь будут ваши плитки'),
        h('p', null, 'Отметьте ☆ нужные показания на странице устройства или добавьте плитку здесь: температура в теплице, свет на кухне, котёл на даче — всё на одном экране.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: addTileDialog }, 'Добавить плитку')));
      return;
    }
    mount(tiles, ...items.map(({ it, i, d }) => {
      const spec = deviceProps(d).find((p) => p.name === it.property)
        || { name: it.property, type: 'string', unit: '', settable: false, min: null, max: null };
      const el = tile(d, spec, { withDevice: true });
      if (editing) {
        el.classList.add('is-editing');
        el.append(h('div', { class: 'tile-edit' },
          h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Левее', onclick: () => move(i, -1), disabled: i === 0 }, '←'),
          h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Правее', onclick: () => move(i, 1), disabled: i === store.dashboard.length - 1 }, '→'),
          h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: () => store.toggleDashboard(it.device_id, it.property).catch((e) => toast(errorMessage(e), 'error')) }, 'Убрать')));
      }
      return el;
    }), editing ? h('button', { class: 'tile tile-add', type: 'button', onclick: addTileDialog }, '+ Добавить плитку') : null);
  };

  const loadQuick = async () => {
    try {
      const { scenarios } = await get('/api/scenarios');
      const manual = scenarios.filter((s) => s.trigger.type === 'manual' && s.enabled && can(s, 'control'));
      mount(quick, manual.length ? h('section', { class: 'panel' },
        h('h2', null, 'Быстрые сценарии'),
        h('div', { class: 'row-actions', style: { marginTop: 0 } }, ...manual.map((s) => actionButton(s.name, async () => {
          try { await post(`/api/scenarios/${s.id}/run`); toast(`«${s.name}» запущен`); } catch (e) { toast(errorMessage(e), 'error'); }
        })))) : null);
    } catch { /* не критично */ }
  };

  editBtn.addEventListener('click', () => { editing = !editing; drawTiles(); });
  mount(root,
    h('header', { class: 'page-head' }, h('h1', null, 'Главная'), h('div', { class: 'panel-tools' }, editBtn)),
    summary, tiles, quick);
  drawSummary();
  drawTiles();
  loadQuick();

  const unsub = store.subscribe((ev, p) => {
    if (ev === 'dashboard' || ev === 'devices') { drawTiles(); drawSummary(); return; }
    if (ev === 'device') {
      drawSummary();
      if (p?.ota) return;
      const d = store.devices.get(p.id);
      for (const old of tiles.querySelectorAll(`[data-device="${CSS.escape(p.id)}"]`)) {
        if (p.prop && old.dataset.prop !== p.prop) continue;
        const spec = deviceProps(d).find((x) => x.name === old.dataset.prop);
        if (!spec || editing) continue;
        old.replaceWith(tile(d, spec, { withDevice: true }));
      }
    }
  });
  return unsub;
}
