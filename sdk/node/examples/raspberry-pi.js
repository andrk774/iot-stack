// Raspberry Pi: температура процессора и реле на GPIO (через sysfs-утилиту pinctrl).
//   IOT_HOST=iot.example.com IOT_CLAIM_TOKEN=... node examples/raspberry-pi.js
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { IotDevice } from '../index.js';

const RELAY_GPIO = 17;

const device = new IotDevice({
  name: 'Raspberry Pi',
  firmware: '1.0.0',
  host: process.env.IOT_HOST,
  claimToken: process.env.IOT_CLAIM_TOKEN, // нужен только при первом запуске
  credentialsFile: './iot-credentials.json',
  // ca: await readFile('./fullchain.pem'),  // для самоподписанного сертификата сервера
});

const cpuTemp = device.addFloat('cpu_temp', { unit: '°C', decimals: 1 });
const load = device.addFloat('load', { decimals: 2 });
device.addBool('relay').onSet(async (on) => {
  await new Promise((resolve, reject) => execFile('pinctrl', ['set', String(RELAY_GPIO), 'op', on ? 'dh' : 'dl'],
    (err) => (err ? reject(err) : resolve())));
  return true;
}).set(false);

device.on('state', (s) => console.log('state:', s));
await device.start();

setInterval(async () => {
  const milli = Number(await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8'));
  cpuTemp.set(milli / 1000);
  const [one] = (await readFile('/proc/loadavg', 'utf8')).split(' ');
  load.set(Number(one));
}, 15000);

process.on('SIGINT', async () => { await device.stop(); process.exit(0); });
