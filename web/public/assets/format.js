// Чистые функции форматирования — без DOM, тестируются в Node.

/** Сырое значение (из MQTT-строки или last_values) -> значение нужного типа */
export function coerce(raw, type) {
  if (raw === undefined || raw === null) return null;
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'off') return false;
    return null;
  }
  if (type === 'integer' || type === 'float') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'string') return String(raw);
  // тип неизвестен: число, если похоже
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const s = String(raw).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : s;
}

const nf = new Map();
function numberFormat(decimals) {
  if (!nf.has(decimals)) {
    nf.set(decimals, new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: decimals }));
  }
  return nf.get(decimals);
}

export function formatValue(value, type) {
  if (value === null || value === undefined) return '—';
  if (type === 'boolean' || typeof value === 'boolean') return value ? 'вкл' : 'выкл';
  if (typeof value === 'number') return numberFormat(type === 'integer' ? 0 : 2).format(value);
  return String(value);
}

/** Свойства устройства в порядке $meta; без $meta — из last_values */
export function deviceProps(device) {
  const metaProps = device?.meta?.props;
  if (metaProps && typeof metaProps === 'object') {
    return Object.entries(metaProps).map(([name, spec]) => ({
      name,
      type: ['boolean', 'integer', 'float', 'string'].includes(spec?.type) ? spec.type : 'string',
      unit: typeof spec?.unit === 'string' ? spec.unit : '',
      settable: spec?.settable === true,
      min: typeof spec?.min === 'number' ? spec.min : null,
      max: typeof spec?.max === 'number' ? spec.max : null,
    }));
  }
  return Object.keys(device?.last_values || {}).map((name) => ({
    name, type: null, unit: '', settable: false, min: null, max: null,
  }));
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'никогда';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} дн назад`;
}

export const STATE_LABELS = {
  new: 'не привязано',
  init: 'запускается',
  ready: 'в сети',
  lost: 'нет связи',
  disconnected: 'отключено',
  sleeping: 'спит',
  alert: 'тревога',
};

export function stateTone(state) {
  if (state === 'ready') return 'ok';
  if (state === 'lost' || state === 'alert') return 'bad';
  if (state === 'sleeping' || state === 'init') return 'warn';
  return 'muted';
}

const ERRORS = {
  invalid_credentials: 'Неверный email или пароль',
  email_taken: 'Этот email уже зарегистрирован',
  registration_disabled: 'Регистрация выключена администратором',
  unauthorized: 'Сессия истекла, войдите снова',
  validation: 'Проверьте заполнение полей',
  device_limit_reached: 'Достигнут лимит устройств',
  device_not_found: 'Устройство не найдено',
  device_not_provisioned: 'Устройство ещё не привязано',
  property_not_settable: 'Этим свойством нельзя управлять',
  mqtt_unavailable: 'Брокер недоступен, попробуйте позже',
  device_managed_by_bridge: 'Устройством управляет мост',
  scenario_not_found: 'Сценарий не найден',
  bridge_not_found: 'Мост не найден',
  too_many_requests: 'Слишком много запросов, подождите минуту',
  network: 'Нет связи с сервером',
  channel_not_found: 'Канал не найден',
  channel_exists: 'Такой канал уже подключён',
  channel_limit_reached: 'Достигнут лимит каналов (20)',
  channel_send_failed: 'Не удалось отправить',
  telegram_not_configured: 'Платформенный бот не настроен: TELEGRAM_BOT_TOKEN в .env',
  telegram_unavailable: 'Бот Telegram ещё не запустился, попробуйте через минуту',
  webpush_not_configured: 'Push-уведомления не настроены на сервере',
  firmware_not_found: 'Прошивка не найдена',
  firmware_limit_reached: 'В библиотеке уже 20 прошивок — удалите старые',
  payload_too_large: 'Файл слишком большой',
  totp_required: 'Нужен код из приложения',
  invalid_totp: 'Код не подошёл',
  invalid_password: 'Неверный пароль',
  totp_already_enabled: 'Двухфакторная защита уже включена',
  totp_not_enabled: 'Двухфакторная защита не включена',
  totp_setup_required: 'Начните подключение заново',
  session_not_found: 'Сеанс уже завершён',
  push_denied: 'Уведомления запрещены в браузере',
};

export function errorMessage(err) {
  const code = err?.code || err?.message;
  let msg = ERRORS[code] || `Ошибка: ${code || 'неизвестная'}`;
  if (code === 'validation' && err?.details?.field) msg += ` (${err.details.field})`;
  return msg;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(2).replace('.', ',')} МБ`;
}

export const OTA_LABELS = {
  pending: 'ждёт устройство', downloading: 'скачивает', rebooting: 'перезагружается',
  done: 'готово', failed: 'ошибка', cancelled: 'отменено',
};

/** Окно графика -> параметры запроса телеметрии */
export const RANGES = {
  '1h': { label: 'Час', ms: 3600e3, bucket: null },
  '24h': { label: 'Сутки', ms: 24 * 3600e3, bucket: '5m' },
  '7d': { label: 'Неделя', ms: 7 * 24 * 3600e3, bucket: '1h' },
  '30d': { label: 'Месяц', ms: 30 * 24 * 3600e3, bucket: '6h' },
};

/** Ответ /telemetry -> [{t: ms, v, min, max}] */
export function seriesFromTelemetry(resp) {
  return (resp?.points || [])
    .map((p) => {
      const t = Date.parse(p.t);
      const v = p.avg ?? p.v;
      return {
        t,
        v: v === null || v === undefined ? null : Number(v),
        min: p.min === undefined || p.min === null ? null : Number(p.min),
        max: p.max === undefined || p.max === null ? null : Number(p.max),
      };
    })
    .filter((p) => Number.isFinite(p.t) && p.v !== null && Number.isFinite(p.v));
}

/** «Красивые» деления оси */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}
