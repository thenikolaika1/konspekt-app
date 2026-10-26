// v61.3: функции панели через НАСТОЯЩИЙ PostgREST 12 (как в Supabase) на локальной копии базы (НЕ production),
// вымышленные данные. Нужен исполняемый файл PostgREST (официальный выпуск GitHub): PGRST_BIN=/путь/postgrest.
// Без него тест пропускается (run.sh). Проверяет: доступ по JWT, все функции панели через HTTP, supabase-js приложения,
// запрет GET/HEAD для функций с секретами, отсутствие секретов в журналах для POST.
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const BIN = process.env.PGRST_BIN;
if (!BIN || !fs.existsSync(BIN)) {
  console.log("SKIP owner-pgrst: нет PostgREST (PGRST_BIN)");
  process.exit(0);
}
const DB = "pr61";
const PSQL = ["-h", process.env.PGHOST || "/var/lib/postgresql/pg61", "-p", process.env.PGPORT || "54361", "-U", "postgres", "-q", "-X", "-tA", "-v", "ON_ERROR_STOP=1"];
const psql = (db, sql) => execFileSync("psql", [...PSQL, "-d", db], { input: sql }).toString().trim();
const PGLOG = process.env.PGLOG || "/var/lib/postgresql/pg61/log.txt";
const pgLogStart = fs.existsSync(PGLOG) ? fs.statSync(PGLOG).size : 0; // журнал — только за этот прогон
const SECRET = crypto.randomBytes(32).toString("hex"); // одноразовый секрет только для этого прогона
const PORT_PGRST = 3301, PORT_PROXY = 3300;

let pass = 0, fail = 0;
const check = (n, ok, x) => (ok ? pass++ : fail++, console.log((ok ? "PASS " : "FAIL ") + n + (!ok && x !== undefined ? " → " + JSON.stringify(x).slice(0, 400) : "")));

// ---------- база: v61 + панель, вымышленные участники ----------
psql("postgres", "drop database if exists " + DB + "; create database " + DB + " template base61;");
psql(DB, fs.readFileSync(ROOT + "/supabase/migrations/20261024150000_paid_access.sql", "utf8"));
psql(DB, fs.readFileSync(ROOT + "/supabase/migrations/20261026120000_owner_panel.sql", "utf8"));
psql(DB, `
create function public.t_reg(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  perform public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  return v;
end $$;
revoke all on function public.t_reg(text, text) from public, anon, authenticated;
update private.ai_limits set max_total_starts = 40, total_starts = 7 where id;
select public.t_reg('PGRSTOWNER01', 'KN-TWAAAA'), public.t_reg('PGRSTSTUD001', 'KN-TSAAAA'), public.t_reg('PGRSTSTUD002', 'KN-TSBAAA');
select private.admin_set_owner('KN-TWAAAA');
-- PostgREST входит как authenticator (как в Supabase) и переключается на роль из JWT
alter role authenticator with login;
`);
const uid = (kn) => psql(DB, "select id from auth.users where email = private.kn_email('" + kn + "')");
const sess = (u) => psql(DB, "insert into auth.sessions (user_id) values ('" + u + "') returning id");
const UO = uid("KN-TWAAAA"), US = uid("KN-TSAAAA");
const SO = sess(UO), SS = sess(US);

// JWT как у Supabase Auth: HS256, role/sub/session_id/aal/is_anonymous/exp
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims, secret = SECRET) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ aud: "authenticated", role: "authenticated", aal: "aal1", is_anonymous: false, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return h + "." + p + "." + crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url");
}
const T = {
  owner: jwt({ sub: UO, session_id: SO }),
  student: jwt({ sub: US, session_id: SS }),
  ownerOtherSession: jwt({ sub: UO, session_id: crypto.randomUUID() }),
  ownerAnon: jwt({ sub: UO, session_id: SO, is_anonymous: true }),
  forged: jwt({ sub: UO, session_id: SO }, "wrong-secret-wrong-secret-wrong-secret"),
  expired: jwt({ sub: UO, session_id: SO, exp: Math.floor(Date.now() / 1000) - 60 }),
};

// ---------- PostgREST ----------
const CONF = path.join(require("os").tmpdir(), "konspekt-pgrst-" + process.pid + ".conf");
fs.writeFileSync(CONF, [
  'db-uri = "postgres://authenticator@/' + DB + '?host=' + (process.env.PGHOST || "/var/lib/postgresql/pg61") + '&port=' + (process.env.PGPORT || "54361") + '"',
  'db-schemas = "public"', 'db-anon-role = "anon"', 'db-extra-search-path = "public, extensions"',
  'jwt-secret = "' + SECRET + '"', "server-port = " + PORT_PGRST, 'server-host = "127.0.0.1"', 'log-level = "info"',
].join("\n"));
const pgrstLog = [];
const pg = spawn(BIN, [CONF]);
pg.stdout.on("data", (d) => pgrstLog.push(String(d)));
pg.stderr.on("data", (d) => pgrstLog.push(String(d)));

// прокси /rest/v1 → PostgREST (как адрес Supabase для supabase-js)
const proxyLog = [];
const proxy = http.createServer((req, res) => {
  proxyLog.push(req.method + " " + req.url);
  if (!req.url.startsWith("/rest/v1")) return res.writeHead(404).end();
  const r = http.request({ host: "127.0.0.1", port: PORT_PGRST, path: req.url.slice(8) || "/", method: req.method, headers: { ...req.headers, host: "127.0.0.1" } }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  req.pipe(r);
});

async function rpc(fn, args, token, method = "POST") {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const url = "http://127.0.0.1:" + PORT_PGRST + "/rpc/" + fn + (method === "GET" ? "?" + new URLSearchParams(args) : "");
  const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(args || {}) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = text;
  }
  return { status: res.status, body };
}

(async () => {
  await new Promise((r) => proxy.listen(PORT_PROXY, "127.0.0.1", r));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch("http://127.0.0.1:" + PORT_PGRST + "/")).ok) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const secrets = [];
  try {
    const api = await (await fetch("http://127.0.0.1:" + PORT_PGRST + "/", { headers: { authorization: "Bearer " + T.owner } })).json();
    const paths = Object.keys(api.paths || {});
    const ownerPaths = paths.filter((p) => p.startsWith("/rpc/owner_"));
    check("P1. PostgREST 12.2.3 запущен, в схеме API 18 функций панели", ownerPaths.length === 18, ownerPaths);
    check("P1. закрытые таблицы и admin_* не опубликованы в API", !paths.some((p) => /owner_panel|access_grants|beta_invites|admin_|panel_/.test(p.replace("/rpc/owner_panel_state", "").replace("/rpc/owner_panel_setup", ""))), paths.filter((p) => /admin_|panel_|private/.test(p)));

    // доступ без входа, с поддельным и просроченным JWT
    let r = await rpc("owner_unlock", { p_password: "x" }, null);
    check("P2. без входа (anon) → отказ PostgreSQL 401/42501, функция не выполнялась", r.status === 401 && r.body.code === "42501", r);
    r = await rpc("owner_unlock", { p_password: "x" }, T.forged);
    check("P3. поддельная подпись JWT → 401", r.status === 401, r);
    r = await rpc("owner_unlock", { p_password: "x" }, T.expired);
    check("P3. просроченный JWT → 401", r.status === 401, r);

    // ученик
    r = await rpc("owner_panel_state", {}, T.student);
    check("P4. ученик: owner_panel_state → {owner:false}", r.status === 200 && JSON.stringify(r.body) === '{"owner":false}', r);
    const sr = await Promise.all(["owner_unlock", "owner_overview", "owner_students", "owner_ai", "owner_history"].map((f) => rpc(f, f === "owner_unlock" ? { p_password: "x" } : { p_session: "x" }, T.student)));
    check("P4. ученик: функции панели → FORBIDDEN", sr.every((x) => x.status === 200 && x.body.error === "FORBIDDEN"), sr);
    r = await fetch("http://127.0.0.1:" + PORT_PGRST + "/owner_panel_secrets", { headers: { authorization: "Bearer " + T.student } });
    check("P4. ученик: таблица паролей не доступна через API (404)", r.status === 404, r.status);
    r = await rpc("owner_unlock", { p_password: "x" }, T.ownerOtherSession);
    check("P5. JWT владельца с несуществующей сессией входа (вышел из аккаунта) → FORBIDDEN", r.body.error === "FORBIDDEN", r);
    r = await rpc("owner_unlock", { p_password: "x" }, T.ownerAnon);
    check("P5. JWT с is_anonymous=true → FORBIDDEN", r.body.error === "FORBIDDEN", r);

    // владелец: установка пароля и вход
    r = await rpc("owner_panel_state", {}, T.owner);
    check("P6. владелец: owner=true, пароль не установлен", r.body.owner === true && r.body.password_set === false, r);
    const code = JSON.parse(psql(DB, "select private.admin_panel_setup('KN-TWAAAA')")).setup_code;
    const PW = "K8TQW-M3ZRH-P2XDN-G7VCJ";
    secrets.push(code, PW, PW.replace(/-/g, ""));
    r = await rpc("owner_panel_setup", { p_setup_code: code, p_new_password: PW }, T.owner);
    check("P6. owner_panel_setup через PostgREST → ok и сессия", r.body.result === "ok" && /^[0-9a-f]{64}$/.test(r.body.session), r);
    secrets.push(r.body.session);
    r = await rpc("owner_unlock", { p_password: "AAAAA-BBBBB-CCCCC-DDDDD" }, T.owner);
    check("P7. неверный пароль → WRONG_PASSWORD (HTTP 200, без подробностей)", r.status === 200 && r.body.error === "WRONG_PASSWORD" && Object.keys(r.body).length <= 2, r);
    r = await rpc("owner_unlock", { p_password: PW }, T.owner);
    const tok = r.body.session;
    secrets.push(tok);
    check("P7. верный пароль → сессия", /^[0-9a-f]{64}$/.test(tok || ""), r);
    r = await rpc("owner_overview", { p_session: tok }, T.student);
    check("P7. ключ сессии владельца с JWT ученика → FORBIDDEN", r.body.error === "FORBIDDEN", r);
    r = await rpc("owner_overview", { p_session: tok }, T.ownerOtherSession);
    check("P7. ключ сессии владельца с другой сессией входа → FORBIDDEN", r.body.error === "FORBIDDEN", r);

    // GET с ключом в адресе — запрещён для изменяемых функций
    // все данные и действия
    r = await rpc("owner_overview", { p_session: tok }, T.owner);
    check("P9. owner_overview: 3 ученика, бюджет 40/7", r.body.students?.total === 3 && r.body.ai?.budget === 40 && r.body.ai?.used === 7, r.body);
    r = await rpc("owner_students", { p_session: tok }, T.owner);
    check("P9. owner_students только с p_session (остальное — значения по умолчанию)", r.body.total === 3 && r.body.limit === 20, r.body);
    r = await rpc("owner_students", { p_session: tok, p_query: "kn-ts", p_filter: "trial", p_limit: 1, p_offset: 1 }, T.owner);
    check("P9. owner_students: поиск, фильтр, страницы (числа и строки из JSON)", r.body.total === 2 && r.body.items.length === 1, r.body);
    r = await rpc("owner_students", { p_session: tok, p_unknown: 1 }, T.owner);
    check("P9. неизвестный аргумент → PGRST202 (имена аргументов клиента должны совпадать — проверено тестом интерфейса)", r.status === 404 && r.body.code === "PGRST202", r);
    r = await rpc("owner_student", { p_session: tok, p_kn_id: "kn-tsaaaa" }, T.owner);
    check("P9. owner_student", r.body.kn_id === "KN-TSAAAA" && Array.isArray(r.body.history), r.body);
    const pv = (await rpc("owner_preview", { p_session: tok, p_kn_id: "KN-TSAAAA", p_action: "grant", p_days: 30, p_ai_quota: 20 }, T.owner)).body;
    check("P10. owner_preview выдачи: даты сервера", pv.days === 30 && pv.ai_quota === 20 && !!pv.ends_at, pv);
    const rq = crypto.randomUUID();
    r = await rpc("owner_grant", { p_session: tok, p_request_id: rq, p_kn_id: "KN-TSAAAA", p_days: 30, p_ai_quota: 20, p_note: "тест" }, T.owner);
    check("P10. owner_grant (uuid строкой) → granted, статус с сервера", r.body.result === "granted" && r.body.access?.status === "paid", r.body);
    r = await rpc("owner_grant", { p_session: tok, p_request_id: rq, p_kn_id: "KN-TSAAAA", p_days: 30, p_ai_quota: 20, p_note: "тест" }, T.owner);
    check("P10. повтор того же запроса → replayed", r.body.replayed === true, r.body);
    const pe = (await rpc("owner_preview", { p_session: tok, p_kn_id: "KN-TSAAAA", p_action: "extend", p_days: 30, p_ai_quota: 10 }, T.owner)).body;
    r = await rpc("owner_extend", { p_session: tok, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSAAAA", p_days: 30, p_ai_quota: 10, p_note: null, p_expect_starts_at: pe.starts_at }, T.owner);
    check("P10. owner_extend: дата из ответа сервера (JSON) принимается обратно точно (timestamptz)", r.body.result === "extended" && r.body.grant?.starts_at === pe.starts_at, { pe: pe.starts_at, r: r.body });
    r = await rpc("owner_extend", { p_session: tok, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSAAAA", p_days: 30, p_ai_quota: 10, p_note: null, p_expect_starts_at: pe.starts_at }, T.owner);
    check("P10. повторное подтверждение устаревшего предпросмотра → STATE_CHANGED", r.body.error === "STATE_CHANGED", r.body);
    const pr = (await rpc("owner_preview", { p_session: tok, p_kn_id: "KN-TSAAAA", p_action: "revoke" }, T.owner)).body;
    r = await rpc("owner_revoke", { p_session: tok, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSAAAA", p_note: null, p_expect_periods: pr.periods_count }, T.owner);
    check("P10. owner_revoke → revoked 2", r.body.result === "revoked" && r.body.revoked === 2, r.body);
    r = await rpc("owner_invite_create", { p_session: tok, p_request_id: crypto.randomUUID(), p_label: "тест", p_valid_days: 7 }, T.owner);
    const icode = r.body.code;
    secrets.push(icode);
    check("P11. owner_invite_create → код", /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(icode || ""), r.body);
    r = await rpc("owner_invites", { p_session: tok, p_filter: "active" }, T.owner);
    const inv = r.body.items?.find((x) => x.label === "тест");
    check("P11. owner_invites: код в списке без самого кода", !!inv && !JSON.stringify(r.body).includes(icode), r.body);
    r = await rpc("owner_invite_revoke", { p_session: tok, p_request_id: crypto.randomUUID(), p_invite_id: inv.invite_id }, T.owner);
    check("P11. owner_invite_revoke → revoked", r.body.result === "revoked", r.body);
    r = await rpc("owner_ai", { p_session: tok }, T.owner);
    check("P12. owner_ai", r.body.budget === 40 && Array.isArray(r.body.days) && r.body.days.length === 7, r.body);
    r = await rpc("owner_history", { p_session: tok, p_limit: 5, p_offset: 0 }, T.owner);
    check("P12. owner_history: страница из 5", r.body.items?.length === 5 && r.body.total > 5, r.body);

    // ---------- запрет GET/HEAD: точный список функций API и функций с секретами ----------
    const rpcs = paths.filter((p) => p.startsWith("/rpc/")).map((p) => p.slice(5)).sort();
    const props = api.paths;
    const secretArgs = ["p_password", "p_new_password", "p_current_password", "p_setup_code", "p_session", "p_code"];
    const withSecrets = rpcs.filter((f) => (props["/rpc/" + f]?.post?.parameters || []).some((x) => x.schema?.properties
      ? Object.keys(x.schema.properties).some((k) => secretArgs.includes(k))
      : false));
    check("G1. функции API для вошедшего: get_my_access, get_my_access_v2, get_plans, track и 18 owner_* (redeem_beta_invite убрана)",
      JSON.stringify(rpcs) === JSON.stringify(["get_my_access", "get_my_access_v2", "get_plans", "owner_ai", "owner_change_password", "owner_extend",
        "owner_grant", "owner_history", "owner_invite_create", "owner_invite_revoke", "owner_invites", "owner_lock", "owner_lock_all", "owner_overview",
        "owner_panel_setup", "owner_panel_state", "owner_preview", "owner_revoke", "owner_student", "owner_students", "owner_unlock", "track"]), rpcs);
    check("G1. функции с секретами в аргументах — только owner_* (17: все, кроме owner_panel_state)",
      withSecrets.length === 17 && withSecrets.every((f) => f.startsWith("owner_")), withSecrets);
    r = await rpc("redeem_beta_invite", { p_code: "AAAA-BBBB-CCCC" }, T.student);
    check("G1. старая redeem_beta_invite(p_code) через API — отказ прав (403, 42501: нет права на функцию)", r.status === 403 && r.body.code === "42501", r);
    const before = psql(DB, "select (select failed_count from private.owner_panel_secrets) || '/' || (select count(*) from private.owner_panel_sessions) || '/' || (select count(*) from private.owner_panel_sessions where revoked_at is not null) || '/' || (select count(*) from private.access_grants) || '/' || (select count(*) from private.beta_invites) || '/' || (select count(*) from private.owner_requests)");
    const S = tok, NEWPW = "H4WZT-9KQMR-2XDPN-C7VJG";
    secrets.push(NEWPW, NEWPW.replace(/-/g, ""));
    const GET_CALLS = [
      ["owner_panel_state", {}], ["owner_panel_setup", { p_setup_code: code, p_new_password: NEWPW }], ["owner_unlock", { p_password: PW }],
      ["owner_lock", { p_session: S }], ["owner_lock_all", { p_session: S }], ["owner_change_password", { p_session: S, p_current_password: PW, p_new_password: NEWPW }],
      ["owner_overview", { p_session: S }], ["owner_students", { p_session: S }], ["owner_student", { p_session: S, p_kn_id: "KN-TSAAAA" }],
      ["owner_preview", { p_session: S, p_kn_id: "KN-TSBAAA", p_action: "grant", p_days: 30, p_ai_quota: 20 }],
      ["owner_grant", { p_session: S, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSBAAA", p_days: 30, p_ai_quota: 20 }],
      ["owner_extend", { p_session: S, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSAAAA", p_days: 30, p_ai_quota: 20 }],
      ["owner_revoke", { p_session: S, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSAAAA", p_expect_periods: 1 }],
      ["owner_invite_create", { p_session: S, p_request_id: crypto.randomUUID(), p_label: "GET", p_valid_days: 7 }],
      ["owner_invites", { p_session: S }], ["owner_invite_revoke", { p_session: S, p_request_id: crypto.randomUUID(), p_invite_id: crypto.randomUUID() }],
      ["owner_ai", { p_session: S }], ["owner_history", { p_session: S }],
    ];
    const getR = [];
    for (const [f, a] of GET_CALLS) getR.push([f, await rpc(f, a, T.owner, "GET")]);
    check("G2. все 18 функций панели через GET (с верными паролем и ключом сессии) → METHOD_NOT_ALLOWED",
      getR.length === 18 && getR.every(([, x]) => x.status === 200 && x.body?.error === "METHOD_NOT_ALLOWED"),
      getR.filter(([, x]) => x.body?.error !== "METHOD_NOT_ALLOWED").map(([f, x]) => f + ":" + x.status + ":" + JSON.stringify(x.body).slice(0, 80)));
    const headR = [];
    for (const [f, a] of GET_CALLS) {
      const res = await fetch("http://127.0.0.1:" + PORT_PGRST + "/rpc/" + f + "?" + new URLSearchParams(a), { method: "HEAD", headers: { authorization: "Bearer " + T.owner } });
      headR.push(res.status);
    }
    const after = psql(DB, "select (select failed_count from private.owner_panel_secrets) || '/' || (select count(*) from private.owner_panel_sessions) || '/' || (select count(*) from private.owner_panel_sessions where revoked_at is not null) || '/' || (select count(*) from private.access_grants) || '/' || (select count(*) from private.beta_invites) || '/' || (select count(*) from private.owner_requests)");
    check("G3. через GET и HEAD ничего не выполнилось: попытки пароля, сессии, выдачи, коды, операции — без изменений", before === after, { before, after, headR });
    check("G4. ответ отказа не содержит аргументов", getR.every(([, x]) => !secrets.some((v) => v && JSON.stringify(x.body).includes(v))));
    r = await rpc("owner_overview", { p_session: tok }, T.owner);
    check("G5. после этого POST работает как раньше (та же сессия)", r.body.students?.total === 3, r.body);

    // supabase-js — та же сборка, что в приложении (js/vendor/supabase.js)
    const ctx = vm.createContext({ WebSocket: globalThis.WebSocket || class {}, fetch, Headers, Request, Response, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, globalThis: {} });
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(ROOT + "/js/vendor/supabase.js", "utf8"), ctx);
    const sb = ctx.supabase.createClient("http://127.0.0.1:" + PORT_PROXY, "local-test-anon-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: "Bearer " + T.owner } },
    });
    let { data, error } = await sb.rpc("owner_unlock", { p_password: PW });
    const tok2 = data?.session;
    secrets.push(tok2);
    check("P13. supabase-js (сборка приложения): rpc owner_unlock → сессия", !error && /^[0-9a-f]{64}$/.test(tok2 || ""), { data, error });
    ({ data, error } = await sb.rpc("owner_grant", { p_session: tok2, p_request_id: crypto.randomUUID(), p_kn_id: "KN-TSBAAA", p_days: 7, p_ai_quota: 3, p_note: null }));
    check("P13. supabase-js: rpc owner_grant → granted (объект, как ждёт js/owner.js)", !error && data?.result === "granted" && typeof data === "object", { data, error });
    ({ data, error } = await sb.rpc("owner_overview", { p_session: tok2 }));
    check("P13. supabase-js: rpc owner_overview → объект", !error && data?.students?.total === 3, { error });
    check("P13. supabase-js (как приложение) вызывает функции панели только POST, без аргументов в адресе", proxyLog.length >= 3
      && proxyLog.every((l) => /^POST \/rest\/v1\/rpc\/owner_[a-z_]+$/.test(l)), proxyLog);

    // перебор через пул соединений PostgREST: 10 неверных одновременно
    const brute = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc("owner_unlock", { p_password: "AAAAA-BBBBB-CCCCC-DDDD" + "EFGHJKMNPQ"[i] }, T.owner)));
    const errs = brute.map((x) => x.body.error);
    check("P14. 10 одновременных неверных паролей через PostgREST: 4 WRONG_PASSWORD, 6 LOCKED (засчитано ровно 5)",
      errs.filter((e) => e === "WRONG_PASSWORD").length === 4 && errs.filter((e) => e === "LOCKED").length === 6, errs);
    r = await rpc("owner_unlock", { p_password: PW }, T.owner);
    check("P14. во время паузы верный пароль → LOCKED", r.body.error === "LOCKED", r.body);
    psql(DB, "update private.owner_panel_secrets set locked_until = null, failed_count = 0, lock_level = 0");

    // смена пароля, выход
    const PW2 = "Q7MZK-3HRWD-X9TNP-C4YGJ";
    secrets.push(PW2, PW2.replace(/-/g, ""));
    const t3 = (await rpc("owner_unlock", { p_password: PW }, T.owner)).body.session;
    r = await rpc("owner_change_password", { p_session: t3, p_current_password: PW, p_new_password: PW2 }, T.owner);
    secrets.push(t3, r.body.session);
    check("P15. owner_change_password → новая сессия; старые закрыты", r.body.result === "ok" && (await rpc("owner_overview", { p_session: tok }, T.owner)).body.error === "PANEL_LOCKED", r.body);
    r = await rpc("owner_lock", { p_session: r.body.session }, T.owner);
    check("P15. owner_lock → ok", r.body.result === "ok", r.body);
  } catch (e) {
    check("без исключений", false, String(e.stack));
  }
  pg.kill();
  proxy.close();
  await new Promise((r) => setTimeout(r, 300));
  // журналы: ни пароля, ни кода установки, ни ключей сессий, ни кода приглашения
  const pgLog = fs.readFileSync(PGLOG, "utf8").slice(pgLogStart);
  const restLog = pgrstLog.join("");
  const lines = restLog.split("\n");
  const inPost = secrets.filter((v) => v && lines.some((l) => !/"(GET|HEAD) /.test(l) && l.includes(v)));
  const inPg = secrets.filter((v) => v && pgLog.includes(v));
  check("P16. журнал PostgreSQL за прогон: нет паролей, кодов и ключей сессий (" + secrets.filter(Boolean).length + " значений)", inPg.length === 0, inPg.map((v) => v.slice(0, 4) + "…"));
  check("P16. журнал PostgREST: в строках POST — только метод, путь и статус, ни одного секрета", inPost.length === 0
    && lines.filter((l) => /"POST \/rpc\//.test(l)).every((l) => /"POST \/rpc\/[a-z_0-9]+ HTTP/.test(l)), inPost.map((v) => v.slice(0, 4) + "…"));
  const getLines = lines.filter((l) => /"(GET|HEAD) \/rpc\/owner_/.test(l));
  check("P16. (ограничение) адрес GET-запроса шлюз пишет в журнал до базы: секреты есть только в строках нарочных GET/HEAD этого теста",
    getLines.length === 36 && secrets.filter((v) => v && lines.some((l) => l.includes(v))).every((v) => getLines.some((l) => l.includes(v))), getLines.length);
  console.log("ИТОГО: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
