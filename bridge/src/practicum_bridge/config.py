"""Bridge settings: pairing token and the shared tool specs."""

import json
import os
import secrets
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "practicum-mcp"
DEFAULT_TOKEN_FILE = CONFIG_DIR / "token"
# bridge/src/practicum_bridge/config.py -> repo root
DEFAULT_TOOLS_FILE = Path(__file__).resolve().parents[3] / "shared" / "tools.json"


def load_or_create_token(path: Path = DEFAULT_TOKEN_FILE) -> str:
    """Read the pairing token, generating it (mode 600) on first run."""
    if path.exists():
        token = path.read_text().strip()
        if token:
            return token
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(24)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    return token


def load_tool_specs(path: Path = DEFAULT_TOOLS_FILE) -> list[dict]:
    return json.loads(path.read_text())["tools"]
