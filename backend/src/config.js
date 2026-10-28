export function loadConfig(env = process.env) {
  const required = (name) => {
    const v = env[name];
    if (!v) throw new Error(`Missing env ${name}`);
    return v;
  };
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 chars');

  return {
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    jwtTtlSec: Number(env.JWT_TTL_SEC || 604800),
    allowRegistration: (env.ALLOW_REGISTRATION || 'true') === 'true',
    maxDevicesPerUser: Number(env.MAX_DEVICES_PER_USER || 50),
    maxBridgeDevices: Number(env.MAX_BRIDGE_DEVICES || 300),
    claimTtlMin: 30,
    publicHost: required('PUBLIC_HOST'),
    mqttPublicPort: Number(env.MQTT_PUBLIC_PORT || 8883),
    mqttUrl: env.MQTT_URL || 'mqtt://emqx:1883',
    // REST API EMQX: разрыв сессий при отзыве доступа (необязательно, но без него сессия живёт до переподключения)
    emqxApiUrl: env.EMQX_API_URL || 'http://emqx:18083',
    emqxApiKey: env.EMQX_API_KEY || '',
    emqxApiSecret: env.EMQX_API_SECRET || '',
    // Сервисные MQTT-учётки (superuser): username -> password
    serviceUsers: {
      backend: required('MQTT_BACKEND_PASSWORD'),
      ingest: required('MQTT_INGEST_PASSWORD'),
      scenarios: required('MQTT_SCENARIOS_PASSWORD'),
    },
    // Уведомления: платформенный Telegram-бот (необязательно) и вебхуки
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramApiUrl: env.TELEGRAM_API_URL || 'https://api.telegram.org',
    // true — разрешить вебхуки на http:// и адреса внутренних сетей (только для локальной разработки)
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === 'true',
    // максимальный размер файла прошивки для OTA
    firmwareMaxBytes: Math.round(Number(env.FIRMWARE_MAX_MB || 4) * 1024 * 1024),
    publicPort: 8000,
    internalPort: 8001,
  };
}
