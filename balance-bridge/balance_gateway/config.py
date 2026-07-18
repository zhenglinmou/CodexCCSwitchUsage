from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROVIDER_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class ConfigError(ValueError):
    pass


def _resolve_secret(value: Any) -> Any:
    if isinstance(value, list):
        return [_resolve_secret(item) for item in value]
    if isinstance(value, dict):
        return {key: _resolve_secret(item) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    def replace(match: re.Match[str]) -> str:
        kind, name = match.group(1), match.group(2)
        if kind == "ENV":
            if name not in os.environ:
                raise ConfigError(f"Missing environment variable: {name}")
            return os.environ[name]
        return Path(name).expanduser().read_text(encoding="utf-8").strip()

    return re.sub(r"\$\{(ENV|FILE):([^}]+)\}", replace, value)


@dataclass(frozen=True)
class GatewayConfig:
    path: Path
    host: str
    port: int
    browser: dict[str, Any]
    providers: dict[str, dict[str, Any]]


def load_config(path: Path) -> GatewayConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"Configuration file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"Invalid JSON in {path}: {exc}") from exc

    server = raw.get("server") or {}
    host = str(server.get("host") or "127.0.0.1")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ConfigError("The gateway may only listen on a loopback address")
    port = int(server.get("port") or 17891)
    if not 1 <= port <= 65535:
        raise ConfigError("server.port must be between 1 and 65535")

    providers: dict[str, dict[str, Any]] = {}
    for item in raw.get("providers") or []:
        provider = _resolve_secret(item)
        provider_id = str(provider.get("id") or "").lower()
        if not PROVIDER_ID.fullmatch(provider_id):
            raise ConfigError(f"Invalid provider id: {provider_id!r}")
        if provider_id in providers:
            raise ConfigError(f"Duplicate provider id: {provider_id}")
        adapter = provider.get("adapter")
        if adapter not in {"generic_http", "browser_fetch", "python_plugin"}:
            raise ConfigError(f"Unsupported adapter for {provider_id}: {adapter!r}")
        provider["id"] = provider_id
        provider.setdefault("name", provider_id)
        provider.setdefault("enabled", True)
        provider.setdefault("timeout_seconds", 30)
        providers[provider_id] = provider

    return GatewayConfig(
        path=path,
        host=host,
        port=port,
        browser=_resolve_secret(raw.get("browser") or {}),
        providers=providers,
    )
