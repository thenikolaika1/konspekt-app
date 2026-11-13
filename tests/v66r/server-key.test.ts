// v66: какой серверный ключ берут analyze-pages и register-invite (без сети, без ИИ, без настоящих ключей).
// Ключ `default` удалён 12.11.2026; функции должны работать на legacy service_role, а без него — на любом
// действующем секретном ключе (konspekt_server_2026 или другом), и честно отказывать (500), если ключей нет.
// Запуск: deno run --allow-env --allow-read --import-map=tests/v66r/import_map.json tests/v66r/server-key.test.ts
//   AP_DIR / RI_DIR — другие копии функций (негативный контроль: production-код 12.11 должен провалить проверки без `default`)
const print = console.log.bind(console);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x?: unknown) => { ok ? pass++ : fail++; print((ok ? "PASS " : "FAIL ") + n + (ok || x === undefined ? "" : " → " + JSON.stringify(x))); };
for (const k of ["log", "warn", "error"] as const) console[k] = () => {}; // журнал функций не нужен
// deno-lint-ignore no-explicit-any
(globalThis as any).__SIM = { notes: new Map(), files: new Map(), gens: [], ledger: new Map(), starts: [], users: new Map(), maxPages: 4, owners: new Set(), access: "ok", clock: () => new Date().toISOString() };
globalThis.fetch = () => Promise.reject(new Error("сеть в тесте запрещена"));
let handler: (r: Request) => Promise<Response> = () => Promise.reject(new Error("no handler"));
Object.defineProperty(Deno, "serve", { value: (h: typeof handler) => ((handler = h), {}), configurable: true, writable: true });
const AP = Deno.env.get("AP_DIR") || "../../supabase/functions/analyze-pages";
const RI = Deno.env.get("RI_DIR") || "../../supabase/functions/register-invite";
await import(AP + "/index.ts"); const ap = handler;
await import(RI + "/index.ts"); const ri = handler;
const FAKE_LEGACY = "eyJ-test-legacy", FAKE_NEW = "sb_secret_test_new", FAKE_OLD = "sb_secret_test_old";
const variants: [string, Record<string, string | undefined>, boolean][] = [
  ["legacy service_role (как сейчас в production)", { SUPABASE_SERVICE_ROLE_KEY: FAKE_LEGACY, SUPABASE_SECRET_KEYS: JSON.stringify({ konspekt_server_2026: FAKE_NEW }) }, true],
  ["без legacy, есть konspekt_server_2026 (default удалён)", { SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: JSON.stringify({ konspekt_server_2026: FAKE_NEW }) }, true],
  ["без legacy, есть только default (как до 12.11)", { SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: JSON.stringify({ default: FAKE_OLD }) }, true],
  ["без legacy, секретный ключ с другим именем", { SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: JSON.stringify({ server_2027: "sb_secret_x" }) }, true],
  ["ключей нет совсем", { SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: undefined }, false],
  ["SUPABASE_SECRET_KEYS повреждён", { SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: "{не json" }, false],
  ["в SUPABASE_SECRET_KEYS не секретный ключ", { SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: JSON.stringify({ other: "sb_publishable_x" }) }, false],
];
Deno.env.set("SUPABASE_URL", "http://sim.local"); Deno.env.set("GIGACHAT_AUTH_KEY", "giga-test");
for (const [name, env, ok] of variants) {
  for (const [k, v] of Object.entries(env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  // analyze-pages: без входа — 401, если ключ сервера найден; иначе 500 SERVER_MISCONFIGURED (до проверки входа)
  const a = await ap(new Request("http://sim.local/functions/v1/analyze-pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  const ab = await a.json();
  check(`analyze-pages: ${name} → ${ok ? "401 UNAUTHORIZED (ключ найден)" : "500 SERVER_MISCONFIGURED"}`, ok ? a.status === 401 && ab.error === "UNAUTHORIZED" : a.status === 500 && ab.error === "SERVER_MISCONFIGURED", [a.status, ab]);
  // register-invite: пустое тело — 400 BAD_REQUEST, если ключ найден; иначе 500 TEMPORARY
  const r = await ri(new Request("http://sim.local/functions/v1/register-invite", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://thenikolaika1.github.io" }, body: "{}" }));
  const rb = await r.json();
  check(`register-invite: ${name} → ${ok ? "400 BAD_REQUEST (ключ найден)" : "500 TEMPORARY"}`, ok ? r.status === 400 && rb.error === "BAD_REQUEST" : r.status === 500 && rb.error === "TEMPORARY", [r.status, rb]);
}
print(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
Deno.exit(fail ? 1 : 0);
