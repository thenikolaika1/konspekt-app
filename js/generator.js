/*
 * Генерация конспекта из страниц.
 *
 * generate(pages) → Promise<note> — полный цикл: конспект создан и сохранён в K.store.
 *   cloud: note(processing) в Supabase → фото в temp-pages → Edge Function analyze-pages
 *          (Z.AI GLM-4.6V-Flash) → notes.content → K.store;
 *   mock:  тестовый конспект локально (если Supabase не настроен).
 * resume(noteId) → Promise<note> — дождаться или повторить генерацию существующей note
 *   (после перезагрузки или из списка «Не удалось»).
 * analyzePages(pages) → Promise<StudyContent> — прежний mock-контракт, оставлен для совместимости.
 *
 * Ошибка — Error с кодом в message (NO_PAGES, NETWORK, UPLOAD_FAILED, AI_TIMEOUT, …).
 *
 * Защита от двойной генерации: пока идёт генерация тех же страниц, повторный вызов получает
 * тот же Promise; повтор после ошибки продолжает ту же note (тот же note_id, уже загруженные
 * фото не загружаются снова). Сервер дополнительно не даёт запустить второй AI-запрос по note.
 */
(() => {
  const K = (window.K = window.K || {});
  const MOCK_DELAY_MS = 4600;
  const cloud = K.cloud;
  const useCloud = !!(cloud && cloud.enabled);

  async function analyzePages(pages) {
    if (!pages || !pages.length) throw new Error("NO_PAGES");
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    const content = K.mock.analysisResult();
    content.meta.pages = pages.map((_, i) => ({ index: i, readable: "ok" }));
    return content;
  }

  // ---------- cloud ----------

  let current = null; // { key, noteId, created, paths: Map(page.id → storage path) }
  let inFlight = null; // { key, promise }

  const keyOf = (pages) => pages.map((p) => p.id).join("|");

  function once(key, fn) {
    if (inFlight && inFlight.key === key) return inFlight.promise;
    if (inFlight) return Promise.reject(new Error("BUSY"));
    const promise = fn().finally(() => {
      if (inFlight && inFlight.promise === promise) inFlight = null;
    });
    inFlight = { key, promise };
    return promise;
  }

  /** Результат генерации: ready → note из store; failed → ошибка с кодом сервера. */
  function settle(row) {
    K.store.putRemote(row);
    if (row.status === "ready") {
      const n = K.store.getNote(row.id);
      if (n && n.content) return n;
      throw new Error("EMPTY_CONTENT");
    }
    throw new Error(row.error_code || "AI_ERROR");
  }

  async function cloudGenerate(pages, opts) {
    const key = keyOf(pages);
    // другой набор страниц — новая генерация; незавершённая прежняя note без результата убирается
    if (!current || current.key !== key) {
      const old = current && K.store.getNote(current.noteId);
      if (old && old.status === "failed") K.store.deleteNote(old.id).catch(() => {});
      current = { key, noteId: K.uid(), created: false, paths: new Map() };
    }
    const job = current;
    const stage = opts.onStage || (() => {});

    stage("upload");
    if (!job.created) {
      await cloud.createProcessingNote(job.noteId);
      job.created = true;
      K.store.putRemote({ id: job.noteId, status: "processing", stage: "uploading", title: "Новый конспект", created_at: new Date().toISOString() });
    }
    let paths;
    try {
      paths = await cloud.uploadPages(job.noteId, pages, job.paths);
    } catch (e) {
      // в списке это не «Создаётся…»: фото не дошли, повтор продолжит загрузку
      K.store.setLocalStatus(job.noteId, "failed", e.message);
      throw e;
    }

    stage("analyze");
    await cloud.startAnalysis(job.noteId, paths);
    const n = settle(await cloud.waitForNote(job.noteId, opts));
    if (current === job) current = null;
    return n;
  }

  async function cloudResume(noteId, opts) {
    const stage = opts.onStage || (() => {});
    let row = await cloud.getNote(noteId);
    if (!row) throw new Error("NOT_FOUND");
    K.store.putRemote(row);
    if (row.status === "ready") return settle(row);
    const n = K.store.getNote(noteId);
    // ещё идёт на сервере — просто ждём результат
    if (n && n.status === "processing") {
      stage("analyze");
      return settle(await cloud.waitForNote(noteId, opts));
    }
    // фото загрузились не полностью (приложение закрыли во время загрузки) — по части страниц конспект не делаем
    if (row.stage === "uploading") throw new Error("PAGES_MISSING");
    // ошибка или прерванная генерация: повтор по уже загруженным фото
    const paths = await cloud.listPagePaths(noteId);
    if (!paths.length) throw new Error("PAGES_MISSING");
    stage("analyze");
    await cloud.startAnalysis(noteId, paths);
    return settle(await cloud.waitForNote(noteId, opts));
  }

  // ---------- публичный API ----------

  function generate(pages, opts = {}) {
    if (!pages || !pages.length) return Promise.reject(new Error("NO_PAGES"));
    const key = keyOf(pages);
    if (!useCloud)
      return once(key, async () => {
        opts.onStage && opts.onStage("analyze");
        // через K.generator — прежняя точка подмены mock-генерации остаётся рабочей
        const content = await K.generator.analyzePages(pages);
        return K.store.createNote(content, { kind: "mock", pageCount: pages.length });
      });
    return once(key, () => cloudGenerate(pages, opts));
  }

  function resume(noteId, opts = {}) {
    if (!useCloud) return Promise.reject(new Error("NOT_FOUND"));
    return once("note:" + noteId, () => cloudResume(noteId, opts));
  }

  K.generator = { kind: useCloud ? "cloud" : "mock", generate, resume, analyzePages };
})();
