"""Raspberry Pi: температура процессора и реле на GPIO17.

    pip install iot-device-sdk gpiozero
    IOT_HOST=iot.example.com IOT_CLAIM_TOKEN=... python3 examples/raspberry_pi.py
"""
import logging
import os
import signal
import threading

from iot_device import IotDevice

logging.basicConfig(level=logging.INFO)

try:
    from gpiozero import OutputDevice
    relay_pin = OutputDevice(17)
except ImportError:  # не на Raspberry Pi — эмулируем
    relay_pin = None

dev = IotDevice(
    "Raspberry Pi",
    os.environ["IOT_HOST"],
    firmware="1.0.0",
    claim_token=os.environ.get("IOT_CLAIM_TOKEN"),  # нужен только при первом запуске
    credentials_file="iot-credentials.json",
    # ca_file="fullchain.pem",  # для самоподписанного сертификата сервера
)

cpu_temp = dev.add_float("cpu_temp", unit="°C", decimals=1)
relay = dev.add_bool("relay")


@relay.on_set
def set_relay(on: bool) -> bool:
    if relay_pin:
        relay_pin.on() if on else relay_pin.off()
    return True


relay.set(False)
dev.on_state = lambda s: print("state:", s)
dev.start()

stop = threading.Event()
signal.signal(signal.SIGINT, lambda *_: stop.set())
signal.signal(signal.SIGTERM, lambda *_: stop.set())
while not stop.wait(15):
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        cpu_temp.set(int(f.read()) / 1000)
dev.stop()
