/*
 * StudyContent v1 — универсальное структурированное представление учебного материала.
 *
 * Фото → AI-анализ → StudyContent → режимы (Classic, в будущем Handwritten, Sticky, Quiz…).
 * AI отвечает за содержание, Konspekt — за дизайн: HTML от модели не принимается,
 * только данные этой схемы. Любой вход проходит через normalize().
 *
 * @typedef {Object} StudyContent
 * @property {1} schemaVersion
 * @property {Object} meta
 * @property {string} meta.title          «§7. Северная война»
 * @property {string} meta.subject        ключ из SUBJECTS (history, biology, …, other)
 * @property {string} meta.subjectLabel   «История»
 * @property {string} meta.topic
 * @property {string} [meta.paragraph]    «§7»
 * @property {string[]} meta.tagline      строка метаданных под заголовком
 * @property {string} meta.summary        1–3 предложения, используется как preview в списках
 * @property {{hex:string, confidence:number}|null} meta.accent
 * @property {{index:number, readable:'ok'|'partial'|'unreadable'}[]} meta.pages
 * @property {{id:string, heading:string, blocks:Block[]}[]} sections
 * @property {Object} glossary
 * @property {{id:string, term:string, definition:string}[]} glossary.terms
 * @property {{id:string, date:string, event:string}[]} glossary.dates
 * @property {{id:string, name:string, role:string}[]} glossary.people
 * @property {{id:string, expression:string, meaning:string, variables:Variable[]}[]} glossary.formulas
 * @property {string[]} remember          «ВАЖНО / Запомни»
 * @property {string} conclusion          «ВЫВОД»
 * @property {{q:string, a:string}[]} selfCheck
 * @property {string[]} warnings          например «часть страницы 3 не читается»
 *
 * Block = { id, type, sourcePage?, ...поля типа }:
 *   PARAGRAPH{text} MAIN_IDEA{text} IMPORTANT{text} EXAMPLE{text} CONCLUSION{text}
 *   DEFINITION{term,text} DATE{date,text} PERSON{name,text} EVENT{title,date?,text}
 *   CAUSE_EFFECT{causes[],effects[]} FORMULA{expression,text,variables[]}
 *   PROCESS{title?,steps[]} SEQUENCE{items[{label,text}]} LIST{title?,items[],ordered}
 *   TABLE{headers[],rows[][]} REMEMBER{items[]}
 *
 * Разметка внутри текста: **жирный**, [d:дата], [t:термин], [p:личность], [f:формула].
 */
(() => {
  const K = (window.K = window.K || {});

  K.esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  K.uid = () =>
    window.crypto?.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // asset: путь к фирменной миниатюре предмета (например "./assets/subjects/history.png").
  // Пока null — показывается текущая иконка-placeholder.
  const SUBJECTS = {
    history: { label: "История", pill: "", badge: "", thumb: "t-history", icon: "history", asset: null },
    biology: { label: "Биология", pill: "bio", badge: "bio", thumb: "t-biology", icon: "biology", asset: null },
    physics: { label: "Физика", pill: "physics", badge: "physics", thumb: "t-physics", icon: "physics", asset: null },
    chemistry: { label: "Химия", pill: "physics", badge: "physics", thumb: "t-physics", icon: "flask", asset: null },
    geography: { label: "География", pill: "bio", badge: "bio", thumb: "t-biology", icon: "globe", asset: null },
    literature: { label: "Литература", pill: "", badge: "", thumb: "t-history", icon: "book", asset: null },
    russian: { label: "Русский язык", pill: "", badge: "", thumb: "t-history", icon: "edit", asset: null },
    social: { label: "Обществознание", pill: "other", badge: "other", thumb: "t-other", icon: "user", asset: null },
    math: { label: "Математика", pill: "physics", badge: "physics", thumb: "t-physics", icon: "doc", asset: null },
    other: { label: "Другое", pill: "other", badge: "other", thumb: "t-other", icon: "doc", asset: null },
  };

  const BLOCK_TYPES = [
    "PARAGRAPH", "MAIN_IDEA", "DEFINITION", "IMPORTANT", "DATE", "PERSON", "EVENT",
    "CAUSE_EFFECT", "FORMULA", "PROCESS", "SEQUENCE", "LIST", "EXAMPLE", "TABLE",
    "REMEMBER", "CONCLUSION",
  ];

  const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const arr = (v) => (Array.isArray(v) ? v : []);
  const strs = (v) => arr(v).map(str).filter(Boolean);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

  function normVariables(v) {
    return arr(v)
      .map((x) => ({ symbol: str(x?.symbol), name: str(x?.name), unit: str(x?.unit) }))
      .filter((x) => x.symbol && x.name);
  }

  function normBlock(b, i) {
    if (!b || typeof b !== "object") return null;
    const type = BLOCK_TYPES.includes(b.type) ? b.type : "PARAGRAPH";
    const out = { id: str(b.id) || "b" + i, type };
    if (Number.isFinite(+b.sourcePage) && b.sourcePage !== null && b.sourcePage !== "") out.sourcePage = +b.sourcePage;
    switch (type) {
      case "PARAGRAPH":
      case "MAIN_IDEA":
      case "IMPORTANT":
      case "EXAMPLE":
      case "CONCLUSION":
        out.text = str(b.text);
        return out.text ? out : null;
      case "DEFINITION":
        out.term = str(b.term);
        out.text = str(b.text);
        return out.term && out.text ? out : null;
      case "DATE":
        out.date = str(b.date);
        out.text = str(b.text);
        return out.date && out.text ? out : null;
      case "PERSON":
        out.name = str(b.name);
        out.text = str(b.text);
        return out.name && out.text ? out : null;
      case "EVENT":
        out.title = str(b.title);
        out.date = str(b.date);
        out.text = str(b.text);
        return out.title ? out : null;
      case "CAUSE_EFFECT":
        out.causes = strs(b.causes);
        out.effects = strs(b.effects);
        return out.causes.length || out.effects.length ? out : null;
      case "FORMULA":
        out.expression = str(b.expression);
        out.text = str(b.text);
        out.variables = normVariables(b.variables);
        return out.expression ? out : null;
      case "PROCESS":
        out.title = str(b.title);
        out.steps = strs(b.steps);
        return out.steps.length ? out : null;
      case "SEQUENCE":
        out.items = arr(b.items)
          .map((x) => ({ label: str(x?.label), text: str(x?.text) }))
          .filter((x) => x.label || x.text);
        return out.items.length ? out : null;
      case "LIST":
        out.title = str(b.title);
        out.items = strs(b.items);
        out.ordered = !!b.ordered;
        return out.items.length ? out : null;
      case "TABLE":
        out.headers = strs(b.headers);
        out.rows = arr(b.rows).map((r) => arr(r).map(str)).filter((r) => r.some(Boolean));
        return out.rows.length ? out : null;
      case "REMEMBER":
        out.items = strs(b.items);
        return out.items.length ? out : null;
    }
    return null;
  }

  /** Приводит любой вход (mock или ответ AI) к валидному StudyContent v1. */
  function normalize(raw) {
    const r = obj(raw);
    const m = obj(r.meta);
    const subjectKey = SUBJECTS[m.subject] ? m.subject : "other";
    const accentHex = str(obj(m.accent).hex);
    const sections = arr(r.sections)
      .map((s, si) => ({
        id: str(s?.id) || "s" + si,
        heading: str(s?.heading),
        blocks: arr(s?.blocks)
          .map((b, bi) => normBlock(b, si + "-" + bi))
          .filter(Boolean),
      }))
      .filter((s) => s.heading || s.blocks.length);
    const g = obj(r.glossary);
    const content = {
      schemaVersion: 1,
      meta: {
        title: str(m.title) || "Конспект",
        subject: subjectKey,
        subjectLabel: str(m.subjectLabel) || SUBJECTS[subjectKey].label,
        topic: str(m.topic),
        paragraph: str(m.paragraph),
        tagline: strs(m.tagline),
        summary: str(m.summary),
        accent: /^#[0-9a-f]{6}$/i.test(accentHex)
          ? { hex: accentHex, confidence: Number(obj(m.accent).confidence) || 0 }
          : null,
        pages: arr(m.pages).map((p, i) => ({
          index: Number.isFinite(+p?.index) ? +p.index : i,
          readable: ["ok", "partial", "unreadable"].includes(p?.readable) ? p.readable : "ok",
        })),
      },
      sections,
      glossary: {
        terms: arr(g.terms)
          .map((x, i) => ({ id: str(x?.id) || "t" + i, term: str(x?.term), definition: str(x?.definition) }))
          .filter((x) => x.term && x.definition),
        dates: arr(g.dates)
          .map((x, i) => ({ id: str(x?.id) || "d" + i, date: str(x?.date), event: str(x?.event) }))
          .filter((x) => x.date && x.event),
        people: arr(g.people)
          .map((x, i) => ({ id: str(x?.id) || "p" + i, name: str(x?.name), role: str(x?.role) }))
          .filter((x) => x.name && x.role),
        formulas: arr(g.formulas)
          .map((x, i) => ({
            id: str(x?.id) || "f" + i,
            expression: str(x?.expression),
            meaning: str(x?.meaning),
            variables: normVariables(x?.variables),
          }))
          .filter((x) => x.expression),
      },
      remember: strs(r.remember),
      conclusion: str(r.conclusion),
      selfCheck: arr(r.selfCheck)
        .map((x) => ({ q: str(x?.q), a: str(x?.a) }))
        .filter((x) => x.q),
      warnings: strs(r.warnings),
    };
    if (!content.sections.length && !content.glossary.terms.length) throw new Error("EMPTY_CONTENT");
    return content;
  }

  K.study = {
    SCHEMA_VERSION: 1,
    SUBJECTS,
    BLOCK_TYPES,
    subject: (key) => SUBJECTS[key] || SUBJECTS.other,
    normalize,
  };
})();
