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
    return esc(nbsp(s))
      .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(d|t|p|f):([^\]\n]+?)\]/g, (_, k, v) => '<span class="' + INLINE[k] + '">' + v + "</span>");
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
  const variables = (vars) =>
    vars.length
      ? '<ul class="cn-vars">' +
        vars
          .map(
            (v) =>
              '<li><span class="formula-inline">' + esc(v.symbol) + "</span> — " + esc(v.name) +
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
          '<div class="formula">' + esc(b.expression) + "</div>" + (b.text ? "<p>" + inline(b.text) + "</p>" : "") + variables(b.variables));
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
          '<div class="formula">' + esc(b.expression) + "</div>" +
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
  function head(c) {
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
  function body(c) {
    const g = c.glossary;
    const v2 = c.meta.format === "classic-2";
    let h = '<article class="cn-body' + (v2 ? " cn-v2" : "") + '">';
    if (c.warnings.length) h += '<p class="note-warning">' + c.warnings.map(esc).join("<br>") + "</p>";
    if (v2 && c.lead) h += kcard("main", "Главное", "<p>" + inline(c.lead) + "</p>", "lead");
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
      h += '<section class="cn-sec">';
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
      if (g.terms.length) h += ref("terms", t("Термины"), g.terms.map((x) => pair('<span class="kw-def">' + esc(x.term) + "</span>", inline(x.definition))).join(""));
      if (g.people.length) h += ref("people", t("Личности"), g.people.map((x) => pair('<span class="kw-person">' + esc(x.name) + "</span>", inline(x.role))).join(""));
      if (g.dates.length) h += ref("dates", t("Даты"), g.dates.map((x) => pair('<span class="kw-date">' + esc(x.date) + "</span>", inline(x.event))).join(""));
      if (g.formulas.length) h += ref("formulas", t("Формулы"), formulas);
      if (c.remember.length) h += openCard("imp", "Важно", remember);
      if (c.conclusion) h += openCard("concl", "Вывод", "<p>" + inline(c.conclusion) + "</p>");
      if (c.selfCheck.length)
        h += '<section class="cn-qa"><h2 class="cn-qa-h">Вопросы и ответы</h2>' +
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
  K.modes.classic = { id: "classic", label: "Конспект", render: (c) => ({ head: head(c), body: body(c), searchHint: searchHint(c) }) };
})();
