// v71: учебник «Физика. Инженеры будущего. 7 класс. Углублённый уровень. Часть 1» (В. В. Белага, Н. И. Воронцова,
// И. А. Ломаченков, Ю. А. Панебратцев; под ред. Ю. А. Панебратцева) — 47 готовых конспектов: введение, § 1–42, 4 итога глав.
// Сайт открывается локально, сеть заменена заглушкой tests/v61/stub-cloud.js (никаких запросов к Supabase).
//
// Запуск из корня репозитория:  node tests/v71/physics-7.test.js
//   PH7_CONTENT=<файл.json вне репозитория> — настоящие тексты { "physics-7-…": StudyContent } (их выгружают из
//   private.library_paragraphs; в git тексты не хранятся). Без него «сервер» отдаёт тестовый текст заглушки, и проверки
//   содержимого (формулы, разделы, вопросы) пропускаются — остаются проверки каталога, навигации и вёрстки.
//   SHOTS_DIR=<папка> — снимки экранов (по умолчанию во временной папке).
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const CONTENT = process.env.PH7_CONTENT ? JSON.parse(fs.readFileSync(process.env.PH7_CONTENT, "utf8")) : null;
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-v71-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8271;
const BOOK = "physics-7-engineers-1", P8 = "physics-8-engineers-1", PER = "physics-8-peryshkin";
const NOW = "2026-11-14T09:00:00+03:00";
const TRIAL = { status: "trial", kind: "trial", starts_at: "2026-11-10T00:00:00+03:00", ends_at: "2026-11-30T00:00:00+03:00", server_now: NOW, ai_quota: 10, ai_used: 0, ai_reserved: 0, ai_remaining: 10, ai_available: 10 };
const ENDED = { status: "expired", kind: "trial", starts_at: "2026-10-01T00:00:00+03:00", ends_at: "2026-10-21T00:00:00+03:00", server_now: NOW };

// оглавление учебника (фото владельца): названия параграфов по главам; Р — решение задач, Л — лабораторные работы
const CH = [
  ["Глава 1. Физика и мир, в котором мы живём", [
    "Что изучает физика", "Некоторые физические термины", "Получение новых знаний", "Физические величины. Единицы физической величины",
    "Измерение физических величин", "Пространство и время", "Измерения и точность измерения",
    "Измерение расстояний и размеров малых тел. Измерение времени", "Решение задач|Р", "Лабораторные и исследовательские работы|Л"]],
  ["Глава 2. Строение вещества", [
    "Строение вещества", "Молекулы и атомы", "Нанотехнологии и их применение", "Броуновское движение. Диффузия",
    "Использование диффузии для решения практических задач", "Взаимное притяжение и отталкивание молекул", "Агрегатные состояния вещества",
    "Решение задач|Р", "Лабораторные и исследовательские работы|Л"]],
  ["Глава 3. Движение, взаимодействие, масса", [
    "Механическое движение", "Скорость", "Относительность механического движения", "Средняя скорость. Ускорение", "Измерение скорости",
    "Решение задач|Р", "Инерция", "Взаимодействие тел и масса", "Плотность и масса", "Решение задач|Р", "Лабораторные и исследовательские работы|Л"]],
  ["Глава 4. Силы вокруг нас", [
    "Сила", "Сила тяжести", "Сила упругости", "Закон Гука. Динамометр", "Вес тела. Невесомость", "Равнодействующая сила", "Сила трения",
    "Трение в природе", "Трение в технике", "Величайшие изобретения: лук, колесо, добывание огня", "Решение задач|Р",
    "Лабораторные и исследовательские работы|Л"]],
];
const KIND = { Р: "Решение задач", Л: "Лабораторные работы" };
// ожидаемый список экрана учебника: [id, номер, название, глава, вид]
const EXPECT = [["physics-7-intro", "", "Введение. Зачем изучать физику", "", ""]];
let num = 0;
CH.forEach(([ch, pars], i) => {
  pars.forEach((x) => { const [t, k] = x.split("|"); num++; EXPECT.push(["physics-7-p" + num, String(num), t, ch, k ? KIND[k] : ""]); });
  EXPECT.push(["physics-7-chapter-" + (i + 1) + "-summary", "", "Подведём итоги", ch, ""]);
});
// формулы, которые обязательно есть на экране конспекта (проверяются при PH7_CONTENT; «_» показывается нижним индексом)
const MUST_F = { "physics-7-p21": "v = s / t", "physics-7-p28": "ρ = m / V", "physics-7-p32": "Fтяж = m · g", "physics-7-p34": "Fупр = k · x", "physics-7-p37": "Fтр = μ · N" };

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

function catalog() {
  const vm = require("vm");
  const ctx = vm.createContext({ console: { warn() {}, log() {} } });
  ctx.window = ctx;
  for (const f of ["js/study-content.js", "js/library.js", "js/library-index.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  return ctx.K.library;
}

(async () => {
  const lib = catalog();
  const ph = lib.book("physics", BOOK);
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch();

  async function open(v2, vp, extra = {}) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 1000, hasTouch: vp.width < 1000, deviceScaleFactor: 1, serviceWorkers: "block", locale: "ru-RU", colorScheme: extra.dark ? "dark" : "light" });
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
    await click(page, '[data-lib-grade="7"]');
    await click(page, '[data-lib-subject="physics"]');
  }

  // ---------- 1. каталог ----------
  check("каталог: в физике 7 класса один учебник — «Инженеры будущего», часть 1 (новый)", lib.books("physics", "7").map((b) => b.id).join() === BOOK, lib.books("physics", "7").map((b) => b.id));
  check("каталог: физика 8 класса не изменилась — те же два учебника (physics-8-engineers-1, physics-8-peryshkin), 51 и 62 материала",
    lib.books("physics", "8").map((b) => b.id).join() === P8 + "," + PER && lib.book("physics", P8).paragraphs.length === 51 && lib.book("physics", PER).paragraphs.length === 62, lib.books("physics", "8").map((b) => b.id));
  check("каталог: новый учебник — «Физика. Инженеры будущего. 7 класс. Углублённый уровень. Часть 1», Белага, Воронцова, Ломаченков, Панебратцев; под ред. Панебратцева, Просвещение, 2025, 2-е изд., 7 класс",
    ph && ph.title === "Физика. Инженеры будущего. 7 класс. Углублённый уровень. Часть 1" && ph.authors === "В. В. Белага, Н. И. Воронцова, И. А. Ломаченков, Ю. А. Панебратцев; под ред. Ю. А. Панебратцева" &&
      ph.publisher === "Просвещение" && ph.edition === "2025, 2-е изд., стереотипное" && ph.grade === "7", ph && { ...ph, paragraphs: ph.paragraphs.length });
  const rows = ph.paragraphs.map((p) => [p.id, p.number, p.title, p.chapter || "", p.kind || ""]);
  check("каталог: 47 материалов по оглавлению — введение, 4 главы (§ 1–42), «Подведём итоги» в конце каждой главы",
    JSON.stringify(rows) === JSON.stringify(EXPECT), rows.map((r, i) => JSON.stringify(r) === JSON.stringify(EXPECT[i]) ? "" : [r, EXPECT[i]]).filter(Boolean).slice(0, 3));
  const nums = ph.paragraphs.filter((p) => p.number).map((p) => Number(p.number));
  check("каталог: номера § 1–42 — ровно по одному разу, без пропусков и повторов", nums.length === 42 && nums.every((n, i) => n === i + 1), nums);
  check("каталог: «Решение задач» — § 9, 18, 25, 29, 41; лабораторные — § 10, 19, 30, 42 (с пометкой вида, как в учебнике 8 класса)",
    ph.paragraphs.filter((p) => p.kind === "Решение задач").map((p) => p.number).join() === "9,18,25,29,41" && ph.paragraphs.filter((p) => p.kind === "Лабораторные работы").map((p) => p.number).join() === "10,19,30,42");
  check("каталог: все 47 материалов готовы (ready), без текстов в публичном каталоге", ph.paragraphs.length === 47 && ph.paragraphs.every((p) => p.ready && !("content" in p)));
  const ids = lib.subjects().flatMap((s) => s.books.flatMap((b) => b.paragraphs.map((p) => p.id)));
  check("каталог: id не пересекаются ни с одним учебником (physics-7-… ≠ physics-8-…)", new Set(ids).size === ids.length && ph.paragraphs.every((p) => /^physics-7-[a-z0-9-]+$/.test(p.id)));
  check("каталог: всего готовых конспектов по истории и физике — 241 + 47 = 288", lib.readyCount({ subjectId: "history" }) + lib.readyCount({ subjectId: "physics" }) === 288);
  check("каталог: 7 класс в библиотеке — история (60) и физика (47)", lib.subjectsIn("7").map((s) => s.id).join() === "history,physics" && lib.readyCount({ gradeId: "7" }) === 107);
  check("каталог: история 7 класса не изменилась — history-7 (26) и history-rus-7 (34)", lib.books("history", "7").map((b) => b.id + ":" + b.paragraphs.length).join() === "history-7:26,history-rus-7:34");

  // ---------- 2. экраны на 320 / 390 / 768 ----------
  const GROUPS = CH.map(([ch, pars]) => ch + (pars.length + 1)).join("|");
  for (const [name, vp] of [["320", { width: 320, height: 640 }], ["390", { width: 390, height: 844 }], ["768", { width: 768, height: 1024 }]]) {
    const { ctx, page, errors } = await open(TRIAL, vp);
    await toPhysics(page);
    const books = await page.evaluate(() => [...document.querySelectorAll("[data-lib-book]")].map((b) => ({ id: b.dataset.libBook, text: b.textContent.replace(/\s+/g, " ") })));
    check(`[${name}] экран «Физика» 7 класса: один учебник — авторы, 47 конспектов и 4 главы`,
      books.length === 1 && books[0].id === BOOK && /В\. В\. Белага/.test(books[0].text) && /47 конспект/.test(books[0].text) && /4 глав/.test(books[0].text), books);
    check(`[${name}] экран «Физика»: без горизонтальной прокрутки`, !(await hscroll(page)));
    await page.screenshot({ path: path.join(SHOTS, `books-${name}.png`), fullPage: true });
    await click(page, `[data-lib-book="${BOOK}"]`);
    const list = await page.evaluate(() => ({
      groups: [...document.querySelectorAll(".lib-group-row")].map((g) => g.textContent.replace(/\s+/g, " ").trim().replace(/ (\d+)$/, "$1")),
      rows: [...document.querySelectorAll("[data-lib-paragraph]")].map((b) => [b.dataset.libParagraph, b.querySelector(".lib-par-num").textContent.replace(/ /g, " "), b.querySelector(".lib-par-title").firstChild.textContent, b.querySelector(".lib-par-kind")?.textContent || ""]),
      chips: [...document.querySelectorAll(".lib-book-hero .lib-chips span")].map((x) => x.textContent),
    }));
    check(`[${name}] список: 4 главы (11, 10, 12, 13 материалов с итогами), введение — сверху, итоги главы 4 — внизу`, list.groups.join("|") === GROUPS && list.rows[0][0] === "physics-7-intro" && list.rows[46][0] === "physics-7-chapter-4-summary", list.groups);
    check(`[${name}] список: 47 строк с номерами § и названиями из оглавления, пометки «Решение задач» / «Лабораторные работы»`,
      list.rows.length === 47 && list.rows.every((r, i) => r[0] === EXPECT[i][0] && r[2] === EXPECT[i][2] && r[3] === EXPECT[i][4] && (EXPECT[i][1] ? r[1] === "§ " + EXPECT[i][1] : r[1] === "")), list.rows.filter((r, i) => r[0] !== EXPECT[i][0] || r[2] !== EXPECT[i][2] || r[3] !== EXPECT[i][4]).slice(0, 3));
    check(`[${name}] шапка учебника: «47 конспектов», «4 главы», издание 2025, 2-е изд.`, list.chips.join("|") === "47 конспектов|4 главы|2025, 2-е изд., стереотипное", list.chips);
    check(`[${name}] список: без горизонтальной прокрутки`, !(await hscroll(page)));
    const out = await page.evaluate(() => [...document.querySelectorAll(".lib-book-hero .lib-chips span")].filter((x) => x.getBoundingClientRect().right > x.closest(".lib-book-hero").getBoundingClientRect().right + 0.5).map((x) => x.textContent));
    check(`[${name}] шапка учебника: подписи не выходят за карточку`, out.length === 0, out);
    await page.screenshot({ path: path.join(SHOTS, `book-${name}.png`) });
    // самое длинное название (§ 8), формулы (§ 34), лабораторные (§ 42) и итоги главы
    for (const id of ["physics-7-p8", "physics-7-p34", "physics-7-p42", "physics-7-chapter-4-summary"]) {
      await page.click(`[data-lib-paragraph="${id}"]`);
      await page.waitForSelector(".cn-doc", { timeout: 5000 }).catch(() => {});
      const r = await page.evaluate(() => ({ bar: document.querySelector(".lib-note-bar-t")?.textContent, doc: !!document.querySelector(".cn-doc"), back: !!document.querySelector("[data-back]") }));
      check(`[${name}] ${id} открылся (заголовок, «Назад»), без горизонтальной прокрутки`, r.doc && r.back && !!r.bar && !(await hscroll(page)), r);
      await page.screenshot({ path: path.join(SHOTS, `${id}-${name}.png`), fullPage: name === "390" && id.endsWith("p34") });
      await page.waitForTimeout(350);
      await click(page, "[data-back]");
      const back = await page.evaluate(() => document.querySelectorAll("[data-lib-paragraph]").length);
      check(`[${name}] «Назад» из ${id} → снова список учебника`, back === 47, back);
    }
    check(`[${name}] нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 3. все 47 открываются, запрос — к своему учебнику; содержимое ----------
  {
    const { ctx, page, errors } = await open(TRIAL, { width: 390, height: 844 });
    await toPhysics(page);
    await click(page, `[data-lib-book="${BOOK}"]`);
    const bad = [], thin = [], junk = [], scroll = [], formulas = [];
    for (const [id] of EXPECT) {
      await page.click(`[data-lib-paragraph="${id}"]`);
      await page.waitForFunction(() => document.querySelector(".cn-doc") || document.querySelector(".lib-error"), null, { timeout: 5000 }).catch(() => {});
      const r = await page.evaluate(() => ({
        call: (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")).pop(),
        text: (document.querySelector(".cn-doc")?.textContent || "").replace(/ /g, " "),
        tables: document.querySelectorAll(".cn-doc table").length,
        formulas: [...document.querySelectorAll(".cn-doc .formula")].map((f) => f.textContent),
        subs: document.querySelectorAll(".cn-doc sub").length,
        rawUnderscore: /[А-Яа-яA-Za-z]_[А-Яа-яA-Za-z]/.test(document.querySelector(".cn-doc")?.textContent || ""),
      }));
      if (r.call !== `libraryParagraph:physics/${BOOK}/${id}`) bad.push([id, r.call]);
      if (CONTENT) {
        const c = CONTENT[id];
        const plain = (x) => x.replace(/\*\*/g, "").replace(/\[(?:d|t|p|f):([^\]]+)\]/g, "$1").replace(/([0-9A-Za-zА-Яа-яЁё)])_(?=[0-9A-Za-zА-Яа-яЁё])/g, "$1");
        const miss = [c.meta.title, ...c.sections.map((s) => s.heading), plain(c.lead), plain(c.conclusion), ...c.selfCheck.map((x) => plain(x.q))].filter((x) => !r.text.includes(x));
        const nt = c.sections.reduce((a, s) => a + s.blocks.filter((b) => b.type === "TABLE").length, 0);
        const nf = c.sections.reduce((a, s) => a + s.blocks.filter((b) => b.type === "FORMULA").length, 0);
        if (miss.length || r.text.length < (/-p\d/.test(id) ? 4000 : 2500) || r.tables < nt) thin.push([id, r.text.length, r.tables, nt, miss.slice(0, 2)]);
        if (r.formulas.length < nf || (MUST_F[id] && !r.formulas.some((f) => f.includes(MUST_F[id])))) formulas.push([id, r.formulas, nf]);
        if (/[A-Za-zА-Яа-я]_[A-Za-zА-Яа-я0-9]/.test(JSON.stringify(c.sections).replace(/"type":"[A-Z_]+"/g, "")) && !r.subs) formulas.push([id, "нет нижних индексов"]);
        if (/undefined|NaN|\*\*|\[[dtpf]:/.test(r.text) || r.rawUnderscore) junk.push(id);
      } else if (!r.text.includes("ТЕСТОВЫЙ ТЕКСТ physics/" + BOOK + "/" + id)) thin.push([id, r.text.slice(0, 80)]);
      if (await hscroll(page)) scroll.push(id);
      await page.waitForTimeout(350);
      await page.click("[data-back]");
      await page.waitForSelector(`[data-lib-paragraph="${id}"]`, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    check("все 47: каждый материал запрашивает у сервера свой текст (physics / physics-7-engineers-1 / id)", bad.length === 0, bad);
    check(CONTENT ? "все 47: полный конспект на экране (название, все разделы, «Главное», вывод, все вопросы, таблицы)" : "все 47: показан текст, который вернул сервер для этого материала", thin.length === 0, thin);
    if (CONTENT) check("все 47: нет «undefined», «NaN», «**», нераскрытой разметки [d:…] и «_» вместо нижнего индекса", junk.length === 0, junk);
    if (CONTENT) check("все 47: все формулы показаны (v = s / t, ρ = m / V, F = mg, закон Гука, F = μN…), индексы (F тяж, v ср) — нижние", formulas.length === 0, formulas);
    check("все 47: без горизонтальной прокрутки (390 px)", scroll.length === 0, scroll);
    await page.evaluate(() => window.K.analytics?.flush?.(true));
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => [...new Set((window.__T.tracked || []).map((e) => e.paragraph_id || e.paragraphId || e.p).filter(Boolean))]);
    check("аналитика: просмотры отправлены с id нового учебника", seen.some((p) => /^physics-7-/.test(p)), seen.slice(0, 5));
    // экран конспекта устроен так же, как у прежних учебников библиотеки (панель «Назад», защита текста; поиска по тексту
    // в конспектах библиотеки нет и в прежних учебниках — поиск есть только в личных конспектах, v66)
    await click(page, '[data-lib-paragraph="physics-7-p21"]');
    await page.waitForSelector(".cn-doc", { timeout: 5000 }).catch(() => {});
    const shapeOf = () => page.evaluate(() => ({ bar: !!document.querySelector(".lib-note-bar-t"), back: !!document.querySelector("[data-back]"), search: !!document.querySelector("#inNoteSearch"), cls: document.querySelector(".cn-doc")?.className || "" }));
    const sNew = await shapeOf();
    await page.waitForTimeout(350);
    await click(page, "[data-back]");
    // прежний учебник физики 8 класса (та же серия) с тем же номером § 1: свой текст (назад к классам → 8 класс → физика)
    for (let i = 0; i < 3 && !(await page.$('[data-lib-grade="8"]')); i++) await click(page, "[data-back]");
    await click(page, '[data-lib-grade="8"]');
    await click(page, '[data-lib-subject="physics"]');
    await click(page, `[data-lib-book="${P8}"]`);
    await click(page, '[data-lib-paragraph="physics-8-p1"]');
    await page.waitForTimeout(400);
    const old = await page.evaluate(() => (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")).pop());
    const sOld = await shapeOf();
    check("экран конспекта нового учебника = экран прежнего (панель, «Назад», защита текста, без поиска — как раньше)", JSON.stringify(sNew) === JSON.stringify(sOld) && sNew.bar && sNew.back, [sNew, sOld]);
    check("нет конфликта: § 1 учебника физики 8 класса запрашивает physics-8-engineers-1/physics-8-p1", old === `libraryParagraph:physics/${P8}/physics-8-p1`, old);
    check("все 47: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 4. доступ: срок закончился — текст не показывается и не запрашивается ----------
  {
    const { ctx, page, errors } = await open(ENDED, { width: 390, height: 844 });
    await page.waitForTimeout(400);
    if (await page.$('[data-go="library"]')) {
      await toPhysics(page);
      if (await page.$(`[data-lib-book="${BOOK}"]`)) {
        await click(page, `[data-lib-book="${BOOK}"]`);
        if (await page.$('[data-lib-paragraph="physics-7-p1"]')) await click(page, '[data-lib-paragraph="physics-7-p1"]');
      }
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
    await click(page, '[data-lib-paragraph="physics-7-p37"]');
    await page.waitForTimeout(400);
    check("тёмная тема системы: § 37 (формулы) открывается, без горизонтальной прокрутки и ошибок JS", !!(await page.$(".cn-doc")) && !(await hscroll(page)) && errors.length === 0, errors);
    await page.screenshot({ path: path.join(SHOTS, "p37-390-dark-system.png") });
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL` + (CONTENT ? "" : " (без PH7_CONTENT: содержимое конспектов не проверялось)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
