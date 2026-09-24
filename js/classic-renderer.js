/*
 * Classic renderer: StudyContent → HTML существующих компонентов конспекта
 * (.section-bar, .special.*, .date/.term/.person, .qa-title).
 * Весь текст экранируется; разметку добавляет только renderer.
 *
 * K.modes — реестр режимов представления. Новый режим (sticky, handwritten, quiz…)
 * добавляется сюда и получает тот же StudyContent — без повторного анализа фото.
 */
(() => {
  const K = (window.K = window.K || {});
  const esc = K.esc;
  const INLINE = { d: "date", t: "term", p: "person", f: "formula-inline" };

  // Типографика: однобуквенные предлоги и союзы не остаются в конце строки («с европейскими», «и шведской»).
  const ONE_LETTER = /(^|[\s(«„])([А-Яа-яЁё]) (?=\S)/g;
  const nbsp = (s) => String(s ?? "").replace(ONE_LETTER, "$1$2 ").replace(ONE_LETTER, "$1$2 ");

  function inline(s) {
    return esc(nbsp(s))
      .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(d|t|p|f):([^\]\n]+?)\]/g, (_, k, v) => '<span class="' + INLINE[k] + '">' + v + "</span>");
  }

  const card = (cls, title, inner) => '<div class="special ' + cls + '"><h3>' + title + "</h3>" + inner + "</div>";
  const list = (items, ordered) => {
    const tag = ordered ? "ol" : "ul";
    return "<" + tag + ">" + items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</" + tag + ">";
  };
  const variables = (vars) =>
    vars.length
      ? '<ul class="vars">' +
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
        return (b.title ? "<b>" + inline(b.title) + "</b>" : "") + list(b.items, b.ordered);
      case "MAIN_IDEA":
        return card("main", "ГЛАВНОЕ", "<p>" + inline(b.text) + "</p>");
      case "IMPORTANT":
        return card("important", "ВАЖНО", "<p>" + inline(b.text) + "</p>");
      case "CONCLUSION":
        return card("conclusion", "ВЫВОД", "<p>" + inline(b.text) + "</p>");
      case "EXAMPLE":
        return card("example", "ПРИМЕР", "<p>" + inline(b.text) + "</p>");
      case "REMEMBER":
        return card("remember", "ЗАПОМНИ", list(b.items));
      case "DEFINITION":
        return '<p><span class="term">' + inline(b.term) + "</span> — " + inline(b.text) + "</p>";
      case "DATE":
        return '<p><span class="date">' + inline(b.date) + "</span> — " + inline(b.text) + "</p>";
      case "PERSON":
        return '<p><span class="person">' + inline(b.name) + "</span> — " + inline(b.text) + "</p>";
      case "EVENT":
        return (
          "<p><strong>" + inline(b.title) + "</strong>" +
          (b.date ? ' (<span class="date">' + inline(b.date) + "</span>)" : "") +
          (b.text ? " — " + inline(b.text) : "") + "</p>"
        );
      case "CAUSE_EFFECT":
        return card(
          "cause",
          "ПРИЧИНА → СЛЕДСТВИЕ",
          (b.causes.length ? "<b>Причины:</b>" + list(b.causes) : "") +
            (b.effects.length ? "<b>Следствия:</b>" + list(b.effects) : ""),
        );
      case "FORMULA":
        return card(
          "formulas",
          "ФОРМУЛА",
          '<div class="formula">' + esc(b.expression) + "</div>" +
            (b.text ? "<p>" + inline(b.text) + "</p>" : "") + variables(b.variables),
        );
      case "PROCESS":
        return (b.title ? "<b>" + inline(b.title) + "</b>" : "") + list(b.steps, true);
      case "SEQUENCE":
        return (
          '<ol class="sequence">' +
          b.items
            .map((x) => "<li>" + (x.label ? "<strong>" + inline(x.label) + "</strong>" + (x.text ? " — " : "") : "") + inline(x.text) + "</li>")
            .join("") +
          "</ol>"
        );
      case "TABLE":
        return (
          '<div class="table-wrap"><table class="note-table">' +
          (b.headers.length ? "<thead><tr>" + b.headers.map((h) => "<th>" + inline(h) + "</th>").join("") + "</tr></thead>" : "") +
          "<tbody>" +
          b.rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table></div>"
        );
    }
    return "";
  }

  function head(c) {
    const subject = K.study.subject(c.meta.subject);
    return (
      '<span class="subject ' + subject.badge + " s-" + c.meta.subject + '">' + esc(c.meta.subjectLabel) + "</span>" +
      '<h1 class="note-title">' + esc(c.meta.title) + "</h1>" +
      '<div class="note-meta">' + c.meta.tagline.map(esc).join('<span class="sep">·</span>') + "</div>"
    );
  }

  function body(c) {
    const g = c.glossary;
    let h = '<div class="note-body">';
    if (c.warnings.length) h += '<p class="note-warning">' + c.warnings.map(esc).join("<br>") + "</p>";
    c.sections.forEach((s, i) => {
      if (s.heading) h += '<div class="section-bar">' + (i + 1) + ". " + inline(s.heading) + "</div>";
      h += s.blocks.map(block).join("");
    });
    if (g.terms.length)
      h += card(
        "terms",
        "Термины и определения",
        g.terms.map((t) => '<p class="gl"><span class="term">' + esc(t.term) + '</span> —<span class="gl-def">' + inline(t.definition) + "</span></p>").join(""),
      );
    if (g.people.length)
      h += card(
        "people",
        "Личности",
        g.people.map((p) => '<p class="gl"><span class="person">' + esc(p.name) + '</span> —<span class="gl-def">' + inline(p.role) + "</span></p>").join(""),
      );
    if (g.dates.length)
      h += card(
        "dates",
        "Даты",
        g.dates.map((d) => '<p class="gl-date"><span class="date">' + esc(d.date) + "</span> — " + inline(d.event) + "</p>").join(""),
      );
    if (g.formulas.length)
      h += card(
        "formulas",
        "Формулы",
        g.formulas
          .map((f) => '<div class="formula">' + esc(f.expression) + "</div>" + (f.meaning ? "<p>" + inline(f.meaning) + "</p>" : "") + variables(f.variables))
          .join(""),
      );
    if (c.remember.length)
      h += card("important", "ВАЖНО", c.remember.length === 1 ? "<p>" + inline(c.remember[0]) + "</p>" : list(c.remember));
    if (c.conclusion) h += card("conclusion", "ВЫВОД", "<p>" + inline(c.conclusion) + "</p>");
    if (c.selfCheck.length)
      h +=
        '<h2 class="qa-title">Вопросы и задания</h2>' +
        c.selfCheck
          .map(
            (x, i) =>
              '<div class="qa"><span class="qa-n">' + (i + 1) + '.</span><div><div class="qa-q">' + inline(x.q) + "</div>" +
              (x.a ? '<span class="answer">Ответ:</span><div class="qa-a">' + inline(x.a) + "</div>" : "") + "</div></div>",
          )
          .join("");
    return h + "</div>";
  }

  K.modes = K.modes || {};
  K.modes.classic = { id: "classic", label: "Конспект", render: (c) => ({ head: head(c), body: body(c) }) };
})();
