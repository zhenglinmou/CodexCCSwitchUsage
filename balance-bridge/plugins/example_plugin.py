"""Example adapter for a provider whose protocol cannot be expressed in providers.json."""

from __future__ import annotations

from typing import Any


def query(provider: dict[str, Any]) -> dict[str, Any]:
    # Make the provider-specific request here. Keep secrets in provider["settings"]
    # and return the gateway's normalized response shape.
    return {
        "success": True,
        "data": {
            "planName": provider["name"],
            "remaining": 0.0,
            "used": 0.0,
            "total": 0.0,
            "unit": "USD",
            "extra": "Replace plugins/example_plugin.py with the real provider request",
            "isValid": True,
        },
    }
