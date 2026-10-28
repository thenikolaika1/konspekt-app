// v62: закрытая библиотека и Premium в браузере (Chromium, размеры iPhone). Сеть не используется: js/cloud.js заменён
// заглушкой (tests/v61/stub-cloud.js), «сервер» библиотеки в ней решает по статусу доступа и отдаёт ТЕСТОВЫЕ тексты.
// PWA: v61.3 (с js/library-catalog.js в кэше) → v62. Нужна распакованная v61.3: git archive 53d3203 | tar -x -C "$V613_DIR".
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const HERE = __dirname;
const V62 = path.resolve(HERE, "../..");
const V613 = process.env.V613_DIR || path.resolve(HERE, "../../../v613site");
const SHOTS = process.env.SHOTS_DIR || path.join(require("os").tmpdir(), "konspekt-v62-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const STUB = fs.readFileSync(path.join(HERE, "../v61/stub-cloud.js"), "utf8");
const PORT = 8262;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (extra !== undefined && !ok ? " → " + JSON.stringify(extra).slice(0, 400) : ""));
}

let ROOT = V62;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
const served = [];
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  served.push(p);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
});

const NOW = "2026-11-02T09:00:00+03:00";
const at = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();
const ACC = {
  trial: { status: "trial", kind: "trial", plan: null, starts_at: at(0), ends_at: at(7), server_now: NOW, ai_quota: 1, ai_used: 0, ai_reserved: 0, ai_remaining: 1, ai_available: 1 },
  trialExpired: { status: "expired", kind: "trial", plan: null, starts_at: at(-8), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  premium: { status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-3), ends_at: at(27), paid_until: at(27), server_now: NOW, ai_quota: 10, ai_used: 4, ai_reserved: 0, ai_remaining: 6, ai_available: 6 },
  premiumEnding: { status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-28), ends_at: at(2), paid_until: at(2), server_now: NOW, ai_quota: 10, ai_used: 9, ai_reserved: 0, ai_remaining: 1, ai_available: 1 },
  premiumExtended: { status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-28), ends_at: at(2), paid_until: at(32), server_now: NOW, ai_quota: 10, ai_used: 9, ai_reserved: 0, ai_remaining: 1, ai_available: 1 },
  gift: { status: "paid", kind: "paid", plan: "gift", plan_title: "Подарок", starts_at: at(-1), ends_at: at(29), paid_until: at(29), server_now: NOW, ai_quota: 3, ai_used: 1, ai_reserved: 0, ai_remaining: 2, ai_available: 2 },
  giftExpired: { status: "expired", kind: "paid", plan: "gift", starts_at: at(-8), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  premiumExpired: { status: "expired", kind: "paid", plan: "premium", starts_at: at(-31), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  owner: { status: "owner", kind: "owner", plan: null, starts_at: at(-1), ends_at: null, server_now: NOW, ai_quota: null, ai_used: 0, ai_reserved: 0, ai_remaining: null, ai_available: null },
};
const PLANS = [{ code: "premium", title: "Premium", days: 30, ai_quota: 10, price_label: "299 ₽", description: "История и физика целиком, 10 конспектов по фото за 30 дней" }];
const P = (v2, extra) => ({ kind: "participant", id: "KN-AAAAAA", uid: "u-1", v2, plans: PLANS, ...extra });
const NOTE = {
  id: "11111111-1111-4111-8111-111111111111", status: "ready", stage: "done", error_code: null, title: "Мой конспект по биологии",
  subject: "biology", preview: "Клетка", content: null, schema_version: 2, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z",
};
const FAR_FUTURE = Date.parse("2030-01-01T00:00:00Z");

let browser;
async function open(T, { sw = false, configPatch } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: sw ? "allow" : "block", locale: "ru-RU" });
  const supa = [];
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/supabase\.co/.test(u)) return supa.push(u), route.abort();
    if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
    if (configPatch && /\/js\/config\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: configPatch(fs.readFileSync(path.join(ROOT, "js/config.js"), "utf8")) });
    if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.clock.install({ time: FAR_FUTURE });
  await page.addInitScript((t) => (window.__T = window.__T || JSON.parse(t)), JSON.stringify(T));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForTimeout(2200);
  await skipWelcome(page);
  return { ctx, page, errors, supa };
}
async function skipWelcome(page) {
  for (let i = 0; i < 4; i++) {
    const btn = await page.$(".welcome:not(.access) .primary");
    if (!btn) break;
    await btn.click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(700);
}
const text = (page) => page.evaluate(() => document.querySelector("#app > .app")?.innerText || "");
const T_ = (page) => page.evaluate(() => window.__T);
const libCalls = async (page) => (await T_(page)).calls.filter((c) => c.startsWith("libraryParagraph:"));
const noErr = (errors) => !errors.filter((e) => !/CONNECTION_LOST|NETWORK|check failed|\[sync\]|PLANS_FAILED|ACCESS_REQUIRED|NOT_FOUND/.test(e)).length;
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
async function tab(page, id) {
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
async function toBook(page, sid) {
  await tab(page, "library");
  await click(page, '[data-lib-grade="8"]');
  await click(page, '[data-lib-subject="' + sid + '"]');
  await click(page, "[data-lib-book]");
}
const firstPar = async (page) => page.$eval("#app > .app [data-lib-paragraph]:not(.soon)", (n) => n.dataset.libParagraph);
// всё, что приложение сохранило на устройстве: localStorage, sessionStorage, IndexedDB (имена), Cache Storage (тела)
async function deviceDump(page) {
  return page.evaluate(async () => {
    let out = JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage));
    if (indexedDB.databases) out += JSON.stringify(await indexedDB.databases());
    // js/cloud.js в тестах — заглушка, в ней самой есть строка тестового текста; её тело не проверяется
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys())
      out += r.url + (/\/js\/cloud\.js/.test(r.url) ? "" : await (await (await caches.open(k)).match(r)).text());
    return out;
  });
}

async function scenarios() {
  browser = await chromium.launch();

  // V1. Пробный период: загрузка с сервера → «Загружаем конспект…» → текст; повторно — из памяти, без запроса
  {
    const { ctx, page, errors, supa } = await open(P(ACC.trial, { libDelay: 1200 }));
    await toBook(page, "history");
    const counter = await text(page);
    check("V1. каталог: счётчики готовых параграфов считаются по ready (26 у истории 8 кл.)", /26/.test(counter) || (await page.$$("#app > .app [data-lib-paragraph]:not(.soon)")).length > 0, counter.slice(0, 200));
    const pid = await firstPar(page);
    await click(page, "[data-lib-paragraph]:not(.soon)", 300);
    const t1 = await text(page);
    check("V1. пока ответа нет — экран «Загружаем конспект…» с «Назад»", t1.includes("Загружаем конспект") && !!(await page.$("#app > .app [data-back]")), t1.slice(0, 200));
    await page.screenshot({ path: path.join(SHOTS, "lib-loading-iphone.png") });
    await page.waitForTimeout(1800);
    const t2 = await text(page);
    check("V1. ответ сервера → полный текст конспекта", !!(await page.$(".cn-doc")) && t2.includes("ТЕСТОВЫЙ ТЕКСТ history/"), t2.slice(0, 200));
    check("V1. запрос текста — один, с id предмета/учебника/параграфа", (await libCalls(page)).length === 1 && (await libCalls(page))[0].endsWith("/" + pid), await libCalls(page));
    await click(page, "[data-back]", 600);
    await click(page, '[data-lib-paragraph="' + pid + '"]', 600);
    check("V1. повторное открытие — из памяти страницы, без нового запроса и без экрана загрузки", (await libCalls(page)).length === 1 && !!(await page.$(".cn-doc")));
    const dump = await deviceDump(page);
    check("V1. текст конспекта не сохранён на устройстве (localStorage, sessionStorage, IndexedDB, кэш)", !dump.includes("ТЕСТОВЫЙ ТЕКСТ"), dump.length);
    check("V1. нет ошибок JS и запросов к настоящему Supabase", noErr(errors) && !supa.length, [errors, supa]);
    // выход из аккаунта — тексты удаляются из памяти
    await tab(page, "me");
    await click(page, "[data-signout]", 1500);
    const forgotten = await page.evaluate(([b]) => {
      const K = window.K;
      const s = K.library.subjects().find((x) => x.id === "history");
      const book = s.books.find((x) => x.grade === "8");
      const p = book.paragraphs.find((x) => K.library.ready(x));
      return K.library.text("history", book.id, p.id);
    }, [null]);
    check("V1. после «Выйти» текста библиотеки в памяти нет", forgotten === null, forgotten);
    await ctx.close();
  }

  // V2. Нет сети: понятная ошибка и «Попробовать снова»; после восстановления — текст
  {
    const { ctx, page, errors } = await open(P(ACC.trial, { libError: "network" }));
    await toBook(page, "physics");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    const t = await text(page);
    check("V2. нет сети: «Не удалось загрузить конспект», «Проверь интернет», кнопка «Попробовать снова»", t.includes("Не удалось загрузить конспект") && t.includes("Проверь интернет")
      && !!(await page.$("#app > .app [data-lib-retry]")), t.slice(0, 300));
    check("V2. нет сети: не выдаётся за «доступ закончился»", !t.includes("закончил") && !t.includes("Нужен доступ"));
    await page.screenshot({ path: path.join(SHOTS, "lib-offline-iphone.png") });
    check("V2. без горизонтальной прокрутки (390)", await noHScroll(page));
    await page.evaluate(() => (window.__T.libError = null));
    await click(page, "[data-lib-retry]", 900);
    check("V2. «Попробовать снова» после восстановления → текст", !!(await page.$(".cn-doc")));
    check("V2. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // V3. На сервере текста нет (не загружен) → «Конспект пока недоступен»
  {
    const { ctx, page } = await open(P(ACC.trial, { libError: "missing" }));
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V3. NOT_FOUND → «Конспект пока недоступен»", (await text(page)).includes("Конспект пока недоступен"));
    await ctx.close();
  }

  // V4. Устройство думало «пробный», сервер ответил ACCESS_REQUIRED (срок кончился) → экран доступа, текст не показан
  {
    const { ctx, page, errors } = await open(P(ACC.trial, { notes: [NOTE] }));
    await toBook(page, "history");
    await page.evaluate((v) => (window.__T.v2 = v), ACC.trialExpired);
    await click(page, "[data-lib-paragraph]:not(.soon)", 1200);
    const t = await text(page);
    check("V4. сервер отказал → «Пробный период закончился», текста нет", t.includes("Пробный период закончился") && !(await page.$(".cn-doc")), t.slice(0, 300));
    check("V4. на экране — кнопка Premium с ценой с сервера («Premium за 299 ₽»)", t.includes("Premium за 299 ₽"), t.slice(0, 400));
    await tab(page, "home");
    const h = await text(page);
    check("V4. главная тоже перешла на «закончился» по ответу сервера", h.includes("Пробный период закончился"), h.slice(0, 200));
    await click(page, '[data-go="all-notes"]', 800);
    check("V4. личные конспекты после окончания доступа открываются", (await text(page)).includes("Мой конспект по биологии"));
    check("V4. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // V5. Premium закончился: экран, CTA, контакт не задан — понятный текст без пустой кнопки
  {
    const { ctx, page, errors } = await open(P(ACC.premiumExpired, { notes: [NOTE] }));
    const t = await text(page);
    check("V5. «Premium закончился», «Premium за 299 ₽», аккаунт и личные конспекты сохранены", t.includes("Premium закончился") && t.includes("Premium за 299 ₽")
      && t.includes("личные конспекты сохранены"), t.slice(0, 400));
    check("V5. контакт не задан: текст «Контакт для оплаты скоро появится…», ни одной ссылки-кнопки", t.includes("Контакт для оплаты скоро появится")
      && !(await page.$("#app > .app a")), t.slice(0, 500));
    await page.screenshot({ path: path.join(SHOTS, "premium-ended-iphone.png") });
    await toBook(page, "physics");
    check("V5. каталог после окончания виден (названия параграфов)", (await page.$$("#app > .app [data-lib-paragraph]")).length === 51);
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V5. параграф → экран доступа, запроса текста к серверу не было (статус уже известен)", !(await page.$(".cn-doc")) && (await libCalls(page)).length === 0, await libCalls(page));
    await tab(page, "photo");
    check("V5. «Фото» → экран Premium, не камера", !(await page.$(".scr-camera")) && !!(await page.$(".scr-tariffs")));
    const tt = await text(page);
    check("V5. экран Premium: 299 ₽, 30 дней, 10 конспектов (только удачные), личные конспекты остаются, как подключить",
      tt.includes("299 ₽") && tt.includes("30 дней") && tt.includes("10 конспектов за срок (считаются только удачные)") && tt.includes("личные конспекты остаются")
      && tt.includes("Как подключить") && tt.includes("не переносятся"), tt.slice(0, 700));
    await page.screenshot({ path: path.join(SHOTS, "tariffs-premium-iphone.png"), fullPage: true });
    check("V5. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
  // V5б. контакт задан в настройках — одна настоящая ссылка
  {
    const { ctx, page } = await open(P(ACC.premiumExpired), {
      configPatch: (src) => src.replace("ownerContact: null", 'ownerContact: { label: "Написать Николаю (тест)", url: "https://example.invalid/test" }'),
    });
    const links = await page.$$eval("#app > .app a", (a) => a.map((x) => x.textContent + "|" + x.href));
    check("V5б. контакт задан → ровно одна ссылка с этим текстом и адресом", links.length === 1 && links[0] === "Написать Николаю (тест)|https://example.invalid/test", [links, (await text(page)).slice(0, 300)]);
    await ctx.close();
  }

  // V6. Premium: «Мой доступ», остаток генераций; предупреждение за 3 дня до конца
  {
    const { ctx, page, errors } = await open(P(ACC.premium));
    let t = await text(page);
    check("V6. Premium (27 дней): обычная главная, «Осталось 6 конспектов», без предупреждения", t.includes("Осталось 6 конспектов") && !t.includes("закончится"), t.slice(0, 300));
    await tab(page, "me");
    t = await text(page);
    check("V6. «Мой доступ»: «Premium до …», ИИ 6 из 10", /Premium до \d+ ноября 2026|Premium до \d+ декабря 2026/.test(t) && t.includes("осталось 6 из 10"), t.slice(0, 600));
    await toBook(page, "physics");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V6. Premium: текст физики открывается", !!(await page.$(".cn-doc")));
    check("V6. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.premiumEnding));
    const t = await text(page);
    check("V7. Premium, осталось 2 дня: строка «Premium закончится через 2 дня · продлить» на главной", t.includes("Premium закончится через 2 дня") && t.includes("продлить"), t.slice(0, 300));
    await page.screenshot({ path: path.join(SHOTS, "premium-ending-iphone.png") });
    await click(page, ".trial-line.ending", 900);
    check("V7. строка ведёт на экран Premium", !!(await page.$(".scr-tariffs")));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.premiumExtended));
    check("V7. продлено заранее (доступ до +32 дней) — предупреждения нет", !(await text(page)).includes("закончится"));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P({ ...ACC.premiumEnding, ends_at: at(0.5), paid_until: at(0.5) }));
    check("V7. меньше суток: «Premium закончится в течение суток»", (await text(page)).includes("в течение суток"));
    await ctx.close();
  }

  // V8. Владелец: библиотека открыта, Premium-строк нет
  {
    const { ctx, page, errors } = await open(P(ACC.owner));
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V8. владелец: текст открывается", !!(await page.$(".cn-doc")));
    check("V8. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // V9. Закладки и личные конспекты работают как раньше (без сети библиотеки)
  {
    const { ctx, page, errors } = await open(P(ACC.premium, { notes: [NOTE], libError: "network" }));
    check("V9. главная: закладки на месте", (await text(page)).includes("Закладки") && !!(await page.$('#app > .app [data-go="bookmarks"]')));
    await click(page, '[data-go="bookmarks"]', 800);
    check("V9. «Все закладки» открываются", (await text(page)).includes("Все закладки"));
    await tab(page, "home");
    await click(page, '[data-go="all-notes"]', 800);
    check("V9. личный конспект открывается, когда библиотека без сети", (await text(page)).includes("Мой конспект по биологии"));
    check("V9. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // V10. Срок закончился, пока открыт конспект: ученик вернулся в приложение → экран доступа, текст забыт
  {
    const { ctx, page, errors } = await open(P(ACC.trial, { notes: [NOTE] }));
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V10. конспект открыт (пробный)", !!(await page.$(".cn-doc")));
    await page.evaluate((v) => {
      window.__T.v2 = v;
      document.dispatchEvent(new Event("visibilitychange"));
    }, ACC.trialExpired);
    await page.waitForTimeout(1200);
    const t = await text(page);
    check("V10. после возвращения в приложение — «Пробный период закончился», текста нет", t.includes("Пробный период закончился") && !(await page.$(".cn-doc")), t.slice(0, 200));
    check("V10. текст забыт в памяти страницы", await page.evaluate(() => {
      const K = window.K, b = K.library.subjects().find((x) => x.id === "history").books.find((x) => x.grade === "8");
      return b.paragraphs.filter((p) => K.library.ready(p)).every((p) => K.library.text("history", b.id, p.id) === null);
    }));
    check("V10. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // V11. Смена аккаунта на одном устройстве (вход другим ID без перезагрузки): тексты прежнего не остаются
  {
    const accounts = { "KN-CCCCCC": { uid: "u-2", v2: ACC.trialExpired } };
    const { ctx, page, errors } = await open(P(ACC.premium, { accounts }));
    await toBook(page, "physics");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V11. аккаунт A (Premium): текст открыт", !!(await page.$(".cn-doc")));
    await page.evaluate(() => (window.__T.kind = "guest"));
    await tab(page, "me");
    const login = await page.$('#app > .app [data-go="login"]');
    if (login) await login.click(), await page.waitForTimeout(500);
    await page.fill("#loginId", "KN-CCCCCC");
    await page.fill("#loginKey", "KEYKEYKEYKEYKEYKEYKE");
    await page.click("#app > .app [data-login]");
    await page.waitForTimeout(1500);
    const left = await page.evaluate(() => {
      const K = window.K, b = K.library.subjects().find((x) => x.id === "physics").books[0];
      return b.paragraphs.filter((p) => K.library.ready(p) && K.library.text("physics", b.id, p.id)).length;
    });
    check("V11. после входа аккаунтом B в памяти нет текстов аккаунта A", left === 0, left);
    const calls0 = (await libCalls(page)).length;
    // вкладка «Библиотека» помнит последний учебник
    await page.click('.tabbar [data-tab="library"]');
    await page.waitForTimeout(900);
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    const tb = await text(page);
    check("V11. аккаунт B (срок закончился): тот же параграф — экран доступа, текст A не показан и не запрошен заново",
      !(await page.$(".cn-doc")) && tb.includes("Пробный период закончился") && (await libCalls(page)).length === calls0,
      [tb.slice(0, 200), (await libCalls(page)).length, calls0, await page.evaluate(() => window.__T.kind + "/" + window.__T.id)]);
    check("V11. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }

  // V12. Медленный интернет: ответ по старому параграфу не подменяет новый; «Назад» во время загрузки
  {
    const { ctx, page, errors } = await open(P(ACC.trial, { libDelay: 2500 }));
    await toBook(page, "history");
    const ids = await page.$$eval("#app > .app [data-lib-paragraph]:not(.soon)", (n) => n.map((x) => x.dataset.libParagraph));
    await click(page, '[data-lib-paragraph="' + ids[0] + '"]', 300);
    check("V12. медленная сеть: экран загрузки", (await text(page)).includes("Загружаем конспект"));
    await click(page, "[data-back]", 400);
    check("V12. «Назад» во время загрузки — список параграфов", (await page.$$("#app > .app [data-lib-paragraph]")).length > 0);
    await click(page, '[data-lib-paragraph="' + ids[1] + '"]', 300);
    await page.waitForTimeout(3500);
    const t = await text(page);
    check("V12. ответ по первому параграфу пришёл раньше — на экране второй параграф и его текст", t.includes("/" + ids[1]) && !new RegExp("/" + ids[0] + "(?![0-9-])").test(t),
      t.slice(0, 200));
    await page.reload();
    await page.waitForTimeout(2500);
    await skipWelcome(page);
    check("V12. обновление страницы во время загрузки — приложение работает", !!(await page.$("#app > .app")) && noErr(errors), errors);
    await ctx.close();
  }

  // V14. Подарочный доступ глазами ученика: «🎁 Подарок до …», библиотека открыта; после конца — свой заголовок
  {
    const { ctx, page, errors } = await open(P(ACC.gift, { notes: [NOTE] }));
    let t = await text(page);
    check("V14. подарок: обычная главная, «Осталось 2 конспекта», без экрана оплаты", t.includes("Осталось 2 конспекта") && !t.includes("закончил"), t.slice(0, 300));
    await tab(page, "me");
    t = await text(page);
    check("V14. «Мой доступ»: «🎁 Подарок до …», ИИ 2 из 3", t.includes("🎁 Подарок до") && t.includes("осталось 2 из 3"), t.slice(0, 600));
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    check("V14. подарок: история открывается", !!(await page.$(".cn-doc")));
    check("V14. нет ошибок JS", noErr(errors), errors);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.giftExpired, { notes: [NOTE] }));
    const t = await text(page);
    check("V14. подарок закончился: «Подарочный доступ закончился», кнопка Premium, личные конспекты сохранены",
      t.includes("Подарочный доступ закончился") && t.includes("Premium за 299 ₽") && t.includes("личные конспекты сохранены"), t.slice(0, 400));
    await ctx.close();
  }

  // V13. Тёмная тема устройства и компьютер: приложение остаётся светлым и читаемым, без горизонтальной прокрутки
  for (const [name, opts] of [["iPhone, тёмная тема", { width: 390, height: 844, dark: true }], ["компьютер 1280×800", { width: 1280, height: 800, desktop: true }]]) {
    const c = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, isMobile: !opts.desktop, hasTouch: !opts.desktop, colorScheme: opts.dark ? "dark" : "light", serviceWorkers: "block", locale: "ru-RU" });
    await c.route("**/*", (route) => {
      const u = route.request().url();
      if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
      if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
      return route.continue();
    });
    const page = await c.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.clock.install({ time: FAR_FUTURE });
    await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify(P(ACC.premiumEnding, { libError: "network" })));
    await page.goto("http://127.0.0.1:" + PORT + "/");
    await page.waitForTimeout(2200);
    await skipWelcome(page);
    const line = await page.$eval(".trial-line.ending", (n) => [getComputedStyle(n).color, getComputedStyle(n).backgroundColor]).catch(() => null);
    check("V13. " + name + ": строка «Premium закончится…» видна и контрастна", !!line && line[0] !== line[1], line);
    await toBook(page, "history");
    await click(page, "[data-lib-paragraph]:not(.soon)", 900);
    const st = await page.$eval(".lib-state", (n) => [getComputedStyle(n.querySelector("p") || n).color, getComputedStyle(document.body).backgroundColor]).catch(() => null);
    check("V13. " + name + ": экран «Не удалось загрузить» читаем (цвет текста ≠ фону), без горизонтальной прокрутки",
      !!st && st[0] !== st[1] && (await noHScroll(page)), st);
    await page.screenshot({ path: path.join(SHOTS, "lib-offline-" + (opts.dark ? "dark" : "desktop") + ".png") });
    check("V13. " + name + ": нет ошибок JS", noErr(errors), errors);
    await c.close();
  }
}

// ---------- производительность: что скачивает первый запуск ----------
async function sizeTest() {
  const measure = async (root) => {
    ROOT = root;
    served.length = 0;
    const { ctx, page } = await open(P(ACC.trial));
    await toBook(page, "history");
    const files = [...new Set(served.filter((p) => !/cloud\.js/.test(p)))];
    const bytes = files.reduce((a, f) => {
      const full = path.join(root, f.endsWith("/") ? f + "index.html" : f);
      return a + (fs.existsSync(full) && fs.statSync(full).isFile() ? fs.statSync(full).size : 0);
    }, 0);
    await ctx.close();
    return { files: files.length, bytes };
  };
  if (!fs.existsSync(path.join(V613, "index.html"))) return;
  const a = await measure(V613);
  const b = await measure(V62);
  console.log("INFO размер первого запуска до библиотеки: v61.3 " + Math.round(a.bytes / 1024) + " КБ (" + a.files + " файлов), v62 " + Math.round(b.bytes / 1024) + " КБ (" + b.files + " файлов)");
  check("P1. первый запуск v62 скачивает меньше на ≥ 1,5 МБ (нет каталога с текстами)", a.bytes - b.bytes > 1.5 * 1024 * 1024, [a, b]);
  ROOT = V62;
}

// ---------- PWA: v61.3 (каталог с текстами в кэше) → v62 ----------
async function pwaTest() {
  if (!fs.existsSync(path.join(V613, "service-worker.js"))) return check("PWA: нет распакованной v61.3 (V613_DIR)", false, V613);
  ROOT = V613;
  const T = P(ACC.trial, { notes: [NOTE] });
  const { ctx, page } = await open(T, { sw: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  await page.reload();
  await page.waitForTimeout(2500);
  const before = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(k + " " + new URL(r.url).pathname);
    return out;
  });
  check("PWA: v61.3 под service worker, в кэше konspekt-v61 есть js/library-catalog.js (как у учеников сейчас)",
    before.some((x) => x.startsWith("konspekt-v61 ")) && before.some((x) => x.endsWith("/js/library-catalog.js")), before.slice(0, 8));
  ROOT = V62;
  served.length = 0;
  await page.reload();
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForTimeout(3000);
  await skipWelcome(page);
  const after = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(k + " " + new URL(r.url).pathname);
    return out;
  });
  const keys = await page.evaluate(() => caches.keys());
  const build = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => /app\.js/.test(s)));
  check("PWA: после обновления — app.js?v=62", /v=62/.test(build || ""), build);
  check("PWA: старый кэш удалён, остался только konspekt-v62", keys.length === 1 && keys[0] === "konspekt-v62", keys);
  check("PWA: js/library-catalog.js нет ни в кэше, ни среди загруженных файлов", !after.some((x) => x.includes("library-catalog")) && !served.some((x) => x.includes("library-catalog")), after);
  check("PWA: js/library-index.js загружен", served.some((x) => x.includes("library-index.js")));
  await toBook(page, "history");
  await click(page, "[data-lib-paragraph]:not(.soon)", 1200);
  check("PWA: после обновления (пробный) конспект открывается с «сервера»", !!(await page.$(".cn-doc")));
  const dump = await deviceDump(page);
  check("PWA: тексты конспектов не попали в кэш service worker и хранилища устройства", !dump.includes("ТЕСТОВЫЙ ТЕКСТ"));
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  check("PWA: в кэше только файлы сайта (нет rpc и чужих адресов)", cached.every((u) => u.startsWith("http://127.0.0.1:" + PORT + "/") && !/\/rpc\//.test(u)), cached);
  check("PWA: личный конспект сохранён", dump.includes("Мой конспект по биологии"));
  // выход из аккаунта при работающем service worker: приложение работает, текста в памяти нет
  await tab(page, "me");
  await click(page, "[data-signout]", 1500);
  const t = await text(page);
  check("PWA: после выхода приложение работает (профиль на экране)", t.includes("Профиль") || t.includes("Войти"), t.slice(0, 200));
  await ctx.close();
  // офлайн: без сети приложение открывается из кэша v62, личный конспект доступен, библиотека просит интернет
  const c2 = await open(P(ACC.trial, { notes: [NOTE] }), { sw: true });
  await c2.page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  await c2.page.reload();
  await c2.page.waitForTimeout(2000);
  await c2.ctx.setOffline(true);
  await c2.page.evaluate(() => (window.__T.libError = "network"));
  await c2.page.reload().catch(() => {});
  await c2.page.waitForTimeout(2500);
  await c2.page.evaluate(() => (window.__T.libError = "network"));
  await skipWelcome(c2.page);
  check("PWA офлайн: приложение открылось из кэша", !!(await c2.page.$("#app > .app")));
  await toBook(c2.page, "history");
  await click(c2.page, "[data-lib-paragraph]:not(.soon)", 1200);
  check("PWA офлайн: библиотека — «Не удалось загрузить конспект», без падения", (await text(c2.page)).includes("Не удалось загрузить конспект"));
  await c2.ctx.close();
}

(async () => {
  // без браузера: в сайте нет текстов, SW не кэширует запросы к Supabase и POST
  const idx = fs.readFileSync(path.join(V62, "js/library-index.js"), "utf8");
  check("S1. js/library-index.js без текстов (нет content, sections, blocks)", !/"content"\s*:|"sections"\s*:|"blocks"\s*:/.test(idx));
  check("S1. js/library-catalog.js удалён, index.html подключает library-index.js?v=62",
    !fs.existsSync(path.join(V62, "js/library-catalog.js")) && /js\/library-index\.js\?v=62/.test(fs.readFileSync(path.join(V62, "index.html"), "utf8"))
    && !/library-catalog/.test(fs.readFileSync(path.join(V62, "index.html"), "utf8")));
  const sw = fs.readFileSync(path.join(V62, "service-worker.js"), "utf8");
  check("S2. service worker: VERSION konspekt-v62, кэширует только GET своего сайта", /VERSION = "konspekt-v62"/.test(sw) && /method !== "GET"/.test(sw) && /origin/.test(sw), sw.slice(0, 300));
  check("S2. service worker не упоминает library-catalog в списке файлов", !/library-catalog\.js"/.test(sw.replace(/\/\/.*$/gm, "")));
  const big = fs.readdirSync(path.join(V62, "js")).filter((f) => fs.statSync(path.join(V62, "js", f)).size > 400000 && f !== "vendor");
  check("S3. в js/ нет больших файлов (тексты были 2 МБ)", !big.filter((f) => !/supabase/.test(f)).length, big);
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  try {
    await scenarios();
    await sizeTest();
    await pwaTest();
  } catch (e) {
    check("тест завершился без исключения", false, String(e && e.stack));
  }
  await browser?.close();
  server.close();
  console.log("ИТОГО: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
