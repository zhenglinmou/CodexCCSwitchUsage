from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class Adapter(ABC):
    @abstractmethod
    async def query(self, provider: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def login(self, provider: dict[str, Any]) -> dict[str, Any]:
        return {"success": False, "message": "This provider does not use browser login"}

    async def close(self) -> None:
        return None
