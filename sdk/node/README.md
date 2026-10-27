# iot-device-sdk (Node.js)

SDK устройства для IoT Stack на Node.js 18+: Raspberry Pi, мини-ПК, любой Linux. Аналог `2smart-cloud-js-sdk`.
Протокол тот же, что у ESP32-SDK: привязка по claim-токену, MQTT over TLS, `$meta`, команды `…/set`.

```bash
npm install ./sdk/node      # или скопируйте папку в проект
```

```js
import { IotDevice } from 'iot-device-sdk';

const device = new IotDevice({
  name: 'Raspberry Pi',
  firmware: '1.0.0',
  host: 'iot.example.com',                   // PUBLIC_HOST сервера
  claimToken: process.env.IOT_CLAIM_TOKEN,   // нужен только при первом запуске
  credentialsFile: './iot-credentials.json', // сюда SDK сохранит MQTT-учётку (права 600)
  // ca: fs.readFileSync('fullchain.pem'),   // если у сервера самоподписанный сертификат
});

const temp = device.addFloat('temperature', { unit: '°C', decimals: 1 });
device.addBool('relay').onSet(async (on) => {
  await gpio.write(17, on);
  return true;               // принять: значение уйдёт серверу; false — отклонить
});

device.on('state', (s) => console.log(s)); // provisioning → connecting → online
await device.start();
setInterval(() => temp.set(readSensor()), 10_000);
```

## Свойства

`addBool(name)`, `addInt(name, { unit, min, max })`, `addFloat(name, { unit, decimals, min, max })`, `addString(name)`.
Имя — `a-z`, `0-9`, `_`, `-`, до 32 символов, с буквы.

- `prop.set(value)` — отправить; если устройство офлайн, значение уйдёт после подключения.
- `prop.onSet(handler)` — сделать управляемым. `handler(value)` получает уже приведённое значение
  (`"on"` → `true`, число с учётом `min`/`max`), может быть `async`.
- `prop.value` — последнее значение.

## Прочее

- `device.publishState('sleeping' | 'alert' | 'ready')`.
- `device.stop()` — публикует `$state = disconnected` и закрывает соединение.
- Новая привязка: передайте другой `claimToken` — SDK заметит, что он отличается от использованного, и привяжется заново.

Пример для Raspberry Pi: `examples/raspberry-pi.js`.

Тесты (без брокера, транспорт подменяется): `npm test`.
