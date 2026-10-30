#!/usr/bin/env node
// Konspekt v62 — ТЕСТОВЫЙ просмотр Premium UI на iPhone по локальной сети. БЕЗ production и вообще без Supabase.
//
// Отдаёт сайт из этой папки репозитория (ветка feature/v62) по адресу http://<компьютер>:8765/konspekt-app/ — тот же
// путь, что на GitHub Pages (так «На экран Домой» работает как у учеников). Вместо js/cloud.js отдаётся имитация
// сервера из тестов (tests/v61/stub-cloud.js): статусы доступа, тарифы и тексты библиотеки — вымышленные, по выбранному
// сценарию; в js/config.js адрес Supabase пустой и аналитика выключена — запросов к production нет и быть не может.
// Только чтение (GET/HEAD), только файлы сайта (не supabase/, tests/, tools/, .git). Ничего не публикует.
//
// Запуск (в папке репозитория):  node tools/premium-preview.mjs          — для iPhone в той же Wi-Fi-сети
//                                 node tools/premium-preview.mjs --local  — только на этом компьютере
// Остановить: Ctrl+C. Windows спросит про брандмауэр — разрешить только для «Частных сетей».
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.includes("--port") ? args[args.indexOf("--port") + 1] : "";
const PORT = /^\d{2,5}$/.test(portArg || "") ? Number(portArg) : 8765;
const HOST = args.includes("--local") ? "127.0.0.1" : "0.0.0.0";
const BASE = "/konspekt-app/";

// только файлы сайта
const ALLOW_FILES = new Set(["index.html", "app.js", "styles.css", "classic-reference-v38.css", "manifest.json", "service-worker.js"]);
const ALLOW_DIRS = ["js/", "icons/", "assets/"];
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

const STUB = readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
// настройки: без адреса и ключа Supabase, без аналитики (даже если что-то обойдёт имитацию — сети не будет)
const CONFIG = readFileSync(path.join(ROOT, "js/config.js"), "utf8")
  .replace(/supabaseUrl:\s*"[^"]*"/, 'supabaseUrl: ""')
  .replace(/supabaseKey:\s*"[^"]*"/, 'supabaseKey: ""')
  .replace(/analytics:\s*true/, "analytics: false");
if (/supabase\.co|sb_publishable_/.test(CONFIG) || !/analytics: false/.test(CONFIG)) {
  console.error("СТОП: не удалось отключить Supabase в настройках тестового режима (js/config.js изменился?)");
  process.exit(1);
}

// сценарии: что «отвечает сервер». Сроки — от текущего времени. Тариф — как в production ДО шага 2б (с ценой
// «299 ₽» в ответе get_plans): интерфейс должен её скрыть
const BOOT = `(() => {
  const KEY = "konspekt-preview-scenario";
  const DAY = 86400000, now = Date.now();
  const at = (d) => new Date(now + d * DAY).toISOString(), NOW = new Date(now).toISOString();
  const acc = (o) => Object.assign({ server_now: NOW, ai_used: 0, ai_reserved: 0 }, o);
  const PLANS = [{ code: "premium", title: "Premium", days: 30, ai_quota: 10, price_label: "299 ₽",
                   description: "История и физика целиком, 10 конспектов по фото за 30 дней" }];
  const NOTE = { id: "11111111-1111-4111-8111-111111111111", status: "ready", stage: "done", error_code: null,
                 title: "Мой конспект (тестовый)", subject: "biology", preview: "Тест", content: null, schema_version: 2,
                 created_at: at(-3), updated_at: at(-3) };
  const S = {
    trial:          ["Пробный период (осталось 7 дней)", acc({ status: "trial", kind: "trial", plan: null, starts_at: at(0), ends_at: at(7), ai_quota: 1, ai_remaining: 1, ai_available: 1 })],
    trialExpired:   ["Пробный период закончился", acc({ status: "expired", kind: "trial", plan: null, starts_at: at(-8), ends_at: at(-1), revoked: false, ai_quota: 0, ai_remaining: 0, ai_available: 0 })],
    premium:        ["Premium действует (27 дней, ИИ 6 из 10)", acc({ status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-3), ends_at: at(27), paid_until: at(27), ai_quota: 10, ai_used: 4, ai_remaining: 6, ai_available: 6 })],
    premiumEnding:  ["Premium заканчивается через 2 дня", acc({ status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-28), ends_at: at(2), paid_until: at(2), ai_quota: 10, ai_used: 9, ai_remaining: 1, ai_available: 1 })],
    premiumNoAi:    ["Premium: ИИ-конспекты закончились", acc({ status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-10), ends_at: at(20), paid_until: at(20), ai_quota: 10, ai_used: 10, ai_remaining: 0, ai_available: 0 })],
    premiumExpired: ["Premium закончился", acc({ status: "expired", kind: "paid", plan: "premium", starts_at: at(-31), ends_at: at(-1), revoked: false, ai_quota: 0, ai_remaining: 0, ai_available: 0 })],
    gift:           ["🎁 Подарок действует (ИИ 2 из 3)", acc({ status: "paid", kind: "paid", plan: "gift", plan_title: "Подарок", starts_at: at(-1), ends_at: at(29), paid_until: at(29), ai_quota: 3, ai_used: 1, ai_remaining: 2, ai_available: 2 })],
    giftExpired:    ["Подарок закончился", acc({ status: "expired", kind: "paid", plan: "gift", starts_at: at(-8), ends_at: at(-1), revoked: false, ai_quota: 0, ai_remaining: 0, ai_available: 0 })],
    plansError:     ["Premium закончился + условия Premium не загрузились", acc({ status: "expired", kind: "paid", plan: "premium", starts_at: at(-31), ends_at: at(-1), revoked: false, ai_quota: 0, ai_remaining: 0, ai_available: 0 })],
  };
  window.__PREVIEW = { KEY, list: Object.keys(S).map((k) => [k, S[k][0]]) };
  let key = null;
  try {
    const q = new URLSearchParams(location.search).get("s");
    if (q && S[q]) {
      // новый сценарий — с чистого листа: данные приложения на этом устройстве (тестовом адресе) стираются
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem(KEY, q); localStorage.setItem("k-first", "1");
      history.replaceState(null, "", location.pathname);
    }
    key = localStorage.getItem(KEY);
  } catch (e) {}
  if (!S[key]) key = "premiumExpired";
  const v2 = S[key][1];
  window.__T = { kind: "participant", id: "KN-TEST42", uid: "preview-user", v2, plans: PLANS, notes: [NOTE], plansError: key === "plansError",
                 access: { plan: v2.kind, quota: v2.ai_quota, used: v2.ai_used, remaining: v2.ai_remaining } };
  // метка тестового режима: нажатие — выбор сценария
  addEventListener("DOMContentLoaded", () => {
    const a = document.createElement("a");
    a.href = "./__preview/"; a.textContent = "ТЕСТ · " + S[key][0];
    a.setAttribute("style", "position:fixed;z-index:99999;right:6px;top:calc(4px + env(safe-area-inset-top));" +
      "max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 9px;border-radius:999px;background:#ffe9a8;" +
      "color:#5c4400;font:600 11px/16px -apple-system,system-ui,sans-serif;text-decoration:none;opacity:.92;pointer-events:auto");
    document.body.appendChild(a);
  });
})();
`;

const PICKER = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Konspekt v62 — тестовый режим</title>
<style>body{margin:0;padding:24px 16px calc(24px + env(safe-area-inset-bottom));font:16px/1.45 -apple-system,system-ui,sans-serif;background:#f7fbff;color:#13204a}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 14px;color:#4c5a7a;font-size:14px}.warn{background:#fff4d6;color:#5c4400;padding:10px 12px;border-radius:12px}
a.s{display:block;margin:0 0 10px;padding:14px 16px;border-radius:14px;background:#fff;border:1px solid #dde6f3;color:#13204a;text-decoration:none;font-weight:650}
a.s small{display:block;font-weight:400;color:#6a7894;font-size:12.5px}</style></head><body>
<h1>Konspekt v62 · тестовый режим</h1>
<p class="warn">Не настоящие данные и не production: «сервер» здесь — имитация из тестов, сеть к Supabase отключена.
ID ученика: <b>KN-TEST42</b>. Выбор сценария стирает данные приложения только на этом тестовом адресе.</p>
<div id="list"></div>
<script src="../__preview/boot.js"></script>
<script>document.getElementById("list").innerHTML = window.__PREVIEW.list.map(([k, t]) =>
  '<a class="s" href="../?s=' + k + '">' + t + '<small>' + k + '</small></a>').join("");</script>
</body></html>`;

function send(res, status, type, body, head) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...head });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

const server = http.createServer((req, res) => {
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "405");
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "text/plain; charset=utf-8", "400"); }
  if (p === "/" || p === "/konspekt-app") return send(res, 302, "text/plain; charset=utf-8", "", { Location: BASE + "__preview/" });
  if (!p.startsWith(BASE)) return send(res, 404, "text/plain; charset=utf-8", "404");
  let rel = p.slice(BASE.length);
  if (rel === "") rel = "index.html";
  if (rel === "__preview/" || rel === "__preview") return send(res, 200, "text/html; charset=utf-8", PICKER);
  if (rel === "__preview/boot.js") return send(res, 200, TYPES[".js"], BOOT);
  if (rel === "js/cloud.js") return send(res, 200, TYPES[".js"], STUB);
  if (rel === "js/config.js") return send(res, 200, TYPES[".js"], CONFIG);
  if (rel.includes("..") || rel.includes("\\") || !(ALLOW_FILES.has(rel) || ALLOW_DIRS.some((d) => rel.startsWith(d)))) {
    return send(res, 404, "text/plain; charset=utf-8", "404");
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "text/plain; charset=utf-8", "404");
  let body = readFileSync(file);
  if (rel === "index.html") {
    // сценарий загружается раньше всех скриптов приложения (имитация сервера читает window.__T при загрузке)
    body = body.toString("utf8").replace('<script src="./js/vendor/supabase.js', '<script src="./__preview/boot.js"></script>\n<script src="./js/vendor/supabase.js');
    if (!body.includes("__preview/boot.js")) return send(res, 500, "text/plain; charset=utf-8", "index.html изменился — тестовый режим не подключён");
  }
  send(res, 200, TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", body);
});

server.on("error", (e) => {
  console.error("СТОП: " + (e.code === "EADDRINUSE" ? "порт " + PORT + " занят — закройте другое окно сервера или запустите с --port 8766" : e.message));
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
  console.log("\nKonspekt v62 — ТЕСТОВЫЙ режим (имитация сервера, без production). Остановить: Ctrl+C\n");
  console.log("  На этом компьютере:  http://localhost:" + PORT + BASE + "__preview/");
  if (HOST === "0.0.0.0") {
    if (lan.length) lan.forEach((ip) => console.log("  На iPhone (та же Wi-Fi): http://" + ip + ":" + PORT + BASE + "__preview/"));
    else console.log("  Адрес в локальной сети не найден — подключите компьютер к Wi-Fi/сети");
  } else console.log("  (--local: только на этом компьютере)");
  console.log("");
});
