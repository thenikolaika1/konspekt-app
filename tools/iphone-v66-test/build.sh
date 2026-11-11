#!/bin/bash
# Тестовая сборка Konspekt для iPhone: BASE=<коммит> VER=<65|66> OUT=<папка> bash build.sh
# Берёт файлы сайта из коммита без изменений, кроме тестовой обвязки (каждая замена проверяется):
#  js/cloud.js → test-cloud.js (нет сети, нет Supabase); config.js — адрес Supabase недействителен, аналитика выкл.;
#  адрес и ключ Supabase заменены недействительными (в сборке нет ни адреса, ни ключа production); service worker — имя кэша konspekt-test-vNN,
#  удаляет только кэши konspekt-test-*, стартовая страница — ./index.html (githack не отдаёт адрес папки);
#  manifest.json — относительные адреса; + start.html, README-TEST.md.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
: "${BASE:?}" "${VER:?}" "${OUT:?}" "${REPO:?}"
mkdir -p "$OUT"
git -C "$REPO" archive "$BASE" app.js assets classic-reference-v38.css icons index.html js manifest.json owner.css service-worker.js styles.css | tar -x -C "$OUT"
cp "$HERE/test-cloud.js" "$OUT/js/cloud.js"
cp "$HERE/start.html" "$OUT/start.html"
python3 - "$OUT" "$VER" "$BASE" <<'PY'
import sys, pathlib, re
out, ver, base = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
def sub(f, old, new, n=1):
    p = out / f; s = p.read_text(encoding="utf-8")
    assert s.count(old) == n, (f, old, s.count(old)); p.write_text(s.replace(old, new), encoding="utf-8")
sub("js/config.js", 'supabaseUrl: "https://ohdeykbkgimvwstkwuuf.supabase.co"', 'supabaseUrl: "https://supabase.invalid"')
sub("js/config.js", "analytics: true", "analytics: false")
sub("index.html", '<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">')
sub("js/config.js", 'supabaseKey: "sb_publishable_7t0cfHxy6z5QU4N1qW-4Og_6qcPhaQ_"', 'supabaseKey: "test-build-no-key"')
sub("service-worker.js", f'const VERSION = "konspekt-v{ver}";', f'const VERSION = "konspekt-test-v{ver}"; // ТЕСТОВАЯ СБОРКА')
sub("service-worker.js", "keys.filter((k) => k !== VERSION)", 'keys.filter((k) => k.startsWith("konspekt-test-") && k !== VERSION)')
sw = (out / "service-worker.js").read_text()
if ver == "66":
    sub("service-worker.js", 'VERSION.replace("konspekt-v", "")', 'VERSION.replace("konspekt-test-v", "")')
    sub("service-worker.js", '"./"', '"./index.html"', 3)
else:
    sub("service-worker.js", '"./"', '"./index.html"', 1)
sub("manifest.json", '"id": "/konspekt-app/", "start_url": "/konspekt-app/", "scope": "/konspekt-app/"', '"id": "./index.html", "start_url": "./index.html", "scope": "./"')
(out / "README-TEST.md").write_text(f"""# Konspekt v{ver} — ТЕСТОВАЯ сборка для iPhone

Не рабочее приложение. Собрано из коммита `{base}` скриптом build.sh: к серверу не подключено (js/cloud.js — тестовая
заглушка без сети), адрес и ключ production Supabase в сборке отсутствуют, Service Worker использует только кэш `konspekt-test-v{ver}`
и удаляет только кэши `konspekt-test-*`. Начать: start.html.
""", encoding="utf-8")
PY
