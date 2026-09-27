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
 *  - meta.pages приводится к фактическому числу загруженных страниц;
 *  - незакрытая разметка ([t:… без «]», непарные **) удаляется, чтобы renderer не показал её как текст;
 *  - meta.format = "classic-2": конспект создан по правилам нового формата (структура по пунктам учебника,
 *    см. prompt.ts). Старые конспекты без этого поля отображаются как раньше.
 */

export const SCHEMA_VERSION = 1;
export const NOTE_FORMAT = "classic-2";

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
const TITLED = ["IMPORTANT", "MAIN_IDEA", "EXAMPLE", "CONCLUSION"];
const MAX_ITEMS = 60;
const MAX_SECTIONS = 30;
const MAX_BLOCKS = 60;

type Json = unknown;
type Obj = Record<string, Json>;

// HTML-теги и управляющие символы убираются; разметка **…** и [d:…] остаётся — её понимает renderer
const clean = (s: string) =>
  fixMarkup(
    s
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // deno-lint-ignore no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim()
      .slice(0, MAX_STR),
  ).trim();

/** Убирает только сломанную разметку: пустые и незакрытые метки [t:…], непарные **. Текст не меняется. */
export function fixMarkup(s: string): string {
  let out = s.replace(/\[(?:t|d|p|f):\s*\]/g, "").replace(/\*\*\s*\*\*/g, "");
  // «[t:» без закрывающей «]» до конца строки
  out = out.replace(/\[(?:t|d|p|f):(?![^\]\n]*\])/g, "");
  if ((out.match(/\*\*/g) || []).length % 2) out = out.replace(/\*\*/g, "");
  return out;
}

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
  // заголовок смысловой карточки («От чего зависит…», «Результат реформы»); необязателен
  if (TITLED.includes(type) && str(b.title)) out.title = str(b.title).slice(0, 120);
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
    format: typeof NOTE_FORMAT;
    /** заголовки основных пунктов учебника, как их выписала модель (для проверки структуры) */
    sourceOutline: string[];
  };
  /** «Главное» перед первым разделом (classic-2); пустая строка — карточки нет */
  lead: string;
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
      format: NOTE_FORMAT,
      sourceOutline: strs(m.sourceOutline).slice(0, MAX_SECTIONS),
    },
    lead: str(r.lead),
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
// qualityIssues() находит нарушения формата Classic Note (classic-2): разделы не совпадают с пунктами учебника,
// слишком короткий или почти дословный текст, нет смысловых выделений или их перебор, дубли, лишние блоки,
// личности и даты, которых нет в тексте, артефакты распознавания. По этому списку делается один повторный
// запрос к модели. Пороги длины — мягкие ориентиры: превышение не делает ответ невалидным.
// sanitize() после финальной попытки только убирает явно лишнее и повреждённое — текст никогда не
// «исправляется» и буквы не заменяются.

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

/** Текст без разметки: «[t:диффузия]» → «диффузия», «**газы**» → «газы». */
export const plain = (s: string) => String(s || "").replace(/\*\*/g, "").replace(/\[(?:t|d|p|f):([^\]\n]+?)\]/g, "$1");
const MARKER = /\[(?:t|d|p|f):[^\]\n]+?\]|\*\*[^*\n]+?\*\*/g;
const BOLD = /\*\*([^*\n]+?)\*\*/g;

// Мягкие ориентиры формата (по старым PWA «Физика 8» / «История 8»), не жёсткие лимиты
const LIMITS = {
  minPerPage: 300, // знаков основного текста на читаемую страницу — ниже почти наверняка выброшено важное
  maxPerPage: 3000, // выше — похоже на дословное переписывание учебника
  maxBase: 800,
  paragraph: 1100,
  highlightFrom: 500, // с какого объёма текста отсутствие выделений считается проблемой
  boldShare: 0.3, // доля жирного в основном тексте
  boldPhrase: 160, // одна жирная «фраза» длиннее — выделено целое предложение
  termDefinition: 300,
  remember: 7,
  rememberItem: 260,
  conclusion: 600,
  selfCheck: 12,
  answer: 500,
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
  const t: string[] = [c.meta.title, c.meta.topic, c.meta.summary, ...c.meta.tagline, c.lead];
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

/** Тексты основной части (разделы; заголовки разделов не считаются). */
const mainTexts = (c: StudyContent) => c.sections.flatMap((s) => s.blocks.flatMap(blockTexts));

/** Заголовок пункта для сравнения: без номера «1.», «§ 2», регистра и знаков. */
const normHeading = (s: string) =>
  normTerm(plain(s)).replace(/^(?:§\s*)?\d+(?:[.)]\d*)*\s*/, "").replace(/^(?:пункт|п)\s+\d+\s*/, "").trim();

const stem = (w: string) => w.slice(0, Math.min(6, Math.max(4, w.length - 2)));
const words = (s: string) => normTerm(plain(s)).split(" ").filter((w) => w.length >= 4);

/** Встречается ли имя/термин в тексте (по основам слов — падежи не мешают). */
function mentioned(name: string, haystack: string): boolean {
  const ws = words(name);
  if (!ws.length) return true; // короткие обозначения (I, XV, pH) не проверяем
  return ws.some((w) => haystack.includes(stem(w)));
}

/** Встречается ли дата в тексте: по числам из неё («1709 г.», «1770–1774 гг.», «XVIII в.»). */
function dateMentioned(date: string, haystack: string): boolean {
  const nums = plain(date).match(/\d{2,}/g);
  if (nums?.length) return nums.some((n) => haystack.includes(n));
  return mentioned(date, haystack);
}

/** Текст, в котором ищем упоминания личностей, дат и терминов: основная часть и «Главное». */
const referenceText = (c: StudyContent) => normTerm(plain([c.lead, ...c.sections.map((s) => s.heading), ...mainTexts(c)].join(" "))) +
  " " + plain([c.lead, ...mainTexts(c)].join(" "));

/** Нарушения формата — короткие фразы по-русски, их же получает модель при повторе. */
export function qualityIssues(c: StudyContent, pageCount: number): string[] {
  const issues: string[] = [];

  const broken = [...new Set(allTexts(c).flatMap(mixedScriptWords))];
  if (broken.length)
    issues.push("слова со смесью латиницы и кириллицы (ошибка чтения): " + broken.slice(0, 8).map((w) => "«" + w + "»").join(", ") +
      " — перечитай эти места; если нельзя прочитать надёжно, не включай их");

  // структура: разделы = пункты учебника, в том же порядке
  const outline = c.meta.sourceOutline;
  if (outline.length) {
    if (c.sections.length !== outline.length)
      issues.push("разделов " + c.sections.length + ", а пунктов учебника в meta.sourceOutline " + outline.length +
        ": разделы должны точно совпадать с пунктами учебника — не дроби, не объединяй и не добавляй разделы");
    else {
      const wrong = c.sections.map((s, i) => [s.heading, outline[i]]).filter(([h, o]) => normHeading(h) !== normHeading(o));
      if (wrong.length)
        issues.push("заголовки или порядок разделов не совпадают с пунктами учебника: " +
          wrong.slice(0, 3).map(([h, o]) => "«" + plain(h) + "» вместо «" + plain(o) + "»").join(", ") + " — заголовок раздела пиши дословно, как в учебнике");
    }
  } else if (c.sections.length > 1) {
    issues.push("не заполнен meta.sourceOutline — выпиши дословно заголовки основных пунктов учебника с фотографий, разделы должны им соответствовать");
  }

  // объём — мягкие ориентиры по числу читаемых страниц
  const main = mainTexts(c);
  const mainPlain = plain(main.join(" "));
  const mainChars = mainPlain.length;
  const readable = Math.max(1, c.meta.pages.filter((p) => p.readable !== "unreadable").length || pageCount);
  if (mainChars < LIMITS.minPerPage * readable)
    issues.push("основной текст очень короткий (" + mainChars + " знаков на " + readable + " стр.): сохрани все существенные мысли каждого пункта учебника — определения, объяснения, причины, перечисления, примеры; убирай только воду и повторы");
  else if (mainChars > LIMITS.maxBase + LIMITS.maxPerPage * readable)
    issues.push("основной текст слишком длинный (" + mainChars + " знаков): похоже на дословную копию учебника — пиши своими словами, убери воду и повторы, но сохрани все существенные мысли");

  const blocks = c.sections.flatMap((s) => s.blocks);
  const longPar = blocks.filter((b) => ["PARAGRAPH", "IMPORTANT", "MAIN_IDEA", "EXAMPLE"].includes(b.type as string) && plain(String(b.text)).length > LIMITS.paragraph).length;
  if (longPar) issues.push("очень длинные абзацы (" + longPar + "): раздели их по смыслу, не переписывай учебник подряд");

  // смысловые выделения: их полное отсутствие в большом тексте и явный перебор
  const markers = main.join(" ").match(MARKER) || [];
  if (mainChars >= LIMITS.highlightFrom && !markers.length)
    issues.push("в основном тексте нет смысловых выделений: отметь настоящие термины [t:…], даты [d:…], личности [p:…], формулы [f:…] и **ключевые мысли** — только там, где это действительно важно");
  const bold = [...main.join(" ").matchAll(BOLD)].map((m) => m[1]);
  const boldChars = bold.reduce((n, b) => n + b.length, 0);
  if (mainChars >= 300 && boldChars > LIMITS.boldShare * mainChars)
    issues.push("слишком много жирного текста (" + Math.round((100 * boldChars) / mainChars) + "% основного текста): выделяй только ключевые слова и короткие фразы");
  else if (bold.some((b) => b.length > LIMITS.boldPhrase))
    issues.push("жирным выделены целые предложения: выделяй только ключевые слова и короткие фразы");

  const forbidden = blocks.filter((b) => FORBIDDEN_IN_SECTIONS.includes(b.type as string)).length;
  if (forbidden) issues.push("в основной части есть блоки REMEMBER/CONCLUSION — они запрещены; «Важно» — только в remember, вывод — только в conclusion");

  const accents = blocks.filter((b) => b.type === "IMPORTANT" || b.type === "MAIN_IDEA").length;
  if (accents > 2 * c.sections.length + 2)
    issues.push("слишком много карточек IMPORTANT (" + accents + "): карточка — для главного в пункте, остальное пиши связным текстом");

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
  if (longTermDef) issues.push("определения в glossary.terms слишком длинные (" + longTermDef + "): одно точное предложение по учебнику");

  // справочные блоки не должны содержать того, чего нет в основном тексте
  const ref = referenceText(c);
  const strayPeople = c.glossary.people.filter((p) => !mentioned(p.name, ref)).map((p) => p.name);
  const strayDates = c.glossary.dates.filter((d) => !dateMentioned(d.date, ref)).map((d) => d.date);
  if (strayPeople.length || strayDates.length)
    issues.push("в «Личностях»/«Датах» есть то, чего нет в тексте конспекта: " + [...strayPeople, ...strayDates].slice(0, 5).map((x) => "«" + x + "»").join(", ") +
      " — справочные блоки только по материалу страниц; если личностей или дат нет, оставь пустые массивы");

  if (c.remember.length > LIMITS.remember || c.remember.some((r) => r.length > LIMITS.rememberItem))
    issues.push("remember («Важно») — несколько коротких ключевых фактов, без пересказа всего материала");
  if (c.conclusion.length > LIMITS.conclusion) issues.push("вывод слишком длинный: короткий итог в 1–3 предложениях");
  const qs = c.selfCheck.map((x) => normTerm(x.q));
  if (c.selfCheck.length > LIMITS.selfCheck || c.selfCheck.some((x) => x.a.length > LIMITS.answer))
    issues.push("вопросы и ответы: только основное по материалу страниц, ответы по тексту учебника без лишнего");
  else if (new Set(qs).size < qs.length) issues.push("вопросы повторяются — каждый вопрос один раз");

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
 * Консервативная чистка после финальной попытки: убирает дубли терминов и вопросов, лишние пункты «Важно»,
 * запрещённые блоки, личности/даты/термины, которых нет в тексте конспекта, и фрагменты с явно повреждёнными
 * словами (минимальной единицей: предложение, пункт списка, термин, вопрос). Ничего не переписывает и не угадывает.
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
  out.lead = dropBrokenSentences(out.lead);

  // справочные блоки: минимальная единица — один пункт; только то, что есть в тексте конспекта
  const ref = referenceText(out);
  const termSeen = new Set<string>();
  out.glossary.terms = out.glossary.terms.filter((t) => {
    const k = normTerm(t.term);
    if (termSeen.has(k)) return report.push("дубль термина «" + t.term + "»"), false;
    termSeen.add(k);
    if (!mentioned(t.term, ref)) return report.push("термина «" + t.term + "» нет в тексте"), false;
    return !isBroken(t.term + " " + t.definition);
  });
  out.glossary.people = out.glossary.people.filter((p) => {
    if (!mentioned(p.name, ref)) return report.push("личности «" + p.name + "» нет в тексте"), false;
    return !isBroken(p.name + " " + p.role);
  });
  out.glossary.dates = out.glossary.dates.filter((d) => {
    if (!dateMentioned(d.date, ref)) return report.push("даты «" + d.date + "» нет в тексте"), false;
    return !isBroken(d.date + " " + d.event);
  });
  out.remember = out.remember.filter((r) => !isBroken(r) && r.length <= LIMITS.rememberItem * 1.5).slice(0, LIMITS.remember);
  if (out.remember.length < c.remember.length) report.push("«Важно»: " + c.remember.length + " → " + out.remember.length);
  out.conclusion = dropBrokenSentences(out.conclusion);
  const qSeen = new Set<string>();
  out.selfCheck = out.selfCheck
    .filter((x) => {
      const k = normTerm(x.q);
      if (qSeen.has(k)) return report.push("дубль вопроса"), false;
      qSeen.add(k);
      return !isBroken(x.q + " " + x.a);
    })
    .slice(0, LIMITS.selfCheck);
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
  if (typeof b.title === "string" && isBroken(b.title)) delete out.title;
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
