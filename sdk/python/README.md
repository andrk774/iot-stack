# iot-device-sdk (Python)

SDK устройства для IoT Stack на Python 3.9+ и paho-mqtt 2.x: Raspberry Pi, Orange Pi, любой Linux.
Протокол тот же, что у ESP32- и Node-SDK.

```bash
pip install ./sdk/python
```

```python
import os
from iot_device import IotDevice

dev = IotDevice(
    "Raspberry Pi",
    "iot.example.com",                           # PUBLIC_HOST сервера
    firmware="1.0.0",
    claim_token=os.environ.get("IOT_CLAIM_TOKEN"),  # нужен только при первом запуске
    credentials_file="iot-credentials.json",      # сюда SDK сохранит MQTT-учётку (права 600)
    # ca_file="fullchain.pem",                    # если у сервера самоподписанный сертификат
)

temp = dev.add_float("temperature", unit="°C", decimals=1)
relay = dev.add_bool("relay")

@relay.on_set
def _(on: bool) -> bool:
    gpio.output(17, on)
    return True          # принять; False — отклонить, серверу уйдёт прежнее значение

dev.on_state = print     # provisioning → connecting → online
dev.start()              # сеть работает в фоновом потоке paho
temp.set(21.5)
```

Свойства: `add_bool`, `add_int(name, unit, min, max)`, `add_float(name, unit, decimals, min, max)`, `add_string`.
Обработчики команд вызываются в сетевом потоке paho — долгую работу выносите в свой поток.

`dev.publish_state("sleeping")`, `dev.stop()`.

Пример: `examples/raspberry_pi.py`. Тесты: `python3 -m unittest discover -s tests`.
