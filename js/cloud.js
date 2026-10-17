/*
 * Supabase: анонимный вход, конспекты (public.notes), временные фото (Storage temp-pages),
 * запуск Edge Function analyze-pages и ранний доступ (get_my_access, redeem_beta_invite).
 *
 * Браузер использует только publishable key (js/config.js); все права ограничены RLS.
 * Готовый content и статусы ready/failed пишет только Edge Function — клиент создаёт
 * note в статусе processing, читает свои notes, переименовывает и удаляет их.
 *
 * Ошибки — Error с кодом в message, как в generator.js:
 *  - NETWORK — устройство действительно без сети (navigator.onLine === false);
 *  - CONNECTION_LOST — сеть есть, но ответа сервера не было (Load failed / Failed to fetch);
 *  - SERVER_TIMEOUT — сработал наш таймаут запроса;
 *  - остальные коды (AUTH_FAILED, CREATE_FAILED, UPLOAD_FAILED, BAD_REQUEST, …) — сервер ответил ошибкой.
 */
(() => {
  const K = (window.K = window.K || {});
  const cfg = K.config || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase && window.supabase.createClient);
  const BUCKET = cfg.pagesBucket || "temp-pages";
  const NOTE_COLS = "id,status,stage,error_code,title,subject,preview,content,schema_version,created_at,updated_at";
  const POLL_MS = 2500;
  const WAIT_MS = 4 * 60_000;

  let client = null;
  let userPromise = null;

  // ---------- аккаунт участника: ID + ключ ----------
  // ID и ключ выдаёт организатор (supabase/release/ff-accounts.ps1). Supabase Auth хранит служебный логин:
  // email из ID в недоставляемой зоне .invalid и пароль из ключа (bcrypt на стороне Auth); сами мы ключ не храним.
  // Алфавит без неоднозначных символов (нет 0/O, 1/I/L); ввод не «исправляется» — только регистр, пробелы и дефисы.
  const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const ID_LEN = 6;
  const KEY_LEN = 20;
  const LOGIN_DOMAIN = "@id.konspekt.invalid";
  // на этом устройстве выполнен вход по ID: без сессии не создаём молча нового анонимного пользователя
  const ACCOUNT = "konspekt.account";
  const AUTH_KEY = enabled ? "sb-" + new URL(cfg.supabaseUrl).hostname.split(".")[0] + "-auth-token" : "";

  const clean = (v) => String(v || "").toUpperCase().replace(/[\s-]/g, "");
  const inAlphabet = (s) => [...s].every((c) => ID_ALPHABET.includes(c));
  /** «kn-7f3kq9», «7F3KQ9» → «KN-7F3KQ9»; иначе null. */
  function normalizeId(input) {
    let s = clean(input);
    if (s.length === ID_LEN + 2 && s.startsWith("KN")) s = s.slice(2);
    return s.length === ID_LEN && inAlphabet(s) ? "KN-" + s : null;
  }
  /** Ключ: 20 символов алфавита, группы через дефис необязательны; иначе null. */
  function normalizeKey(input) {
    const s = clean(input);
    return s.length === KEY_LEN && inAlphabet(s) ? s : null;
  }
  const idLogin = (id, key) => ({ email: "id-" + id.toLowerCase() + LOGIN_DOMAIN, password: "Kn-2." + key });
  const idFromEmail = (email) => {
    const m = /^id-(kn-[a-z0-9]+)@id\.konspekt\.invalid$/.exec(String(email || "").toLowerCase());
    return m ? normalizeId(m[1]) : null;
  };

  const readJson = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k) || "null");
    } catch (e) {
      return null;
    }
  };
  const getFlag = () => readJson(ACCOUNT);
  // анонимная сессия гостя на время входа по ID (тот же уровень защиты, что и сама сессия в localStorage)
  const GUEST = "konspekt.guest";
  const setGuest = (v) => {
    try {
      v ? localStorage.setItem(GUEST, JSON.stringify(v)) : localStorage.removeItem(GUEST);
    } catch (e) {}
  };
  const setFlag = (v) => {
    try {
      v ? localStorage.setItem(ACCOUNT, JSON.stringify(v)) : localStorage.removeItem(ACCOUNT);
    } catch (e) {}
  };
  /** Сохранённая сессия этого устройства (без сети и без запросов): { id, email } пользователя или null. */
  const peekSession = () => {
    const s = AUTH_KEY && readJson(AUTH_KEY);
    return s && (s.currentSession || s);
  };
  function peekUser() {
    const s = peekSession();
    const u = s && s.user;
    return u && u.id ? { id: u.id, email: u.email || "" } : null;
  }
  const peekUid = () => peekUser()?.id || null;

  // смена пользователя (вход, выход, потеря сессии): store и аналитика переключают свои данные на его uid
  const userListeners = [];
  let lastUid;
  function notifyUser(uid) {
    if (uid === lastUid) return;
    lastUid = uid;
    // вне обработчика onAuthStateChange: подписчики могут обращаться к Supabase
    setTimeout(() => userListeners.forEach((fn) => fn(uid)), 0);
  }
  const onUser = (fn) => userListeners.push(fn);

  // последний токен сессии — для отправки аналитики при уходе со страницы (fetch keepalive, без await)
  let lastToken = "";
  function sb() {
    if (client) return client;
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    client.auth.onAuthStateChange((_event, session) => {
      lastToken = session?.access_token || "";
      // токен истёк, а обновить не удалось (нет сети, 5xx): supabase-js сообщает «нет сессии», но хранит её —
      // пользователь тот же, его данные на устройстве остаются. Сменился — только если сессии нет и в хранилище
      const uid = session?.user?.id || peekUid();
      if (!uid) userPromise = null;
      notifyUser(uid);
    });
    return client;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Таймауты только для шагов генерации, повтор которых идемпотентен (тот же note_id / тот же путь фото).
  // Обычные значения в production: создание note 0.2–0.8 с, запуск analyze-pages 1.8–3.2 с,
  // загрузка одной страницы (~0.3–0.85 МБ) около 2–2.5 с.
  const CREATE_TIMEOUT_MS = cfg.createTimeoutMs || 15_000;
  const START_TIMEOUT_MS = cfg.startTimeoutMs || 20_000;
  const UPLOAD_TIMEOUT_MS = cfg.uploadTimeoutMs || 45_000;

  /** Ответа сервера не было: обрыв связи, Load failed, отмена по таймауту. Определяется по форме ошибки, не по тексту. */
  const noResponse = (err, status) =>
    !!err && (status === 0 || ["FunctionsFetchError", "StorageUnknownError"].includes(err.name) || (err.name === "AuthRetryableFetchError" && !err.status));

  /** Ошибка без ответа сервера: без сети — NETWORK, по нашему таймауту — SERVER_TIMEOUT, иначе CONNECTION_LOST. */
  function connectionError(cause, timedOut) {
    const e = new Error(navigator.onLine === false ? "NETWORK" : timedOut ? "SERVER_TIMEOUT" : "CONNECTION_LOST");
    e.cause = cause;
    e.transient = true;
    return e;
  }

  /** Ошибка запроса: нет ответа сервера → connectionError, ответ сервера → его код (не маскируется под сеть). */
  function fail(code, cause, status) {
    if (noResponse(cause, status)) return connectionError(cause);
    const e = new Error(code);
    e.cause = cause;
    return e;
  }

  /** Контроллер отмены с таймаутом; timedOut() — сработал ли именно таймаут. */
  function timeoutController(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, timedOut: () => ctrl.signal.aborted, done: () => clearTimeout(timer) };
  }

  // iOS/Safari после закрытия камеры иногда возвращает Load failed или подвисает.
  // Повторяем только идемпотентные операции и только когда ответа сервера не было; без сети не повторяем.
  // Ответ Supabase иногда теряется по дороге (запись сделана, ответа нет; шлюз отдаёт 520) и связь возвращается
  // не сразу: 5 попыток с паузами 1, 2, 4, 8 с — около 15 с ожидания между попытками сверх таймаутов запросов.
  const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
  async function retryNetwork(fn) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!e.transient || navigator.onLine === false || i >= RETRY_DELAYS_MS.length) throw e;
        // исходная ошибка — только в консоль, пользователю показывается код
        console.warn("[cloud] no server response, retry " + (i + 1) + ":", e.message, String(e.cause?.message || ""));
        await sleep(RETRY_DELAYS_MS[i]);
      }
    }
  }

  function ensureUser() {
    if (!userPromise) {
      userPromise = (async () => {
        const { data, error } = await sb().auth.getSession();
        if (data?.session?.user) return data.session.user;
        // Сессия есть, но обновить токен не удалось (сеть, 5xx) — gotrue её сохранил. Новый анонимный вход
        // здесь потерял бы все конспекты пользователя, поэтому — ошибка, повтор позже с тем же пользователем.
        // Без ошибки сессии нет совсем, либо сервер отверг токен и gotrue сам удалил сессию.
        if (error && error.name === "AuthRetryableFetchError") throw fail("AUTH_FAILED", error);
        // участник этого устройства потерял сессию (ключ сменили, сессия отозвана): не подменяем его новым
        // анонимным аккаунтом — приложение попросит войти снова или явно продолжить без входа
        if (getFlag()) throw new Error("SIGNED_OUT");
        // гость этого устройства, который входил по ID и вышел: возвращаем его прежний анонимный аккаунт
        const guest = readJson(GUEST);
        if (guest && guest.refresh_token) {
          const r = await sb().auth.refreshSession({ refresh_token: guest.refresh_token });
          if (r.data?.user) {
            setGuest(null);
            return r.data.user;
          }
          if (r.error && r.error.name === "AuthRetryableFetchError") throw fail("AUTH_FAILED", r.error);
          setGuest(null); // токен отозван или устарел — дальше обычный новый гость
        }
        const res = await sb().auth.signInAnonymously();
        if (res.error || !res.data?.user) throw fail("AUTH_FAILED", res.error);
        return res.data.user;
      })().catch((e) => {
        userPromise = null;
        throw ["NETWORK", "CONNECTION_LOST", "AUTH_FAILED", "SIGNED_OUT"].includes(e.message) ? e : fail("AUTH_FAILED", e);
      });
    }
    return userPromise;
  }

  async function listNotes() {
    await ensureUser();
    const { data, error, status } = await sb().from("notes").select(NOTE_COLS).order("created_at", { ascending: false });
    if (error) throw fail("LOAD_FAILED", error, status);
    return data || [];
  }

  async function getNote(id) {
    await ensureUser();
    const { data, error, status } = await sb().from("notes").select(NOTE_COLS).eq("id", id).maybeSingle();
    if (error) throw fail("LOAD_FAILED", error, status);
    return data;
  }

  async function createProcessingNote(id) {
    const user = await ensureUser();
    return retryNetwork(async () => {
      const t = timeoutController(CREATE_TIMEOUT_MS);
      try {
        const { error, status } = await sb()
          .from("notes")
          .insert({ id, user_id: user.id, status: "processing", stage: "uploading", title: "Новый конспект" })
          .abortSignal(t.signal);
        // Один note_id генерируется заранее: если первый insert дошёл, а ответ потерялся, повтор получит 23505 — note уже есть.
        if (!error || error.code === "23505") return;
        if (noResponse(error, status)) throw connectionError(error, t.timedOut());
        throw fail("CREATE_FAILED", error, status);
      } finally {
        t.done();
      }
    });
  }

  async function renameNote(id, title) {
    await ensureUser();
    const { error, status } = await sb().from("notes").update({ title }).eq("id", id);
    if (error) throw fail("SAVE_FAILED", error, status);
  }

  async function deleteNote(id) {
    await ensureUser();
    await removeFolder(id).catch((e) => console.warn("[cloud] photos cleanup failed", e));
    const { error, status } = await sb().from("notes").delete().eq("id", id);
    if (error) throw fail("DELETE_FAILED", error, status);
  }

  const folder = (user, noteId) => user.id + "/" + noteId;

  /** Storage отказал, потому что объект с этим путём уже есть (upsert: false). */
  const isDuplicate = (err) => !!err && (err.status === 409 || String(err.statusCode) === "409" || /already exists|duplicate/i.test(String(err.message)));

  /**
   * Объект по этому пути — именно эта страница: путь уникален для страницы (в имени её page.id, папку пишет
   * только владелец — RLS), и размер совпадает с её файлом. null — проверить не удалось (нет ответа сервера).
   */
  async function isSameObject(bucket, path, blob) {
    const cut = path.lastIndexOf("/");
    const name = path.slice(cut + 1);
    const { data, error } = await bucket.list(path.slice(0, cut), { search: name, limit: 10 });
    if (error) return null;
    const f = (data || []).find((x) => x.name === name);
    return !!f && Number(f.metadata?.size) === blob.size;
  }

  /** Загрузка с таймаутом. Storage не принимает signal, поэтому зависший запрос не обрывается, а перестаёт ждаться:
   *  повтор идёт по тому же пути, и если исходный запрос всё же дошёл, повтор получит «уже есть» и проверку. */
  function uploadWithTimeout(bucket, path, blob) {
    let timer;
    const timeout = new Promise((r) => (timer = setTimeout(() => r({ error: { name: "StorageUnknownError", message: "client timeout" }, timedOut: true }), UPLOAD_TIMEOUT_MS)));
    const req = bucket.upload(path, blob, { contentType: "image/jpeg", upsert: false }).catch((e) => ({ error: e }));
    return Promise.race([req, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Загружает страницы в temp-pages/{uid}/{noteId}/NN-{page.id}.jpg по порядку. Путь детерминирован: повтор
   * (в том числе после «Повторить») пишет ту же страницу по тому же пути, дублей в папке note не бывает.
   * done: Map page.id → path — уже загруженные страницы (при повторе не загружаются снова).
   */
  async function uploadPages(noteId, pages, done) {
    const user = await ensureUser();
    const bucket = sb().storage.from(BUCKET);
    const uploadOne = async (page, i) => {
      if (done.has(page.id)) return;
      const path = folder(user, noteId) + "/" + String(i + 1).padStart(2, "0") + "-" + page.id + ".jpg";
      let lastError = null;
      let timedOut = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(1000 * 2 ** attempt);
        const res = await uploadWithTimeout(bucket, path, page.blob);
        if (!res.error) return done.set(page.id, path);
        lastError = res.error;
        timedOut = !!res.timedOut;
        if (isDuplicate(res.error)) {
          // прошлая попытка дошла, а ответ потерялся: тот же объект — успех; другой объект — ошибка без повтора
          const same = await isSameObject(bucket, path, page.blob);
          if (same) return done.set(page.id, path);
          if (same === false) throw fail("UPLOAD_FAILED", res.error);
          lastError = { name: "StorageUnknownError", message: "duplicate not verified" }; // проверка без ответа сервера
          continue;
        }
        // ответ сервера 4xx не повторяем; без ответа или 5xx — повтор по тому же пути
        if (!noResponse(res.error) && !(res.error.status >= 500)) break;
      }
      if (noResponse(lastError)) throw connectionError(lastError, timedOut);
      throw fail("UPLOAD_FAILED", lastError);
    };
    const queue = pages.map((p, i) => [p, i]);
    const worker = async () => { for (let job; (job = queue.shift()); ) await uploadOne(...job); };
    await Promise.all([worker(), worker()]);
    return pages.map((p) => done.get(p.id));
  }

  async function listPagePaths(noteId) {
    const user = await ensureUser();
    const { data, error } = await sb().storage.from(BUCKET).list(folder(user, noteId), { limit: 100, sortBy: { column: "name", order: "asc" } });
    if (error) throw fail("LOAD_FAILED", error);
    return (data || []).filter((f) => f.id && f.name.endsWith(".jpg")).map((f) => folder(user, noteId) + "/" + f.name);
  }

  async function removeFolder(noteId) {
    const paths = await listPagePaths(noteId);
    if (paths.length) await sb().storage.from(BUCKET).remove(paths);
  }

  async function cleanupPhotos(rows) {
    const user = await ensureUser();
    const { data, error } = await sb().storage.from(BUCKET).list(user.id, { limit: 100 });
    if (error || !data) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const DAY = 864e5;
    for (const entry of data) {
      if (entry.id) continue;
      const r = byId.get(entry.name);
      const age = r ? Date.now() - Date.parse(r.updated_at || r.created_at) : Infinity;
      const obsolete = !r || r.status === "ready" || (r.status === "failed" && age > DAY) || age > 2 * DAY;
      if (obsolete) await removeFolder(entry.name).catch(() => {});
    }
  }

  async function startAnalysis(noteId, paths) {
    await ensureUser();
    return retryNetwork(async () => {
      const t = timeoutController(START_TIMEOUT_MS);
      try {
        const { data, error } = await sb().functions.invoke(cfg.analyzeFunction || "analyze-pages", { body: { note_id: noteId, paths }, signal: t.signal });
        if (!error) return data;
        // запрос не дошёл или ответ потерян: повтор с тем же note_id безопасен (сервер не запустит второй AI-запрос)
        if (noResponse(error)) throw connectionError(error.context || error, t.timedOut());
        let code = "";
        try { code = (await error.context?.json())?.error || ""; } catch (e) {}
        // Серверная блокировка делает повтор безопасным: второй AI-запрос для той же note не стартует.
        if (code === "ALREADY_PROCESSING") return { status: "processing" };
        // ответ сервера (4xx/5xx, relay error) — его код, без повтора
        throw fail(code || "START_FAILED", error);
      } finally {
        t.done();
      }
    });
  }

  async function waitForNote(noteId, { isCancelled } = {}) {
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      if (isCancelled && isCancelled()) throw new Error("CANCELLED");
      try {
        const row = await getNote(noteId);
        if (!row) throw new Error("NOT_FOUND");
        if (row.status === "ready" || row.status === "failed") return row;
      } catch (e) {
        if (e.message === "NOT_FOUND") throw e;
      }
    }
    throw new Error("STILL_PROCESSING");
  }

  // ---------- ранний доступ (Friends & Family): источник истины — сервер ----------
  // Клиент ничего не считает сам: quota, used и remaining приходят из get_my_access().

  const ACCESS_TIMEOUT_MS = cfg.accessTimeoutMs || 15_000;

  /** RPC с таймаутом: нет ответа сервера → connectionError, ответ сервера с ошибкой → code (не «нет доступа»). */
  async function callRpc(fn, args, code) {
    const t = timeoutController(ACCESS_TIMEOUT_MS);
    try {
      const { data, error, status } = await sb().rpc(fn, args).abortSignal(t.signal);
      if (!error) return data;
      if (noResponse(error, status)) throw connectionError(error, t.timedOut());
      throw fail(code, error, status);
    } finally {
      t.done();
    }
  }

  /** Доступ к генерации конспектов: { plan, quota, used, reserved, remaining, available } или null — доступа нет. */
  async function getAccess() {
    await ensureUser();
    const rows = await retryNetwork(() => callRpc("get_my_access", undefined, "ACCESS_FAILED"));
    return (Array.isArray(rows) ? rows : []).find((r) => r.resource === "text_generation") || null;
  }

  /**
   * Активация кода приглашения для текущего пользователя: { result: activated | already_active | invalid, access }.
   * Код уходит только в теле запроса; здесь он не сохраняется и не пишется в журнал.
   */
  async function redeemInvite(code) {
    await ensureUser();
    const data = await callRpc("redeem_beta_invite", { p_code: code }, "REDEEM_FAILED");
    return { result: data?.result || "invalid", access: data?.access || null };
  }

  /**
   * Аналитика (js/analytics.js): пакет событий в RPC public.track. Пользователя сервер берёт из JWT.
   * keepalive — при уходе страницы: supabase-js так не умеет, поэтому прямой запрос с последним токеном
   * (нет токена — не отправляем, события останутся в очереди до следующего запуска).
   */
  async function track(events, { keepalive = false } = {}) {
    if (!keepalive) {
      await ensureUser();
      return callRpc("track", { p_events: events }, "TRACK_FAILED");
    }
    if (!lastToken) throw new Error("NO_SESSION");
    const res = await fetch(cfg.supabaseUrl + "/rest/v1/rpc/track", {
      method: "POST",
      keepalive: true,
      headers: { apikey: cfg.supabaseKey, Authorization: "Bearer " + lastToken, "Content-Type": "application/json" },
      body: JSON.stringify({ p_events: events }),
    });
    if (!res.ok) throw new Error("TRACK_FAILED");
    return res.json();
  }

  /**
   * Аккаунт на этом устройстве (без запросов): participant — вошли по ID; signedOut — входили по ID, но сессии
   * больше нет; guest — анонимный пользователь или ещё никого.
   */
  function getAccount() {
    const u = enabled ? peekUser() : null;
    const id = u && idFromEmail(u.email);
    if (id) return { kind: "participant", id, uid: u.id };
    const flag = getFlag();
    // uid — того, кто входил (для очистки его копий на устройстве); сессии у него сейчас нет
    if (flag && !u) return { kind: "signedOut", id: flag.id || "", uid: flag.uid || null };
    return { kind: "guest", id: "", uid: u ? u.id : null };
  }

  /**
   * Вход по ID и ключу. Неверный ID, неверный ключ и неверный формат — одна ошибка BAD_CREDENTIALS
   * (по ответу нельзя понять, существует ли ID). Ключ уходит только в запрос Supabase Auth и нигде не сохраняется.
   * Тот же ID → тот же auth.uid() на любом устройстве. → { id, uid }
   */
  async function signInWithId(rawId, rawKey) {
    const id = normalizeId(rawId);
    const key = normalizeKey(rawKey);
    if (!id || !key) throw new Error("BAD_CREDENTIALS");
    const login = idLogin(id, key);
    const prev = peekSession();
    let res;
    try {
      res = await sb().auth.signInWithPassword(login);
    } catch (e) {
      throw connectionError(e);
    }
    const { data, error } = res;
    if (error || !data?.user) {
      if (noResponse(error, error?.status)) throw connectionError(error);
      if (error?.status === 429 || error?.code === "over_request_rate_limit") throw new Error("RATE_LIMITED");
      if (error?.code === "invalid_credentials" || error?.status === 400) throw new Error("BAD_CREDENTIALS");
      throw fail("AUTH_FAILED", error);
    }
    if (idFromEmail(data.user.email) !== id) {
      await sb().auth.signOut({ scope: "local" }).catch(() => {});
      throw new Error("AUTH_FAILED");
    }
    // гостя запоминаем, чтобы после выхода вернуть его конспекты и закладки (не создавать нового)
    if (prev && prev.refresh_token && prev.user && !idFromEmail(prev.user.email) && prev.user.id !== data.user.id)
      setGuest({ uid: prev.user.id, refresh_token: prev.refresh_token });
    setFlag({ id, uid: data.user.id });
    userPromise = Promise.resolve(data.user);
    notifyUser(data.user.id);
    return { id, uid: data.user.id };
  }

  /** Выход только на этом устройстве. Дальше устройство — гость: прежний (если он был) или новый анонимный. */
  async function signOut() {
    const uid = peekUid();
    let error = null;
    try {
      ({ error } = await sb().auth.signOut({ scope: "local" }));
    } catch (e) {
      error = e;
    }
    // supabase-js без ответа сервера (офлайн) сессию не удаляет — убираем её с устройства сами:
    // выход на этом устройстве должен сработать и без сети (на сервере эта сессия остаётся до её отзыва)
    if (error || peekUid() === uid) {
      try {
        localStorage.removeItem(AUTH_KEY);
      } catch (e) {}
    }
    setFlag(null);
    userPromise = null;
    lastToken = ""; // без ответа сервера supabase-js не сообщает о выходе — токен для keepalive убираем сами
    notifyUser(null);
    if (error && !noResponse(error, error.status)) console.warn("[account] sign out:", error.code || error.status || "error");
    return uid;
  }

  /** После потери сессии участника: явно продолжить гостем (прежний гость устройства или новый анонимный). */
  function continueAsGuest() {
    setFlag(null);
    userPromise = null;
  }

  K.cloud = {
    enabled, ensureUser, listNotes, getNote, createProcessingNote, renameNote, deleteNote, uploadPages, listPagePaths, cleanupPhotos,
    startAnalysis, waitForNote, getAccess, redeemInvite, track,
    peekUid, onUser, getAccount, signInWithId, signOut, continueAsGuest, normalizeId, normalizeKey,
  };
})();
