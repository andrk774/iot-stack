"""IotDevice для Linux (Raspberry Pi и т.п.): привязка по claim-токену, MQTT over TLS через paho-mqtt."""
from __future__ import annotations

import json
import logging
import os
import ssl
import threading
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from .protocol import (
    DEVICE_ID_RE, MAX_META_LEN, PROP_RE, STATES, TYPES, PropSpec,
    build_meta, format_value, parse_set_topic, parse_value, topic,
)

SetHandler = Callable[[Any], bool]


class ProvisionError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"provision failed: HTTP {status} {message}".strip())
        self.status = status


class Property:
    def __init__(self, device: "IotDevice", spec: PropSpec):
        self._device = device
        self.spec = spec
        self.value: Any = None
        self.wire: Optional[str] = None
        self.handler: Optional[SetHandler] = None

    @property
    def name(self) -> str:
        return self.spec.name

    def on_set(self, handler: SetHandler) -> SetHandler:
        """Сделать свойство управляемым. Можно как декоратор:

        @relay.on_set
        def _(value: bool) -> bool: ...   # True — принять, False — отклонить
        """
        if not callable(handler):
            raise TypeError("handler must be callable")
        self.handler = handler
        self.spec.settable = True
        return handler

    def set(self, value: Any) -> "Property":
        wire = format_value(value, self.spec)
        if wire is None:
            return self
        self.wire = wire
        self.value = wire if self.spec.type == "string" else parse_value(
            wire, PropSpec(self.spec.name, self.spec.type, decimals=self.spec.decimals))
        self._device._publish_property(self)
        return self


def _default_post(url: str, body: dict, ca_file: Optional[str]) -> tuple[int, dict]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json"})
    ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


class IotDevice:
    def __init__(
        self,
        name: str,
        host: str,
        *,
        firmware: str = "1.0.0",
        mqtt_port: int = 8883,
        api_url: Optional[str] = None,
        claim_token: Optional[str] = None,
        credentials_file: str = "iot-credentials.json",
        ca_file: Optional[str] = None,
        client_factory: Optional[Callable[..., Any]] = None,
        http_post: Optional[Callable[[str, dict], tuple[int, dict]]] = None,
        logger: Optional[logging.Logger] = None,
    ):
        if not name or not host:
            raise ValueError("name and host are required")
        self.name = name
        self.host = host
        self.firmware = firmware
        self.mqtt_port = mqtt_port
        self.api_url = (api_url or f"https://{host}").rstrip("/")
        self.claim_token = claim_token
        self.credentials_file = credentials_file
        self.ca_file = ca_file
        self._client_factory = client_factory
        self._http_post = http_post or (lambda url, body: _default_post(url, body, ca_file))
        self.log = logger or logging.getLogger("iot_device")
        self.props: dict[str, Property] = {}
        self.credentials: Optional[dict] = None
        self.state = "idle"
        self.on_state: Optional[Callable[[str], None]] = None
        self._client = None
        self._lock = threading.Lock()

    # ---------- свойства ----------
    def _add(self, name: str, type_: str, *, unit=None, min=None, max=None, decimals=2) -> Property:
        if not PROP_RE.match(name):
            raise ValueError(f"property name '{name}': a-z, 0-9, _ -, до 32 символов, с буквы")
        if type_ not in TYPES:
            raise ValueError(type_)
        if name in self.props:
            raise ValueError(f"property '{name}' already exists")
        p = Property(self, PropSpec(name, type_, unit=unit, min=min, max=max, decimals=decimals))
        self.props[name] = p
        return p

    def add_bool(self, name: str) -> Property:
        return self._add(name, "boolean")

    def add_int(self, name: str, unit: Optional[str] = None, min=None, max=None) -> Property:
        return self._add(name, "integer", unit=unit, min=min, max=max)

    def add_float(self, name: str, unit: Optional[str] = None, decimals: int = 2, min=None, max=None) -> Property:
        return self._add(name, "float", unit=unit, min=min, max=max, decimals=decimals)

    def add_string(self, name: str) -> Property:
        return self._add(name, "string")

    # ---------- состояние ----------
    def _set_state(self, s: str) -> None:
        if s == self.state:
            return
        self.state = s
        if self.on_state:
            try:
                self.on_state(s)
            except Exception:  # noqa: BLE001 — колбэк пользователя не должен ронять сеть
                self.log.exception("on_state failed")

    @property
    def online(self) -> bool:
        return self.state == "online"

    @property
    def device_id(self) -> Optional[str]:
        return self.credentials["device_id"] if self.credentials else None

    # ---------- учётка ----------
    def _load_credentials(self) -> Optional[dict]:
        try:
            with open(self.credentials_file, encoding="utf-8") as f:
                c = json.load(f)
            if DEVICE_ID_RE.match(c.get("device_id", "")) and c.get("password"):
                return c
        except (OSError, ValueError):
            pass
        return None

    def _save_credentials(self, c: dict) -> None:
        tmp = f"{self.credentials_file}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(c, f, indent=2)
        os.replace(tmp, self.credentials_file)

    def _provision(self) -> dict:
        if not self.claim_token:
            raise RuntimeError("нет учётки и claim_token: создайте устройство (POST /api/devices) и передайте claim_token")
        status, data = self._http_post(f"{self.api_url}/api/provision", {"claim_token": self.claim_token})
        if status != 200:
            raise ProvisionError(status, str(data.get("error", "")))
        c = {"device_id": data["device_id"], "password": data["mqtt"]["password"],
             "claim_token_used": self.claim_token, "host": self.host}
        self._save_credentials(c)
        self.log.info("привязано как %s", c["device_id"])
        return c

    # ---------- MQTT ----------
    def _make_client(self, client_id: str):
        if self._client_factory:
            return self._client_factory(client_id)
        import paho.mqtt.client as mqtt  # импорт здесь: тестам paho не нужен
        return mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=client_id,
                           protocol=mqtt.MQTTv311, clean_session=True)

    def meta(self) -> str:
        return build_meta(self.name, self.firmware, [p.spec for p in self.props.values()])

    def start(self) -> "IotDevice":
        creds = self._load_credentials()
        if self.claim_token and (not creds or creds.get("claim_token_used") != self.claim_token):
            if creds:
                self.log.info("новый claim_token — привязка заново")
            creds = None
        if not creds:
            self._set_state("provisioning")
            creds = self._provision()
        self.credentials = creds
        if len(self.meta().encode()) > MAX_META_LEN:
            self.log.warning("$meta больше 8 КБ, сервер его отбросит")

        dev_id = creds["device_id"]
        c = self._make_client(dev_id)
        c.username_pw_set(dev_id, creds["password"])
        c.will_set(topic(dev_id, "$state"), "lost", qos=1, retain=True)
        c.tls_set(ca_certs=self.ca_file) if self.ca_file else c.tls_set()
        c.reconnect_delay_set(min_delay=1, max_delay=60)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        self._client = c
        self._set_state("connecting")
        c.connect_async(self.host, self.mqtt_port, keepalive=60)
        c.loop_start()
        return self

    def stop(self) -> None:
        c = self._client
        if not c:
            return
        if self.online:
            c.publish(topic(self.device_id, "$state"), "disconnected", qos=1, retain=True).wait_for_publish(5)
        c.disconnect()
        c.loop_stop()
        self._set_state("idle")

    def publish_state(self, state: str) -> None:
        if state not in STATES:
            raise ValueError(state)
        if self._client and self.online:
            self._client.publish(topic(self.device_id, "$state"), state, qos=1, retain=True)

    def _on_connect(self, client, userdata, flags, reason_code, properties=None) -> None:
        if getattr(reason_code, "is_failure", False):
            self.log.error("MQTT отказ: %s", reason_code)
            return
        dev_id = self.device_id
        client.publish(topic(dev_id, "$state"), "init", qos=1, retain=True)
        client.publish(topic(dev_id, "$meta"), self.meta(), qos=1, retain=True)
        client.subscribe(topic(dev_id, "+/set"), qos=1)
        with self._lock:
            for p in self.props.values():
                if p.wire is not None:
                    client.publish(topic(dev_id, p.name), p.wire, qos=0)
        client.publish(topic(dev_id, "$state"), "ready", qos=1, retain=True)
        self._set_state("online")
        self.log.info("онлайн: dev/%s/…", dev_id)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None) -> None:
        if self.state == "online":
            self._set_state("connecting")

    def _publish_property(self, p: Property) -> None:
        c = self._client
        if c is None or not self.online or p.wire is None:
            return
        with self._lock:
            c.publish(topic(self.device_id, p.name), p.wire, qos=0)

    def _on_message(self, client, userdata, msg) -> None:
        name = parse_set_topic(msg.topic, self.device_id)
        p = self.props.get(name) if name else None
        if not p or not p.handler:
            return
        raw = msg.payload.decode("utf-8", errors="replace")
        value = parse_value(raw, p.spec)
        if value is None:
            self.log.warning("%s: недопустимое значение %r", name, raw)
            self._publish_property(p)
            return
        try:
            ok = bool(p.handler(value))
        except Exception:  # noqa: BLE001
            self.log.exception("обработчик %s упал", name)
            ok = False
        if ok:
            p.set(value)
        else:
            self._publish_property(p)
