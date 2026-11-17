// v72: ПК-версия Konspekt by NK — боковая панель, ширина экранов, чтение с оглавлением рядом, фото с компьютера
// (перетаскивание, Ctrl+V), кнопка установки, устанавливаемость PWA (проверка самого Chromium), телефон без изменений.
// Сайт открывается локально (под /konspekt-app/, как на GitHub Pages), сеть заменена заглушкой tests/v61/stub-cloud.js.
//
// Запуск из корня репозитория:  node tests/v72/desktop.test.js
//   PH7_CONTENT=<файл.json вне репозитория> — настоящие тексты физики 7 (иначе текст заглушки; раскладка проверяется так же).
//   SHOTS_DIR=<папка> — снимки экранов.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const CONTENT = process.env.PH7_CONTENT ? JSON.parse(fs.readFileSync(process.env.PH7_CONTENT, "utf8")) : null;
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-v72-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8272, BASE = "http://127.0.0.1:" + PORT + "/konspekt-app/";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (!p.startsWith("/konspekt-app/")) return r.writeHead(404).end();
  p = p.slice("/konspekt-app".length);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end();
  r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(r);
});

let pass = 0, fail = 0;
const check = (n, ok, x) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 500)));
};
const at = (d) => new Date(Date.now() + d * 864e5).toISOString();
const GIFT = { status: "paid", kind: "paid", plan: "gift", plan_title: "Подарок", starts_at: at(-1), ends_at: at(29), paid_until: at(29), server_now: new Date().toISOString(), ai_quota: 3, ai_used: 1, ai_reserved: 0, ai_remaining: 2, ai_available: 2 };
const EXPIRED = { status: "expired", kind: "paid", plan: "gift", starts_at: at(-8), ends_at: at(-1), revoked: false, server_now: new Date().toISOString(), ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 };
const pngSize = (f) => { const b = fs.readFileSync(path.join(ROOT, f)); return b.readUInt32BE(16) + "x" + b.readUInt32BE(20); };

(async () => {
  // ---------- 1. файлы: manifest, иконки, стили ----------
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  check("manifest: название Konspekt by NK, standalone, start_url/scope/id — /konspekt-app/", man.name === "Konspekt by NK" && man.short_name && man.display === "standalone" &&
    man.start_url === "/konspekt-app/" && man.scope === "/konspekt-app/" && man.id === "/konspekt-app/", man);
  check("manifest: иконки 192 и 512 (обычная и maskable), размеры файлов совпадают", man.icons.some((i) => i.sizes === "192x192") && man.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable") &&
    man.icons.every((i) => fs.existsSync(path.join(ROOT, i.src)) && pngSize(i.src) === i.sizes), man.icons.map((i) => [i.src, i.sizes, fs.existsSync(path.join(ROOT, i.src)) && pngSize(i.src)]));
  check("manifest: снимки экрана для окна установки — wide (ПК) и narrow (телефон), размеры совпадают с файлами", man.screenshots.some((s) => s.form_factor === "wide") && man.screenshots.some((s) => s.form_factor === "narrow") &&
    man.screenshots.every((s) => fs.existsSync(path.join(ROOT, s.src)) && pngSize(s.src) === s.sizes), man.screenshots.map((s) => [s.src, s.sizes, fs.existsSync(path.join(ROOT, s.src)) && pngSize(s.src)]));
  const idx = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "desktop.css"), "utf8");
  check("index.html: desktop.css подключён после остальных стилей, той же сборки", /desktop\.css\?v=\d+"/.test(idx) && idx.indexOf("desktop.css") > idx.indexOf("classic-reference-v38.css"));
  const outside = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").trim();
  check("desktop.css: вне @media только скрытие ПК-элементов (телефон не меняется)", /^(\.[\w.-]+(,\.[\w.-]+)*\{display:none(!important)?\}\s*)+$/.test(outside.replace(/\s+/g, "").replace(/}/g, "}\n").trim().split("\n").join("")) || outside.split("}").filter(Boolean).every((r) => /display:none/.test(r)), outside);

  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch();

  async function open(T, vp, { sw = false } = {}) {
    const mobile = vp.width < 600;
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, serviceWorkers: sw ? "allow" : "block", locale: "ru-RU" });
    const stub = STUB + (CONTENT ? `;(() => { const C = ${JSON.stringify(CONTENT)}; const o = window.K.cloud.libraryParagraph; window.K.cloud.libraryParagraph = async (s, b, p) => { const r = await o(s, b, p); return C[p] ? JSON.parse(JSON.stringify(C[p])) : r; }; })();` : "");
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: stub });
      if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify(T));
    await page.goto(BASE);
    await page.waitForTimeout(1300);
    for (let i = 0; i < 4; i++) {
      const b = await page.$(".welcome:not(.access) .primary");
      if (!b) break;
      await b.click();
      await page.waitForTimeout(300);
    }
    return { ctx, page, errors };
  }
  const P = (extra) => ({ kind: "participant", id: "KN-AAAAAA", uid: "u-1", v2: GIFT, ...extra });
  const click = async (page, sel) => { await page.locator(sel).filter({ visible: true }).first().click(); await page.waitForTimeout(450); };
  const layout = (page) => page.evaluate(() => {
    const a = document.querySelector("#app > .app")?.getBoundingClientRect();
    const t = document.querySelector(".tabbar");
    const tr = t && !t.hidden ? t.getBoundingClientRect() : null;
    const tabs = [...document.querySelectorAll(".tabbar .tab[data-tab]")].map((b) => b.getBoundingClientRect());
    return {
      hscroll: document.documentElement.scrollWidth > innerWidth + 1,
      app: a && { left: Math.round(a.left), width: Math.round(a.width) },
      bar: tr && { left: Math.round(tr.left), top: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) },
      vertical: tabs.length === 4 && tabs.every((r, i) => !i || r.top > tabs[i - 1].top + 10),
      active: document.querySelector(".tabbar .tab.active")?.dataset.tab || null,
      vw: innerWidth, vh: innerHeight,
    };
  });

  // ---------- 2. разрешения: основные экраны без горизонтальной прокрутки и ошибок ----------
  const VPS = [[1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [1024, 768], [390, 844]];
  for (const [w, h] of VPS) {
    const name = w + "x" + h, desk = w >= 1024;
    const { ctx, page, errors } = await open(P(), { width: w, height: h });
    const seen = [];
    const visit = async (label) => {
      const l = await layout(page);
      seen.push([label, l]);
      await page.screenshot({ path: path.join(SHOTS, name + "-" + label + ".png") });
      return l;
    };
    const home = await visit("home");
    if (desk) {
      check(`[${name}] главная: боковая панель слева на всю высоту, разделы столбиком, «Главная» выделена`, home.bar && home.bar.left === 0 && home.bar.top === 0 && home.bar.h === home.vh && home.vertical && home.active === "home", home);
      check(`[${name}] главная: рабочая область справа от панели, шире телефонной колонки (430 px)`, home.app.left >= home.bar.w + 20 && home.app.width > 700 && home.app.left + home.app.width <= w, home);
    } else {
      check(`[${name}] телефон: нижняя панель внизу на всю ширину, экран во всю ширину — как раньше`, home.bar && home.bar.left === 0 && home.bar.w === w && home.bar.top + home.bar.h === h && home.app.width === w, home);
    }
    await click(page, '[data-tab="library"]');
    await click(page, '[data-lib-grade="7"]');
    await click(page, '[data-lib-subject="physics"]');
    await click(page, '[data-lib-book="physics-7-engineers-1"]');
    const book = await visit("book");
    if (desk && w >= 1366) {
      const cols = await page.evaluate(() => new Set([...document.querySelectorAll("[data-lib-paragraph]")].slice(1, 6).map((b) => Math.round(b.getBoundingClientRect().left))).size);
      check(`[${name}] учебник: параграфы в несколько колонок`, cols >= 2, cols);
    }
    await click(page, '[data-lib-paragraph="physics-7-p34"]');
    await page.waitForSelector(".cn-doc", { timeout: 5000 }).catch(() => {});
    const rd = await visit("paragraph");
    const doc = await page.evaluate(() => {
      const toc = document.querySelector(".cn-doc > .lr-toc")?.getBoundingClientRect();
      const body = document.querySelector(".cn-doc > .cn-body")?.getBoundingClientRect();
      return { toc: toc && { l: Math.round(toc.left), r: Math.round(toc.right), t: Math.round(toc.top) }, body: body && { l: Math.round(body.left), w: Math.round(body.width), t: Math.round(body.top) }, sticky: document.querySelector(".cn-doc > .lr-toc") && getComputedStyle(document.querySelector(".cn-doc > .lr-toc")).position };
    });
    if (desk && doc.toc) {
      check(`[${name}] чтение: оглавление слева от текста и закреплено при прокрутке, текст — колонка не шире 800 px`, doc.toc.r <= doc.body.l && Math.abs(doc.toc.t - doc.body.t) < 40 && doc.sticky === "sticky" && doc.body.w <= 800 && doc.body.w >= 420, doc);
      check(`[${name}] чтение: боковая панель остаётся, выделена «Библиотека»`, rd.bar && rd.active === "library", rd);
    } else if (!desk) {
      check(`[${name}] телефон, чтение: оглавление над текстом, нижней панели нет — как раньше`, (!doc.toc || doc.toc.t < doc.body.t) && !rd.bar, [doc, rd]);
    }
    await page.evaluate(() => scrollTo(0, 2000));
    await page.waitForTimeout(250);
    await visit("paragraph-mid");
    if (desk) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      check(`[${name}] Esc на экране чтения — «Назад» к списку параграфов`, (await page.$$("[data-lib-paragraph]")).length === 47);
      await click(page, '[data-lib-paragraph="physics-7-p1"]');
      await click(page, '[data-tab="home"]');
      check(`[${name}] с экрана чтения боковая панель ведёт на главную`, (await layout(page)).active === "home" && !!(await page.$(".scr-home")));
    } else {
      for (let i = 0; i < 6 && !(await page.locator('[data-tab="me"]').isVisible().catch(() => false)); i++) {
        await page.evaluate(() => scrollTo(0, 0));
        await click(page, "[data-back]");
        await page.waitForTimeout(400);
      }
    }
    await click(page, '[data-tab="me"]');
    await visit("profile");
    await click(page, '[data-tab="home"]');
    await click(page, '[data-go="all-notes"]');
    await visit("all-notes");
    await click(page, '[data-tab="photo"]');
    const cam = await visit("camera");
    if (desk) {
      const dz = await page.evaluate(() => { const d = document.querySelector(".drop-hint"); const s = document.querySelector(".shutter"); return { drop: !!d && getComputedStyle(d).display !== "none", shutter: !!s && getComputedStyle(s).display !== "none", pick: !!document.querySelector(".drop-hint [data-gallery]") }; });
      check(`[${name}] «Новый конспект»: место для фото с компьютера и кнопка «Выбрать файлы», кнопки затвора нет, выделено «Фото»`, dz.drop && dz.pick && !dz.shutter && cam.active === "photo", [dz, cam.active]);
    } else {
      const dz = await page.evaluate(() => ({ drop: getComputedStyle(document.querySelector(".drop-hint")).display, shutter: getComputedStyle(document.querySelector(".shutter")).display }));
      check(`[${name}] телефон, камера: затвор и видоискатель как раньше, ПК-подсказки нет`, dz.drop === "none" && dz.shutter !== "none", dz);
    }
    check(`[${name}] ни на одном экране нет горизонтальной прокрутки`, seen.every(([, l]) => !l.hscroll), seen.filter(([, l]) => l.hscroll).map(([n]) => n));
    check(`[${name}] нет ошибок JavaScript`, errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 3. доступ закончился, окна ----------
  {
    const { ctx, page, errors } = await open(P({ v2: EXPIRED }), { width: 1440, height: 900 });
    const l = await layout(page);
    const txt = await page.evaluate(() => document.querySelector("#app > .app").textContent);
    check("[1440] срок закончился: экран продления не шире 760 px, панель на месте, текст об окончании доступа", l.app.width <= 760 && l.bar && /закончил/.test(txt), [l.app, txt.slice(0, 80)]);
    await page.screenshot({ path: path.join(SHOTS, "1440-access-ended.png") });
    check("[1440] срок закончился: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(P(), { width: 1440, height: 900 });
    await click(page, "[data-note-menu]");
    const sh = await page.evaluate(() => { const s = document.querySelector(".overlay .sheet")?.getBoundingClientRect(); return s && { top: Math.round(s.top), bottom: Math.round(s.bottom), w: Math.round(s.width), cx: Math.round(s.left + s.width / 2), mid: Math.round((({ left, width }) => left + width / 2)(document.querySelector(".overlay").getBoundingClientRect())) }; });
    check("[1440] меню конспекта — окно по центру экрана, а не лист снизу", sh && sh.bottom < 900 - 20 && sh.top > 20 && sh.w <= 520 && Math.abs(sh.cx - sh.mid) < 4, sh); // по центру видимой области (без места под полосу прокрутки — оно зарезервировано, v72.1)
    await page.screenshot({ path: path.join(SHOTS, "1440-menu.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    check("[1440] Esc закрывает окно", !(await page.$(".overlay:not(.closing)")));
    check("[1440] окна: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 4. фото с компьютера: перетаскивание, вставка, не-картинка, бросок вне экрана ----------
  {
    const { ctx, page, errors } = await open(P(), { width: 1440, height: 900 });
    const png = fs.readFileSync(path.join(ROOT, "icons/icon-192.png")).toString("base64");
    const drop = (kind, type, name) => page.evaluate(([b64, kind, type, name]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([type === "image/png" ? bin : new TextEncoder().encode("text")], name, { type }));
      if (kind === "paste") return document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector(".app").dispatchEvent(over);
      const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector(".app").dispatchEvent(ev);
      return [over.defaultPrevented, ev.defaultPrevented];
    }, [png, kind, type, name]);
    const homeDrop = await drop("drop", "image/png", "page.png");
    check("бросок файла на главной: браузер не открывает файл вместо приложения, страницы не добавляются", homeDrop[0] && homeDrop[1] && !!(await page.$(".scr-home")));
    await click(page, '[data-tab="photo"]');
    await drop("drop", "image/png", "page1.png");
    await page.waitForTimeout(1200);
    const n1 = await page.$$eval(".page-strip .page-thumb", (x) => x.length);
    check("перетаскивание PNG в «Новый конспект» добавляет страницу", n1 === 1, n1);
    await drop("paste", "image/png", "shot.png");
    await page.waitForTimeout(1200);
    const n2 = await page.$$eval(".page-strip .page-thumb", (x) => x.length);
    check("вставка скриншота (Ctrl+V) добавляет страницу", n2 === 2, n2);
    await drop("drop", "text/plain", "notes.txt");
    await page.waitForTimeout(500);
    const msg = await page.evaluate(() => document.querySelector(".camera-message")?.textContent || "");
    const n3 = await page.$$eval(".page-strip .page-thumb", (x) => x.length);
    check("брошенный не-рисунок не добавляется, понятное сообщение", n3 === 2 && /фотографии или скриншоты/.test(msg), [n3, msg]);
    const ready = await page.evaluate(() => !document.querySelector("[data-process]").disabled);
    check("кнопка «Создать конспект» активна после добавления страниц", ready);
    await page.screenshot({ path: path.join(SHOTS, "1440-camera-pages.png") });
    check("фото с компьютера: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 5. кнопка установки и смена ширины окна ----------
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const { ctx, page, errors } = await open(P(), { width: w, height: h });
    const before = await page.evaluate(() => { const b = document.querySelector("[data-install]"); return !!b && getComputedStyle(b).display !== "none"; });
    await page.evaluate(() => {
      window.__prompted = 0;
      const e = new Event("beforeinstallprompt", { cancelable: true });
      e.prompt = async () => (window.__prompted++, undefined);
      e.userChoice = Promise.resolve({ outcome: "accepted" });
      window.__bip = e;
      window.dispatchEvent(e);
    });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => { const b = document.querySelector("[data-install]"); return { shown: !!b && getComputedStyle(b).display !== "none", prevented: window.__bip.defaultPrevented }; });
    if (w >= 1024) {
      check("[1440] установка: без предложения браузера кнопки нет (ничего не имитируем)", !before);
      check("[1440] установка: браузер предложил — в панели «Установить приложение»", after.shown && after.prevented, after);
      await click(page, "[data-install]");
      const r = await page.evaluate(() => ({ n: window.__prompted, shown: getComputedStyle(document.querySelector("[data-install]")).display !== "none" }));
      check("[1440] установка: нажатие открывает окно установки браузера, кнопка скрывается", r.n === 1 && !r.shown, r);
      await page.setViewportSize({ width: 800, height: 900 });
      await page.waitForTimeout(500);
      const narrow = await layout(page);
      check("окно сузили до 800 px: панель снова внизу, как на телефоне", narrow.bar && narrow.bar.top + narrow.bar.h === 900 && !narrow.vertical, narrow.bar);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(500);
      const wide = await layout(page);
      check("окно снова 1440 px: боковая панель", wide.bar && wide.bar.left === 0 && wide.bar.h === 900 && wide.vertical, wide.bar);
    } else {
      check("[390] телефон: событие установки не перехватывается, кнопки нет (поведение браузера не меняется)", !after.shown && !after.prevented, after);
    }
    check(`[${w}] установка/размер окна: нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 6. PWA: устанавливаемость по оценке самого Chromium, работа без сети ----------
  {
    const { ctx, page, errors } = await open(P(), { width: 1440, height: 900 }, { sw: true });
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    await page.reload();
    await page.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(page);
    const inst = await cdp.send("Page.getInstallabilityErrors").catch((e) => ({ error: String(e) }));
    const mf = await cdp.send("Page.getAppManifest").catch((e) => ({ error: String(e) }));
    check("PWA: Chromium считает приложение устанавливаемым (ошибок установки нет)", inst.installabilityErrors && inst.installabilityErrors.length === 0, inst);
    check("PWA: manifest прочитан без ошибок", mf.errors && mf.errors.length === 0 && /Konspekt by NK/.test(mf.data || ""), mf.errors);
    const cache = await page.evaluate(async () => ({ keys: await caches.keys(), sw: !!navigator.serviceWorker.controller, build: [...document.scripts].map((s) => s.src).find((s) => s.includes("app.js")).split("?")[1] }));
    const sw = fs.readFileSync(path.join(ROOT, "service-worker.js"), "utf8").match(/VERSION = "([^"]+)"/)[1];
    check("PWA: service worker управляет страницей, один кэш текущей версии", cache.sw && cache.keys.length === 1 && cache.keys[0] === sw && cache.build === "v=" + sw.replace("konspekt-v", ""), cache);
    const cached = await page.evaluate(async (v) => (await (await caches.open(v)).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search), sw);
    check("PWA: desktop.css и manifest-иконки этой сборки в кэше (окно открывается без сети)", cached.some((u) => /desktop\.css\?v=/.test(u)), cached.filter((u) => /css/.test(u)));
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForTimeout(1500);
    const off = await layout(page);
    check("PWA: без интернета приложение открывается в той же раскладке для ПК", off.bar && off.bar.left === 0 && off.vertical && !!(await page.$(".scr-home")), off);
    await ctx.setOffline(false);
    check("PWA: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
