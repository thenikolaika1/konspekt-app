// v64: учебник «Физика. 8 класс. Базовый уровень» (Перышкин, Иванов) — 62 готовых конспекта.
// Сайт открывается локально, сеть заменена заглушкой tests/v61/stub-cloud.js (никаких запросов к Supabase).
//
// Запуск из корня репозитория:  node tests/v64/peryshkin.test.js
//   PER8_CONTENT=<файл.json вне репозитория> — настоящие тексты конспектов { "physics-8-per-pN": StudyContent } (их
//   выгружают из private.library_paragraphs). Без него «сервер» отдаёт тестовый текст заглушки, и проверки
//   содержимого (разделы, формулы, «Проверь себя») пропускаются — остаются проверки каталога, навигации и вёрстки.
//   SHOTS_DIR=<папка> — снимки экранов (по умолчанию во временной папке).
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const CONTENT = process.env.PER8_CONTENT ? JSON.parse(fs.readFileSync(process.env.PER8_CONTENT, "utf8")) : null;
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-v64-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8264;
const BOOK = "physics-8-peryshkin", OLD = "physics-8-engineers-1";
const NOW = "2026-11-07T09:00:00+03:00";
const TRIAL = { status: "trial", kind: "trial", starts_at: "2026-11-01T00:00:00+03:00", ends_at: "2026-11-21T00:00:00+03:00", server_now: NOW, ai_quota: 10, ai_used: 0, ai_reserved: 0, ai_remaining: 10, ai_available: 10 };
const ENDED = { status: "expired", kind: "trial", starts_at: "2026-10-01T00:00:00+03:00", ends_at: "2026-10-21T00:00:00+03:00", server_now: NOW };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".webmanifest": "application/manifest+json" };
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

// каталог — тем же кодом, что в приложении
function catalog() {
  const vm = require("vm");
  const ctx = vm.createContext({ console: { warn() {}, log() {} } });
  ctx.window = ctx;
  for (const f of ["js/study-content.js", "js/library.js", "js/library-index.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  return ctx.K.library;
}

(async () => {
  const lib = catalog();
  const per = lib.book("physics", BOOK);
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch();

  async function open(v2, vp, extra = {}) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 1000, hasTouch: vp.width < 1000, deviceScaleFactor: 1, serviceWorkers: "block", locale: "ru-RU", colorScheme: extra.dark ? "dark" : "light" });
    // заглушка облака; при PER8_CONTENT «сервер» отдаёт настоящие тексты нового учебника (доступ решает по T.v2, как в stub)
    const stub = STUB + (CONTENT ? `
;(() => { const C = ${JSON.stringify(CONTENT)}; const orig = window.K.cloud.libraryParagraph;
  window.K.cloud.libraryParagraph = async (s, b, p) => { const r = await orig(s, b, p); return b === "${BOOK}" && C[p] ? JSON.parse(JSON.stringify(C[p])) : r; }; })();` : "");
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
    await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify({ kind: "user", uid: "u-1", v2 }));
    await page.goto("http://127.0.0.1:" + PORT + "/");
    await page.waitForTimeout(1500);
    for (let i = 0; i < 4; i++) {
      const b = await page.$(".welcome:not(.access) .primary");
      if (!b) break;
      await b.click();
      await page.waitForTimeout(300);
    }
    return { ctx, page, errors };
  }
  const click = async (page, sel) => { await page.click(sel); await page.waitForTimeout(250); };
  const hscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1);
  async function toPhysics(page) {
    await click(page, '[data-go="library"]');
    await click(page, '[data-lib-grade="8"]');
    await click(page, '[data-lib-subject="physics"]');
  }

  // ---------- 1. каталог ----------
  check("каталог: в физике 8 класса два учебника — «Инженеры будущего» и Перышкин, Иванов",
    lib.books("physics", "8").map((b) => b.id).join() === OLD + "," + BOOK, lib.books("physics", "8").map((b) => b.id));
  check("каталог: новый учебник — «Физика. 8 класс. Базовый уровень», Перышкин, Иванов, Просвещение, 2024, 4-е изд.",
    per.title === "Физика. 8 класс. Базовый уровень" && per.authors === "И. М. Перышкин, А. И. Иванов" && per.publisher === "Просвещение" && per.edition === "2024, 4-е изд., стереотипное", per);
  check("каталог: ровно 62 параграфа, § 1–62 по порядку, все готовы", per.paragraphs.length === 62 && per.paragraphs.every((p, i) => p.number === String(i + 1) && p.ready));
  const byCh = {};
  per.paragraphs.forEach((p) => (byCh[p.chapter] = (byCh[p.chapter] || 0) + 1));
  check("каталог: главы 1–3 — 26 / 23 / 13 параграфов",
    JSON.stringify(byCh) === JSON.stringify({ "Глава 1. Тепловые явления": 26, "Глава 2. Электрические явления": 23, "Глава 3. Электромагнитные явления": 13 }), byCh);
  const ids = lib.subjects().flatMap((s) => s.books.flatMap((b) => b.paragraphs.map((p) => p.id)));
  check("каталог: id параграфов не пересекаются с «Инженерами будущего» (physics-8-per-pN ≠ physics-8-pN)", new Set(ids).size === ids.length && per.paragraphs.every((p) => /^physics-8-per-p\d+$/.test(p.id)));
  check("каталог: прежний учебник — 51 материал, id physics-8-p1… как раньше", lib.book("physics", OLD).paragraphs.length === 51 && lib.paragraph("physics", OLD, "physics-8-p1")?.title === "Основы молекулярно-кинетической теории");

  // ---------- 2. экраны на 320 / 390 / 768 ----------
  for (const [name, vp] of [["320", { width: 320, height: 640 }], ["390", { width: 390, height: 844 }], ["768", { width: 768, height: 1024 }]]) {
    const { ctx, page, errors } = await open(TRIAL, vp);
    await toPhysics(page);
    const books = await page.evaluate(() => [...document.querySelectorAll("[data-lib-book]")].map((b) => ({ id: b.dataset.libBook, text: b.textContent.replace(/\s+/g, " ") })));
    check(`[${name}] экран «Физика»: два учебника, у нового — авторы и профили «Математический», «Общеобразовательный»`,
      books.length === 2 && books[0].id === OLD && books[1].id === BOOK && /И\. М\. Перышкин, А\. И\. Иванов/.test(books[1].text) && /Математический/.test(books[1].text) && /Общеобразовательный/.test(books[1].text) && /62 конспект/.test(books[1].text), books);
    check(`[${name}] экран «Физика»: без горизонтальной прокрутки`, !(await hscroll(page)));
    await page.screenshot({ path: path.join(SHOTS, `books-${name}.png`), fullPage: true });
    await click(page, `[data-lib-book="${BOOK}"]`);
    const list = await page.evaluate(() => ({
      groups: [...document.querySelectorAll(".lib-group-row")].map((g) => g.textContent.replace(/\s+/g, " ").trim()),
      rows: [...document.querySelectorAll("[data-lib-paragraph]")].map((b) => [b.dataset.libParagraph, b.querySelector(".lib-par-num").textContent.replace(/ /g, " "), b.querySelector(".lib-par-title").textContent]),
    }));
    check(`[${name}] список: 3 главы (26, 23, 13) и 62 строки с номерами § 1–62 и названиями из оглавления`,
      list.groups.join("|") === "Глава 1. Тепловые явления26|Глава 2. Электрические явления23|Глава 3. Электромагнитные явления13" &&
        list.rows.length === 62 && list.rows.every((r, i) => r[0] === per.paragraphs[i].id && r[1] === "§ " + (i + 1) && r[2] === per.paragraphs[i].title), list.groups);
    check(`[${name}] список: без горизонтальной прокрутки`, !(await hscroll(page)));
    const chips = await page.evaluate(() => [...document.querySelectorAll(".lib-book-hero .lib-chips span")].filter((x) => x.getBoundingClientRect().right > x.closest(".lib-book-hero").getBoundingClientRect().right + 0.5).map((x) => x.textContent));
    check(`[${name}] шапка учебника: подписи (издание, профили) не выходят за карточку`, chips.length === 0, chips);
    await page.screenshot({ path: path.join(SHOTS, `book-${name}.png`) });
    // длинное название и формулы — § 19 и § 46
    for (const n of [19, 46]) {
      await click(page, `[data-lib-paragraph="physics-8-per-p${n}"]`);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ bar: document.querySelector(".lib-note-bar-t")?.textContent, doc: !!document.querySelector(".cn-doc"), back: !!document.querySelector("[data-back]") }));
      check(`[${name}] § ${n} открылся (заголовок, кнопка «Назад»), без горизонтальной прокрутки`, r.doc && r.back && /§\s?\d+/.test(r.bar || "") && !(await hscroll(page)), r);
      await page.screenshot({ path: path.join(SHOTS, `p${n}-${name}.png`), fullPage: n === 46 && name === "390" });
      await click(page, "[data-back]");
      const back = await page.evaluate(() => document.querySelectorAll("[data-lib-paragraph]").length);
      check(`[${name}] «Назад» из § ${n} → снова список учебника`, back === 62, back);
    }
    check(`[${name}] нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 3. все 62 параграфа открываются, запрос — к своему учебнику ----------
  {
    const { ctx, page, errors } = await open(TRIAL, { width: 390, height: 844 });
    await toPhysics(page);
    await click(page, `[data-lib-book="${BOOK}"]`);
    const bad = [], thin = [], fx = [], scroll = [];
    for (let n = 1; n <= 62; n++) {
      const id = "physics-8-per-p" + n;
      await page.click(`[data-lib-paragraph="${id}"]`);
      await page.waitForFunction(() => document.querySelector(".cn-doc") || document.querySelector(".lib-error"), null, { timeout: 5000 }).catch(() => {});
      const r = await page.evaluate(() => ({
        call: (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")).pop(),
        text: (document.querySelector(".cn-doc")?.textContent || "").replace(/\u00a0/g, " "),
        formulas: document.querySelectorAll(".cn-doc .formula").length,
        sections: document.querySelectorAll(".cn-doc h2, .cn-doc h3").length,
      }));
      if (r.call !== `libraryParagraph:physics/${BOOK}/${id}`) bad.push([n, r.call]);
      if (CONTENT) {
        const c = CONTENT[id];
        // блоки «Формула» в тексте + справочник «Формулы» (сворачиваемый) с главными формулами параграфа
        const nf = c.sections.reduce((a, s) => a + s.blocks.filter((b) => b.type === "FORMULA").length, 0) + c.glossary.formulas.length;
        const plain = (x) => x.replace(/\*\*/g, "").replace(/([0-9A-Za-zА-Яа-яЁёΑ-Ωα-ω'′)])_(?=[0-9A-Za-zА-Яа-яЁё])/g, "$1"); // A_п показывается как A<sub>п</sub>
        const miss = [c.meta.title, ...c.sections.map((s) => s.heading), plain(c.lead), plain(c.conclusion), ...c.selfCheck.map((x) => plain(x.q))].filter((x) => !r.text.includes(x));
        if (miss.length || r.text.length < 3000) thin.push([n, r.text.length, miss.slice(0, 2)]);
        if (r.formulas !== nf || /undefined|NaN|\*\*/.test(r.text)) fx.push([n, r.formulas, nf]);
      } else if (!r.text.includes("ТЕСТОВЫЙ ТЕКСТ physics/" + BOOK + "/" + id)) thin.push([n, r.text.slice(0, 80)]);
      if (await hscroll(page)) scroll.push(n);
      await page.waitForTimeout(350); // как человек: экран успел открыться (переходы чаще ~0,3 с не принимаются)
      await page.click("[data-back]");
      await page.waitForSelector(`[data-lib-paragraph="${id}"]`, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250); // защита от двойного нажатия в приложении — 200 мс
    }
    check("все 62: каждый параграф запрашивает у сервера свой текст (physics / physics-8-peryshkin / physics-8-per-pN)", bad.length === 0, bad);
    check(CONTENT ? "все 62: полный конспект на экране (название, все разделы, введение, вывод, все вопросы «Проверь себя», > 3000 знаков)" : "все 62: показан текст, который вернул сервер для этого параграфа", thin.length === 0, thin);
    if (CONTENT) check("все 62: формулы — все блоки «Формула» и справочник формул на месте; нет «undefined», «NaN», «**»", fx.length === 0, fx);
    check("все 62: без горизонтальной прокрутки (390 px)", scroll.length === 0, scroll);
    // аналитика: просмотры идут с id нового учебника
    await page.evaluate(() => window.K.analytics?.flush?.(true));
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => [...new Set((window.__T.tracked || []).map((e) => e.paragraph_id || e.paragraphId || e.p).filter(Boolean))]);
    check("аналитика: просмотры параграфов отправлены с id нового учебника", seen.some((p) => /^physics-8-per-p\d+$/.test(p)), seen.slice(0, 5));
    // § 1 «Инженеров будущего» — свой текст, не Перышкин
    await click(page, "[data-back]");
    await click(page, `[data-lib-book="${OLD}"]`);
    await click(page, '[data-lib-paragraph="physics-8-p1"]');
    await page.waitForTimeout(400);
    const old = await page.evaluate(() => (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")).pop());
    check("нет конфликта: § 1 «Инженеров будущего» запрашивает physics-8-engineers-1/physics-8-p1", old === `libraryParagraph:physics/${OLD}/physics-8-p1`, old);
    check("все 62: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 4. доступ: без пробного периода и Premium текст не запрашивается ----------
  {
    const { ctx, page, errors } = await open(ENDED, { width: 390, height: 844 });
    await page.waitForTimeout(400);
    const lib8 = await page.$('[data-go="library"]');
    if (lib8) {
      await toPhysics(page);
      await click(page, `[data-lib-book="${BOOK}"]`);
      await click(page, '[data-lib-paragraph="physics-8-per-p1"]');
      await page.waitForTimeout(500);
    }
    const r = await page.evaluate(() => ({ calls: (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")), doc: !!document.querySelector(".cn-doc") }));
    check("доступ: срок закончился — конспект нового учебника не показывается и не запрашивается", r.calls.length === 0 && !r.doc, r);
    check("доступ: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 5. системная тёмная тема телефона ----------
  {
    const { ctx, page, errors } = await open(TRIAL, { width: 390, height: 844 }, { dark: true });
    await toPhysics(page);
    await click(page, `[data-lib-book="${BOOK}"]`);
    await click(page, '[data-lib-paragraph="physics-8-per-p12"]');
    await page.waitForTimeout(400);
    check("тёмная тема системы: § 12 открывается, без горизонтальной прокрутки и ошибок JS", !!(await page.$(".cn-doc")) && !(await hscroll(page)) && errors.length === 0, errors);
    await page.screenshot({ path: path.join(SHOTS, "p12-390-dark-system.png") });
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL` + (CONTENT ? "" : " (без PER8_CONTENT: содержимое конспектов не проверялось)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
