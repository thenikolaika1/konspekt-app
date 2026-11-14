// Релиз v66: состав сборки без браузера. Негативный контроль: ROOT=<папка эксперимента> node tests/v66r/release-guard.test.mjs
// должен провалиться (там analyze-pages-exp, 6 фото, метка эксперимента).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const ROOT = process.env.ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 300))); };
const tracked = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const site = tracked.filter((f) => !/^(supabase|tests|tools|docs?)\//.test(f) && /\.(js|html|css|json|webmanifest)$/.test(f));
const siteText = site.map((f) => [f, read(f)]);

const idx = read("index.html"), sw = read("service-worker.js"), app = read("app.js"), cfg = read("js/config.js");
const vers = [...idx.matchAll(/\?v=([^"']+)/g)].map((m) => m[1]);
check("G1. index.html: у всех файлов один номер сборки ?v=67 (только цифры — по нему приложение замечает обновление)", vers.length >= 15 && vers.every((v) => v === "67"), [...new Set(vers)]);
check("G2. service worker: VERSION konspekt-v67 (старые кэши удаляются при активации)", /const VERSION = "konspekt-v67";/.test(sw) && /caches\.delete/.test(sw));
check("G3. панель владельца грузится той же версии (owner.css/owner.js ?v=67)", /owner\.css\?v=67/.test(app) && /owner\.js\?v=67/.test(app));
check("G4. js/protect.js подключён до app.js", idx.indexOf("js/protect.js?v=67") > 0 && idx.indexOf("js/protect.js") < idx.indexOf("app.js?v="));
check("G5. сайт не обращается к экспериментальной функции analyze-pages-exp и не содержит метки эксперимента",
  !siteText.some(([, s]) => /analyze-pages-exp|kn-exp|эксперимент v34/.test(s)) && /analyzeFunction: "analyze-pages"/.test(cfg), siteText.filter(([, s]) => /analyze-pages-exp|kn-exp/.test(s)).map(([f]) => f));
check("G6. клиент: MAX_PAGES = 4", /const MAX_PAGES = 4;/.test(app) && !/const MAX_PAGES = [5-9]/.test(app));
const fn = read("supabase/functions/analyze-pages/index.ts");
check("G7. сервер analyze-pages: MAX_PAGES = 4 и пробные 5–8 фото владельца выключены", /const MAX_PAGES = 4;/.test(fn) && /const OWNER_PAGE_TEST = false;/.test(fn));
check("G8. экспериментальной функции в релизе нет (supabase/functions/analyze-pages-exp)", !fs.existsSync(path.join(ROOT, "supabase/functions/analyze-pages-exp")));
check("G9. миграция ограничения библиотеки — только в supabase/prepared, не в supabase/migrations",
  !tracked.some((f) => f.startsWith("supabase/migrations/") && /library_rate_limit/.test(f)) && tracked.includes("supabase/prepared/20261110120000_v34_4_library_rate_limit.sql"));
const secretRe = /sb_secret_[A-Za-z0-9_-]{10,}|service_role["']?\s*[:=]\s*["']ey|-----BEGIN [A-Z ]*PRIVATE KEY|GIGACHAT_AUTH_KEY\s*=\s*["'][^"']{8,}|eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;
const leaks = tracked.filter((f) => !/\.(png|jpe?g|webp|ico|gif|woff2?)$/.test(f) && !f.startsWith("tests/")).filter((f) => secretRe.test(read(f)));
check("G10. секретов в файлах нет (service_role, sb_secret, приватные ключи, JWT, ключ GigaChat)", leaks.length === 0, leaks);
check("G11. в сайте только публикуемый ключ Supabase (sb_publishable_)", /supabaseKey: "sb_publishable_/.test(cfg));
check("G12. нет отладочных экранов и вывода в консоль на сайте (debugger, console.log в app.js)", !/\bdebugger\b/.test(app) && !/console\.log\(/.test(app));
const prot = read("js/protect.js");
check("G13. водяной знак: один элемент, код KN- из SHA-256, без email/телефона", /"KN-" \+ sha256Hex\("konspekt-wm:" \+ uid\)/.test(prot) && (prot.match(/class="kn-wm"/g) || []).length === 1 && !/email|phone|телефон/i.test(prot.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
check("G14. тёмной темы не добавлено (нет prefers-color-scheme: dark в стилях сайта)", !siteText.some(([f, s]) => f.endsWith(".css") && /prefers-color-scheme:\s*dark/.test(s)));
console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
