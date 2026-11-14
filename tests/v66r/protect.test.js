// v66 (релиз): защита текста конспекта от простого копирования — Chromium, сеть заменена заглушкой
// (tests/v61/stub-cloud.js), Supabase и ИИ не вызываются. Проверяется: выделение, Ctrl/Cmd+C, Ctrl+Insert, Ctrl+A,
// контекстное меню, перетаскивание, печать, водяной знак (код по пользователю), поля ввода, владелец, история,
// прокрутка и масштаб, ширина 320 / 390 / 768.
// Safari/iOS и настоящее долгое нажатие на телефоне здесь не проверяются (только CSS-свойства, которые их отключают).
// Запуск: node tests/v66r/protect.test.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(__dirname, "../..");
const STUB = fs.readFileSync(path.join(ROOT, "tests/v61/stub-cloud.js"), "utf8");
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "konspekt-protect-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8268;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".json": "application/json" };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end();
  r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(r);
});
let pass = 0, fail = 0;
const check = (n, ok, x) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x).slice(0, 400)));
};
const NOW = "2026-11-10T15:00:00+03:00";
const at = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();
const ACC = {
  trial: { status: "trial", kind: "trial", plan: null, starts_at: at(-1), ends_at: at(6), server_now: NOW, ai_quota: 3, ai_used: 0, ai_reserved: 0, ai_remaining: 3, ai_available: 3 },
  owner: { status: "owner", kind: "owner", plan: null, starts_at: at(-1), ends_at: null, server_now: NOW, ai_quota: null, ai_used: 0, ai_reserved: 0, ai_remaining: null, ai_available: null },
};
const wmCode = (uid) => "KN-" + crypto.createHash("sha256").update("konspekt-wm:" + uid).digest("hex").slice(0, 8).toUpperCase();
const UID1 = "2f1c9d1e-6b1a-4c77-9a51-3e0b8f6a1c01", UID2 = "9a0e7c55-1d2b-4f0e-8c33-7b6d5e4f3a22";

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
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}
const click = async (page, sel, ms = 650) => (await page.click("#app > .app " + sel), page.waitForTimeout(ms));
async function toParagraph(page) {
  await page.click('.tabbar [data-tab="library"]');
  await page.waitForTimeout(650);
  await click(page, '[data-lib-grade="8"]');
  await click(page, '[data-lib-subject="history"]');
  await click(page, "[data-lib-book]");
  await click(page, "[data-lib-paragraph]:not(.soon)", 1200);
}
const clip = (page) => page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR:" + e));
const setClip = (page, s) => page.evaluate((x) => navigator.clipboard.writeText(x), s);
const docText = (page) => page.evaluate(() => document.querySelector(".cn-doc")?.innerText || "");
async function mouseSelect(page) {
  const box = await page.$eval(".cn-doc", (n) => {
    const r = n.getBoundingClientRect();
    return { x: r.left + 12, y: r.top + 12, w: r.width - 24, h: Math.min(r.height, 500) - 24 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w, box.y + box.h, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => String(window.getSelection()));
}
async function forceSelectDoc(page) {
  // выделение программно (как расширение браузера или «выделить всё») — затем копирование клавишами
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(".cn-doc"));
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
}

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch();

  // ---------- 1. ученик (пробный период): параграф библиотеки ----------
  {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-AAAAAA", uid: UID1, v2: ACC.trial, plans: [] }, { width: 1100, height: 900 });
    await toParagraph(page);
    const txt = await docText(page);
    check("1. параграф библиотеки открыт, текст на месте", /ТЕСТОВЫЙ ТЕКСТ/.test(txt), txt.slice(0, 120));
    const st = await page.$eval(".cn-doc", (n) => {
      const c = getComputedStyle(n);
      return { cls: n.className, us: c.userSelect, wus: c.webkitUserSelect, callout: c.webkitTouchCallout || "", pos: c.position };
    });
    check("1. область конспекта защищена: kn-protected, user-select: none (и -webkit-), -webkit-touch-callout: none (долгое нажатие iOS)",
      /kn-protected/.test(st.cls) && st.us === "none" && (st.wus === "none" || st.wus === "") && (st.callout === "none" || st.callout === ""), st);
    const wm = await page.evaluate(() => {
      const all = document.querySelectorAll(".kn-wm"), n = all[0];
      if (!n) return null;
      const sp = n.querySelector("span"), r = sp.getBoundingClientRect(), c = getComputedStyle(sp);
      return { count: all.length, code: n.dataset.wm, text: sp.textContent, aria: n.getAttribute("aria-hidden"), pe: getComputedStyle(n).pointerEvents,
        last: n === n.parentElement.lastElementChild, h: n.getBoundingClientRect().height, fs: parseFloat(c.fontSize), color: c.color,
        bottomGap: Math.round(innerHeight - r.bottom), visible: r.top >= 0 && r.bottom <= innerHeight, bg: c.backgroundImage };
    });
    check("1. водяной знак: ОДИН небольшой код KN- + SHA-256(konspekt-wm:uid)[0..8], последний в конспекте, нулевой высоты, скрыт от диктора, нажатия проходят насквозь",
      wm && wm.count === 1 && wm.code === wmCode(UID1) && wm.text === wm.code && wm.last && wm.h === 0 && wm.aria === "true" && wm.pe === "none" && wm.fs <= 12 && wm.bg === "none", wm);
    check("1. водяной знак полупрозрачный (не сплошной цвет)", wm && /rgba\(13, 23, 71, 0\.[1-4]\d*\)/.test(wm.color), wm && wm.color);
    check("1. в водяном знаке нет ID входа, email и самого uid", wm && !wm.code.includes("AAAAAA") && !wm.code.toLowerCase().includes(UID1.slice(0, 8)));
    // мышь
    const sel = await mouseSelect(page);
    check("2. выделение мышью по тексту конспекта ничего не выделяет", sel.trim() === "", sel.slice(0, 80));
    // Ctrl+C / Cmd+C / Ctrl+Insert после программного выделения
    for (const keys of ["Control+c", "Meta+c", "Control+Insert", "Control+x"]) {
      await setClip(page, "SENTINEL");
      await forceSelectDoc(page);
      await page.keyboard.press(keys);
      await page.waitForTimeout(150);
      const c = await clip(page);
      check("3. " + keys + " при выделенном тексте конспекта — текст в буфер обмена не попадает", !/ТЕСТОВЫЙ/.test(c), c.slice(0, 80));
    }
    // событие copy напрямую (меню браузера «Копировать», execCommand)
    await setClip(page, "SENTINEL");
    await forceSelectDoc(page);
    const exec = await page.evaluate(() => {
      document.execCommand("copy");
      return true;
    });
    const c2 = await clip(page);
    check("3. команда «Копировать» браузера (событие copy) — в буфер попадает пустая строка, не текст", exec && !/ТЕСТОВЫЙ/.test(c2), c2.slice(0, 80));
    // Ctrl+A
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.click(".cn-doc", { position: { x: 30, y: 30 } }).catch(() => {});
    await page.keyboard.press("Control+a");
    const all = await page.evaluate(() => String(window.getSelection()));
    check("3. Ctrl+A на экране конспекта не выделяет текст конспекта", !/ТЕСТОВЫЙ/.test(all), all.slice(0, 80));
    // контекстное меню и перетаскивание
    const ctxPrevented = await page.evaluate(() => {
      const t = document.querySelector(".cn-doc p, .cn-doc .cn-par, .cn-doc div:not(.kn-wm)");
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      t.dispatchEvent(e);
      const d = new Event("dragstart", { bubbles: true, cancelable: true });
      t.dispatchEvent(d);
      return [e.defaultPrevented, d.defaultPrevented];
    });
    check("4. контекстное меню и перетаскивание текста в области конспекта отменяются", ctxPrevented[0] && ctxPrevented[1], ctxPrevented);
    // печать
    await page.emulateMedia({ media: "print" });
    const pr = await page.evaluate(() => ({ disp: getComputedStyle(document.querySelector(".cn-doc")).display, txt: document.body.innerText }));
    await page.emulateMedia({ media: "screen" });
    check("5. печать экрана конспекта (Ctrl+P / меню браузера): текст конспекта не печатается", pr.disp === "none", pr.disp);
    const ctrlP = await page.evaluate(() => {
      const e = new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      const s = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(s);
      return [e.defaultPrevented, s.defaultPrevented];
    });
    check("5. Ctrl+P и Ctrl+S на экране конспекта перехвачены", ctrlP[0] && ctrlP[1], ctrlP);
    // экранный диктор: текст в дереве доступности остаётся
    const ax = await page.locator(".cn-doc").ariaSnapshot().catch(() => "");
    check("6. доступность: текст конспекта по-прежнему есть в дереве доступности (экранный диктор читает)", /ТЕСТОВЫЙ/.test(ax), ax.slice(0, 120));
    await page.screenshot({ path: path.join(SHOTS, "protect-desktop.png") });
    check("1. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 2. поле ввода (поиск по конспекту) и свой конспект-пример ----------
  {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-AAAAAA", uid: UID1, v2: ACC.trial, plans: [] }, { width: 1100, height: 900 });
    const card = await page.$("#app > .app .note-card[data-note]");
    check("7. история: на главной есть конспект (пример)", !!card);
    if (card) {
      await card.click();
      await page.waitForTimeout(900);
      const prot = await page.$(".cn-doc.kn-protected .kn-wm");
      check("7. свой конспект открывается из истории и тоже защищён (водяной знак на месте)", !!prot);
      await page.fill("#inNoteSearch", "клетка");
      await page.waitForTimeout(400);
      await page.focus("#inNoteSearch");
      await page.keyboard.press("Control+a");
      await setClip(page, "SENTINEL");
      await page.keyboard.press("Control+c");
      await page.waitForTimeout(150);
      const c = await clip(page);
      check("8. поле поиска: выделение и Ctrl+C работают как обычно (в буфере — введённый текст)", c === "клетка", c);
      const st = async () => page.evaluate(() => ({
        cnt: document.querySelector("#inNoteCount").textContent.trim(),
        marks: [...document.querySelectorAll("#noteDoc mark.cn-hit")].map((m) => m.textContent),
        cur: [...document.querySelectorAll("#noteDoc mark.cn-hit")].findIndex((m) => m.classList.contains("current")),
        bg: (() => { const m = document.querySelector("#noteDoc mark.cn-hit.current"); return m ? getComputedStyle(m).backgroundColor : ""; })(),
      }));
      // известное слово: самое частое слово конспекта длиной от 6 букв (берётся из настоящего текста, не из теста)
      const word = await page.evaluate(() => {
        const ws = (document.querySelector("#noteDoc").innerText.toLowerCase().match(/[а-яё]{6,}/g) || []);
        const f = {}; ws.forEach((w) => (f[w] = (f[w] || 0) + 1));
        return Object.entries(f).sort((a, b) => b[1] - a[1])[0][0];
      });
      const expected = await page.evaluate((w) => (document.querySelector("#noteDoc").innerText.toLowerCase().replace(/ё/g, "е").split(w.replace(/ё/g, "е")).length - 1), word);
      await page.fill("#inNoteSearch", word);
      await page.waitForTimeout(500);
      let r1 = await st();
      check("8. поиск: известное слово «" + word + "» находится — совпадений столько же, сколько в тексте, все подсвечены (mark.cn-hit), счётчик «1 из N»",
        expected > 0 && r1.marks.length === expected && r1.marks.every((m) => m.toLowerCase() === word) && r1.cnt === "1 из " + expected && r1.cur === 0, { word, expected, r1 });
      check("8. поиск: текущее совпадение выделено цветом (подсветка видна в защищённом тексте)", /255, 201, 77/.test(r1.bg), r1.bg);
      if (expected > 1) {
        await page.press("#inNoteSearch", "Enter");
        await page.waitForTimeout(500);
        const r2 = await st();
        check("8. поиск: Enter — переход к следующему совпадению (2 из N)", r2.cur === 1 && r2.cnt === "2 из " + expected, r2);
      }
      // запрос из двух слов через однобуквенный предлог: в тексте там неразрывный пробел
      const phrase = await page.evaluate(() => {
        const t = document.querySelector("#noteDoc").innerText;
        const m = t.match(/(?:^|[\s(«])([вскиуоа]\u00a0[а-яё]{4,})/i);
        return m ? m[1].replace(/\u00a0/g, " ") : "";
      });
      if (phrase) {
        await page.fill("#inNoteSearch", phrase);
        await page.waitForTimeout(500);
        const r3 = await st();
        check("8. поиск: фраза с однобуквенным предлогом («" + phrase + "») находится, хотя в тексте неразрывный пробел", r3.marks.length > 0 && /из/.test(r3.cnt), r3);
      } else check("8. поиск: в примере есть фраза с однобуквенным предлогом для проверки", false, "нет такой фразы");
      // ё / е
      const yoWord = await page.evaluate(() => (document.querySelector("#noteDoc").innerText.match(/[а-я]*ё[а-я]*/i) || [""])[0]);
      if (yoWord) {
        await page.fill("#inNoteSearch", yoWord.replace(/ё/g, "е"));
        await page.waitForTimeout(500);
        const r4 = await st();
        check("8. поиск: «" + yoWord.replace(/ё/g, "е") + "» находит «" + yoWord + "» (ё = е)", r4.marks.length > 0, r4);
      }
      await page.fill("#inNoteSearch", "щщщщзззз");
      await page.waitForTimeout(400);
      const r5 = await st();
      check("8. поиск: несуществующее слово — «Нет совпадений», подсветки нет", r5.marks.length === 0 && r5.cnt === "Нет совпадений", r5);
      await page.fill("#inNoteSearch", "");
      await page.waitForTimeout(300);
      const r6 = await st();
      check("8. поиск: очистка поля убирает подсветку и счётчик, текст конспекта не испорчен", r6.marks.length === 0 && r6.cnt === "", r6);
      // копирование найденного защищённого текста по-прежнему не работает
      await setClip(page, "SENTINEL");
      await page.fill("#inNoteSearch", word);
      await page.waitForTimeout(400);
      await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#noteDoc mark.cn-hit")); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await page.evaluate(() => document.querySelector("#noteDoc").focus?.());
      await page.click("#noteDoc", { position: { x: 5, y: 5 } }).catch(() => {});
      await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#noteDoc mark.cn-hit")); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await page.keyboard.press("Control+c");
      await page.waitForTimeout(150);
      check("8. найденное и подсвеченное слово Ctrl+C не копирует (защита не мешает поиску, поиск не обходит защиту)", (await clip(page)) === "SENTINEL", await clip(page));
      await page.click("#app > .app [data-back]");
      await page.waitForTimeout(800);
      check("7. «Назад» возвращает к истории", !!(await page.$("#app > .app .note-card[data-note]")));
    }
    check("7. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 2б. поиск в истории («Все конспекты»): ё/е, лишние пробелы, «Ничего не найдено» ----------
  {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-AAAAAA", uid: UID1, v2: ACC.trial, plans: [] });
    await page.click('#app > .app [data-go="all-notes"]');
    await page.waitForTimeout(700);
    const titles = async () => page.evaluate(() => [...document.querySelectorAll("#allList .note-card")].map((c) => c.querySelector("h3,.note-title,b,strong")?.textContent || c.textContent));
    const all = await titles();
    const target = all.find((t) => /Северная война/.test(t));
    check("8б. история: в списке «Все конспекты» есть конспекты (примеры), среди них «Северная война»", all.length >= 2 && !!target, all);
    const q = async (v) => (await page.fill("#noteSearch", v), await page.waitForTimeout(300), titles());
    const r1 = await q("северная");
    check("8б. поиск в истории: одно слово находит нужный конспект и только его", r1.length === 1 && /Северная война/.test(r1[0]), r1);
    const r2 = await q("  Сёверная    ВОЙНА ");
    check("8б. поиск в истории: ё вместо е, заглавные буквы и лишние пробелы — тот же конспект", r2.length === 1 && /Северная война/.test(r2[0]), r2);
    const r3 = await q("щщщщзззз");
    const empty = await page.evaluate(() => document.querySelector("#allList").innerText);
    check("8б. поиск в истории: несуществующее слово — «Ничего не найдено»", r3.every((t) => !/война/.test(t)) && /Ничего не найдено/.test(empty), empty);
    const r4 = await q("");
    check("8б. поиск в истории: пустой запрос — снова весь список", r4.length === all.length, r4.length);
    check("8б. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 3. другой ученик — другой код ----------
  {
    const { ctx, page } = await open({ kind: "participant", id: "KN-BBBBBB", uid: UID2, v2: ACC.trial, plans: [] });
    await toParagraph(page);
    const code = await page.$eval(".cn-doc .kn-wm", (n) => n.dataset.wm).catch(() => "");
    check("9. у другого ученика другой код водяного знака", code === wmCode(UID2) && code !== wmCode(UID1), [code, wmCode(UID2)]);
    await ctx.close();
  }

  // ---------- 4. владелец: без ограничений ----------
  {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-OWNER1", uid: "owner-uid", v2: ACC.owner, plans: [] }, { width: 1100, height: 900 });
    await toParagraph(page);
    const st = await page.$eval(".cn-doc", (n) => ({ cls: n.className, wm: !!n.querySelector(".kn-wm"), us: getComputedStyle(n).userSelect }));
    await setClip(page, "SENTINEL");
    await forceSelectDoc(page);
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(150);
    const c = await clip(page);
    check("10. владелец: конспект без защиты и водяного знака, Ctrl+C копирует текст (для работы с материалами)",
      !/kn-protected/.test(st.cls) && !st.wm && st.us !== "none" && /ТЕСТОВЫЙ/.test(c), { st, c: c.slice(0, 60) });
    check("10. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 5. ширина 320 / 390 / 768: вёрстка, прокрутка, масштаб ----------
  for (const w of [320, 390, 768]) {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-AAAAAA", uid: UID1, v2: ACC.trial, plans: [] }, { width: w, height: 760 });
    await toParagraph(page);
    const r = await page.evaluate(() => {
      const d = document.querySelector(".cn-doc"), m = d.querySelector(".kn-wm");
      const vp = document.querySelector('meta[name="viewport"]').content;
      return {
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        wmW: Math.round(m.getBoundingClientRect().width), dW: Math.round(d.getBoundingClientRect().width),
        spanIn: (() => { const r = m.querySelector("span").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.top >= 0; })(),
        zoomOk: !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(vp), touch: getComputedStyle(d).touchAction,
      };
    });
    check(`11. [${w}] без горизонтальной прокрутки, код водяного знака виден целиком на экране, масштаб пальцами не запрещён`,
      !r.hscroll && Math.abs(r.wmW - r.dW) < 2 && r.spanIn && r.zoomOk && r.touch !== "none", r);
    // прокрутка колесом/жестом над водяным знаком
    const y0 = await page.evaluate(() => scrollY);
    await page.evaluate(() => {
      const d = document.querySelector(".cn-doc");
      d.style.minHeight = "2400px"; // длинный конспект
    });
    await page.mouse.move(w / 2, 400);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
    const y1 = await page.evaluate(() => scrollY);
    check(`11. [${w}] прокрутка над текстом и водяным знаком работает`, y1 > y0, [y0, y1]);
    // нажатия по элементам внутри конспекта проходят сквозь водяной знак
    const through = await page.evaluate(() => {
      const d = document.querySelector(".cn-doc"), r = d.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top + 40, 120));
      return el && !el.classList.contains("kn-wm");
    });
    check(`11. [${w}] нажатия попадают в конспект, а не в водяной знак`, through);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(SHOTS, "protect-" + w + ".png") });
    check(`11. [${w}] нет ошибок JS`, errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 6. сервер ограничил частоту (RATE_LIMITED): понятное сообщение, а не «проверь интернет» ----------
  for (const [ra, want] of [[3600, "через час"], [86400, "На сегодня"]]) {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-AAAAAA", uid: UID1, v2: ACC.trial, plans: [], libError: "rate", libRetryAfter: ra });
    await toParagraph(page);
    const t = await page.evaluate(() => document.querySelector("#app > .app").innerText);
    check("12. лимит частоты (" + ra + " с): «Слишком много конспектов подряд», " + want + "; текста конспекта и «проверь интернет» нет",
      /Слишком много конспектов подряд/.test(t) && t.includes(want) && !/Проверь интернет|ТЕСТОВЫЙ/.test(t), t.slice(0, 300));
    check("12. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  // ---------- 7. дизайн не изменился: конспект ученика без водяного знака = конспект владельца пиксель в пиксель ----------
  {
    const shot = async (v2, uid, hideWm) => {
      const { ctx, page } = await open({ kind: "participant", id: "KN-AAAAAA", uid, v2, plans: [] });
      await toParagraph(page);
      if (hideWm) await page.addStyleTag({ content: ".kn-wm{display:none!important}" });
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);
      const buf = await page.locator(".cn-doc").screenshot({ animations: "disabled" });
      const bar = await page.locator(".note-bar").screenshot({ animations: "disabled" });
      const view = await page.screenshot({ animations: "disabled" });
      await ctx.close();
      const h = (b) => crypto.createHash("sha256").update(b).digest("hex");
      return [h(buf), h(bar), buf.length, h(view)];
    };
    const owner = await shot(ACC.owner, "owner-uid", false);
    const student = await shot(ACC.trial, UID1, true);
    const studentWm = await shot(ACC.trial, UID1, false);
    check("13. дизайн: конспект ученика (водяной знак скрыт) совпадает с конспектом владельца пиксель в пиксель; панель сверху — тоже",
      owner[0] === student[0] && owner[1] === student[1], { owner, student });
    check("13. водяной знак действительно рисуется на экране (снимок экрана со знаком отличается)", studentWm[3] !== student[3]);
  }

  // ---------- 8. долгое нажатие на телефоне ----------
  // Chromium без экрана не умеет выделять текст долгим нажатием даже без защиты (проверено: Input.dispatchTouchEvent
  // и Input.synthesizeTapGesture дают пустое выделение и в незащищённом тексте), поэтому сам жест здесь не
  // проверяется. Проверяется то, что его отключает: CSS (user-select/-webkit-touch-callout — проверка 1) и отмена
  // меню, которое браузер открывает по долгому нажатию (событие contextmenu от касания).
  {
    const { ctx, page, errors } = await open({ kind: "participant", id: "KN-AAAAAA", uid: UID1, v2: ACC.trial, plans: [] });
    await toParagraph(page);
    const r = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".cn-doc *")].find((n) => /ТЕСТОВЫЙ ТЕКСТ/.test(n.textContent) && !n.children.length);
      const e = new PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch" });
      el.dispatchEvent(e);
      const c = getComputedStyle(el);
      return { prevented: e.defaultPrevented, us: c.userSelect, callout: c.webkitTouchCallout || "" };
    });
    check("14. долгое нажатие: меню от касания отменяется, у текста user-select: none и -webkit-touch-callout: none (сам жест — только на устройстве)",
      r.prevented && r.us === "none" && (r.callout === "none" || r.callout === ""), r);
    // Chromium свойство -webkit-touch-callout не знает (вычисляется пустым) — поэтому отдельно проверяется само правило в styles.css
    const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
    check("14. в styles.css правило для iOS/Android: .cn-doc.kn-protected { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none }",
      /\.cn-doc\.kn-protected\{[^}]*-webkit-user-select:none;user-select:none;-webkit-touch-callout:none/.test(css));
    check("14. нет ошибок JS", errors.length === 0, errors);
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (Chromium; Safari/iOS не проверялись)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
