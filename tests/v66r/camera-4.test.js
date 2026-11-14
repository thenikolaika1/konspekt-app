// v66 (релиз, предел 4 фото у всех): экран камеры в Chromium — выбор 1–4 фото, отказ на 5-м, выбор сразу нескольких из
// галереи, удаление, порядок отправки (по содержимому картинок), один запуск, сообщение AI_BAD_JSON, вёрстка 320 / 390 / 768.
// Сеть заменена заглушкой (tests/v61/stub-cloud.js + подмена загрузки и запуска в тесте) — Supabase и ИИ не вызываются.
// Запуск: node tests/v66r/camera-4.test.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-v66r-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8267;
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

  const colorsOf = (page, nums) => page.evaluate(async (b64s) => Promise.all(b64s.map(async (b) => {
    const bmp = await createImageBitmap(await (await fetch("data:image/png;base64," + b)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    return [...g.getImageData(Math.round(bmp.width / 2), 5, 1, 1).data.slice(0, 3)];
  })), nums.map((i) => photos[i - 1].buffer.toString("base64")));
  const near = (a, b) => a.every((x, k) => Math.abs(x - b[k]) <= 12); // JPEG-сжатие слегка меняет цвет
  const sentIs = async (page, nums) => {
    const T = await page.evaluate(() => window.__T);
    const exp = await colorsOf(page, nums);
    const sent = (T.sent || []).map((x) => x.split(",").map(Number));
    return { ok: sent.length === nums.length && sent.every((c, i) => near(c, exp[i])), sent, exp, T };
  };
  const msgOf = (t) => /не больше 4 страниц/.test(t);

  for (const [name, vp] of [["320", { width: 320, height: 640 }], ["390", { width: 390, height: 844 }], ["768", { width: 768, height: 1024 }]]) {
    const { ctx, page, errors } = await open(vp);
    await page.click('[data-go="camera"]');
    await page.waitForTimeout(500);
    check(`[${name}] камера: «Страницы · 0»`, (await camText(page)).includes("Страницы · 0"), await camText(page));
    await add(page, 1, 3);
    check(`[${name}] 3 фото: можно добавлять ещё, сообщения об ограничении нет`, (await thumbs(page)) === 3 && !!(await page.$(".add-page")) && !msgOf(await camText(page)), await camText(page));
    await add(page, 4, 4);
    let t = await camText(page);
    check(`[${name}] 4 фото: 4 миниатюры, «Страницы · 4», кнопок добавления нет, съёмка и галерея выключены`,
      (await thumbs(page)) === 4 && t.includes("Страницы · 4") && !(await page.$(".add-page"))
        && (await page.$eval(".shutter", (b) => b.disabled)) && (await page.$eval("[data-gallery]", (b) => b.disabled)), t);
    check(`[${name}] 4 миниатюры в пределах экрана, без горизонтальной прокрутки`,
      (await page.$$eval(".page-strip .page-thumb", (ns) => ns.every((n) => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height > 0; }))) && !(await hscroll(page)));
    await page.screenshot({ path: path.join(SHOTS, "camera-4-" + name + ".png"), fullPage: true });
    // 5-я и 6-я (выключенную кнопку обходим): не добавлены, сообщение о пределе
    await page.evaluate(() => (document.querySelector("[data-gallery]").disabled = false));
    await page.setInputFiles("#galleryInput", photos.slice(4, 6));
    await page.waitForTimeout(500);
    t = await camText(page);
    check(`[${name}] 5-я и 6-я фото: не добавлены (4 остаются), «Можно добавить не больше 4 страниц»`, (await thumbs(page)) === 4 && msgOf(t), t);
    if (name === "390") {
      await page.click('.page-strip [data-remove-page="1"]');
      await page.waitForTimeout(500);
      t = await camText(page);
      check("[390] удалена 2-я фото: 3 миниатюры, «Страницы · 3», «Ещё страница» вернулась", (await thumbs(page)) === 3 && t.includes("Страницы · 3") && !!(await page.$(".add-page")), t);
      await add(page, 7, 7);
      await page.click("[data-process]");
      await page.waitForFunction(() => window.__T.startPaths, null, { timeout: 10000 });
      const s = await sentIs(page, [1, 3, 4, 7]);
      check("[390] «Создать конспект»: на сервер ушли 4 страницы, пути 01…04 по порядку экрана, один запуск",
        s.T.startPaths.length === 4 && s.T.startPaths.every((p, i) => p.includes("/" + String(i + 1).padStart(2, "0") + "-")), s.T.startPaths);
      check("[390] содержимое отправленных фото = выбранные фото в порядке экрана: 1, 3, 4, 7 (2-я удалена)", s.ok, { sent: s.sent, exp: s.exp });
    }
    check(`[${name}] нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }
  // выбор сразу 6 фото из галереи: добавлены первые 4 в порядке выбора, отправляются именно они
  {
    const { ctx, page, errors } = await open({ width: 390, height: 844 });
    await page.click('[data-go="camera"]');
    await page.waitForTimeout(500);
    await page.setInputFiles("#galleryInput", [photos[5], photos[1], photos[8], photos[3], photos[0], photos[2]]);
    await page.waitForFunction(() => !document.querySelector(".page-shot.loading"), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    const t = await camText(page);
    check("[галерея, 6 сразу] добавлены 4, «Можно добавить не больше 4 страниц»", (await thumbs(page)) === 4 && msgOf(t), t);
    await page.click("[data-process]");
    await page.waitForFunction(() => window.__T.startPaths, null, { timeout: 10000 });
    const s = await sentIs(page, [6, 2, 9, 4]);
    check("[галерея, 6 сразу] отправлены ровно первые 4 выбранные фото в порядке выбора: 6, 2, 9, 4", s.ok && s.T.startPaths.length === 4, { sent: s.sent, exp: s.exp });
    check("[галерея, 6 сразу] нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }
  // сервер вернул failed AI_BAD_JSON — понятное сообщение вместо «Что-то пошло не так», фото сохранены
  {
    const { ctx, page, errors } = await open({ width: 390, height: 844 });
    await page.evaluate(() => {
      window.K.cloud.waitForNote = async () => ({ id: "note-1", status: "failed", stage: "failed", error_code: "AI_BAD_JSON" });
    });
    await page.click('[data-go="camera"]');
    await page.waitForTimeout(500);
    await add(page, 1, 2);
    await page.click("[data-process]");
    await page.waitForFunction(() => /Не удалось создать конспект/.test(document.body.innerText), null, { timeout: 15000 });
    const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    check("[AI_BAD_JSON] экран ошибки: «ИИ не смог корректно сформировать конспект. Твои фотографии сохранены.», «Попробуй ещё раз.», кнопка повтора",
      t.includes("ИИ не смог корректно сформировать конспект. Твои фотографии сохранены.") && t.includes("Попробуй ещё раз.") && !t.includes("Что-то пошло не так")
        && !!(await page.$("[data-retry]")), t.slice(0, 400));
    check("[AI_BAD_JSON] нет ошибок JS", errors.length === 0, errors);
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
