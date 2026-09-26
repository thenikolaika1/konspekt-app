/*
 * Хранилище конспектов и закладок.
 *
 * Контракт для UI: чтение синхронное из кэша в памяти (заполняется в init),
 * изменения — асинхронные (возвращают Promise).
 *
 * Два вида конспектов в одном списке:
 *  - локальные (demo и старые mock) — только в localStorage, как раньше;
 *  - облачные (remote: true) — настоящие AI-конспекты из Supabase public.notes. Их копия
 *    хранится в localStorage для быстрого старта и чтения без сети; sync() обновляет её
 *    с сервера. У облачных есть status: processing | ready | failed; content есть только у ready.
 * Закладки пока локальные и ссылаются на id конспектов любого вида.
 */
(() => {
  const K = (window.K = window.K || {});
  const KEY = "konspekt.store.v1";
  // processing без изменений дольше этого считается прерванной генерацией (сервер тоже разрешает её повтор)
  const STALE_MS = 6 * 60_000;
  const UPLOAD_STALE_MS = 3 * 60_000;
  let db = { version: 1, notes: [], bookmarks: [] };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.notes) || !Array.isArray(data.bookmarks)) return false;
      db = data;
      return true;
    } catch (e) {
      console.warn("[store] load failed", e);
      return false;
    }
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      console.error("[store] save failed", e);
      throw new Error("STORAGE_FAILED");
    }
  }

  function summarize(content) {
    return {
      title: content.meta.title,
      subject: content.meta.subject,
      subjectLabel: content.meta.subjectLabel,
      preview: content.meta.summary || content.sections.map((s) => s.heading).filter(Boolean).join(", "),
    };
  }

  /** thumbnail — необязательная обложка темы (путь или URL); без неё UI показывает обложку предмета. */
  function makeNote(id, content, source, createdAt, thumbnail) {
    const c = K.study.normalize(content);
    const note = { id, ...summarize(c), createdAt, updatedAt: createdAt, openedAt: null, source, schemaVersion: c.schemaVersion, content: c };
    if (thumbnail) note.thumbnail = thumbnail;
    return note;
  }

  /** Строка public.notes → note для UI (тот же формат, что у локальных, плюс remote/status). */
  function fromRow(r, prev) {
    const createdAt = Date.parse(r.created_at) || (prev && prev.createdAt) || Date.now();
    const updatedAt = Date.parse(r.updated_at) || createdAt;
    const note = {
      id: r.id,
      remote: true,
      status: r.status || "processing",
      stage: r.stage || "",
      errorCode: r.error_code || "",
      createdAt,
      updatedAt,
      openedAt: prev ? prev.openedAt : null,
      source: { kind: "ai" },
    };
    if (note.status === "ready" && r.content) {
      try {
        const c = K.study.normalize(r.content);
        if (r.title) c.meta.title = r.title;
        return { ...note, ...summarize(c), preview: r.preview || summarize(c).preview, schemaVersion: c.schemaVersion, content: c };
      } catch (e) {
        console.warn("[store] invalid remote content", r.id, e);
        note.status = "failed";
        note.errorCode = "EMPTY_CONTENT";
      }
    }
    if (note.status === "ready") note.status = "failed"; // ready без content показывать нельзя
    // генерация, которая давно не менялась, прервана (например, закрыли приложение во время загрузки фото)
    const age = Date.now() - updatedAt;
    if (note.status === "processing" && ((note.stage === "uploading" && age > UPLOAD_STALE_MS) || age > STALE_MS)) {
      note.status = "failed";
      note.errorCode = note.stage === "uploading" ? "UPLOAD_INTERRUPTED" : "STALE";
    }
    const subject = K.study.SUBJECTS[r.subject] ? r.subject : "other";
    return { ...note, title: r.title || "Новый конспект", subject, subjectLabel: K.study.subject(subject).label, preview: "", content: null };
  }

  function seed() {
    const now = Date.now();
    db = {
      version: 1,
      notes: K.mock.seedNotes().map((s) => makeNote(s.id, s.content, { kind: "demo" }, now - s.ageMs, s.thumbnail)),
      bookmarks: K.mock.seedBookmarks(),
    };
  }

  /** Выполняет изменение; при ошибке сохранения откатывает кэш. */
  function mutate(fn) {
    const snapshot = JSON.stringify(db);
    try {
      const result = fn();
      persist();
      return Promise.resolve(result);
    } catch (e) {
      db = JSON.parse(snapshot);
      return Promise.reject(e);
    }
  }

  /** Демо-конспекты, сохранённые до появления обложек, получают свою обложку. */
  function migrateThumbnails() {
    let changed = false;
    K.mock.seedNotes().forEach((s) => {
      const n = db.notes.find((x) => x.id === s.id);
      if (n && !n.thumbnail && !n.thumbnailUrl && s.thumbnail) {
        n.thumbnail = s.thumbnail;
        changed = true;
      }
    });
    return changed;
  }

  const findNote = (id) => db.notes.find((n) => n.id === id) || null;
  const cloud = () => (K.cloud && K.cloud.enabled ? K.cloud : null);

  function putRow(row) {
    const prev = findNote(row.id);
    const note = fromRow(row, prev);
    if (prev) Object.keys(prev).forEach((k) => delete prev[k]), Object.assign(prev, note);
    else db.notes.push(note);
    return prev || note;
  }
  const findBookmark = (id) => db.bookmarks.find((b) => b.id === id) || null;

  K.store = {
    init() {
      if (!load()) {
        seed();
        try {
          persist();
        } catch (e) {}
      } else if (migrateThumbnails()) {
        try {
          persist();
        } catch (e) {}
      }
      return Promise.resolve();
    },

    /**
     * Загружает облачные конспекты пользователя. Локальные (demo/mock) не трогает.
     * Возвращает true, если список изменился. Без сети остаётся локальная копия.
     */
    async sync() {
      const c = cloud();
      if (!c) return false;
      const rows = await c.listNotes();
      const before = JSON.stringify(db.notes);
      const ids = new Set(rows.map((r) => r.id));
      db.notes = db.notes.filter((n) => !n.remote || ids.has(n.id));
      rows.forEach(putRow);
      c.cleanupPhotos(rows).catch(() => {});
      const changed = JSON.stringify(db.notes) !== before;
      if (changed) {
        try {
          persist();
        } catch (e) {}
      }
      return changed;
    },

    /** Кладёт в кэш строку public.notes (результат генерации или опроса). */
    putRemote(row) {
      const n = putRow(row);
      try {
        persist();
      } catch (e) {}
      return n;
    },

    /** Меняет статус облачного конспекта только на устройстве (например, фото не загрузились). */
    setLocalStatus(id, status, errorCode) {
      const n = findNote(id);
      if (!n || !n.remote) return;
      n.status = status;
      n.errorCode = errorCode || "";
      try {
        persist();
      } catch (e) {}
    },

    /** Облачные конспекты, которые ещё создаются. */
    listPending: () => db.notes.filter((n) => n.remote && n.status === "processing"),

    // --- notes ---
    listNotes: () => [...db.notes].sort((a, b) => b.createdAt - a.createdAt),
    getNote: findNote,
    createNote: (content, source) =>
      mutate(() => {
        const note = makeNote(K.uid(), content, source || {}, Date.now());
        db.notes.push(note);
        return note;
      }),
    renameNote: async (id, title) => {
      const n0 = findNote(id);
      if (n0 && n0.remote && cloud() && title) await cloud().renameNote(id, title);
      return mutate(() => {
        const n = findNote(id);
        if (!n || !title) return;
        n.title = title;
        if (n.content) n.content.meta.title = title;
        n.updatedAt = Date.now();
      });
    },
    markOpened: (id) =>
      mutate(() => {
        const n = findNote(id);
        if (n) n.openedAt = Date.now();
      }).catch(() => {}),
    deleteNote: async (id) => {
      const n0 = findNote(id);
      if (n0 && n0.remote && cloud()) await cloud().deleteNote(id);
      return mutate(() => {
        db.notes = db.notes.filter((n) => n.id !== id);
        db.bookmarks.forEach((b) => (b.noteIds = b.noteIds.filter((x) => x !== id)));
      });
    },

    // --- bookmarks ---
    listBookmarks: () => db.bookmarks,
    getBookmark: findBookmark,
    notesInBookmark(id) {
      const b = findBookmark(id);
      return b ? K.store.listNotes().filter((n) => b.noteIds.includes(n.id)) : [];
    },
    createBookmark: ({ name, icon, color }) =>
      mutate(() => {
        const b = { id: K.uid(), name, icon, color, cls: "", noteIds: [] };
        db.bookmarks.push(b);
        return b;
      }),
    updateBookmark: (id, patch) =>
      mutate(() => {
        const b = findBookmark(id);
        if (!b) return;
        ["name", "icon", "color"].forEach((k) => {
          if (patch[k] !== undefined) b[k] = patch[k];
        });
        // своё оформление заменяет стандартное оформление seed-закладки
        if (patch.color) b.cls = "";
      }),
    deleteBookmark: (id) =>
      mutate(() => {
        db.bookmarks = db.bookmarks.filter((b) => b.id !== id);
      }),
    toggleNoteInBookmark: (bookmarkId, noteId) =>
      mutate(() => {
        const b = findBookmark(bookmarkId);
        if (!b) return false;
        const has = b.noteIds.includes(noteId);
        b.noteIds = has ? b.noteIds.filter((x) => x !== noteId) : [...b.noteIds, noteId];
        return !has;
      }),
  };
})();
