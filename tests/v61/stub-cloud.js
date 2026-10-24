// Заглушка js/cloud.js для тестов v61: никакой сети, сценарий — в window.__T (задаёт addInitScript).
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
    track: async (ev) => (T.tracked.push(...ev), { ok: ev.length, skipped: 0 }),
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
