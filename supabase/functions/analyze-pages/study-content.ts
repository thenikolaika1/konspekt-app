/**
 * Серверная валидация StudyContent v1.
 *
 * Порт normalize() из js/study-content.js: та же схема, те же правила отбрасывания
 * неполных блоков. Источник истины схемы — frontend (js/study-content.js), клиент
 * повторно прогоняет content через свой normalize() перед отрисовкой.
 *
 * Дополнительно к клиенту:
 *  - из всех строк удаляются HTML-теги (HTML от модели не принимается);
 *  - длины строк и массивов ограничены;
 *  - meta.pages приводится к фактическому числу загруженных страниц.
 */

export const SCHEMA_VERSION = 1;

export const SUBJECT_KEYS = [
  "history",
  "biology",
  "physics",
  "chemistry",
  "geography",
  "literature",
  "russian",
  "social",
  "math",
  "other",
] as const;

const SUBJECT_LABELS: Record<string, string> = {
  history: "История",
  biology: "Биология",
  physics: "Физика",
  chemistry: "Химия",
  geography: "География",
  literature: "Литература",
  russian: "Русский язык",
  social: "Обществознание",
  math: "Математика",
  other: "Другое",
};

export const BLOCK_TYPES = [
  "PARAGRAPH", "MAIN_IDEA", "DEFINITION", "IMPORTANT", "DATE", "PERSON", "EVENT",
  "CAUSE_EFFECT", "FORMULA", "PROCESS", "SEQUENCE", "LIST", "EXAMPLE", "TABLE",
  "REMEMBER", "CONCLUSION",
];

const MAX_STR = 1500;
const MAX_ITEMS = 60;
const MAX_SECTIONS = 30;
const MAX_BLOCKS = 60;

type Json = unknown;
type Obj = Record<string, Json>;

// HTML-теги и управляющие символы убираются; разметка **…** и [d:…] остаётся — её понимает renderer
const clean = (s: string) =>
  s
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, MAX_STR);

const str = (v: Json): string => (typeof v === "string" ? clean(v) : typeof v === "number" ? String(v) : "");
const arr = (v: Json): Json[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const strs = (v: Json): string[] => arr(v).map(str).filter(Boolean);
const obj = (v: Json): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function normVariables(v: Json) {
  return arr(v)
    .map((x) => ({ symbol: str(obj(x).symbol), name: str(obj(x).name), unit: str(obj(x).unit) }))
    .filter((x) => x.symbol && x.name);
}

function normBlock(raw: Json, i: string): Obj | null {
  const b = obj(raw);
  if (!Object.keys(b).length) return null;
  const type = BLOCK_TYPES.includes(b.type as string) ? (b.type as string) : "PARAGRAPH";
  const out: Obj = { id: str(b.id) || "b" + i, type };
  if (b.sourcePage !== null && b.sourcePage !== "" && Number.isFinite(Number(b.sourcePage))) out.sourcePage = Number(b.sourcePage);
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
      return (out.causes as string[]).length || (out.effects as string[]).length ? out : null;
    case "FORMULA":
      out.expression = str(b.expression);
      out.text = str(b.text);
      out.variables = normVariables(b.variables);
      return out.expression ? out : null;
    case "PROCESS":
      out.title = str(b.title);
      out.steps = strs(b.steps);
      return (out.steps as string[]).length ? out : null;
    case "SEQUENCE":
      out.items = arr(b.items)
        .map((x) => ({ label: str(obj(x).label), text: str(obj(x).text) }))
        .filter((x) => x.label || x.text);
      return (out.items as Json[]).length ? out : null;
    case "LIST":
      out.title = str(b.title);
      out.items = strs(b.items);
      out.ordered = !!b.ordered;
      return (out.items as string[]).length ? out : null;
    case "TABLE":
      out.headers = strs(b.headers);
      out.rows = arr(b.rows)
        .map((r) => arr(r).map(str))
        .filter((r) => r.some(Boolean));
      return (out.rows as Json[]).length ? out : null;
    case "REMEMBER":
      out.items = strs(b.items);
      return (out.items as string[]).length ? out : null;
  }
  return null;
}

export type StudyContent = {
  schemaVersion: 1;
  meta: {
    title: string;
    subject: string;
    subjectLabel: string;
    topic: string;
    paragraph: string;
    tagline: string[];
    summary: string;
    accent: null;
    pages: { index: number; readable: "ok" | "partial" | "unreadable" }[];
  };
  sections: { id: string; heading: string; blocks: Obj[] }[];
  glossary: {
    terms: { id: string; term: string; definition: string }[];
    dates: { id: string; date: string; event: string }[];
    people: { id: string; name: string; role: string }[];
    formulas: { id: string; expression: string; meaning: string; variables: ReturnType<typeof normVariables> }[];
  };
  remember: string[];
  conclusion: string;
  selfCheck: { q: string; a: string }[];
  warnings: string[];
};

export type ValidationResult =
  | { ok: true; content: StudyContent }
  | { ok: false; code: "AI_BAD_JSON" | "EMPTY_CONTENT" | "UNREADABLE_PAGES"; reason: string };

const READABLE = ["ok", "partial", "unreadable"] as const;

/**
 * Проверяет ответ модели и приводит его к StudyContent v1.
 * pageCount — сколько страниц реально отправлено модели.
 */
export function validateStudyContent(raw: Json, pageCount: number): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "AI_BAD_JSON", reason: "not an object" };
  const r = raw as Obj;
  const m = obj(r.meta);

  // страницы: ровно столько, сколько загружено, в исходном порядке
  const reported = new Map<number, (typeof READABLE)[number]>();
  arr(m.pages).forEach((p, i) => {
    const po = obj(p);
    const idx = Number.isFinite(Number(po.index)) ? Number(po.index) : i;
    const readable = READABLE.includes(po.readable as never) ? (po.readable as (typeof READABLE)[number]) : "ok";
    if (idx >= 0 && idx < pageCount) reported.set(idx, readable);
  });
  const pages = Array.from({ length: pageCount }, (_, i) => ({ index: i, readable: reported.get(i) || ("ok" as const) }));

  const sections = arr(r.sections)
    .slice(0, MAX_SECTIONS)
    .map((s, si) => {
      const so = obj(s);
      return {
        id: str(so.id) || "s" + si,
        heading: str(so.heading),
        blocks: arr(so.blocks)
          .slice(0, MAX_BLOCKS)
          .map((b, bi) => normBlock(b, si + "-" + bi))
          .filter((b): b is Obj => !!b),
      };
    })
    .filter((s) => s.heading || s.blocks.length);

  const g = obj(r.glossary);
  const subject = SUBJECT_KEYS.includes(m.subject as never) ? (m.subject as string) : "other";
  const content: StudyContent = {
    schemaVersion: 1,
    meta: {
      title: str(m.title) || "Конспект",
      subject,
      subjectLabel: SUBJECT_LABELS[subject],
      topic: str(m.topic),
      paragraph: str(m.paragraph),
      tagline: strs(m.tagline).slice(0, 4),
      summary: str(m.summary),
      accent: null,
      pages,
    },
    sections,
    glossary: {
      terms: arr(g.terms)
        .map((x, i) => ({ id: str(obj(x).id) || "t" + i, term: str(obj(x).term), definition: str(obj(x).definition) }))
        .filter((x) => x.term && x.definition),
      dates: arr(g.dates)
        .map((x, i) => ({ id: str(obj(x).id) || "d" + i, date: str(obj(x).date), event: str(obj(x).event) }))
        .filter((x) => x.date && x.event),
      people: arr(g.people)
        .map((x, i) => ({ id: str(obj(x).id) || "p" + i, name: str(obj(x).name), role: str(obj(x).role) }))
        .filter((x) => x.name && x.role),
      formulas: arr(g.formulas)
        .map((x, i) => ({
          id: str(obj(x).id) || "f" + i,
          expression: str(obj(x).expression),
          meaning: str(obj(x).meaning),
          variables: normVariables(obj(x).variables),
        }))
        .filter((x) => x.expression),
    },
    remember: strs(r.remember),
    conclusion: str(r.conclusion),
    selfCheck: arr(r.selfCheck)
      .map((x) => ({ q: str(obj(x).q), a: str(obj(x).a) }))
      .filter((x) => x.q),
    warnings: strs(r.warnings).slice(0, 10),
  };

  const empty = !content.sections.length && !content.glossary.terms.length;
  if (empty) {
    const unreadable = r.error === "UNREADABLE_PAGES" || (pages.length > 0 && pages.every((p) => p.readable === "unreadable"));
    return unreadable
      ? { ok: false, code: "UNREADABLE_PAGES", reason: "no readable pages" }
      : { ok: false, code: "EMPTY_CONTENT", reason: "no sections and no terms" };
  }
  return { ok: true, content };
}

/** Короткое описание для списков (notes.preview) — как summarize() в js/store.js. */
export function previewOf(c: StudyContent): string {
  return (c.meta.summary || c.sections.map((s) => s.heading).filter(Boolean).join(", ")).slice(0, 300);
}

/**
 * Достаёт JSON-объект из ответа модели: убирает служебные маркеры GLM (<|begin_of_box|>),
 * ограждения ```json и текст вокруг объекта. null — если JSON не разобрать.
 */
export function extractJson(text: string): Json | null {
  let t = String(text || "")
    .replace(/<\|begin_of_box\|>|<\|end_of_box\|>/g, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ---------- качество конспекта ----------
//
// qualityIssues() находит нарушения утверждённого формата Classic Note: пересказ вместо конспекта,
// дубли, лишние повторяющие блоки и явные артефакты распознавания. По этому списку делается
// повторный запрос к модели. sanitize() после финальной попытки только убирает явно лишнее
// и повреждённое — текст никогда не «исправляется» и буквы не заменяются.

/** Слово, в котором в одном сплошном наборе букв смешаны кириллица и латиница («кисlorод», «Orgаны»). */
const LETTER_RUN = /[A-Za-zА-Яа-яЁё]+/g;
const HAS_CYR = /[А-Яа-яЁё]/;
const HAS_LAT = /[A-Za-z]/;

export function mixedScriptWords(text: string): string[] {
  const out: string[] = [];
  for (const run of String(text || "").match(LETTER_RUN) || []) {
    if (HAS_CYR.test(run) && HAS_LAT.test(run)) out.push(run);
  }
  return out;
}

const normTerm = (s: string) =>
  s.toLowerCase().replace(/ё/g, "е").replace(/\[[a-z]:|\]|\*\*/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

// ориентиры утверждённого формата (не жёсткие лимиты символов: превышение — повод для повтора)
const LIMITS = {
  paragraph: 450,
  definition: 220,
  termDefinition: 220,
  remember: 3,
  rememberItem: 200,
  conclusion: 500,
  selfCheck: 6,
  answer: 260,
  accents: 2, // IMPORTANT/MAIN_IDEA на весь конспект
  mainPerPage: 900, // символов основного текста на страницу (≈30–45% учебной страницы)
  mainBase: 500,
};

const FORBIDDEN_IN_SECTIONS = ["REMEMBER", "CONCLUSION"];

/** Все текстовые значения блока (для подсчёта длины и поиска артефактов). */
function blockTexts(b: Obj): string[] {
  const out: string[] = [];
  const add = (v: Json) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === "object") Object.entries(v as Obj).forEach(([k, x]) => k !== "id" && k !== "type" && add(x));
  };
  add(b);
  return out;
}

function allTexts(c: StudyContent): string[] {
  const t: string[] = [c.meta.title, c.meta.topic, c.meta.summary, ...c.meta.tagline];
  c.sections.forEach((s) => {
    t.push(s.heading);
    s.blocks.forEach((b) => t.push(...blockTexts(b)));
  });
  c.glossary.terms.forEach((x) => t.push(x.term, x.definition));
  c.glossary.people.forEach((x) => t.push(x.name, x.role));
  c.glossary.dates.forEach((x) => t.push(x.date, x.event));
  c.glossary.formulas.forEach((x) => t.push(x.meaning));
  t.push(...c.remember, c.conclusion);
  c.selfCheck.forEach((x) => t.push(x.q, x.a));
  return t.filter(Boolean);
}

/** Нарушения формата — короткие фразы по-русски, их же получает модель при повторе. */
export function qualityIssues(c: StudyContent, pageCount: number): string[] {
  const issues: string[] = [];

  const broken = [...new Set(allTexts(c).flatMap(mixedScriptWords))];
  if (broken.length)
    issues.push("слова со смесью латиницы и кириллицы (ошибка чтения): " + broken.slice(0, 8).map((w) => "«" + w + "»").join(", ") +
      " — перечитай эти места; если нельзя прочитать надёжно, не включай их");

  const blocks = c.sections.flatMap((s) => s.blocks);
  const mainChars = c.sections.reduce((n, s) => n + s.heading.length + s.blocks.reduce((m, b) => m + blockTexts(b).join(" ").length, 0), 0);
  const budget = LIMITS.mainBase + LIMITS.mainPerPage * Math.max(1, pageCount);
  if (mainChars > budget)
    issues.push("основная часть слишком длинная (" + mainChars + " символов, ориентир до ~" + budget + "): это пересказ, а нужен конспект — сократи вдвое, оставь главное");

  const longPar = blocks.filter((b) => ["PARAGRAPH", "IMPORTANT", "MAIN_IDEA", "EXAMPLE"].includes(b.type as string) && String(b.text).length > LIMITS.paragraph).length;
  if (longPar) issues.push("длинные абзацы (" + longPar + "): абзац — 1–3 коротких предложения своими словами, без переписывания учебника");

  const longDef = blocks.filter((b) => b.type === "DEFINITION" && String(b.text).length > LIMITS.definition).length;
  if (longDef) issues.push("определения внутри текста слишком длинные (" + longDef + "): определение — одно предложение; термины описывай в glossary.terms");
  const manyDef = c.sections.filter((s) => s.blocks.filter((b) => b.type === "DEFINITION").length > 1).length;
  if (manyDef) issues.push("в разделе больше одного DEFINITION: в тексте отмечай термины [t:…], а определения давай в glossary.terms");

  const forbidden = blocks.filter((b) => FORBIDDEN_IN_SECTIONS.includes(b.type as string)).length;
  if (forbidden) issues.push("в основной части есть блоки REMEMBER/CONCLUSION — они запрещены; «Важно» — только в remember, вывод — только в conclusion");

  const accents = blocks.filter((b) => b.type === "IMPORTANT" || b.type === "MAIN_IDEA").length;
  if (accents > LIMITS.accents) issues.push("слишком много блоков IMPORTANT/MAIN_IDEA (" + accents + "), допустимо не больше одного");

  const seen = new Set<string>();
  const dupTerms: string[] = [];
  c.glossary.terms.forEach((t) => {
    const k = normTerm(t.term);
    if (seen.has(k)) dupTerms.push(t.term);
    seen.add(k);
  });
  const defSeen = new Set<string>();
  blocks.filter((b) => b.type === "DEFINITION").forEach((b) => {
    const k = normTerm(String(b.term));
    if (defSeen.has(k)) dupTerms.push(String(b.term));
    defSeen.add(k);
  });
  if (dupTerms.length) issues.push("термины повторяются: " + [...new Set(dupTerms)].map((t) => "«" + t + "»").join(", ") + " — каждый термин один раз");

  const longTermDef = c.glossary.terms.filter((t) => t.definition.length > LIMITS.termDefinition).length;
  if (longTermDef) issues.push("определения в glossary.terms слишком длинные (" + longTermDef + "): одно короткое точное предложение");

  if (c.remember.length > LIMITS.remember || c.remember.some((r) => r.length > LIMITS.rememberItem))
    issues.push("remember («Важно») — только 1–3 коротких акцента по одному предложению, без пересказа материала");
  if (c.conclusion.length > LIMITS.conclusion) issues.push("вывод слишком длинный: 1–3 предложения");
  if (c.selfCheck.length > LIMITS.selfCheck || c.selfCheck.some((x) => x.a.length > LIMITS.answer))
    issues.push("вопросы и ответы: 3–5 вопросов, ответы короткие (1–2 предложения)");

  return issues;
}

// предложения внутри текста; разметка [t:…] не разрывается
const splitSentences = (s: string) => s.split(/(?<=[.!?…])\s+(?=[«"(\[*A-ZА-ЯЁ0-9])/u);
const isBroken = (s: string) => mixedScriptWords(s).length > 0;

/** Удаляет из текста только предложения с явно повреждёнными словами. Пустая строка — если не осталось ничего. */
function dropBrokenSentences(text: string): string {
  if (!isBroken(text)) return text;
  return splitSentences(text).filter((s) => !isBroken(s)).join(" ").trim();
}

/**
 * Консервативная чистка после финальной попытки: убирает дубли терминов, лишние пункты «Важно»,
 * запрещённые блоки и фрагменты с явно повреждёнными словами (минимальной единицей: предложение,
 * пункт списка, термин, вопрос). Ничего не переписывает и не угадывает.
 * Возвращает очищенный content и технический отчёт для лога (в конспект он не попадает).
 */
export function sanitize(c: StudyContent): { content: StudyContent; report: string[] } {
  const report: string[] = [];
  const out: StudyContent = JSON.parse(JSON.stringify(c));
  const brokenBefore = allTexts(out).flatMap(mixedScriptWords);

  // основная часть
  const defSeen = new Set<string>();
  out.sections = out.sections
    .map((s) => {
      const blocks = s.blocks
        .filter((b) => {
          if (FORBIDDEN_IN_SECTIONS.includes(b.type as string)) {
            report.push("убран блок " + b.type);
            return false;
          }
          if (b.type === "DEFINITION") {
            const k = normTerm(String(b.term));
            if (defSeen.has(k) || isBroken(String(b.term))) return report.push("убран DEFINITION «" + b.term + "»"), false;
            defSeen.add(k);
          }
          return true;
        })
        .map((b) => cleanBlock(b))
        .filter((b): b is Obj => !!b);
      return { ...s, heading: isBroken(s.heading) ? "" : s.heading, blocks };
    })
    .filter((s) => s.heading || s.blocks.length);

  // справочные блоки: минимальная единица — один пункт
  const termSeen = new Set<string>();
  out.glossary.terms = out.glossary.terms.filter((t) => {
    const k = normTerm(t.term);
    if (termSeen.has(k)) return report.push("дубль термина «" + t.term + "»"), false;
    termSeen.add(k);
    return !isBroken(t.term + " " + t.definition);
  });
  out.glossary.people = out.glossary.people.filter((p) => !isBroken(p.name + " " + p.role));
  out.glossary.dates = out.glossary.dates.filter((d) => !isBroken(d.date + " " + d.event));
  out.remember = out.remember.filter((r) => !isBroken(r) && r.length <= LIMITS.rememberItem * 1.5).slice(0, LIMITS.remember);
  if (out.remember.length < c.remember.length) report.push("«Важно»: " + c.remember.length + " → " + out.remember.length);
  out.conclusion = dropBrokenSentences(out.conclusion);
  out.selfCheck = out.selfCheck.filter((x) => !isBroken(x.q + " " + x.a)).slice(0, LIMITS.selfCheck);
  out.warnings = out.warnings.filter((w) => !isBroken(w));

  // заголовок и метаданные: повреждённое не показываем
  if (isBroken(out.meta.title)) out.meta.title = out.meta.paragraph && !isBroken(out.meta.paragraph) ? out.meta.paragraph : "Конспект";
  if (isBroken(out.meta.topic)) out.meta.topic = "";
  if (isBroken(out.meta.summary)) out.meta.summary = "";
  out.meta.tagline = out.meta.tagline.filter((t) => !isBroken(t));

  if (brokenBefore.length) report.push("убраны фрагменты с повреждёнными словами: " + [...new Set(brokenBefore)].join(", "));
  return { content: out, report };
}

/** Чистит текстовые поля блока от повреждённых предложений/пунктов; null — если блок опустел. */
function cleanBlock(b: Obj): Obj | null {
  const s = (v: Json) => dropBrokenSentences(String(v ?? ""));
  const items = (v: Json) => (Array.isArray(v) ? (v as string[]).filter((x) => !isBroken(String(x))) : []);
  const out: Obj = { ...b };
  switch (b.type) {
    case "PARAGRAPH":
    case "MAIN_IDEA":
    case "IMPORTANT":
    case "EXAMPLE":
      out.text = s(b.text);
      return out.text ? out : null;
    case "DEFINITION":
      out.text = s(b.text);
      return out.text ? out : null;
    case "DATE":
    case "PERSON":
    case "EVENT":
      if (isBroken(blockTexts(b).join(" "))) return null;
      return out;
    case "CAUSE_EFFECT":
      out.causes = items(b.causes);
      out.effects = items(b.effects);
      return (out.causes as string[]).length || (out.effects as string[]).length ? out : null;
    case "FORMULA":
      out.text = s(b.text);
      return out;
    case "PROCESS":
      out.steps = items(b.steps);
      if (isBroken(String(b.title ?? ""))) out.title = "";
      return (out.steps as string[]).length ? out : null;
    case "LIST":
      out.items = items(b.items);
      if (isBroken(String(b.title ?? ""))) out.title = "";
      return (out.items as string[]).length ? out : null;
    case "SEQUENCE":
      out.items = (b.items as Obj[]).filter((x) => !isBroken(String(x.label) + " " + String(x.text)));
      return (out.items as Obj[]).length ? out : null;
    case "TABLE":
      out.rows = (b.rows as string[][]).filter((r) => !isBroken(r.join(" ")));
      return (out.rows as string[][]).length && !isBroken((b.headers as string[]).join(" ")) ? out : null;
  }
  return out;
}
