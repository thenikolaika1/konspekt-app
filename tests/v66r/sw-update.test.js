// v66: обновление PWA под настоящим service worker (Chromium). node tests/v66r/sw-update.test.js OLD_DIR NEW_DIR OLD_V NEW_V MODE
// MODE=immediate — сразу после автообновления приложение закрывают и открывают уже без сети;
// MODE=relaunch — после обновления ещё один запуск при сети, потом без сети.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [OLD, NEW, OV, NV, MODE] = process.argv.slice(2);
const t0 = Date.now(); const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
setTimeout(() => { log("TIMEOUT"); process.exit(3); }, 120000);
let ROOT = OLD;
const STUB = fs.readFileSync(path.join(NEW, "tests/v61/stub-cloud.js"), "utf8");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp" };
const PORT = 8300 + Math.floor(Math.random() * 500);
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end();
  r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  if (p.endsWith("/js/cloud.js")) return r.end(STUB);
  fs.createReadStream(f).pipe(r);
});
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 300))); };
(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ru-RU" });
  ctx.setDefaultTimeout(20000);
  await ctx.addInitScript(() => (window.__T = { kind: "participant", id: "KN-AAAAAA", uid: "2f1c9d1e-6b1a-4c77-9a51-3e0b8f6a1c01",
    v2: { status: "trial", kind: "trial", starts_at: "2026-11-10T00:00:00Z", ends_at: "2026-11-17T00:00:00Z", server_now: "2026-11-11T12:00:00Z", ai_quota: 3, ai_used: 0, ai_reserved: 0, ai_remaining: 3, ai_available: 3 }, plans: [] }));
  let page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const info = async (pg) => {
    const ok = await pg.evaluate(() => typeof caches !== "undefined" && !!document.querySelector("#app")).catch(() => false);
    if (!ok) return { opened: false, url: pg.url() };
    return pg.evaluate(async () => {
      const urls = [...document.scripts].map((s) => s.src).concat([...document.querySelectorAll("link[rel=stylesheet]")].map((l) => l.href)).filter((u) => u.startsWith(location.origin)).map((u) => new URL(u).pathname + new URL(u).search);
      const keys = await caches.keys(); const cached = [];
      for (const k of keys) for (const r of await (await caches.open(k)).keys()) cached.push(k + " " + new URL(r.url).pathname + new URL(r.url).search);
      return { opened: document.querySelector("#app").children.length > 0, urls, keys, cached, prot: !!window.K?.protect };
    });
  };
  const only = (a, v) => a.urls && a.urls.length > 10 && a.urls.every((u) => u.endsWith("v=" + v));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.reload(); await page.waitForTimeout(1500);
  let a = await info(page);
  check(`1. старая версия ${OV} под service worker`, only(a, OV) && a.keys.join() === "konspekt-v" + OV, a);
  ROOT = NEW; log("на сервере новая версия " + NV);
  const nav = page.waitForEvent("framenavigated", { timeout: 20000 }).catch(() => null);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  check("2. открытое приложение само перезагрузилось", !!(await nav));
  await page.waitForTimeout(1000);
  // ждём, пока новый service worker активируется и удалит кэш прежней версии (без фиксированной паузы: на медленной машине дольше)
  let waited = 0;
  for (; waited < 15000; waited += 250) {
    if ((await page.evaluate(() => caches.keys())).join() === "konspekt-v" + NV) break;
    await page.waitForTimeout(250);
  }
  log("старый кэш удалён через " + (waited / 1000).toFixed(2) + " с после перезагрузки (+1 с)");
  a = await info(page);
  check(`3. после обновления все файлы v=${NV}, ни одного v=${OV}`, only(a, NV), a.urls);
  check(`4. кэш только konspekt-v${NV}, без файлов v=${OV}`, a.keys.join() === "konspekt-v" + NV && !a.cached.some((c) => c.includes("v=" + OV)), a.keys);
  const start = a.cached.filter((c) => / \/(index\.html)?$/.test(c));
  log("стартовая страница в кэше после обновления: " + JSON.stringify(start));
  if (MODE === "relaunch") { await page.close(); page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(1500); log("запуск при сети выполнен"); }
  await page.close();
  await ctx.setOffline(true);
  page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`).catch((e) => log("offline goto: " + String(e).split("\n")[0]));
  await page.waitForTimeout(1500);
  a = await info(page);
  check(`5. [${MODE}] запуск без сети: приложение открылось, все файлы v=${NV}`, a.opened && only(a, NV), a.opened ? a.urls : a);
  check("6. нет ошибок JS", errors.length === 0, errors);
  await browser.close(); srv.close();
  log(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { log("ERROR " + String(e).split("\n")[0]); process.exit(2); });
