"""Read-only balance adapters for providers stored by CC Switch.

No credential is copied into the bridge configuration.  Every query loads the
current provider record (or an existing CC Switch backup for the legacy
AnyRouter cookie) and returns only normalized, non-secret fields.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

import requests


CC_SWITCH_DB = Path.home() / ".cc-switch" / "cc-switch.db"
CC_SWITCH_BACKUPS = Path.home() / ".cc-switch" / "backups"
CPA_AUTH_DIR = Path.home() / ".cli-proxy-api"
WHAM_URL = "https://chatgpt.com/backend-api/wham/usage"
QUOTA_PER_USD = 500_000


def _failure(provider: dict[str, Any], message: str, **extra: Any) -> dict[str, Any]:
    result = {"success": False, "provider": provider["id"], "message": message}
    result.update(extra)
    return result


def _success(
    provider: dict[str, Any],
    *,
    plan: str,
    remaining: float | None,
    used: float | None,
    total: float | None,
    unit: str,
    extra: str = "",
    request_count: int = 0,
    **metadata: Any,
) -> dict[str, Any]:
    data = {
        "isValid": True,
        "planName": plan,
        "remaining": remaining,
        "used": used,
        "total": total,
        "unit": unit,
        "extra": extra,
        "requestCount": request_count,
    }
    data.update(metadata)
    return {"success": True, "provider": provider["id"], "data": data}


def _read_cc_switch_provider(provider: dict[str, Any]) -> dict[str, Any]:
    provider_ref = str(provider.get("cc_switch_provider_id") or "")
    if not provider_ref:
        raise ValueError("cc_switch_provider_id is required")
    uri = f"file:{CC_SWITCH_DB.as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT id, name, settings_config, meta FROM providers "
            "WHERE app_type = 'codex' AND id = ? LIMIT 1",
            (provider_ref,),
        ).fetchone()
    if not row:
        raise ValueError(f"CC Switch provider no longer exists: {provider_ref}")
    return {
        "id": row["id"],
        "name": row["name"],
        "settings": json.loads(row["settings_config"] or "{}"),
        "meta": json.loads(row["meta"] or "{}"),
    }


def _api_key(record: dict[str, Any]) -> str:
    return str((record["settings"].get("auth") or {}).get("OPENAI_API_KEY") or "")


def _api_base(record: dict[str, Any]) -> str:
    config = str(record["settings"].get("config") or "")
    match = re.search(r"(?m)^\s*base_url\s*=\s*[\"']([^\"']+)", config)
    return match.group(1).rstrip("/") if match else ""


def _get_json(
    url: str,
    *,
    headers: dict[str, str],
    timeout: float = 30,
    session: requests.Session | None = None,
) -> tuple[int, Any, str]:
    client = session or requests
    response = client.get(url, headers=headers, timeout=timeout)
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return response.status_code, payload, response.text


def _local_usage(record_id: str) -> tuple[int, float]:
    uri = f"file:{CC_SWITCH_DB.as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        row = connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) "
            "FROM proxy_request_logs WHERE provider_id = ? AND app_type = 'codex'",
            (record_id,),
        ).fetchone()
    return int(row[0] or 0), float(row[1] or 0)


def _path_value(payload: Any, path: str, default: Any = None) -> Any:
    current = payload
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return default
    return current


def _window_label(seconds: int | float | None, fallback: str) -> str:
    seconds = int(seconds or 0)
    if seconds and seconds % 86_400 == 0:
        days = seconds // 86_400
        return f"{days}天" if days != 1 else "24小时"
    if seconds and seconds % 3_600 == 0:
        return f"{seconds // 3_600}小时"
    return fallback


def _configured_limits(provider: dict[str, Any], payload: dict[str, Any]) -> list[dict[str, Any]]:
    limits = []
    for item in provider.get("limit_windows") or []:
        remaining = float(_path_value(payload, str(item["remaining_path"]), 0) or 0)
        used = float(_path_value(payload, str(item["used_path"]), 0) or 0)
        total_path = item.get("total_path")
        total = float(_path_value(payload, str(total_path), remaining + used) or 0) if total_path else remaining + used
        limits.append(
            {
                "id": str(item["id"]),
                "label": str(item.get("label") or item["id"]),
                "windowSeconds": item.get("window_seconds"),
                "remaining": remaining,
                "used": used,
                "total": total,
                "unit": str(item.get("unit") or "USD"),
                "resetAt": _path_value(payload, str(item.get("reset_at_path") or ""))
                if item.get("reset_at_path")
                else None,
            }
        )
    return limits


def _deepseek(provider: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    key = _api_key(record)
    base = _api_base(record) or "https://api.deepseek.com"
    status, payload, _ = _get_json(
        base + "/user/balance",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    if status != 200 or not isinstance(payload, dict) or not payload.get("is_available"):
        message = payload.get("message") if isinstance(payload, dict) else None
        return _failure(provider, str(message or f"DeepSeek balance query failed (HTTP {status})"), http_status=status)
    infos = payload.get("balance_infos") or []
    balances = []
    for item in infos:
        try:
            balances.append((str(item.get("currency") or ""), float(item.get("total_balance") or 0)))
        except (TypeError, ValueError):
            continue
    remaining = sum(value for _, value in balances)
    unit = balances[0][0] if len({currency for currency, _ in balances}) == 1 else "currency"
    details = "，".join(f"{currency}: {value:g}" for currency, value in balances)
    return _success(
        provider,
        plan="DeepSeek",
        remaining=remaining,
        used=None,
        total=None,
        unit=unit or "CNY",
        extra=details,
        balanceSupported=True,
        source="official_api",
    )


def _packy(provider: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    status, payload, _ = _get_json(
        "https://www.packyapi.com/api/usage/token/",
        headers={
            "Authorization": f"Bearer {_api_key(record)}",
            "Accept": "application/json",
            "User-Agent": "cc-switch/1.0",
        },
    )
    if status != 200 or not isinstance(payload, dict) or payload.get("code") is not True:
        message = payload.get("message") if isinstance(payload, dict) else None
        return _failure(provider, str(message or f"PackyCode query failed (HTTP {status})"), http_status=status)
    data = payload.get("data") or {}
    remaining = float(data.get("total_available") or 0) / QUOTA_PER_USD
    used = float(data.get("total_used") or 0) / QUOTA_PER_USD
    return _success(
        provider,
        plan="PackyCode",
        remaining=remaining,
        used=used,
        total=remaining + used,
        unit="USD",
        extra=f"重置周期: {data.get('quota_reset_period') or '未知'}",
        balanceSupported=True,
        source="provider_api",
    )


def _paid_window(provider: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    base = _api_base(record)
    status, payload, _ = _get_json(
        base + "/user/balance",
        headers={
            "Authorization": f"Bearer {_api_key(record)}",
            "Accept": "application/json",
            "User-Agent": "cc-switch/1.0",
        },
    )
    if status != 200 or not isinstance(payload, dict):
        return _failure(provider, f"Window balance query failed (HTTP {status})", http_status=status)
    if payload.get("is_active") is False:
        return _failure(provider, str(payload.get("reason") or "Account is inactive"), http_status=status)
    limits = _configured_limits(provider, payload)
    if not limits:
        return _failure(provider, "No limit_windows mapping is configured")
    primary_id = str(provider.get("primary_limit") or limits[0]["id"])
    primary = next((item for item in limits if item["id"] == primary_id), limits[0])
    extra = "；".join(
        f"{item['label']} 剩余 {item['remaining']:.2f}/{item['total']:.2f} {item['unit']}"
        for item in limits
    )
    return _success(
        provider,
        plan=record["name"],
        remaining=primary["remaining"],
        used=primary["used"],
        total=primary["total"],
        unit=primary["unit"],
        extra=extra,
        balanceSupported=True,
        source="provider_api",
        primaryLimitId=primary["id"],
        limits=limits,
    )


def _cpa_token(account_id: str) -> dict[str, Any] | None:
    if not CPA_AUTH_DIR.exists():
        return None
    candidates = []
    for path in CPA_AUTH_DIR.glob("*.json"):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if item.get("type") == "codex" and str(item.get("account_id") or "") == account_id:
            candidates.append((path.stat().st_mtime, item))
    return max(candidates, default=(0, None), key=lambda pair: pair[0])[1]


def _query_wham(access_token: str, account_id: str) -> tuple[int, Any]:
    status, payload, _ = _get_json(
        WHAM_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "ChatGPT-Account-Id": account_id,
            "Accept": "application/json",
            "User-Agent": "cc-switch-balance-bridge/2",
        },
    )
    return status, payload


def _wham_summary(payload: dict[str, Any]) -> dict[str, Any]:
    rate_limit = payload.get("rate_limit") or {}
    limits = []
    for window_id, fallback in (("primary", "主窗口"), ("secondary", "次窗口")):
        window = rate_limit.get(f"{window_id}_window")
        if not isinstance(window, dict):
            continue
        used_percent = float(window.get("used_percent") or 0)
        window_seconds = int(window.get("limit_window_seconds") or 0)
        limits.append(
            {
                "id": window_id,
                "label": _window_label(window_seconds, fallback),
                "windowSeconds": window_seconds or None,
                "remaining": max(0.0, 100.0 - used_percent),
                "used": used_percent,
                "total": 100.0,
                "unit": "%",
                "resetAfterSeconds": int(window.get("reset_after_seconds") or 0),
                "resetAt": window.get("reset_at"),
            }
        )
    window = limits[0] if limits else {
        "remaining": 100.0,
        "used": 0.0,
        "resetAfterSeconds": 0,
        "resetAt": None,
    }
    used = float(window["used"])
    remaining = max(0.0, 100.0 - used)
    reset_seconds = int(window.get("resetAfterSeconds") or 0)
    credits = payload.get("credits") or {}
    return {
        "plan": str(payload.get("plan_type") or "OpenAI"),
        "remaining": remaining,
        "used": used,
        "reset_seconds": reset_seconds,
        "reset_at": window.get("resetAt"),
        "credit_balance": credits.get("balance"),
        "limit_reached": bool(rate_limit.get("limit_reached")),
        "limits": limits,
    }


def _openai(provider: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    auth = record["settings"].get("auth") or {}
    tokens = auth.get("tokens") or {}
    account_id = str(tokens.get("account_id") or "")
    access_token = str(tokens.get("access_token") or "")
    cpa = _cpa_token(account_id)
    if cpa and cpa.get("access_token"):
        access_token = str(cpa["access_token"])
    if not access_token or not account_id:
        return _failure(provider, "OpenAI account token is missing", login_required=True)
    status, payload = _query_wham(access_token, account_id)
    if status != 200 or not isinstance(payload, dict):
        message = ((payload or {}).get("error") or {}).get("message") if isinstance(payload, dict) else None
        if status in {401, 403}:
            return _success(
                provider,
                plan=record["name"],
                remaining=None,
                used=None,
                total=None,
                unit="%",
                extra=str(message or "OpenAI 登录已失效，请重新登录该账号"),
                isValid=False,
                invalidMessage=str(message or "OpenAI 登录已失效，请重新登录该账号"),
                loginRequired=True,
                balanceSupported=True,
                source="openai_wham",
                httpStatus=status,
            )
        return _failure(
            provider,
            str(message or f"OpenAI usage query failed (HTTP {status})"),
            http_status=status,
        )
    info = _wham_summary(payload)
    limit_text = []
    for item in info["limits"]:
        text = f"{item['label']} {item['remaining']:.1f}% 可用"
        if item["resetAfterSeconds"]:
            text += f"，约 {item['resetAfterSeconds'] // 60} 分钟后重置"
        limit_text.append(text)
    extra = "；".join(limit_text) or f"主窗口 {info['remaining']:.1f}% 可用"
    if info["credit_balance"] is not None:
        extra += f"，Credits {info['credit_balance']}"
    return _success(
        provider,
        plan=f"OpenAI {info['plan']}",
        remaining=info["remaining"],
        used=info["used"],
        total=100.0,
        unit="%",
        extra=extra,
        balanceSupported=True,
        source="openai_wham",
        primaryLimitId="primary",
        limits=info["limits"],
        resetAt=info["reset_at"],
        limitReached=info["limit_reached"],
    )


def _cpa_accounts(provider: dict[str, Any]) -> dict[str, Any]:
    accounts = []
    if CPA_AUTH_DIR.exists():
        for path in sorted(CPA_AUTH_DIR.glob("*.json")):
            try:
                auth = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if auth.get("type") != "codex" or not auth.get("access_token") or not auth.get("account_id"):
                continue
            status, payload = _query_wham(str(auth["access_token"]), str(auth["account_id"]))
            item = {
                "label": path.stem,
                "enabled": not bool(auth.get("disabled")),
                "success": status == 200 and isinstance(payload, dict),
            }
            if item["success"]:
                item.update(_wham_summary(payload))
            else:
                item["httpStatus"] = status
            accounts.append(item)
    usable = [item for item in accounts if item.get("success") and item.get("enabled")]
    if not usable:
        usable = [item for item in accounts if item.get("success")]
    if not usable:
        return _failure(provider, "CLIProxyAPI has no queryable Codex account", login_required=True)
    remaining = min(float(item["remaining"]) for item in usable)
    used = max(float(item["used"]) for item in usable)
    extra = "；".join(
        f"{item['label']}: {item['remaining']:.1f}% 可用{'（已停用）' if not item['enabled'] else ''}"
        for item in accounts
        if item.get("success")
    )
    safe_accounts = [
        {
            "label": item["label"],
            "enabled": item["enabled"],
            "success": item["success"],
            "plan": item.get("plan"),
            "remaining": item.get("remaining"),
            "used": item.get("used"),
            "resetAt": item.get("reset_at"),
            "limits": item.get("limits") or [],
        }
        for item in accounts
    ]
    return _success(
        provider,
        plan=f"CLIProxyAPI ({len(usable)} 个可用账号)",
        remaining=remaining,
        used=used,
        total=100.0,
        unit="%",
        extra=extra,
        balanceSupported=True,
        source="cpa_auth_files",
        accounts=safe_accounts,
    )


def _find_anyrouter_cookie() -> tuple[str, str]:
    databases = [CC_SWITCH_DB]
    if CC_SWITCH_BACKUPS.exists():
        databases.extend(sorted(CC_SWITCH_BACKUPS.glob("*.db"), key=lambda path: path.stat().st_mtime, reverse=True))
    names = ("any的国外", "any的国外我自己的")
    for database in databases:
        try:
            uri = f"file:{database.as_posix()}?mode=ro"
            with sqlite3.connect(uri, uri=True) as connection:
                rows = connection.execute(
                    "SELECT meta FROM providers WHERE app_type = 'codex' AND name IN (?, ?)", names
                ).fetchall()
        except sqlite3.Error:
            continue
        for (raw_meta,) in rows:
            try:
                usage = (json.loads(raw_meta or "{}") or {}).get("usage_script") or {}
            except json.JSONDecodeError:
                continue
            cookie = str(usage.get("accessToken") or "")
            user_id = str(usage.get("userId") or "")
            if cookie and user_id and "=" in cookie:
                return cookie, user_id
    return "", ""


def _solve_acw(arg1: str) -> str:
    permutation = [15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36]
    xor_key = "3000176000856006061501533003690027800375"
    reordered = [""] * 40
    for index, character in enumerate(arg1):
        for destination, source in enumerate(permutation):
            if source == index + 1:
                reordered[destination] = character
                break
    value = "".join(reordered)
    return "".join(
        f"{int(value[index:index + 2], 16) ^ int(xor_key[index:index + 2], 16):02x}"
        for index in range(0, 40, 2)
    )


def _anyrouter(provider: dict[str, Any]) -> dict[str, Any]:
    cookie, user_id = _find_anyrouter_cookie()
    if not cookie or not user_id:
        return _failure(
            provider,
            "AnyRouter login cookie is missing; update the CC Switch usage credential first",
            login_required=True,
        )
    session = requests.Session()
    for segment in cookie.split(";"):
        if "=" not in segment:
            continue
        name, value = segment.strip().split("=", 1)
        if name and value:
            session.cookies.set(name, value, domain="anyrouter.top", path="/")
    headers = {
        "Accept": "application/json",
        "New-Api-User": user_id,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
    }
    payload = None
    status = 0
    for _ in range(3):
        status, candidate, text = _get_json(
            "https://anyrouter.top/api/user/self", headers=headers, timeout=45, session=session
        )
        if isinstance(candidate, dict):
            payload = candidate
            break
        challenge = re.search(r"var arg1='([0-9A-Fa-f]{40})'", text)
        if not challenge:
            break
        session.cookies.set("acw_sc__v2", _solve_acw(challenge.group(1)), domain="anyrouter.top", path="/")
    if not isinstance(payload, dict) or not payload.get("success"):
        message = payload.get("message") if isinstance(payload, dict) else None
        return _failure(
            provider,
            str(message or "AnyRouter session expired or WAF verification failed"),
            http_status=status,
            login_required=True,
        )
    data = payload.get("data") or {}
    remaining = float(data.get("quota") or 0) / QUOTA_PER_USD
    used = float(data.get("used_quota") or 0) / QUOTA_PER_USD
    return _success(
        provider,
        plan=str(data.get("group") or "AnyRouter"),
        remaining=remaining,
        used=used,
        total=remaining + used,
        unit="USD",
        extra="",
        request_count=int(data.get("request_count") or 0),
        balanceSupported=True,
        source="cc_switch_cookie_direct",
    )


def _health_only(provider: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    base = _api_base(record)
    status, payload, _ = _get_json(
        base + "/models",
        headers={"Authorization": f"Bearer {_api_key(record)}", "Accept": "application/json"},
    )
    requests_count, local_cost = _local_usage(record["id"])
    if status != 200 or not isinstance(payload, dict):
        message = None
        if isinstance(payload, dict):
            error = payload.get("error")
            message = error.get("message") if isinstance(error, dict) else payload.get("message")
        invalid = str(message or f"API Key 当前不可用 (HTTP {status})")
        return _success(
            provider,
            plan=record["name"],
            remaining=None,
            used=local_cost,
            total=None,
            unit="USD",
            extra=invalid + "；该站未提供可由模型 API Key 调用的余额接口",
            request_count=requests_count,
            isValid=False,
            invalidMessage=invalid,
            balanceSupported=False,
            source="api_health_and_local_usage",
            httpStatus=status,
        )
    return _success(
        provider,
        plan=record["name"],
        remaining=None,
        used=local_cost,
        total=None,
        unit="USD",
        extra="API Key 可用；该站未提供可由模型 API Key 调用的余额接口，used 为 CC Switch 本地记录费用",
        request_count=requests_count,
        balanceSupported=False,
        source="api_health_and_local_usage",
        modelCount=len(payload.get("data") or []),
    )


def query(provider: dict[str, Any]) -> dict[str, Any]:
    """Entry point used by PythonPluginAdapter."""
    mode = str(provider.get("mode") or "")
    try:
        if mode == "cpa_accounts":
            return _cpa_accounts(provider)
        if mode == "anyrouter":
            return _anyrouter(provider)
        record = _read_cc_switch_provider(provider)
        handlers = {
            "deepseek": _deepseek,
            "packy": _packy,
            "paid_window": _paid_window,
            "openai": _openai,
            "health_only": _health_only,
        }
        handler = handlers.get(mode)
        if not handler:
            return _failure(provider, f"Unknown CC Switch adapter mode: {mode}")
        return handler(provider, record)
    except requests.RequestException as exc:
        return _failure(provider, f"Connection failed: {exc}")
    except (OSError, sqlite3.Error, json.JSONDecodeError, ValueError) as exc:
        return _failure(provider, str(exc))
