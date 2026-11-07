/**
 * Эксперимент «8 фотографий»: генерация по частям.
 *
 * Почему: GigaChat (тариф физлица) принимает фото в Files API строго по одному (2,8 с на страницу сейчас, до 12 с
 * в плохие дни), а ответ на 4 страницы занимает ~50 с. 8 страниц одним запросом — ~25–95 с загрузки + 80–100 с ответа:
 * больше лимита вызова GigaChat (100 с) и бюджета функции (140 с при лимите Supabase 150 с). Так и падали прошлые
 * попытки на 7–8 страниц.
 *
 * Как: до SINGLE_MAX страниц — как раньше, одним запросом. Больше — две части (5 → 3+2, 6 → 3+3, 7 → 4+3, 8 → 4+4),
 * каждая в своём вызове функции со своим бюджетом времени. Первая часть идёт в вызове пользователя; её результат
 * передаётся во второй вызов в теле запроса, подписанного ключом сервера (HMAC-SHA256): подделать продолжение или
 * пропустить проверку доступа снаружи нельзя. Вторая часть получает оглавление первой (чтобы не повторяться и
 * продолжить пункт, разорванный между страницами), потом части объединяются в один конспект.
 *
 * Квота: резерв генерации делается один раз — при запуске (op = note_id), итог фиксирует триггер на notes.status,
 * как и раньше. Части — внутреннее устройство одной генерации: вторая часть start_text_generation_v2 не вызывает.
 */

import type { StudyContent } from "./study-content.ts";
import { plain } from "./study-content.ts";

/** до стольких страниц — один запрос (прежнее поведение) */
export const SINGLE_MAX = 4;
/** подпись продолжения действует столько (вторая часть стартует сразу после первой) */
export const CONTINUATION_TTL_MS = 10 * 60_000;

/** Границы частей: [начало, конец) по индексам страниц. */
export function splitPages(n: number): [number, number][] {
  if (n <= SINGLE_MAX) return [[0, n]];
  const first = Math.ceil(n / 2);
  return [[0, first], [first, n]];
}

/** Промпт части: какие это страницы всей темы и (для второй части) что уже есть в первой. */
export function partPrompt(base: string, part: number, parts: number, from: number, to: number, total: number, ctx?: PartContext): string {
  const head = `Это часть ${part + 1} из ${parts} одной темы: страницы ${from + 1}–${to} из ${total}. ` +
    (part === 0
      ? "Сделай конспект только этих страниц. Продолжение темы обработается отдельно и будет добавлено после твоего конспекта; " +
        "\"conclusion\" и \"selfCheck\" — только по этим страницам.\n"
      : "Первая часть темы (страницы 1–" + from + ") уже законспектирована — не повторяй её содержание.\n" +
        (ctx?.title ? `Название темы: «${ctx.title}» — повтори его в "meta.title".\n` : "") +
        (ctx?.headings.length ? "Разделы первой части: " + ctx.headings.map((h) => "«" + h + "»").join(", ") + ".\n" : "") +
        (ctx?.lastHeading
          ? `Если первая фотография продолжает пункт «${ctx.lastHeading}», начни с раздела с ТОЧНО таким же заголовком и пиши только продолжение; ` +
            "новые пункты учебника — новыми разделами.\n"
          : "") +
        (ctx?.terms.length ? "Термины первой части (в glossary.terms их не повторяй): " + ctx.terms.join(", ") + ".\n" : "") +
        "\"conclusion\" — итог ВСЕЙ темы (с учётом первой части) в 2–5 предложениях; \"selfCheck\" — только по этим страницам.\n");
  return head + "\n" + base;
}

export type PartContext = { title: string; headings: string[]; lastHeading: string; terms: string[] };

/** Что второй части нужно знать о первой (без самого текста конспекта). */
export function contextOf(a: StudyContent): PartContext {
  const headings = a.sections.map((s) => plain(s.heading)).filter(Boolean).slice(0, 30);
  return {
    title: plain(a.meta.title),
    headings,
    lastHeading: headings[headings.length - 1] || "",
    terms: a.glossary.terms.map((t) => plain(t.term)).filter(Boolean).slice(0, 40),
  };
}

const key = (s: string) => plain(s).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
function uniqBy<T>(items: T[], k: (x: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const v = k(x);
    if (!v || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

/**
 * Объединяет конспекты двух частей в один: разделы по порядку (раздел, продолженный во второй части с тем же
 * заголовком, склеивается), справочные блоки без повторов, страницы — по порядку всей темы. Текст не меняется.
 */
export function mergeParts(a: StudyContent, b: StudyContent): StudyContent {
  const offset = a.meta.pages.length;
  type Blk = StudyContent["sections"][number]["blocks"][number];
  // номер страницы у блоков второй части — в нумерации всей темы
  const shift = (blk: Blk): Blk => (typeof blk.sourcePage === "number" ? { ...blk, sourcePage: blk.sourcePage + offset } : { ...blk });
  const sections: { heading: string; blocks: Blk[] }[] = a.sections.map((s) => ({ heading: s.heading, blocks: s.blocks.map((x) => ({ ...x })) }));
  for (const s of b.sections) {
    const last = sections[sections.length - 1];
    // пункт, начатый на последней странице первой части и продолженный во второй, — один раздел
    if (last && s.heading && key(last.heading) === key(s.heading)) last.blocks.push(...s.blocks.map(shift));
    else sections.push({ heading: s.heading, blocks: s.blocks.map(shift) });
  }
  const renum = sections.map((s, si) => ({ id: "s" + si, heading: s.heading, blocks: s.blocks.map((blk, bi) => ({ ...blk, id: si + "-" + bi })) }));
  const ids = <T extends { id: string }>(xs: T[], p: string) => xs.map((x, i) => ({ ...x, id: p + i }));
  const g = (k: keyof StudyContent["glossary"]) => [...a.glossary[k], ...b.glossary[k]] as never[];
  return {
    schemaVersion: 1,
    meta: {
      ...a.meta,
      title: a.meta.title !== "Конспект" ? a.meta.title : b.meta.title,
      subject: a.meta.subject !== "other" ? a.meta.subject : b.meta.subject,
      subjectLabel: a.meta.subject !== "other" ? a.meta.subjectLabel : b.meta.subjectLabel,
      topic: a.meta.topic || b.meta.topic,
      paragraph: a.meta.paragraph || b.meta.paragraph,
      tagline: uniqBy([...a.meta.tagline, ...b.meta.tagline], key).slice(0, 4),
      summary: a.meta.summary || b.meta.summary,
      pages: [...a.meta.pages, ...b.meta.pages.map((p) => ({ ...p, index: p.index + offset }))],
      sourceOutline: uniqBy([...a.meta.sourceOutline, ...b.meta.sourceOutline], key).slice(0, 30),
    },
    lead: a.lead || b.lead,
    sections: renum as StudyContent["sections"],
    glossary: {
      terms: ids(uniqBy(g("terms") as StudyContent["glossary"]["terms"], (x) => key(x.term)), "t"),
      dates: ids(uniqBy(g("dates") as StudyContent["glossary"]["dates"], (x) => key(x.date + " " + x.event)), "d"),
      people: ids(uniqBy(g("people") as StudyContent["glossary"]["people"], (x) => key(x.name)), "p"),
      formulas: ids(uniqBy(g("formulas") as StudyContent["glossary"]["formulas"], (x) => key(x.expression)), "f"),
    },
    remember: uniqBy([...a.remember, ...b.remember], key).slice(0, 8),
    // вторая часть писала итог всей темы (см. partPrompt); если его нет — итог первой части
    conclusion: b.conclusion || a.conclusion,
    selfCheck: uniqBy([...a.selfCheck, ...b.selfCheck], (x) => key(x.q)).slice(0, 12),
    warnings: uniqBy([...a.warnings, ...b.warnings], key).slice(0, 10),
  };
}

// ---------- подпись продолжения ----------

export type Continuation = {
  note_id: string;
  user_id: string;
  paths: string[];
  /** notes.updated_at, записанный при передаче: продолжение действует только для этого состояния note */
  handoff_at: string;
  exp: number;
  /** результат первой части и её расход (для одной строки ai_generations на всю генерацию) */
  part1: { content: StudyContent; input: number; output: number; model: string; provider: string; ms: number; attempts: number };
};

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode("analyze-pages/continuation/v1:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function signContinuation(secret: string, c: Continuation): Promise<{ payload: string; sig: string }> {
  const payload = JSON.stringify(c);
  return { payload, sig: await hmac(secret, payload) };
}

/** Проверка подписи (сравнение за постоянное время) и срока. null — продолжение не принимается. */
export async function verifyContinuation(secret: string, payload: unknown, sig: unknown, now = Date.now()): Promise<Continuation | null> {
  if (!secret || typeof payload !== "string" || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig) || payload.length > 400_000) return null;
  const want = await hmac(secret, payload);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  let c: Continuation;
  try {
    c = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!c || typeof c.exp !== "number" || c.exp < now || c.exp > now + CONTINUATION_TTL_MS + 60_000) return null;
  return c;
}
