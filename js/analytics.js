/*
 * Аналитика P0: открытия приложения и библиотеки, сессии просмотра параграфов библиотеки
 * и «приблизительное активное время просмотра». Отправка — RPC public.track (js/cloud.js), сервер
 * сам определяет пользователя (auth.uid()) и ограничивает время. Без сети события копятся в localStorage.
 *
 * Что считается активным временем: экран параграфа виден (document.visibilityState = visible)
 * и с последнего касания / прокрутки / клавиши прошло не больше IDLE_MS. Фон, заблокированный экран,
 * бездействие и закрытое приложение не считаются. Это не доказательство чтения.
 *
 * Сессия просмотра — непрерывное пребывание на экране параграфа: уход на другой экран, вкладку или параграф
 * её завершает; фон до RESUME_MS — та же сессия, дольше — новая (и событие app_resume).
 * Отключение: K.config.analytics = false.
 *
 * Очередь у каждого пользователя своя (konspekt.analytics.v1:<uid>) и отправляется только с его сессией:
 * события одного аккаунта не уходят от имени другого. Накопленное без пользователя (первый запуск до входа)
 * получает первый вошедший; очередь прежних версий — пользователь сохранённой сессии этого устройства.
 */
(() => {
  const K = (window.K = window.K || {});
  const cfg = K.config || {};
  const cloud = K.cloud;
  const enabled = cfg.analytics !== false && !!(cloud && cloud.enabled && cloud.track);

  const LEGACY = "konspekt.analytics.v1";
  const NONE = "none";
  const qkey = (uid) => LEGACY + ":" + (uid || NONE);
  const TICK_MS = 5_000; // шаг учёта времени
  const FLUSH_MS = 60_000; // отправка накопленного, пока есть изменения
  const IDLE_MS = 120_000; // без касаний дольше — время не считается
  const RESUME_MS = 30 * 60_000; // фон дольше — новое «открытие приложения» и новая сессия просмотра
  const MAX_VIEW_S = 3600; // сервер тоже не примет больше
  const MAX_EVENTS = 200; // очередь событий приложения без сети
  const MAX_VIEWS = 100; // сессий просмотра в очереди
  const BATCH = 20; // событий в одном запросе (лимит сервера)
  const FLUSH_STUCK_MS = 30_000;

  // номер сборки — из ?v= своего тега (у всех скриптов он один; app.js к этому моменту ещё не подключён)
  const BUILD = ((document.currentScript || {}).src || "").match(/[?&]v=([0-9A-Za-z._-]{1,16})/)?.[1] || "";

  function uuid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  // очередь: события приложения и последнее состояние каждой сессии просмотра (v — версия, sv — отправленная)
  function read(k) {
    try {
      const x = JSON.parse(localStorage.getItem(k) || "null");
      if (x && Array.isArray(x.ev) && x.views && typeof x.views === "object") return x;
    } catch (e) {}
    return null;
  }
  const drop = (k) => {
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  };
  /** Очередь пользователя; без своей — забирает очередь без владельца (и общую очередь прежних версий). */
  function load(uid, legacyToo) {
    const own = read(qkey(uid));
    const q0 = own || { ev: [], views: {} };
    const sources = [];
    if (legacyToo) sources.push(LEGACY);
    if (uid) sources.push(qkey(null));
    for (const k of sources) {
      const x = read(k);
      if (!x) continue;
      q0.ev = [...q0.ev, ...x.ev].slice(-MAX_EVENTS);
      Object.assign(q0.views, x.views);
      try {
        localStorage.setItem(qkey(uid), JSON.stringify(q0));
        drop(k);
      } catch (e) {}
    }
    return q0;
  }
  let owner = (enabled && cloud.peekUid()) || null; // чья очередь сейчас открыта
  let q = load(owner, true);
  const save = () => {
    try {
      localStorage.setItem(qkey(owner), JSON.stringify(q));
    } catch (e) {}
  };

  let view = null; // { id, p, ms, w } — текущая сессия: активные мс, время открытия (Date.now)
  let inLibrary = false;
  let hiddenAt = null;
  let lastInput = performance.now();
  let lastTick = performance.now();
  let lastFlush = 0;
  let flushing = 0; // время начала идущей отправки; зависшая дольше FLUSH_STUCK_MS не блокирует следующие
  const visible = () => document.visibilityState === "visible";

  /** Учесть время с прошлого шага: только видимый экран и не дольше IDLE_MS после последнего действия. */
  function tick() {
    const now = performance.now();
    const from = lastTick;
    lastTick = now;
    if (!view || !visible()) return;
    const add = Math.min(now, lastInput + IDLE_MS) - from;
    if (add > 0) view.ms += Math.min(add, TICK_MS * 2); // разрыв таймера (сон устройства) не засчитывается
    put(false);
  }

  function put(end) {
    const prev = q.views[view.id] || {};
    const s = Math.min(MAX_VIEW_S, Math.floor(view.ms / 1000));
    if (prev.s === s && !!prev.end === end) return;
    q.views[view.id] = { id: view.id, p: view.p, s, w: view.w, end, v: (prev.v || 0) + 1, sv: prev.sv || 0 };
    const ids = Object.keys(q.views);
    if (ids.length > MAX_VIEWS) delete q.views[ids[0]];
    save();
  }

  function ev(k) {
    q.ev.push({ id: uuid(), k });
    if (q.ev.length > MAX_EVENTS) q.ev.splice(0, q.ev.length - MAX_EVENTS);
    save();
  }

  function startView(p) {
    view = { id: uuid(), p, ms: 0, w: Date.now() };
    lastInput = lastTick = performance.now();
    put(false); // новая сессия попадёт в ближайшую отправку
  }

  function endView() {
    if (!view) return;
    tick();
    put(true);
    view = null;
  }

  /** Отправка очереди. keepalive — при уходе страницы: результат неизвестен, очередь не очищается (повтор безопасен). */
  async function flush(keepalive) {
    if (!enabled || (!keepalive && flushing && Date.now() - flushing < FLUSH_STUCK_MS)) return;
    // только своей сессией: нет пользователя или сессия уже другого — ждём bind()
    if (!owner || cloud.peekUid() !== owner) return;
    const mine = q;
    const mineOwner = owner;
    const views = Object.values(q.views).filter((x) => x.v !== x.sv);
    const batch = [
      ...q.ev.map((e) => ({ t: "ev", id: e.id, k: e.k, b: BUILD })),
      ...views.map((x) => ({ t: "view", id: x.id, p: x.p, s: x.s, a: Math.max(0, Math.floor((Date.now() - x.w) / 1000)), end: !!x.end, b: BUILD })),
    ].slice(0, BATCH);
    if (!batch.length) return;
    lastFlush = Date.now();
    if (keepalive) {
      cloud.track(batch, { keepalive: true }).catch(() => {});
      return;
    }
    const started = (flushing = Date.now());
    const sent = new Map(batch.map((x) => [x.id, x.t === "view" ? q.views[x.id]?.v : 0]));
    try {
      await cloud.track(batch);
      // пока шла отправка, очередь могла смениться (выход): отмечаем отправленное в той, из которой брали
      mine.ev = mine.ev.filter((e) => !sent.has(e.id));
      for (const [id, v] of sent) {
        const x = mine.views[id];
        if (!x || x.v !== v) continue;
        if (x.end) delete mine.views[id];
        else x.sv = v;
      }
      if (mine === q) save();
      else
        try {
          localStorage.setItem(qkey(mineOwner), JSON.stringify(mine));
        } catch (e) {}
      if (mine === q && (q.ev.length || Object.values(q.views).some((x) => x.v !== x.sv))) setTimeout(() => flush(), 1000);
    } catch (e) {
      // без сети или ошибка сервера — всё остаётся в очереди до следующей отправки
    } finally {
      if (flushing === started) flushing = 0;
    }
  }

  /**
   * Вызывается после каждой отрисовки экрана (app.js render): начало и конец сессий просмотра
   * и вход в библиотеку. Повторные вызовы для того же экрана ничего не меняют.
   */
  function screen(name, paragraphId) {
    if (!enabled) return;
    const lib = typeof name === "string" && name.startsWith("library");
    if (lib && !inLibrary) ev("library_open");
    inLibrary = lib;
    const p = name === "library-paragraph" ? paragraphId : null;
    if (view && view.p === p) return;
    endView();
    if (p) startView(p);
  }

  function onHidden() {
    tick();
    hiddenAt = Date.now();
    flush(true);
  }

  function onVisible() {
    const now = performance.now();
    if (hiddenAt && Date.now() - hiddenAt >= RESUME_MS) {
      ev("app_resume");
      if (view) {
        // долгий перерыв: прежняя сессия закончилась, когда приложение ушло в фон
        const p = view.p;
        put(true);
        view = null;
        startView(p);
      }
    }
    hiddenAt = null;
    lastTick = lastInput = now;
    flush();
  }

  if (enabled) {
    // прошлый запуск страницы закончился: его незавершённые сессии завершены (дошлём, что успели записать)
    for (const x of Object.values(q.views)) {
      if (!x.end) {
        x.end = true;
        x.v = (x.v || 0) + 1;
      }
    }
    save();
    ev("app_cold");
    if (!visible()) hiddenAt = Date.now();

    const input = () => (lastInput = performance.now());
    for (const t of ["pointerdown", "touchstart", "keydown", "wheel", "scroll"]) window.addEventListener(t, input, { capture: true, passive: true });
    document.addEventListener("visibilitychange", () => (visible() ? onVisible() : onHidden()));
    // уход со страницы (закрытие, перезагрузка при обновлении PWA): из bfcache страница может вернуться — тогда сессия продолжается
    window.addEventListener("pagehide", (e) => {
      tick();
      if (view && !e.persisted) {
        put(true);
        view = null;
      }
      flush(true);
    });
    window.addEventListener("pageshow", (e) => e.persisted && onVisible());
    document.addEventListener("freeze", onHidden);
    document.addEventListener("resume", onVisible);
    window.addEventListener("online", () => flush());
    setInterval(() => {
      tick();
      if (Date.now() - lastFlush >= FLUSH_MS) flush();
    }, TICK_MS);
    setTimeout(() => flush(), 3000);
    if (cloud.onUser) cloud.onUser(bind);
  }

  /** Смена пользователя на устройстве: сессия просмотра завершается в очереди прежнего, дальше — очередь нового. */
  function bind(uid) {
    uid = uid || null;
    if (!enabled || uid === owner) return;
    if (view) {
      tick();
      put(true);
      view = null;
    }
    save();
    owner = uid;
    q = load(owner, false);
    save();
    setTimeout(() => flush(), 1000);
  }

  /** Перед входом или выходом: дослать очередь текущего пользователя (не дольше ms). */
  function settle(ms = 3000) {
    if (!enabled || !owner) return Promise.resolve();
    flushing = 0;
    return Promise.race([flush(), new Promise((r) => setTimeout(r, ms))]).catch(() => {});
  }

  K.analytics = { enabled, screen, flush, bind, settle };
})();
