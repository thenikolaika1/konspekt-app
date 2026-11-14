// v66: крайние случаи установки service worker (Chromium). node tests/v66r/sw-edge.test.js OLD_DIR NEW_DIR
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [OLD, NEW] = process.argv.slice(2);
setTimeout(() => { console.log("TIMEOUT"); process.exit(3); }, 180000);
const STUB = fs.readFileSync(path.join(NEW, "tests/v61/stub-cloud.js"), "utf8");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp" };
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 300))); };
function server(port, pick) {
  return new Promise((res) => {
    const s = http.createServer((q, r) => {
      let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const root = pick(p, q);
      if (root === 500) return r.writeHead(500).end("err");
      const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end();
      r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
      if (p.endsWith("/js/cloud.js")) return r.end(STUB);
      fs.createReadStream(f).pipe(r);
    });
    s.listen(port, "127.0.0.1", () => res(s));
  });
}
(async () => {
  const browser = await chromium.launch();
  async function scenario(name, pick, verify) {
    const port = 8900 + Math.floor(Math.random() * 90);
    const srv = await server(port, pick);
    const ctx = await browser.newContext({ locale: "ru-RU" });
    ctx.setDefaultTimeout(20000);
    await ctx.addInitScript(() => (window.__T = { kind: "participant", id: "KN-AAAAAA", uid: "u-1", v2: { status: "trial", kind: "trial", starts_at: "2026-11-10T00:00:00Z", ends_at: "2026-11-17T00:00:00Z", server_now: "2026-11-11T12:00:00Z", ai_quota: 3, ai_used: 0, ai_reserved: 0, ai_remaining: 3, ai_available: 3 }, plans: [] }));
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    const st = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      await new Promise((r) => setTimeout(r, 1500));
      const keys = await caches.keys(); const cached = [];
      for (const k of keys) for (const q of await (await caches.open(k)).keys()) cached.push(k + " " + new URL(q.url).pathname + new URL(q.url).search);
      return { active: reg.active?.state, keys, cached, app: document.querySelector("#app")?.children.length > 0 };
    });
    await verify(st, errors);
    await ctx.close(); srv.close();
  }
  // E1: первый вход, сайт целиком v68 — SW активен, в кэше стартовая страница и все 16 файлов ?v=66, ничего другого версий
  await scenario("E1", () => NEW, (st, errors) => {
    const v = st.cached.filter((c) => /\?v=68$/.test(c));
    check("E1. первый вход (без старой версии): SW активен, приложение работает, в кэше стартовая страница и файлы ?v=66, нет файлов других версий",
      st.active === "activated" && st.app && st.cached.includes("konspekt-v68 /") && v.length >= 16 && !st.cached.some((c) => /\?v=(?!68$)/.test(c)) && errors.length === 0, st);
  });
  // E2: сайт обновился не целиком — service-worker.js уже v68, а index.html ещё v67: чужая страница в кэш v68 не попадает
  await scenario("E2", (p) => (p.endsWith("/index.html") ? OLD : NEW), (st, errors) => {
    check("E2. service worker v68 + index.html ещё v67: установка прошла, стартовая страница v67 в кэш v68 предварительно НЕ положена, файлов ?v=66 заранее нет",
      st.active === "activated" && st.app && !st.cached.some((c) => /\?v=68$/.test(c)) && errors.length === 0, st);
  });
  // E3: при установке сервер отвечает ошибкой на стартовую страницу (запрос из service worker) — установка не ломается
  await scenario("E3", (p, q) => (p.endsWith("/index.html") && q.headers["sec-fetch-dest"] === "empty" ? 500 : NEW), (st, errors) => {
    check("E3. ошибка 500 при предварительной загрузке: service worker всё равно установлен и активен, приложение работает",
      st.active === "activated" && st.app && errors.length === 0, st);
  });
  // E4: при установке сервер не отвечает на файлы (500 на всё, кроме навигации и SW) — установка не ломается
  await scenario("E4", (p, q) => (q.headers["sec-fetch-dest"] === "empty" && /\.(js|css)$/.test(p) && !p.endsWith("service-worker.js") ? 500 : NEW), (st, errors) => {
    check("E4. ошибки 500 на файлы при предварительной загрузке: service worker активен, приложение работает", st.active === "activated" && st.app && errors.length === 0, { active: st.active, app: st.app, errors });
  });
  await browser.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (Chromium)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR " + String(e).split("\n")[0]); process.exit(2); });
