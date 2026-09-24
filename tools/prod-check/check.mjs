// Проверка реального production: заголовки/маркеры файлов + скриншоты экранов + старые данные localStorage.
import { chromium } from "playwright";
import fs from "fs";
const PROD = "https://thenikolaika1.github.io/konspekt-app/";
const OUT = "prod-check-results";
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); log.push(s); };

// 1. что реально отдаёт сервер
const files = ["", "index.html", "service-worker.js", "styles.css?v=22", "styles.css", "app.js?v=22", "app.js",
  "js/classic-renderer.js?v=22", "js/classic-renderer.js", "js/mock-content.js?v=22", "js/store.js?v=22", "assets/thumbs/leaf.svg"];
const markers = { "": ["v=22", "v=16"], "index.html": ["v=22", "v=16"], "service-worker.js": ["konspekt-v22", "konspekt-v16"],
  "styles.css?v=22": ["CLASSIC NOTE", "COLOR & DEPTH", "обложки конспектов"], "styles.css": ["CLASSIC NOTE"],
  "app.js?v=22": ["noteThumb", "inNoteSearch"], "app.js": ["noteThumb", "inNoteSearch"],
  "js/classic-renderer.js?v=22": ["cn-intro", "section-bar"], "js/classic-renderer.js": ["cn-intro", "section-bar"],
  "js/mock-content.js?v=22": ["assets/thumbs"], "js/store.js?v=22": ["migrateThumbnails"] };
say("=== HTTP ===");
for (const f of files) {
  const r = await fetch(PROD + f, { cache: "no-store" });
  const t = await r.text();
  const h = (k) => r.headers.get(k);
  say(f || "/", r.status, "etag=" + h("etag"), "last-modified=" + h("last-modified"), "cache-control=" + h("cache-control"),
    "age=" + h("age"), "x-cache=" + h("x-cache"), "len=" + t.length,
    (markers[f] || []).map((m) => m + ":" + (t.includes(m) ? "YES" : "no")).join(" "));
}

const browser = await chromium.launch();
const newCtx = () => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const watch = (p, tag) => {
  p.on("pageerror", (e) => say(tag, "JS ERROR", e.message));
  p.on("console", (m) => m.type() === "error" && say(tag, "console.error", m.text()));
  p.on("response", (r) => r.status() >= 400 && say(tag, "HTTP", r.status(), r.url()));
};
const loaded = (p) => p.evaluate(() => ({
  scripts: [...document.scripts].map((s) => s.src.replace(location.origin, "")).filter(Boolean),
  css: [...document.styleSheets].map((s) => s.href && s.href.replace(location.origin, "")).filter(Boolean),
  sw: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
}));

// 2. свежий пользователь: полный flow по экранам
say("=== FRESH USER FLOW ===");
{
  const ctx = await newCtx(); const p = await ctx.newPage(); watch(p, "[fresh]");
  await p.goto(PROD); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(800);
  say("loaded", await loaded(p));
  say("home", await p.evaluate(() => ({ thumbImgs: document.querySelectorAll(".note-card .thumb-img").length, cardPills: [...document.querySelectorAll(".note-card .pill")].map((x) => x.className) })));
  await p.screenshot({ path: `${OUT}/01-home.png` });
  await p.click(".hero [data-go=camera]"); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/02-camera-empty.png` });
  await p.setInputFiles("#cameraInput", ["03-camera.png", "13-note.png"]); await p.waitForFunction(() => document.querySelectorAll(".page-thumb").length >= 2);
  await p.screenshot({ path: `${OUT}/03-camera-pages.png` });
  await p.click("[data-process]"); await p.waitForTimeout(1300);
  await p.screenshot({ path: `${OUT}/04-processing.png` });
  await p.waitForSelector(".note-title", { timeout: 15000 }); await p.waitForTimeout(400);
  say("created note DOM", await p.evaluate(() => ({ cnIntro: !!document.querySelector(".cn-intro"), oldSectionBar: document.querySelectorAll(".section-bar").length, cnH2: document.querySelectorAll(".cn-h2").length, qa: document.querySelectorAll(".cn-body .qa").length, theme: document.querySelector(".app").className, boxBg: getComputedStyle(document.querySelector(".cn-box") || document.body).backgroundColor })));
  await p.screenshot({ path: `${OUT}/05-note-created-top.png` });
  await p.click("[data-back]"); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/06-home-after-create.png` });
  await p.click('[data-note="demo-internal-energy"]'); await p.waitForSelector(".note-title"); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/07-note-physics-top.png` });
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  await p.evaluate((h) => scrollTo(0, Math.round((h - innerHeight) / 2)), h); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/08-note-physics-middle.png` });
  await p.evaluate(() => scrollTo(0, 1e6)); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/09-note-physics-bottom.png` });
  await p.evaluate(() => scrollTo(0, 0));
  await p.click("[data-back]"); await p.waitForTimeout(300);
  await p.click('[data-note="demo-northern-war"]'); await p.waitForSelector(".note-title"); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/10-note-history-top.png` });
  await p.click(".note-actions .note-menu"); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/11-note-menu-sheet.png` });
  await p.click("[data-backdrop]", { position: { x: 20, y: 20 } }); await p.waitForTimeout(300);
  await p.click("[data-back]"); await p.waitForTimeout(300);
  await p.click("[data-go=all-notes]"); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/12-all-notes.png` });
  await p.click("[data-back]"); await p.waitForTimeout(300);
  await p.click('[data-bookmark="bm-history"]'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/13-bookmark.png` });
  await p.click("[data-back]"); await p.waitForTimeout(300);
  await p.click(".bookmarks [data-go=new-bookmark]"); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/14-new-bookmark.png` });
  say("caches", await p.evaluate(() => caches.keys()));
  await ctx.close();
}

// 3. пользователь со СТАРЫМИ данными (localStorage от прошлой версии 1125d71) и уже установленным SW
say("=== LEGACY LOCALSTORAGE ===");
{
  const oc = await newCtx(); const op = await oc.newPage();
  await op.goto("http://localhost:8000/konspekt-app/"); await op.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await op.reload(); await op.waitForTimeout(600);
  await op.click(".hero [data-go=camera]"); await op.setInputFiles("#cameraInput", ["03-camera.png"]); await op.waitForSelector(".page-thumb");
  await op.click("[data-process]"); await op.waitForSelector(".note-title", { timeout: 15000 });
  const legacy = await op.evaluate(() => localStorage.getItem("konspekt.store.v1"));
  say("legacy store bytes", legacy.length, "notes", JSON.parse(legacy).notes.map((n) => n.id + (n.thumbnail ? "+thumb" : "")));
  await oc.close();
  const ctx = await newCtx(); const p = await ctx.newPage(); watch(p, "[legacy]");
  await p.goto(PROD); await p.evaluate((s) => { localStorage.clear(); localStorage.setItem("k-first", "1"); localStorage.setItem("konspekt.store.v1", s); }, legacy);
  await p.reload(); await p.waitForTimeout(800);
  say("legacy home", await p.evaluate(() => ({ cards: document.querySelectorAll(".note-list .note-card").length, thumbImgs: document.querySelectorAll(".note-card .thumb-img").length, stored: JSON.parse(localStorage.getItem("konspekt.store.v1")).notes.map((n) => n.id + (n.thumbnail ? "+thumb" : "")) })));
  await p.screenshot({ path: `${OUT}/20-legacy-home.png` });
  await p.locator(".note-card").first().click(); await p.waitForSelector(".note-title"); await p.waitForTimeout(400);
  say("legacy user-created note", await p.evaluate(() => ({ title: document.querySelector(".note-title").textContent, cnIntro: !!document.querySelector(".cn-intro"), oldSectionBar: document.querySelectorAll(".section-bar").length })));
  await p.screenshot({ path: `${OUT}/21-legacy-note-created.png` });
  await p.click("[data-back]"); await p.waitForTimeout(300);
  await p.click('[data-note="demo-internal-energy"]'); await p.waitForSelector(".note-title"); await p.waitForTimeout(400);
  say("legacy demo note", await p.evaluate(() => ({ cnIntro: !!document.querySelector(".cn-intro"), oldSectionBar: document.querySelectorAll(".section-bar").length })));
  await p.screenshot({ path: `${OUT}/22-legacy-note-physics.png` });
  await p.reload(); await p.waitForTimeout(800);
  say("after reload", await loaded(p), await p.evaluate(() => caches.keys()));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/report.txt`, log.join("\n") + "\n");
