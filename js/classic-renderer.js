/*
 * Classic renderer: StudyContent → HTML плотного учебного конспекта.
 * Обычный текст идёт прямо по «листу»; карточки — только для особых блоков
 * (ВАЖНО, ВЫВОД, ЗАПОМНИ, ПРИМЕР, ФОРМУЛА). Цвета берутся из темы предмета (CSS .nt-<subject>).
 * Весь текст экранируется; разметку добавляет только renderer. Пустые разделы не выводятся.
 *
 * meta.format = "classic-2" (новые AI-конспекты, эталон — PWA «Физика 8» / «История 8»):
 * заголовки разделов — дословно пункты учебника (без автонумерации), карточка «Главное» перед первым
 * разделом, карточки со своим заголовком, списки с заголовком и «причина → следствие» — мягкими карточками,
 * справочные блоки в конце — сворачиваемые. Старые конспекты (без format) выглядят как раньше.
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

  /** v2 — конспект classic-2: списки с заголовком и причинно-следственные связи становятся карточками. */
  function block(b, v2) {
    switch (b.type) {
      case "PARAGRAPH":
        return "<p>" + inline(b.text) + "</p>";
      case "LIST":
        if (v2 && b.title) return box("list-card", "head", inline(b.title), list(b.items, b.ordered));
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
        if (v2)
          return box("cause", "head", "Причина → следствие",
            (b.causes.length ? '<p class="cn-lbl">Причины:</p>' + list(b.causes) : "") +
            (b.effects.length ? '<p class="cn-lbl">Следствия:</p>' + list(b.effects) : ""));
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
        if (v2 && b.title) return box("list-card", "head", inline(b.title), list(b.steps, true));
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
      '<header class="cn-intro"><div class="cn-kicker">' + esc(m.subjectLabel) + "</div>" +
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
  const ref = (cls, title, inner) =>
    '<section class="cn-ref ' + cls + '"><h2 class="cn-ref-h"><button type="button" class="cn-ref-btn" data-ref aria-expanded="false" aria-controls="ref-' + cls +
    '"><span>' + title + "</span>" + CHEVRON + '</button></h2><div class="cn-ref-panel" id="ref-' + cls + '"><div class="cn-ref-inner">' + inner + "</div></div></section>";

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
    if (v2 && c.lead) h += box("lead", "imp", "Главное", "<p>" + inline(c.lead) + "</p>");
    c.sections.forEach((s, i) => {
      h += '<section class="cn-sec">';
      // classic-2: заголовок — дословно пункт учебника (номер, если он есть в учебнике, уже в тексте)
      if (s.heading) h += '<h2 class="cn-h2">' + (v2 ? "" : i + 1 + ". ") + inline(s.heading) + "</h2>";
      h += s.blocks.map((b) => block(b, v2)).join("") + "</section>";
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
      // тот же порядок справочных блоков, каждый — сворачиваемый; пустые не выводятся
      if (g.terms.length) h += ref("terms", "Термины", terms);
      if (g.people.length) h += ref("people", "Личности", people);
      if (g.dates.length) h += ref("dates", "Даты", dates);
      if (g.formulas.length) h += ref("formulas", "Формулы", formulas);
      if (c.remember.length) h += ref("important", "Важно", remember);
      if (c.conclusion) h += ref("conclusion", "Вывод", "<p>" + inline(c.conclusion) + "</p>");
      if (c.selfCheck.length) h += ref("qa-part", "Вопросы и ответы", qa);
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
