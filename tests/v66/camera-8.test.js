// v66 (эксперимент «8 фотографий»): экран камеры в Chromium — выбор 1–8 фото, отказ на 9-м, удаление, порядок
// отправки, счётчик, вёрстка на 320 / 390 / 768. Сеть заменена заглушкой (tests/v61/stub-cloud.js + подмена
// загрузки и запуска в тесте) — Supabase и ИИ не вызываются.
// Запуск: node tests/v66/camera-8.test.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-v66-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8266;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".json": "application/json" };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end();
  r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(r);
});
let pass = 0, fail = 0;
const check = (n, ok, x) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 400)));
};
const NOW = "2026-11-07T15:00:00+03:00";
const TRIAL = { status: "trial", kind: "trial", starts_at: "2026-11-05T00:00:00+03:00", ends_at: "2026-11-12T00:00:00+03:00", server_now: NOW, ai_quota: 3, ai_used: 0, ai_reserved: 0, ai_remaining: 3, ai_available: 3 };

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch();
  // «фотографии» страниц: разные картинки (номер страницы крупно), чтобы проверить порядок
  const mk = await browser.newPage({ viewport: { width: 300, height: 400 } });
  const photos = [];
  for (let i = 1; i <= 10; i++) {
    await mk.setContent(`<body style="margin:0;background:hsl(${i * 33},60%,85%);font:bold 160px sans-serif;display:grid;place-items:center;height:400px">${i}</body>`);
    photos.push({ name: "page-" + i + ".png", mimeType: "image/png", buffer: await mk.screenshot() });
  }
  await mk.close();

  async function open(vp) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700, serviceWorkers: "block", locale: "ru-RU" });
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
      if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify({ kind: "user", uid: "u-1", v2: TRIAL, access: { remaining: 3 } }));
    await page.goto("http://127.0.0.1:" + PORT + "/");
    await page.waitForTimeout(1500);
    for (let i = 0; i < 4; i++) {
      const b = await page.$(".welcome:not(.access) .primary");
      if (!b) break;
      await b.click();
      await page.waitForTimeout(300);
    }
    // загрузка и запуск — записываем, что ушло бы на сервер (порядок страниц), ИИ не вызывается
    await page.evaluate(() => {
      const T = window.__T;
      T.sent = null;
      window.K.cloud.createProcessingNote = async () => "note-1";
      window.K.cloud.uploadPages = async (noteId, pages, done) => {
        T.sent = await Promise.all(pages.map(async (p) => {
          const bmp = await createImageBitmap(p.blob);
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const g = c.getContext("2d");
          g.drawImage(bmp, 0, 0);
          return g.getImageData(Math.round(bmp.width / 2), 5, 1, 1).data.slice(0, 3).join(",");
        }));
        return pages.map((p, i) => "u-1/" + noteId + "/" + String(i + 1).padStart(2, "0") + "-" + p.id + ".jpg");
      };
      window.K.cloud.startAnalysis = async (noteId, paths) => ((T.startPaths = paths), { status: "processing" });
      window.K.cloud.waitForNote = async (noteId, opts) => ((T.waitOpts = opts), new Promise(() => {}));
    });
    return { ctx, page, errors };
  }
  const hscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  const camText = (page) => page.evaluate(() => (document.querySelector(".camera-bottom")?.innerText || "").replace(/\s+/g, " "));
  const thumbs = (page) => page.$$eval(".page-strip .page-thumb", (n) => n.length);
  const add = async (page, from, to) => {
    await page.setInputFiles("#galleryInput", photos.slice(from - 1, to));
    await page.waitForFunction(() => !document.querySelector(".page-shot.loading"), null, { timeout: 15000 });
    await page.waitForTimeout(300);
  };

  for (const [name, vp] of [["320", { width: 320, height: 640 }], ["390", { width: 390, height: 844 }], ["768", { width: 768, height: 1024 }]]) {
    const { ctx, page, errors } = await open(vp);
    await page.click('[data-go="camera"]');
    await page.waitForTimeout(500);
    check(`[${name}] камера: счётчик «Страницы · 0 из 8»`, (await camText(page)).includes("Страницы · 0 из 8"), await camText(page));
    await add(page, 1, 4);
    check(`[${name}] 4 фото: как раньше — можно добавлять ещё, сообщения об ограничении нет`, (await thumbs(page)) === 4 && !!(await page.$(".add-page"))
      && !(await camText(page)).includes("не более"), await camText(page));
    await add(page, 5, 8);
    let t = await camText(page);
    check(`[${name}] 8 фото: все 8 миниатюр видны, «Страницы · 8 из 8», кнопок добавления нет, сообщение «Можно загрузить не более 8 фотографий»`,
      (await thumbs(page)) === 8 && t.includes("Страницы · 8 из 8") && !(await page.$(".add-page")) && t.includes("Можно загрузить не более 8 фотографий")
        && (await page.$eval(".shutter", (b) => b.disabled)) && (await page.$eval("[data-gallery]", (b) => b.disabled)), t);
    const vis = await page.$$eval(".page-strip .page-thumb", (ns) => ns.every((n) => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height > 0; }));
    check(`[${name}] 8 миниатюр в пределах экрана (перенос во второй ряд), без горизонтальной прокрутки`, vis && !(await hscroll(page)));
    await page.screenshot({ path: path.join(SHOTS, "camera-8-" + name + ".png"), fullPage: true });
    // 9-я фотография (из галереи сразу несколько): отказ, 8 остаются
    await page.evaluate(() => (document.querySelector("[data-gallery]").disabled = false));
    await page.setInputFiles("#galleryInput", photos.slice(8, 10));
    await page.waitForTimeout(500);
    t = await camText(page);
    check(`[${name}] 9-я и 10-я фото: не добавлены (8 остаются), «Можно загрузить не более 8 фотографий»`, (await thumbs(page)) === 8 && t.includes("Можно загрузить не более 8 фотографий"), t);
    if (name === "390") {
      // удаление 3-й страницы: 7, снова можно добавить; порядок отправки 1,2,4,5,6,7,8 → добавляем 9-ю в конец
      await page.click('.page-strip [data-remove-page="2"]');
      await page.waitForTimeout(500);
      t = await camText(page);
      check("[390] удалена 3-я фото: 7 миниатюр, «7 из 8», кнопка «Ещё страница» вернулась, сообщения нет",
        (await thumbs(page)) === 7 && t.includes("Страницы · 7 из 8") && !!(await page.$(".add-page")) && !t.includes("не более"), t);
      await add(page, 9, 9);
      const order = await page.$$eval(".page-strip .page-shot", (ns) => ns.map((n) => n.alt));
      check("[390] после удаления и добавления — 8 фото", order.length === 8, order);
      await page.click("[data-process]");
      await page.waitForFunction(() => window.__T.startPaths, null, { timeout: 10000 });
      const T = await page.evaluate(() => window.__T);
      check("[390] «Создать конспект»: на сервер ушли 8 страниц по порядку экрана (01…08), один запуск генерации",
        T.startPaths.length === 8 && T.startPaths.every((p, i) => p.includes("/" + String(i + 1).padStart(2, "0") + "-")), T.startPaths);
      // порядок по содержимому: цвет фона каждой отправленной страницы = цвет исходной фотографии 1,2,4,5,6,7,8,9
      const expected = await page.evaluate(async (b64s) => Promise.all(b64s.map(async (b) => {
        const bmp = await createImageBitmap(await (await fetch("data:image/png;base64," + b)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        return [...g.getImageData(Math.round(bmp.width / 2), 5, 1, 1).data.slice(0, 3)];
      })), [1, 2, 4, 5, 6, 7, 8, 9].map((i) => photos[i - 1].buffer.toString("base64")));
      const near = (a, b) => a.every((x, k) => Math.abs(x - b[k]) <= 12); // JPEG-сжатие слегка меняет цвет
      const sent = T.sent.map((x) => x.split(",").map(Number));
      check("[390] содержимое страниц в порядке экрана: 1, 2, 4, 5, 6, 7, 8, 9 (3-я удалена)", sent.length === 8 && sent.every((c, i) => near(c, expected[i])), { sent, expected });
      check("[390] ожидание результата для 8 страниц — увеличенное (pageCount = 8)", T.waitOpts && T.waitOpts.pageCount === 8, T.waitOpts);
    }
    check(`[${name}] нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }
  // v66.4: сервер вернул failed AI_BAD_JSON — понятное сообщение вместо «Что-то пошло не так», фото сохранены
  {
    const { ctx, page, errors } = await open({ width: 390, height: 844 });
    await page.evaluate(() => {
      window.K.cloud.waitForNote = async () => ({ id: "note-1", status: "failed", stage: "failed", error_code: "AI_BAD_JSON" });
    });
    await page.click('[data-go="camera"]');
    await page.waitForTimeout(500);
    await add(page, 1, 8);
    await page.click("[data-process]");
    await page.waitForFunction(() => /Не удалось создать конспект/.test(document.body.innerText), null, { timeout: 15000 });
    const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    check("[390, AI_BAD_JSON] экран ошибки: «ИИ не смог корректно сформировать конспект. Твои фотографии сохранены.», подсказка «Попробуй ещё раз.», без «Что-то пошло не так»",
      t.includes("ИИ не смог корректно сформировать конспект. Твои фотографии сохранены.") && t.includes("Попробуй ещё раз.") && !t.includes("Что-то пошло не так")
        && !!(await page.$("[data-retry]")), t.slice(0, 400));
    check("[390, AI_BAD_JSON] нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }
  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (интерфейс с заглушкой сервера; ИИ не вызывался)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
