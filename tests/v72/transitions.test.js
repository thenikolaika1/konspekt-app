// v72.1: стабильность переходов на компьютере — покадрово (каждый кадр requestAnimationFrame), а не только конечный снимок.
// Во время перехода заголовки, «Назад» и боковая панель не сдвигаются ни в одном кадре, двойного слоя (уходящий экран под новым)
// нет, экран не «перелистывается» (transform); параграф: «Назад» и название стоят на месте и пока текст загружается, и после;
// окна открываются и закрываются на месте; быстрые повторные нажатия не оставляют лишних слоёв; телефон — прежнее перелистывание.
// Полосы прокрутки включены (как в Windows), сеть заменена заглушкой tests/v61/stub-cloud.js, ответ сервера — с задержкой.
//
// Запуск из корня репозитория:  node tests/v72/transitions.test.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
// задержка ответа сервера на текст параграфа — видно состояние «Загружаем конспект…»
const SLOW = ";(() => { const o = window.K.cloud.libraryParagraph; window.K.cloud.libraryParagraph = (...a) => new Promise((r) => setTimeout(r, 600)).then(() => o(...a)); })();";
const PORT = 8274, BASE = "http://127.0.0.1:" + PORT + "/konspekt-app/";
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
  console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 600)));
};
const at = (d) => new Date(Date.now() + d * 864e5).toISOString();
const GIFT = { status: "paid", kind: "paid", plan: "gift", plan_title: "Подарок", starts_at: at(-1), ends_at: at(29), paid_until: at(29), server_now: new Date().toISOString(), ai_quota: 3, ai_used: 1, ai_reserved: 0, ai_remaining: 2, ai_available: 2 };

// замер в странице: каждый кадр — положение отслеживаемых элементов текущего экрана, панели, слоёв и transform экрана
const SAMPLER = () => {
  window.__startSampling = (ms) => {
    const F = (window.__F = []);
    const t0 = performance.now();
    const r = (e) => (e ? (({ left, top, width, height }) => [Math.round(left), Math.round(top), Math.round(width), Math.round(height)])(e.getBoundingClientRect()) : null);
    const tick = () => {
      const app = document.querySelector("#app > .app");
      F.push({
        t: Math.round(performance.now() - t0),
        screen: app ? app.className : "",
        head: r(app?.querySelector(".top h1, .top h2, .top .ttl, .section-row h2, .lib-note-bar-t, .camera-top b, h1, h2")),
        back: r(app?.querySelector("[data-back]")),
        bar: r(document.querySelector(".tabbar:not([hidden])")),
        active: document.querySelector(".tabbar .tab.active")?.dataset.tab || null,
        ghosts: document.querySelectorAll(".screen-ghost").length,
        screens: document.querySelectorAll("#app > .app").length,
        tx: app ? getComputedStyle(app).transform : "none",
        sheet: r(document.querySelector(".overlay:not(.closing) .sheet, .overlay:not(.closing) .modal")),
        closing: r(document.querySelector(".overlay.closing .sheet, .overlay.closing .modal")),
      });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
};
const same = (a, b) => (!a && !b) || (a && b && a.every((v, i) => Math.abs(v - b[i]) <= 1));

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] }); // полосы прокрутки видны, как в Windows

  async function open(vp, extra = {}) {
    const mobile = vp.width < 600;
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, serviceWorkers: "block", locale: "ru-RU" });
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (/\/js\/cloud\.js/.test(u)) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB + SLOW });
      if (!u.startsWith("http://127.0.0.1:" + PORT)) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.addInitScript((t) => (window.__T = JSON.parse(t)), JSON.stringify({ kind: "participant", id: "KN-AAAAAA", uid: "u-1", v2: GIFT, ...extra }));
    await page.addInitScript(SAMPLER);
    await page.goto(BASE);
    await page.waitForTimeout(1300);
    for (let i = 0; i < 4; i++) {
      const b = await page.$(".welcome:not(.access) .primary");
      if (!b) break;
      await b.click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(500);
    return { ctx, page, errors };
  }

  // переход: нажатие → кадры 0…ms; возвращает кадры нового экрана
  async function transition(page, sel, ms = 450) {
    await page.evaluate((m) => window.__startSampling(m), ms);
    await page.locator(sel).filter({ visible: true }).first().click();
    await page.waitForTimeout(ms + 120);
    return page.evaluate(() => window.__F);
  }

  // на компьютере: в каждом кадре после нажатия — ни слоя уходящего экрана, ни transform; заголовок, «Назад»
  // и боковая панель с первого кадра нового экрана стоят там же, где в конце перехода
  function stable(name, F) {
    const last = F[F.length - 1];
    const fresh = F.filter((f) => f.screen === last.screen);
    const bad = [];
    for (const f of F) {
      if (f.ghosts) bad.push([f.t, "слой уходящего экрана"]);
      if (f.screens !== 1) bad.push([f.t, "экранов " + f.screens]);
      if (f.tx !== "none") bad.push([f.t, "transform " + f.tx]);
      if (!same(f.bar, F[0].bar)) bad.push([f.t, "панель", f.bar, F[0].bar]);
    }
    for (const f of fresh) {
      if (!same(f.head, last.head)) bad.push([f.t, "заголовок", f.head, last.head]);
      if (!same(f.back, last.back)) bad.push([f.t, "«Назад»", f.back, last.back]);
    }
    check(name + " — каждый кадр: ничего не сдвигается, один слой, панель на месте (" + F.length + " кадров)", bad.length === 0 && F.length >= 8, bad.slice(0, 6));
  }

  for (const [w, h] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    const name = w + "x" + h;
    const { ctx, page, errors } = await open({ width: w, height: h });
    const steps = [
      ["Главная → Готовые конспекты", ".lib-entry"],
      ["Библиотека → класс", '[data-lib-grade="7"]'],
      ["класс → предмет", '[data-lib-subject="physics"]'],
      ["предмет → учебник", '[data-lib-book="physics-7-engineers-1"]'],
    ];
    for (const [label, sel] of steps) stable(`[${name}] ${label}`, await transition(page, sel));

    // учебник → параграф: загрузка (600 мс) и текст — «Назад» и название на одном месте во всех кадрах
    const P1 = await transition(page, '[data-lib-paragraph="physics-7-p34"]', 1100);
    stable(`[${name}] учебник → параграф (загрузка и текст)`, P1);
    const loading = P1.find((f) => f.t > 60 && f.t < 400), loaded = P1[P1.length - 1];
    check(`[${name}] параграф: «Назад» и название в состоянии «Загружаем конспект…» там же, где после загрузки текста`,
      loading && same(loading.back, loaded.back) && same(loading.head, loaded.head), [loading && loading.back, loaded.back, loading && loading.head, loaded.head]);
    stable(`[${name}] параграф → Назад`, await transition(page, "[data-back]"));
    stable(`[${name}] боковое меню: Библиотека → Главная`, await transition(page, '[data-tab="home"]'));
    stable(`[${name}] Главная → Новый конспект`, await transition(page, '[data-tab="photo"]'));
    stable(`[${name}] боковое меню: Новый конспект → Я (профиль)`, await transition(page, '[data-tab="me"]'));
    stable(`[${name}] боковое меню: Я → Библиотека`, await transition(page, '[data-tab="library"]'));
    stable(`[${name}] боковое меню: Библиотека → Главная`, await transition(page, '[data-tab="home"]'));

    // окно: открывается и закрывается на месте (по центру), не уезжает вниз
    const O = await transition(page, "[data-note-menu]", 400);
    const opened = O[O.length - 1].sheet;
    const moved = O.filter((f) => f.sheet && Math.abs(f.sheet[1] + f.sheet[3] / 2 - (opened[1] + opened[3] / 2)) > opened[3] * 0.03 + 2);
    check(`[${name}] окно открывается по центру на месте (без выезда снизу)`, opened && moved.length === 0 && Math.abs(opened[1] + opened[3] / 2 - h / 2) < h * 0.2, [opened, moved.slice(0, 3)]);
    await page.evaluate(() => window.__startSampling(400));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const C = await page.evaluate(() => window.__F);
    const fell = C.filter((f) => f.closing && f.closing[1] > opened[1] + 20);
    check(`[${name}] окно закрывается на месте (Esc), не уезжает вниз за край экрана`, fell.length === 0 && !(await page.$(".overlay")), fell.slice(0, 3));

    // быстрые повторные нажатия: вперёд-назад без пауз — один экран, без слоёв, панель на месте
    // (приложение намеренно пропускает нажатие, пришедшее раньше 200 мс после перехода, — защита от двойного открытия)
    const quick = (sel) => page.locator(sel).filter({ visible: true }).first().click({ timeout: 700 }).catch(() => {});
    for (let i = 0; i < 4; i++) {
      await quick(".lib-entry");
      await quick('[data-lib-grade="7"]');
      await page.keyboard.press("Escape");
      await quick('[data-tab="library"]');
      await quick('[data-tab="home"]');
    }
    await page.waitForTimeout(300);
    await quick('[data-tab="home"]');
    await page.waitForTimeout(400);
    const rapid = await page.evaluate(() => ({ screens: document.querySelectorAll("#app > .app").length, ghosts: document.querySelectorAll(".screen-ghost").length, home: !!document.querySelector(".scr-home"), bar: document.querySelector(".tabbar")?.getBoundingClientRect().left }));
    check(`[${name}] быстрые повторные нажатия: один экран, без лишних слоёв, Главная, панель на месте`, rapid.screens === 1 && rapid.ghosts === 0 && rapid.home && rapid.bar === 0, rapid);
    stable(`[${name}] повторное открытие «Готовые конспекты» после быстрых нажатий`, await transition(page, ".lib-entry"));
    check(`[${name}] нет ошибок JavaScript`, errors.length === 0, errors);
    await ctx.close();
  }

  // телефон: прежнее перелистывание (сдвиг и слой уходящего экрана) сохранено, ничего не сломано
  {
    const { ctx, page, errors } = await open({ width: 390, height: 844 });
    const F = await transition(page, ".lib-entry");
    check("[390x844] телефон: переход как раньше — новый экран въезжает (transform), уходящий виден под ним", F.some((f) => f.tx !== "none") && F.some((f) => f.ghosts === 1) && F[F.length - 1].ghosts === 0, F.slice(0, 3));
    const P = await transition(page, '[data-lib-grade="7"]');
    check("[390x844] телефон: следующий экран открывается, нижняя панель на месте", /lib/.test(P[P.length - 1].screen) && !!P[P.length - 1].bar, P[P.length - 1]);
    check("[390x844] нет ошибок JavaScript", errors.length === 0, errors);
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR " + (e && e.stack || e)); process.exit(2); });
