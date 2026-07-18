from __future__ import annotations

import asyncio

from balance_gateway.app import run


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
