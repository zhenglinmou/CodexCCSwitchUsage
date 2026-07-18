from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from balance_gateway.config import ConfigError, load_config
from balance_gateway.gateway import BalanceGateway
from balance_gateway.mapping import normalize_payload, values_at


class JsonHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({
            "ok": True,
            "account": {"plan": "Pro", "balance": 12.5, "used": 7.5, "currency": "USD"},
            "buckets": [{"costs": [{"value": 1.25}, {"value": 2.75}]}],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class MappingTests(unittest.TestCase):
    def test_json_path_wildcards(self):
        payload = {"data": [{"items": [{"v": 1}, {"v": 2}]}, {"items": [{"v": 3}]}]}
        self.assertEqual(values_at(payload, "data[*].items[*].v"), [1, 2, 3])

    def test_normalization_and_conversion(self):
        provider = {
            "id": "demo",
            "name": "Demo",
            "response": {
                "success": {"path": "success", "equals": True},
                "fields": {
                    "planName": {"path": "data.group"},
                    "remaining": {"path": "data.quota", "divisor": 500000},
                    "used": {"path": "data.used", "divisor": 500000},
                    "total": {"paths": ["data.quota", "data.used"], "aggregate": "sum", "divisor": 500000},
                    "unit": {"default": "USD"},
                },
            },
        }
        result = normalize_payload(provider, {"success": True, "data": {"group": "default", "quota": 7500000, "used": 2500000}})
        self.assertEqual(result["data"]["remaining"], 15)
        self.assertEqual(result["data"]["used"], 5)
        self.assertEqual(result["data"]["total"], 20)


class ConfigTests(unittest.TestCase):
    def test_inline_environment_secret_and_loopback_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "providers.json"
            os.environ["BALANCE_TEST_TOKEN"] = "secret"
            path.write_text(json.dumps({
                "server": {"host": "127.0.0.1", "port": 18000},
                "providers": [{
                    "id": "demo", "adapter": "generic_http",
                    "request": {"url": "https://example.invalid", "headers": {"Authorization": "Bearer ${ENV:BALANCE_TEST_TOKEN}"}},
                }],
            }), encoding="utf-8")
            config = load_config(path)
            self.assertEqual(config.providers["demo"]["request"]["headers"]["Authorization"], "Bearer secret")
            path.write_text(json.dumps({"server": {"host": "0.0.0.0"}, "providers": []}), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(path)


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), JsonHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        config = {
            "server": {"host": "127.0.0.1", "port": 17891},
            "providers": [{
                "id": "http-demo",
                "name": "HTTP Demo",
                "adapter": "generic_http",
                "request": {"url": f"http://127.0.0.1:{self.httpd.server_port}/balance"},
                "response": {
                    "success": {"path": "ok", "equals": True},
                    "fields": {
                        "planName": {"path": "account.plan"},
                        "remaining": {"path": "account.balance"},
                        "used": {"path": "account.used"},
                        "total": {"paths": ["account.balance", "account.used"], "aggregate": "sum"},
                        "unit": {"path": "account.currency"},
                        "extra": {"path": "buckets[*].costs[*].value", "aggregate": "sum"},
                    },
                },
            }],
        }
        self.config_path = self.root / "providers.json"
        self.config_path.write_text(json.dumps(config), encoding="utf-8")
        self.gateway = BalanceGateway(self.config_path, self.root / "app", self.root)

    async def asyncTearDown(self):
        await self.gateway.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.temp.cleanup()

    async def test_generic_http_provider_and_cc_switch_generator(self):
        result = await self.gateway.query("http-demo")
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["total"], 20)
        self.assertEqual(result["data"]["extra"], "4.0")
        generated = self.gateway.cc_switch_code("http-demo")
        self.assertIn("/v1/balance/http-demo", generated["code"])

    async def test_unknown_provider(self):
        result = await self.gateway.query("missing")
        self.assertFalse(result["success"])


if __name__ == "__main__":
    unittest.main()
