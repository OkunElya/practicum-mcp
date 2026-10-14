"""MCP server whose tools are executed by the browser extension."""

import logging
from typing import Any

import mcp_types as types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server

from .link import ExtensionLink, ToolCallError

log = logging.getLogger(__name__)

INSTRUCTIONS = """\
These tools act in the user's own logged-in Yandex Practicum tab (practicum.yandex.ru) in
their browser, through an extension. The user watches every action and can stop it.
Start with where_am_i. Tools marked destructive record something on the user's account
and may ask the user for approval first; a denied approval is final, don't retry it.
Errors of kind "platform" are the site's own instability: retrying later is fine.
"""

# effect (from shared/tools.json) -> MCP tool hints
_HINTS: dict[str, dict[str, bool]] = {
    "read": {"read_only_hint": True},
    "nav": {"read_only_hint": False, "destructive_hint": False, "idempotent_hint": True},
    "rev": {"read_only_hint": False, "destructive_hint": False},
    "irrev": {"read_only_hint": False, "destructive_hint": True},
}

_JSON_TYPES = {"string", "number", "integer", "boolean"}


def input_schema(params: dict[str, dict[str, Any]]) -> dict[str, Any]:
    props: dict[str, Any] = {}
    for name, p in params.items():
        prop: dict[str, Any] = {
            "type": p["type"] if p.get("type") in _JSON_TYPES else "string",
            "description": p.get("description", ""),
        }
        for key in ("enum", "default"):
            if key in p:
                prop[key] = p[key]
        props[name] = prop
    required = [n for n, p in params.items() if not p.get("optional") and "default" not in p]
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


def to_mcp_tool(spec: dict[str, Any]) -> types.Tool:
    return types.Tool(
        name=spec["name"],
        description=spec.get("description", ""),
        input_schema=input_schema(spec.get("params", {})),
        annotations=types.ToolAnnotations(open_world_hint=True, **_HINTS.get(spec.get("effect", ""), {})),
    )


def _text(text: str, is_error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=is_error)


def build_server(link: ExtensionLink, static_specs: list[dict[str, Any]]) -> Server:
    def specs() -> list[dict[str, Any]]:
        # The connected extension's own list wins: it knows what it implements.
        return link.tools if link.connected and link.tools else static_specs

    async def list_tools(ctx: ServerRequestContext, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
        return types.ListToolsResult(tools=[to_mcp_tool(s) for s in specs()])

    async def call_tool(ctx: ServerRequestContext, params: types.CallToolRequestParams) -> types.CallToolResult:
        spec = next((s for s in specs() if s["name"] == params.name), None)
        if spec is None:
            names = ", ".join(s["name"] for s in specs())
            return _text(f"unknown tool {params.name!r}. Available: {names}", is_error=True)

        step = 0

        async def on_progress(text: str) -> None:
            nonlocal step
            step += 1
            try:  # a no-op unless the client asked for progress
                await ctx.session.report_progress(step, message=text)
            except Exception:
                log.debug("progress notification failed", exc_info=True)

        timeout = float(spec.get("timeout_s", 60))
        try:
            output = await link.call(params.name, dict(params.arguments or {}), timeout, on_progress)
        except ToolCallError as e:
            return _text(f"[{e.kind}] {e}", is_error=True)
        return _text(output)

    return Server(
        "practicum-mcp",
        version="0.1.0",
        instructions=INSTRUCTIONS,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )
