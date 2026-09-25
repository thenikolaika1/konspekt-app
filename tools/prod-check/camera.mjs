// Production: версии файлов, камера в WebKit, содержимое страницы в первом кадре.
import pw from "playwright";
import fs from "fs";
const PROD = "https://thenikolaika1.github.io/konspekt-app/";
const OUT = "prod-check-results";
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); log.push(s); };
for (const [f, ms] of Object.entries({ "index.html": ["v=27", "demo-page.js"], "service-worker.js": ["konspekt-v27"], "js/demo-page.js?v=27": ["Первые годы войны", "PAGES"], "app.js?v=27": ["demoPage.render"], "styles.css?v=27": [".demo-page", "fake-page:after{content:none"] })) {
  const r = await fetch(PROD + f, { cache: "no-store" }); const t = await r.text();
  say(f, r.status, ms.map((m) => m + ":" + (t.includes(m) ? "YES" : "no")).join(" "));
}
for (const [engine, W, H, dpr] of [["webkit", 390, 844, 3], ["webkit", 430, 932, 2], ["chromium", 390, 844, 2]]) {
  const browser = await pw[engine].launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.on("pageerror", (e) => say(engine, "JS ERROR", e.message));
  await p.goto(PROD); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(1200);
  await p.evaluate(() => { window.__f = []; let n = 0; const t = () => { const pg = document.querySelector(".fake-page"); if (pg) window.__f.push({ svg: !!pg.querySelector("svg.demo-page"), after: getComputedStyle(pg, "::after").content }); if (++n < 30) requestAnimationFrame(t); }; requestAnimationFrame(t); });
  await p.tap(".hero [data-go=camera]"); await p.waitForTimeout(800);
  const fr = await p.evaluate(() => window.__f);
  say(engine, W + "x" + H, "camera frames:", fr.length, "first frame:", fr[0], "all frames new page:", fr.every((f) => f.svg && f.after === "none"));
  const r = await p.evaluate(() => { const e = document.querySelector(".viewfinder").getBoundingClientRect(); return { y: e.y, h: e.height }; });
  await p.screenshot({ path: `${OUT}/camera-${engine}-${W}.png` });
  await p.screenshot({ path: `${OUT}/camera-${engine}-${W}-crop.png`, clip: { x: 0, y: r.y, width: W, height: r.h } });
  await browser.close();
}
fs.writeFileSync(`${OUT}/report.txt`, log.join("\n") + "\n");
