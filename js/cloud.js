/*
 * ТЕСТОВАЯ СБОРКА для проверки на iPhone: вместо js/cloud.js. Сети нет совсем — ни Supabase, ни ИИ.
 * Всё хранится только в памяти этого браузера (localStorage). Роль выбирается на start.html.
 * «Создание конспекта» не распознаёт фото: через 4 с показывается готовый пример «Внутренняя энергия».
 */
(() => {
  const K = (window.K = window.K || {});
  const LS = { role: "kn-test-role", notes: "kn-test-notes" };
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const role = () => (["student", "owner", "expired"].includes(get(LS.role)) ? get(LS.role) : "student");
  const UID = { student: "test-student-0001", owner: "test-owner-0001", expired: "test-expired-0001" };
  const KN = { student: "KN-TEST01", owner: "KN-TEST00", expired: "KN-TEST02" };
  let signedOut = false;
  const uid = () => (signedOut ? null : UID[role()]);
  const rows = () => { try { return JSON.parse(get(LS.notes + ":" + uid()) || "[]"); } catch (e) { return []; } };
  const save = (list) => set(LS.notes + ":" + uid(), JSON.stringify(list));
  const patch = (id, p) => { const l = rows(); const r = l.find((x) => x.id === id); if (r) Object.assign(r, p, { updated_at: new Date().toISOString() }); save(l); return r; };
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const day = 86400000;
  function access() {
    const now = Date.now();
    const base = { server_now: new Date(now).toISOString(), ai_used: 0, ai_reserved: 0 };
    if (role() === "owner") return { ...base, status: "owner", kind: "owner", plan: null, starts_at: new Date(now - day).toISOString(), ends_at: null, ai_quota: null, ai_remaining: null, ai_available: null };
    if (role() === "expired") return { ...base, status: "expired", kind: "trial", plan: null, starts_at: new Date(now - 8 * day).toISOString(), ends_at: new Date(now - day).toISOString(), ai_quota: 3, ai_used: 3, ai_remaining: 0, ai_available: 0 };
    return { ...base, status: "trial", kind: "trial", plan: null, starts_at: new Date(now - day).toISOString(), ends_at: new Date(now + 6 * day).toISOString(), ai_quota: 3, ai_remaining: 3, ai_available: 3 };
  }
  const listeners = [];
  K.cloud = {
    enabled: true,
    testBuild: true,
    ensureUser: async () => {},
    listNotes: async () => copy(rows()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    getNote: async (id) => copy(rows().find((r) => r.id === id) || null),
    async createProcessingNote(id) {
      const l = rows();
      if (!l.some((r) => r.id === id)) l.push({ id, status: "processing", stage: "uploading", error_code: null, title: "Новый конспект", subject: null, preview: null, content: null, schema_version: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), paths: [] });
      save(l);
    },
    async renameNote(id, title) { patch(id, { title }); },
    async deleteNote(id) { save(rows().filter((r) => r.id !== id)); },
    async uploadPages(noteId, pages, done) {
      await sleep(600);
      const paths = pages.map((p, i) => uid() + "/" + noteId + "/" + String(i + 1).padStart(2, "0") + "-" + p.id + ".jpg");
      pages.forEach((p, i) => done && done.set && done.set(p.id, paths[i]));
      patch(noteId, { paths });
      return paths;
    },
    listPagePaths: async (noteId) => copy((rows().find((r) => r.id === noteId) || {}).paths || []),
    cleanupPhotos: async () => {},
    async startAnalysis(noteId, paths) {
      // как сервер v66: больше 4 фото — отказ у всех; без доступа — отказ
      const fail = (code) => { patch(noteId, { status: "failed", stage: "failed", error_code: code }); throw new Error(code); };
      if (paths.length > 4) fail("TOO_MANY_PAGES");
      if (role() === "expired") fail("ACCESS_EXPIRED");
      patch(noteId, { status: "processing", stage: "analyzing" });
      setTimeout(() => {
        const c = copy(K.mock.seedNotes()[1].content);
        c.meta.title = "Тестовый конспект: Внутренняя энергия";
        c.meta.pages = paths.map((_, i) => ({ index: i, readable: "ok" }));
        patch(noteId, { status: "ready", stage: "done", content: c, title: c.meta.title, subject: "physics", schema_version: c.schemaVersion || 1, preview: "Пример для проверки (фото: " + paths.length + "), это не распознанный текст" });
      }, 4000);
      return { status: "processing", note_id: noteId };
    },
    async waitForNote(noteId, { isCancelled } = {}) {
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        if (isCancelled && isCancelled()) throw new Error("CANCELLED");
        const r = rows().find((x) => x.id === noteId);
        if (!r) throw new Error("NOT_FOUND");
        if (r.status === "ready" || r.status === "failed") return copy(r);
      }
      throw new Error("STILL_PROCESSING");
    },
    getAccess: async () => null,
    getAccessV2: async () => copy(access()),
    getPlans: async () => [{ code: "premium", title: "Premium", days: 30, ai_quota: 10, price_label: null, description: "Тестовая сборка: оплата не работает", active: true }],
    async libraryParagraph(s, b, p) {
      await sleep(300);
      if (!["owner", "paid", "trial"].includes(access().status)) { const e = new Error("ACCESS_REQUIRED"); e.access = copy(access()); throw e; }
      // настоящие тексты библиотеки закрыты и в тестовую сборку не попадают — вместо них тестовый текст
      const para = (n) => ({ id: "b" + n, type: "PARAGRAPH", text: "ТЕСТОВЫЙ ТЕКСТ " + n + ". Настоящие конспекты библиотеки в тестовой сборке недоступны. Внутренняя энергия тела зависит от температуры: чем выше температура, тем больше энергия движения частиц. В стекле, в воде и в воздухе частицы движутся по-разному." });
      return { schemaVersion: 1, meta: { title: "Тестовый параграф " + p, subject: s, subjectLabel: "", topic: "Тест", tagline: [], summary: "Тестовый текст", accent: null, pages: [] },
        sections: [1, 2, 3, 4, 5, 6].map((n) => ({ id: "s" + n, heading: "Тестовый раздел " + n, blocks: [para(n * 2 - 1), para(n * 2)] })),
        glossary: { terms: [], dates: [], people: [], formulas: [] }, remember: [], conclusion: "", selfCheck: [], warnings: [] };
    },
    track: async (ev) => ({ ok: ev.length, skipped: 0 }),
    ownerRpc: async () => { throw new Error("OWNER_FAILED"); },
    peekUid: () => uid(),
    onUser: (f) => listeners.push(f),
    getAccount: () => (signedOut ? { kind: "signedOut", id: KN[role()], uid: null } : { kind: "participant", id: KN[role()], uid: uid() }),
    async signInWithId(id) { signedOut = false; return { id, uid: uid() }; },
    async signOut() { signedOut = true; return { uid: null }; },
    continueAsGuest: async () => ({ uid: uid() }),
    normalizeId: (s) => String(s || "").trim().toUpperCase(),
    normalizeKey: (s) => String(s || "").trim(),
    registerWithInvite: async () => { throw new Error("INVALID"); },
    finishRegistration: async () => {},
    pendingRegistration: () => null,
    clearPendingRegistration: () => {},
  };
})();
