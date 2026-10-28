// Заглушка js/cloud.js для тестов v61/v62: никакой сети, сценарий — в window.__T (задаёт addInitScript).
(() => {
  const K = (window.K = window.K || {});
  const T = (window.__T = window.__T || {});
  T.calls = T.calls || [];
  T.tracked = T.tracked || [];
  const listeners = [];
  const call = (n) => T.calls.push(n);
  K.cloud = {
    enabled: true,
    ensureUser: async () => {},
    listNotes: async () => (T.offline ? Promise.reject(new Error("NETWORK")) : JSON.parse(JSON.stringify(T.notes || []))),
    getNote: async (id) => (T.notes || []).find((n) => n.id === id) || null,
    createProcessingNote: async () => call("createProcessingNote"),
    renameNote: async () => call("renameNote"),
    deleteNote: async () => call("deleteNote"),
    uploadPages: async () => (call("uploadPages"), []),
    listPagePaths: async () => [],
    cleanupPhotos: async () => {},
    startAnalysis: async () => {
      call("startAnalysis");
      if (T.v2AfterStart) T.v2 = T.v2AfterStart; // сервер отказал: срок закончился во время работы
      throw new Error(T.startError || "ACCESS_EXPIRED");
    },
    waitForNote: async () => {
      throw new Error("STILL_PROCESSING");
    },
    getAccess() {
      call("getAccess");
      if (T.access === "hang") return new Promise(() => {});
      if (T.access === "error" || T.offline) return Promise.reject(new Error("CONNECTION_LOST"));
      return Promise.resolve(T.access ? { resource: "text_generation", reserved: 0, available: T.access.remaining, ...T.access } : null);
    },
    // v61: статус с сервера; "missing" — на сервере нет get_my_access_v2 (старая база)
    getAccessV2() {
      call("getAccessV2");
      if (T.v2 === "hang") return new Promise(() => {});
      if (T.v2 === "error" || T.offline) return Promise.reject(new Error("CONNECTION_LOST"));
      if (T.v2 === "missing" || T.v2 === undefined) return Promise.resolve(null);
      return Promise.resolve(JSON.parse(JSON.stringify(T.v2)));
    },
    getPlans() {
      call("getPlans");
      if (T.plansError) return Promise.reject(new Error("PLANS_FAILED"));
      return Promise.resolve(JSON.parse(JSON.stringify(T.plans || [])));
    },
    // v62: текст готового конспекта — как public.get_library_paragraph: решает «сервер» по T.v2 (owner/paid/trial),
    // текст тестовый (не настоящий конспект). T.libError: "network" | "missing"; T.libHang — ответа нет; T.libDelay — мс.
    async libraryParagraph(s, b, p) {
      call("libraryParagraph:" + s + "/" + b + "/" + p);
      if (T.libHang) return new Promise(() => {});
      if (T.libDelay) await new Promise((r) => setTimeout(r, T.libDelay));
      if (T.libError === "network" || T.offline) throw new Error("CONNECTION_LOST");
      if (T.libError === "missing") throw new Error("NOT_FOUND");
      const v2 = T.v2 && typeof T.v2 === "object" ? T.v2 : null;
      if (v2 && !["owner", "paid", "trial"].includes(v2.status)) {
        const e = new Error("ACCESS_REQUIRED");
        e.access = JSON.parse(JSON.stringify(v2));
        throw e;
      }
      return {
        schemaVersion: 1,
        meta: { title: "Тестовый конспект " + p, subject: s, subjectLabel: "", topic: "Тест", tagline: [], summary: "ТЕСТОВЫЙ ТЕКСТ " + p, accent: null, pages: [] },
        sections: [{ id: "s1", heading: "Тестовый раздел", blocks: [{ id: "b1", type: "PARAGRAPH", text: "ТЕСТОВЫЙ ТЕКСТ " + s + "/" + b + "/" + p }] }],
        glossary: { terms: [], dates: [], people: [], formulas: [] },
        remember: [], conclusion: "", selfCheck: [], warnings: [],
      };
    },
    track: async (ev) => (T.tracked.push(...ev), { ok: ev.length, skipped: 0 }),
    // v61.3: функции панели — в тестах панели идут в локальную базу через тестовый сервер (owner-ui.test.js),
    // от имени входа T.rpcUser (claims JWT задаёт сервер); T.rpcOffline — обрыв связи
    async ownerRpc(fn, args) {
      call("ownerRpc:" + fn);
      if (T.rpcOffline || T.offline) throw new Error("CONNECTION_LOST");
      const res = await fetch("/__rpc/" + fn, { method: "POST", headers: { "content-type": "application/json", "x-test-user": T.rpcUser || "none" }, body: JSON.stringify(args || {}) });
      if (!res.ok) throw new Error("OWNER_FAILED");
      return res.json();
    },
    peekUid: () => (T.kind === "signedOut" ? null : T.uid || null),
    onUser: (f) => listeners.push(f),
    getAccount: () =>
      T.kind === "participant"
        ? { kind: "participant", id: T.id, uid: T.uid }
        : T.kind === "signedOut"
          ? { kind: "signedOut", id: T.id || "", uid: null }
          : { kind: "guest", id: "", uid: T.uid || null },
    async signInWithId(id) {
      call("signInWithId");
      const next = (T.accounts || {})[id];
      if (!next) throw new Error("BAD_CREDENTIALS");
      Object.assign(T, next, { kind: "participant", id });
      return { id, uid: T.uid };
    },
    async signOut() {
      call("signOut");
      Object.assign(T, { kind: "guest", uid: "guest-uid", id: "", access: null });
      return { uid: T.uid };
    },
    continueAsGuest: async () => ({ uid: T.uid }),
    normalizeId: (s) => String(s || "").trim().toUpperCase(),
    normalizeKey: (s) => String(s || "").trim(),
    registerWithInvite: async () => {
      throw new Error("INVALID");
    },
    finishRegistration: async () => {},
    pendingRegistration: () => null,
    clearPendingRegistration: () => {},
  };
})();
