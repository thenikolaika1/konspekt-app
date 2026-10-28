/*
 * Konspekt by NK — панель владельца (v61.3).
 * Загружается только у аккаунта со статусом «владелец» (app.js), но это лишь удобство: каждое действие проверяет
 * сервер (public.owner_*: вход Supabase Auth, роль owner, постоянный пароль панели, сессия панели).
 * Пароль не хранится нигде: поле очищается сразу после отправки. В sessionStorage — только ключ сессии панели
 * (живёт до закрытия приложения/вкладки, на сервере — 12 часов, без действий 2 часа).
 * Все данные — ответы сервера; строки из базы экранируются (esc).
 */
(() => {
  const K = window.K;
  const cloud = K.cloud;
  const SKEY = "kn-owner-panel";
  const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const TABS = [
    ["home", "Главная", "home"],
    ["students", "Ученики", "users"],
    ["subs", "Подписки", "card"],
    ["invites", "Коды", "ticket"],
    ["ai", "ИИ", "spark"],
    ["history", "История", "clock"],
  ];
  const st = { open: false, session: null, state: null, stack: [], root: null, flash: null, busy: false, after: null };

  // ---------- мелочи ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (iso, opts) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", ...opts }) : "—");
  const date = (iso) => fmt(iso, { day: "numeric", month: "long", year: "numeric" });
  const dateShort = (iso) => fmt(iso, { day: "numeric", month: "short" });
  const dateTime = (iso) => fmt(iso, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const time = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
  const plural = (n, a, b, c) => {
    const m = Math.abs(n) % 100, d = m % 10;
    return m > 10 && m < 20 ? c : d > 1 && d < 5 ? b : d === 1 ? a : c;
  };
  const days = (n) => n + " " + plural(n, "день", "дня", "дней");
  const gens = (n) => n + " " + plural(n, "генерация", "генерации", "генераций");
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  };
  // пароль панели: 20 символов алфавита ID (≈99 бит), генератор устройства (crypto.getRandomValues), без смещения
  function newPassword() {
    let s = "";
    while (s.length < 20) for (const b of crypto.getRandomValues(new Uint8Array(40))) if (b < 248 && s.length < 20) s += ALPHA[b % 31];
    return s.replace(/(.{5})(?=.)/g, "$1-");
  }
  const ICON = {
    home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.6.7 2.6 2.3 3 4.7"/>',
    card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
    ticket: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2.2"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    share: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2"/>',
    crown: '<path d="M4 8l4 4 4-7 4 7 4-4-1.5 10h-13z"/>',
  };
  const icon = (n) => '<svg class="ow-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[n] || "") + "</svg>";

  const ERR = {
    WRONG_PASSWORD: "Пароль не подходит.",
    NOT_SET: "Пароль панели ещё не установлен.",
    NO_SETUP_CODE: "Код установки не найден или истёк (он действует 30 минут). Получи новый в Supabase.",
    WRONG_CODE: "Код установки не подходит.",
    WEAK_PASSWORD: "Пароль должен состоять из 20 символов генератора (как XXXXX-XXXXX-XXXXX-XXXXX).",
    SAME_AS_KEY: "Пароль панели не должен совпадать с ключом аккаунта.",
    SAME_PASSWORD: "Новый пароль совпадает с текущим.",
    INVALID_ID: "Неверный ID. Пример: KN-ABC234.",
    USER_NOT_FOUND: "Ученик с таким ID не найден.",
    ALREADY_ACTIVE: "У ученика уже есть действующая подписка — используй «Продлить».",
    NO_PAID_YET: "Оплаченного доступа ещё не было — используй «Выдать Premium».",
    NOTHING_TO_REVOKE: "Нет действующих подписок — отзывать нечего.",
    STATE_CHANGED: "Пока был открыт экран подтверждения, подписка ученика изменилась. Проверь данные заново.",
    DAILY_LIMIT: "За сутки создано уже 10 приглашений — это предел. Попробуй завтра.",
    INVITE_NOT_FOUND: "Приглашение не найдено.",
    ALREADY_USED: "Код уже использован — отозвать нельзя.",
    ALREADY_REVOKED: "Код уже отозван.",
    ALREADY_EXPIRED: "Срок кода уже закончился — он и так не работает.",
    IN_PROGRESS: "По этому коду прямо сейчас идёт регистрация. Попробуй через 15 минут.",
    REQUEST_REUSED: "Повтори действие ещё раз.",
    CUSTOM_TERMS_NOT_CONFIRMED: "Условия отличаются от Premium (30 дней, 10 генераций) — подтверди нестандартные условия.",
    BUDGET_LOW: "Бюджета ИИ не хватает на этот срок — сначала увеличь бюджет на экране «ИИ».",
    BUDGET_TOO_LOW: "Бюджет не может быть меньше уже израсходованного и резерва оплаченных генераций.",
    SERVER_ERROR: "Ошибка сервера. Попробуй ещё раз.",
    NETWORK: "Нет подключения к интернету.",
    CONNECTION_LOST: "Не удалось связаться с сервером. Попробуй ещё раз.",
    SERVER_TIMEOUT: "Сервер не ответил вовремя. Попробуй ещё раз.",
  };
  const errText = (r) => {
    if (!r) return ERR.SERVER_ERROR;
    if (r.error === "LOCKED") return "Слишком много неверных попыток. Попробуй после " + (r.locked_until ? dateTime(r.locked_until) : "паузы") + ".";
    if (r.error === "INVALID_INPUT") return r.message || "Проверь введённые данные.";
    if (r.error === "BUDGET_LOW" && r.need !== undefined)
      return "Бюджета ИИ не хватает: на этот срок нужно " + r.need + " " + plural(r.need, "запуск", "запуска", "запусков") + ", свободно " + Math.max(0, r.free) +
        ". Сначала увеличь бюджет на экране «ИИ».";
    if (r.error === "BUDGET_TOO_LOW" && r.min !== undefined) return "Бюджет не может быть меньше " + r.min + ": это израсходованные запуски и резерв оплаченных генераций.";
    return ERR[r.error] || ERR.SERVER_ERROR;
  };
  const STATUS = {
    owner: ["Владелец", "owner"], paid: ["Подписка", "paid"], trial: ["Пробный", "trial"],
    expired: ["Истёк", "expired"], none: ["Без доступа", "none"],
  };
  function badge(a) {
    if (!a) return "";
    let [label, cls] = STATUS[a.status] || ["—", "none"];
    if (a.kind === "legacy") (label = a.status === "expired" ? "F&F · завершено" : "F&F"), (cls = "legacy");
    if (a.revoked && a.status === "expired") label = "Отозван";
    if (a.status === "paid" && a.plan_title) label = a.plan_title;
    return '<span class="ow-badge ow-' + cls + '">' + esc(label) + "</span>";
  }
  const aiLine = (a) => (a.ai_quota === null || a.ai_quota === undefined ? (a.status === "owner" ? "ИИ без лимита" : "") : "ИИ " + (a.ai_remaining ?? 0) + " из " + a.ai_quota);

  // ---------- сессия панели ----------
  const saveSession = (s) => {
    st.session = s.session;
    try {
      sessionStorage.setItem(SKEY, JSON.stringify({ session: s.session, expires_at: s.expires_at }));
    } catch (e) {}
  };
  const forgetSession = () => {
    st.session = null;
    try {
      sessionStorage.removeItem(SKEY);
    } catch (e) {}
  };
  function loadSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SKEY) || "null");
      if (s && s.session && Date.parse(s.expires_at) > Date.now()) return (st.session = s.session);
    } catch (e) {}
    forgetSession();
    return null;
  }

  class Stop extends Error {}
  // вызов функции панели; закрытая сессия → экран пароля, нет прав → панель закрывается
  async function call(fn, args = {}, withSession = true) {
    const res = await cloud.ownerRpc(fn, withSession ? { p_session: st.session, ...args } : args);
    if (res.error === "PANEL_LOCKED") {
      forgetSession();
      st.after = current();
      st.flash = { kind: "info", text: "Сессия панели закончилась — введи пароль ещё раз." };
      reset({ name: "lock" });
      throw new Stop();
    }
    if (res.error === "FORBIDDEN") {
      forgetSession();
      close();
      throw new Stop();
    }
    return res;
  }
  const netError = (e) => ERR[e?.message] || ERR.CONNECTION_LOST;

  // ---------- навигация ----------
  const current = () => st.stack[st.stack.length - 1] || { name: "home" };
  function reset(route) {
    for (const x of st.stack) x.flash = null;
    st.stack = [route];
    render();
  }
  function push(route) {
    st.stack.push(route);
    render();
  }
  // после изменения данные прежних экранов устарели — при возврате загрузятся заново
  function showResult(route) {
    for (const x of st.stack) (x.data = null), (x.error = null), (x.loading = false);
    push(route);
  }
  function back() {
    if (st.stack.length > 1) st.stack.pop();
    else return close();
    render();
  }

  // ---------- оболочка ----------
  function shell(title, body, opts = {}) {
    const r = current();
    const top = st.stack.length > 1;
    const nav = opts.nav !== false
      ? '<nav class="ow-nav" aria-label="Разделы панели">' + TABS.map(([id, label, ic]) =>
          '<button class="ow-tab' + (st.stack[0]?.name === id ? " active" : "") + '" data-ow-tab="' + id + '">' + icon(ic) + "<span>" + label + "</span></button>").join("") + "</nav>"
      : "";
    // сообщение показывается, пока открыт экран, на котором оно появилось (переживает догрузку данных)
    if (st.flash) (r.flash = st.flash), (st.flash = null);
    const flash = r.flash ? '<div class="ow-flash ow-flash-' + esc(r.flash.kind) + '" role="status">' + esc(r.flash.text) + "</div>" : "";
    return (
      '<div class="ow-shell' + (opts.nav === false ? " no-nav" : "") + '" data-view="' + esc(r.name) + '">' +
      '<header class="ow-head">' +
      '<button class="ow-icon-btn" data-ow-back aria-label="' + (top ? "Назад" : "Закрыть панель") + '">' + icon(top ? "back" : "close") + "</button>" +
      '<div class="ow-head-title"><span class="ow-crown">' + icon("crown") + "</span><b>" + esc(title) + "</b></div>" +
      (opts.nav === false ? '<span class="ow-icon-btn ghost"></span>' : '<button class="ow-icon-btn" data-ow-go="settings" aria-label="Настройки панели">' + icon("gear") + "</button>") +
      "</header>" + flash + '<main class="ow-main">' + body + "</main>" + nav + "</div>"
    );
  }
  const loading = (text = "Загружаем…") => '<div class="ow-state" role="status"><span class="ow-spinner"></span><p>' + esc(text) + "</p></div>";
  const errorBox = (text) => '<div class="ow-state ow-state-error" role="alert">' + icon("warn") + "<p>" + esc(text) + '</p><button class="ow-btn ow-secondary" data-ow-retry>Повторить</button></div>';
  const empty = (title, text) => '<div class="ow-state">' + "<b>" + esc(title) + "</b><p>" + esc(text || "") + "</p></div>";
  const stat = (n, label, go, tone) => '<button class="ow-stat' + (tone ? " tone-" + tone : "") + '"' + (go ? ' data-ow-go="' + go + '"' : "") + "><b>" + esc(n ?? "—") + "</b><span>" + esc(label) + "</span></button>";

  // данные экрана: один запрос на экран (r.loading), ответ → render; повтор — data-ow-retry (сбрасывает data/error)
  function need(route, fn) {
    if (route.data || route.error || route.loading) return;
    route.loading = true;
    const req = (route.req = (route.req || 0) + 1); // ответ на устаревший запрос (сменили фильтр/поиск) не применяется
    Promise.resolve()
      .then(fn)
      .then((d) => {
        if (req !== route.req) return;
        if (d.error) route.error = errText(d);
        else route.data = d;
      }, (e) => {
        if (req === route.req && !(e instanceof Stop)) route.error = netError(e);
      })
      .then(() => {
        if (req !== route.req) return;
        route.loading = false;
        if (current() !== route) return;
        // поиск: обновляется только список — поле ввода и клавиатура iPhone остаются на месте
        const list = route.partial && st.root.querySelector("[data-ow-list]");
        route.partial = false;
        if (list) list.innerHTML = studentList(route);
        else render();
      });
  }

  // ---------- экраны ----------
  const VIEWS = {
    lock(r) {
      const s = st.state || {};
      const kn = '<p class="ow-lead">Аккаунт <b class="ow-mono">' + esc(s.kn_id || "") + "</b></p>";
      if (s.locked_until && Date.parse(s.locked_until) > Date.now() && !r.error)
        r.error = "Слишком много неверных попыток. Попробуй после " + dateTime(s.locked_until) + ".";
      const err = r.error ? '<p class="ow-error" role="alert">' + esc(r.error) + "</p>" : '<p class="ow-error" role="alert"></p>';
      if (s.password_set)
        return shell("Панель владельца",
          '<section class="ow-lock">' + '<div class="ow-lock-ico">' + icon("lock") + "</div><h1>Вход в панель</h1>" + kn +
          '<form class="ow-form" data-ow-form="unlock" autocomplete="on">' +
          '<input type="text" name="username" autocomplete="username" value="' + esc((s.kn_id || "") + " · панель") + '" hidden>' +
          '<label class="ow-label" for="owPassword">Пароль панели</label>' +
          '<input id="owPassword" class="ow-field ow-mono" type="password" name="password" autocomplete="current-password" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="40" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required>' +
          err + '<button class="ow-btn ow-primary ow-wide" type="submit">Открыть панель</button></form>' +
          '<p class="ow-note">Пароль постоянный. Сессия панели — до 12 часов (без действий — 2 часа), потом просто введи его снова.</p></section>',
          { nav: false });
      if (s.setup_pending) {
        r.pw = r.pw || newPassword();
        return shell("Панель владельца",
          '<section class="ow-lock"><div class="ow-lock-ico">' + icon("lock") + "</div><h1>Установить пароль</h1>" + kn +
          '<form class="ow-form" data-ow-form="setup" autocomplete="off">' +
          '<label class="ow-label" for="owSetupCode">Одноразовый код из Supabase</label>' +
          '<input id="owSetupCode" class="ow-field ow-mono" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="20" placeholder="XXXX-XXXX-XXXX" required>' +
          '<label class="ow-label">Твой постоянный пароль панели</label>' +
          (r.own
            ? '<input id="owOwnPassword" class="ow-field ow-mono" autocomplete="new-password" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="40" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required>' +
              '<button class="ow-link" type="button" data-ow-act="gen-own">Сгенерировать здесь</button>'
            : '<div class="ow-secret"><code class="ow-mono" data-ow-pw>' + esc(r.pw) + "</code>" +
              '<button class="ow-icon-btn" type="button" data-ow-act="copy-pw" aria-label="Скопировать пароль">' + icon("copy") + "</button></div>" +
              '<div class="ow-row-links"><button class="ow-link" type="button" data-ow-act="regen">Другой пароль</button>' +
              '<button class="ow-link" type="button" data-ow-act="own">У меня пароль из генератора</button></div>') +
          '<p class="ow-warn">' + icon("warn") + "<span>Сохрани пароль прямо сейчас (например, в «Пароли» iPhone). Он показывается один раз и не хранится ни в приложении, ни в базе.</span></p>" +
          '<label class="ow-check"><input type="checkbox" id="owSaved" required> Я сохранил пароль</label>' +
          err + '<button class="ow-btn ow-primary ow-wide" type="submit">Установить пароль</button></form></section>',
          { nav: false });
      }
      return shell("Панель владельца",
        '<section class="ow-lock"><div class="ow-lock-ico">' + icon("lock") + "</div><h1>Пароль ещё не установлен</h1>" + kn +
        '<ol class="ow-steps"><li>Открой Supabase → <b>SQL Editor</b> и выполни:<code class="ow-code">select private.admin_panel_setup(\'' + esc(s.kn_id || "KN-XXXXXX") + "');</code></li>" +
        "<li>Скопируй <b>setup_code</b> из ответа (действует 30 минут).</li><li>Вернись сюда и нажми «Проверить».</li></ol>" +
        '<button class="ow-btn ow-primary ow-wide" data-ow-act="recheck">Проверить</button></section>',
        { nav: false });
    },

    home(r) {
      need(r, () => call("owner_overview"));
      if (r.error) return shell("Главная", errorBox(r.error));
      if (!r.data) return shell("Главная", loading());
      const d = r.data, s = d.students, sub = d.subscriptions, ai = d.ai, inv = d.invites;
      const pct = ai.budget ? Math.min(100, Math.round((ai.used / ai.budget) * 100)) : 100;
      return shell("Главная",
        '<section class="ow-hello"><p>Привет, <b class="ow-mono">' + esc(d.owner_kn) + "</b></p><h1>Konspekt by NK</h1></section>" +
        '<div class="ow-quick"><button class="ow-btn ow-primary" data-ow-go="grant">' + icon("plus") + "Выдать Premium</button>" +
        '<button class="ow-btn ow-secondary" data-ow-go="invite-new">' + icon("ticket") + "Приглашение</button></div>" +
        '<section class="ow-card"><h2>Ученики</h2><div class="ow-big" data-ow-go="students"><b>' + esc(s.total) + "</b><span>всего зарегистрировано</span></div>" +
        '<div class="ow-stats">' + stat(s.paid, "с подпиской", "subs", "blue") + stat(s.trial, "на пробном", "students:trial", "mint") +
        stat(s.expired, "доступ истёк", "students:expired", "wine") + "</div></section>" +
        '<section class="ow-card"><h2>Подписки</h2><div class="ow-stats">' + stat(sub.active, "действуют", "subs", "blue") +
        stat(sub.expiring_7d, "истекают за 7 дней", "subs:expiring", sub.expiring_7d ? "gold" : "") + stat(sub.extensions_30d, "продлений за 30 дней") + "</div></section>" +
        '<section class="ow-card" data-ow-go="ai"><h2>ИИ</h2>' + aiState(ai) +
        '<div class="ow-meter" role="img" aria-label="Использовано ' + esc(ai.used) + " из " + esc(ai.budget) + '"><i style="width:' + pct + '%"></i></div>' +
        '<div class="ow-stats">' + stat(ai.budget, "общий бюджет") + stat(ai.used, "использовано") + stat(ai.remaining, "осталось", null, ai.remaining > 5 ? "mint" : "wine") + "</div>" +
        (ai.reserve ? reserveLine(ai.reserve) : "") + "</section>" +
        '<section class="ow-card"><h2>Приглашения</h2><div class="ow-stats four">' + stat(inv.active, "активные", "invites:active", "mint") + stat(inv.used, "использованы", "invites:used") +
        stat(inv.expired, "истекли", "invites:expired") + stat(inv.revoked, "отозваны", "invites:revoked") + "</div></section>" +
        '<p class="ow-updated">Обновлено ' + esc(time(d.server_now)) + ' · <button class="ow-link" data-ow-retry>обновить</button></p>');
    },

    students(r) {
      r.filter = r.filter || "all";
      fetchStudents(r);
      const chips = [["all", "Все"], ["paid", "Подписка"], ["trial", "Пробный"], ["expiring", "Истекает"], ["expired", "Истёк"], ["legacy", "F&F"]];
      return shell("Ученики",
        '<div class="ow-search">' + icon("search") + '<input id="owSearch" type="search" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Поиск по ID: KN-ABC234 или ABC" value="' + esc(r.q || "") + '" aria-label="Поиск по ID"></div>' +
        '<div class="ow-chips">' + chips.map(([id, l]) => '<button class="ow-chip' + (r.filter === id ? " active" : "") + '" data-ow-filter="' + id + '">' + l + "</button>").join("") + "</div>" +
        '<div data-ow-list>' + studentList(r) + "</div>");
    },

    student(r) {
      need(r, () => call("owner_student", { p_kn_id: r.kn }));
      if (r.error) return shell(r.kn, errorBox(r.error));
      if (!r.data) return shell(r.kn, loading());
      const d = r.data, a = d.access || {};
      const until = a.paid_until || a.ends_at;
      const periods = d.paid_periods || [];
      const hasPaid = (d.grants || []).some((g) => g.kind === "paid");
      return shell(d.kn_id,
        '<section class="ow-card ow-profile"><div class="ow-profile-top"><b class="ow-mono ow-id">' + esc(d.kn_id) + "</b>" + badge(a) + "</div>" +
        '<dl class="ow-dl">' +
        "<dt>Тип доступа</dt><dd>" + esc(kindText(a)) + "</dd>" +
        (a.starts_at ? "<dt>Начало</dt><dd>" + esc(date(a.starts_at)) + "</dd>" : "") +
        "<dt>Окончание</dt><dd>" + esc(until ? date(until) : a.status === "owner" ? "бессрочно" : "—") + "</dd>" +
        (a.ai_quota !== undefined && a.ai_quota !== null ? "<dt>Генерации</dt><dd>использовано " + esc(a.ai_used ?? 0) + ", осталось " + esc(a.ai_remaining ?? 0) + " из " + esc(a.ai_quota) + "</dd>" : "") +
        "<dt>Регистрация</dt><dd>" + esc(date(d.registered_at)) + "</dd>" +
        "<dt>Последняя генерация</dt><dd>" + esc(d.last_generation_at ? dateTime(d.last_generation_at) : "не было") + "</dd>" +
        "</dl></section>" +
        (periods.length ? '<section class="ow-card"><h2>Оплаченные сроки</h2>' + periodList(periods) + "</section>" : "") +
        '<div class="ow-actions">' +
        (periods.length ? "" : '<button class="ow-btn ow-primary" data-ow-act="grant">Выдать Premium</button>') +
        (hasPaid ? '<button class="ow-btn ' + (periods.length ? "ow-primary" : "ow-secondary") + '" data-ow-act="extend">Продлить</button>' : "") +
        (periods.length ? '<button class="ow-btn ow-danger" data-ow-act="revoke">Отозвать доступ</button>' : "") + "</div>" +
        '<section class="ow-card"><h2>История</h2>' + (d.history.length ? '<ul class="ow-events">' + d.history.map((h) => eventItem({ ...h, type: h.action, kn_id: null, by: actorKind(h.actor) })).join("") + "</ul>" : empty("Пока пусто", "")) + "</section>");
    },

    // выдача / продление: форма → предпросмотр сервера → подтверждение → результат
    grant: (r) => subForm(r, "grant"),
    extend: (r) => subForm(r, "extend"),
    confirm(r) {
      const p = r.preview;
      const title = r.action === "grant" ? "Подтверди выдачу" : "Подтверди продление";
      return shell(title,
        '<section class="ow-card ow-summary"><dl class="ow-dl">' +
        "<dt>Ученик</dt><dd class=\"ow-mono\">" + esc(p.kn_id) + "</dd>" +
        "<dt>Операция</dt><dd>" + (r.action === "grant" ? "Выдача Premium" : "Продление Premium") + "</dd>" +
        "<dt>Условия</dt><dd>" + (p.custom ? "<b>Нестандартные</b>" : "Premium") + "</dd>" +
        "<dt>Срок</dt><dd>" + esc(days(p.days)) + "</dd>" +
        "<dt>Генерации ИИ</dt><dd>" + esc(gens(p.ai_quota)) + " на этот срок</dd>" +
        "<dt>Начало</dt><dd>" + esc(p.starts_after_current ? date(p.starts_at) + " (после текущего срока)" : "сразу после подтверждения") + "</dd>" +
        "<dt>Окончание</dt><dd>" + esc(date(p.ends_at)) + "</dd>" +
        (r.note ? "<dt>Комментарий</dt><dd>" + esc(r.note) + "</dd>" : "") + "</dl>" +
        (r.action === "extend" ? '<p class="ow-note">Оплаченные дни текущего срока сохраняются. Неиспользованные генерации текущего срока на новый не переносятся.</p>' : "") +
        (p.custom ? '<p class="ow-warn">' + icon("warn") + "<span>Условия отличаются от Premium (30 дней, 10 генераций). Проверь, что это не опечатка.</span></p>" : "") +
        (p.budget_check && !p.budget_check.ok ? '<p class="ow-error" role="alert">' + esc(errText({ error: "BUDGET_LOW", need: p.budget_check.need, free: p.budget_check.free })) + "</p>" : "") +
        "</section>" + (r.error ? '<p class="ow-error" role="alert">' + esc(r.error) + "</p>" : "") +
        '<div class="ow-actions two"><button class="ow-btn ow-secondary" data-ow-back>Отмена</button>' +
        '<button class="ow-btn ow-primary" data-ow-act="commit"' + (st.busy || (p.budget_check && !p.budget_check.ok) ? " disabled" : "") + ">" +
        (st.busy ? "Выполняем…" : r.action === "grant" ? "Подтвердить выдачу" : "Подтвердить продление") + "</button></div>",
        { nav: false });
    },
    revoke(r) {
      need(r, () => call("owner_preview", { p_kn_id: r.kn, p_action: "revoke" }));
      if (r.error && !r.data) return shell("Отзыв доступа", errorBox(r.error), { nav: false });
      if (!r.data) return shell("Отзыв доступа", loading(), { nav: false });
      const p = r.data, n = p.periods_count;
      const tail = p.kn_id.slice(-3);
      return shell("Отзыв доступа",
        '<section class="ow-card ow-danger-card"><div class="ow-warn-big">' + icon("warn") + "</div>" +
        "<h2>Отозвать подписку <span class=\"ow-mono\">" + esc(p.kn_id) + "</span>?</h2>" +
        "<p>Будут отозваны <b>все " + esc(n) + " " + plural(n, "оплаченный срок", "оплаченных срока", "оплаченных сроков") + "</b> — действующий и будущие:</p>" +
        periodList(p.periods) +
        '<p class="ow-note">Аккаунт и конспекты ученика сохранятся. ИИ и полные тексты библиотеки закроются сразу. Если идёт пробный период — он продолжится до своего конца. Вернуть доступ можно новой выдачей.</p></section>' +
        '<form class="ow-form" data-ow-form="revoke"><label class="ow-label" for="owTail">Для подтверждения введи последние 3 символа ID (<b>' + esc(tail.replace(/./g, "•")) + "</b>)</label>" +
        '<input id="owTail" class="ow-field ow-mono" maxlength="3" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off" required>' +
        '<label class="ow-label" for="owRevNote">Причина (необязательно)</label><input id="owRevNote" class="ow-field" maxlength="200">' +
        (r.error ? '<p class="ow-error" role="alert">' + esc(r.error) + "</p>" : '<p class="ow-error" role="alert"></p>') +
        '<div class="ow-actions two"><button class="ow-btn ow-secondary" type="button" data-ow-back>Отмена</button>' +
        '<button class="ow-btn ow-danger" type="submit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Отзываем…" : "Отозвать доступ") + "</button></div></form>",
        { nav: false });
    },
    result(r) {
      const ok = !r.res.error;
      const a = r.res.access;
      const g = r.res.grant;
      return shell(ok ? "Готово" : "Не выполнено",
        '<section class="ow-result ' + (ok ? "ok" : "bad") + '"><div class="ow-result-ico">' + icon(ok ? "check" : "warn") + "</div>" +
        "<h1>" + esc(ok ? r.okTitle : "Операция не выполнена") + "</h1>" +
        (ok ? "" : '<p class="ow-error">' + esc(errText(r.res)) + "</p>") +
        (ok && r.res.kn_id ? '<dl class="ow-dl"><dt>Ученик</dt><dd class="ow-mono">' + esc(r.res.kn_id) + "</dd>" +
          (g ? "<dt>Срок</dt><dd>" + esc(date(g.starts_at)) + " — " + esc(date(g.ends_at)) + "</dd><dt>Лимит</dt><dd>" + esc(gens(g.ai_quota)) + "</dd>" : "") +
          (r.res.revoked !== undefined ? "<dt>Отозвано сроков</dt><dd>" + esc(r.res.revoked) + "</dd>" : "") +
          (a ? "<dt>Статус сейчас</dt><dd>" + badge(a) + " " + esc(a.paid_until || a.ends_at ? "до " + date(a.paid_until || a.ends_at) : "") + " " + esc(aiLine(a)) + "</dd>" : "") + "</dl>" : "") +
        (r.res.replayed ? '<p class="ow-note">Это повтор уже выполненной операции — второй раз ничего не изменено.</p>' : "") +
        "</section>" +
        '<div class="ow-actions">' + (r.kn ? '<button class="ow-btn ow-primary" data-ow-act="to-student" data-kn="' + esc(r.kn) + '">К ученику</button>' : "") +
        '<button class="ow-btn ow-secondary" data-ow-tab="home">На главную</button></div>',
        { nav: false });
    },

    subs(r) {
      r.filter = r.filter || "paid";
      fetchStudents(r);
      return shell("Подписки",
        '<div class="ow-quick"><button class="ow-btn ow-primary" data-ow-go="grant">' + icon("plus") + "Выдать Premium по ID</button></div>" +
        '<div class="ow-chips">' + [["paid", "Действующие"], ["expiring", "Истекают за 7 дней"], ["expired", "Истёкшие"]]
          .map(([id, l]) => '<button class="ow-chip' + (r.filter === id ? " active" : "") + '" data-ow-filter="' + id + '">' + l + "</button>").join("") + "</div>" +
        '<div data-ow-list>' + studentList(r) + "</div>");
    },

    invites(r) {
      r.filter = r.filter || "all";
      need(r, () => call("owner_invites", { p_filter: r.filter, p_limit: 20, p_offset: 0 }));
      const chips = [["all", "Все"], ["active", "Активные"], ["used", "Использованы"], ["expired", "Истекли"], ["revoked", "Отозваны"]];
      const d = r.data;
      const head =
        '<div class="ow-quick"><button class="ow-btn ow-primary" data-ow-go="invite-new">' + icon("plus") + "Создать приглашение</button></div>" +
        (d ? '<p class="ow-note center">Сегодня создано ' + esc(d.created_today) + " из " + esc(d.daily_limit) + " (предел в сутки)</p>" : "") +
        '<div class="ow-chips">' + chips.map(([id, l]) => '<button class="ow-chip' + (r.filter === id ? " active" : "") + '" data-ow-filter="' + id + '">' + l +
          (d && d.counts[id] !== undefined ? " · " + d.counts[id] : "") + "</button>").join("") + "</div>";
      if (r.error) return shell("Приглашения", head + errorBox(r.error));
      if (!d) return shell("Приглашения", head + loading());
      const IST = { active: ["Активно", "mint"], used: ["Использовано", "blue"], expired: ["Истекло", "none"], revoked: ["Отозвано", "wine"] };
      const items = d.items.map((x) => {
        const [l, c] = IST[x.status] || ["—", "none"];
        return '<li class="ow-item"><div class="ow-item-main"><b class="ow-ellipsis">' + esc(x.label || "Без подписи") + "</b>" +
          '<span class="ow-meta">создан ' + esc(dateShort(x.created_at)) + (x.expires_at ? " · до " + esc(dateShort(x.expires_at)) : " · бессрочно") +
          (x.source === "script" ? " · из скрипта" : "") + (x.redeemed_kn ? ' · <span class="ow-mono">' + esc(x.redeemed_kn) + "</span>" : "") + "</span></div>" +
          '<div class="ow-item-side"><span class="ow-badge ow-' + c + '">' + l + "</span>" +
          (x.status === "active" ? '<button class="ow-link danger" data-ow-act="inv-revoke" data-id="' + esc(x.invite_id) + '" data-label="' + esc(x.label || "") + '">Отозвать</button>' : "") +
          "</div></li>";
      }).join("");
      return shell("Приглашения", head + (d.items.length ? '<ul class="ow-list">' + items + "</ul>" + more(r, d) : empty("Пока нет приглашений", "Создай первое кнопкой выше.")));
    },
    "invite-new"(r) {
      r.days = r.days || 7;
      return shell("Новое приглашение",
        '<form class="ow-form" data-ow-form="invite"><label class="ow-label" for="owInvLabel">Подпись (кому — видишь только ты)</label>' +
        '<input id="owInvLabel" class="ow-field" maxlength="100" placeholder="Например: Ваня, 7Б" value="' + esc(r.label || "") + '">' +
        '<span class="ow-label">Код действует</span><div class="ow-chips">' + [1, 3, 7, 14, 30].map((n) =>
          '<button type="button" class="ow-chip' + (r.days === n ? " active" : "") + '" data-ow-days="' + n + '">' + days(n) + "</button>").join("") + "</div>" +
        '<p class="ow-note">Один код — одна регистрация. После регистрации ученик сразу получит пробный период. Код покажется один раз — сразу отправь его ученику.</p>' +
        (r.error ? '<p class="ow-error" role="alert">' + esc(r.error) + "</p>" : "") +
        '<div class="ow-actions two"><button class="ow-btn ow-secondary" type="button" data-ow-back>Отмена</button>' +
        '<button class="ow-btn ow-primary" type="submit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Создаём…" : "Создать код") + "</button></div></form>",
        { nav: false });
    },
    "invite-created"(r) {
      const d = r.res;
      return shell("Приглашение создано",
        '<section class="ow-result ok"><div class="ow-result-ico">' + icon("ticket") + "</div><h1>Код приглашения</h1>" +
        (d.code
          ? '<div class="ow-code-big ow-mono" data-ow-code>' + esc(d.code) + "</div>" +
            '<div class="ow-actions two"><button class="ow-btn ow-secondary" data-ow-act="copy-code">' + icon("copy") + "Скопировать</button>" +
            '<button class="ow-btn ow-primary" data-ow-act="share-code">' + icon("share") + "Поделиться</button></div>" +
            '<p class="ow-warn">' + icon("warn") + "<span>Код показывается только сейчас — в базе хранится лишь его отпечаток. Если закроешь экран, создай новый код.</span></p>"
          : '<p class="ow-note">Код уже был показан раньше и больше не отображается. Если не успел его сохранить — отзови это приглашение и создай новое.</p>') +
        '<dl class="ow-dl"><dt>Подпись</dt><dd>' + esc(d.label || "без подписи") + "</dd><dt>Действует до</dt><dd>" + esc(dateTime(d.expires_at)) + "</dd></dl></section>" +
        '<div class="ow-actions"><button class="ow-btn ow-secondary" data-ow-tab="invites">К приглашениям</button></div>',
        { nav: false });
    },

    ai(r) {
      need(r, () => call("owner_ai"));
      if (r.error) return shell("ИИ и бюджет", errorBox(r.error));
      if (!r.data) return shell("ИИ и бюджет", loading());
      const d = r.data, b = d.breaker;
      const pct = d.budget ? Math.min(100, Math.round((d.used / d.budget) * 100)) : 100;
      const max = Math.max(1, ...d.days.map((x) => x.starts));
      return shell("ИИ и бюджет",
        '<section class="ow-card ow-ring-card"><div class="ow-ring" style="--p:' + pct + '"><div><b>' + esc(d.remaining) + "</b><span>осталось</span></div></div>" +
        '<div class="ow-stats">' + stat(d.budget, "общий бюджет") + stat(d.used, "использовано") + stat(d.in_flight, "идёт сейчас") + "</div></section>" +
        '<section class="ow-card"><h2>Состояние</h2>' + aiState(d) +
        (b.active ? '<dl class="ow-dl"><dt>Причина</dt><dd>' + (b.reason === "daily"
            ? "за сутки " + esc(b.day_errors) + " " + plural(b.day_errors, "техническая ошибка", "технические ошибки", "технических ошибок") + " (предел " + esc(b.day_limit) + ")"
            : "массовый сбой: " + esc(b.window_errors) + " " + plural(b.window_errors, "ошибка", "ошибки", "ошибок") + " у " + esc(b.window_users) + " " +
              plural(b.window_users, "ученика", "учеников", "учеников") + " за " + esc(b.window_minutes) + " минут") + "</dd>" +
          "<dt>Возобновится</dt><dd>" + (b.until_at_most ? "не позже " + esc(dateTime(b.until_at_most)) + ", если новых сбоев не будет" : "автоматически") + "</dd></dl>" : "") +
        (d.state === "budget_exhausted" ? '<p class="ow-note">Бюджет исчерпан: новые генерации не запускаются ни у кого. Увеличь бюджет кнопкой ниже.</p>' : "") +
        "</section>" + (d.reserve ? reserveCard(d.reserve) : "") +
        '<section class="ow-card"><h2>За сутки</h2><div class="ow-stats four">' + stat(d.starts_24h, "запусков") + stat(d.ok_24h, "успешно", null, "mint") +
        stat(d.tech_errors_24h, "тех. ошибок", null, d.tech_errors_24h ? "wine" : "") + stat(d.user_errors_24h, "нечитаемые фото") + "</div></section>" +
        '<section class="ow-card"><h2>7 дней</h2><div class="ow-bars">' + d.days.map((x) =>
          '<div class="ow-bar" title="' + esc(x.day) + '"><i style="height:' + Math.round((x.starts / max) * 100) + '%"><em style="height:' + (x.starts ? Math.round((x.ok / x.starts) * 100) : 0) + '%"></em></i>' +
          "<span>" + esc(x.starts) + "</span><small>" + esc(new Date(x.day + "T12:00:00Z").toLocaleDateString("ru-RU", { weekday: "short" })) + "</small></div>").join("") + "</div>" +
        '<p class="ow-note">Синим — успешные, светлым — неудачные запуски.</p></section>' +
        '<section class="ow-card"><h2>Защита бюджета</h2><ul class="ow-plain">' +
        "<li>Пауза " + esc(d.limits.tech_pause_minutes) + " минут после " + esc(d.limits.tech_pause_after) + " технических ошибок подряд</li>" +
        "<li>Не больше " + esc(d.limits.max_tech_errors_per_day) + " технических ошибок у ученика за сутки</li>" +
        "<li>Не больше " + esc(d.limits.max_user_errors_per_day) + " попыток с нечитаемыми фото за сутки</li>" +
        "<li>Автостоп: " + esc(b.window_limit) + " ошибки у 2+ учеников за " + esc(b.window_minutes) + " мин или " + esc(b.day_limit) + " за сутки</li></ul>" +
        '<p class="ow-note">Бюджет меняешь только ты — на экране «Изменить бюджет», с подтверждением. Автоматически он не растёт.</p></section>');
    },

    // изменение общего бюджета ИИ: ввод → подтверждение → результат (сервер проверяет минимум и что бюджет не изменился)
    budget(r) {
      need(r, () => call("owner_ai"));
      if (r.error && !r.data) return shell("Изменить бюджет", errorBox(r.error), { nav: false });
      if (!r.data) return shell("Изменить бюджет", loading(), { nav: false });
      const d = r.data, b = d.reserve || {};
      if (r.step === "confirm")
        return shell("Подтверди бюджет",
          '<section class="ow-card ow-summary"><dl class="ow-dl"><dt>Сейчас</dt><dd>' + esc(d.budget) + " " + plural(d.budget, "запуск", "запуска", "запусков") +
          "</dd><dt>Станет</dt><dd><b>" + esc(r.value) + "</b></dd><dt>Израсходовано</dt><dd>" + esc(d.used) + "</dd><dt>Резерв Premium</dt><dd>" + esc(b.premium_reserve) +
          "</dd></dl>" + (r.value > d.budget ? '<p class="ow-note">Больше бюджет — больше возможных запросов к GigaChat. Проверь остаток токенов в кабинете GigaChat.</p>' : "") +
          "</section>" + (r.err || r.error ? '<p class="ow-error" role="alert">' + esc(r.err || r.error) + "</p>" : "") +
          '<div class="ow-actions two"><button class="ow-btn ow-secondary" data-ow-act="budget-edit">Назад</button>' +
          '<button class="ow-btn ow-primary" data-ow-act="budget-commit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Сохраняем…" : "Подтвердить") + "</button></div>",
          { nav: false });
      return shell("Изменить бюджет",
        '<form class="ow-form" data-ow-form="budget"><p class="ow-note">Бюджет — сколько всего запусков ИИ можно сделать (у всех вместе, считая неудачные). ' +
        "Сейчас " + esc(d.budget) + ", израсходовано " + esc(d.used) + ". Меньше " + esc(b.min_budget) + " поставить нельзя: это израсходованное и резерв оплаченных генераций.</p>" +
        '<label class="ow-label" for="owBudget">Новый бюджет</label>' +
        '<input id="owBudget" class="ow-field" type="number" inputmode="numeric" min="' + esc(b.min_budget) + '" max="100000" value="' + esc(r.value ?? d.budget) + '" required>' +
        '<p class="ow-note">Один Premium — это ' + esc(b.per_premium) + " " + plural(b.per_premium, "запуск", "запуска", "запусков") + " резерва (10 генераций × " +
        esc(String(b.factor).replace(".", ",")) + " с запасом на неудачи).</p>" +
        (r.err ? '<p class="ow-error" role="alert">' + esc(r.err) + "</p>" : '<p class="ow-error" role="alert"></p>') +
        '<div class="ow-actions two"><button class="ow-btn ow-secondary" type="button" data-ow-back>Отмена</button>' +
        '<button class="ow-btn ow-primary" type="submit">Продолжить</button></div></form>',
        { nav: false });
    },

    history(r) {
      need(r, () => call("owner_history", { p_limit: 30, p_offset: 0 }));
      if (r.error) return shell("История", errorBox(r.error));
      if (!r.data) return shell("История", loading());
      const d = r.data;
      return shell("История", d.items.length ? '<ul class="ow-events">' + d.items.map(eventItem).join("") + "</ul>" + more(r, d) : empty("Пока пусто", "Здесь появятся выдачи, продления, отзывы и приглашения."));
    },

    settings(r) {
      return shell("Настройки панели",
        '<section class="ow-card"><h2>Пароль панели</h2><p class="ow-note">Пароль постоянный — меняется только когда ты сам решишь.</p>' +
        '<button class="ow-btn ow-secondary ow-wide" data-ow-go="password">Сменить пароль</button></section>' +
        '<section class="ow-card"><h2>Сессии</h2><p class="ow-note">Сессия панели: до 12 часов, без действий — 2 часа. Выход из аккаунта закрывает её.</p>' +
        '<button class="ow-btn ow-secondary ow-wide" data-ow-act="lock">Выйти из панели на этом устройстве</button>' +
        '<button class="ow-btn ow-danger ow-wide" data-ow-act="lock-all">Выйти из панели на всех устройствах</button></section>' +
        '<section class="ow-card"><h2>Забыл пароль?</h2><p class="ow-note">В Supabase → SQL Editor: <code class="ow-code">select private.admin_panel_setup(\'' + esc(st.state?.kn_id || "KN-XXXXXX") +
        "');</code> — старый пароль и все сессии перестанут действовать, а новый ты установишь здесь по одноразовому коду.</p></section>");
    },
    password(r) {
      r.pw = r.pw || newPassword();
      return shell("Смена пароля",
        '<form class="ow-form" data-ow-form="password" autocomplete="off"><label class="ow-label" for="owCurPw">Текущий пароль</label>' +
        '<input id="owCurPw" class="ow-field ow-mono" type="password" autocomplete="current-password" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="40" required>' +
        '<label class="ow-label">Новый пароль</label><div class="ow-secret"><code class="ow-mono" data-ow-pw>' + esc(r.pw) + "</code>" +
        '<button class="ow-icon-btn" type="button" data-ow-act="copy-pw" aria-label="Скопировать пароль">' + icon("copy") + "</button></div>" +
        '<button class="ow-link" type="button" data-ow-act="regen">Другой пароль</button>' +
        '<p class="ow-warn">' + icon("warn") + "<span>Сохрани новый пароль. После смены все сессии панели закроются (на этом устройстве откроется новая).</span></p>" +
        '<label class="ow-check"><input type="checkbox" id="owSaved" required> Я сохранил новый пароль</label>' +
        (r.error ? '<p class="ow-error" role="alert">' + esc(r.error) + "</p>" : '<p class="ow-error" role="alert"></p>') +
        '<div class="ow-actions two"><button class="ow-btn ow-secondary" type="button" data-ow-back>Отмена</button>' +
        '<button class="ow-btn ow-primary" type="submit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Меняем…" : "Сменить пароль") + "</button></div></form>",
        { nav: false });
    },
  };

  // ---------- части экранов ----------
  function aiState(ai) {
    const map = {
      ok: ["Работает", "mint", "Генерации запускаются как обычно."],
      breaker: ["Автостоп", "gold", "Массовый сбой ИИ: генерации временно на паузе у всех, возобновятся сами."],
      budget_exhausted: ["Бюджет исчерпан", "wine", "Новые генерации не запускаются ни у кого."],
      disabled: ["Выключен", "none", "ИИ выключен в настройках (ai_limits.ai_enabled)."],
    };
    const [l, c, t] = map[ai.state] || ["—", "none", ""];
    return '<div class="ow-ai-state"><span class="ow-badge ow-' + c + '">' + l + "</span><p>" + esc(t) + "</p></div>";
  }
  // резерв бюджета под оплаченные генерации (private.budget_state)
  const RESERVE = {
    ok: ["Хватает", "mint"], low: ["Бюджет заканчивается", "gold"], reserved_only: ["Только для Premium", "wine"], exhausted: ["Бюджет исчерпан", "wine"],
  };
  function reserveLine(b) {
    const [l, c] = RESERVE[b.state] || ["—", "none"];
    return '<p class="ow-note"><span class="ow-badge ow-' + c + '">' + esc(l) + "</span> резерв Premium " + esc(b.premium_reserve) + ", свободно " + esc(Math.max(0, b.free)) + "</p>";
  }
  function reserveCard(b) {
    const [l, c] = RESERVE[b.state] || ["—", "none"];
    const warn = {
      low: "Свободный бюджет меньше " + b.warn_percent + "% — скоро новые подписки и пробные генерации не поместятся. Увеличь бюджет.",
      reserved_only: "Свободного бюджета нет: генерации идут только у учеников с Premium (их резерв защищён). Пробный период и твои запуски сверх резерва — на паузе.",
      exhausted: "Бюджет исчерпан полностью.",
    }[b.state];
    return '<section class="ow-card"><h2>Бюджет и резерв Premium</h2><div class="ow-ai-state"><span class="ow-badge ow-' + c + '">' + esc(l) + "</span>" +
      (warn ? "<p>" + esc(warn) + "</p>" : "<p>Оплаченные генерации учеников защищены резервом.</p>") + "</div>" +
      '<div class="ow-stats four">' + stat(b.remaining, "осталось") + stat(b.premium_reserve, "резерв Premium", null, "blue") +
      stat(b.owner_reserve_left, "твой резерв") + stat(Math.max(0, b.free), "свободно", null, b.free > 0 ? "mint" : "wine") + "</div>" +
      '<dl class="ow-dl"><dt>Обязательства</dt><dd>' + esc(b.obligations) + " " + plural(b.obligations, "генерация", "генерации", "генераций") + " у учеников с Premium</dd>" +
      "<dt>Запас</dt><dd>× " + esc(String(b.factor).replace(".", ",")) + " на неудачи и повторы (оценка, не гарантия)</dd>" +
      "<dt>Можно продать</dt><dd>ещё " + esc(b.can_sell) + " " + plural(b.can_sell, "Premium", "Premium", "Premium") + " без увеличения бюджета</dd></dl>" +
      '<button class="ow-btn ow-secondary ow-wide" data-ow-go="budget">Изменить бюджет</button></section>';
  }
  function kindText(a) {
    if (a.kind === "legacy") return "Участник F&F (тестирование v59)";
    if (a.status === "paid" && a.plan_title) return a.plan_title;
    return { owner: "Владелец", paid: "Оплаченная подписка", trial: "Пробный период", expired: "Доступ закончился", none: "Без доступа" }[a.status] || "—";
  }
  const periodList = (ps) => '<ul class="ow-periods">' + ps.map((p) => "<li><b>" + esc(date(p.starts_at)) + " — " + esc(date(p.ends_at)) + "</b><span>ИИ: " + esc(p.ai_used ?? 0) + " из " + esc(p.ai_quota) + "</span></li>").join("") + "</ul>";
  const more = (r, d) => (d.items.length < d.total ? '<button class="ow-btn ow-secondary ow-wide" data-ow-act="more">Показать ещё (' + esc(d.total - d.items.length) + ")</button>" : "");
  function studentList(r) {
    if (r.error) return errorBox(r.error);
    if (!r.data) return loading();
    const d = r.data;
    if (!d.items.length) return empty(r.q ? "Ничего не найдено" : "Пока никого", r.q ? "Проверь ID — поиск по символам после «KN-»." : "");
    return '<p class="ow-note">' + esc(d.total) + " " + plural(d.total, "ученик", "ученика", "учеников") + "</p>" +
      '<ul class="ow-list">' + d.items.map((x) =>
        '<li><button class="ow-item" data-ow-student="' + esc(x.kn_id) + '"><div class="ow-item-main"><b class="ow-mono">' + esc(x.kn_id) + "</b>" +
        '<span class="ow-meta">' + esc([x.ends_at ? "до " + dateShort(x.ends_at) : x.status === "owner" ? "бессрочно" : "", aiLine(x), "рег. " + dateShort(x.registered_at)].filter(Boolean).join(" · ")) + "</span></div>" +
        '<div class="ow-item-side">' + badge(x) + icon("chev") + "</div></button></li>").join("") + "</ul>" + more(r, d);
  }
  function fetchStudents(r, append) {
    const off = append && r.data ? r.data.items.length : 0;
    const req = () => call("owner_students", { p_query: r.q || null, p_filter: r.filter, p_limit: 20, p_offset: off });
    if (!append) return need(r, req);
    req().then((d) => {
      if (!d.error) (r.data.items = r.data.items.concat(d.items)), (r.data.total = d.total);
      render();
    }, (e) => e instanceof Stop || ((r.error = netError(e)), render()));
  }
  // кто действовал: панель, SQL Editor владельца или сама система (регистрация, триггеры)
  const actorKind = (a) => (!a ? null : a.startsWith("panel:") ? "panel" : a === "postgres" || a === "supabase_admin" ? "sql_editor" : "system");
  const EV = {
    grant: ["Выдача подписки", "card"], extend: ["Продление", "card"], revoke: ["Отзыв доступа", "warn"], set_owner: ["Назначен владелец", "crown"],
    trial: ["Пробный период", "spark"], grant_trial: ["Пробный период выдан вручную", "spark"], trial_on_register: ["Регистрация: пробный период", "spark"], invite_create: ["Создано приглашение", "ticket"], invite_revoke: ["Отозвано приглашение", "ticket"],
    panel_refused: ["Отказ операции", "warn"], setup_code_issued: ["Код установки пароля", "lock"], password_set: ["Пароль панели установлен", "lock"],
    password_changed: ["Пароль панели изменён", "lock"], password_reset: ["Пароль панели сброшен", "lock"], unlock_failed: ["Неверный пароль панели", "warn"],
    locked: ["Пауза после неверных паролей", "warn"], sessions_revoked: ["Закрыты сессии панели", "lock"],
    budget: ["Изменён бюджет ИИ", "card"],
  };
  function eventText(e) {
    const x = e.details || {};
    switch (e.type) {
      case "grant":
      case "extend":
        return [x.days ? days(x.days) : "", x.ai_quota !== undefined && x.ai_quota !== null ? gens(x.ai_quota) : "", x.starts_at ? "с " + date(x.starts_at) : "", x.note || ""].filter(Boolean).join(" · ");
      case "revoke":
        return [x.kind === "owner" ? "роль владельца" : x.kind === "trial" ? "пробный период" : "подписка", "сроков: " + (x.revoked ?? 0), x.note || ""].filter(Boolean).join(" · ");
      case "invite_create":
        return [x.label || "без подписи", x.expires_at ? "до " + dateShort(x.expires_at) : ""].filter(Boolean).join(" · ");
      case "invite_revoke":
        return x.label || "без подписи";
      case "panel_refused":
        return ({ grant: "выдача", extend: "продление", revoke: "отзыв", invite_create: "приглашение", invite_revoke: "отзыв кода", budget: "бюджет" }[x.op] || x.op || "") + ": " + (ERR[x.error] || x.error || "");
      case "budget":
        return (x.from ?? "?") + " → " + (x.to ?? "?") + " запусков";
      case "locked":
        return x.until ? "до " + dateTime(x.until) : "";
      case "unlock_failed":
        return x.what === "setup_code" ? "код установки" : "";
      default:
        return x.note || "";
    }
  }
  function eventItem(e) {
    const [title, ic] = EV[e.type] || [e.type, "clock"];
    const bad = ["panel_refused", "unlock_failed", "locked"].includes(e.type);
    return '<li class="ow-event' + (bad ? " bad" : "") + '"><span class="ow-event-ico">' + icon(ic) + '</span><div><b>' + esc(title) + "</b>" +
      (e.kn_id ? ' <span class="ow-mono">' + esc(e.kn_id) + "</span>" : "") + '<span class="ow-meta">' + esc(dateTime(e.at)) +
      (e.by === "panel" ? " · из панели" : e.by === "sql_editor" ? " · SQL Editor" : e.by === "system" ? " · автоматически" : "") + "</span>" +
      (eventText(e) ? "<p>" + esc(eventText(e)) + "</p>" : "") + "</div></li>";
  }
  // Premium (30 дней, 10 генераций) — по умолчанию; другие условия — только после явного выбора «Нестандартные условия»
  const PREMIUM = { days: 30, quota: 10 };
  function subForm(r, action) {
    r.custom = !!r.custom;
    if (!r.custom) (r.days = PREMIUM.days), (r.quota = PREMIUM.quota);
    r.days = r.days || PREMIUM.days;
    r.quota = r.quota ?? PREMIUM.quota;
    const customDays = ![7, 30, 90].includes(r.days);
    return shell(action === "grant" ? "Выдать Premium" : "Продлить Premium",
      '<form class="ow-form" data-ow-form="sub">' +
      '<label class="ow-label" for="owKn">ID ученика</label>' +
      '<input id="owKn" class="ow-field ow-mono" value="' + esc(r.kn || "") + '" placeholder="KN-ABC234" maxlength="12" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off" required' + (r.lockKn ? " readonly" : "") + ">" +
      '<span class="ow-label">Условия</span><div class="ow-chips">' +
      '<button type="button" class="ow-chip' + (r.custom ? "" : " active") + '" data-ow-terms="premium">Premium · 30 дней · 10 генераций</button>' +
      '<button type="button" class="ow-chip' + (r.custom ? " active" : "") + '" data-ow-terms="custom">Нестандартные</button></div>' +
      (r.custom
        ? '<p class="ow-warn">' + icon("warn") + "<span>Нестандартные условия — только по особой договорённости. Обычная оплата 299 ₽ — это Premium: 30 дней и 10 генераций.</span></p>" +
          '<span class="ow-label">Срок</span><div class="ow-chips">' + [7, 30, 90].map((n) =>
            '<button type="button" class="ow-chip' + (r.days === n && !r.customDays ? " active" : "") + '" data-ow-days="' + n + '">' + days(n) + "</button>").join("") +
          '<button type="button" class="ow-chip' + (customDays || r.customDays ? " active" : "") + '" data-ow-days="custom">Свой</button></div>' +
          (customDays || r.customDays ? '<input id="owDays" class="ow-field" type="number" inputmode="numeric" min="1" max="400" value="' + esc(r.days) + '" aria-label="Число дней (1–400)">' : "") +
          '<label class="ow-label" for="owQuota">Генерации ИИ на этот срок</label>' +
          '<input id="owQuota" class="ow-field" type="number" inputmode="numeric" min="0" max="1000" value="' + esc(r.quota) + '" required>'
        : '<p class="ow-note">Premium: 299 ₽, 30 календарных дней, 10 успешных генераций ИИ, история и физика целиком.</p>') +
      '<label class="ow-label" for="owNote">Комментарий (видишь только ты)</label>' +
      '<input id="owNote" class="ow-field" maxlength="200" placeholder="Например: оплата 28.10, 299 ₽" value="' + esc(r.note || "") + '">' +
      (r.error ? '<p class="ow-error" role="alert">' + esc(r.error) + "</p>" : '<p class="ow-error" role="alert"></p>') +
      '<div class="ow-actions two"><button class="ow-btn ow-secondary" type="button" data-ow-back>Отмена</button>' +
      '<button class="ow-btn ow-primary" type="submit"' + (st.busy ? " disabled" : "") + ">" + (st.busy ? "Проверяем…" : "Продолжить") + "</button></div></form>" +
      '<p class="ow-note">Даты начала и окончания посчитает сервер — ты увидишь их перед подтверждением.</p>',
      { nav: false });
  }

  // ---------- отрисовка ----------
  function render() {
    if (!st.open || !st.root) return;
    const r = current();
    const view = VIEWS[r.name] || VIEWS.home;
    const y = st.root.querySelector(".ow-main")?.scrollTop || 0;
    const sameView = st.root.firstElementChild?.dataset.view === r.name;
    st.root.innerHTML = view(r);
    const main = st.root.querySelector(".ow-main");
    if (main && sameView) main.scrollTop = y;
  }

  // ---------- действия ----------
  async function busy(fn) {
    if (st.busy) return;
    st.busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Stop)) (current().error = netError(e));
    } finally {
      st.busy = false;
      render();
    }
  }
  const val = (id) => st.root.querySelector("#" + id)?.value ?? "";

  async function onSubmit(e) {
    const form = e.target.closest("[data-ow-form]");
    if (!form) return;
    e.preventDefault();
    const r = current();
    const kind = form.dataset.owForm;
    if (kind === "unlock") {
      const input = st.root.querySelector("#owPassword");
      const pw = input.value;
      input.value = ""; // пароль не остаётся в поле и в памяти страницы
      if (!pw.trim()) return;
      return busy(async () => {
        const res = await cloud.ownerRpc("owner_unlock", { p_password: pw });
        if (res.result === "ok") return opened(res);
        if (res.error === "FORBIDDEN") return close();
        if (res.error === "NOT_SET") return refreshState();
        if (res.error === "LOCKED") st.state.locked_until = res.locked_until;
        r.error = errText(res);
      });
    }
    if (kind === "setup") {
      if (!st.root.querySelector("#owSaved")?.checked) return (r.error = "Сначала сохрани пароль и отметь это."), render();
      const code = val("owSetupCode");
      const pw = r.own ? val("owOwnPassword") : r.pw;
      return busy(async () => {
        const res = await cloud.ownerRpc("owner_panel_setup", { p_setup_code: code, p_new_password: pw });
        if (res.result === "ok") {
          r.pw = null;
          st.flash = { kind: "ok", text: "Пароль установлен. Панель открыта." };
          return opened(res);
        }
        if (res.error === "FORBIDDEN") return close();
        r.error = errText(res);
      });
    }
    if (kind === "password") {
      if (!st.root.querySelector("#owSaved")?.checked) return (r.error = "Сначала сохрани новый пароль и отметь это."), render();
      const cur = val("owCurPw");
      return busy(async () => {
        const res = await call("owner_change_password", { p_current_password: cur, p_new_password: r.pw });
        if (res.result === "ok") {
          saveSession(res);
          st.flash = { kind: "ok", text: "Пароль изменён. Остальные сессии панели закрыты." };
          return reset({ name: "home" });
        }
        r.error = errText(res);
      });
    }
    if (kind === "sub") {
      r.kn = val("owKn").trim();
      if (r.custom) {
        if (st.root.querySelector("#owDays")) r.days = parseInt(val("owDays"), 10);
        r.quota = parseInt(val("owQuota"), 10);
      } else (r.days = PREMIUM.days), (r.quota = PREMIUM.quota);
      r.note = val("owNote").trim();
      if (!Number.isInteger(r.days) || r.days < 1 || r.days > 400) return (r.error = "Срок: от 1 до 400 дней."), render();
      if (!Number.isInteger(r.quota) || r.quota < 0 || r.quota > 1000) return (r.error = "Генерации: целое число от 0 до 1000."), render();
      r.error = null;
      return busy(async () => {
        const res = await call("owner_preview", { p_kn_id: r.kn, p_action: r.name, p_days: r.days, p_ai_quota: r.quota });
        if (res.error) return (r.error = errText(res));
        push({ name: "confirm", action: r.name, preview: res, note: r.note, requestId: uuid() });
      });
    }
    if (kind === "revoke") {
      const p = r.data;
      if (val("owTail").trim().toUpperCase() !== p.kn_id.slice(-3)) return (r.error = "Символы не совпадают с концом ID."), render();
      r.error = null;
      r.requestId = r.requestId || uuid();
      const note = val("owRevNote").trim();
      return busy(async () => {
        const res = await call("owner_revoke", { p_request_id: r.requestId, p_kn_id: p.kn_id, p_note: note || null, p_expect_periods: p.periods_count });
        if (res.error === "STATE_CHANGED") return (r.error = errText(res)), (r.data = null), (r.requestId = null);
        st.stack.pop();
        showResult({ name: "result", res, okTitle: "Доступ отозван", kn: p.kn_id });
      });
    }
    if (kind === "budget") {
      const v = parseInt(val("owBudget"), 10);
      const b = r.data?.reserve || {};
      if (!Number.isInteger(v) || v < 0 || v > 100000) return (r.err = "Бюджет: целое число от 0 до 100 000."), render();
      if (b.min_budget !== undefined && v < b.min_budget) return (r.err = errText({ error: "BUDGET_TOO_LOW", min: b.min_budget })), render();
      if (v === r.data.budget) return (r.err = "Это и есть текущий бюджет."), render();
      r.value = v;
      r.err = null;
      r.step = "confirm";
      r.requestId = uuid();
      return render();
    }
    if (kind === "invite") {
      r.label = val("owInvLabel").trim();
      r.requestId = r.requestId || uuid();
      return busy(async () => {
        const res = await call("owner_invite_create", { p_request_id: r.requestId, p_label: r.label || null, p_valid_days: r.days });
        if (res.error) {
          r.error = errText(res);
          r.requestId = null;
          return;
        }
        st.stack.pop();
        showResult({ name: "invite-created", res });
      });
    }
  }

  async function onClick(e) {
    const t = e.target;
    const el = (s) => t.closest(s);
    let x;
    if (el("[data-ow-back]")) return back();
    if ((x = el("[data-ow-tab]"))) return reset({ name: x.dataset.owTab });
    if ((x = el("[data-ow-go]"))) {
      const [name, filter] = x.dataset.owGo.split(":");
      if (["home", "students", "subs", "invites", "ai", "history"].includes(name)) return reset({ name, filter });
      return push({ name, filter });
    }
    if ((x = el("[data-ow-student]"))) return push({ name: "student", kn: x.dataset.owStudent });
    if (el("[data-ow-retry]")) {
      const r = current();
      r.data = null;
      r.error = null;
      r.loading = false;
      return render();
    }
    if ((x = el("[data-ow-filter]"))) {
      const r = current();
      r.filter = x.dataset.owFilter;
      r.data = null;
      r.error = null;
      r.loading = false;
      return render();
    }
    if ((x = el("[data-ow-terms]"))) {
      const r = current();
      (r.kn = val("owKn") || r.kn), (r.note = val("owNote"));
      r.custom = x.dataset.owTerms === "custom";
      if (!r.custom) (r.days = PREMIUM.days), (r.quota = PREMIUM.quota), (r.customDays = false);
      return render();
    }
    if ((x = el("[data-ow-days]"))) {
      const r = current();
      // форма подписки: «Свой» — поле с числом дней; приглашение: те же кнопки срока кода
      if (r.name === "invite-new") {
        if (x.dataset.owDays === "custom") r.custom = true;
        else (r.days = Number(x.dataset.owDays)), (r.custom = false);
      } else if (x.dataset.owDays === "custom") r.customDays = true;
      else (r.days = Number(x.dataset.owDays)), (r.customDays = false);
      if (r.name !== "invite-new") (r.kn = val("owKn") || r.kn), (r.quota = parseInt(val("owQuota"), 10)), (r.note = val("owNote"));
      else r.label = val("owInvLabel");
      return render();
    }
    if (!(x = el("[data-ow-act]"))) return;
    const r = current();
    switch (x.dataset.owAct) {
      case "recheck":
        return refreshState();
      case "regen":
        r.pw = newPassword();
        return render();
      case "own":
        r.own = true;
        return render();
      case "gen-own":
        r.own = false;
        return render();
      case "copy-pw":
        return copy(r.pw, x);
      case "copy-code":
        return copy(r.res.code, x);
      case "share-code":
        if (navigator.share)
          return navigator.share({ title: "Konspekt by NK", text: "Код приглашения в Konspekt by NK: " + r.res.code }).catch(() => {});
        return copy(r.res.code, x);
      case "grant":
        return push({ name: "grant", kn: r.data.kn_id, lockKn: true });
      case "extend":
        return push({ name: "extend", kn: r.data.kn_id, lockKn: true });
      case "revoke":
        return push({ name: "revoke", kn: r.data.kn_id });
      case "to-student":
        st.stack = [{ name: "students" }];
        return push({ name: "student", kn: x.dataset.kn });
      case "budget-edit":
        r.step = null;
        r.err = null;
        return render();
      case "budget-commit":
        r.error = null;
        return busy(async () => {
          const res = await call("owner_set_budget", { p_request_id: r.requestId, p_new_budget: r.value, p_expect_budget: r.data.budget });
          if (res.error) {
            r.err = errText(res);
            if (res.error === "STATE_CHANGED") (r.data = null), (r.loading = false), (r.step = null);
            return;
          }
          st.flash = { kind: "ok", text: "Бюджет ИИ: " + res.budget + " " + plural(res.budget, "запуск", "запуска", "запусков") + "." };
          st.stack.pop();
          const top = current();
          if (top) (top.data = res.ai || null), (top.loading = false);
        });
      case "commit":
        return busy(async () => {
          const p = r.preview;
          const fn = r.action === "grant" ? "owner_grant" : "owner_extend";
          const args = { p_request_id: r.requestId, p_kn_id: p.kn_id, p_days: p.days, p_ai_quota: p.ai_quota, p_note: r.note || null, p_custom: !!p.custom };
          if (r.action === "extend") args.p_expect_starts_at = p.starts_after_current ? p.starts_at : null;
          const res = await call(fn, args);
          if (res.error === "STATE_CHANGED" || res.error === "BUDGET_LOW") return (r.error = errText(res));
          st.stack.pop();
          st.stack.pop();
          showResult({ name: "result", res, okTitle: r.action === "grant" ? "Premium выдан" : "Premium продлён", kn: p.kn_id });
        });
      case "more":
        if (r.name === "students" || r.name === "subs") return fetchStudents(r, true);
        return call(r.name === "invites" ? "owner_invites" : "owner_history",
          r.name === "invites" ? { p_filter: r.filter, p_limit: 20, p_offset: r.data.items.length } : { p_limit: 30, p_offset: r.data.items.length })
          .then((d) => {
            if (!d.error) (r.data.items = r.data.items.concat(d.items)), (r.data.total = d.total);
            render();
          }, (err) => err instanceof Stop || ((r.error = netError(err)), render()));
      case "inv-revoke": {
        const label = x.dataset.label || "без подписи";
        if (!confirm("Отозвать приглашение «" + label + "»? Регистрация по этому коду станет невозможна.")) return;
        return busy(async () => {
          const res = await call("owner_invite_revoke", { p_request_id: uuid(), p_invite_id: x.dataset.id });
          st.flash = res.error ? { kind: "bad", text: errText(res) } : { kind: "ok", text: "Приглашение отозвано." };
          r.data = null;
          r.loading = false;
        });
      }
      case "lock":
        await lockHere();
        return close();
      case "lock-all":
        if (!confirm("Закрыть панель на всех устройствах? Понадобится снова ввести пароль.")) return;
        return busy(async () => {
          const res = await call("owner_lock_all");
          forgetSession();
          st.flash = { kind: res.error ? "bad" : "ok", text: res.error ? errText(res) : "Все сессии панели закрыты." };
          reset({ name: "lock" });
        });
    }
  }
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add("done");
      setTimeout(() => btn.classList.remove("done"), 1500);
    } catch (e) {
      const code = st.root.querySelector("[data-ow-code],[data-ow-pw]");
      if (code) window.getSelection().selectAllChildren(code);
    }
  }

  let searchTimer = null;
  function onInput(e) {
    if (e.target.id !== "owSearch") return;
    const r = current();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      r.q = e.target.value.trim();
      r.data = null;
      r.error = null;
      r.loading = false;
      r.partial = true;
      // перерисовываем только список — поле поиска сохраняет фокус и курсор на iPhone
      fetchStudents(r);
      const list = st.root.querySelector("[data-ow-list]");
      if (list) list.innerHTML = studentList(r);
    }, 300);
  }

  // ---------- открытие / закрытие ----------
  async function opened(res) {
    saveSession(res);
    st.state = { ...st.state, password_set: true, setup_pending: false, locked_until: null };
    const next = st.after && st.after.name !== "lock" ? st.after : { name: "home" };
    st.after = null;
    next.data = null;
    next.error = null;
    reset(next);
  }
  async function refreshState() {
    try {
      st.state = await cloud.ownerRpc("owner_panel_state", {});
    } catch (e) {
      st.state = st.state || {};
      return reset({ name: "lock", error: netError(e) });
    }
    if (!st.state.owner) return close();
    reset({ name: "lock" });
  }

  async function open() {
    if (!st.root) {
      st.root = document.createElement("div");
      st.root.id = "owner-root";
      st.root.className = "ow";
      st.root.setAttribute("role", "dialog");
      st.root.setAttribute("aria-label", "Панель владельца");
      st.root.addEventListener("click", onClick);
      st.root.addEventListener("submit", onSubmit);
      st.root.addEventListener("input", onInput);
      document.body.appendChild(st.root);
    }
    st.open = true;
    st.root.hidden = false;
    document.documentElement.classList.add("ow-open");
    st.root.innerHTML = '<div class="ow-shell no-nav">' + loading("Открываем панель…") + "</div>";
    try {
      st.state = await cloud.ownerRpc("owner_panel_state", {});
    } catch (e) {
      st.state = {};
      st.stack = [{ name: "lock", error: netError(e) }];
      st.root.innerHTML = '<div class="ow-shell no-nav">' + errorBox(netError(e)) + '<button class="ow-btn ow-secondary ow-wide" data-ow-back>Закрыть</button></div>';
      return;
    }
    if (!st.state.owner) return close();
    loadSession();
    reset(st.session ? { name: "home" } : { name: "lock" });
  }
  function close() {
    st.open = false;
    st.stack = [];
    if (st.root) {
      st.root.hidden = true;
      st.root.innerHTML = "";
    }
    document.documentElement.classList.remove("ow-open");
  }
  async function lockHere() {
    const s = st.session;
    forgetSession();
    if (s) await cloud.ownerRpc("owner_lock", { p_session: s }).catch(() => {});
  }
  // выход из обычного аккаунта: сначала закрываем сессию панели (на сервере она и так перестанет действовать)
  async function beforeSignOut() {
    await lockHere();
    close();
  }

  K.owner = { open, close, beforeSignOut, isOpen: () => st.open };
})();
