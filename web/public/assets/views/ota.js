// Обновление прошивки: панель на странице устройства и библиотека прошивок в настройках.
import { h, mount, toast, actionButton, field } from '../dom.js';
import { get, post, del, upload } from '../api.js';
import { relativeTime, errorMessage, formatBytes, OTA_LABELS } from '../format.js';

const ACTIVE = new Set(['pending', 'downloading', 'rebooting']);
const TONE = { done: 'ok', failed: 'bad', cancelled: 'muted', pending: 'warn', downloading: 'warn', rebooting: 'warn' };

/** Панель «Прошивка» для устройства с прямым подключением. live(msg) — статус из MQTT. */
export function otaPanel(device) {
  const body = h('div', { class: 'stack' });
  const section = h('section', { class: 'panel', 'aria-labelledby': 'ota-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'ota-title' }, 'Прошивка')), body);
  let job = null;
  let firmwares = [];

  const draw = () => {
    const current = device.meta?.fw;
    const status = job ? h('div', { class: 'ota-status' },
      h('span', { class: `state state-${TONE[job.status] || 'muted'}` }, h('span', { class: 'state-dot', 'aria-hidden': 'true' }),
        `${job.version}: ${OTA_LABELS[job.status] || job.status}`),
      job.status === 'downloading' && Number.isInteger(job.progress)
        ? h('progress', { max: 100, value: job.progress, 'aria-label': 'Скачано' }, `${job.progress}%`) : null,
      job.status === 'downloading' && Number.isInteger(job.progress) ? h('span', { class: 'muted' }, `${job.progress}%`) : null,
      h('span', { class: 'muted' }, relativeTime(job.updated_at || job.created_at)),
      job.error ? h('div', { class: 'list-error' }, job.error) : null) : null;

    const sel = h('select', { 'aria-label': 'Прошивка' },
      ...firmwares.map((f) => h('option', { value: f.id }, `${f.name} ${f.version} (${formatBytes(f.size)})`)));
    const controls = firmwares.length
      ? h('div', { class: 'inline-form' }, sel,
        actionButton('Обновить прошивку', async () => {
          const fw = firmwares.find((f) => f.id === sel.value);
          if (current && fw.version === current && !confirm(`Версия ${current} уже стоит. Отправить всё равно?`)) return;
          if (!confirm(`Обновить «${device.name}» до ${fw.name} ${fw.version}? Устройство перезагрузится.`)) return;
          try {
            ({ job } = await post(`/api/devices/${device.id}/ota`, { firmware_id: fw.id }));
            draw();
            toast('Команда отправлена. Устройство начнёт обновление, как только будет на связи.');
          } catch (e) { toast(errorMessage(e), 'error'); }
        }, 'btn btn-primary'),
        job && ACTIVE.has(job.status) && job.status !== 'rebooting' ? actionButton('Отменить', async () => {
          try { await del(`/api/devices/${device.id}/ota`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
        }) : null)
      : h('p', { class: 'muted' }, 'В библиотеке нет прошивок. Загрузите .bin в ', h('a', { href: '#/settings' }, 'настройках'), '.');

    mount(body,
      h('p', null, current ? `Сейчас: ${current}` : 'Версию устройство пока не сообщило.'),
      status,
      controls,
      h('p', { class: 'field-hint' }, 'В прошивке должно быть device.enableOta(). Команда дойдёт и до устройства, которое сейчас не в сети.'));
  };

  const load = async () => {
    try {
      const [o, f] = await Promise.all([get(`/api/devices/${device.id}/ota`), get('/api/firmwares')]);
      job = o.job;
      firmwares = f.firmwares;
      draw();
    } catch (e) {
      mount(body, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };
  load();

  return {
    el: section,
    live(msg) {
      if (!job || msg.job !== job.id) { load(); return; }
      job = { ...job, status: msg.status, progress: msg.progress ?? job.progress, error: msg.error ?? null, updated_at: new Date().toISOString() };
      draw();
    },
    setDevice(d) { device = d; draw(); },
  };
}

/** Раздел настроек «Прошивки» */
export function firmwaresSection() {
  const host = h('div');
  const file = h('input', { type: 'file', accept: '.bin,application/octet-stream' });
  const name = h('input', { maxlength: 64, placeholder: 'Например, «Реле кухни»' });
  const version = h('input', { maxlength: 32, placeholder: '1.1.0' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  let maxBytes = 4 * 1024 * 1024;

  const load = async () => {
    try {
      const data = await get('/api/firmwares');
      maxBytes = data.max_bytes;
      if (!data.firmwares.length) {
        mount(host, h('p', { class: 'empty-inline' }, 'Прошивок пока нет.'));
        return;
      }
      mount(host, h('div', { class: 'list' }, ...data.firmwares.map((f) => h('div', { class: 'list-row' },
        h('span', { class: 'tag' }, f.version),
        h('div', null,
          h('span', { class: 'title' }, f.name),
          h('div', { class: 'list-sub' }, `${formatBytes(f.size)}, загружена ${relativeTime(f.created_at)}`),
          h('div', { class: 'list-sub' }, h('code', { title: 'SHA-256' }, f.sha256.slice(0, 16)), '…')),
        h('div', { class: 'row-actions', style: { marginTop: 0 } },
          actionButton('Удалить', async () => {
            if (!confirm(`Удалить прошивку ${f.name} ${f.version}?`)) return;
            try { await del(`/api/firmwares/${f.id}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
          }, 'btn btn-small btn-danger'))))));
    } catch (e) {
      mount(host, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };

  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    if (!name.value) name.value = f.name.replace(/\.ino\..*$|\.bin$/i, '').slice(0, 64);
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(f.name);
    if (m && !version.value) version.value = m[1];
  });

  const send = actionButton('Загрузить', async () => {
    error.textContent = '';
    const f = file.files[0];
    if (!f) { error.textContent = 'Выберите файл .bin'; return; }
    if (f.size > maxBytes) { error.textContent = `Файл больше ${formatBytes(maxBytes)}`; return; }
    if (!name.value.trim() || !version.value.trim()) { error.textContent = 'Укажите название и версию — ту же, что в прошивке'; return; }
    try {
      const q = new URLSearchParams({ name: name.value.trim(), version: version.value.trim() });
      await upload(`/api/firmwares?${q}`, f);
      file.value = '';
      name.value = '';
      version.value = '';
      toast('Прошивка загружена');
      await load();
    } catch (e) {
      error.textContent = e.details?.reason ? `${errorMessage(e)}: ${e.details.reason}` : errorMessage(e);
    }
  }, 'btn btn-primary');

  load();
  return h('section', { class: 'panel', 'aria-labelledby': 'fw-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'fw-title', class: 'section-title' }, 'Прошивки для OTA')),
    h('p', { class: 'muted' }, 'Файл .bin приложения (Arduino IDE: «Экспорт бинарного файла», PlatformIO: firmware.bin). Версия должна совпадать с указанной в скетче: по ней устройство поймёт, что обновилось.'),
    h('div', { class: 'grid-3' }, field('Файл', file), field('Название', name), field('Версия', version)),
    h('div', { class: 'row-actions' }, send),
    error,
    host);
}
