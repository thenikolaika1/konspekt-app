// Проверка реального production: версии файлов + конспекты физики и истории (начало / середина / низ).
import { chromium } from "playwright";
import fs from "fs";
const PROD = "https://thenikolaika1.github.io/konspekt-app/";
const OUT = "prod-check-results";
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); log.push(s); };
const checks = { "index.html": ["v=25"], "service-worker.js": ["konspekt-v25"], "styles.css?v=25": ["--note-primary", "nt-physics", "cn-h2alt"],
  "js/classic-renderer.js?v=25": ["cn-card", "qa-label", 'part("remember"'], "js/mock-content.js?v=25": ['id: "b9", type: "IMPORTANT"'] };
say("=== HTTP ===");
for (const [f, ms] of Object.entries(checks)) {
  const r = await fetch(PROD + f, { cache: "no-store" }); const t = await r.text();
  say(f, r.status, "last-modified=" + r.headers.get("last-modified"), ms.map((m) => m + ":" + (t.includes(m) ? "YES" : "no")).join(" "));
}
const browser = await chromium.launch();
for (const [id, tag] of [["demo-internal-energy", "physics"], ["demo-northern-war", "history"]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => say(tag, "JS ERROR", e.message)); p.on("response", (r) => r.status() >= 400 && say(tag, "HTTP", r.status(), r.url()));
  await p.goto(PROD); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(700);
  await p.click(`[data-note="${id}"]`); await p.waitForSelector(".cn-intro"); await p.waitForTimeout(500);
  say(tag, await p.evaluate(() => {
    const cs = (q, k) => { const e = document.querySelector(q); return e ? getComputedStyle(e)[k] : null; };
    return { app: document.querySelector(".app").className, css: [...document.styleSheets].map((s) => s.href && s.href.split("/").pop()).filter(Boolean),
      bodyFont: cs(".cn-body p", "fontSize"), h2Font: cs(".cn-h2", "fontSize"), h2Bg: cs(".cn-h2", "backgroundImage").slice(0, 60), qFont: cs(".qa-q", "fontSize"),
      important: cs(".cn-box.important", "backgroundColor"), cards: document.querySelectorAll(".cn-card").length, sw: !!navigator.serviceWorker.controller };
  }));
  await p.screenshot({ path: `${OUT}/${tag}-top.png` });
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  if (tag === "history") {
    await p.evaluate(() => { const e = document.querySelectorAll(".cn-h2")[2]; scrollTo(0, e.getBoundingClientRect().top + scrollY - 70); });
  } else {
    await p.evaluate((h) => scrollTo(0, Math.round((h - innerHeight) / 2)), h);
  }
  await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/${tag}-middle.png` });
  await p.evaluate(() => scrollTo(0, 1e6)); await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/${tag}-bottom.png` });
  say(tag, "caches", await p.evaluate(() => caches.keys()));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/report.txt`, log.join("\n") + "\n");
