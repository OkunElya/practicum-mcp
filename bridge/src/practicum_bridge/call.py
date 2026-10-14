"""Call one tool on a running bridge, for manual testing.

    uv run practicum-call                       # list tools
    uv run practicum-call where_am_i
    uv run practicum-call read_lesson '{"lesson_id": "…"}'
"""

import argparse
import asyncio
import json
import os
import sys
from urllib.parse import urlparse

from mcp.client import Client


def drop_proxies_for_loopback(url: str) -> None:
    # The bridge is local; a system proxy (e.g. ALL_PROXY=socks://…) must not be used,
    # and httpx refuses to even parse some proxy schemes.
    if urlparse(url).hostname in ("127.0.0.1", "localhost", "::1"):
        for key in list(os.environ):
            if key.lower() in ("all_proxy", "http_proxy", "https_proxy"):
                del os.environ[key]


async def main_async(args: argparse.Namespace) -> int:
    drop_proxies_for_loopback(args.url)
    async with Client(args.url) as client:
        if not args.tool:
            for t in (await client.list_tools()).tools:
                print(f"{t.name}: {t.description}")
            return 0

        async def progress(p: float, total: float | None, message: str | None) -> None:
            print(f"… {message}", file=sys.stderr)

        res = await client.call_tool(args.tool, json.loads(args.args), progress_callback=progress)
        for c in res.content:
            print(getattr(c, "text", c))
        return 1 if res.is_error else 0


def main() -> None:
    p = argparse.ArgumentParser(prog="practicum-call", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("tool", nargs="?")
    p.add_argument("args", nargs="?", default="{}", help="JSON object")
    p.add_argument("--url", default="http://127.0.0.1:8766/mcp")
    sys.exit(asyncio.run(main_async(p.parse_args())))


if __name__ == "__main__":
    main()
