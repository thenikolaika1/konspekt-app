// Проверка тестовой сборки под путём как у githack (/thenikolaika1/konspekt-app/<ref>/), сервер без index для папок.
// node verify.test.js BUILD66 BUILD65
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [B66, B65] = process.argv.slice(2);
setTimeout(() => { console.log("TIMEOUT"); process.exit(3); }, 300000);
const PREFIX = "/thenikolaika1/konspekt-app/iphone-v66-test/";
let ROOT = B66;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".md": "text/plain" };
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (!u.pathname.startsWith(PREFIX)) return r.writeHead(404).end("other site");
  const p = decodeURIComponent(u.pathname.slice(PREFIX.length));
  const f = path.join(ROOT, p);
  if (!p || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end("not found"); // папки не отдаются
  r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(r);
});
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 300))); };
(async () => {
  await new Promise((r) => srv.listen(8411, "127.0.0.1", r));
  const BASE = "http://127.0.0.1:8411" + PREFIX;
  const browser = await chromium.launch();
  const outside = [];
  async function ctxNew(mobile = true) {
    const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ru-RU" } : { locale: "ru-RU" });
    ctx.setDefaultTimeout(20000);
    ctx.on("request", (q) => { if (!q.url().startsWith("http://127.0.0.1:8411" + PREFIX) && !q.url().startsWith("data:") && !q.url().startsWith("blob:")) outside.push(q.url()); });
    return ctx;
  }
  const ctx = await ctxNew();
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  // чужой кэш на том же домене (как другой сайт на githack) — не должен пропасть
  await page.goto("http://127.0.0.1:8411" + PREFIX + "README-TEST.md");
  await page.evaluate(async () => { const c = await caches.open("other-site-cache"); await c.put("/other/file", new Response("x")); });
  await page.goto(BASE + "start.html");
  await page.waitForFunction(() => document.getElementById("d-net").className !== "wait" && document.getElementById("d-sw").className !== "wait", null, { timeout: 20000 });
  const d = await page.evaluate(() => ({ b: document.getElementById("d-build").textContent, sw: document.getElementById("d-sw").textContent, net: document.getElementById("d-net").textContent, scope: document.getElementById("d-scope").textContent }));
  check("1. start.html: сборка v66, Service Worker работает, связь с настоящим сервером отключена", d.b === "v66" && d.sw === "работает" && d.net === "отключена", d);
  check("2. область Service Worker — только путь тестовой сборки", d.scope.endsWith(PREFIX), d.scope);
  const role = async (r) => { await page.goto(BASE + "start.html"); await page.click(`[data-role="${r}"]`); await page.waitForTimeout(1800);
    for (let i = 0; i < 4; i++) { const b = await page.$(".welcome:not(.access) .primary"); if (!b) break; await b.click(); await page.waitForTimeout(300); } };
  await role("student");
  // пример «Внутренняя энергия»
  await page.click('#app > .app [data-go="all-notes"]').catch(() => {}); await page.waitForTimeout(600);
  const cards = await page.$$("#app > .app .note-card[data-note]");
  let opened = false;
  for (const c of cards) if (/Внутренняя энергия/.test(await c.innerText())) { await c.click(); opened = true; break; }
  await page.waitForTimeout(900);
  const st = await page.evaluate(() => ({ prot: !!document.querySelector(".cn-doc.kn-protected"), wm: document.querySelectorAll(".kn-wm").length, code: document.querySelector(".kn-wm")?.textContent || "" }));
  check("3. ученик: пример «Внутренняя энергия» защищён, один водяной знак KN-…", opened && st.prot && st.wm === 1 && /^KN-[0-9A-F]{8}$/.test(st.code), st);
  await page.fill("#inNoteSearch", "энергия"); await page.waitForTimeout(500);
  const hits = await page.evaluate(() => ({ n: document.querySelectorAll("#noteDoc mark.cn-hit").length, c: document.querySelector("#inNoteCount").textContent }));
  check("4. поиск «энергия»: 15 совпадений, «1 из 15»", hits.n === 15 && hits.c === "1 из 15", hits);
  // камера: 4 фото → результат
  const mk = await browser.newPage(); const photos = [];
  for (let i = 1; i <= 5; i++) { await mk.setContent(`<body style="margin:0;background:hsl(${i * 50},60%,80%);font:bold 120px sans-serif">${i}</body>`); photos.push({ name: i + ".png", mimeType: "image/png", buffer: await mk.screenshot() }); }
  await mk.close();
  await page.goto(BASE + "index.html"); await page.waitForTimeout(1500);
  await page.click('#app > .app [data-go="camera"]'); await page.waitForTimeout(500);
  await page.setInputFiles("#galleryInput", photos); await page.waitForFunction(() => !document.querySelector(".page-shot.loading"), null, { timeout: 15000 }); await page.waitForTimeout(300);
  const cam = await page.evaluate(() => ({ n: document.querySelectorAll(".page-strip .page-thumb").length, t: document.querySelector(".camera-bottom")?.innerText.replace(/\s+/g, " ") }));
  check("5. выбор 5 фото: добавлены 4, сообщение о пределе", cam.n === 4 && /не больше 4/.test(cam.t), cam);
  await page.click("[data-process]");
  await page.waitForFunction(() => /Тестовый конспект/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  const res = await page.evaluate(() => ({ t: document.body.innerText.slice(0, 200), prot: !!document.querySelector(".cn-doc.kn-protected") }));
  check("6. «Создать конспект»: тестовый результат открыт и защищён", /Тестовый конспект/.test(res.t) && res.prot, res);
  await page.reload(); await page.waitForTimeout(1500);
  check("7. после перезагрузки конспект остаётся в истории", /Тестовый конспект/.test(await page.evaluate(() => document.body.innerText)));
  // владелец
  await role("owner");
  await page.click('#app > .app [data-go="all-notes"]').catch(() => {}); await page.waitForTimeout(600);
  for (const c of await page.$$("#app > .app .note-card[data-note]")) if (/Внутренняя энергия/.test(await c.innerText())) { await c.click(); break; }
  await page.waitForTimeout(900);
  const ow = await page.evaluate(() => ({ prot: !!document.querySelector(".cn-doc.kn-protected"), wm: document.querySelectorAll(".kn-wm").length, doc: !!document.querySelector(".cn-doc") }));
  check("8. владелец: защиты и водяного знака нет", ow.doc && !ow.prot && ow.wm === 0, ow);
  // доступ закончился
  await role("expired"); await page.waitForTimeout(500);
  check("9. доступ закончился: экран окончания доступа", /закончил/i.test(await page.evaluate(() => document.body.innerText)));
  // кэши и офлайн
  const keys = await page.evaluate(() => caches.keys());
  check("10. кэши: konspekt-test-v66 и чужой other-site-cache сохранён", keys.includes("konspekt-test-v66") && keys.includes("other-site-cache") && !keys.some((k) => k.startsWith("konspekt-v")), keys);
  await ctx.setOffline(true);
  const off = await ctx.newPage(); await off.goto(BASE + "index.html").catch(() => {}); await off.waitForTimeout(1500);
  check("11. без сети приложение открывается из кэша", await off.evaluate(() => !!document.querySelector("#app > .app")).catch(() => false));
  await ctx.setOffline(false);
  check("12. ни одного запроса за пределы тестовой сборки (Supabase, аналитика и т. п.)", outside.length === 0, outside);
  check("13. нет ошибок JS", errors.length === 0, errors);
  await ctx.close();
  // обновление v65 → v66 на одном адресе (как ветка на raw.githack)
  ROOT = B65;
  const c2 = await ctxNew(); const p2 = await c2.newPage(); const e2 = []; p2.on("pageerror", (e) => e2.push(String(e)));
  await p2.goto("http://127.0.0.1:8411" + PREFIX + "README-TEST.md");
  await p2.evaluate(async () => { const c = await caches.open("other-site-cache"); await c.put("/other/file", new Response("x")); });
  await p2.goto(BASE + "index.html"); await p2.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); await p2.reload(); await p2.waitForTimeout(1500);
  const v65 = await p2.evaluate(() => [...document.scripts].map((s) => s.src).filter((s) => /app\.js/.test(s))[0]);
  check("14. v65 (тест) открыт под Service Worker", /v=65/.test(v65), v65);
  ROOT = B66;
  const nav = p2.waitForEvent("framenavigated", { timeout: 20000 }).catch(() => null);
  await p2.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  check("15. после замены на v66 приложение само перезагрузилось", !!(await nav));
  await p2.waitForTimeout(1000);
  for (let i = 0; i < 60 && (await p2.evaluate(() => caches.keys())).includes("konspekt-test-v65"); i++) await p2.waitForTimeout(250);
  const a = await p2.evaluate(async () => ({ urls: [...document.scripts].map((s) => s.src).filter((u) => /\?v=/.test(u)), keys: await caches.keys() }));
  check("16. после обновления только файлы v66; кэш v65 удалён, чужой кэш сохранён", a.urls.length > 10 && a.urls.every((u) => /v=66$/.test(u)) && !a.keys.includes("konspekt-test-v65") && a.keys.includes("konspekt-test-v66") && a.keys.includes("other-site-cache"), a.keys);
  await p2.close(); await c2.setOffline(true);
  const p3 = await c2.newPage(); await p3.goto(BASE + "index.html").catch(() => {}); await p3.waitForTimeout(1500);
  const o = await p3.evaluate(() => ({ app: !!document.querySelector("#app > .app"), v: [...document.scripts].map((s) => s.src).filter((u) => /app\.js/.test(u))[0] })).catch(() => ({ app: false }));
  check("17. сразу после обновления без сети открывается v66", o.app && /v=66/.test(o.v || ""), o);
  check("18. нет ошибок JS при обновлении; запросов наружу нет", e2.length === 0 && outside.length === 0, { e2, outside });
  await browser.close(); srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (Chromium; не Safari)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR " + String(e).split("\n")[0]); process.exit(2); });
