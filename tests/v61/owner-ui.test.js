// v61.3: панель владельца в браузере (Chromium, размеры iPhone) — против НАСТОЯЩИХ функций public.owner_* в локальной
// копии базы (НЕ production). Тестовый сервер передаёт вызовы панели в PostgreSQL с ролью authenticated и claims JWT
// выбранного входа (владелец / ученик / F&F / гость) — как это делает PostgREST Supabase. Вход Supabase Auth заменён
// заглушкой (stub-cloud.js), всё остальное — реальный код приложения и панели.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync, execFile } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "../..");
const SHOTS = process.env.SHOTS_DIR || path.join(require("os").tmpdir(), "konspekt-v613-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const STUB = fs.readFileSync(path.join(HERE, "stub-cloud.js"), "utf8");
const PORT = 8191;
const DB = "ou61";
const PSQL = ["-h", process.env.PGHOST || "/var/lib/postgresql/pg61", "-p", process.env.PGPORT || "54361", "-U", "postgres", "-q", "-X", "-tA"];
const psql = (db, sql, vars = {}) =>
  execFileSync("psql", [...PSQL, "-d", db, "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", k + "=" + v])], { input: sql }).toString().trim();
const sqlv = (sql) => psql(DB, sql);

let pass = 0, fail = 0;
function check(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (extra !== undefined && !ok ? " → " + JSON.stringify(extra).slice(0, 400) : ""));
}

// ---------- база: v61 + панель, владелец, 24 ученика, F&F ----------
psql("postgres", "drop database if exists " + DB + "; create database " + DB + " template base61;");
psql(DB, fs.readFileSync(path.join(ROOT, "supabase/migrations/20261024150000_paid_access.sql"), "utf8"));
psql(DB, fs.readFileSync(path.join(ROOT, "supabase/migrations/20261026120000_owner_panel.sql"), "utf8"));
psql(DB, `
create function public.t_reg(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, encrypted_password, raw_app_meta_data)
  values (private.kn_email(p_kn), extensions.crypt('Kn-2.KEYABCDEFGHJKMNPQRST', extensions.gen_salt('bf', 4)), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  perform public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  return v;
end $$;
-- вызов функции панели как через PostgREST: роль authenticated, claims JWT, именованные аргументы с типами функции
create function public.t_call(p_fn text, p_args jsonb, p_claims jsonb) returns jsonb language plpgsql as $$
declare v_parts text[] := '{}'; k text; v jsonb; r jsonb; t text;
begin
  if p_fn !~ '^owner_[a-z_]+$' then raise exception 'bad fn'; end if;
  perform set_config('request.jwt.claims', p_claims::text, true);
  for k, v in select * from jsonb_each(p_args) loop
    select format_type(a.ty, null) into t
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           lateral unnest(p.proargtypes::oid[], p.proargnames[1:p.pronargs]) a(ty, nm)
     where n.nspname = 'public' and p.proname = p_fn and a.nm = k;
    if t is null then raise exception 'bad arg %', k; end if;
    v_parts := v_parts || format('%I => %L::%s', k, case when jsonb_typeof(v) = 'null' then null else v #>> '{}' end, t);
  end loop;
  set local role authenticated;
  execute format('select public.%I(%s)', p_fn, array_to_string(v_parts, ', ')) into r;
  reset role;
  return r;
end $$;
update private.ai_limits set max_total_starts = 40, total_starts = 7 where id;
select public.t_reg('UIOWNER00001', 'KN-WAAAAA');
select private.admin_set_owner('KN-WAAAAA');
select public.t_reg('UISTUD' || lpad(i::text, 6, '0'), 'KN-S' || translate(lpad(i::text, 5, '0'), '0123456789', 'ABCDEFGHJK')) from generate_series(1, 24) i;
do $$ declare v uuid; begin
  insert into auth.users (email) values (private.kn_email('KN-FFAAAA')) returning id into v;
  update private.access_settings set trial_on_register = false;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
  update private.access_settings set trial_on_register = true;
end $$;
`);
const uid = (kn) => sqlv("select id from auth.users where email = private.kn_email('" + kn + "')");
const USERS = {};
for (const [name, kn] of [["owner", "KN-WAAAAA"], ["student", "KN-SAAAAB"], ["ff", "KN-FFAAAA"]]) {
  const u = uid(kn);
  USERS[name] = { sub: u, session_id: sqlv("insert into auth.sessions (user_id) values ('" + u + "') returning id"), role: "authenticated", is_anonymous: false };
}
USERS.none = { role: "anon" };
const ownerSessionValid = () => sqlv("select count(*) from private.owner_panel_sessions where revoked_at is null and expires_at > now()");

// ---------- тестовый сервер: файлы сайта + /__rpc → PostgreSQL ----------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
const rpcLog = [];
const server = http.createServer((req, res) => {
  const p0 = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (req.method === "POST" && p0.startsWith("/__rpc/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fn = p0.slice(7);
      const claims = USERS[req.headers["x-test-user"]] || USERS.none;
      rpcLog.push({ fn, body, method: req.method, url: req.url });
      execFile("psql", [...PSQL, "-d", DB, "-v", "fn=" + fn, "-v", "args=" + (body || "{}"), "-v", "claims=" + JSON.stringify(claims)],
        (err, out, errOut) => {
          if (err) return res.writeHead(500).end(String(errOut));
          res.writeHead(200, { "content-type": "application/json" }).end(out.trim() || "null");
        }).stdin?.end("select public.t_call(:'fn', :'args'::jsonb, :'claims'::jsonb);");
    });
    return;
  }
  let p = p0;
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
});

// ---------- браузер ----------
const NOW = new Date().toISOString();
const V2 = {
  owner: { status: "owner", kind: "owner", starts_at: NOW, ends_at: null, server_now: NOW, ai_quota: null, ai_used: 0, ai_reserved: 0, ai_remaining: null, ai_available: null },
  paid: { status: "paid", kind: "paid", starts_at: NOW, ends_at: NOW, paid_until: new Date(Date.now() + 20 * 864e5).toISOString(), server_now: NOW, ai_quota: 20, ai_used: 0, ai_reserved: 0, ai_remaining: 20, ai_available: 20 },
  ff: { status: "expired", kind: "legacy", legacy_source: "beta_invite", starts_at: "2026-10-18T21:00:00Z", ends_at: "2026-10-23T21:00:00Z", server_now: NOW, ai_quota: 1, ai_used: 0, ai_reserved: 0, ai_remaining: 0, ai_available: 0 },
};
let browser;
async function open(T, viewport = { width: 390, height: 844 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 700, hasTouch: viewport.width < 700, serviceWorkers: opts.sw ? "allow" : "block" });
  const blocked = [];
  await ctx.route("**/*", (r) => {
    const u = r.request().url();
    if (/supabase\.co/.test(u)) return blocked.push(u), r.abort();
    if (/\/js\/cloud\.js/.test(u)) return r.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
    return r.continue();
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => (window.__T = Object.assign(window.__T || {}, JSON.parse(t))), JSON.stringify(T));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("k-first", "1");
    } catch (e) {}
  });
  const errors = [];
  const consoleLog = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => consoleLog.push(m.type() + " " + m.text()));
  page.on("dialog", (d) => d.accept());
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForTimeout(1600);
  for (let i = 0; i < 4; i++) {
    const b = await page.$(".welcome:not(.access) .primary");
    if (!b) break;
    await b.click();
    await page.waitForTimeout(300);
  }
  return { ctx, page, errors, blocked, consoleLog };
}
const appText = (p) => p.evaluate(() => document.querySelector("#app > .app")?.innerText || "");
const owText = (p) => p.evaluate(() => document.querySelector("#owner-root")?.innerText || "");
const wait = (p, ms = 700) => p.waitForTimeout(ms);
async function toProfile(page) {
  await page.click('.tabbar [data-tab="me"]');
  await wait(page);
}
async function until(page, fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(page, 200);
  }
  return false;
}
const owSel = (page, s) => page.$("#owner-root " + s);
async function owClick(page, s, ms = 900) {
  await page.click("#owner-root " + s);
  await wait(page, ms);
}
const noHScroll = (page) => page.evaluate(() => {
  const m = document.querySelector("#owner-root .ow-main");
  return !!m && m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
});
const OWNER = { kind: "participant", id: "KN-WAAAAA", uid: "owner-uid", v2: V2.owner, rpcUser: "owner" };
const PW = "HJKMN-PQRST-23456-WXYZA";

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch();
  try {
    // 1–3. гость, ученик, F&F: кнопки нет, код панели не загружается
    for (const [name, T] of [
      ["гость", { kind: "guest", uid: "guest-uid", v2: { status: "none", kind: null, server_now: NOW }, rpcUser: "none" }],
      ["ученик", { kind: "participant", id: "KN-SAAAAB", uid: "s-uid", v2: V2.paid, rpcUser: "student" }],
      ["F&F", { kind: "participant", id: "KN-FFAAAA", uid: "f-uid", v2: V2.ff, rpcUser: "ff" }],
    ]) {
      const { ctx, page, errors } = await open(T);
      if (name !== "гость") await toProfile(page);
      const t = await appText(page);
      const loaded = await page.evaluate(() => !!window.K.owner || !!document.querySelector('script[src*="owner.js"],link[href*="owner.css"]'));
      check("U" + (name === "гость" ? 1 : name === "ученик" ? 2 : 3) + ". " + name + ": нет кнопки «Панель владельца», код панели не загружен",
        !t.includes("Панель владельца") && !(await page.$("[data-owner-panel]")) && !loaded, t.slice(0, 200));
      if (name !== "гость") {
        // даже прямой вызов функций панели из консоли браузера — отказ сервера
        const r = await page.evaluate(async () => [await K.cloud.ownerRpc("owner_unlock", { p_password: "HJKMN-PQRST-23456-WXYZA" }), await K.cloud.ownerRpc("owner_overview", { p_session: "x" })]);
        check("U" + (name === "ученик" ? 2 : 3) + ". " + name + ": ручной вызов owner_unlock / owner_overview из браузера → FORBIDDEN", r.every((x) => x.error === "FORBIDDEN"), r);
      }
      check("U1–3. " + name + ": нет ошибок JS", !errors.length, errors);
      await ctx.close();
    }

    // 4–5. владелец: кнопка → пароль не установлен → установка по одноразовому коду
    const o = await open(OWNER);
    const { page } = o;
    await toProfile(page);
    check("U4. владелец: кнопка «👑 Панель владельца» в «Я»", (await appText(page)).includes("Панель владельца"));
    await page.click("[data-owner-panel]");
    await until(page, async () => (await owText(page)).includes("Пароль ещё не установлен"));
    let t = await owText(page);
    check("U4. панель без пароля: инструкция с командой для своего ID", t.includes("Пароль ещё не установлен") && t.includes("admin_panel_setup('KN-WAAAAA')"), t.slice(0, 300));
    const code = JSON.parse(sqlv("select private.admin_panel_setup('KN-WAAAAA')")).setup_code;
    await owClick(page, '[data-ow-act="recheck"]', 1200);
    t = await owText(page);
    const gen = await page.$eval("#owner-root [data-ow-pw]", (n) => n.textContent);
    check("U5. экран установки: пароль сгенерирован на устройстве (20 символов, XXXXX-…)", /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(gen) && t.includes("Сохрани пароль"), gen);
    await owClick(page, '[data-ow-act="regen"]', 300);
    const gen2 = await page.$eval("#owner-root [data-ow-pw]", (n) => n.textContent);
    check("U5. «Другой пароль» — новый случайный", gen2 !== gen && /^[A-Z2-9-]{23}$/.test(gen2));
    await page.screenshot({ path: path.join(SHOTS, "owner-setup.png") });
    // свой пароль из генератора на компьютере (tools/owner-panel-password.mjs)
    await owClick(page, '[data-ow-act="own"]', 300);
    await page.fill("#owner-root #owSetupCode", code);
    await page.fill("#owner-root #owOwnPassword", PW);
    await owClick(page, 'button[type="submit"]', 700);
    check("U5. без галочки «Я сохранил пароль» установка не начинается", (await owText(page)).includes("Сначала сохрани пароль") || (await page.$eval("#owner-root #owSaved", (n) => n.validity.valueMissing)));
    await page.fill("#owner-root #owSetupCode", code);
    await page.fill("#owner-root #owOwnPassword", PW);
    await page.check("#owner-root #owSaved");
    await owClick(page, 'button[type="submit"]', 2500);
    t = await owText(page);
    check("U5. пароль установлен → главная панели", t.includes("Пароль установлен") && t.includes("всего зарегистрировано"), t.slice(0, 300));
    const store = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    check("U5. пароль не сохранён ни в localStorage, ни в sessionStorage; там только ключ сессии панели",
      !store.includes(PW) && !store.includes(PW.replace(/-/g, "")) && /kn-owner-panel/.test(store) && !store.includes(code), store.slice(0, 300));

    // 6. главная — реальные числа сервера
    t = await owText(page);
    check("U6. главная: 26 учеников (24 + F&F + владелец), бюджет 40 / использовано 7 / осталось 33, ИИ «Работает»",
      /26\s*всего зарегистрировано/.test(t) && t.includes("33") && t.includes("Работает") && t.includes("40"), t.slice(0, 500));
    await page.screenshot({ path: path.join(SHOTS, "owner-home-390.png"), fullPage: false });
    check("U36. главная 390 px: без горизонтальной прокрутки", await noHScroll(page));

    // 7. ученики: список, поиск, фильтр, страницы
    await owClick(page, '[data-ow-tab="students"]', 1500);
    t = await owText(page);
    check("U7. ученики: 26, первая страница 20 и «Показать ещё (6)»", t.includes("26 учеников") && t.includes("Показать ещё (6)") && (await page.$$("#owner-root [data-ow-student]")).length === 20, t.slice(0, 200));
    await owClick(page, '[data-ow-act="more"]', 1500);
    check("U7. «Показать ещё» догружает остальные 6", (await page.$$("#owner-root [data-ow-student]")).length === 26);
    await page.fill("#owner-root #owSearch", "kn-saaaab");
    await wait(page, 1500);
    check("U7. поиск «kn-saaaab» (строчные, с KN-) → 1 (KN-SAAAAB)", (await page.$$("#owner-root [data-ow-student]")).length === 1 && (await owText(page)).includes("KN-SAAAAB"));
    check("U7. поле поиска сохраняет фокус при обновлении списка", await page.evaluate(() => document.activeElement?.id === "owSearch"));
    await page.fill("#owner-root #owSearch", "SAAAB");
    await wait(page, 1500);
    check("U7. поиск по части ID «SAAAB» → несколько учеников", (await page.$$("#owner-root [data-ow-student]")).length >= 2);
    await page.fill("#owner-root #owSearch", "QQQQ");
    await wait(page, 1500);
    check("U7. поиск без результата — «Ничего не найдено»", (await owText(page)).includes("Ничего не найдено"));
    await page.fill("#owner-root #owSearch", "");
    await wait(page, 1200);
    await owClick(page, '[data-ow-filter="legacy"]', 1500);
    check("U7. фильтр F&F → KN-FFAAAA", (await page.$$("#owner-root [data-ow-student]")).length === 1 && (await owText(page)).includes("KN-FFAAAA"));
    await owClick(page, '[data-ow-filter="all"]', 1500);

    // 8. выдача подписки из карточки ученика: форма → подтверждение с датами сервера → результат
    await owClick(page, '[data-ow-student="KN-SAAAAB"]', 1500);
    t = await owText(page);
    check("U8. карточка ученика: ID, статус «Пробный», регистрация, история; кнопка «Выдать подписку»", t.includes("KN-SAAAAB") && t.includes("Пробный") && t.includes("Регистрация") && t.includes("Выдать подписку"), t.slice(0, 300));
    await page.screenshot({ path: path.join(SHOTS, "owner-student.png") });
    await owClick(page, '[data-ow-act="grant"]', 600);
    check("U8. форма: ID ученика подставлен и не редактируется", (await page.$eval("#owner-root #owKn", (n) => n.value + "|" + n.readOnly)) === "KN-SAAAAB|true");
    await owClick(page, '[data-ow-days="30"]', 300);
    await page.fill("#owner-root #owQuota", "20");
    await page.fill("#owner-root #owNote", "оплата 26.10");
    await owClick(page, 'button[type="submit"]', 1800);
    t = await owText(page);
    const end30 = new Date(Date.now() + 30 * 864e5).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric" });
    check("U8. подтверждение: ID, «Выдача подписки», 30 дней, 20 генераций, начало сразу, окончание — дата сервера",
      t.includes("KN-SAAAAB") && t.includes("Выдача подписки") && t.includes("30 дней") && t.includes("20 генераций") && t.includes("сразу после подтверждения") && t.includes(end30), t.slice(0, 400));
    check("U8. до подтверждения выдачи нет", sqlv("select count(*) from private.access_grants g join auth.users u on u.id = g.user_id where u.email = private.kn_email('KN-SAAAAB') and g.kind = 'paid'") === "0");
    await page.screenshot({ path: path.join(SHOTS, "owner-confirm.png") });
    // двойное нажатие «Подтвердить»
    await page.evaluate(() => {
      const b = document.querySelector('#owner-root [data-ow-act="commit"]');
      b.click();
      b.click();
    });
    await until(page, async () => (await owText(page)).includes("Подписка выдана"));
    t = await owText(page);
    check("U8. результат после ответа сервера: «Подписка выдана», срок, лимит, статус с сервера", t.includes("Подписка выдана") && t.includes("20 генераций") && t.includes("Подписка") && t.includes("ИИ 20 из 20"), t.slice(0, 400));
    check("U19. двойное нажатие — одна выдача в базе", sqlv("select count(*) from private.access_grants g join auth.users u on u.id = g.user_id where u.email = private.kn_email('KN-SAAAAB') and g.kind = 'paid'") === "1");
    check("U8. журнал: выдача от имени панели", sqlv("select count(*) from private.access_log where action = 'grant' and actor = 'panel:KN-WAAAAA'") === "1");

    // 9. продление: встык к текущему сроку
    await owClick(page, '[data-ow-act="to-student"]', 1500);
    await owClick(page, '[data-ow-act="extend"]', 600);
    await owClick(page, '[data-ow-days="30"]', 300);
    await page.fill("#owner-root #owQuota", "10");
    await owClick(page, 'button[type="submit"]', 1800);
    t = await owText(page);
    check("U9. подтверждение продления: начало «после текущего срока» = окончание текущего, правила v61.2 объяснены",
      t.includes("Продление") && t.includes(end30 + " (после текущего срока)") && t.includes("Оплаченные дни текущего срока сохраняются"), t.slice(0, 400));
    await owClick(page, '[data-ow-act="commit"]', 2000);
    check("U9. «Подписка продлена»", (await owText(page)).includes("Подписка продлена"));
    check("U9. в базе 2 срока, второй начинается в конце первого", sqlv(`select count(*) || ':' || (max(starts_at) = min(ends_at))::text from private.access_grants g join auth.users u on u.id = g.user_id where u.email = private.kn_email('KN-SAAAAB') and g.kind = 'paid'`) === "2:true");

    // 10. отзыв: все сроки видны, подтверждение частью ID
    await owClick(page, '[data-ow-act="to-student"]', 1500);
    await owClick(page, '[data-ow-act="revoke"]', 1500);
    t = await owText(page);
    check("U10. отзыв: предупреждение «все 2 оплаченных срока», список сроков, последствия", t.includes("все 2 оплаченных срока") && t.includes("Аккаунт и конспекты ученика сохранятся"), t.slice(0, 400));
    await page.screenshot({ path: path.join(SHOTS, "owner-revoke.png") });
    await page.fill("#owner-root #owTail", "XYZ");
    await owClick(page, 'button[type="submit"]', 700);
    check("U10. неверные последние символы ID — отзыва нет", (await owText(page)).includes("не совпадают") && sqlv("select count(*) from private.access_log where action = 'revoke'") === "0");
    await page.fill("#owner-root #owTail", "aab");
    await owClick(page, 'button[type="submit"]', 2000);
    t = await owText(page);
    check("U10. отзыв выполнен: «Доступ отозван», отозвано сроков 2, статус перечитан с сервера", t.includes("Доступ отозван") && t.includes("Отозвано сроков") && /2/.test(t), t.slice(0, 400));

    // 11. приглашения: создание, код один раз, копирование, отзыв (экран результата — без вкладок: «На главную»)
    await owClick(page, '[data-ow-tab="home"]', 1500);
    await owClick(page, '[data-ow-tab="invites"]', 1500);
    await owClick(page, '[data-ow-go="invite-new"]', 600);
    const long = "Ученик с очень длинной подписью для проверки переноса строк в списке приглашений на iPhone SE 7Б класс";
    await page.fill("#owner-root #owInvLabel", long.slice(0, 100));
    await owClick(page, '[data-ow-days="14"]', 300);
    await owClick(page, 'button[type="submit"]', 2000);
    const icode = await page.$eval("#owner-root [data-ow-code]", (n) => n.textContent).catch(() => "");
    check("U22. код создан: XXXX-XXXX-XXXX, кнопки «Скопировать» и «Поделиться», предупреждение «показывается только сейчас»",
      /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(icode) && (await owText(page)).includes("Поделиться") && (await owText(page)).includes("показывается только сейчас"), icode);
    check("U22. в базе только отпечаток кода", sqlv("select count(*) from private.beta_invites where code_hash = private.invite_code_hash('" + icode + "')") === "1"
      && sqlv("select count(*) from private.beta_invites where label like '%" + icode + "%'") === "0");
    await page.screenshot({ path: path.join(SHOTS, "owner-invite-code.png") });
    await owClick(page, '[data-ow-tab="invites"]', 1500);
    t = await owText(page);
    check("U29. после выхода с экрана кода он больше нигде не виден", !t.includes(icode) && !(await page.content()).includes(icode));
    check("U37. длинная подпись: без горизонтальной прокрутки", await noHScroll(page));
    check("U22. в списке: «Активно», подпись, «из 10» за сутки", t.includes("Активно") && t.includes("Ученик с очень длинной") && t.includes("из 10"), t.slice(0, 300));
    await owClick(page, '[data-ow-act="inv-revoke"]', 2000);
    t = await owText(page);
    check("U25. отзыв кода (с подтверждением): «Приглашение отозвано», статус «Отозвано»; регистрация по нему невозможна",
      t.includes("Приглашение отозвано") && t.includes("Отозвано") && sqlv("select public.register_invite_begin('" + icode + "', 'KN-NAAAAA', repeat('d', 64)) ->> 'result'") !== "reserved", t.slice(0, 300));

    // 12. ИИ и бюджет: реальные значения, автостоп
    await owClick(page, '[data-ow-tab="ai"]', 1500);
    t = await owText(page);
    check("U34. ИИ: осталось 33, бюджет 40, «Работает», 7 дней", t.includes("33") && t.includes("40") && t.includes("Работает") && t.includes("7 дней"), t.slice(0, 300));
    sqlv(`insert into private.generation_starts (user_id, op_key, started_at, outcome, error_code, finished_at)
      select u.id, 'x' || g, now() - interval '5 minutes', 'failed', 'AI_TIMEOUT', now() from auth.users u, generate_series(1, 2) g
       where u.email in (private.kn_email('KN-SAAAAC'), private.kn_email('KN-SAAAAD'))`);
    await owClick(page, '[data-ow-tab="ai"]', 1500);
    t = await owText(page);
    check("U34. ИИ: массовый сбой → «Автостоп», причина и «не позже …»", t.includes("Автостоп") && t.includes("массовый сбой") && t.includes("не позже"), t.slice(0, 500));
    await page.screenshot({ path: path.join(SHOTS, "owner-ai.png") });
    check("U34. панель не изменила бюджет", sqlv("select max_total_starts || '/' || total_starts from private.ai_limits") === "40/7");

    // 13. история
    await owClick(page, '[data-ow-tab="history"]', 1500);
    t = await owText(page);
    check("U33. история: выдача, продление, отзыв, приглашения, пароль — «из панели»", ["Выдача подписки", "Продление", "Отзыв доступа", "Создано приглашение", "Отозвано приглашение", "Пароль панели установлен"].every((x) => t.includes(x)) && t.includes("из панели"), t.slice(0, 500));
    await page.screenshot({ path: path.join(SHOTS, "owner-history.png") });

    // 14. ошибки сети и повтор
    await page.evaluate(() => (window.__T.rpcOffline = true));
    await owClick(page, '[data-ow-tab="students"]', 1200);
    t = await owText(page);
    check("U38. нет связи: понятная ошибка и «Повторить»", t.includes("Не удалось связаться с сервером") && t.includes("Повторить"), t.slice(0, 200));
    await page.evaluate(() => (window.__T.rpcOffline = false));
    await owClick(page, "[data-ow-retry]", 1500);
    check("U38. «Повторить» после восстановления связи — список загружен", (await page.$$("#owner-root [data-ow-student]")).length > 0);

    // 15. повторное открытие: сессия на месте — пароль не нужен
    await owClick(page, "[data-ow-back]", 400);
    check("U39. панель закрыта крестиком — снова приложение", !(await page.$eval("#owner-root", (n) => !n.hidden)) && (await appText(page)).includes("Панель владельца"));
    await page.click("[data-owner-panel]");
    await until(page, async () => (await owText(page)).includes("всего зарегистрировано"));
    check("U39. повторное открытие в течение сессии — сразу главная, без пароля", (await owText(page)).includes("всего зарегистрировано"));

    // 16. сессия истекла на сервере → экран пароля → после входа возврат в раздел
    await owClick(page, '[data-ow-tab="history"]', 1500);
    sqlv("update private.owner_panel_sessions set expires_at = now() - interval '1 second'");
    await owClick(page, '[data-ow-tab="ai"]', 1500);
    t = await owText(page);
    check("U41. истёкшая сессия: «Сессия панели закончилась — введи пароль»", t.includes("Сессия панели закончилась") && t.includes("Вход в панель"), t.slice(0, 200));
    await page.screenshot({ path: path.join(SHOTS, "owner-unlock.png") });
    await page.fill("#owner-root #owPassword", "AAAAA-BBBBB-CCCCC-DDDDD");
    await owClick(page, 'button[type="submit"]', 1500);
    check("U15. неверный пароль: «Пароль не подходит», поле очищено", (await owText(page)).includes("Пароль не подходит") && (await page.$eval("#owner-root #owPassword", (n) => n.value)) === "");
    await page.fill("#owner-root #owPassword", PW.toLowerCase());
    await owClick(page, 'button[type="submit"]', 2000);
    t = await owText(page);
    check("U41. верный пароль (тот же, постоянный) → возврат в раздел «ИИ»", t.includes("ИИ и бюджет") && t.includes("осталось"), t.slice(0, 200));

    // 17. перебор в интерфейсе
    sqlv("update private.owner_panel_sessions set revoked_at = now()");
    await owClick(page, '[data-ow-tab="home"]', 1500);
    for (let i = 0; i < 5; i++) {
      await page.fill("#owner-root #owPassword", "AAAAA-BBBBB-CCCCC-DDDD" + "EFGHJ"[i]);
      await owClick(page, 'button[type="submit"]', 900);
    }
    t = await owText(page);
    check("U11. 5 неверных паролей → «Слишком много неверных попыток. Попробуй после …»", t.includes("Слишком много неверных попыток"), t.slice(0, 300));
    await page.reload();
    await wait(page, 1500);
    await toProfile(page);
    await page.click("[data-owner-panel]");
    await wait(page, 1800);
    check("U11. перезагрузка страницы паузу не снимает", (await owText(page)).includes("Слишком много неверных попыток"));
    sqlv("update private.owner_panel_secrets set locked_until = null, failed_count = 0, lock_level = 0");
    await page.fill("#owner-root #owPassword", PW);
    await owClick(page, 'button[type="submit"]', 2000);

    // 18. размеры iPhone и компьютер — без горизонтальной прокрутки на всех разделах
    for (const vp of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 430, height: 932 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(vp);
      let ok = true;
      for (const tab of ["home", "students", "subs", "invites", "ai", "history"]) {
        await owClick(page, '[data-ow-tab="' + tab + '"]', 1100);
        if (!(await noHScroll(page))) ok = false;
      }
      const navOk = await page.$eval("#owner-root .ow-nav", (n) => n.getBoundingClientRect().bottom <= innerHeight + 1);
      check("U36. " + vp.width + "×" + vp.height + ": 6 разделов без горизонтальной прокрутки, навигация на экране", ok && navOk);
      await owClick(page, '[data-ow-tab="home"]', 1100);
      await page.screenshot({ path: path.join(SHOTS, "owner-home-" + vp.width + ".png") });
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // 19. выход из аккаунта закрывает сессию панели
    await owClick(page, "[data-ow-back]", 400);
    await page.click("[data-signout]");
    await wait(page, 1500);
    check("U40. выход из аккаунта: сессия панели закрыта на сервере, панель закрыта, кнопки нет", ownerSessionValid() === "0"
      && !(await page.$eval("#owner-root", (n) => !n.hidden)) && !(await appText(page)).includes("Панель владельца"));
    // секреты не уходят ни в консоль браузера, ни в аналитику, ни в адреса запросов
    const tracked = await page.evaluate(() => JSON.stringify(window.__T.tracked || []));
    const said = o.consoleLog.join("\n");
    check("U43. пароль и ключи сессии панели не попадают в консоль браузера и в события аналитики",
      ![PW, PW.replace(/-/g, ""), PW.toLowerCase()].some((v) => said.includes(v) || tracked.includes(v)) && !/[0-9a-f]{64}/.test(said + tracked), { said: said.slice(0, 300) });
    check("U43. все вызовы панели — POST на сервер, аргументы только в теле (адреса без параметров)", rpcLog.length > 20 && rpcLog.every((x) => x.method === "POST" && !x.url.includes("?")),
      rpcLog.filter((x) => x.method !== "POST" || x.url.includes("?")).slice(0, 3));
    check("U40. sessionStorage очищен", !(await page.evaluate(() => JSON.stringify({ ...sessionStorage }).includes("kn-owner-panel"))));
    check("U24. владелец: нет ошибок JS за весь сценарий", !o.errors.length, o.errors);
    check("U24. ни одного запроса к *.supabase.co (только локальный сервер)", !o.blocked.length, o.blocked);
    await o.ctx.close();

    // 20. PWA-кэш: файлы панели попадают в кэш только у владельца
    {
      const s1 = await open({ kind: "participant", id: "KN-SAAAAB", uid: "s-uid", v2: V2.paid, rpcUser: "student" }, undefined, { sw: true });
      await s1.page.reload();
      await wait(s1.page, 2500);
      const keys = await s1.page.evaluate(async () => {
        const out = [];
        for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(k + " " + new URL(r.url).pathname);
        return out;
      });
      check("U42. ученик: сервис-воркер работает (кэш konspekt-v61), файлов панели в кэше нет",
        keys.some((k) => k.startsWith("konspekt-v61 ")) && !keys.some((k) => /owner\.(js|css)/.test(k)), keys.slice(0, 5));
      await s1.ctx.close();
      const s2 = await open(OWNER, undefined, { sw: true });
      await s2.page.reload();
      await wait(s2.page, 2000);
      await toProfile(s2.page);
      await s2.page.click("[data-owner-panel]");
      await wait(s2.page, 2500);
      const keys2 = await s2.page.evaluate(async () => {
        const out = [];
        for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
        return out;
      });
      check("U42. владелец: после открытия панели owner.js и owner.css в кэше текущей версии (обновятся со сменой VERSION)",
        keys2.includes("/js/owner.js") && keys2.includes("/owner.css"), keys2.filter((k) => /owner/.test(k)));
      await s2.ctx.close();
    }
  } catch (e) {
    check("без исключений", false, String(e.stack));
  }
  await browser.close();
  server.close();
  console.log("ИТОГО: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
