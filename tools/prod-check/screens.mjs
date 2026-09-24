// Скриншоты production и проверка версий файлов.
import pw from "playwright";
import fs from "fs";
const PROD = "https://thenikolaika1.github.io/konspekt-app/";
const OUT = "prod-check-results";
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); log.push(s); };
const checks = { "index.html": ["v=26"], "service-worker.js": ["konspekt-v26"], "app.js?v=26": ["THUMB_POOL", "touchedSinceVisible", "DECO.head", 'icon("sparkle")', "const ONCE"],
  "styles.css?v=26": ["FINAL POLISH", "deco-head", "body:has(.overlay)"], "js/classic-renderer.js?v=26": ["cn-card"] };
for (const [f, ms] of Object.entries(checks)) {
  const r = await fetch(PROD + f, { cache: "no-store" }); const t = await r.text();
  say(f, r.status, "last-modified=" + r.headers.get("last-modified"), ms.map((m) => m + ":" + (t.includes(m) ? "YES" : "no")).join(" "));
}
const browser = await pw.webkit.launch();
const shot = async (name, fn, W = 390, H = 844) => {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.on("pageerror", (e) => say(name, "JS ERROR", e.message)); p.on("response", (r) => r.status() >= 400 && say(name, "HTTP", r.status(), r.url()));
  await p.goto(PROD); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(1200);
  await fn(p); await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  say(name, "overflowX", await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), "caches", await p.evaluate(() => caches.keys()));
  await ctx.close();
};
await shot("home", async () => {});
await shot("camera", async (p) => { await p.tap(".hero [data-go=camera]"); await p.setInputFiles("#cameraInput", ["03-camera.png", "13-note.png"]); await p.waitForFunction(() => document.querySelectorAll(".page-thumb").length >= 2); });
await shot("camera-empty", async (p) => { await p.tap(".hero [data-go=camera]"); });
await shot("processing", async (p) => { await p.tap(".hero [data-go=camera]"); await p.setInputFiles("#cameraInput", ["03-camera.png"]); await p.waitForSelector(".page-thumb"); await p.tap("[data-process]"); await p.waitForTimeout(700); });
await shot("all-notes", async (p) => { await p.tap("[data-go=all-notes]"); });
await shot("all-bookmarks", async (p) => { await p.tap("[data-go=bookmarks]"); });
await shot("new-bookmark", async (p) => { await p.tap(".bookmarks [data-go=new-bookmark]"); });
await shot("sheet", async (p) => { await p.tap(".note-card [data-note-menu]"); });
await shot("home-430", async () => {}, 430, 932);
await browser.close();
fs.writeFileSync(`${OUT}/report.txt`, log.join("\n") + "\n");
