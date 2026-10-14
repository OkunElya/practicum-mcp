"""Run the bridge: WebSocket for the extension + MCP for clients.

    uv run practicum-bridge                 # MCP over streamable HTTP at http://127.0.0.1:8766/mcp
    uv run practicum-bridge --stdio         # MCP over stdio (for a client that spawns the bridge)
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from .config import DEFAULT_TOKEN_FILE, DEFAULT_TOOLS_FILE, load_or_create_token, load_tool_specs
from .link import ExtensionLink
from .server import build_server

log = logging.getLogger("practicum_bridge")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="practicum-bridge", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1", help="bind address for both ports (keep it loopback)")
    p.add_argument("--ws-port", type=int, default=8765, help="port the extension connects to")
    p.add_argument("--http-port", type=int, default=8766, help="MCP streamable HTTP port")
    p.add_argument("--stdio", action="store_true", help="serve MCP over stdio instead of HTTP")
    p.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_FILE)
    p.add_argument("--tools", type=Path, default=DEFAULT_TOOLS_FILE, help="shared/tools.json")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


async def serve_mcp(server, args: argparse.Namespace) -> None:
    if args.stdio:
        from mcp.server.stdio import stdio_server

        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
        return

    import uvicorn

    app = server.streamable_http_app(host=args.host)
    log.info("MCP endpoint: http://%s:%d/mcp", args.host, args.http_port)
    config = uvicorn.Config(app, host=args.host, port=args.http_port, log_level="warning")
    await uvicorn.Server(config).serve()


async def run(args: argparse.Namespace) -> None:
    token = load_or_create_token(args.token_file)
    # stderr only: in --stdio mode stdout carries the MCP protocol.
    log.info("extension pairing token (paste into the extension popup): %s", token)

    link = ExtensionLink(token)
    server = build_server(link, load_tool_specs(args.tools))
    tasks = {
        asyncio.create_task(link.serve(args.host, args.ws_port), name="extension link"),
        asyncio.create_task(serve_mcp(server, args), name="mcp"),
    }
    # Whichever ends first (port in use, stdin closed, Ctrl+C) stops the other.
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for t in done:
        if t.exception():
            raise t.exception()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except OSError as e:
        log.error("%s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
