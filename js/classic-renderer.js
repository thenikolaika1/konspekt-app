/*
 * Classic renderer: StudyContent → HTML плотного учебного конспекта.
 * Обычный текст идёт прямо по «листу»; карточки — только для особых блоков
 * (ВАЖНО, ВЫВОД, ЗАПОМНИ, ПРИМЕР, ФОРМУЛА). Цвета берутся из темы предмета (CSS .nt-<subject>).
 * Весь текст экранируется; разметку добавляет только renderer. Пустые разделы не выводятся.
 *
 * meta.format = "classic-2" (новые AI-конспекты, эталон — PWA «Физика 8» / «История 8»):
 * разделы — пункты учебника с номером (номер из учебника или по порядку); подписи к рисункам («Рис. 24. …»)
 * не считаются разделами и выводятся скромной подписью без номера; «Главное» — небольшая карточка в начале;
 * смысловые карточки разных типов (определение, важно, состав/функции, причина → следствие, процесс, пример,
 * формула) — каждая со своим смысловым цветом (CSS .k-*). В конце: Термины, Личности, Даты, Формулы —
 * сворачиваемые; «Важно» и «Вывод» — открытые карточки; «Вопросы и ответы» — открытый раздел, каждый вопрос
 * раскрывается отдельно. Старые конспекты (без format) выглядят как раньше.
 *
 * K.modes — реестр режимов представления. Новый режим (sticky, handwritten, quiz…)
 * добавляется сюда и получает тот же StudyContent — без повторного анализа фото.
 */
(() => {
  const K = (window.K = window.K || {});
  const esc = K.esc;
  const INLINE = { d: "kw-date", t: "kw-term", p: "kw-person", f: "formula-inline" };

  // Типографика: однобуквенные предлоги и союзы не остаются в конце строки («с европейскими», «и шведской»).
  const ONE_LETTER = /(^|[\s(«„])([А-Яа-яЁё]) (?=\S)/g;
  const nbsp = (s) => String(s ?? "").replace(ONE_LETTER, "$1$2 ").replace(ONE_LETTER, "$1$2 ");

  function inline(s) {
    const h = esc(nbsp(s))
      .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(d|t|p|f):([^\]\n]+?)\]/g, (_, k, v) => '<span class="' + INLINE[k] + '">' + v + "</span>");
    // готовые конспекты библиотеки: обозначения с индексом в тексте (A_п, Q_отд, η_max) — нижним индексом
    return libSubs ? h.replace(/([0-9A-Za-zА-Яа-яЁёΑ-Ωα-ω'′)])_([0-9A-Za-zА-Яа-яЁё]+)/g, "$1<sub>$2</sub>") : h;
  }

  const titled = (b, fallback) => (b.title ? inline(b.title) : fallback);

  /** Особый блок: цветная полоса слева, метка, компактное содержимое.
   *  tone: imp (важное: ВАЖНО, ЗАПОМНИ) | alt (итог: ВЫВОД) | head (цвет заголовков: ФОРМУЛА) | plain (ПРИМЕР) */
  const box = (cls, tone, label, inner) =>
    '<div class="cn-box ' + cls + " tone-" + tone + '"><div class="cn-box-label">' + label + "</div>" + inner + "</div>";
  const list = (items, ordered) => {
    const tag = ordered ? "ol" : "ul";
    return "<" + tag + ' class="cn-list">' + items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</" + tag + ">";
  };
  const sub = (title) => (title ? '<h3 class="cn-h3">' + inline(title) + "</h3>" : "");
  // готовые конспекты библиотеки: индекс после «_» в формулах (Q_отд, N_потерь) — нижним индексом; в конспектах по фото
  // формулы выводятся как прежде (флаг ставит body() на время вывода готового конспекта)
  let libSubs = false;
  const fx = (s) => (libSubs ? esc(s).replace(/_([0-9A-Za-zА-Яа-яЁё]+)/g, "<sub>$1</sub>") : esc(s));
  const variables = (vars) =>
    vars.length
      ? '<ul class="cn-vars">' +
        vars
          .map(
            (v) =>
              '<li><span class="formula-inline">' + fx(v.symbol) + "</span> — " + esc(v.name) +
              (v.unit ? ", " + esc(v.unit) : "") + "</li>",
          )
          .join("") +
        "</ul>"
      : "";

  /**
   * classic-2: смысловые карточки. Каждый тип — свой смысловой цвет (k-*), одинаковый для всех предметов;
   * предмет задаёт только акцент страницы. null — блок выводится так же, как в прежнем формате.
   */
  const kcard = (kind, label, inner, cls) =>
    '<div class="cn-box k-' + kind + (cls ? " " + cls : "") + '"><div class="cn-box-label">' + label + "</div>" + inner + "</div>";
  function blockV2(b) {
    switch (b.type) {
      case "DEFINITION":
        return kcard("def", "Определение", '<p><span class="kw-def">' + inline(b.term) + "</span> — " + inline(b.text) + "</p>");
      case "IMPORTANT":
        return kcard("imp", titled(b, "Важно"), "<p>" + inline(b.text) + "</p>", b.title ? "titled" : "");
      case "MAIN_IDEA":
        return kcard("main", titled(b, "Главное"), "<p>" + inline(b.text) + "</p>", b.title ? "titled" : "");
      case "CONCLUSION":
        return kcard("concl", titled(b, "Вывод"), "<p>" + inline(b.text) + "</p>", b.title ? "titled" : "");
      case "EXAMPLE":
        return kcard("ex", titled(b, "Пример"), "<p>" + inline(b.text) + "</p>", b.title ? "titled" : "");
      case "REMEMBER":
        return kcard("imp", "Запомни", list(b.items));
      case "LIST":
        return b.title ? kcard("info", inline(b.title), list(b.items, b.ordered), "titled") : null;
      case "PROCESS":
        return b.title ? kcard("info", inline(b.title), list(b.steps, true), "titled") : kcard("info", "Этапы", list(b.steps, true));
      case "CAUSE_EFFECT":
        return kcard("cause", "Причина → следствие",
          (b.causes.length ? '<p class="cn-lbl">Причины</p>' + list(b.causes) : "") +
          (b.effects.length ? '<p class="cn-lbl">Следствия</p>' + list(b.effects) : ""));
      case "FORMULA":
        return kcard("formula", "Формула",
          '<div class="formula">' + fx(b.expression) + "</div>" + (b.text ? "<p>" + inline(b.text) + "</p>" : "") + variables(b.variables));
    }
    return null;
  }

  function block(b, v2) {
    if (v2) {
      const html = blockV2(b);
      if (html !== null) return html;
    }
    switch (b.type) {
      case "PARAGRAPH":
        return "<p>" + inline(b.text) + "</p>";
      case "LIST":
        return sub(b.title) + list(b.items, b.ordered);
      case "MAIN_IDEA":
        return box("main", "imp", titled(b, "Важно · главная мысль"), "<p>" + inline(b.text) + "</p>");
      case "IMPORTANT":
        return box("important", "imp", titled(b, "Важно"), "<p>" + inline(b.text) + "</p>");
      case "REMEMBER":
        return box("remember", "imp", "Запомни", list(b.items));
      case "CONCLUSION":
        return box("conclusion", "alt", titled(b, "Вывод"), "<p>" + inline(b.text) + "</p>");
      case "EXAMPLE":
        return box("example", "plain", titled(b, "Пример"), "<p>" + inline(b.text) + "</p>");
      case "DEFINITION":
        return '<p><span class="kw-def">' + inline(b.term) + "</span> — " + inline(b.text) + "</p>";
      case "DATE":
        return '<p><span class="kw-date">' + inline(b.date) + "</span> — " + inline(b.text) + "</p>";
      case "PERSON":
        return '<p><span class="kw-person">' + inline(b.name) + "</span> — " + inline(b.text) + "</p>";
      case "EVENT":
        return (
          "<p><strong>" + inline(b.title) + "</strong>" +
          (b.date ? ' (<span class="kw-date">' + inline(b.date) + "</span>)" : "") +
          (b.text ? " — " + inline(b.text) : "") + "</p>"
        );
      case "CAUSE_EFFECT":
        return (
          sub("Причина → следствие") +
          (b.causes.length ? '<p class="cn-lbl">Причины:</p>' + list(b.causes) : "") +
          (b.effects.length ? '<p class="cn-lbl">Следствия:</p>' + list(b.effects) : "")
        );
      case "FORMULA":
        return box(
          "formulas",
          "head",
          "Формула",
          '<div class="formula">' + fx(b.expression) + "</div>" +
            (b.text ? "<p>" + inline(b.text) + "</p>" : "") + variables(b.variables),
        );
      case "PROCESS":
        return sub(b.title) + list(b.steps, true);
      case "SEQUENCE":
        return (
          '<ol class="cn-list sequence">' +
          b.items
            .map((x) => "<li>" + (x.label ? "<strong>" + inline(x.label) + "</strong>" + (x.text ? " — " : "") : "") + inline(x.text) + "</li>")
            .join("") +
          "</ol>"
        );
      case "TABLE": {
        // 3+ колонок на телефоне не помещаются: строка становится компактным блоком «Заголовок: значение»
        const stack = b.headers.length >= 3;
        const label = (i) => (stack && i > 0 && b.headers[i] ? ' data-label="' + esc(b.headers[i]) + '"' : "");
        return (
          '<div class="table-wrap"><table class="note-table' + (stack ? " stack" : "") + '">' +
          (b.headers.length ? "<thead><tr>" + b.headers.map((h) => "<th>" + inline(h) + "</th>").join("") + "</tr></thead>" : "") +
          "<tbody>" +
          b.rows.map((r) => "<tr>" + r.map((c, i) => "<td" + label(i) + ">" + inline(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table></div>"
        );
      }
    }
    return "";
  }

  /** Вводный блок: предмет, название, тема и строка метаданных — компактно, чтобы материал был виден сразу. */
  // числа справочника для шапки готового конспекта: «4 раздела · 6 терминов» — только то, что есть в данных
  const ruPlural = (n, one, few, many) => n + " " + (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
  const v2Sections = (c) => c.sections.filter((s) => !(s.heading && FIGURE_CAPTION.test(plainText(s.heading))));
  // номер и заголовок раздела — так же, как в body(): номер из учебника («2. …») или по порядку
  const numbered = (secs) => {
    let num = 0;
    return secs.map((s) => {
      const m = /^\s*(\d{1,2})\s*[.)]\s+(\S.*)$/.exec(s.heading || "");
      num = m ? Number(m[1]) : num + 1;
      return { num, title: m ? m[2] : s.heading || "" };
    });
  };

  // справочник готового конспекта: иконка (inline SVG, цвет — currentColor) и название по типу
  const LR_ICON = {
    terms: '<path d="M5 4.5h11a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11M9 8.5h5M9 11.5h3"/>',
    people: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    dates: '<rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    formulas: '<path d="M15 4.5h-3.2a2 2 0 0 0-2 1.7L8.2 17.8a2 2 0 0 1-2 1.7H5"/><path d="M7 10h7M14 13l5 5M19 13l-5 5"/>',
  };
  const lrIcon = (k) =>
    '<svg class="lr-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + LR_ICON[k] + "</svg>";
  const lrRefs = (c) =>
    [
      ["terms", "Термины", c.glossary.terms.length],
      ["people", c.meta.subject === "history" ? "Исторические личности" : "Личности", c.glossary.people.length],
      ["dates", "Важные даты", c.glossary.dates.length],
      ["formulas", "Формулы", c.glossary.formulas.length],
    ].filter((x) => x[2]);

  /** Шапка готового конспекта библиотеки: предмет, номер параграфа, название, глава · учебник, состав, оглавление. */
  function libraryHead(c, opts) {
    const m = c.meta, g = c.glossary;
    const badge = m.paragraph || m.tagline[m.tagline.length - 1] || "";
    const where = [m.tagline[0], opts.book].filter((x) => x && x !== badge).map(esc).join('<span class="sep">·</span>');
    const secs = v2Sections(c);
    const stats = [
      secs.length && ruPlural(secs.length, "раздел", "раздела", "разделов"),
      g.terms.length && ruPlural(g.terms.length, "термин", "термина", "терминов"),
      g.people.length && ruPlural(g.people.length, "личность", "личности", "личностей"),
      g.dates.length && ruPlural(g.dates.length, "дата", "даты", "дат"),
      g.formulas.length && ruPlural(g.formulas.length, "формула", "формулы", "формул"),
      c.selfCheck.length && ruPlural(c.selfCheck.length, "вопрос", "вопроса", "вопросов"),
    ].filter(Boolean);
    const refs = lrRefs(c);
    const toc = secs.length > 1 || refs.length
      ? '<nav class="lr-toc" aria-label="Разделы параграфа"><div class="lr-toc-h">В параграфе</div><ol>' +
        numbered(secs).filter((x) => x.title).map((x) => '<li><button type="button" data-jump="lr-s' + x.num + '"><span class="lr-toc-n">' + x.num + '</span><span class="lr-toc-t">' + inline(x.title) + "</span></button></li>").join("") +
        refs.map(([k, t, n]) => '<li><button type="button" class="lr-toc-ref ' + k + '" data-jump="lr-' + k + '"><span class="lr-toc-n">' + lrIcon(k) + '</span><span class="lr-toc-t">' + t + '</span><span class="lr-toc-c">' + n + "</span></button></li>").join("") +
        "</ol></nav>"
      : "";
    return (
      '<header class="cn-intro lr-hero"><div class="lr-hero-top"><span class="cn-kicker">' + esc(m.subjectLabel) + "</span>" +
      (m.materialType ? '<span class="lr-kind">' + esc(m.materialType) + "</span>" : "") +
      (badge ? '<span class="lr-badge">' + esc(badge) + "</span>" : "") + "</div>" +
      '<h1 class="note-title">' + esc(m.title) + "</h1>" +
      (where ? '<div class="note-meta lr-where">' + where + "</div>" : "") +
      (stats.length ? '<ul class="lr-stats">' + stats.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") +
      "</header>" + toc
    );
  }

  function head(c, opts) {
    if (opts?.layout === "library" && c.meta.format === "classic-2") return libraryHead(c, opts);
    const m = c.meta;
    const lead = m.topic && m.topic !== m.title ? '<p class="cn-lead">' + esc(m.topic) + "</p>" : "";
    return (
      '<header class="cn-intro' + (m.format === "classic-2" ? " cn-v2i" : "") + '"><div class="cn-kicker">' + esc(m.subjectLabel) + "</div>" +
      '<h1 class="note-title">' + esc(m.title) + "</h1>" + lead +
      (m.tagline.length ? '<div class="note-meta">' + m.tagline.map(esc).join('<span class="sep">·</span>') + "</div>" : "") +
      "</header>"
    );
  }

  /** Раздел с акцентным заголовком (формулы, вопросы). */
  const part = (cls, title, inner) => '<section class="cn-part ' + cls + '"><h2 class="cn-h2alt">' + title + "</h2>" + inner + "</section>";
  /** Справочная карточка (термины, личности, даты): цветная полоса, заголовок, плотные строки. */
  const card = (cls, title, inner) => '<section class="cn-card ' + cls + '"><h2 class="cn-card-title">' + title + "</h2>" + inner + "</section>";

  const CHEVRON =
    '<svg class="cn-ref-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /**
   * Сворачиваемый справочный блок classic-2: [ Термины ⌄ ]. Содержимое остаётся в документе (поиск по конспекту
   * находит его и раскрывает блок), по нажатию плавно раскрывается. Открытие/закрытие — app.js (data-ref).
   */
  const ref = (cls, title, inner, tag = "section", h = "h2", id = "ref-" + cls) =>
    "<" + tag + ' class="cn-ref ' + cls + '"><' + h + ' class="cn-ref-h"><button type="button" class="cn-ref-btn" data-ref aria-expanded="false" aria-controls="' + id +
    '">' + title + CHEVRON + "</button></" + h + '><div class="cn-ref-panel" id="' + id + '" role="region"><div class="cn-ref-inner"><div class="cn-ref-body">' + inner +
    "</div></div></div></" + tag + ">";
  /** Открытая справочная карточка classic-2 («Важно», «Вывод»): без сворачивания. */
  const openCard = (kind, title, inner) => '<section class="cn-end k-' + kind + '"><h2 class="cn-end-h">' + title + "</h2>" + inner + "</section>";
  /** Подпись к рисунку/схеме/таблице («Рис. 24. …») — не раздел учебника. */
  const FIGURE_CAPTION = /^\s*(?:рис(?:\.|унок)|схема|табл(?:\.|ица))\s*\d/i;
  const plainText = (s) => String(s || "").replace(/\*\*/g, "").replace(/\[(?:t|d|p|f):([^\]\n]+?)\]/g, "$1");

  /**
   * Утверждённый формат Classic Note (одинаковый для всех предметов):
   * основная часть по разделам → Термины → Личности → Даты → Формулы → Важно → Вывод → Вопросы и ответы.
   * Пустые справочные блоки не выводятся.
   */
  function body(c, opts) {
    const g = c.glossary;
    const v2 = c.meta.format === "classic-2";
    const lib = v2 && opts?.layout === "library";
    libSubs = lib;
    let h = '<article class="cn-body' + (v2 ? " cn-v2" : "") + '">';
    if (c.warnings.length) h += '<p class="note-warning">' + c.warnings.map(esc).join("<br>") + "</p>";
    // готовый конспект библиотеки: «Главное» — введение и ключевые пункты (remember) в одной зелёной карточке в начале
    const leadPoints = lib && c.remember.length ? list(c.remember) : "";
    if (v2 && c.lead) h += kcard("main", "Главное", "<p>" + inline(c.lead) + "</p>" + leadPoints, "lead");
    let num = 0;
    c.sections.forEach((s, i) => {
      if (!v2) {
        h += '<section class="cn-sec">';
        if (s.heading) h += '<h2 class="cn-h2">' + (i + 1) + ". " + inline(s.heading) + "</h2>";
        h += s.blocks.map((b) => block(b, v2)).join("") + "</section>";
        return;
      }
      // classic-2: подпись к рисунку — продолжение текущего пункта, без номера
      if (s.heading && FIGURE_CAPTION.test(plainText(s.heading))) {
        h += '<section class="cn-sec cn-fig"><p class="cn-cap">' + inline(s.heading) + "</p>" + s.blocks.map((b) => block(b, true)).join("") + "</section>";
        return;
      }
      // номер из учебника («2. …», «2) …») или по порядку
      const m = /^\s*(\d{1,2})\s*[.)]\s+(\S.*)$/.exec(s.heading || "");
      num = m ? Number(m[1]) : num + 1;
      const title = m ? m[2] : s.heading;
      h += '<section class="cn-sec"' + (lib ? ' id="lr-s' + num + '"' : "") + ">";
      if (title) h += '<h2 class="cn-h2"><span class="cn-num">' + num + '</span><span class="cn-h2-t">' + inline(title) + "</span></h2>";
      h += s.blocks.map((b) => block(b, true)).join("") + "</section>";
    });

    const terms = g.terms.map((t) => '<p class="cn-gl"><span class="kw-def">' + esc(t.term) + "</span> — " + inline(t.definition) + "</p>").join("");
    const people = g.people.map((p) => '<p class="cn-gl"><span class="kw-person">' + esc(p.name) + "</span> — " + inline(p.role) + "</p>").join("");
    const dates = g.dates.map((d) => '<p class="cn-gl cn-date"><span class="kw-date">' + esc(d.date) + "</span><span>" + inline(d.event) + "</span></p>").join("");
    const formulas = g.formulas
      .map((f) => '<div class="formula">' + esc(f.expression) + "</div>" + (f.meaning ? "<p>" + inline(f.meaning) + "</p>" : "") + variables(f.variables))
      .join("");
    const remember = c.remember.length === 1 ? "<p>" + inline(c.remember[0]) + "</p>" : list(c.remember);
    const qa = c.selfCheck
      .map(
        (x, i) =>
          '<div class="qa"><div class="qa-q">' + (i + 1) + ". " + inline(x.q) + "</div>" +
          (x.a ? '<div class="qa-a"><span class="qa-label">Ответ:</span> ' + inline(x.a) + "</div>" : "") + "</div>",
      )
      .join("");

    if (v2) {
      // справочник — сворачиваемый; «Важно» и «Вывод» — открытые карточки; вопросы раскрываются по одному.
      // Пустые блоки не выводятся.
      const pair = (a, b) => '<div class="cn-pair"><div class="cn-pair-k">' + a + '</div><div class="cn-pair-v">' + b + "</div></div>";
      const t = (s) => '<span class="cn-ref-t">' + s + "</span>";
      if (lib) h += libraryRef(c);
      else {
      if (g.terms.length) h += ref("terms", t("Термины"), g.terms.map((x) => pair('<span class="kw-def">' + esc(x.term) + "</span>", inline(x.definition))).join(""));
      if (g.people.length) h += ref("people", t("Личности"), g.people.map((x) => pair('<span class="kw-person">' + esc(x.name) + "</span>", inline(x.role))).join(""));
      if (g.dates.length) h += ref("dates", t("Даты"), g.dates.map((x) => pair('<span class="kw-date">' + esc(x.date) + "</span>", inline(x.event))).join(""));
      }
      if (g.formulas.length && !lib) h += ref("formulas", t("Формулы"), formulas);
      if (c.remember.length && !(lib && c.lead)) h += openCard("imp", "Важно", remember);
      if (c.conclusion) h += openCard("concl", "Вывод", "<p>" + inline(c.conclusion) + "</p>");
      if (c.selfCheck.length)
        h += '<section class="cn-qa"><h2 class="cn-qa-h">' + (lib && c.meta.selfCheckTitle ? esc(c.meta.selfCheckTitle) : "Вопросы и ответы") + "</h2>" + (lib && c.meta.selfCheckNote ? '<p class="cn-qa-note">' + esc(c.meta.selfCheckNote) + "</p>" : "") +
          c.selfCheck
            .map((x, i) =>
              ref("cn-q", '<span class="cn-q-n">' + (i + 1) + '.</span><span class="cn-q-t">' + inline(x.q) + "</span>",
                x.a ? '<p class="qa-a">' + inline(x.a) + "</p>" : '<p class="qa-a cn-muted">Ответ не указан.</p>', "div", "h3", "ref-q" + (i + 1)))
            .join("") +
          "</section>";
      return h + "</article>";
    }

    if (g.terms.length) h += card("terms", "Термины", terms);
    if (g.people.length) h += card("people", "Личности", people);
    if (g.dates.length) h += card("dates", "Даты", dates);
    if (g.formulas.length) h += part("formulas", "Формулы", formulas);
    // «Важно» — несколько ключевых акцентов (StudyContent.remember), тем же блоком, что и IMPORTANT
    if (c.remember.length) h += box("important key-points", "imp", "Важно", remember);
    if (c.conclusion) h += box("conclusion", "alt", "Вывод", "<p>" + inline(c.conclusion) + "</p>");
    if (c.selfCheck.length) h += part("qa-part", "Вопросы и ответы", qa);
    return h + "</article>";
  }

  /**
   * Справочник готового конспекта библиотеки: «Термины», «Исторические личности», «Важные даты» — отдельные
   * сворачиваемые блоки (по умолчанию свёрнуты) с иконкой, названием, числом элементов и стрелкой.
   * Раскрытие — тот же механизм, что у справочника конспектов по фото (data-ref, aria-expanded/aria-controls).
   * Внутри: термины — карточки, личности — компактные карточки, даты — временная шкала в порядке источника.
   * Текст тот же, что в данных; свёрнутый блок остаётся в документе целиком.
   */
  function libraryRef(c) {
    const g = c.glossary;
    const inner = {
      terms: () => '<dl class="lr-terms">' + g.terms.map((x) => '<div class="lr-term"><dt class="kw-def">' + esc(x.term) + "</dt><dd>" + inline(x.definition) + "</dd></div>").join("") + "</dl>",
      people: () =>
        '<ul class="lr-people">' +
        g.people.map((x) => '<li class="lr-person"><span class="lr-mono" aria-hidden="true">' + esc(x.name.trim().charAt(0)) + '</span><div><b class="kw-person">' + esc(x.name) + "</b><p>" + inline(x.role) + "</p></div></li>").join("") +
        "</ul>",
      dates: () => '<ol class="lr-timeline">' + g.dates.map((x) => '<li><span class="kw-date lr-date">' + esc(x.date) + "</span><p>" + inline(x.event) + "</p></li>").join("") + "</ol>",
      // формулы (физика и др.): карточка — формула, что она выражает, обозначения с единицами
      formulas: () => '<div class="lr-formulas">' + g.formulas.map((f) => '<div class="lr-formula"><div class="formula">' + fx(f.expression) + "</div>" + (f.meaning ? "<p>" + inline(f.meaning) + "</p>" : "") + variables(f.variables) + "</div>").join("") + "</div>",
    };
    return lrRefs(c)
      .map(([k, title, n]) =>
        '<section class="cn-ref lr-acc ' + k + '" id="lr-' + k + '"><h2 class="cn-ref-h"><button type="button" class="cn-ref-btn" id="lr-' + k + '-btn" data-ref aria-expanded="false" aria-controls="lr-' + k + '-panel">' +
        '<span class="lr-acc-ico">' + lrIcon(k) + '</span><span class="cn-ref-t">' + title + '</span><span class="lr-count">' + n + "</span>" + CHEVRON + "</button></h2>" +
        '<div class="cn-ref-panel" id="lr-' + k + '-panel" role="region" aria-labelledby="lr-' + k + '-btn"><div class="cn-ref-inner"><div class="cn-ref-body">' + inner[k]() + "</div></div></div></section>")
      .join("");
  }

  /** Подсказка для поиска по конспекту из его же данных: «Поиск: §7, Северная война, Ништадтский мир…» */
  function searchHint(c) {
    const words = [];
    [c.meta.paragraph, ...c.glossary.terms.map((t) => t.term), ...c.glossary.people.map((p) => p.name)]
      .filter(Boolean)
      .forEach((w) => {
        if (words.length < 3 && words.join(", ").length + w.length <= 26) words.push(w);
      });
    return words.length ? "Поиск: " + words.join(", ") + "…" : "Поиск по конспекту";
  }

  K.modes = K.modes || {};
  K.modes.classic = {
    id: "classic", label: "Конспект",
    render: (c, opts) => {
      libSubs = c.meta.format === "classic-2" && opts?.layout === "library";
      return { head: head(c, opts), body: body(c, opts), searchHint: searchHint(c) };
    },
  };
})();
