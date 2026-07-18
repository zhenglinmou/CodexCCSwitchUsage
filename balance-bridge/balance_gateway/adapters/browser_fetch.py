from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.async_api import Browser, BrowserContext, Error as PlaywrightError, Page, async_playwright

from .base import Adapter
from ..mapping import normalize_payload


class BrowserFetchAdapter(Adapter):
    def __init__(self, profile_dir: Path, browser_config: dict[str, Any]) -> None:
        self.profile_dir = profile_dir
        self.browser_config = browser_config
        self.playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.pages: dict[str, Page] = {}
        self.start_lock = asyncio.Lock()
        self.query_lock = asyncio.Lock()
        self.imported_legacy_cookies: set[str] = set()
        self.imported_cookie_files: set[str] = set()

    async def _import_cookie_file(self, provider: dict[str, Any]) -> None:
        cookie_file = str(provider.get("cookie_file") or "")
        if not cookie_file or cookie_file in self.imported_cookie_files or not self.context:
            return
        self.imported_cookie_files.add(cookie_file)
        path = Path(cookie_file).expanduser()
        if not path.exists():
            return
        hostname = urlparse(str(provider.get("base_url") or "")).hostname
        if not hostname:
            return
        try:
            header = path.read_text(encoding="utf-8").strip()
            cookies = []
            for part in header.split(";"):
                if "=" not in part:
                    continue
                name, value = part.strip().split("=", 1)
                if name and value:
                    cookies.append(
                        {"name": name, "value": value, "domain": hostname, "path": "/", "secure": True}
                    )
            if cookies:
                await self.context.add_cookies(cookies)
        except (OSError, PlaywrightError):
            return

    def _read_cc_switch_usage(self, provider: dict[str, Any]) -> dict[str, Any]:
        database = Path.home() / ".cc-switch" / "cc-switch.db"
        if not database.exists():
            return {}
        databases = [database]
        backup_dir = database.parent / "backups"
        if backup_dir.exists():
            databases.extend(
                sorted(backup_dir.glob("*.db"), key=lambda path: path.stat().st_mtime, reverse=True)
            )
        provider_ref = str(provider.get("cc_switch_provider_id") or "")
        legacy_name = str(provider.get("legacy_cc_switch_provider") or "")
        if not provider_ref and not legacy_name:
            return {}
        credential_config = provider.get("cc_switch_credentials") or {}
        token_field = str(credential_config.get("token_field") or "accessToken")
        user_id_field = str(credential_config.get("user_id_field") or "userId")
        first_usage: dict[str, Any] = {}
        for candidate in databases:
            try:
                uri = f"file:{candidate.as_posix()}?mode=ro"
                with sqlite3.connect(uri, uri=True) as connection:
                    if provider_ref:
                        row = connection.execute(
                            "SELECT meta FROM providers WHERE id = ? AND app_type = 'codex' LIMIT 1",
                            (provider_ref,),
                        ).fetchone()
                    else:
                        row = connection.execute(
                            "SELECT meta FROM providers WHERE name = ? AND app_type = 'codex' LIMIT 1",
                            (legacy_name,),
                        ).fetchone()
                if not row or not row[0]:
                    continue
                usage = json.loads(row[0]).get("usage_script") or {}
                if usage and not first_usage:
                    first_usage = usage
                if credential_config:
                    if usage.get(token_field) and usage.get(user_id_field):
                        return usage
                elif usage.get("accessToken"):
                    return usage
            except (sqlite3.Error, json.JSONDecodeError, OSError):
                continue
        return first_usage

    def _request_context(self, provider: dict[str, Any]) -> tuple[dict[str, str], str]:
        request = provider.get("request") or {}
        headers = {str(key): str(value) for key, value in (request.get("headers") or {}).items()}
        fallback_user_id = str(provider.get("fallback_user_id") or "")
        credential_config = provider.get("cc_switch_credentials") or {}
        if credential_config:
            usage = self._read_cc_switch_usage(provider)
            token = str(usage.get(credential_config.get("token_field", "accessToken")) or "")
            user_id = str(usage.get(credential_config.get("user_id_field", "userId")) or "")
            header = str(credential_config.get("token_header") or "Authorization")
            prefix = str(credential_config.get("token_prefix") or "Bearer ")
            if token:
                headers[header] = prefix + token
            if user_id:
                fallback_user_id = user_id
        user_header = str(request.get("browser_user_header") or "")
        if user_header and fallback_user_id:
            headers[user_header] = fallback_user_id
        return headers, fallback_user_id

    async def _import_legacy_cookie(self, provider: dict[str, Any]) -> None:
        provider_id = provider["id"]
        legacy_name = provider.get("legacy_cc_switch_provider")
        if not legacy_name or provider_id in self.imported_legacy_cookies:
            return
        self.imported_legacy_cookies.add(provider_id)
        if not self.context:
            return
        try:
            usage = self._read_cc_switch_usage(provider)
            cookie_header = str(usage.get("accessToken") or "")
            hostname = urlparse(str(provider.get("base_url") or "")).hostname
            cookies = []
            for part in cookie_header.split(";"):
                if "=" not in part:
                    continue
                name, value = part.strip().split("=", 1)
                if name and value and hostname:
                    cookies.append({"name": name, "value": value, "domain": hostname, "path": "/", "secure": True})
            if cookies:
                await self.context.add_cookies(cookies)
        except (sqlite3.Error, json.JSONDecodeError):
            return

    async def _ensure_context(self) -> BrowserContext:
        async with self.start_lock:
            if self.context:
                return self.context
            self.playwright = await async_playwright().start()
            launch_options = {
                "channel": self.browser_config.get("channel", "msedge"),
                "headless": bool(self.browser_config.get("headless", False)),
                "args": ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
            }
            if self.browser_config.get("persistent", True):
                self.context = await self.playwright.chromium.launch_persistent_context(
                    user_data_dir=str(self.profile_dir),
                    viewport=None,
                    **launch_options,
                )
            else:
                self.browser = await self.playwright.chromium.launch(**launch_options)
                self.context = await self.browser.new_context(viewport=None)
            return self.context

    async def _page(self, provider: dict[str, Any], navigate: bool = True) -> Page:
        context = await self._ensure_context()
        await self._import_cookie_file(provider)
        await self._import_legacy_cookie(provider)
        provider_id = provider["id"]
        page = self.pages.get(provider_id)
        if not page or page.is_closed():
            page = await context.new_page()
            self.pages[provider_id] = page
        headers, _ = self._request_context(provider)
        if headers:
            await context.set_extra_http_headers(headers)
            await page.set_extra_http_headers(headers)
        base_url = str(provider.get("base_url") or "").rstrip("/")
        if navigate and not provider.get("navigate_request") and not page.url.startswith(base_url):
            await page.goto(base_url, wait_until="domcontentloaded", timeout=60_000)
            await page.wait_for_timeout(750)
        return page

    async def login(self, provider: dict[str, Any]) -> dict[str, Any]:
        page = await self._page(provider, navigate=False)
        login_path = str(provider.get("login_path") or "/login")
        url = str(provider.get("base_url") or "").rstrip("/") + "/" + login_path.lstrip("/")
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        await page.bring_to_front()
        return {"success": True, "message": f"Opened {provider['name']} login page", "url": page.url}

    async def _fetch(self, page: Page, provider: dict[str, Any]) -> dict[str, Any]:
        request = provider.get("request") or {}
        headers, fallback_user_id = self._request_context(provider)
        return await page.evaluate(
            """
            async ({path, method, headers, body, userHeader, fallbackUserId}) => {
              const outgoing = {...headers};
              if (userHeader) {
                let storedUser = {};
                try { storedUser = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
                outgoing[userHeader] = String(storedUser.id || fallbackUserId || '');
              }
              const response = await fetch(path, {
                method,
                credentials: 'include',
                cache: 'no-store',
                headers: outgoing,
                body: body == null ? undefined : JSON.stringify(body)
              });
              return {
                status: response.status,
                contentType: response.headers.get('content-type') || '',
                text: await response.text(),
                pageUrl: location.href
              };
            }
            """,
            {
                "path": request.get("path") or "/api/user/self",
                "method": str(request.get("method") or "GET").upper(),
                "headers": headers or {"Accept": "application/json"},
                "body": request.get("json"),
                "userHeader": request.get("browser_user_header"),
                "fallbackUserId": fallback_user_id,
            },
        )

    async def _navigate_fetch(self, page: Page, provider: dict[str, Any]) -> dict[str, Any]:
        request = provider.get("request") or {}
        base_url = str(provider.get("base_url") or "").rstrip("/")
        url = base_url + "/" + str(request.get("path") or "/api/user/self").lstrip("/")
        response = await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        attempts = max(1, int(float(provider.get("waf_wait_seconds", 30)) * 2))
        text = ""
        for _ in range(attempts):
            text = await page.locator("body").inner_text()
            try:
                json.loads(text)
                break
            except json.JSONDecodeError:
                await page.wait_for_timeout(500)
        return {
            "status": response.status if response else 200,
            "contentType": response.headers.get("content-type", "") if response else "",
            "text": text,
            "pageUrl": page.url,
        }

    async def query(self, provider: dict[str, Any]) -> dict[str, Any]:
        async with self.query_lock:
            page = await self._page(provider)
            raw = None
            for attempt in range(2):
                try:
                    if provider.get("navigate_request"):
                        raw = await self._navigate_fetch(page, provider)
                    else:
                        raw = await self._fetch(page, provider)
                    break
                except PlaywrightError as exc:
                    if attempt or "Execution context was destroyed" not in str(exc):
                        raise
                    await page.wait_for_load_state("domcontentloaded", timeout=60_000)
                    await page.wait_for_timeout(1000)
            assert raw is not None
            try:
                payload = json.loads(raw["text"])
            except json.JSONDecodeError:
                return {
                    "success": False,
                    "message": "Browser session is not authenticated or WAF verification is incomplete",
                    "login_required": True,
                    "login_url": f"/v1/login/{provider['id']}",
                    "page_url": raw["pageUrl"],
                }
            result = normalize_payload(provider, payload)
            result["http_status"] = raw["status"]
            if not result.get("success"):
                result["login_required"] = True
                result["login_url"] = f"/v1/login/{provider['id']}"
            return result

    async def close(self) -> None:
        if self.context:
            await self.context.close()
            self.context = None
        if self.browser:
            await self.browser.close()
            self.browser = None
        if self.playwright:
            await self.playwright.stop()
            self.playwright = None
