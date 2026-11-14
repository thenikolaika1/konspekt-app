// v68: учебник «История. История России. XVIII — начало XIX в. 8 класс» (В. Р. Мединский, А. В. Торкунов) — 42 готовых конспекта:
// введение, 35 карточек параграфов (§ 1–54, сдвоенные параграфы — одной карточкой), 5 итогов глав, заключение.
// Сайт открывается локально, сеть заменена заглушкой tests/v61/stub-cloud.js (никаких запросов к Supabase).
//
// Запуск из корня репозитория:  node tests/v68/history-russia.test.js
//   HR8_CONTENT=<файл.json вне репозитория> — настоящие тексты { "history-rus-8-…": StudyContent } (их выгружают из
//   private.library_paragraphs; в git тексты не хранятся). Без него «сервер» отдаёт тестовый текст заглушки, и проверки
//   содержимого (разделы, вопросы, даты, поиск по тексту) пропускаются — остаются проверки каталога, навигации и вёрстки.
//   SHOTS_DIR=<папка> — снимки экранов (по умолчанию во временной папке).
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const CONTENT = process.env.HR8_CONTENT ? JSON.parse(fs.readFileSync(process.env.HR8_CONTENT, "utf8")) : null;
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-v68-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8268;
const BOOK = "history-rus-8", OLD = "history-8";
const NOW = "2026-11-14T09:00:00+03:00";
const TRIAL = { status: "trial", kind: "trial", starts_at: "2026-11-10T00:00:00+03:00", ends_at: "2026-11-30T00:00:00+03:00", server_now: NOW, ai_quota: 10, ai_used: 0, ai_reserved: 0, ai_remaining: 10, ai_available: 10 };
const ENDED = { status: "expired", kind: "trial", starts_at: "2026-10-01T00:00:00+03:00", ends_at: "2026-10-21T00:00:00+03:00", server_now: NOW };

// оглавление учебника (фото владельца): номера и названия параграфов по главам
const CH = [
  ["Глава I. Рождение Российской империи", [
    ["1–2", "Борьба за власть в конце XVII в."], ["3", "Пётр I: становление реформатора"], ["4", "Начало Петровских преобразований"],
    ["5–6", "Северная война: от Нарвы до Полтавы"], ["7–8", "Северная война: «Полтавская виктория»"], ["9", "Северная война: от Полтавы до Ништадтского мира"],
    ["10", "Трансформация власти: реформы государственного управления"], ["11–12", "Модернизация по-петровски. Церковная, военная и социально-экономические реформы"],
    ["13", "Народные выступления"], ["14", "Общество и государство в период реформ"], ["15–16", "Петербург в первой четверти XVIII в."], ["17–18", "Преображённая Россия: итоги реформ"]]],
  ["Глава II. Россия после Петра I. Дворцовые перевороты (1725–1762)", [
    ["19–20", "Эпоха дворцовых переворотов: от Екатерины I до Анны Иоанновны"], ["21–22", "Правление Елизаветы Петровны и Петра III"]]],
  ["Глава III. Россия в 1760–1790-х гг. Правление Екатерины II и Павла I", [
    ["23–24", "«Законная монархия» Екатерины II"], ["25–26", "Кто и как присоединялся к России"], ["27–28", "Экономика России во второй половине XVIII в.: хозяйство империи"],
    ["29–30", "Общество века реформ: «благородные» и «подлые»"], ["31–32", "Социальный протест"], ["33–34", "Внешняя политика Екатерины II: южное и восточное направления"],
    ["35–36", "Начало освоения Новороссии и Крыма"], ["37", "Внешняя политика Екатерины II: западное направление"], ["38", "«Непросвещённый абсолютизм»: внутренняя политика Павла I"],
    ["39", "Внешняя политика Павла I"], ["40", "«Государство при армии»: жизнь и служба в императорских войсках в XVIII в."]]],
  ["Глава IV. Культурное пространство Российской империи в XVIII в.", [
    ["41–42", "Публицистика, литература, театр"], ["43", "Развитие образования"], ["44", "Развитие науки и техники"], ["45", "Архитектура и искусство"]]],
  ["Глава V. Политика правительства Александра I", [
    ["46", "Первые мероприятия нового императора"], ["47–48", "Внешняя политика России в 1801–1811 гг."], ["49–50", "«Недаром помнит вся Россия…»: Отечественная война 1812 года"],
    ["51", "Заграничные походы русской армии. Венский конгресс"], ["52", "Либеральные и консервативные тенденции в политике Александра I в 1815–1825 гг."],
    ["53–54", "Общественное движение в первой четверти XIX в. Восстание декабристов"]]],
];
const ROMAN = ["I", "II", "III", "IV", "V"];
// ожидаемый список экрана учебника: [id, номер, название, глава]
const EXPECT = [[BOOK + "-intro", "", "Введение. Россия в XVIII — начале XIX в.", ""]];
CH.forEach(([ch, pars], i) => {
  pars.forEach(([n, t]) => EXPECT.push([BOOK + "-p" + n.replace("–", "-"), n, t, ch]));
  EXPECT.push([BOOK + "-chapter-" + (i + 1) + "-summary", "", "Итоги главы " + ROMAN[i] + ". Главное по главе", ch]);
});
EXPECT.push([BOOK + "-conclusion", "", "Заключение. Россия от царства к империи", ""]);

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
  const hr = lib.book("history", BOOK);
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
  async function toHistory(page) {
    await click(page, '[data-go="library"]');
    await click(page, '[data-lib-grade="8"]');
    await click(page, '[data-lib-subject="history"]');
  }

  // ---------- 1. каталог ----------
  check("каталог: в истории 8 класса два учебника — Мединский, Чубарьян (прежний) и Мединский, Торкунов (новый)",
    lib.books("history", "8").map((b) => b.id).join() === OLD + "," + BOOK, lib.books("history", "8").map((b) => b.id));
  check("каталог: новый учебник — «История России. XVIII — начало XIX в.», В. Р. Мединский, А. В. Торкунов, Просвещение, 2026, 2-е изд.",
    hr && hr.title === "История России. XVIII — начало XIX в." && hr.authors === "В. Р. Мединский, А. В. Торкунов" && hr.publisher === "Просвещение" &&
      hr.edition === "2026, 2-е изд., обновлённое" && hr.grade === "8", hr && { ...hr, paragraphs: hr.paragraphs.length });
  const rows = hr.paragraphs.map((p) => [p.id, p.number, p.title, p.chapter || ""]);
  check("каталог: 42 материала по оглавлению — введение, 5 глав (§ 1–54, сдвоенные параграфы одной карточкой), итоги каждой главы, заключение",
    JSON.stringify(rows) === JSON.stringify(EXPECT), rows.map((r, i) => JSON.stringify(r) === JSON.stringify(EXPECT[i]) ? "" : [r, EXPECT[i]]).filter(Boolean).slice(0, 3));
  const nums = hr.paragraphs.filter((p) => p.number).flatMap((p) => { const [a, b] = p.number.split("–").map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; });
  check("каталог: номера § 1–54 покрыты ровно по одному разу, без пропусков и повторов", nums.length === 54 && nums.every((n, i) => n === i + 1), nums);
  check("каталог: все 42 материала готовы (ready), без текстов в публичном каталоге", hr.paragraphs.every((p) => p.ready && !("content" in p)));
  const ids = lib.subjects().flatMap((s) => s.books.flatMap((b) => b.paragraphs.map((p) => p.id)));
  check("каталог: id не пересекаются ни с одним учебником (history-rus-8-… ≠ history-8-…)", new Set(ids).size === ids.length && hr.paragraphs.every((p) => /^history-rus-8-[a-z0-9-]+$/.test(p.id)));
  const titles = hr.paragraphs.map((p) => p.title);
  check("каталог: названий-дублей нет", new Set(titles).size === titles.length);
  check("каталог: прежний учебник истории — 26 материалов, как раньше", lib.book("history", OLD).paragraphs.length === 26 && lib.paragraph("history", OLD, "history-8-p2")?.title === "Эпоха Просвещения");
  check("каталог: всего готовых конспектов по истории и физике — 181 (139 + 42)", lib.readyCount({ subjectId: "history" }) + lib.readyCount({ subjectId: "physics" }) === 181);

  // ---------- 2. экраны на 320 / 390 / 768 ----------
  const GROUPS = CH.map(([ch, pars]) => ch + (pars.length + 1)).join("|");
  for (const [name, vp] of [["320", { width: 320, height: 640 }], ["390", { width: 390, height: 844 }], ["768", { width: 768, height: 1024 }]]) {
    const { ctx, page, errors } = await open(TRIAL, vp);
    await toHistory(page);
    const books = await page.evaluate(() => [...document.querySelectorAll("[data-lib-book]")].map((b) => ({ id: b.dataset.libBook, text: b.textContent.replace(/\s+/g, " ") })));
    check(`[${name}] экран «История»: два учебника, у нового — авторы, 42 конспекта и 5 глав`,
      books.length === 2 && books[0].id === OLD && books[1].id === BOOK && /В\. Р\. Мединский, А\. В\. Торкунов/.test(books[1].text) && /42 конспект/.test(books[1].text) && /5 глав/.test(books[1].text) && /26 конспект/.test(books[0].text), books);
    check(`[${name}] экран «История»: без горизонтальной прокрутки`, !(await hscroll(page)));
    await page.screenshot({ path: path.join(SHOTS, `books-${name}.png`), fullPage: true });
    await click(page, `[data-lib-book="${BOOK}"]`);
    const list = await page.evaluate(() => ({
      groups: [...document.querySelectorAll(".lib-group-row")].map((g) => g.textContent.replace(/\s+/g, " ").trim().replace(/ (\d+)$/, "$1")),
      rows: [...document.querySelectorAll("[data-lib-paragraph]")].map((b) => [b.dataset.libParagraph, b.querySelector(".lib-par-num").textContent.replace(/ /g, " "), b.querySelector(".lib-par-title").textContent]),
      chips: [...document.querySelectorAll(".lib-book-hero .lib-chips span")].map((x) => x.textContent),
    }));
    check(`[${name}] список: 5 глав (13, 3, 12, 5, 7 материалов с итогами), введение — сверху, заключение — внизу`, list.groups.join("|") === GROUPS && list.rows[0][0] === BOOK + "-intro" && list.rows[41][0] === BOOK + "-conclusion", list.groups);
    check(`[${name}] список: 42 строки с номерами § и названиями из оглавления, итоги и введение — со значком`,
      list.rows.length === 42 && list.rows.every((r, i) => r[0] === EXPECT[i][0] && r[2] === EXPECT[i][2] && (EXPECT[i][1] ? r[1] === "§ " + EXPECT[i][1] : r[1] === "")), list.rows.filter((r, i) => r[0] !== EXPECT[i][0] || r[2] !== EXPECT[i][2]).slice(0, 3));
    check(`[${name}] шапка учебника: «42 конспекта», «5 глав», издание`, list.chips.join("|") === "42 конспекта|5 глав|2026, 2-е изд., обновлённое", list.chips);
    check(`[${name}] список: без горизонтальной прокрутки`, !(await hscroll(page)));
    const out = await page.evaluate(() => [...document.querySelectorAll(".lib-book-hero .lib-chips span")].filter((x) => x.getBoundingClientRect().right > x.closest(".lib-book-hero").getBoundingClientRect().right + 0.5).map((x) => x.textContent));
    check(`[${name}] шапка учебника: подписи не выходят за карточку`, out.length === 0, out);
    await page.screenshot({ path: path.join(SHOTS, `book-${name}.png`) });
    // самое длинное название (§ 52), сдвоенный § 49–50 и итоги главы
    for (const id of [BOOK + "-p52", BOOK + "-p49-50", BOOK + "-chapter-3-summary"]) {
      await page.click(`[data-lib-paragraph="${id}"]`);
      await page.waitForSelector(".cn-doc", { timeout: 5000 }).catch(() => {});
      const r = await page.evaluate(() => ({ bar: document.querySelector(".lib-note-bar-t")?.textContent, doc: !!document.querySelector(".cn-doc"), back: !!document.querySelector("[data-back]") }));
      check(`[${name}] ${id} открылся (заголовок, «Назад»), без горизонтальной прокрутки`, r.doc && r.back && !!r.bar && !(await hscroll(page)), r);
      await page.screenshot({ path: path.join(SHOTS, `${id}-${name}.png`), fullPage: name === "390" && id.endsWith("p49-50") });
      await page.waitForTimeout(350);
      await click(page, "[data-back]");
      const back = await page.evaluate(() => document.querySelectorAll("[data-lib-paragraph]").length);
      check(`[${name}] «Назад» из ${id} → снова список учебника`, back === 42, back);
    }
    check(`[${name}] нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 3. все 42 открываются, запрос — к своему учебнику; содержимое ----------
  {
    const { ctx, page, errors } = await open(TRIAL, { width: 390, height: 844 });
    await toHistory(page);
    await click(page, `[data-lib-book="${BOOK}"]`);
    const bad = [], thin = [], junk = [], scroll = [];
    for (const [id] of EXPECT) {
      await page.click(`[data-lib-paragraph="${id}"]`);
      await page.waitForFunction(() => document.querySelector(".cn-doc") || document.querySelector(".lib-error"), null, { timeout: 5000 }).catch(() => {});
      const r = await page.evaluate(() => ({
        call: (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")).pop(),
        text: (document.querySelector(".cn-doc")?.textContent || "").replace(/ /g, " "),
        tables: document.querySelectorAll(".cn-doc table").length,
        dates: document.querySelectorAll(".cn-doc .kw-date").length,
      }));
      if (r.call !== `libraryParagraph:history/${BOOK}/${id}`) bad.push([id, r.call]);
      if (CONTENT) {
        const c = CONTENT[id];
        const plain = (x) => x.replace(/\*\*/g, "").replace(/\[(?:d|t|p|f):([^\]]+)\]/g, "$1");
        const miss = [c.meta.title, ...c.sections.map((s) => s.heading), plain(c.lead), plain(c.conclusion), ...c.selfCheck.map((x) => plain(x.q))].filter((x) => !r.text.includes(x));
        const nt = c.sections.reduce((a, s) => a + s.blocks.filter((b) => b.type === "TABLE").length, 0);
        if (miss.length || r.text.length < (/-p\d/.test(id) ? 4000 : 1500) || r.tables < nt) thin.push([id, r.text.length, r.tables, nt, miss.slice(0, 2)]);
        if (/undefined|NaN|\*\*|\[[dtpf]:/.test(r.text)) junk.push(id);
      } else if (!r.text.includes("ТЕСТОВЫЙ ТЕКСТ history/" + BOOK + "/" + id)) thin.push([id, r.text.slice(0, 80)]);
      if (await hscroll(page)) scroll.push(id);
      await page.waitForTimeout(350);
      await page.click("[data-back]");
      await page.waitForSelector(`[data-lib-paragraph="${id}"]`, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    check("все 42: каждый материал запрашивает у сервера свой текст (history / history-rus-8 / id)", bad.length === 0, bad);
    check(CONTENT ? "все 42: полный конспект на экране (название, все разделы, «Главное», вывод, все вопросы, таблицы)" : "все 42: показан текст, который вернул сервер для этого материала", thin.length === 0, thin);
    if (CONTENT) check("все 42: нет «undefined», «NaN», «**», нераскрытой разметки [d:…]", junk.length === 0, junk);
    check("все 42: без горизонтальной прокрутки (390 px)", scroll.length === 0, scroll);
    await page.evaluate(() => window.K.analytics?.flush?.(true));
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => [...new Set((window.__T.tracked || []).map((e) => e.paragraph_id || e.paragraphId || e.p).filter(Boolean))]);
    check("аналитика: просмотры отправлены с id нового учебника", seen.some((p) => /^history-rus-8-/.test(p)), seen.slice(0, 5));
    // экран конспекта устроен так же, как у прежних учебников библиотеки (панель «Назад», защита текста; поиска по тексту
    // в конспектах библиотеки нет и в прежних учебниках — поиск есть только в личных конспектах, v66)
    await click(page, `[data-lib-paragraph="${BOOK}-p7-8"]`);
    await page.waitForSelector(".cn-doc", { timeout: 5000 }).catch(() => {});
    const shapeOf = () => page.evaluate(() => ({ bar: !!document.querySelector(".lib-note-bar-t"), back: !!document.querySelector("[data-back]"), search: !!document.querySelector("#inNoteSearch"), cls: document.querySelector(".cn-doc")?.className || "" }));
    const sNew = await shapeOf();
    await page.waitForTimeout(350);
    await click(page, "[data-back]");
    // прежний учебник: свой текст
    await click(page, "[data-back]");
    await click(page, `[data-lib-book="${OLD}"]`);
    await click(page, '[data-lib-paragraph="history-8-p2"]');
    await page.waitForTimeout(400);
    const old = await page.evaluate(() => (window.__T.calls || []).filter((c) => c.startsWith("libraryParagraph:")).pop());
    const sOld = await shapeOf();
    check("экран конспекта нового учебника = экран прежнего (панель, «Назад», защита текста, без поиска — как раньше)", JSON.stringify(sNew) === JSON.stringify(sOld) && sNew.bar && sNew.back, [sNew, sOld]);
    check("нет конфликта: § 2 прежнего учебника запрашивает history-8/history-8-p2", old === `libraryParagraph:history/${OLD}/history-8-p2`, old);
    check("все 42: нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 4. доступ: срок закончился — текст не показывается и не запрашивается ----------
  {
    const { ctx, page, errors } = await open(ENDED, { width: 390, height: 844 });
    await page.waitForTimeout(400);
    if (await page.$('[data-go="library"]')) {
      await toHistory(page);
      if (await page.$(`[data-lib-book="${BOOK}"]`)) {
        await click(page, `[data-lib-book="${BOOK}"]`);
        if (await page.$(`[data-lib-paragraph="${BOOK}-p1-2"]`)) await click(page, `[data-lib-paragraph="${BOOK}-p1-2"]`);
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
    await toHistory(page);
    await click(page, `[data-lib-book="${BOOK}"]`);
    await click(page, `[data-lib-paragraph="${BOOK}-p33-34"]`);
    await page.waitForTimeout(400);
    check("тёмная тема системы: § 33–34 открывается, без горизонтальной прокрутки и ошибок JS", !!(await page.$(".cn-doc")) && !(await hscroll(page)) && errors.length === 0, errors);
    await page.screenshot({ path: path.join(SHOTS, "p33-34-390-dark-system.png") });
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL` + (CONTENT ? "" : " (без HR8_CONTENT: содержимое конспектов не проверялось)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
