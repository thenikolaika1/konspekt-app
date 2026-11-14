// v66: экран продления доступа без слова Premium и без цены (Chromium, сервер — заглушка tests/v61/stub-cloud.js).
// Пробный, полный, подарочный, истёкший доступ, владелец; кнопка «Связаться с администратором»; цена с сервера не видна.
// Запуск: node tests/v66r/renewal.test.js   (ROOT=<папка> — проверить другую сборку, например v65 как негативный контроль)
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = process.env.ROOT || path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.resolve(__dirname, "../v61/stub-cloud.js"), "utf8");
const PORT = 8276;
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
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 400))); };
const NOW = "2026-11-14T09:00:00+03:00";
const at = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();
const ACC = {
  trial: { status: "trial", kind: "trial", plan: null, starts_at: at(-1), ends_at: at(6), server_now: NOW, ai_quota: 3, ai_used: 0, ai_reserved: 0, ai_remaining: 3, ai_available: 3 },
  trialExpired: { status: "expired", kind: "trial", plan: null, starts_at: at(-8), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  paid: { status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-3), ends_at: at(27), paid_until: at(27), server_now: NOW, ai_quota: 10, ai_used: 4, ai_reserved: 0, ai_remaining: 6, ai_available: 6 },
  paidEnding: { status: "paid", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-28), ends_at: at(2), paid_until: at(2), server_now: NOW, ai_quota: 10, ai_used: 9, ai_reserved: 0, ai_remaining: 1, ai_available: 1 },
  paidExpired: { status: "expired", kind: "paid", plan: "premium", plan_title: "Premium", starts_at: at(-31), ends_at: at(-1), revoked: false, server_now: NOW, ai_quota: 0, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
  gift: { status: "paid", kind: "paid", plan: "gift", plan_title: "Подарок", starts_at: at(-1), ends_at: at(29), paid_until: at(29), server_now: NOW, ai_quota: 3, ai_used: 1, ai_reserved: 0, ai_remaining: 2, ai_available: 2 },
  owner: { status: "owner", kind: "owner", plan: null, starts_at: at(-1), ends_at: null, server_now: NOW, ai_quota: null, ai_used: 0, ai_reserved: 0, ai_remaining: null, ai_available: null },
};
// сервер ещё присылает название «Premium» и цену — интерфейс не должен показывать ни то, ни другое
const PLANS = [{ code: "premium", title: "Premium", days: 30, ai_quota: 10, price_label: "299 ₽", description: "Premium за 299 ₽" }];
const FORBIDDEN = /premium|премиум|₽|руб|\b299\b|цена|стоимост/i;
const P = (v2, extra) => ({ kind: "participant", id: "KN-AAAAAA", uid: "u-1", v2, plans: PLANS, ...extra });
let browser;
async function open(T, vp = { width: 390, height: 844 }) {
  const mobile = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: "ru-RU" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:" + PORT });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
    if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify(T));
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForTimeout(1800);
  for (let i = 0; i < 4; i++) {
    const b = await page.$(".welcome:not(.access) .primary");
    if (!b) break;
    await b.click();
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}
const text = (page) => page.evaluate(() => (document.querySelector("#app > .app")?.innerText || "").replace(/ /g, " ").replace(/\s+/g, " "));
const screenName = (page) => page.evaluate(() => document.querySelector("#app > .app")?.className || "");
async function tab(page, id) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.$eval(".tabbar", (n) => n.hidden).catch(() => true))) break;
    const back = page.locator("#app > .app [data-back]:visible").first();
    if (!(await back.count())) break;
    await back.click();
    await page.waitForTimeout(500);
  }
  await page.click('.tabbar [data-tab="' + id + '"]');
  await page.waitForTimeout(650);
}
const seen = []; // все тексты, которые увидел ученик, — для общей проверки «нет Premium и цены»
const look = async (page, where) => { const t = await text(page); seen.push([where, t]); return t; };
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch();

  // 1. Пробный период идёт — экрана продления нет, на главной строка с днями
  {
    const { ctx, page, errors } = await open(P(ACC.trial));
    const home = await look(page, "trial/home");
    check("1. пробный период идёт: главная, а не экран окончания; строка «Пробный период: осталось 6 дней»", !/Пробный период завершён|Связаться с администратором/.test(home) && /Пробный период: осталось 6 дней/.test(home), home.slice(0, 200));
    await tab(page, "me");
    const prof = await look(page, "trial/profile");
    check("1. профиль: «Пробный период до …», кнопка «Продление доступа»", /Пробный период до/.test(prof) && /Продление доступа/.test(prof), prof.slice(0, 300));
    await page.click('#app > .app [data-go="tariffs"]');
    await page.waitForTimeout(800);
    const tar = await look(page, "trial/tariffs");
    check("1. экран продления: заголовок «Продление доступа», «На 30 дней», блок «Связаться с администратором», подпись об условиях",
      /Продление доступа/.test(tar) && /На 30 дней/.test(tar) && /Связаться с администратором/.test(tar) && /Капустину Николаю/.test(tar) && /Условия продления обсуждаются индивидуально\./.test(tar), tar.slice(0, 400));
    check("1. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // 2. Пробный период закончился — экран по образцу владельца, кнопка ведёт к связи с администратором
  for (const [name, vp] of [["390", { width: 390, height: 844 }], ["320", { width: 320, height: 640 }], ["1100", { width: 1100, height: 860 }]]) {
    const { ctx, page, errors } = await open(P(ACC.trialExpired), vp);
    const t = await look(page, "trialExpired/" + name);
    const h1 = await page.$eval("#app > .app h1", (n) => n.textContent).catch(() => "");
    check(`2 [${name}]. заголовок «Пробный период завершён»`, h1 === "Пробный период завершён", h1);
    check(`2 [${name}]. описание точно по тексту`, t.includes("Бесплатный доступ к Konspekt закончился. Чтобы продолжить пользоваться приложением, продлите доступ."), t.slice(0, 300));
    check(`2 [${name}]. блок «Продление доступа» / «На 30 дней»`, (await page.$eval("#app > .app .renew-card", (n) => n.innerText.replace(/ /g, " ").replace(/\s+/g, " ").trim()).catch(() => "")) === "Продление доступа На 30 дней");
    const btn = await page.$eval("#app > .app .ended-actions .primary", (n) => n.textContent).catch(() => "");
    check(`2 [${name}]. основная кнопка «Связаться с администратором», под ней «Условия продления обсуждаются индивидуально.»`,
      btn === "Связаться с администратором" && (await page.$eval("#app > .app .ended-actions .renew-note", (n) => n.textContent).catch(() => "")) === "Условия продления обсуждаются индивидуально.", btn);
    check(`2 [${name}]. аккаунт и конспекты сохранены — сообщение на месте; без горизонтальной прокрутки`, /личные конспекты сохранены/.test(t) && (await noHScroll(page)));
    if (name === "390") {
      await page.click("#app > .app .ended-actions [data-contact]");
      await page.waitForTimeout(900);
      const tar = await look(page, "trialExpired/contact");
      const inView = await page.evaluate(() => { const r = document.querySelector("#renewContact")?.getBoundingClientRect(); return !!r && r.top >= -2 && r.top < innerHeight * 0.6; });
      check("2. кнопка открывает экран продления сразу на блоке «Связаться с администратором» (блок вверху экрана)", (await screenName(page)).includes("tariffs-screen") && inView, { inView });
      check("2. блок связи: администратор Капустин Николай, ID ученика, «Скопировать ID»", /Капустину Николаю/.test(tar) && /Ваш ID: KN-AAAAAA/.test(tar) && !!(await page.$("#app > .app [data-copy-id]")), tar.slice(0, 400));
      await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
      await page.click("#app > .app [data-copy-id]");
      await page.waitForTimeout(300);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      check("2. «Скопировать ID» копирует ID ученика (ключ входа не копируется) и пишет «ID скопирован»", clip === "KN-AAAAAA" && /ID скопирован/.test(await text(page)), clip);
      await page.locator("#app > .app [data-back]:visible").first().click();
      await page.waitForTimeout(700);
      check("2. «Назад» возвращает к экрану окончания доступа", /Пробный период завершён/.test(await text(page)));
    }
    check(`2 [${name}]. нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }

  // 3. Полный доступ действует / заканчивается / истёк; подарок; владелец
  {
    const { ctx, page, errors } = await open(P(ACC.paid));
    check("3. полный доступ действует: главная, не экран окончания", !/Связаться с администратором|Срок доступа истёк/.test(await look(page, "paid/home")));
    await tab(page, "me");
    const prof = await look(page, "paid/profile");
    check("3. профиль: «Полный доступ до …», «Осталось 27 дней», кнопка «Продление доступа»", /Полный доступ до/.test(prof) && /Осталось 27 дней/.test(prof) && /Продление доступа/.test(prof), prof.slice(0, 300));
    check("3. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.paidEnding));
    const home = await look(page, "paidEnding/home");
    check("3. за 2 дня до конца: на главной «Полный доступ закончится через 2 дня · продлить»", /Полный доступ закончится через 2 дня · продлить/.test(home), home.slice(0, 300));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.paidExpired));
    const t = await look(page, "paidExpired/ended");
    const h1 = await page.$eval("#app > .app h1", (n) => n.textContent).catch(() => "");
    check("3. полный доступ истёк: «Срок доступа истёк», «Продление доступа / На 30 дней», «Связаться с администратором»",
      h1 === "Срок доступа истёк" && /Доступ к Konspekt закончился\. Чтобы продолжить пользоваться приложением, продлите доступ\./.test(t) && /На 30 дней/.test(t) && /Связаться с администратором/.test(t), [h1, t.slice(0, 200)]);
    await tab(page, "me");
    const prof = await look(page, "paidExpired/profile");
    check("3. профиль после окончания: «Доступ закончился», кнопка «Продлить доступ»", /Доступ закончился/.test(prof) && /Продлить доступ/.test(prof), prof.slice(0, 300));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.gift));
    await tab(page, "me");
    check("3. подарок: «🎁 Подарок до …»", /🎁 Подарок до/.test(await look(page, "gift/profile")));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.owner));
    const home = await look(page, "owner/home");
    check("3. владелец: экрана продления нет", !/Связаться с администратором|Продление доступа/.test(home));
    await ctx.close();
  }
  // 4. Гость без доступа — экран раннего доступа (как в v65), без экрана продления; ученик с пробным периодом — параграф библиотеки
  {
    const { ctx, page } = await open({ kind: "guest", uid: "guest-uid", v2: { status: "none", kind: null, server_now: NOW }, plans: PLANS });
    const t = await look(page, "guest/start");
    check("4. гость без доступа: экран раннего доступа, без «Пробный период завершён» и без экрана продления", /Ранний доступ/.test(t) && !/завершён|Связаться с администратором/.test(t), t.slice(0, 200));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(P(ACC.trial));
    await tab(page, "library");
    for (const sel of ['[data-lib-grade="8"]', '[data-lib-subject="history"]', "[data-lib-book]", "[data-lib-paragraph]:not(.soon)"]) {
      await page.click("#app > .app " + sel);
      await page.waitForTimeout(700);
    }
    const t = await look(page, "trial/library-paragraph");
    check("4. пробный период: параграф библиотеки открывается (экран продления не мешает)", /ТЕСТОВЫЙ ТЕКСТ/.test(t) && !/Связаться с администратором/.test(t), t.slice(0, 200));
    await ctx.close();
  }
  // 5. Нигде на экранах ученика нет слова Premium и цены (сервер их присылает)
  const bad = seen.filter(([, t]) => FORBIDDEN.test(t)).map(([w, t]) => w + ": " + (t.match(FORBIDDEN) || [""])[0]);
  check("5. на всех просмотренных экранах ученика (" + seen.length + ") нет «Premium», «₽», «руб», «299», «цена/стоимость»", seen.length >= 12 && bad.length === 0, bad);

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (Chromium)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
