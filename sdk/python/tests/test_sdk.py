import json
import os
import stat
import tempfile
import unittest
from types import SimpleNamespace

from iot_device import IotDevice, ProvisionError
from iot_device.protocol import PropSpec, build_meta, format_value, parse_set_topic, parse_value

ID = "d0123456789abcdef"


class ProtocolTest(unittest.TestCase):
    def test_values(self):
        self.assertIs(parse_value("ON", PropSpec("r", "boolean")), True)
        self.assertIsNone(parse_value("2", PropSpec("r", "boolean")))
        self.assertIsNone(parse_value("101", PropSpec("l", "integer", max=100)))
        self.assertEqual(parse_value("21.456", PropSpec("t", "float", decimals=1)), 21.5)
        self.assertIsNone(parse_value("nan", PropSpec("t", "float")))
        self.assertEqual(format_value(22.0, PropSpec("t", "float")), "22")
        self.assertEqual(format_value(21.44, PropSpec("t", "float", decimals=1)), "21.4")
        self.assertEqual(format_value(-0.001, PropSpec("t", "float")), "0")
        self.assertIsNone(format_value(float("inf"), PropSpec("t", "float")))
        self.assertEqual(format_value(True, PropSpec("r", "boolean")), "true")
        self.assertEqual(len(format_value("я" * 200, PropSpec("s", "string")).encode()), 256)

    def test_topics_and_meta(self):
        self.assertEqual(parse_set_topic(f"dev/{ID}/relay/set", ID), "relay")
        self.assertIsNone(parse_set_topic(f"dev/{ID}/a/b/set", ID))
        meta = json.loads(build_meta("Pi", "1", [PropSpec("t", "float", unit="°C"), PropSpec("r", "boolean", settable=True)]))
        self.assertEqual(meta["props"], {"t": {"type": "float", "unit": "°C"}, "r": {"type": "boolean", "settable": True}})


class FakeClient:
    def __init__(self, client_id):
        self.client_id = client_id
        self.pub, self.subs, self.calls = [], [], []

    def username_pw_set(self, u, p): self.calls.append(("auth", u, p))
    def will_set(self, t, payload, qos, retain): self.calls.append(("will", t, payload, retain))
    def tls_set(self, **kw): self.calls.append(("tls", kw))
    def reconnect_delay_set(self, **kw): pass
    def connect_async(self, host, port, keepalive): self.calls.append(("connect", host, port))
    def loop_start(self): pass
    def loop_stop(self): pass
    def disconnect(self): self.calls.append(("disconnect",))
    def subscribe(self, t, qos): self.subs.append(t)

    def publish(self, t, payload, qos=0, retain=False):
        self.pub.append((t, payload, retain))
        return SimpleNamespace(wait_for_publish=lambda timeout=None: None)

    # «сервер»
    def connected(self, dev):
        dev._on_connect(self, None, None, SimpleNamespace(is_failure=False), None)

    def message(self, dev, t, payload):
        dev._on_message(self, None, SimpleNamespace(topic=t, payload=payload.encode()))


class DeviceTest(unittest.TestCase):
    def make(self, creds_file=None, token="claim-token-123456"):
        self.dir = tempfile.mkdtemp()
        self.posts = []
        self.client = None

        def post(url, body):
            self.posts.append((url, body))
            return 200, {"device_id": ID, "mqtt": {"password": "secret"}}

        def factory(cid):
            self.client = FakeClient(cid)
            return self.client

        return IotDevice("Pi", "iot.test", firmware="2.0", claim_token=token,
                         credentials_file=creds_file or os.path.join(self.dir, "creds.json"),
                         client_factory=factory, http_post=post)

    def test_full_flow(self):
        dev = self.make()
        states = []
        dev.on_state = states.append
        temp = dev.add_float("temperature", unit="°C", decimals=1)
        relay = dev.add_bool("relay")
        seen = []

        @relay.on_set
        def _(value):
            seen.append(value)
            return True

        mode = dev.add_string("mode")
        mode.on_set(lambda v: v in ("eco", "heat"))
        temp.set(21.44)  # до подключения — запомнится

        dev.start()
        self.assertEqual(self.posts, [("https://iot.test/api/provision", {"claim_token": "claim-token-123456"})])
        creds_path = os.path.join(self.dir, "creds.json")
        if os.name != "nt":  # на Windows POSIX-прав нет
            self.assertEqual(stat.S_IMODE(os.stat(creds_path).st_mode), 0o600)
        c = self.client
        self.assertEqual(c.client_id, ID)
        self.assertIn(("will", f"dev/{ID}/$state", "lost", True), c.calls)
        self.assertIn(("connect", "iot.test", 8883), c.calls)

        c.connected(dev)
        self.assertEqual(dev.state, "online")
        self.assertEqual(states, ["provisioning", "connecting", "online"])
        self.assertEqual(c.subs, [f"dev/{ID}/+/set"])
        meta = json.loads(next(p for t, p, _ in c.pub if t.endswith("$meta")))
        self.assertEqual(meta["props"]["relay"], {"type": "boolean", "settable": True})
        self.assertIn((f"dev/{ID}/temperature", "21.4", False), c.pub)
        self.assertEqual(c.pub[-1], (f"dev/{ID}/$state", "ready", True))

        c.message(dev, f"dev/{ID}/relay/set", "on")
        self.assertEqual(seen, [True])
        self.assertIs(relay.value, True)
        self.assertEqual(c.pub[-1], (f"dev/{ID}/relay", "true", False))

        c.message(dev, f"dev/{ID}/mode/set", "turbo")       # отклонено
        self.assertIsNone(mode.value)
        c.message(dev, f"dev/{ID}/temperature/set", "1")    # не settable
        c.message(dev, f"dev/{ID}/relay/set", "maybe")      # мусор
        self.assertEqual(seen, [True])

        dev.stop()
        self.assertIn((f"dev/{ID}/$state", "disconnected", True), c.pub)

    def test_credentials_reuse_and_reprovision(self):
        first = self.make()
        first.start()
        path = first.credentials_file
        again = self.make(creds_file=path)
        again.start()
        self.assertEqual(self.posts, [], "учётка из файла")
        fresh = self.make(creds_file=path, token="another-token-123456")
        fresh.start()
        self.assertEqual(len(self.posts), 1)

    def test_errors(self):
        dev = self.make(token=None)
        with self.assertRaises(RuntimeError):
            dev.start()
        with self.assertRaises(ValueError):
            dev.add_float("Bad Name")
        bad = IotDevice("x", "h", claim_token="t" * 20, credentials_file=os.path.join(tempfile.mkdtemp(), "c.json"),
                        http_post=lambda u, b: (401, {"error": "invalid_or_expired_claim_token"}), client_factory=FakeClient)
        with self.assertRaises(ProvisionError) as cm:
            bad.start()
        self.assertEqual(cm.exception.status, 401)


class PahoApiTest(unittest.TestCase):
    """Проверка, что вызовы совпадают с настоящим paho-mqtt 2.x (без сети)."""

    def test_real_client_accepts_our_calls(self):
        try:
            import paho.mqtt.client as mqtt  # noqa: F401
        except ImportError:
            self.skipTest("paho-mqtt не установлен")
        dev = IotDevice("Pi", "iot.test", claim_token="claim-token-123456",
                        credentials_file=os.path.join(tempfile.mkdtemp(), "c.json"),
                        http_post=lambda u, b: (200, {"device_id": ID, "mqtt": {"password": "p"}}))
        real = dev._make_client(ID)
        real.username_pw_set(ID, "p")
        real.will_set(f"dev/{ID}/$state", "lost", qos=1, retain=True)
        real.tls_set()
        real.reconnect_delay_set(min_delay=1, max_delay=60)
        real.on_connect = dev._on_connect
        real.on_disconnect = dev._on_disconnect
        real.on_message = dev._on_message
        self.assertEqual(real._client_id, ID.encode())


if __name__ == "__main__":
    unittest.main()
