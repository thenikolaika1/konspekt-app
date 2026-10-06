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

  const sb = () => client || (client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }));
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
  async function retryNetwork(fn, attempts = 3) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!e.transient || navigator.onLine === false || i === attempts - 1) throw e;
        // исходная ошибка — только в консоль, пользователю показывается код
        console.warn("[cloud] no server response, retry " + (i + 1) + ":", e.message, String(e.cause?.message || ""));
        await sleep(500 * 2 ** i);
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
        const res = await sb().auth.signInAnonymously();
        if (res.error || !res.data?.user) throw fail("AUTH_FAILED", res.error);
        return res.data.user;
      })().catch((e) => {
        userPromise = null;
        throw ["NETWORK", "CONNECTION_LOST", "AUTH_FAILED"].includes(e.message) ? e : fail("AUTH_FAILED", e);
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

  K.cloud = { enabled, ensureUser, listNotes, getNote, createProcessingNote, renameNote, deleteNote, uploadPages, listPagePaths, cleanupPhotos, startAnalysis, waitForNote, getAccess, redeemInvite };
})();
