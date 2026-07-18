from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from . import __version__
from .gateway import BalanceGateway


PROJECT_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "CCSwitchWafBalanceBridge"
CONFIG_FILE = Path(os.environ.get("BALANCE_GATEWAY_CONFIG", PROJECT_DIR / "providers.json"))
LOG_FILE = APP_DIR / "bridge.log"
PID_FILE = APP_DIR / "bridge.pid"
APP_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("balance-gateway")


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = f"LocalBalanceGateway/{__version__}"
    gateway: BalanceGateway
    loop: asyncio.AbstractEventLoop
    stop_event: asyncio.Event

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def run_async(self, coroutine, timeout: float = 90) -> dict[str, Any]:
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        return future.result(timeout=timeout)

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path).rstrip("/") or "/"
        if path in {"/", "/health", "/v1/health"}:
            self.send_json(200, self.gateway.health())
            return
        if path == "/v1/providers":
            self.send_json(200, self.gateway.list_providers())
            return
        if path == "/v1/balances":
            self.send_json(200, self.run_async(self.gateway.query_all(), 180))
            return
        if path.startswith("/v1/balance/") or path.startswith("/usage/"):
            provider_id = path.rsplit("/", 1)[-1].lower()
            self.send_json(200, self.run_async(self.gateway.query(provider_id)))
            return
        if path.startswith("/v1/login/") or path.startswith("/login/"):
            provider_id = path.rsplit("/", 1)[-1].lower()
            self.send_json(200, self.run_async(self.gateway.login(provider_id)))
            return
        if path.startswith("/v1/cc-switch/"):
            provider_id = path.rsplit("/", 1)[-1].lower()
            self.send_json(200, self.gateway.cc_switch_code(provider_id))
            return
        if path == "/shutdown":
            self.send_json(200, {"success": True, "message": "Shutting down"})
            self.loop.call_soon_threadsafe(self.stop_event.set)
            return
        self.send_json(404, {"success": False, "message": "Not found"})

    def do_POST(self) -> None:
        path = unquote(urlparse(self.path).path).rstrip("/") or "/"
        if path == "/v1/reload":
            try:
                result = self.gateway.reload()
                self.send_json(200 if result.get("success") else 409, result)
            except Exception as exc:
                log.exception("Configuration reload failed")
                self.send_json(400, {"success": False, "message": str(exc)})
            return
        if path in {"/v1/shutdown", "/shutdown"}:
            self.send_json(200, {"success": True, "message": "Shutting down"})
            self.loop.call_soon_threadsafe(self.stop_event.set)
            return
        self.send_json(404, {"success": False, "message": "Not found"})


def start_http_server(gateway: BalanceGateway, loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event) -> ThreadingHTTPServer:
    GatewayHandler.gateway = gateway
    GatewayHandler.loop = loop
    GatewayHandler.stop_event = stop_event
    server = ThreadingHTTPServer((gateway.config.host, gateway.config.port), GatewayHandler)
    threading.Thread(target=server.serve_forever, name="balance-gateway-http", daemon=True).start()
    return server


async def run() -> None:
    gateway = BalanceGateway(CONFIG_FILE, APP_DIR, PROJECT_DIR)
    stop_event = asyncio.Event()
    server = start_http_server(gateway, asyncio.get_running_loop(), stop_event)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    log.info("Local balance gateway started url=http://%s:%s", gateway.config.host, gateway.config.port)
    try:
        await stop_event.wait()
    finally:
        server.shutdown()
        server.server_close()
        await gateway.close()
        PID_FILE.unlink(missing_ok=True)
        log.info("Local balance gateway stopped")
