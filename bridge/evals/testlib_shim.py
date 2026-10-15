"""Local stand-in for Practicum's private "ast_testlib" used by QuizCoding tests.

    from testlib_shim import grade
    grade(user_code, answer_code, test, precode="", timeout=10)
    -> {"solved": bool, "message": str, "stdout": str, "stderr": str}

Everything runs in a separate ``python -I`` process (this file re-executed
with ``--worker``); nothing from the student, the reference or the test is
executed in the caller's process.

The test source is executed with these globals (inferred from the scraped
tests, the real library is not public):

- ``_u`` - the student's module after execution: its globals, plus
  ``_output`` (what it printed, trailing newlines stripped) and ``user_code``;
- ``_a`` - the same for the reference solution;
- ``_test`` - the checker object (see ``Checker``);
- ``ast``.

The first ``AssertionError`` becomes ``message``; no failure means solved.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys

RESULT_MARK = "\x00TESTLIB_SHIM_RESULT\x00"
USER_FILE = "main.py"
ANSWER_FILE = "<author>"
PRECODE_FILE = "<precode>"


def grade(
    user_code: str,
    answer_code: str,
    test: str,
    precode: str = "",
    timeout: float = 10,
) -> dict:
    payload = json.dumps(
        {"user": user_code, "answer": answer_code, "test": test or "", "precode": precode or ""}
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-I", os.path.abspath(__file__), "--worker"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"PYTHONIOENCODING": "utf-8", "PATH": os.environ.get("PATH", "")},
        )
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        return {
            "solved": False,
            "message": f"TimeoutError: превышено время выполнения ({timeout:g} с).",
            "stdout": out.split(RESULT_MARK)[0],
            "stderr": "timeout",
        }
    idx = proc.stdout.rfind(RESULT_MARK)
    if idx < 0:
        return {
            "solved": False,
            "message": f"Проверка завершилась аварийно (код {proc.returncode}).",
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    result = json.loads(proc.stdout[idx + len(RESULT_MARK):])
    if proc.stderr:
        result["stderr"] = (result.get("stderr") or "") + proc.stderr
    return result


# --------------------------------------------------------------------------
# Worker side (runs in the subprocess).
# --------------------------------------------------------------------------

_MISSING = object()


class _Recorder:
    """Records calls made directly from student code (sys.setprofile)."""

    def __init__(self, filename: str):
        self.filename = filename
        self.calls: list[tuple[str, tuple | None, dict | None]] = []

    def __call__(self, frame, event, arg):
        try:
            if event == "call":
                caller = frame.f_back
                if caller is None or caller.f_code.co_filename != self.filename:
                    return
                code = frame.f_code
                loc = frame.f_locals
                n = code.co_argcount + code.co_kwonlyargcount
                names = code.co_varnames[:n]
                pos = tuple(_snapshot(loc.get(v)) for v in code.co_varnames[: code.co_argcount])
                if code.co_flags & 0x04:  # *args
                    pos += tuple(loc.get(code.co_varnames[n], ()))
                kw = {v: _snapshot(loc.get(v)) for v in names}
                self.calls.append((code.co_name, pos, kw))
            elif event == "c_call":
                if frame.f_code.co_filename != self.filename:
                    return
                self.calls.append((getattr(arg, "__name__", ""), None, None))
        except Exception:
            pass


def _snapshot(value):
    import copy

    try:
        return copy.deepcopy(value)
    except Exception:
        return value


def _run_module(name, filename, code, precode="", record=False, overrides=None):
    """Execute code in a fresh module; return (module, stdout, error, traceback, calls)."""
    import io
    import traceback
    import types
    from contextlib import redirect_stderr, redirect_stdout

    mod = types.ModuleType("__main__")
    mod.__dict__["__builtins__"] = __builtins__
    out, err = io.StringIO(), io.StringIO()
    error = tb = None
    recorder = _Recorder(filename) if record else None
    try:
        tree = ast.parse(code, filename)
        if overrides:
            tree = _override_assignments(tree, overrides)
        compiled = compile(tree, filename, "exec")
    except SyntaxError as exc:
        return mod, "", exc, traceback.format_exc(limit=0), []
    with redirect_stdout(out), redirect_stderr(err):
        try:
            if precode.strip():
                exec(compile(precode, PRECODE_FILE, "exec"), mod.__dict__)
            if recorder:
                sys.setprofile(recorder)
            try:
                exec(compiled, mod.__dict__)
            finally:
                sys.setprofile(None)
        except BaseException as exc:  # noqa: BLE001 - SystemExit/KeyboardInterrupt too
            if isinstance(exc, SystemExit) and exc.code in (None, 0):
                pass
            else:
                error = exc
                tb = _user_traceback(exc, filename)
    stdout = out.getvalue()
    mod.__dict__["_output"] = stdout.rstrip("\n")
    mod.__dict__["user_code"] = code
    mod.__dict__["_stderr"] = err.getvalue()
    return mod, stdout, error, tb, (recorder.calls if recorder else [])


def _user_traceback(exc, filename):
    import traceback

    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename != __file__]
    lines = ["Traceback (most recent call last):\n"]
    lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(exc), exc)
    return "".join(lines)


def _format_error(exc):
    if isinstance(exc, SyntaxError):
        where = f" (line {exc.lineno})" if exc.lineno else ""
        return f"{type(exc).__name__}: {exc.msg}{where}"
    return f"{type(exc).__name__}: {exc}"


def _override_assignments(tree, overrides):
    """Replace the value of the first top-level ``name = ...`` for each override."""
    pending = dict(overrides)
    for stmt in tree.body:
        targets = []
        if isinstance(stmt, ast.Assign):
            targets = [t.id for t in stmt.targets if isinstance(t, ast.Name)]
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value:
            targets = [stmt.target.id]
        for t in targets:
            if t in pending:
                stmt.value = ast.copy_location(_const(pending.pop(t)), stmt.value)
                break
    if pending:  # not assigned at top level: define them up front
        pre = [
            ast.Assign(targets=[ast.Name(id=k, ctx=ast.Store())], value=_const(v))
            for k, v in pending.items()
        ]
        tree.body[:0] = pre
    return ast.fix_missing_locations(tree)


def _const(value):
    return ast.parse(repr(value), mode="eval").body


# ---------------------------------------------------------------- queries


def _walk(node):
    """Pre-order (source order) walk including the node itself."""
    yield node
    for child in ast.iter_child_nodes(node):
        yield from _walk(child)


def _resolve(obj, parts):
    for p in parts:
        if isinstance(obj, (list, tuple)):
            try:
                obj = obj[int(p)]
            except (ValueError, IndexError):
                return _MISSING
        else:
            obj = getattr(obj, p, _MISSING)
        if obj is _MISSING:
            return _MISSING
    return obj


_OPS = {
    "nclass": lambda v, x: isinstance(v, x),
    "exact": lambda v, x: v == x,
    "iexact": lambda v, x: isinstance(v, str) and v.lower() == str(x).lower(),
    "in": lambda v, x: v in x,
    "contains": lambda v, x: x in v,
    "icontains": lambda v, x: str(x).lower() in str(v).lower(),
    "startswith": lambda v, x: isinstance(v, str) and v.startswith(x),
    "endswith": lambda v, x: isinstance(v, str) and v.endswith(x),
    "gt": lambda v, x: v > x,
    "gte": lambda v, x: v >= x,
    "lt": lambda v, x: v < x,
    "lte": lambda v, x: v <= x,
    "len": lambda v, x: len(v) == x,
    "isnull": lambda v, x: (v is None) == bool(x),
}


def _match(node, cls, lookups):
    if cls is not None and not isinstance(node, cls):
        return False
    for key, expected in lookups.items():
        parts = key.split("__")
        op = "exact"
        if len(parts) > 1 and parts[-1] in _OPS:
            op = parts.pop()
        elif parts == ["nclass"]:
            op, parts = "nclass", []
        value = _resolve(node, parts)
        if value is _MISSING:
            if op == "isnull" and expected:
                continue
            return False
        try:
            if op == "exact":
                # 1 == True in Python; keep bool and int lookups apart
                if isinstance(value, bool) != isinstance(expected, bool):
                    return False
                if not value == expected:
                    return False
            elif not _OPS[op](value, expected):
                return False
        except Exception:
            return False
    return True


class Query:
    """Result of ``_test.node(...)``: a set of AST nodes, chainable."""

    def __init__(self, nodes):
        self.all = list(nodes)

    def node(self, cls=None, **lookups):
        if isinstance(cls, str):  # tolerate node('Call', ...)
            cls = getattr(ast, cls)
        seen, found = set(), []
        for root in self.all:
            for n in _walk(root):
                if id(n) not in seen and _match(n, cls, lookups):
                    seen.add(id(n))
                    found.append(n)
        return Query(found)

    @property
    def exists(self):
        return bool(self.all)

    @property
    def first(self):
        return self.all[0] if self.all else None

    @property
    def last(self):
        return self.all[-1] if self.all else None

    @property
    def count(self):
        return len(self.all)

    def __len__(self):
        return len(self.all)

    def __iter__(self):
        return iter(self.all)

    def __getitem__(self, i):
        return self.all[i]

    def __bool__(self):
        return bool(self.all)

    def __repr__(self):
        return f"Query({len(self.all)} nodes)"


def _fail(m, default):
    raise AssertionError(m if m is not None else default)


class Checker:
    """The ``_test`` object."""

    def __init__(self, user_mod, answer_mod, user_src, answer_src, user_tree, calls, precode):
        self._u = user_mod
        self._a = answer_mod
        self.usr_src = user_src
        self.user_code = user_src
        self.ans_src = answer_src
        self.tree = user_tree
        self._calls = calls
        self._precode = precode

    # ---- AST
    def node(self, cls=None, **lookups):
        return Query([self.tree]).node(cls, **lookups)

    # ---- variables
    def var_exists(self, *names, same_type=False, m=None):
        for name in names:
            if name not in self._u.__dict__:
                _fail(m, f"Убедитесь, что в коде объявлена переменная `{name}`.")
            if same_type and name in self._a.__dict__:
                if type(self._u.__dict__[name]) is not type(self._a.__dict__[name]):
                    _fail(
                        m,
                        f"Убедитесь, что переменная `{name}` имеет тип "
                        f"`{type(self._a.__dict__[name]).__name__}`.",
                    )
        return True

    def var(self, *names, m=None):
        for name in names:
            default = f"Не удаляйте и не изменяйте переменную `{name}`."
            if name not in self._u.__dict__:
                _fail(m, default)
            if name not in self._a.__dict__:
                continue
            u, a = self._u.__dict__[name], self._a.__dict__[name]
            try:
                same = type(u) is type(a) and bool(u == a)
            except Exception:
                same = False
            if not same:
                _fail(m, default)
        return True

    # ---- output
    def output(self, m=None):
        u = _norm_output(self._u._output)
        a = _norm_output(self._a._output)
        if u != a:
            _fail(
                m,
                "Проверьте, что выведенный текст соответствует ожидаемому.\n"
                f"Ваш вывод:\n\n```\n{self._u._output}\n```\n\n"
                f"А должно быть:\n\n```\n{self._a._output}\n```",
            )
        return True

    # ---- calls
    def call(self, name, args=None, kwargs=None, m=None):
        default = f"Убедитесь, что в коде вызвана функция `{name}`."
        short = name.rsplit(".", 1)[-1]
        runtime = [c for c in self._calls if c[0] in (name, short)]
        if args is None and kwargs is None:
            if runtime or self._ast_calls(short):
                return True
            _fail(m, default)
        for _, pos, kw in runtime:
            if pos is None:
                continue
            ok = True
            if args is not None:
                try:
                    ok = list(pos[: len(args)]) == list(args) and len(pos) >= len(args)
                except Exception:
                    ok = False
            if ok and kwargs:
                ok = all(kw.get(k, _MISSING) == v for k, v in kwargs.items())
            if ok:
                return True
        # builtins: arguments are not visible at runtime, compare literal args in the AST
        if args is not None and any(c[1] is None for c in runtime):
            for node in self._ast_calls(short):
                try:
                    vals = [ast.literal_eval(a) for a in node.args]
                except Exception:
                    continue
                if vals[: len(args)] == list(args):
                    return True
        _fail(m, default)

    def _ast_calls(self, short):
        found = []
        for n in _walk(self.tree):
            if isinstance(n, ast.Call):
                f = n.func
                if (isinstance(f, ast.Name) and f.id == short) or (
                    isinstance(f, ast.Attribute) and f.attr == short
                ):
                    found.append(n)
        return found

    # ---- imports
    def imports(self, *modules, m=None):
        for module in modules:
            ok = False
            for n in _walk(self.tree):
                if isinstance(n, ast.Import):
                    ok |= any(a.name == module or a.name.startswith(module + ".") for a in n.names)
                elif isinstance(n, ast.ImportFrom) and n.module:
                    ok |= n.module == module or n.module.startswith(module + ".")
                    ok |= any(f"{n.module}.{a.name}" == module for a in n.names)
            if not ok:
                _fail(m, f"Убедитесь, что в коде импортирован модуль `{module}`.")
        return True

    # ---- re-run with other variable values
    def matrix(self, values, m=None):
        names = list(values)
        rows = list(zip(*(values[k] for k in names)))
        for row in rows:
            overrides = dict(zip(names, row))
            desc = ", ".join(f"{k} = {v!r}" for k, v in overrides.items())
            _, u_out, u_err, _, _ = _run_module(
                "user", USER_FILE, self.usr_src, self._precode, overrides=overrides
            )
            _, a_out, _, _, _ = _run_module(
                "answer", ANSWER_FILE, self.ans_src, self._precode, overrides=overrides
            )
            if u_err is not None:
                _fail(m, f"При значениях {desc} в коде возникла ошибка:\n`{_format_error(u_err)}`")
            if _norm_output(u_out) != _norm_output(a_out):
                _fail(
                    m,
                    f"Проверьте работу программы при значениях {desc}.\n"
                    f"Ваш вывод:\n\n```\n{u_out.rstrip()}\n```\n\n"
                    f"А должно быть:\n\n```\n{a_out.rstrip()}\n```",
                )
        return True


def _norm_output(text):
    return "\n".join(line.rstrip() for line in text.strip("\n").splitlines()).strip()


def _worker():
    import io
    import traceback

    data = json.loads(sys.stdin.read())
    sys.stdin = io.StringIO("")
    real_stdout = sys.stdout

    def finish(solved, message, stdout="", stderr=""):
        real_stdout.write(
            RESULT_MARK
            + json.dumps(
                {"solved": solved, "message": message, "stdout": stdout, "stderr": stderr},
                ensure_ascii=False,
            )
        )
        real_stdout.flush()
        os._exit(0)

    user_src, answer_src, precode = data["user"], data["answer"], data["precode"]

    u_mod, u_out, u_err, u_tb, calls = _run_module("user", USER_FILE, user_src, precode, record=True)
    if u_err is not None:
        finish(False, _format_error(u_err), u_out, u_mod.__dict__.get("_stderr", "") + (u_tb or ""))
    u_stderr = u_mod.__dict__.get("_stderr", "")

    a_mod, _, a_err, a_tb, _ = _run_module("answer", ANSWER_FILE, answer_src, precode)
    if a_err is not None:
        finish(False, f"Эталонное решение упало: {_format_error(a_err)}", u_out, a_tb or "")

    if not (data["test"] or "").strip():
        finish(True, "", u_out, u_stderr)

    checker = Checker(u_mod, a_mod, user_src, answer_src, ast.parse(user_src), calls, precode)
    env = {
        "__name__": "__test__",
        "__builtins__": __builtins__,
        "_u": u_mod,
        "_a": a_mod,
        "_test": checker,
        "ast": ast,
    }
    sink = io.StringIO()
    from contextlib import redirect_stderr, redirect_stdout

    try:
        code = compile(data["test"], "<test>", "exec")
        with redirect_stdout(sink), redirect_stderr(sink):
            exec(code, env)
    except AssertionError as exc:
        msg = str(exc) or "Проверка не пройдена."
        finish(False, msg, u_out, u_stderr)
    except BaseException as exc:  # noqa: BLE001
        finish(False, _format_error(exc), u_out, u_stderr + traceback.format_exc())
    finish(True, "", u_out, u_stderr)


if __name__ == "__main__" and sys.argv[1:] == ["--worker"]:
    _worker()
