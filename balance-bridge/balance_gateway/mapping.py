from __future__ import annotations

import re
from typing import Any


MISSING = object()


def values_at(value: Any, path: str) -> list[Any]:
    """Read a small JSONPath subset: dots, numeric indexes and [*]."""
    if not path or path == "$":
        return [value]
    normalized = path.removeprefix("$.")
    tokens = re.findall(r"[^.\[\]]+|\[\*\]|\[\d+\]", normalized)
    current = [value]
    for token in tokens:
        next_values: list[Any] = []
        if token == "[*]":
            for item in current:
                if isinstance(item, list):
                    next_values.extend(item)
        elif token.startswith("["):
            index = int(token[1:-1])
            for item in current:
                if isinstance(item, list) and index < len(item):
                    next_values.append(item[index])
        else:
            for item in current:
                if isinstance(item, dict) and token in item:
                    next_values.append(item[token])
        current = next_values
        if not current:
            break
    return current


def first_at(value: Any, paths: str | list[str], default: Any = MISSING) -> Any:
    if isinstance(paths, str):
        paths = [paths]
    for path in paths:
        found = values_at(value, path)
        if found:
            return found[0]
    return default


def _number(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    return float(value)


def _optional_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def map_field(payload: Any, spec: Any) -> Any:
    if not isinstance(spec, dict):
        return spec
    paths = spec.get("path") or spec.get("paths")
    if paths is None:
        result = spec.get("default")
    else:
        path_list = [paths] if isinstance(paths, str) else paths
        all_values: list[Any] = []
        for path in path_list:
            all_values.extend(values_at(payload, path))
        aggregate = spec.get("aggregate", "first")
        if not all_values:
            result = spec.get("default")
        elif aggregate == "sum":
            result = sum(_number(item) for item in all_values)
        elif aggregate == "count":
            result = len(all_values)
        elif aggregate == "max":
            result = max(_number(item) for item in all_values)
        elif aggregate == "min":
            result = min(_number(item) for item in all_values)
        else:
            result = all_values[0]

    if result is not None and any(key in spec for key in ("divisor", "multiplier", "round")):
        result = _number(result)
        divisor = _number(spec.get("divisor", 1)) or 1
        result = result / divisor * _number(spec.get("multiplier", 1))
        if "round" in spec:
            result = round(result, int(spec["round"]))
    return result


def _matches_rule(payload: Any, rule: dict[str, Any] | None, default: bool) -> bool:
    if not rule:
        return default
    actual = first_at(payload, rule.get("path", ""), MISSING)
    if actual is MISSING:
        return bool(rule.get("missing", False))
    if "equals" in rule:
        return actual == rule["equals"]
    if "not_equals" in rule:
        return actual != rule["not_equals"]
    if "in" in rule:
        return actual in rule["in"]
    if "not_in" in rule:
        return actual not in rule["not_in"]
    return bool(actual)


def normalize_payload(provider: dict[str, Any], payload: Any) -> dict[str, Any]:
    response = provider.get("response") or {}
    if not _matches_rule(payload, response.get("success"), True):
        message = first_at(payload, response.get("message_paths") or ["message", "error.message", "error"], "Provider rejected the request")
        return {"success": False, "message": str(message), "login_required": False}

    fields = response.get("fields") or {}
    remaining = map_field(payload, fields["remaining"]) if "remaining" in fields else None
    used = map_field(payload, fields["used"]) if "used" in fields else None
    total_spec = fields.get("total")
    if total_spec:
        total = map_field(payload, total_spec)
    elif remaining is not None and used is not None:
        total = _number(remaining) + _number(used)
    else:
        total = None
    data = {
        "planName": map_field(payload, fields.get("planName", {"default": provider["name"]})),
        "remaining": _optional_number(remaining),
        "used": _optional_number(used),
        "total": _optional_number(total),
        "unit": str(map_field(payload, fields.get("unit", {"default": "USD"}))),
        "extra": str(map_field(payload, fields.get("extra", {"default": ""})) or ""),
        "isValid": _matches_rule(payload, response.get("valid"), True),
    }
    request_count = fields.get("requestCount")
    if request_count:
        data["requestCount"] = int(_number(map_field(payload, request_count)))
        if not data["extra"] and provider.get("request_count_in_extra", True):
            data["extra"] = f"请求次数：{data['requestCount']}"
    return {"success": True, "provider": provider["id"], "data": data}
