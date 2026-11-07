// Имитация Supabase для теста analyze-pages: notes, ai_generations, Storage temp-pages, Auth, RPC
// start_text_generation_v2 и итог резерва генерации (как триггер notes_finalize_usage). Состояние — globalThis.__SIM.
// Настоящий Supabase не вызывается.

type Row = Record<string, unknown>;
export type Sim = {
  notes: Map<string, Row>;
  files: Map<string, Uint8Array>;
  gens: Row[];
  /** резерв генерации по note: reserved → charged (ready) / refunded (failed) */
  ledger: Map<string, string>;
  starts: { note: string; pages: number }[];
  users: Map<string, string>; // token → user id
  maxPages: number;
  owners: Set<string>;
  access: string; // "ok" | результат отказа
  clock: () => string;
};
// deno-lint-ignore no-explicit-any
const sim = (): Sim => (globalThis as any).__SIM;

type Filter = { col: string; op: "eq" | "or"; val: unknown };
function match(row: Row, f: Filter): boolean {
  if (f.op === "eq") return String(row[f.col]) === String(f.val);
  // только используемая форма: "status.eq.failed,stage.is.null,stage.neq.analyzing"
  return String(f.val).split(",").some((c) => {
    const [col, op, v] = c.split(".");
    if (op === "eq") return String(row[col]) === v;
    if (op === "neq") return String(row[col]) !== v;
    if (op === "is") return row[col] === null || row[col] === undefined;
    return false;
  });
}

class Query {
  private filters: Filter[] = [];
  private kind: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private returning = false;
  constructor(private table: string) {}
  select(_cols?: string) {
    if (this.kind === "select") this.kind = "select";
    else this.returning = true;
    return this;
  }
  update(p: Row) {
    this.kind = "update";
    this.patch = p;
    return this;
  }
  insert(row: Row) {
    this.kind = "insert";
    this.patch = row;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  or(expr: string) {
    this.filters.push({ col: "", op: "or", val: expr });
    return this;
  }
  private run(): { data: unknown; error: null | { message: string } } {
    const s = sim();
    if (this.table === "ai_generations" && this.kind === "insert") {
      s.gens.push({ ...this.patch });
      return { data: null, error: null };
    }
    if (this.table !== "notes") return { data: null, error: { message: "unknown table " + this.table } };
    const rows = [...s.notes.values()].filter((r) => this.filters.every((f) => match(r, f)));
    if (this.kind === "select") return { data: rows.map((r) => ({ ...r })), error: null };
    const out: Row[] = [];
    for (const r of rows) {
      const before = r.status;
      // как PostgreSQL: updated_at хранится с микросекундами, отдаётся строкой
      Object.assign(r, this.patch, this.patch.updated_at ? { updated_at: s.clock() } : {});
      if (before !== r.status && (r.status === "ready" || r.status === "failed")) {
        const st = s.ledger.get(String(r.id));
        if (st === "reserved") s.ledger.set(String(r.id), r.status === "ready" ? "charged" : "refunded");
      }
      out.push({ ...r });
    }
    return { data: this.returning ? out : null, error: null };
  }
  maybeSingle() {
    const r = this.run();
    const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
    return Promise.resolve({ data: d, error: r.error });
  }
  then<T>(ok: (v: { data: unknown; error: null | { message: string } }) => T, bad?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

export function createClient(_url: string, _key: string, opts?: { global?: { headers?: Record<string, string> } }) {
  const asUser = (opts?.global?.headers?.Authorization || "").replace("Bearer ", "");
  return {
    auth: {
      getUser: (token: string) => {
        const id = sim().users.get(token);
        return Promise.resolve(id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } });
      },
    },
    from: (table: string) => new Query(table),
    rpc: (fn: string, args: Row) => {
      const s = sim();
      // вызов от имени пользователя (его JWT): статус доступа, как get_my_access_v2
      if (fn === "get_my_access_v2") {
        const uid = s.users.get(asUser);
        return Promise.resolve(uid ? { data: { status: s.owners.has(uid) ? "owner" : "trial" }, error: null } : { data: null, error: { message: "jwt" } });
      }
      if (fn !== "start_text_generation_v2") return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
      const note = s.notes.get(String(args.p_note_id));
      s.starts.push({ note: String(args.p_note_id), pages: Number(args.p_page_count) });
      if (!note) return Promise.resolve({ data: { result: "not_found" }, error: null });
      if (note.status === "ready") return Promise.resolve({ data: { result: "ready" }, error: null });
      if (note.status === "processing" && note.stage === "analyzing") return Promise.resolve({ data: { result: "already_processing" }, error: null });
      if (Number(args.p_page_count) > s.maxPages) return Promise.resolve({ data: { result: "too_many_pages", max_pages: s.maxPages }, error: null });
      if (s.access !== "ok") return Promise.resolve({ data: { result: s.access }, error: null });
      if (s.ledger.get(String(note.id)) === "charged") return Promise.resolve({ data: { result: "already_consumed" }, error: null });
      s.ledger.set(String(note.id), "reserved");
      Object.assign(note, { status: "processing", stage: "analyzing", error_code: null, updated_at: s.clock() });
      return Promise.resolve({ data: { result: "started" }, error: null });
    },
    storage: {
      from: (_bucket: string) => ({
        download: (path: string) => {
          const b = sim().files.get(path);
          return Promise.resolve(b ? { data: new Blob([b], { type: "image/jpeg" }), error: null } : { data: null, error: { message: "not found" } });
        },
        list: (folder: string) =>
          Promise.resolve({
            data: [...sim().files.keys()].filter((k) => k.startsWith(folder + "/")).map((k) => ({ id: k, name: k.slice(folder.length + 1) })),
            error: null,
          }),
        remove: (paths: string[]) => {
          paths.forEach((p) => sim().files.delete(p));
          return Promise.resolve({ data: null, error: null });
        },
      }),
    },
  };
}
export type SupabaseClient = ReturnType<typeof createClient>;
