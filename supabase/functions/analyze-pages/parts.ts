/**
 * Эксперимент «8 фотографий»: генерация по частям.
 *
 * Почему: GigaChat (тариф физлица) принимает фото в Files API строго по одному (2,8 с на страницу сейчас, до 12 с
 * в плохие дни), а ответ на 4 страницы занимает ~50 с. 8 страниц одним запросом — ~25–95 с загрузки + 80–100 с ответа:
 * больше лимита вызова GigaChat (100 с) и бюджета функции (140 с при лимите Supabase 150 с). Так и падали прошлые
 * попытки на 7–8 страниц.
 *
 * Как: до SINGLE_MAX страниц — как раньше, одним запросом. Больше — части не больше PART_MAX фото
 * (5 → 3+2, 6 → 3+3, 7 → 3+2+2, 8 → 3+3+2), каждая в своём вызове функции со своим бюджетом времени: 4 фото одним
 * запросом GigaChat однажды не ответил и за 138 с (07.11.2026), 3 фото — 42–53 с. Первая часть идёт в вызове
 * пользователя; результат готовых частей передаётся в следующий вызов в теле запроса, подписанного ключом сервера
 * (HMAC-SHA256): подделать продолжение или пропустить проверку доступа снаружи нельзя. Следующая часть получает
 * оглавление и термины готовых (чтобы не повторяться и продолжить пункт, разорванный между страницами) и сразу
 * объединяется с ними. Часть, на которую модель не ответила (тайм-аут, сеть), один раз за генерацию повторяется
 * в новом вызове функции — со своим полным бюджетом времени.
 *
 * Квота: резерв генерации делается один раз — при запуске (op = note_id), итог фиксирует триггер на notes.status,
 * как и раньше. Части — внутреннее устройство одной генерации: вторая часть start_text_generation_v2 не вызывает.
 */

import type { StudyContent } from "./study-content.ts";
import { plain } from "./study-content.ts";

/** до стольких страниц — один запрос (прежнее поведение) */
export const SINGLE_MAX = 4;
/** больше SINGLE_MAX страниц — части не больше стольких фото */
export const PART_MAX = 3;
/** ожидание ответа модели на одну часть (вызов провайдера целиком: вход, загрузка фото, ответ) */
export const PART_CALL_MS = 90_000;
/** подпись продолжения действует столько (вторая часть стартует сразу после первой) */
export const CONTINUATION_TTL_MS = 10 * 60_000;

// ---------- повтор части после тайм-аута и общий бюджет генерации (v66.3) ----------
//
// 07.11.2026 (v29): часть из 3 фото дважды не дождалась ответа GigaChat за 90 с (chat 87 с), повтор получил те же 90 с.
// Теперь повтор получает больше времени (PART_RETRY_CALL_MS) и меньше фото: часть из 2–3 фото делится пополам
// (3 → 2+1, 2 → 1+1). Повторов не больше MAX_PART_RETRIES за генерацию; новый вызов не начинается, если вместе с
// оставшимися частями он заведомо не уложится в GEN_BUDGET_MS (клиент ждёт дольше — см. WAIT_LONG_MS в js/cloud.js).

/** ожидание ответа модели при повторе части (новый вызов функции: бюджет 140 с минус чтение фото и передача) */
export const PART_RETRY_CALL_MS = 120_000;
/** повторов частей за одну генерацию не больше этого (бесконечных повторов нет) */
export const MAX_PART_RETRIES = 2;
/**
 * вся генерация по частям: новый вызов начинается, только если по оценке закончится до этого срока. Оценка вызова —
 * partCapMs + CALL_OVERHEAD_MS; если вызов затянется (повтор по качеству внутри вызова), его всё равно оборвёт лимит
 * Supabase 150 с, поэтому итог записан не позже ~GEN_BUDGET_MS − PART_CALL_MS − CALL_OVERHEAD_MS + 150 с ≈ 10 мин 45 с
 * от запуска. Клиент ждёт 12 мин (WAIT_LONG_MS в js/cloud.js) — дольше сервера.
 */
export const GEN_BUDGET_MS = 10 * 60_000;
/** сверх ожидания модели на вызов функции: запуск, чтение фото, вход, загрузка в GigaChat, передача следующей части */
export const CALL_OVERHEAD_MS = 15_000;
/** самая быстрая часть, которую видели (3 фото: 45–49 с с загрузкой) — меньше на часть не закладываем */
export const MIN_PART_MS = 45_000;

/** Часть плана: страницы [from, to); long — повтор после тайм-аута, ожидание модели PART_RETRY_CALL_MS. */
export type Part = { from: number; to: number; long?: boolean };

/** План частей для n страниц (как splitPages). */
export const planFor = (n: number): Part[] => splitPages(n).map(([from, to]) => ({ from, to }));

/** Сколько ждать ответа модели на эту часть. */
export const partCapMs = (p: Part) => (p.long ? PART_RETRY_CALL_MS : PART_CALL_MS);

/** Описание плана для лога: «3+3+2», повторные части — со звёздочкой: «2*+1*+3+2». */
export const planLabel = (plan: Part[]) => plan.map((p) => p.to - p.from + (p.long ? "*" : "")).join("+");

/**
 * Уложится ли генерация, если сейчас начать часть i: её вызов в худшем случае + самые быстрые оставшиеся части.
 * elapsedMs — сколько уже идёт генерация (с запуска пользователем).
 */
export function fitsGeneration(elapsedMs: number, plan: Part[], i: number): boolean {
  if (!plan[i]) return false;
  return elapsedMs + partCapMs(plan[i]) + CALL_OVERHEAD_MS + MIN_PART_MS * (plan.length - i - 1) <= GEN_BUDGET_MS;
}

/**
 * Новый план после того, как модель не ответила на часть i (code — AI_TIMEOUT или AI_NETWORK), или null — повторять
 * бессмысленно. Тайм-аут части из 2–3 фото → она делится пополам (3 → 2+1, 2 → 1+1): страницы те же, по порядку, каждая
 * ровно в одной части. Тайм-аут одного фото → тот же запрос с долгим ожиданием, но только если его ещё не было.
 * Сетевая ошибка → та же часть с долгим ожиданием. Готовые части (до i) не меняются.
 */
export function retryPlan(plan: Part[], i: number, code: string): Part[] | null {
  const p = plan[i];
  if (!p) return null;
  const size = p.to - p.from;
  let repl: Part[];
  if (code === "AI_TIMEOUT" && size >= 2) {
    const mid = p.from + Math.ceil(size / 2);
    repl = [{ from: p.from, to: mid, long: true }, { from: mid, to: p.to, long: true }];
  } else if (code === "AI_TIMEOUT" && p.long) return null; // одно фото уже ждали дольше всего
  else repl = [{ from: p.from, to: p.to, long: true }];
  return [...plan.slice(0, i), ...repl, ...plan.slice(i + 1)];
}

/** План из подписанного продолжения: части подряд от 0 до n, в каждой 1…PART_MAX страниц, частей 2…n. */
export function validPlan(plan: unknown, n: number): plan is Part[] {
  if (!Array.isArray(plan) || plan.length < 2 || plan.length > n) return false;
  let at = 0;
  for (const p of plan) {
    if (!p || typeof p !== "object" || !Number.isInteger(p.from) || !Number.isInteger(p.to)) return false;
    if (p.from !== at || p.to - p.from < 1 || p.to - p.from > PART_MAX || (p.long !== undefined && typeof p.long !== "boolean")) return false;
    at = p.to;
  }
  return at === n;
}

/** Границы частей: [начало, конец) по индексам страниц. Части почти равные, большие — первыми. */
export function splitPages(n: number): [number, number][] {
  if (n <= SINGLE_MAX) return [[0, n]];
  const k = Math.ceil(n / PART_MAX);
  const base = Math.floor(n / k), extra = n % k;
  const out: [number, number][] = [];
  for (let i = 0, from = 0; i < k; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push([from, from + size]);
    from += size;
  }
  return out;
}

/** Промпт части: какие это страницы всей темы и (для второй части) что уже есть в первой. */
export function partPrompt(base: string, part: number, parts: number, from: number, to: number, total: number, ctx?: PartContext): string {
  const head = `Это часть ${part + 1} из ${parts} одной темы: страницы ${from + 1}–${to} из ${total}. ` +
    (part === 0
      ? "Сделай конспект только этих страниц. Продолжение темы обработается отдельно и будет добавлено после твоего конспекта; " +
        "\"conclusion\" и \"selfCheck\" — только по этим страницам.\n"
      : (part === 1 ? "Первая часть" : "Предыдущие части") + " темы (страницы 1–" + from + ") уже законспектирован" + (part === 1 ? "а" : "ы") +
        " — не повторяй их содержание.\n" +
        (ctx?.title ? `Название темы: «${ctx.title}» — повтори его в "meta.title".\n` : "") +
        (ctx?.headings.length ? "Разделы готовых частей: " + ctx.headings.map((h) => "«" + h + "»").join(", ") + ".\n" : "") +
        (ctx?.lastHeading
          ? `Если первая фотография продолжает пункт «${ctx.lastHeading}», начни с раздела с ТОЧНО таким же заголовком и пиши только продолжение; ` +
            "новые пункты учебника — новыми разделами.\n"
          : "") +
        (ctx?.terms.length ? "Термины готовых частей (в glossary.terms их не повторяй): " + ctx.terms.join(", ") + ".\n" : "") +
        (part === parts - 1
          ? "\"conclusion\" — итог ВСЕЙ темы (с учётом готовых частей) в 2–5 предложениях; \"selfCheck\" — только по этим страницам.\n"
          : "Продолжение темы обработается отдельно; \"conclusion\" и \"selfCheck\" — только по этим страницам.\n"));
  return head + "\n" + base;
}

export type PartContext = { title: string; headings: string[]; lastHeading: string; terms: string[] };

/** Что следующей части нужно знать о готовых (без самого текста конспекта). */
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
    // последняя часть пишет итог всей темы (см. partPrompt); если его нет — итог готовых частей
    conclusion: b.conclusion || a.conclusion,
    selfCheck: uniqBy([...a.selfCheck, ...b.selfCheck], (x) => key(x.q)).slice(0, 12),
    warnings: uniqBy([...a.warnings, ...b.warnings], key).slice(0, 10),
  };
}

// ---------- подпись продолжения ----------

/** Расход всех вызовов генерации (для одной строки ai_generations): токены, время, попытки, модель. */
export type Usage = { input: number; output: number; ms: number; attempts: number; model: string; provider: string };

export type Continuation = {
  note_id: string;
  user_id: string;
  paths: string[];
  /** notes.updated_at, записанный при передаче: продолжение действует только для этого состояния note */
  handoff_at: string;
  exp: number;
  /** план частей (после повтора с делением — изменённый); part — индекс в нём */
  plan: Part[];
  /** какую часть плана (с 0) обрабатывать */
  part: number;
  /** сколько повторов частей уже было в этой генерации (не больше MAX_PART_RETRIES) */
  retries: number;
  /** когда генерацию запустил пользователь (мс, часы сервера) — для общего бюджета GEN_BUDGET_MS */
  t0: number;
  /** объединённый конспект готовых частей (null — готовых частей нет: повтор первой) */
  prev: StudyContent | null;
  /** расход всех предыдущих вызовов */
  acc: Usage;
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
