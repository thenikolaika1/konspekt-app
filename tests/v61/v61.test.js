// Тесты интерфейса v61 (локально): статус доступа с сервера, «Доступ закончился», «Тарифы», «Мой доступ», PWA.
// Сеть к Supabase не используется: js/cloud.js подменяется заглушкой, любой запрос к *.supabase.co обрывается и считается.
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const HERE = __dirname;
// корень проекта (эта ветка) и распакованная v59 для сравнения: git archive 4390054 | tar -x -C "$V59_DIR"
const V61 = path.resolve(HERE, "../..");
const V59 = process.env.V59_DIR || path.resolve(HERE, "../../../v59site");
const SHOTS = process.env.SHOTS_DIR || path.join(require("os").tmpdir(), "konspekt-v61-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const STUB = fs.readFileSync(path.join(HERE, "stub-cloud.js"), "utf8");
const PORT = 8171;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (extra !== undefined && !ok ? " → " + JSON.stringify(extra).slice(0, 400) : ""));
}

let ROOT = V61;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
});

// ---------- данные и код без браузера ----------
function loadCatalog(dir) {
  const ctx = vm.createContext({ console: { warn() {}, log() {} } });
  ctx.window = ctx;
  const cat = fs.existsSync(path.join(dir, "js/library-index.js")) ? "js/library-index.js" : "js/library-catalog.js";  // v62: каталог без текстов
  for (const f of ["js/config.js", "js/study-content.js", "js/library.js", cat]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
  return ctx.K;
}
function staticTests() {
  const K = loadCatalog(V61);
  check("данные: библиотека показывает историю и физику (биология скрыта, как в v60)", K.library.subjects().map((s) => s.id).join() === "history,physics");
  const all = K.library.catalog();
  const n = (id, f) => all.subjects.find((s) => s.id === id).books.reduce((a, b) => a + b.paragraphs.filter(f).length, 0);
  check("данные (v62): готовы 26 / 51, биология без текстов (скрыта)", n("history", (p) => p.ready) === 26 && n("physics", (p) => p.ready) === 51 && n("biology", (p) => p.ready) === 0);
  check("данные (v62): в публичном каталоге нет ни одного текста (content) и служебных пометок (source)", all.subjects.every((s) => s.books.every((b) => b.paragraphs.every((p) => !("content" in p) && !("source" in p)))));
  // структура каталога (классы, предметы, учебники, номера и названия параграфов) — та же, что в v59
  const shape = (c) => JSON.stringify(c.subjects.map((s) => [s.id, s.title, s.books.map((b) => [b.id, b.title, b.grade, b.paragraphs.map((p) => [p.id, p.number, p.title, p.chapter || ""])])]));
  check("данные (v62): структура каталога = v59 (те же учебники и параграфы)", shape(all) === shape(loadCatalog(V59).library.catalog()));
  check("данные (v62): js/library-catalog.js с текстами удалён из сайта", !fs.existsSync(path.join(V61, "js/library-catalog.js")));
  const sql = (dir) => execFileSync("node", ["tools/catalog-to-sql.mjs"], { cwd: dir }).toString();
  check("данные: справочник аналитики = v59 (107)", sql(V61) === sql(V59));
  const app = fs.readFileSync(path.join(V61, "app.js"), "utf8");
  check("код: старой проверки F&F (ffEnded/serverMarks/ffEndsAt) больше нет", !/ffEnded|serverMarks|FF_ENDS_AT|ffEndsAt/.test(app + fs.readFileSync(path.join(V61, "js/cloud.js"), "utf8") + fs.readFileSync(path.join(V61, "js/config.js"), "utf8")));
  check("код: нет Date.now() в решении о доступе (paywalled/daysLeft)", !/Date\.now\(\)/.test(app.slice(app.indexOf("// ---------- доступ v61"), app.indexOf("function earlyAccess"))));
  check("код (v62): контакта и ссылок связи нет — подключение Premium только через Николая", !/ownerContact/.test(fs.readFileSync(path.join(V61, "js/config.js"), "utf8") + app));
  check("код: нет реквизитов/карт/телефонов", !/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b|\+7\s?\d|t\.me\/|@[a-z0-9-]+\.(ru|com)/i.test(app));
  const fn = fs.readFileSync(path.join(V61, "supabase/functions/analyze-pages/index.ts"), "utf8");
  check("функция: analyze-pages вызывает start_text_generation_v2", /rpc\("start_text_generation_v2"/.test(fn) && !/rpc\("start_text_generation"/.test(fn));
}

// ---------- сценарии ----------
const NOW = "2026-11-02T09:00:00+03:00";
const at = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();
const ACC = {
  trial: { status: "trial", kind: "trial", plan: null, starts_at: at(0), ends_at: at(7), server_now: NOW, ai_quota: 1, ai_used: 0, ai_reserved: 0, ai_remaining: 1, ai_available: 1 },
  trialExpired: { status: "expired", kind: "trial", plan: null, starts_at: at(-8), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  paid: { status: "paid", kind: "paid", plan: null, starts_at: at(-3), ends_at: at(27), paid_until: at(57), server_now: NOW, ai_quota: 20, ai_used: 5, ai_reserved: 0, ai_remaining: 15, ai_available: 15 },
  paidExpired: { status: "expired", kind: "paid", plan: null, starts_at: at(-31), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  revoked: { status: "expired", kind: "paid", plan: null, starts_at: at(-3), ends_at: at(0), revoked: true, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  // v61.1: отозвана роль владельца — нейтральный заголовок
  ownerRevoked: { status: "expired", kind: "owner", plan: null, starts_at: at(-30), ends_at: at(0), revoked: true, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  owner: { status: "owner", kind: "owner", plan: null, starts_at: at(-1), ends_at: null, server_now: NOW, ai_quota: null, ai_used: 42, ai_reserved: 0, ai_remaining: null, ai_available: null },
  legacyService: { status: "paid", kind: "legacy", legacy_source: "manual", starts_at: null, ends_at: null, server_now: NOW, ai_quota: 100, ai_used: 12, ai_reserved: 0, ai_remaining: 88, ai_available: 88 },
  legacyFF: { status: "expired", kind: "legacy", legacy_source: "beta_invite", starts_at: "2026-10-18T21:00:00Z", ends_at: "2026-10-23T21:00:00Z", server_now: NOW, ai_quota: 1, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
};
const P = (v2, extra) => ({ kind: "participant", id: "KN-AAAAAA", uid: "u-1", v2, ...extra });
const NOTE = {
  id: "11111111-1111-4111-8111-111111111111", status: "ready", stage: "done", error_code: null, title: "Мой конспект по биологии",
  subject: "biology", preview: "Клетка", content: null, schema_version: 2, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z",
};
// часы устройства далеко в будущем: если бы приложение считало сроки по ним, всё было бы «закончилось»
const FAR_FUTURE = Date.parse("2030-01-01T00:00:00Z");

let browser;
async function open(T, { viewport = { width: 390, height: 844 }, time = FAR_FUTURE, mobile = true, configPatch } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, serviceWorkers: "block", locale: "ru-RU" });
  const supa = [];
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/supabase\.co/.test(u)) return supa.push(u), route.abort();
    if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
    if (configPatch && /\/js\/config\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: configPatch(fs.readFileSync(path.join(V61, "js/config.js"), "utf8")) });
    if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  if (time) await page.clock.install({ time });
  await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify(T));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForTimeout(2200);
  for (let i = 0; i < 4; i++) {
    const btn = await page.$(".welcome:not(.access) .primary");
    if (!btn) break;
    await btn.click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(700);
  return { ctx, page, errors, supa };
}
// неразрывные пробелы (между числом и словом) сравниваются как обычные
const text = (page) => page.evaluate(() => (document.querySelector("#app > .app")?.innerText || "").replace(/\u00a0/g, " "));
const T_ = (page) => page.evaluate(() => window.__T);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
async function tab(page, id) {
  // с полноэкранного экрана (конспект, камера) — сначала «Назад», как пользователь
  for (let i = 0; i < 3 && (await page.$eval(".tabbar", (n) => n.hidden).catch(() => true)); i++) {
    const back = await page.$("#app > .app [data-back], #app > .app .back");
    if (!back) break;
    await back.click();
    await page.waitForTimeout(600);
  }
  await page.click('.tabbar [data-tab="' + id + '"]');
  await page.waitForTimeout(650);
}
const click = async (page, sel, ms = 650) => (await page.click("#app > .app " + sel), page.waitForTimeout(ms));
const noErr = (errors) => !errors.filter((e) => !/CONNECTION_LOST|NETWORK|check failed|\[sync\]|PLANS_FAILED/.test(e)).length;
async function flushViews(page) {
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.K.analytics.flush());
    await page.waitForTimeout(250);
  }
  return (await T_(page)).tracked.filter((e) => e.t === "view").map((e) => e.p);
}
async function toBook(page, sid) {
  await tab(page, "library");
  await click(page, '[data-lib-grade="8"]');
  await click(page, '[data-lib-subject="' + sid + '"]');
  await click(page, "[data-lib-book]");
}

async function scenarios() {
  browser = await chromium.launch();

  // 1–3. Пробный период: строка на главной, «Мой доступ», библиотека и камера открыты
  {
    const { ctx, page, errors, supa } = await open(P(ACC.trial));
    const t = await text(page);
    check("1. trial: «Пробный период: осталось 7 дней» на главной (по времени сервера, часы устройства — 2030 г.)", t.includes("Пробный период: осталось 7 дней"), t.slice(0, 300));
    check("1. trial: главная обычная, «Остался 1 конспект»", t.includes("Новый конспект") && t.includes("Остался 1 конспект"));
    await page.screenshot({ path: path.join(SHOTS, "home-trial-iphone.png") });
    await tab(page, "me");
    const pf = await text(page);
    check("1. «Мой доступ»: пробный период до 9 ноября 2026 г., осталось 7 дней, ИИ 1 из 1", /Пробный период до 9 ноября 2026/.test(pf) && pf.includes("Осталось 7 дней") && pf.includes("ИИ по фото: осталось 1 из 1"), pf.slice(0, 600));
    check("1. «Мой доступ»: кнопка «Premium и продление» (v62)", pf.includes("Premium и продление"));
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("1. trial: полный текст готового конспекта открывается", !!(await page.$(".cn-doc")));
    await tab(page, "photo");
    check("1. trial: «Фото» открывает камеру", !!(await page.$(".scr-camera")));
    const views = await flushViews(page);
    check("1. аналитика: просмотр при доступе записан", views.length === 1 && /^history-8/.test(views[0]), views);
    check("1. нет ошибок JS и запросов к Supabase", noErr(errors) && !supa.length, [errors, supa]);
    await ctx.close();
  }

  // 4–8. Пробный период закончился: экран с кнопками; каталог виден; полный текст закрыт; личные конспекты есть
  {
    const { ctx, page, errors } = await open(P(ACC.trialExpired, { notes: [NOTE] }));
    const t = await text(page);
    check("5. expired trial: «Пробный период закончился»", t.includes("Пробный период закончился"), t.slice(0, 300));
    check("5. экран: кнопка Premium, «Мои конспекты», аккаунт и личные конспекты сохранены", /Premium/.test(t) && /Мои конспекты · \d/.test(t) && t.includes("Твой аккаунт и личные конспекты сохранены"));
    check("5. (v62) подключение через Николая: «Подключает Николай», без ссылок и оплаты", t.includes("Подключает Николай") && !(await page.$(".ended a")) && !/оплат/i.test(t), t.slice(0, 400));
    check("5. нет цен и придуманных тарифов", !/₽|руб\./i.test(t));
    await page.screenshot({ path: path.join(SHOTS, "trial-ended-iphone.png") });
    check("5. без горизонтальной прокрутки (390)", await noHScroll(page));
    // 6. каталог: классы, предметы, учебник, названия параграфов
    await toBook(page, "physics");
    const book = await text(page);
    const titles = await page.$$eval("#app > .app [data-lib-paragraph]", (b) => b.length);
    check("6. каталог после окончания: учебник физики и 51 название параграфа видны", titles === 51 && book.includes("Параграфы"), titles);
    // 7. полный текст → экран доступа (с «Назад»)
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    const pw = await text(page);
    check("7. открыть параграф → «Пробный период закончился», текста конспекта нет", pw.includes("Пробный период закончился") && !(await page.$(".cn-doc")), pw.slice(0, 200));
    check("7. экран доступа в библиотеке: поясняет, что каталог виден", pw.includes("Список предметов и параграфов остаётся виден"));
    await page.screenshot({ path: path.join(SHOTS, "paywall-paragraph-iphone.png") });
    await click(page, "[data-back]");
    check("7. «Назад» возвращает к списку параграфов", (await page.$$("#app > .app [data-lib-paragraph]")).length === 51);
    const views = await flushViews(page);
    check("7. аналитика: закрытый параграф не засчитан как просмотр", !views.length, views);
    // 8. личные конспекты
    await tab(page, "home");
    await click(page, '[data-go="all-notes"]', 800);
    check("8. «Мои конспекты» открывает личные конспекты", (await text(page)).includes("Мой конспект по биологии"));
    // «Фото» → тарифы, профиль — «Доступ закончился» и «Продлить доступ»
    await tab(page, "photo");
    check("5. «Фото» после окончания → экран тарифов, не камера", !(await page.$(".scr-camera")) && !!(await page.$(".scr-tariffs")));
    await tab(page, "me");
    const pf = await text(page);
    check("5. «Мой доступ»: «Доступ закончился 1 ноября 2026 г.» и «Продлить Premium»", /Доступ закончился 1 ноября 2026/.test(pf) && pf.includes("Продлить Premium"), pf.slice(0, 500));
    const T = await T_(page);
    check("5. не было запросов генерации", !T.calls.some((c) => /startAnalysis|uploadPages|createProcessingNote|deleteNote/.test(c)), T.calls);
    check("5. нет ошибок JS", noErr(errors), errors);
    // 17. обновление страницы
    await page.reload();
    await page.waitForTimeout(2500);
    check("17. после перезагрузки — снова «Пробный период закончился»", (await text(page)).includes("Пробный период закончился"));
    check("8. личный конспект на месте после перезагрузки", await page.evaluate(() => Object.values(localStorage).some((v) => v.includes("Мой конспект по биологии"))));
    await ctx.close();
  }

  // Экран Premium (v62): пустое состояние, ошибка загрузки, условия из get_plans — без цены, описания и ссылок;
  // подключение — только через Николая (ID ученика), контакт из старых настроек игнорируется
  {
    const a = await open(P(ACC.trialExpired));
    await click(a.page, '[data-go="tariffs"]', 900);
    const t = await text(a.page);
    check("тарифы: пусто → «Premium пока не опубликован», условия уточнить у Николая; без цен", t.includes("Premium пока не опубликован") && t.includes("уточните у Николая") && !/₽/.test(t), t.slice(0, 400));
    check("тарифы: «Как подключить Premium?» — через Николая, без оплаты и реквизитов", t.includes("Как подключить Premium?") && t.includes("свяжитесь с Николаем") && !/оплат|карт[аы]\s*\d|\d{16}/i.test(t), t.slice(0, 400));
    await a.page.screenshot({ path: path.join(SHOTS, "tariffs-empty-iphone.png") });
    check("тарифы: без горизонтальной прокрутки", await noHScroll(a.page));
    check("тарифы: нет ошибок JS", noErr(a.errors), a.errors);
    await a.ctx.close();
    const b = await open(P(ACC.trialExpired, { plansError: true }));
    await click(b.page, '[data-go="tariffs"]', 900);
    check("тарифы: ошибка сети → «Не удалось загрузить условия Premium»", (await text(b.page)).includes("Не удалось загрузить условия Premium"));
    await b.ctx.close();
    const plans = [{ code: "t1", title: "Тестовый тариф А (данные теста)", days: 30, ai_quota: 10, price_label: "цена теста", description: "описание теста" },
                   { code: "t2", title: "Тестовый тариф Б (данные теста)", days: 90, ai_quota: 40, price_label: "цена теста 2", description: "описание теста 2" }];
    const c = await open(P(ACC.paid, { plans }), { configPatch: (s) => s.replace("hiddenLibrarySubjects:", 'ownerContact: { label: "Написать Николаю", url: "https://example.invalid/contact" },\n    hiddenLibrarySubjects:') });
    await tab(c.page, "me");
    await click(c.page, '[data-go="tariffs"]', 900);
    const tc = await text(c.page);
    check("тарифы: единственный тариф из get_plans — название, генерации и срок с сервера", tc.includes("Тестовый тариф А") && tc.includes("10 ИИ-конспектов по фотографиям за 30 дней") && !tc.includes("Тестовый тариф Б"), tc.slice(0, 500));
    check("тарифы: цена и описание тарифа с сервера не показываются", !tc.includes("цена теста") && !tc.includes("описание теста"), tc.slice(0, 500));
    check("тарифы: контакт из настроек игнорируется — ссылок нет", !(await c.page.$("#app > .app a")));
    await c.page.screenshot({ path: path.join(SHOTS, "tariffs-list-iphone.png"), fullPage: true });
    await c.ctx.close();
  }

  // 9–12. Оплачено: срок и дни — по времени сервера (заранее продлено: paid_until), генерации текущего срока
  {
    const { ctx, page, errors } = await open(P(ACC.paid));
    const t = await text(page);
    check("9. paid: главная обычная, «Осталось 15 конспектов», нет строки пробного периода", t.includes("Осталось 15 конспектов") && !t.includes("Пробный период"), t.slice(0, 300));
    await tab(page, "me");
    const pf = await text(page);
    check("10. «Мой доступ»: «Оплачен до 29 декабря 2026 г.» (продлён заранее), «Осталось 57 дней», ИИ 15 из 20", /Оплачен до 29 декабря 2026/.test(pf) && pf.includes("Осталось 57 дней") && pf.includes("ИИ по фото: осталось 15 из 20"), pf.slice(0, 600));
    await page.screenshot({ path: path.join(SHOTS, "profile-paid-iphone.png"), fullPage: true });
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("9. paid: полный текст открывается", !!(await page.$(".cn-doc")));
    check("9. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
  // 12. генерации текущего срока закончились (paid, остаток 0)
  {
    const { ctx, page } = await open(P({ ...ACC.paid, ai_used: 20, ai_remaining: 0, ai_available: 0 }));
    const t = await text(page);
    check("12. paid, генерации срока исчерпаны → «Генерации ИИ закончились», кнопка «Тарифы»", t.includes("Генерации ИИ закончились") && t.includes("Новые появятся с продлением"), t.slice(0, 300));
    check("v61.1 грамматика: «На этот срок использовано 20 конспектов»", t.includes("На этот срок использовано 20 конспектов"), t.slice(0, 300));
    await tab(page, "photo");
    check("12. камера не открывается (сервер всё равно откажет)", !(await page.$(".scr-camera")));
    await ctx.close();
  }
  // v61.1 грамматика: одна генерация — «использован 1 конспект»
  {
    const { ctx, page } = await open(P({ ...ACC.trial, ai_used: 1, ai_remaining: 0, ai_available: 0 }));
    const t = await text(page);
    check("v61.1 грамматика: «На этот срок использован 1 конспект»", t.includes("На этот срок использован 1 конспект") && !t.includes("использовано 1 конспект"), t.slice(0, 300));
    await ctx.close();
  }
  // v61.1 справка: число генераций пробного периода не зашито в текст
  {
    const { ctx, page } = await open(P(ACC.trial));
    await tab(page, "me");
    await click(page, '[data-go="help"]', 800);
    // ответы справки свёрнуты (<details>) — читаем весь текст экрана, а не только видимый
    const h = await page.evaluate(() => document.querySelector("#app > .app")?.textContent || "");
    check("v61.1 справка: «зависит от доступа — пробного периода или Premium», без «в пробном периоде — одна»", h.includes("пробного периода или Premium") && !h.includes("в пробном периоде — одна"), h.slice(0, 200));
    check("v61.2 справка: объяснения COOLDOWN, AI_UNAVAILABLE, RETRY_LIMIT, DAILY_LIMIT есть",
      ["ИИ сейчас не отвечает.", "Сервис ИИ временно недоступен.", "Слишком много попыток с нечитаемыми фото.", "На сегодня запуски ИИ закончились."].every((x) => h.includes(x)));
    await ctx.close();
  }
  // 11/13. оплаченный срок закончился; доступ отозван
  for (const [k, title, card] of [["paidExpired", "Premium закончился", /Доступ закончился 1 ноября 2026/], ["revoked", "Premium закончился", /Доступ закрыт/],
                                   ["ownerRevoked", "Доступ закончился", /Доступ закрыт/]]) {
    const { ctx, page } = await open(P(ACC[k]));
    const h1 = await page.$eval("#app > .app h1", (n) => n.textContent).catch(() => "");
    check("13. " + k + ": заголовок «" + title + "»", h1 === title, h1);
    await tab(page, "me");
    check("13. " + k + ": «Мой доступ» — " + card, card.test(await text(page)));
    await ctx.close();
  }

  // 14. Владелец: бессрочно, без личного лимита; часы устройства в будущем не мешают
  {
    const { ctx, page, errors } = await open({ ...P(ACC.owner), id: "KN-OWNER2" });
    const t = await text(page);
    check("14. владелец: обычная главная без остатка/«закончились»", t.includes("Новый конспект") && !/Остал|закончил/.test(t), t.slice(0, 300));
    await tab(page, "me");
    const pf = await text(page);
    check("14. «Мой доступ»: «Владелец · бессрочный доступ», «без личного лимита», без кнопки продления", pf.includes("Владелец · бессрочный доступ") && pf.includes("без личного лимита") && !pf.includes("Premium и продление") && !pf.includes("Продлить Premium"), pf.slice(0, 500));
    await tab(page, "photo");
    check("14. владелец: камера открывается", !!(await page.$(".scr-camera")));
    await toBook(page, "physics");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("14. владелец: полный текст открывается", !!(await page.$(".cn-doc")));
    check("14. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
  // служебный анонимный (legacy manual) — как раньше; F&F (legacy, окно закрыто) — свой заголовок
  {
    const a = await open({ kind: "guest", uid: "u-anon", v2: ACC.legacyService });
    const t = await text(a.page);
    check("14. анонимный служебный: обычная главная, остаток 88", t.includes("Осталось 88 конспектов") && !t.includes("закончил"), t.slice(0, 200));
    await tab(a.page, "me");
    check("14. анонимный служебный: «Действует · бессрочно»", (await text(a.page)).includes("Действует · бессрочно"));
    await a.ctx.close();
    const b = await open(P(ACC.legacyFF, { notes: [NOTE] }));
    check("23. бывший F&F без оплаты: «Бесплатное тестирование завершено» (прежняя логика сервера)", (await text(b.page)).includes("Бесплатное тестирование завершено"));
    await b.ctx.close();
  }
  // гость — экран раннего доступа как в v59
  {
    const { ctx, page } = await open({ kind: "guest", uid: "guest-uid", v2: { status: "none", kind: null, server_now: NOW } });
    const t = await text(page);
    check("гость: экран регистрации по приглашению, без экрана оплаты", t.includes("Ранний доступ") && !t.includes("закончил"), t.slice(0, 200));
    await ctx.close();
  }

  // 16/24. Сервер статусов недоступен: ни ложного «закончилось», ни бесконечной загрузки
  for (const mode of ["error", "hang"]) {
    const { ctx, page, errors } = await open(P(mode, { access: mode, offline: mode === "error" }));
    await page.waitForTimeout(1500);
    const t = await text(page);
    check("24. статус недоступен (" + mode + "): обычный экран, без «закончилось»", t.includes("Новый конспект") && !t.includes("закончил"), t.slice(0, 200));
    check("24. (" + mode + ") нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
  // сервер без v61 (миграция не применена): прежний get_my_access, как v59 — без экранов оплаты
  {
    const { ctx, page, errors } = await open(P("missing", { access: { plan: "beta", quota: 1, used: 0, remaining: 0 } }));
    const t = await text(page);
    check("сервер без v61: поведение v59 (без экрана оплаты, библиотека открыта)", !t.includes("закончился") && t.includes("Бесплатные конспекты закончились"), t.slice(0, 200));
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("сервер без v61: полный текст открыт (интерфейс не изображает подписку)", !!(await page.$(".cn-doc")));
    await tab(page, "me");
    check("сервер без v61: карточки «Мой доступ» нет", !(await text(page)).includes("Мой доступ"));
    check("сервер без v61: нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // 18. выход и вход другим аккаунтом: expired → paid
  {
    const accounts = { "KN-CCCCCC": { uid: "u-paid", v2: ACC.paid } };
    const { ctx, page, errors } = await open(P(ACC.trialExpired, { accounts }));
    check("18. старт: «Пробный период закончился»", (await text(page)).includes("Пробный период закончился"));
    await page.evaluate(() => (window.__T.kind = "guest"));
    await tab(page, "me");
    const login = await page.$('#app > .app [data-go="login"]');
    if (login) await login.click(), await page.waitForTimeout(500);
    await page.fill("#loginId", "KN-CCCCCC");
    await page.fill("#loginKey", "KEYKEYKEYKEYKEYKEYKE");
    await page.click("#app > .app [data-login]");
    await page.waitForTimeout(1500);
    await tab(page, "home");
    const t = await text(page);
    check("18. вход оплаченным аккаунтом → обычная главная без экрана оплаты", t.includes("Новый конспект") && !t.includes("закончился"), t.slice(0, 200));
    check("18. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // 4/5. Сервер отказал при генерации (срок закончился во время работы) → экран доступа, без потери фото и конспектов
  {
    const png = path.join(V61, "icons", fs.readdirSync(path.join(V61, "icons")).find((f) => f.endsWith(".png")));
    const { ctx, page, errors } = await open(P(ACC.trial, { v2AfterStart: ACC.trialExpired, startError: "ACCESS_EXPIRED" }));
    await tab(page, "photo");
    await page.setInputFiles("#galleryInput", png);
    await page.waitForTimeout(1500);
    const create = await page.$("#app > .app .camera-actions .primary");
    if (create) await create.click();
    await page.waitForTimeout(3500);
    const t = await text(page);
    const T = await T_(page);
    check("4. отказ сервера ACCESS_EXPIRED → обновлён статус и показан экран «Пробный период закончился»", T.calls.includes("startAnalysis") && t.includes("Пробный период закончился"), [T.calls.slice(-6), t.slice(0, 200)]);
    check("4. нет ошибок JS", noErr(errors.filter((e) => !/ACCESS_EXPIRED|generation\] failed/.test(e))), errors);
    await ctx.close();
  }

  // v61.2: отказы защиты бюджета → понятный экран ошибки «генерация не потрачена», статус не «закончился»
  for (const [code, what, hint] of [
    ["COOLDOWN", "ИИ сейчас не отвечает.", "Подожди 15 минут"],
    ["AI_UNAVAILABLE", "Сервис ИИ временно недоступен.", "возобновится само"],
    ["RETRY_LIMIT", "Слишком много попыток с нечитаемыми фото.", "Пересними страницы"],
    ["DAILY_LIMIT", "На сегодня запуски ИИ закончились.", "Попробуй завтра"],
  ]) {
    const png = path.join(V61, "icons", fs.readdirSync(path.join(V61, "icons")).find((f) => f.endsWith(".png")));
    const { ctx, page, errors } = await open(P(ACC.paid, { startError: code }));
    await tab(page, "photo");
    await page.setInputFiles("#galleryInput", png);
    await page.waitForTimeout(1500);
    const create = await page.$("#app > .app .camera-actions .primary");
    if (create) await create.click();
    await page.waitForTimeout(3500);
    const t = await text(page);
    check("v61.2 " + code + " → «" + what + "», «" + hint + "», «генерация не потрачена»", t.includes(what) && t.includes(hint) && /генерация не потрачена/i.test(t), t.slice(0, 300));
    check("v61.2 " + code + " → не экран «доступ закончился»", !t.includes("закончился") || code === "DAILY_LIMIT");
    check("v61.2 " + code + " → нет ошибок JS", noErr(errors.filter((e) => !new RegExp(code + "|generation\\] failed").test(e))), errors);
    await ctx.close();
  }

  // вид: 320 и 1280
  for (const [name, vp, mobile] of [["320", { width: 320, height: 568 }, true], ["desktop-1280", { width: 1280, height: 800 }, false]]) {
    const { ctx, page, errors } = await open(P(ACC.trialExpired, { notes: [NOTE] }), { viewport: vp, mobile });
    check("вид " + name + ": экран доступа без горизонтальной прокрутки", (await noHScroll(page)) && (await text(page)).includes("Пробный период закончился"));
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const vis = await page.$eval('.ended [data-go="all-notes"]', (n) => n.getBoundingClientRect().bottom <= document.querySelector(".tabbar").getBoundingClientRect().top + 1);
    check("вид " + name + ": кнопки не под панелью вкладок", vis);
    await page.screenshot({ path: path.join(SHOTS, "trial-ended-" + name + ".png") });
    await tab(page, "me");
    check("вид " + name + ": профиль без горизонтальной прокрутки", await noHScroll(page));
    check("вид " + name + ": нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
}

// ---------- PWA: v59 в кэше → v61 ----------
async function pwaTest() {
  ROOT = V59;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/supabase\.co/.test(u)) return route.abort();
    if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
    return route.continue();
  });
  await ctx.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify(P(ACC.trialExpired, { notes: [NOTE], access: { plan: "beta", quota: 1, used: 0, remaining: 0 } })));
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  await page.reload();
  await page.waitForTimeout(2500);
  check("PWA: v59 под service worker, кэш konspekt-v59", (await page.evaluate(() => caches.keys())).includes("konspekt-v59"));
  ROOT = V61;
  await page.reload();
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForTimeout(3000);
  for (let i = 0; i < 4; i++) {
    const btn = await page.$(".welcome:not(.access) .primary");
    if (!btn) break;
    await btn.click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  const keys = await page.evaluate(() => caches.keys());
  const build = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => /app\.js/.test(s)));
  check("PWA: после обновления — app.js?v=62", /v=62/.test(build || ""), build);
  check("PWA: старый кэш удалён, остался konspekt-v62", keys.length === 1 && keys[0] === "konspekt-v62", keys);
  check("PWA: после обновления — статус с сервера (экран «Пробный период закончился»)", (await text(page)).includes("Пробный период закончился"));
  check("PWA: личный конспект сохранён", await page.evaluate(() => Object.values(localStorage).some((v) => v.includes("Мой конспект по биологии"))));
  await ctx.close();
}

(async () => {
  staticTests();
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  try {
    await scenarios();
    await pwaTest();
  } catch (e) {
    check("тест завершился без исключения", false, String(e && e.stack));
  }
  await browser?.close();
  server.close();
  console.log("ИТОГО: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
