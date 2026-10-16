"""Bridge settings: pairing token and the shared tool specs."""

import json
import os
import secrets
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "practicum-mcp"
DEFAULT_TOKEN_FILE = CONFIG_DIR / "token"


def _tools_file() -> Path:
    """shared/tools.json in a checkout (bridge/src/practicum_bridge/config.py -> repo root);
    an installed wheel carries its own copy next to this file (the release workflow puts it there)."""
    here = Path(__file__).resolve()
    repo = here.parents[3] / "shared" / "tools.json" if len(here.parents) > 3 else None
    return repo if repo and repo.exists() else here.parent / "tools.json"


DEFAULT_TOOLS_FILE = _tools_file()


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
