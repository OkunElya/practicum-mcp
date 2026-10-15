"""Run inside a Django environment: GET a page or check a scenario's pages.

    python -I django_probe.py PROJECT CHECKS.json get /about/
    python -I django_probe.py PROJECT CHECKS.json check

Prints one JSON object. Used by tune.py in place of the platform's
preview server and checker.
"""

import json
import os
import sys
import traceback

# The real checker's wording (lesson 4, October 2026).
BINDING = (
    "Убедитесь, что в файле `{file}` url `{path}` привязан ко view-функции `{name}` из модуля `{module}`. "
    "Помните, что при подключении файла urls.py функцией include ко всем url-ам этого файла добавляется префикс. "
    "Префикс в данном случае совпадает с именем приложения, для которого подключаются url-ы."
)


def tail(tb: str, n: int = 12) -> str:
    return "\n".join(tb.strip().splitlines()[-n:])


def main() -> None:
    project, checks_file, mode = sys.argv[1:4]
    arg = sys.argv[4] if len(sys.argv) > 4 else ""
    checks = json.load(open(checks_file))
    sys.path.insert(0, project)
    os.chdir(project)
    os.environ["DJANGO_SETTINGS_MODULE"] = checks["settings"]
    try:
        import django

        django.setup()
        from django.test import Client
        from django.urls import resolve
    except Exception:
        print(json.dumps({"setup_error": tail(traceback.format_exc())}))
        return

    client = Client(raise_request_exception=True)

    def get(path: str) -> dict:
        try:
            r = client.get(path)
        except Exception:
            return {"status": 500, "body": tail(traceback.format_exc())}
        return {"status": r.status_code, "body": r.content.decode(errors="replace")}

    if mode == "get":
        print(json.dumps(get(arg)))
        return

    for page in checks["pages"]:
        path, view = page["path"], page.get("view")
        if view:
            try:
                m = resolve(path)
                actual = f"{m.func.__module__}.{m.func.__name__}"
            except Exception:
                # Resolver404 or a URLconf that doesn't import: the platform's checker
                # reports both as a wrong binding (seen on the real task).
                actual = None
            if actual != view:
                module, name = view.rsplit(".", 1)
                print(json.dumps({"solved": False, "message": BINDING.format(file=page["urls_file"], path=path, name=name, module=module)}))
                return
        r = get(path)
        if r["status"] != 200:
            last = r["body"].strip().splitlines()[-1:] if r["status"] >= 500 else []
            print(json.dumps({"solved": False, "message": f"При запросе к `{path}` сервер вернул код {r['status']}, а должен 200. {' '.join(last)}".strip()}))
            return
        if page["text"] not in r["body"]:
            print(json.dumps({"solved": False, "message": f"Убедитесь, что при запросе к `{path}` возвращается текст «{page['text']}»."}))
            return
    print(json.dumps({"solved": True, "message": ""}))


if __name__ == "__main__":
    main()
