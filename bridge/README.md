# practicum-bridge

Python side of Practicum MCP: a WebSocket server the browser extension connects to, and an MCP
server (streamable HTTP or stdio) whose tools the extension executes. See the [main README](../README.md).

```sh
uv run practicum-bridge [--stdio] [--ws-port 8765] [--http-port 8766]
uv run practicum-call [tool] [json-args]
uv run pytest
```
