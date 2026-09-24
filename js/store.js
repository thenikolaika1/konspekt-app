/*
 * Хранилище конспектов и закладок. Phase 0: localStorage.
 *
 * Контракт для UI: чтение синхронное из кэша в памяти (заполняется в init),
 * изменения — асинхронные (возвращают Promise). Позже init() будет загружать
 * данные из Supabase, а мутации — писать туда, не меняя вызовов в UI.
 */
(() => {
  const K = (window.K = window.K || {});
  const KEY = "konspekt.store.v1";
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

    // --- notes ---
    listNotes: () => [...db.notes].sort((a, b) => b.createdAt - a.createdAt),
    getNote: findNote,
    createNote: (content, source) =>
      mutate(() => {
        const note = makeNote(K.uid(), content, source || {}, Date.now());
        db.notes.push(note);
        return note;
      }),
    renameNote: (id, title) =>
      mutate(() => {
        const n = findNote(id);
        if (!n || !title) return;
        n.title = title;
        n.content.meta.title = title;
        n.updatedAt = Date.now();
      }),
    markOpened: (id) =>
      mutate(() => {
        const n = findNote(id);
        if (n) n.openedAt = Date.now();
      }).catch(() => {}),
    deleteNote: (id) =>
      mutate(() => {
        db.notes = db.notes.filter((n) => n.id !== id);
        db.bookmarks.forEach((b) => (b.noteIds = b.noteIds.filter((x) => x !== id)));
      }),

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
