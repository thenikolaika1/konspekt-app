/*
 * Supabase: анонимный вход, конспекты (public.notes), временные фото (Storage temp-pages)
 * и запуск Edge Function analyze-pages.
 *
 * Браузер использует только publishable key (js/config.js); все права ограничены RLS.
 * Готовый content и статусы ready/failed пишет только Edge Function — клиент создаёт
 * note в статусе processing, читает свои notes, переименовывает и удаляет их.
 *
 * Ошибки — Error с кодом в message (NETWORK, AUTH_FAILED, UPLOAD_FAILED, …), как в generator.js.
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

  const sb = () =>
    client ||
    (client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fail(code, cause) {
    const offline = navigator.onLine === false || /fetch|network|load failed|timed? ?out/i.test(String(cause?.message || cause || ""));
    const e = new Error(offline && code !== "AUTH_FAILED" ? "NETWORK" : code);
    e.cause = cause;
    return e;
  }

  /** Текущий пользователь; при первом запуске — анонимный вход (без email, имени и пароля). */
  function ensureUser() {
    if (!userPromise) {
      userPromise = (async () => {
        const { data } = await sb().auth.getSession();
        if (data?.session?.user) return data.session.user;
        const res = await sb().auth.signInAnonymously();
        if (res.error || !res.data?.user) throw fail(navigator.onLine === false ? "NETWORK" : "AUTH_FAILED", res.error);
        return res.data.user;
      })().catch((e) => {
        userPromise = null;
        throw e.message === "NETWORK" || e.message === "AUTH_FAILED" ? e : fail("AUTH_FAILED", e);
      });
    }
    return userPromise;
  }

  // ---------- notes ----------

  async function listNotes() {
    await ensureUser();
    const { data, error } = await sb().from("notes").select(NOTE_COLS).order("created_at", { ascending: false });
    if (error) throw fail("LOAD_FAILED", error);
    return data || [];
  }

  async function getNote(id) {
    await ensureUser();
    const { data, error } = await sb().from("notes").select(NOTE_COLS).eq("id", id).maybeSingle();
    if (error) throw fail("LOAD_FAILED", error);
    return data;
  }

  /** Новая генерация: пустая note в статусе processing. Повторный вызов с тем же id безопасен. */
  async function createProcessingNote(id) {
    const user = await ensureUser();
    const { error } = await sb()
      .from("notes")
      .insert({ id, user_id: user.id, status: "processing", stage: "uploading", title: "Новый конспект" });
    if (error && error.code !== "23505") throw fail("CREATE_FAILED", error);
  }

  async function renameNote(id, title) {
    await ensureUser();
    const { error } = await sb().from("notes").update({ title }).eq("id", id);
    if (error) throw fail("SAVE_FAILED", error);
  }

  async function deleteNote(id) {
    await ensureUser();
    await removeFolder(id).catch((e) => console.warn("[cloud] photos cleanup failed", e));
    const { error } = await sb().from("notes").delete().eq("id", id);
    if (error) throw fail("DELETE_FAILED", error);
  }

  // ---------- временные фото ----------

  const folder = (user, noteId) => user.id + "/" + noteId;

  /**
   * Загружает страницы в temp-pages/{uid}/{noteId}/NN-{случайное имя}.jpg по порядку.
   * done: Map page.id → path — уже загруженные страницы (при повторе не загружаются снова).
   */
  async function uploadPages(noteId, pages, done) {
    const user = await ensureUser();
    const bucket = sb().storage.from(BUCKET);
    const uploadOne = async (page, i) => {
      if (done.has(page.id)) return;
      const path = folder(user, noteId) + "/" + String(i + 1).padStart(2, "0") + "-" + K.uid() + ".jpg";
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(1000 * 2 ** attempt);
        const { error } = await bucket.upload(path, page.blob, { contentType: "image/jpeg", upsert: false });
        if (!error) return done.set(page.id, path);
        lastError = error;
      }
      throw fail("UPLOAD_FAILED", lastError);
    };
    // по две страницы одновременно: быстрее, но не забивает слабый канал
    const queue = pages.map((p, i) => [p, i]);
    const worker = async () => {
      for (let job; (job = queue.shift()); ) await uploadOne(...job);
    };
    await Promise.all([worker(), worker()]);
    return pages.map((p) => done.get(p.id));
  }

  /** Пути уже загруженных страниц note (для повтора после перезагрузки), по порядку. */
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

  /**
   * Уборка: удаляет временные фото конспектов, которые уже готовы, удалены или давно
   * завершились ошибкой. Фото свежей ошибки остаются — по ним можно повторить генерацию.
   */
  async function cleanupPhotos(rows) {
    const user = await ensureUser();
    const { data, error } = await sb().storage.from(BUCKET).list(user.id, { limit: 100 });
    if (error || !data) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const DAY = 864e5;
    for (const entry of data) {
      if (entry.id) continue; // файл в корне папки — не наш формат
      const r = byId.get(entry.name);
      const age = r ? Date.now() - Date.parse(r.updated_at || r.created_at) : Infinity;
      const obsolete = !r || r.status === "ready" || (r.status === "failed" && age > DAY) || age > 2 * DAY;
      if (obsolete) await removeFolder(entry.name).catch(() => {});
    }
  }

  // ---------- генерация ----------

  /** Запускает Edge Function. Повторный запуск уже идущей генерации не создаёт второй запрос к AI. */
  async function startAnalysis(noteId, paths) {
    await ensureUser();
    const { data, error } = await sb().functions.invoke(cfg.analyzeFunction || "analyze-pages", {
      body: { note_id: noteId, paths },
    });
    if (!error) return data;
    let code = "";
    try {
      code = (await error.context?.json())?.error || "";
    } catch (e) {}
    if (code === "ALREADY_PROCESSING") return { status: "processing" };
    throw fail(code || (error.name === "FunctionsFetchError" ? "NETWORK" : "START_FAILED"), error);
  }

  /**
   * Ждёт, пока Edge Function завершит генерацию: опрашивает notes.status.
   * Кратковременные сетевые ошибки не прерывают ожидание.
   */
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

  K.cloud = {
    enabled,
    ensureUser,
    listNotes,
    getNote,
    createProcessingNote,
    renameNote,
    deleteNote,
    uploadPages,
    listPagePaths,
    cleanupPhotos,
    startAnalysis,
    waitForNote,
  };
})();
