"""Протокол платформы — те же правила, что в ESP32/Node SDK и на сервере.

dev/<id>/$state | dev/<id>/$meta | dev/<id>/<prop> | dev/<id>/<prop>/set
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Optional

PROP_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
DEVICE_ID_RE = re.compile(r"^d[0-9a-f]{16}$")
NUM_RE = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")
STATES = ("init", "ready", "disconnected", "sleeping", "lost", "alert")
TYPES = ("boolean", "integer", "float", "string")
MAX_VALUE_LEN = 256
MAX_META_LEN = 8192


@dataclass
class PropSpec:
    name: str
    type: str
    unit: Optional[str] = None
    min: Optional[float] = None
    max: Optional[float] = None
    decimals: int = 2
    settable: bool = False
    extra: dict = field(default_factory=dict)


def topic(device_id: str, leaf: str) -> str:
    return f"dev/{device_id}/{leaf}"


def parse_set_topic(t: str, device_id: str) -> Optional[str]:
    prefix = f"dev/{device_id}/"
    if not (t.startswith(prefix) and t.endswith("/set")):
        return None
    prop = t[len(prefix):-4]
    return prop if PROP_RE.match(prop) else None


def _in_range(n: float, spec: PropSpec) -> bool:
    return (spec.min is None or n >= spec.min) and (spec.max is None or n <= spec.max)


def _round(n: float, decimals: int) -> float:
    r = round(n, max(0, min(6, decimals)))
    return 0.0 if r == 0 else r


def parse_value(raw: str, spec: PropSpec) -> Any:
    """Строка команды -> значение нужного типа; None, если недопустимо."""
    s = raw.strip()
    if spec.type == "boolean":
        v = s.lower()
        if v in ("true", "1", "on", "yes"):
            return True
        if v in ("false", "0", "off", "no"):
            return False
        return None
    if spec.type == "integer":
        if not re.fullmatch(r"[-+]?\d{1,15}", s):
            return None
        n = int(s)
        return n if _in_range(n, spec) else None
    if spec.type == "float":
        if not NUM_RE.match(s):
            return None
        n = float(s)
        if not math.isfinite(n) or not _in_range(n, spec):
            return None
        return _round(n, spec.decimals)
    return raw if len(raw.encode()) <= MAX_VALUE_LEN else None


def format_value(value: Any, spec: PropSpec) -> Optional[str]:
    """Значение -> строка для публикации; None, если отправлять нечего."""
    if value is None:
        return None
    if spec.type == "boolean":
        return "true" if value else "false"
    if spec.type == "integer":
        try:
            return str(int(value))
        except (TypeError, ValueError, OverflowError):
            return None
    if spec.type == "float":
        try:
            n = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(n):
            return None
        r = _round(n, spec.decimals)
        return str(int(r)) if r == int(r) else repr(r)
    s = str(value)
    b = s.encode()
    return s if len(b) <= MAX_VALUE_LEN else b[:MAX_VALUE_LEN].decode(errors="ignore")


def build_meta(name: str, firmware: str, specs: list[PropSpec]) -> str:
    props = {}
    for s in specs:
        p: dict[str, Any] = {"type": s.type}
        if s.unit:
            p["unit"] = s.unit
        if s.settable:
            p["settable"] = True
        if s.min is not None:
            p["min"] = s.min
        if s.max is not None:
            p["max"] = s.max
        props[s.name] = p
    return json.dumps({"name": name, "fw": firmware, "props": props}, ensure_ascii=False, separators=(",", ":"))
