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
