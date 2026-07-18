from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from . import __version__
from .adapters.browser_fetch import BrowserFetchAdapter
from .adapters.generic_http import GenericHttpAdapter
from .adapters.python_plugin import PythonPluginAdapter
from .config import GatewayConfig, load_config


log = logging.getLogger("balance-gateway")


class BalanceGateway:
    def __init__(self, config_path: Path, app_dir: Path, project_dir: Path) -> None:
        self.config_path = config_path
        self.app_dir = app_dir
        self.project_dir = project_dir
        self.config: GatewayConfig = load_config(config_path)
        self.started_at = time.time()
        self.generic_adapter = GenericHttpAdapter()
        self.browser_adapter = BrowserFetchAdapter(app_dir / "edge-profile", self.config.browser)
        self.plugin_adapter = PythonPluginAdapter(project_dir)
        self.locks: dict[str, asyncio.Lock] = {}

    def _adapter(self, provider: dict[str, Any]):
        return {
            "generic_http": self.generic_adapter,
            "browser_fetch": self.browser_adapter,
            "python_plugin": self.plugin_adapter,
        }[provider["adapter"]]

    def provider(self, provider_id: str) -> dict[str, Any] | None:
        return self.config.providers.get(provider_id.lower())

    async def query(self, provider_id: str) -> dict[str, Any]:
        provider = self.provider(provider_id)
        if not provider:
            return {"success": False, "message": f"Unknown provider: {provider_id}"}
        if not provider.get("enabled", True):
            return {"success": False, "provider": provider_id, "message": "Provider is disabled"}
        lock = self.locks.setdefault(provider_id, asyncio.Lock())
        async with lock:
            try:
                timeout = float(provider.get("timeout_seconds", 30)) + 5
                result = await asyncio.wait_for(self._adapter(provider).query(provider), timeout=timeout)
                result.setdefault("provider", provider_id)
                log.info("Balance query provider=%s success=%s", provider_id, result.get("success"))
                return result
            except asyncio.TimeoutError:
                log.warning("Balance query timed out provider=%s", provider_id)
                return {"success": False, "provider": provider_id, "message": "Balance query timed out"}
            except Exception as exc:
                log.exception("Balance query failed provider=%s", provider_id)
                return {"success": False, "provider": provider_id, "message": str(exc)}

    async def query_all(self) -> dict[str, Any]:
        enabled = [provider_id for provider_id, provider in self.config.providers.items() if provider.get("enabled", True)]
        results = await asyncio.gather(*(self.query(provider_id) for provider_id in enabled))
        return {
            "success": all(item.get("success") for item in results),
            "data": {provider_id: result for provider_id, result in zip(enabled, results)},
        }

    async def login(self, provider_id: str) -> dict[str, Any]:
        provider = self.provider(provider_id)
        if not provider:
            return {"success": False, "message": f"Unknown provider: {provider_id}"}
        try:
            return await self._adapter(provider).login(provider)
        except Exception as exc:
            log.exception("Login failed provider=%s", provider_id)
            return {"success": False, "message": str(exc)}

    def list_providers(self) -> dict[str, Any]:
        items = []
        for provider in self.config.providers.values():
            login_supported = bool(
                provider.get("login_supported", provider["adapter"] == "browser_fetch")
            )
            items.append({
                "id": provider["id"],
                "name": provider["name"],
                "adapter": provider["adapter"],
                "enabled": bool(provider.get("enabled", True)),
                "loginSupported": login_supported,
                "balanceUrl": f"/v1/balance/{provider['id']}",
                "loginUrl": f"/v1/login/{provider['id']}" if login_supported else None,
            })
        return {"success": True, "providers": items}

    def health(self) -> dict[str, Any]:
        return {
            "success": True,
            "service": "local-balance-gateway",
            "version": __version__,
            "uptime_seconds": int(time.time() - self.started_at),
            "config": str(self.config_path),
            "providers": list(self.config.providers),
        }

    def reload(self) -> dict[str, Any]:
        new_config = load_config(self.config_path)
        if (new_config.host, new_config.port) != (self.config.host, self.config.port):
            return {"success": False, "message": "Host or port changes require a service restart"}
        self.config = new_config
        self.browser_adapter.browser_config = new_config.browser
        self.locks = {key: value for key, value in self.locks.items() if key in new_config.providers}
        log.info("Configuration reloaded providers=%s", list(new_config.providers))
        return {"success": True, "message": "Configuration reloaded", "providers": list(new_config.providers)}

    def cc_switch_code(self, provider_id: str) -> dict[str, Any]:
        provider = self.provider(provider_id)
        if not provider:
            return {"success": False, "message": f"Unknown provider: {provider_id}"}
        url = f"http://{self.config.host}:{self.config.port}/v1/balance/{provider_id}"
        code = f'''({{
  request: {{
    url: "{url}",
    method: "GET",
    headers: {{ "Accept": "application/json", "Cache-Control": "no-store" }}
  }},
  extractor: function (response) {{
    if (response && response.success && response.data) {{
      return {{
        isValid: response.data.isValid !== false,
        invalidMessage: response.data.invalidMessage || "",
        planName: response.data.planName || "{provider['name']}",
        remaining: Number(response.data.remaining) || 0,
        used: Number(response.data.used) || 0,
        total: Number(response.data.total) || 0,
        unit: response.data.unit || "USD",
        extra: response.data.extra || ""
      }};
    }}
    return {{
      isValid: false,
      invalidMessage: (response && response.message) || "本地余额网关不可用"
    }};
  }}
}})'''
        return {"success": True, "provider": provider_id, "baseUrl": f"http://{self.config.host}:{self.config.port}", "code": code}

    async def close(self) -> None:
        await self.browser_adapter.close()
