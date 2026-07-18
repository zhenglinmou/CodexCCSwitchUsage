from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
from typing import Any

from .base import Adapter


class PythonPluginAdapter(Adapter):
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def _load(self, provider: dict[str, Any]):
        relative = Path(str(provider.get("plugin") or ""))
        path = (self.root / relative).resolve()
        if self.root not in path.parents or path.suffix != ".py" or not path.is_file():
            raise ValueError(f"Invalid plugin path: {relative}")
        spec = importlib.util.spec_from_file_location(f"balance_plugin_{provider['id']}", path)
        if not spec or not spec.loader:
            raise ValueError(f"Cannot load plugin: {relative}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    async def query(self, provider: dict[str, Any]) -> dict[str, Any]:
        module = self._load(provider)
        function = getattr(module, "query", None)
        if not callable(function):
            raise ValueError("Plugin must export query(provider)")
        if inspect.iscoroutinefunction(function):
            result = await function(provider)
        else:
            import asyncio
            result = await asyncio.to_thread(function, provider)
        if inspect.isawaitable(result):
            result = await result
        if not isinstance(result, dict):
            raise TypeError("Plugin query() must return a dict")
        result.setdefault("provider", provider["id"])
        return result
