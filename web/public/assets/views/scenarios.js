import { h, mount, toast, actionButton, field } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { store } from '../store.js';
import { deviceProps, relativeTime, errorMessage } from '../format.js';

const OP_LABELS = { gt: 'больше', gte: 'не меньше', lt: 'меньше', lte: 'не больше', eq: 'равно', ne: 'не равно', changed: 'изменилось' };
const STATES = { lost: 'нет связи', ready: 'в сети', alert: 'тревога', sleeping: 'спит' };
const LEVELS = { info: 'обычное', warning: 'внимание', alert: 'тревога' };
const CRON_PRESETS = [
  ['0 7 * * *', 'каждый день в 7:00'],
  ['0 8 * * 1-5', 'по будням в 8:00'],
  ['0 22 * * *', 'каждый вечер в 22:00'],
  ['0 * * * *', 'каждый час'],
  ['*/15 * * * *', 'каждые 15 минут'],
];
const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();

// ---------- описание сценария словами ----------
const devName = (id) => store.devices.get(id)?.name || 'удалённое устройство';
const fmtVal = (v) => (v === true ? 'вкл' : v === false ? 'выкл' : String(v));

export function describeTrigger(t) {
  if (!t) return '';
  if (t.type === 'property') {
    return t.op === 'changed'
      ? `когда ${devName(t.device_id)} · ${t.property} изменилось`
      : `когда ${devName(t.device_id)} · ${t.property} ${OP_LABELS[t.op]} ${fmtVal(t.value)}`;
  }
  if (t.type === 'state') return `когда ${devName(t.device_id)}: ${STATES[t.state] || t.state}`;
  if (t.type === 'schedule') {
    const preset = CRON_PRESETS.find(([c]) => c === t.cron);
    return `по расписанию: ${preset ? preset[1] : t.cron}`;
  }
  return 'только вручную';
}

// ---------- список ----------
export function renderScenarios(root) {
  const list = h('div', { class: 'list' });
  const load = async () => {
    try {
      const { scenarios } = await get('/api/scenarios');
      if (scenarios.length === 0) {
        mount(root.querySelector('.list-host'), h('div', { class: 'empty' },
          h('h2', null, 'Сценариев пока нет'),
          h('p', null, 'Сценарий выполняет действия сам: например, включает вентилятор, когда в теплице жарче 30 °C, или присылает уведомление, если датчик пропал из сети.'),
          h('a', { class: 'btn btn-primary', href: '#/scenarios/new' }, 'Создать сценарий')));
        return;
      }
      mount(list, ...scenarios.map((s) => {
        const toggle = h('button', {
          class: `switch${s.enabled ? ' is-on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(s.enabled),
          'aria-label': `${s.name}: ${s.enabled ? 'выключить' : 'включить'}`,
        }, h('span', { class: 'switch-knob' }));
        toggle.addEventListener('click', async () => {
          toggle.disabled = true;
          try {
            await put(`/api/scenarios/${s.id}`, { ...s, enabled: !s.enabled });
            await load();
          } catch (e) { toast(errorMessage(e), 'error'); toggle.disabled = false; }
        });
        return h('div', { class: 'list-row' },
          toggle,
          h('div', null,
            h('a', { class: 'title', href: `#/scenarios/${s.id}` }, s.name),
            h('div', { class: 'list-sub' }, describeTrigger(s.trigger),
              s.last_run_at ? ` · запускался ${relativeTime(s.last_run_at)}` : ''),
            s.last_error ? h('div', { class: 'list-error' }, s.last_error) : null),
          s.trigger.type === 'manual' || s.enabled
            ? actionButton('Запустить', async () => {
              try { await post(`/api/scenarios/${s.id}/run`); toast(`«${s.name}» запущен`); } catch (e) { toast(errorMessage(e), 'error'); }
            }, 'btn btn-small') : h('span'));
      }));
    } catch (e) {
      mount(list, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };
  mount(root,
    h('header', { class: 'page-head' }, h('h1', null, 'Сценарии'),
      h('a', { class: 'btn btn-primary', href: '#/scenarios/new' }, 'Создать сценарий')),
    h('div', { class: 'list-host' }, list));
  load();
  return () => {};
}

// ---------- редактор ----------
function deviceSelect(value, onChange, filter = () => true) {
  const devices = [...store.devices.values()].filter(filter).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const sel = h('select', { 'aria-label': 'Устройство' },
    h('option', { value: '' }, '— устройство —'),
    ...devices.map((d) => h('option', { value: d.id, selected: d.id === value }, d.name)));
  sel.value = value || '';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function propSelect(deviceId, value, onChange, onlySettable = false) {
  const d = store.devices.get(deviceId);
  const props = d ? deviceProps(d).filter((p) => !onlySettable || p.settable) : [];
  if (props.length === 0) {
    const inp = h('input', { value: value || '', placeholder: 'свойство', 'aria-label': 'Свойство', maxlength: 32 });
    inp.addEventListener('change', () => onChange(inp.value.trim()));
    return inp;
  }
  const sel = h('select', { 'aria-label': 'Свойство' },
    h('option', { value: '' }, '— свойство —'),
    ...props.map((p) => h('option', { value: p.name, selected: p.name === value }, p.unit ? `${p.name}, ${p.unit}` : p.name)));
  sel.value = value || '';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function propType(deviceId, prop) {
  const d = store.devices.get(deviceId);
  return d ? deviceProps(d).find((p) => p.name === prop)?.type : null;
}

function valueInput(type, value, onChange) {
  if (type === 'boolean') {
    const sel = h('select', { 'aria-label': 'Значение' },
      h('option', { value: 'true' }, 'вкл'), h('option', { value: 'false' }, 'выкл'));
    sel.value = value === false || value === 'false' ? 'false' : 'true';
    onChange(sel.value === 'true');
    sel.addEventListener('change', () => onChange(sel.value === 'true'));
    return sel;
  }
  const num = type === 'integer' || type === 'float';
  const inp = h('input', { type: num ? 'number' : 'text', step: type === 'integer' ? 1 : 'any', value: value ?? '', placeholder: 'значение', 'aria-label': 'Значение', maxlength: 256 });
  const read = () => {
    const raw = inp.value.trim();
    if (num) return raw === '' ? undefined : Number(raw);
    // для неизвестного типа: число, если похоже
    if (!type && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
    return raw;
  };
  inp.addEventListener('input', () => onChange(read()));
  return inp;
}

function comparisonRow(c, rerender, { allowChanged }) {
  const ops = Object.entries(OP_LABELS).filter(([k]) => allowChanged || k !== 'changed');
  const opSel = h('select', { 'aria-label': 'Условие' }, ...ops.map(([k, l]) => h('option', { value: k }, l)));
  opSel.value = c.op || 'gt';
  c.op = opSel.value;
  opSel.addEventListener('change', () => { c.op = opSel.value; rerender(); });
  return h('div', { class: 'rule-fields' },
    deviceSelect(c.device_id, (v) => { c.device_id = v; c.property = ''; rerender(); }),
    propSelect(c.device_id, c.property, (v) => { c.property = v; rerender(); }),
    opSel,
    c.op === 'changed' ? null : valueInput(propType(c.device_id, c.property), c.value, (v) => { c.value = v; }));
}

export function renderScenarioEditor(root, { id }) {
  const isNew = id === 'new';
  let s = {
    name: '', enabled: true, cooldown_sec: 0,
    trigger: { type: 'property', op: 'gt' },
    conditions: [],
    actions: [{ type: 'set' }],
  };

  const triggerHost = h('div', { class: 'stack' });
  const condHost = h('div', { class: 'stack' });
  const actionHost = h('div', { class: 'stack' });
  const nameInput = h('input', { maxlength: 100, required: true, placeholder: 'Например, «Проветрить теплицу»' });
  const cooldown = h('input', { type: 'number', min: 0, max: 86400, step: 1, value: '0' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const drawTrigger = () => {
    const t = s.trigger;
    const typeSel = h('select', { 'aria-label': 'Тип запуска' },
      h('option', { value: 'property' }, 'Значение свойства'),
      h('option', { value: 'state' }, 'Состояние устройства'),
      h('option', { value: 'schedule' }, 'Расписание'),
      h('option', { value: 'manual' }, 'Только вручную'));
    typeSel.value = t.type;
    typeSel.addEventListener('change', () => {
      s.trigger = { type: typeSel.value, ...(typeSel.value === 'property' ? { op: 'gt' } : {}),
        ...(typeSel.value === 'state' ? { state: 'lost' } : {}),
        ...(typeSel.value === 'schedule' ? { cron: '0 7 * * *', tz: browserTz } : {}) };
      drawTrigger();
    });

    let body = null;
    if (t.type === 'property') body = comparisonRow(t, drawTrigger, { allowChanged: true });
    if (t.type === 'state') {
      const st = h('select', { 'aria-label': 'Состояние' }, ...Object.entries(STATES).map(([k, l]) => h('option', { value: k }, l)));
      st.value = t.state || 'lost';
      st.addEventListener('change', () => { t.state = st.value; });
      body = h('div', { class: 'rule-fields' }, deviceSelect(t.device_id, (v) => { t.device_id = v; }), h('span', null, 'перешло в'), st);
    }
    if (t.type === 'schedule') {
      const cron = h('input', { value: t.cron || '', 'aria-label': 'Cron', placeholder: 'мин час день месяц день_недели', style: { fontFamily: 'var(--mono)' } });
      cron.addEventListener('input', () => { t.cron = cron.value.trim(); });
      const preset = h('select', { 'aria-label': 'Готовое расписание' },
        h('option', { value: '' }, 'готовые варианты…'), ...CRON_PRESETS.map(([c, l]) => h('option', { value: c }, l)));
      preset.addEventListener('change', () => { if (preset.value) { t.cron = preset.value; cron.value = preset.value; } });
      const tz = h('input', { value: t.tz || browserTz, 'aria-label': 'Часовой пояс' });
      tz.addEventListener('input', () => { t.tz = tz.value.trim(); });
      body = h('div', { class: 'stack' },
        h('div', { class: 'rule-fields' }, cron, preset),
        field('Часовой пояс', tz, 'Формат cron: минута, час, день месяца, месяц, день недели (0 или 7 — воскресенье).'));
    }
    if (t.type === 'manual') body = h('p', { class: 'muted' }, 'Сценарий выполняется только по кнопке «Запустить».');
    mount(triggerHost, h('div', { class: 'rule' }, h('div', { class: 'rule-fields' }, typeSel), body));
  };

  const drawConditions = () => {
    mount(condHost,
      ...s.conditions.map((c, i) => h('div', { class: 'rule' },
        h('div', { class: 'rule-head' }, h('span', { class: 'rule-title' }, 'и при этом'),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => { s.conditions.splice(i, 1); drawConditions(); } }, 'Убрать')),
        comparisonRow(c, drawConditions, { allowChanged: false }))),
      s.conditions.length < 10
        ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => { s.conditions.push({ op: 'eq' }); drawConditions(); } }, 'Добавить условие')
        : null);
  };

  const drawActions = () => {
    mount(actionHost,
      ...s.actions.map((a, i) => {
        const typeSel = h('select', { 'aria-label': 'Действие' },
          h('option', { value: 'set' }, 'Установить свойство'),
          h('option', { value: 'notify' }, 'Уведомить'),
          h('option', { value: 'delay' }, 'Пауза'));
        typeSel.value = a.type;
        typeSel.addEventListener('change', () => { s.actions[i] = { type: typeSel.value, ...(typeSel.value === 'notify' ? { level: 'info' } : {}) }; drawActions(); });
        let fields = null;
        if (a.type === 'set') {
          fields = [
            deviceSelect(a.device_id, (v) => { a.device_id = v; a.property = ''; drawActions(); }),
            propSelect(a.device_id, a.property, (v) => { a.property = v; drawActions(); }, true),
            valueInput(propType(a.device_id, a.property), a.value, (v) => { a.value = v; }),
          ];
        }
        if (a.type === 'notify') {
          const msg = h('input', { value: a.message || '', maxlength: 500, placeholder: 'Текст, можно {device}, {property}, {value}', style: { flex: '1 1 260px' }, 'aria-label': 'Текст уведомления' });
          msg.addEventListener('input', () => { a.message = msg.value; });
          const lvl = h('select', { 'aria-label': 'Важность' }, ...Object.entries(LEVELS).map(([k, l]) => h('option', { value: k }, l)));
          lvl.value = a.level || 'info';
          lvl.addEventListener('change', () => { a.level = lvl.value; });
          fields = [msg, lvl];
        }
        if (a.type === 'delay') {
          const sec = h('input', { type: 'number', min: 1, max: 3600, value: a.seconds ?? 60, 'aria-label': 'Секунды' });
          a.seconds = Number(sec.value);
          sec.addEventListener('input', () => { a.seconds = Number(sec.value); });
          fields = [sec, h('span', null, 'секунд')];
        }
        return h('div', { class: 'rule' },
          h('div', { class: 'rule-head' }, h('span', { class: 'rule-title' }, `Шаг ${i + 1}`),
            s.actions.length > 1
              ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => { s.actions.splice(i, 1); drawActions(); } }, 'Убрать')
              : null),
          h('div', { class: 'rule-fields' }, typeSel, ...(fields || [])));
      }),
      s.actions.length < 10
        ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => { s.actions.push({ type: 'set' }); drawActions(); } }, 'Добавить действие')
        : null);
  };

  const save = async () => {
    error.textContent = '';
    s.name = nameInput.value.trim();
    s.cooldown_sec = Number(cooldown.value) || 0;
    try {
      const saved = isNew ? await post('/api/scenarios', s) : await put(`/api/scenarios/${id}`, s);
      toast('Сценарий сохранён');
      location.hash = `#/scenarios/${saved.id}`;
      if (!isNew) { s = saved; drawAll(); }
    } catch (e) {
      error.textContent = e.details?.reason ? `${errorMessage(e)}: ${e.details.reason}` : errorMessage(e);
    }
  };

  const remove = async () => {
    if (!confirm(`Удалить сценарий «${s.name}»?`)) return;
    try { await del(`/api/scenarios/${id}`); location.hash = '#/scenarios'; toast('Сценарий удалён'); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const drawAll = () => {
    nameInput.value = s.name;
    cooldown.value = String(s.cooldown_sec ?? 0);
    drawTrigger();
    drawConditions();
    drawActions();
  };

  mount(root, h('div', { class: 'editor' },
    h('header', { class: 'page-head' },
      h('div', null, h('a', { class: 'back', href: '#/scenarios' }, 'Сценарии'), h('h1', null, isNew ? 'Новый сценарий' : 'Сценарий'))),
    h('section', { class: 'panel' },
      field('Название', nameInput),
      h('h2', { class: 'section-title' }, 'Когда запускать'), triggerHost,
      h('h2', { class: 'section-title' }, 'Дополнительные условия'), condHost,
      h('h2', { class: 'section-title' }, 'Что сделать'), actionHost,
      field('Не запускать повторно, секунд', cooldown, '0 — без ограничения. Полезно для уведомлений, чтобы не получать их каждую минуту.'),
      error,
      h('div', { class: 'row-actions' },
        actionButton('Сохранить сценарий', save, 'btn btn-primary'),
        isNew ? null : actionButton('Запустить сейчас', async () => {
          try { await post(`/api/scenarios/${id}/run`); toast('Запущено'); } catch (e) { toast(errorMessage(e), 'error'); }
        }),
        isNew ? null : h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Удалить')))));

  if (isNew) drawAll();
  else {
    get(`/api/scenarios/${id}`).then((data) => { s = data; drawAll(); })
      .catch((e) => mount(root, h('div', { class: 'empty' }, h('h2', null, errorMessage(e)), h('a', { class: 'btn', href: '#/scenarios' }, 'К сценариям'))));
  }
  return () => {};
}
