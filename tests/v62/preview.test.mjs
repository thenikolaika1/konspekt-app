#!/usr/bin/env node
// v62: тестовый сервер tools/premium-preview.mjs — изоляция от production и границы (без браузера).
// Запускает сервер на свободном порту только на 127.0.0.1 и проверяет ответы. Запуск: node tests/v62/preview.test.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORT = 18765 + Math.floor(Math.random() * 1000);
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || extra === undefined ? "" : " → " + JSON.stringify(extra).slice(0, 300)));
};
const srv = spawn(process.execPath, [path.join(ROOT, "tools/premium-preview.mjs"), "--port", String(PORT)], { cwd: ROOT });
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
const B = "http://127.0.0.1:" + PORT;
const get = (p, opt) => fetch(B + p, { redirect: "manual", ...opt });
try {
  for (let i = 0; i < 50 && !log.includes("Открыть в Chrome"); i++) await new Promise((r) => setTimeout(r, 100));
  check("P1. сервер запущен; по умолчанию только этот компьютер (127.0.0.1), адрес для Chrome — localhost/konspekt-app/__preview/",
    log.includes("http://localhost:" + PORT + "/konspekt-app/__preview/") && log.includes("только на этом компьютере") && !log.includes("На iPhone"), log);
  const root = await get("/");
  check("P2. корень → выбор сценария", root.status === 302 && root.headers.get("location") === "/konspekt-app/__preview/", [root.status, root.headers.get("location")]);
  const page = await get("/konspekt-app/");
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") || "";
  check("P3. CSP: запросы только к этому серверу (connect-src 'self'), без внешних скриптов", /connect-src 'self'(;|$)/.test(csp) && /default-src 'self'/.test(csp) && !/supabase|https?:/.test(csp), csp);
  check("P3. сценарий подключается раньше всех скриптов приложения", html.indexOf("__preview/boot.js") > 0 && html.indexOf("__preview/boot.js") < html.indexOf("js/vendor/supabase.js"));
  const cloud = await (await get("/konspekt-app/js/cloud.js")).text();
  check("P4. js/cloud.js — имитация из тестов, не настоящий клиент Supabase",
    cloud === readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8") && !/createClient|supabase\.co|\/rest\/v1/.test(cloud));
  const cfg = await (await get("/konspekt-app/js/config.js")).text();
  check("P5. js/config.js: адреса и ключа Supabase нет, аналитика выключена",
    /supabaseUrl: ""/.test(cfg) && /supabaseKey: ""/.test(cfg) && /analytics: false/.test(cfg) && !/supabase\.co|sb_publishable_/.test(cfg), cfg.slice(0, 300));
  const boot = await (await get("/konspekt-app/__preview/boot.js")).text();
  check("P6. сценарии: 9 штук, ID KN-TEST42, тариф с ценой (интерфейс должен её скрыть), без сетевых вызовов",
    (boot.match(/^\s{4}\w+:\s+\["/gm) || []).length === 9 && boot.includes("KN-TEST42") && boot.includes('"299 ₽"') && !/fetch\(|XMLHttpRequest|supabase\.co/.test(boot));
  const picker = await get("/konspekt-app/__preview/");
  check("P7. страница выбора сценария открывается", picker.status === 200 && (await picker.text()).includes("тестовый режим"));
  const blocked = ["/konspekt-app/supabase/release/rollback-v62.sql", "/konspekt-app/supabase/migrations/20261028120000_v62_paid_library.sql",
    "/konspekt-app/tests/v61/stub-cloud.js", "/konspekt-app/tools/premium-preview.mjs", "/konspekt-app/.git/config", "/konspekt-app/.gitignore",
    "/konspekt-app/js/../supabase/release/rollback-v62.sql", "/konspekt-app/js/..%2f..%2f.git%2fconfig", "/app.js", "/konspekt-app/js/owner.js"];
  const codes = [];
  for (const p of blocked) codes.push(p + "=" + (await get(p)).status);
  check("P8. закрыто: supabase/, tests/, tools/, .git, выход из папки, файлы вне /konspekt-app/; js/owner.js не нужен ученику, но отдаётся только как файл сайта",
    codes.filter((c) => !c.endsWith("=404") && !c.startsWith("/konspekt-app/js/owner.js")).length === 0, codes);
  const post = await get("/konspekt-app/", { method: "POST", body: "x" });
  check("P9. только чтение: POST → 405", post.status === 405, post.status);
  const app = await get("/konspekt-app/app.js");
  check("P10. файлы сайта отдаются (app.js, манифест, иконка) без кэша", app.status === 200 && app.headers.get("cache-control") === "no-store"
    && (await get("/konspekt-app/manifest.json")).status === 200 && (await get("/konspekt-app/icons/icon-192.png")).status === 200);
} finally {
  srv.kill();
}
console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
