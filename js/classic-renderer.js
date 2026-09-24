/*
 * Classic renderer: StudyContent → HTML плотного учебного конспекта.
 * Обычный текст идёт прямо по «листу»; карточки — только для особых блоков
 * (ВАЖНО, ВЫВОД, ЗАПОМНИ, ПРИМЕР, ФОРМУЛА). Цвета берутся из темы предмета (CSS .nt-<subject>).
 * Весь текст экранируется; разметку добавляет только renderer. Пустые разделы не выводятся.
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

  /** Особый блок: цветная полоса слева, метка, компактное содержимое. tone: main (цвет предмета) | alt (второй цвет) | plain */
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

  function block(b) {
    switch (b.type) {
      case "PARAGRAPH":
        return "<p>" + inline(b.text) + "</p>";
      case "LIST":
        return sub(b.title) + list(b.items, b.ordered);
      case "MAIN_IDEA":
        return box("main", "main", "Важно · главная мысль", "<p>" + inline(b.text) + "</p>");
      case "IMPORTANT":
        return box("important", "main", "Важно", "<p>" + inline(b.text) + "</p>");
      case "REMEMBER":
        return box("remember", "main", "Запомни", list(b.items));
      case "CONCLUSION":
        return box("conclusion", "alt", "Вывод", "<p>" + inline(b.text) + "</p>");
      case "EXAMPLE":
        return box("example", "plain", "Пример", "<p>" + inline(b.text) + "</p>");
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
          "main",
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
      '<header class="cn-intro"><div class="cn-kicker">' + esc(m.subjectLabel) + "</div>" +
      '<h1 class="note-title">' + esc(m.title) + "</h1>" + lead +
      (m.tagline.length ? '<div class="note-meta">' + m.tagline.map(esc).join('<span class="sep">·</span>') + "</div>" : "") +
      "</header>"
    );
  }

  /** Раздел с акцентным заголовком (глоссарий, «Что нужно запомнить», вопросы). */
  const part = (cls, title, inner) => '<section class="cn-part ' + cls + '"><h2 class="cn-h2alt">' + title + "</h2>" + inner + "</section>";

  function body(c) {
    const g = c.glossary;
    let h = '<article class="cn-body">';
    if (c.warnings.length) h += '<p class="note-warning">' + c.warnings.map(esc).join("<br>") + "</p>";
    c.sections.forEach((s, i) => {
      h += '<section class="cn-sec">';
      if (s.heading) h += '<h2 class="cn-h2">' + (i + 1) + ". " + inline(s.heading) + "</h2>";
      h += s.blocks.map(block).join("") + "</section>";
    });
    if (c.conclusion) h += box("conclusion", "alt", "Вывод", "<p>" + inline(c.conclusion) + "</p>");
    if (g.terms.length)
      h += part("terms", "Термины и определения",
        g.terms.map((t) => '<p class="cn-gl"><span class="kw-def">' + esc(t.term) + "</span> — " + inline(t.definition) + "</p>").join(""));
    if (g.people.length)
      h += part("people", "Личности",
        g.people.map((p) => '<p class="cn-gl"><span class="kw-person">' + esc(p.name) + "</span> — " + inline(p.role) + "</p>").join(""));
    if (g.dates.length)
      h += part("dates", "Даты",
        g.dates.map((d) => '<p class="cn-gl cn-date"><span class="kw-date">' + esc(d.date) + "</span><span>" + inline(d.event) + "</span></p>").join(""));
    if (g.formulas.length)
      h += part("formulas", "Формулы",
        g.formulas
          .map((f) => '<div class="formula">' + esc(f.expression) + "</div>" + (f.meaning ? "<p>" + inline(f.meaning) + "</p>" : "") + variables(f.variables))
          .join(""));
    if (c.remember.length) h += part("remember", "Что нужно запомнить", list(c.remember));
    if (c.selfCheck.length) {
      const answered = c.selfCheck.some((x) => x.a);
      const title = answered ? "Ответы на вопросы" + (c.meta.paragraph ? " после " + esc(c.meta.paragraph) : "") : "Вопросы для самопроверки";
      h += part("qa-part", title,
        c.selfCheck
          .map((x, i) => '<div class="qa"><div class="qa-q">' + (i + 1) + ". " + inline(x.q) + "</div>" + (x.a ? '<div class="qa-a">' + inline(x.a) + "</div>" : "") + "</div>")
          .join(""));
    }
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
