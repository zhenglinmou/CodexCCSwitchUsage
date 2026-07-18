from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import Adapter
from ..mapping import normalize_payload


class GenericHttpAdapter(Adapter):
    async def query(self, provider: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self._query_sync, provider)

    def _query_sync(self, provider: dict[str, Any]) -> dict[str, Any]:
        request_config = provider.get("request") or {}
        url = request_config.get("url")
        if not url:
            base_url = str(provider.get("base_url") or "").rstrip("/")
            url = base_url + "/" + str(request_config.get("path") or "").lstrip("/")
        method = str(request_config.get("method") or "GET").upper()
        headers = {str(k): str(v) for k, v in (request_config.get("headers") or {}).items()}
        body = request_config.get("json")
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        request = Request(url=url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=float(provider.get("timeout_seconds", 30))) as response:
                raw = response.read().decode("utf-8")
                status = response.status
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            status = exc.code
        except URLError as exc:
            return {"success": False, "message": f"Connection failed: {exc.reason}"}
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return {"success": False, "message": f"Provider returned non-JSON content (HTTP {status})"}
        result = normalize_payload(provider, payload)
        result["http_status"] = status
        return result
