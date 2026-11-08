// v66 (эксперимент «8 фотографий»): analyze-pages целиком — с ИМИТАЦИЕЙ Supabase и GigaChat (настоящий ИИ и
// production не вызываются). Проверяет логику: 1–8 страниц, отказ на 9, деление на части, порядок, объединение,
// одно списание генерации, ошибки частей, повтор, подделку и повтор продолжения.
// Запуск: deno run --allow-env --allow-read --import-map=tests/v66/import_map.json tests/v66/analyze-sim.test.ts
// deno-lint-ignore-file no-explicit-any
import type { Sim } from "./stubs/supabase.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || info === undefined ? "" : " → " + JSON.stringify(info).slice(0, 500)));
};

// ---------- окружение функции ----------
const env: Record<string, string> = {
  SUPABASE_URL: "http://sim.local", SUPABASE_SERVICE_ROLE_KEY: "svc-secret-test", SUPABASE_ANON_KEY: "anon-test", GIGACHAT_AUTH_KEY: "giga-test",
};
for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
Deno.env.delete("ZAI_API_KEY");
Deno.env.delete("OPENROUTER_API_KEY");
// часы функции: сдвиг имитирует долгий ответ модели (проверка «на повтор не хватает времени»)
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow.call(Date) + skew;
// перехват лога функции (вывод сохраняется): проверяем, что диагностика безопасна
const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => (logs.push(a.map(String).join(" ")), orig(...a));
}
// таймеры функции: в тестах тайм-аута «быстрые» (90 с → 50 мс); запрошенные задержки записываются (какой предел задан)
const realSetTimeout = globalThis.setTimeout;
const timers = { fast: false, asked: [] as number[] };
// deno-lint-ignore no-explicit-any
(globalThis as any).setTimeout = (fn: () => void, ms?: number, ...a: unknown[]) => {
  timers.asked.push(Number(ms) || 0);
  return realSetTimeout(fn, timers.fast ? Math.min(Number(ms) || 0, 50) : ms, ...a);
};
let micro = 0;
const sim: Sim = {
  notes: new Map(), files: new Map(), gens: [], ledger: new Map(), starts: [], users: new Map([["tok-u1", "u1"], ["tok-u2", "u2"], ["tok-owner", "u-owner"]]),
  maxPages: 8, access: "ok", owners: new Set(["u-owner"]),
  clock: () => new Date(Date.now()).toISOString().replace("Z", String(++micro % 1000).padStart(3, "0") + "+00:00"),
};
(globalThis as any).__SIM = sim;
const bg: Promise<unknown>[] = [];
(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => bg.push(p) };
let handler: (r: Request) => Promise<Response> = () => Promise.reject(new Error("no handler"));
Object.defineProperty(Deno, "serve", { value: (h: typeof handler) => ((handler = h), {}), configurable: true, writable: true });

// ---------- имитация GigaChat ----------
type Call = { pages: number[]; prompt: string };
const sc = {
  calls: [] as Call[], uploads: 0, fileToPage: new Map<string, number>(), continuationHits: 0,
  chatFailOn: -1, continueHeading: false, selfStatus: 0, deleted: 0,
  holdContinuation: null as null | ((r: Request) => Promise<Response>),
  /** номера страниц-«титульных листов» (без текста темы) */
  titles: new Set<number>(),
  /** номера вызовов chat, на которые модель даёт короткий отказ / длинный отказ / HTTP-ошибку */
  refuse: new Set<number>(), refuseLong: new Set<number>(), chatStatus: new Map<number, number>(),
  /** на сколько мс «длится» ответ модели (сдвиг часов функции) */
  chatMs: 0,
  systems: [] as string[],
  /** номера вызовов chat, на которые модель не отвечает (висит до тайм-аута) */
  hang: new Set<number>(),
  /** v66.3, поток: вызовы, где модель шлёт два фрагмента и замолкает до тайм-аута (частичный ответ) */
  hangMid: new Set<number>(),
  /** вызовы, где поток закрывается после двух фрагментов без конца ответа */
  eof: new Set<number>(),
  /** вызовы, где в потоке приходит неразборчивый фрагмент / событие ошибки */
  badChunk: new Set<number>(), errorEvent: new Set<number>(),
  /** сервер отвечает обычным JSON даже на stream: true */
  noStream: false,
  /** запрошен ли поток в каждом вызове chat */
  streamReq: [] as boolean[],
  /** «время» до первого токена (сдвиг часов функции перед первым фрагментом) */
  firstTokenMs: 0,
  /** v66.4: вызовы chat, где модель портит JSON: double — две запятые подряд, missing — поле без значения */
  badJson: new Map<number, "double" | "missing">(),
};
const TITLE_WARNING = "Фото 1 — титульный лист учебника «Физика 8», автор Перышкин, текста темы нет";
const shortRefusal = () => JSON.stringify({ error: "UNREADABLE_PAGES", warnings: [TITLE_WARNING] });
const longRefusal = (n: number) => JSON.stringify({
  meta: { pages: Array.from({ length: n }, (_, i) => ({ index: i, readable: "unreadable" })) }, sections: [],
  warnings: Array.from({ length: 6 }, (_, i) => "Страница " + (i + 1) + " сильно размыта и снята под углом, буквы сливаются, разобрать текст абзацев невозможно даже частично."),
});
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const filler = "Ученики разбирают этот пункт учебника подробно, с определениями, примерами и выводами по каждому абзацу страницы. ";
function contentFor(pages: number[], prompt: string) {
  const second = /часть [2-9] из [2-9]/.test(prompt); // не первая часть
  const text = pages.filter((p) => !sc.titles.has(p));
  const sections = text.map((p) => ({ p, i: pages.indexOf(p) })).map(({ p, i }) => ({
    heading: sc.continueHeading && second && i === 0 ? "Пункт " + (p - 1) : "Пункт " + p,
    blocks: [{ type: "PARAGRAPH", text: "**Страница " + p + "**: Термин " + p + " и Общий термин. " + filler + filler, sourcePage: i }],
  }));
  return {
    meta: { title: second ? "Другое название" : "§ 5. Тема из восьми страниц", subject: "physics", pages: pages.map((p, i) => ({ index: i, readable: sc.titles.has(p) ? "unreadable" : "ok" })), sourceOutline: sections.map((s) => s.heading) },
    lead: second ? "" : "Главное по теме.",
    sections,
    glossary: { terms: [...text.map((p) => ({ term: "Термин " + p, definition: "Определение термина со страницы " + p + "." })), { term: "Общий термин", definition: "Есть в обеих частях." }], dates: [], people: [], formulas: [] },
    remember: text.map((p) => "Факт со страницы " + p),
    conclusion: /итог ВСЕЙ темы/.test(prompt) ? "Итог всей темы." : "Итог части.",
    selfCheck: text.map((p) => ({ q: "Вопрос по странице " + p + "?", a: "Ответ " + p + "." })),
    warnings: [],
  };
}
/**
 * Потоковый ответ как у GigaChat (Server-Sent Events): «data: {choices:[{delta:{content}}]}» по кусочкам, в последнем —
 * finish_reason и usage, затем «data: [DONE]». Режимы sc.hangMid / eof / badChunk / errorEvent — сбои посреди потока.
 */
function sse(k: number, content: string, usage: unknown, signal?: AbortSignal | null) {
  const enc = new TextEncoder();
  const size = Math.ceil(content.length / 6);
  const pieces = Array.from({ length: Math.ceil(content.length / size) }, (_, i) => content.slice(i * size, (i + 1) * size));
  const ev = (o: unknown) => enc.encode("data: " + (typeof o === "string" ? o : JSON.stringify(o)) + "\n\n");
  const chunk = (c: string, extra: Record<string, unknown> = {}) =>
    ev({ model: "GigaChat-2-Max:2.0", object: "chat.completion", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: c }, ...extra }] });
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i === 0) skew += sc.firstTokenMs;
      if (i === 2 && (sc.hangMid.has(k) || sc.eof.has(k) || sc.badChunk.has(k) || sc.errorEvent.has(k))) {
        if (sc.eof.has(k)) return ctl.close();
        if (sc.badChunk.has(k)) return (ctl.enqueue(enc.encode("data: {не json\n\n")), void i++);
        if (sc.errorEvent.has(k)) return (ctl.enqueue(ev({ status: 500, message: "internal error" })), void i++);
        return new Promise<void>((_, reject) => {
          const stop = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) stop();
          signal?.addEventListener("abort", stop, { once: true });
        });
      }
      if (i < pieces.length - 1) ctl.enqueue(chunk(pieces[i]));
      else if (i === pieces.length - 1) ctl.enqueue(chunk(pieces[i], { finish_reason: "stop" }));
      else if (i === pieces.length) ctl.enqueue(ev({ model: "GigaChat-2-Max:2.0", object: "chat.completion", created: 1, choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage }));
      else if (i === pieces.length + 1) ctl.enqueue(ev("[DONE]"));
      else return ctl.close();
      i++;
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.startsWith("http://sim.local/functions/v1/analyze-pages")) {
    sc.continuationHits++;
    if (sc.selfStatus) return jsonRes(sc.selfStatus, { error: "x" });
    const req = new Request(u, init);
    if (sc.holdContinuation) return sc.holdContinuation(req);
    return handler(req);
  }
  if (u.includes("/oauth")) return jsonRes(200, { access_token: "t", expires_at: Date.now() + 3_600_000 });
  if (u.endsWith("/files") && init.method === "POST") {
    const file = (init.body as FormData).get("file") as File;
    const page = Number(new TextDecoder().decode(new Uint8Array(await file.arrayBuffer())).replace("PAGE:", ""));
    const id = "f" + ++sc.uploads;
    sc.fileToPage.set(id, page);
    return jsonRes(200, { id });
  }
  if (/\/files\/[^/]+\/delete$/.test(u)) return (sc.deleted++, jsonRes(200, { deleted: true }));
  if (u.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init.body));
    const pages = body.messages.filter((m: any) => m.attachments).map((m: any) => sc.fileToPage.get(m.attachments[0])!);
    const prompt = body.messages.filter((m: any) => !m.attachments && m.role === "user").map((m: any) => m.content).join("\n");
    const system = body.messages.find((m: any) => m.role === "system")?.content || "";
    sc.systems.push(system);
    sc.calls.push({ pages, prompt });
    const k = sc.calls.length - 1;
    sc.streamReq.push(body.stream === true);
    skew += sc.chatMs;
    if (k === sc.chatFailOn) return jsonRes(500, { message: "boom" });
    if (sc.hang.has(k)) {
      return new Promise<Response>((_, reject) => {
        const sig = init.signal;
        if (sig?.aborted) reject(new DOMException("aborted", "AbortError"));
        sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (sc.chatStatus.has(k)) return jsonRes(sc.chatStatus.get(k)!, { message: "refused" });
    const usage = (out: number) => ({ prompt_tokens: 2700 + 1930 * pages.length, completion_tokens: out });
    const reply = (content: string, out: number) => body.stream === true && !sc.noStream
      ? sse(k, content, usage(out), init.signal)
      : jsonRes(200, { model: "GigaChat-2-Max:2.0", choices: [{ message: { content }, finish_reason: "stop" }], usage: usage(out) });
    if (sc.refuseLong.has(k)) return reply(longRefusal(pages.length), 400);
    // модель: на одних титульных листах текста нет — отказ; титульный лист среди страниц с текстом — отказ при
    // прежней инструкции, конспект по остальным при новой («НЕ причина для отказа»)
    const titled = pages.some((p) => sc.titles.has(p));
    const allTitles = pages.every((p) => sc.titles.has(p));
    if (sc.refuse.has(k) || allTitles || (titled && !/НЕ причина для отказа/.test(system))) return reply(shortRefusal(), 23);
    let json = JSON.stringify(contentFor(pages, prompt));
    if (sc.badJson.get(k) === "double") json = json.replace(',"sections":', ',,"sections":');
    if (sc.badJson.get(k) === "missing") json = json.replace('"warnings":[]', '"warnings":,"z":[]');
    return reply(json, 300 * pages.filter((p) => !sc.titles.has(p)).length);
  }
  return jsonRes(404, {});
};

await import("../../supabase/functions/analyze-pages/index.ts");

// ---------- помощники ----------
let noteN = 0;
function makeNote(n: number, user = "u1") {
  const id = crypto.randomUUID();
  noteN++;
  sim.notes.set(id, { id, user_id: user, status: "processing", stage: "uploading", error_code: null, updated_at: sim.clock(), content: null });
  const paths: string[] = [];
  for (let p = 1; p <= n; p++) {
    const path = user + "/" + id + "/" + String(p).padStart(2, "0") + "-pg" + p + ".jpg";
    sim.files.set(path, new TextEncoder().encode("PAGE:" + p));
    paths.push(path);
  }
  return { id, paths };
}
async function settle() {
  while (bg.length) await bg.shift();
}
async function start(id: string, paths: string[], tok = "tok-u1") {
  const res = await handler(new Request("http://sim.local/functions/v1/analyze-pages", {
    method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", origin: "https://thenikolaika1.github.io" },
    body: JSON.stringify({ note_id: id, paths }),
  }));
  const body = await res.json();
  await settle();
  return { status: res.status, body };
}
const reset = () => {
  sc.calls = [];
  sc.chatFailOn = -1;
  sc.continueHeading = false;
  sc.selfStatus = 0;
  sc.continuationHits = 0;
  sc.holdContinuation = null;
  sc.titles = new Set();
  sc.refuse = new Set();
  sc.refuseLong = new Set();
  sc.chatStatus = new Map();
  sc.chatMs = 0;
  sc.systems = [];
  sc.hang = new Set();
  sc.hangMid = new Set();
  sc.eof = new Set();
  sc.badChunk = new Set();
  sc.errorEvent = new Set();
  sc.noStream = false;
  sc.streamReq = [];
  sc.firstTokenMs = 0;
  sc.badJson = new Map();
  timers.fast = false;
  timers.asked = [];
  logs.length = 0;
};
const note = (id: string) => sim.notes.get(id) as any;
const plainText = (c: any) => JSON.stringify(c.sections);

// размеры частей: 1–4 — один запрос; 5 → 3+2, 6 → 3+3, 7 → 3+2+2, 8 → 3+3+2
const partSizes = (n: number) => (n <= 4 ? [n] : ({ 5: [3, 2], 6: [3, 3], 7: [3, 2, 2], 8: [3, 3, 2] } as Record<number, number[]>)[n]);

// ---------- 1–8 страниц ----------
for (let n = 1; n <= 8; n++) {
  reset();
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(n);
  const r = await start(id, paths);
  const nn = note(id);
  const c = nn.content;
  const expectedParts = partSizes(n);
  check(`[${n}] ответ 202, конспект готов (ready)`, r.status === 202 && nn.status === "ready", { r, status: nn.status, err: nn.error_code });
  check(`[${n}] запросов к модели: ${expectedParts.length} (страниц в каждом: ${expectedParts.join("+")}), не больше 4 фото за запрос`,
    JSON.stringify(sc.calls.map((x) => x.pages.length)) === JSON.stringify(expectedParts), sc.calls.map((x) => x.pages));
  const order = sc.calls.flatMap((x) => x.pages);
  check(`[${n}] страницы ушли модели по порядку 1…${n}, каждая один раз`, JSON.stringify(order) === JSON.stringify(Array.from({ length: n }, (_, i) => i + 1)), order);
  const heads = c?.sections.map((s: any) => s.heading) || [];
  check(`[${n}] конспект охватывает все страницы: разделы «Пункт 1…${n}» по порядку, текст каждой страницы`,
    JSON.stringify(heads) === JSON.stringify(Array.from({ length: n }, (_, i) => "Пункт " + (i + 1)))
      && Array.from({ length: n }, (_, i) => i + 1).every((p) => plainText(c).includes("Страница " + p)), heads);
  check(`[${n}] meta.pages — ${n} страниц с индексами 0…${n - 1}; термины и вопросы всех страниц, «Общий термин» один раз`,
    c?.meta.pages.length === n && c.meta.pages.every((p: any, i: number) => p.index === i)
      && Array.from({ length: n }, (_, i) => i + 1).every((p) => c.glossary.terms.some((t: any) => t.term === "Термин " + p) && c.selfCheck.some((q: any) => q.q.includes("странице " + p + "?")))
      && c.glossary.terms.filter((t: any) => t.term === "Общий термин").length === 1,
    { pages: c?.meta.pages.length, terms: c?.glossary.terms.map((t: any) => t.term), q: c?.selfCheck.map((x: any) => x.q) });
  check(`[${n}] одна генерация: один запуск (резерв), списана один раз (charged), одна строка ai_generations на ${n} стр.`,
    sim.starts.length - startsBefore === 1 && sim.ledger.get(id) === "charged" && sim.gens.length - gensBefore === 1
      && sim.gens[sim.gens.length - 1].page_count === n && sim.gens[sim.gens.length - 1].status === "success",
    { starts: sim.starts.length - startsBefore, ledger: sim.ledger.get(id), gens: sim.gens.slice(gensBefore) });
  const g = sim.gens[sim.gens.length - 1];
  check(`[${n}] токены в ai_generations — сумма всех частей`, g.input_tokens === sc.calls.reduce((a, x) => a + 2700 + 1930 * x.pages.length, 0)
    && g.output_tokens === 300 * n, g);
  check(`[${n}] фото удалены из хранилища после успеха`, ![...sim.files.keys()].some((k) => k.includes(id)));
  if (n > 4) {
    const k = expectedParts.length, lastP = sc.calls[k - 1].prompt;
    check(`[${n}] последняя часть: промпт «часть ${k} из ${k}», оглавление и термины готовых частей, итог всей темы` +
      (k === 3 ? "; средняя часть — «часть 2 из 3» без итога всей темы" : ""),
      new RegExp("часть " + k + " из " + k).test(lastP) && lastP.includes("«Пункт 1»") && lastP.includes("Термин 1")
        && lastP.includes("Термин " + (expectedParts[0] + (k === 3 ? expectedParts[1] : 0)))
        && (k < 3 || (/часть 2 из 3/.test(sc.calls[1].prompt) && !/итог ВСЕЙ темы/.test(sc.calls[1].prompt) && /Продолжение темы обработается отдельно/.test(sc.calls[1].prompt)))
        && c.conclusion === "Итог всей темы." && c.meta.title === "§ 5. Тема из восьми страниц", sc.calls[1].prompt.slice(0, 600));
  } else {
    check(`[${n}] как раньше: один запрос без текста про части`, sc.calls.length === 1 && !/часть \d из/.test(sc.calls[0].prompt));
  }
}

// ---------- 9 страниц и лимит базы ----------
reset();
{
  const startsBefore = sim.starts.length;
  const { id, paths } = makeNote(9);
  const r = await start(id, paths);
  check("[9] 9 страниц: 400 TOO_MANY_PAGES, генерация не запускалась, ИИ не вызывался", r.status === 400 && r.body.error === "TOO_MANY_PAGES"
    && sim.starts.length === startsBefore && sc.calls.length === 0, r);
}
reset();
sim.maxPages = 4; // как сейчас в production (private.ai_limits.max_pages = 4)
{
  const { id, paths } = makeNote(6);
  const r = await start(id, paths);
  check("[лимит базы 4] 6 страниц при max_pages = 4: отказ TOO_MANY_PAGES, note failed, ИИ не вызывался, резерва нет",
    r.status === 400 && note(id).error_code === "TOO_MANY_PAGES" && sc.calls.length === 0 && !sim.ledger.has(id), r);
}
// пробные генерации владельца при лимите базы 4 (как сейчас в production)
reset();
{
  const { id, paths } = makeNote(8, "u-owner");
  const r = await start(id, paths, "tok-owner");
  check("[лимит базы 4, владелец] 8 страниц: разрешено только владельцу — готово, 3 части, одно списание, в лимит базы ушло 4",
    r.status === 202 && note(id).status === "ready" && sc.calls.length === 3 && sim.ledger.get(id) === "charged"
      && sim.starts[sim.starts.length - 1].pages === 4 && note(id).content.meta.pages.length === 8, { r, st: note(id).status, calls: sc.calls.length });
}
reset();
{
  const { id, paths } = makeNote(8);
  const r = await start(id, paths, "tok-u1");
  check("[лимит базы 4, ученик] 8 страниц у ученика: по-прежнему TOO_MANY_PAGES, ИИ не вызывался", r.status === 400 && r.body.error === "TOO_MANY_PAGES"
    && sc.calls.length === 0 && sim.starts[sim.starts.length - 1].pages === 8, r);
}
reset();
{
  const { id, paths } = makeNote(4, "u-owner");
  const r = await start(id, paths, "tok-owner");
  check("[лимит базы 4, владелец] 4 страницы — как раньше (в лимит ушло 4, один запрос)", r.status === 202 && note(id).status === "ready"
    && sc.calls.length === 1 && sim.starts[sim.starts.length - 1].pages === 4);
}
sim.maxPages = 8;

// ---------- пункт, разорванный между частями ----------
reset();
sc.continueHeading = true;
{
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const heads = note(id).content.sections.map((s: any) => s.heading);
  const p4 = note(id).content.sections.find((s: any) => s.heading === "Пункт 3");
  const p6 = note(id).content.sections.find((s: any) => s.heading === "Пункт 6");
  check("[8 = 3+3+2] пункты, разорванные на стыках частей (стр. 3→4 и 6→7), — по одному разделу без дублей: «Пункт 3» со стр. 3 и 4, «Пункт 6» со стр. 6 и 7",
    JSON.stringify(heads) === JSON.stringify(["Пункт 1", "Пункт 2", "Пункт 3", "Пункт 5", "Пункт 6", "Пункт 8"])
      && JSON.stringify(p4.blocks).includes("Страница 3") && JSON.stringify(p4.blocks).includes("Страница 4")
      && JSON.stringify(p6.blocks).includes("Страница 6") && JSON.stringify(p6.blocks).includes("Страница 7"), heads);
  const src = note(id).content.sections.flatMap((s: any) => s.blocks.map((b: any) => b.sourcePage));
  check("[8] номера страниц у блоков — в нумерации всей темы (0…7)", JSON.stringify(src) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]), src);
}

// ---------- ошибки частей, возврат резерва, повтор ----------
reset();
sc.chatFailOn = 1; // вторая часть
const failed2 = makeNote(8);
{
  const gensBefore = sim.gens.length;
  await start(failed2.id, failed2.paths);
  const nn = note(failed2.id);
  const g = sim.gens.slice(gensBefore);
  check("[8, ошибка второй части] note failed (AI_ERROR), резерв возвращён (refunded), фото сохранены для повтора",
    nn.status === "failed" && nn.error_code === "AI_ERROR" && sim.ledger.get(failed2.id) === "refunded"
      && failed2.paths.every((p) => sim.files.has(p)), { st: nn.status, err: nn.error_code, ledger: sim.ledger.get(failed2.id) });
  check("[8, ошибка второй части] одна строка ai_generations (failed) с токенами первой части", g.length === 1 && g[0].status === "failed"
    && g[0].input_tokens === 2700 + 1930 * 3 && g[0].page_count === 8, g);
}
reset();
{
  const startsBefore = sim.starts.length;
  await start(failed2.id, failed2.paths);
  check("[8, повтор после ошибки] снова все три части, ready, списано один раз (charged)", note(failed2.id).status === "ready"
    && sim.ledger.get(failed2.id) === "charged" && sim.starts.length - startsBefore === 1 && sc.calls.length === 3);
}
reset();
sc.chatFailOn = 0; // первая часть
{
  const { id, paths } = makeNote(7);
  await start(id, paths);
  check("[7, ошибка первой части] failed, резерв возвращён, вторая часть не запускалась", note(id).status === "failed"
    && sim.ledger.get(id) === "refunded" && sc.continuationHits === 0 && sc.calls.length === 1, { err: note(id).error_code, hits: sc.continuationHits });
}
reset();
sc.selfStatus = 503; // вторая часть не принята (сеть, перегрузка)
{
  const { id, paths } = makeNote(6);
  await start(id, paths);
  check("[6, вторая часть не принята] failed CONTINUATION_FAILED, резерв возвращён", note(id).status === "failed"
    && note(id).error_code === "CONTINUATION_FAILED" && sim.ledger.get(id) === "refunded", note(id).error_code);
}

reset();
{
  // ответ на передачу потерялся (обрыв), а вторая часть всё же запустилась: первая часть считает передачу неудачной
  sc.holdContinuation = async (req) => {
    const r = await handler(req);
    void r;
    throw new TypeError("connection reset");
  };
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const nn = note(id);
  check("[8, ответ на передачу потерян] итог согласован: failed и резерв возвращён; вторая часть не перезаписала его готовым конспектом",
    nn.status === "failed" && nn.error_code === "CONTINUATION_FAILED" && sim.ledger.get(id) === "refunded" && !nn.content, { st: nn.status, err: nn.error_code, l: sim.ledger.get(id) });
}

// ---------- безопасность продолжения ----------
reset();
let captured: { url: string; body: string; headers: Headers } | null = null;
sc.holdContinuation = async (req) => {
  captured = { url: req.url, body: await req.clone().text(), headers: req.headers };
  return handler(req);
};
const sec = makeNote(8);
await start(sec.id, sec.paths);
check("[продолжение] перехвачено: тело подписано, в заголовках нет ключа сервера", !!captured
  && !JSON.stringify([...captured!.headers]).includes("svc-secret-test") && !captured!.body.includes("svc-secret-test") && note(sec.id).status === "ready");
const post = (body: string) => handler(new Request("http://sim.local/functions/v1/analyze-pages", { method: "POST", headers: { "x-kn-continuation": "1", "Content-Type": "application/json" }, body }));
{
  const callsBefore = sc.calls.length;
  const replay = await post(captured!.body);
  await settle();
  check("[продолжение] повтор того же продолжения после готовности → 409, ИИ не вызывался", replay.status === 409 && sc.calls.length === callsBefore, replay.status);
  const b = JSON.parse(captured!.body);
  const tampered = JSON.parse(b.continuation);
  tampered.user_id = "u2";
  const r1 = await post(JSON.stringify({ continuation: JSON.stringify(tampered), sig: b.sig }));
  const r2 = await post(JSON.stringify({ continuation: b.continuation, sig: "0".repeat(64) }));
  const r3 = await post(JSON.stringify({ continuation: b.continuation }));
  check("[продолжение] изменённое тело, чужая/пустая подпись → 403", r1.status === 403 && r2.status === 403 && r3.status === 403, [r1.status, r2.status, r3.status]);
  const r4 = await handler(new Request("http://sim.local/functions/v1/analyze-pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: captured!.body }));
  check("[продолжение] без заголовка продолжения тело не принимается за запуск (нужен JWT) → 401", r4.status === 401, r4.status);
}
{
  // подпись верная, но срок истёк
  const { signContinuation } = await import("../../supabase/functions/analyze-pages/parts.ts");
  const b = JSON.parse(captured!.body);
  const c = JSON.parse(b.continuation);
  c.exp = Date.now() - 1000;
  const s = await signContinuation("svc-secret-test", c);
  const r = await post(JSON.stringify({ continuation: s.payload, sig: s.sig }));
  check("[продолжение] истёкшая подпись → 403", r.status === 403, r.status);
}
reset();
{
  // двойная доставка продолжения: второй экземпляр не запускает вторую часть
  let dup: Promise<Response> | null = null;
  sc.holdContinuation = async (req) => {
    const body = await req.clone().text();
    dup = handler(new Request(req.url, { method: "POST", headers: req.headers, body }));
    return handler(req);
  };
  const d = makeNote(8);
  await start(d.id, d.paths);
  const second = await dup!;
  await settle();
  check("[продолжение] двойная доставка: вторая часть выполнена один раз, конспект готов, списано один раз (не возвращено)",
    sc.calls.length === 3 && note(d.id).status === "ready" && sim.ledger.get(d.id) === "charged", { s: second.status, calls: sc.calls.length, st: note(d.id).status, l: sim.ledger.get(d.id) });
}
reset();
{
  // чужая note: запуск с токеном другого пользователя
  const { id, paths } = makeNote(6);
  const r = await start(id, paths, "tok-u2");
  check("[доступ] чужие пути/note → отказ, ИИ не вызывался", r.status >= 400 && sc.calls.length === 0, r);
}
reset();
sim.access = "limit_reached";
{
  const { id, paths } = makeNote(8);
  const r = await start(id, paths);
  check("[доступ] лимит генераций исчерпан: 403 LIMIT_REACHED, ИИ не вызывался", r.status === 403 && r.body.error === "LIMIT_REACHED" && sc.calls.length === 0, r);
}
sim.access = "ok";


// ---------- v66.1: отказ «страницы не читаются» (UNREADABLE_PAGES) ----------
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const unreadableLogs = () => logs.filter((l) => l.includes("unreadable:"));
const safeLog = () => !logs.some((l) => l.includes(TITLE_WARNING) || l.includes("Перышкин") || l.includes("размыта") || l.includes("Страница 1"));
const genOk = (id: string, gensBefore: number, startsBefore: number, status: "success" | "failed") =>
  sim.starts.length - startsBefore === 1 && sim.gens.length - gensBefore === 1 && sim.gens[sim.gens.length - 1].status === status
    && sim.ledger.get(id) === (status === "success" ? "charged" : "refunded");

reset();
{
  const { id, paths } = makeNote(1);
  await start(id, paths);
  check("[инструкция] модели ушёл новый текст: обложка/титульный лист — НЕ причина для отказа; отказ — только если текста нет ни на одной фотографии", /НЕ причина для отказа/.test(sc.systems[0]) && /НИ НА ОДНОЙ фотографии/.test(sc.systems[0]), sc.systems[0]?.slice(-700));
}

// 1. первая фотография — титульный лист, 1–8 фото
for (let n = 1; n <= 8; n++) {
  reset();
  sc.titles = new Set([1]);
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(n);
  const r = await start(id, paths);
  const nn = note(id);
  if (n === 1) {
    // только титульный лист: текста нет нигде — честный отказ после одного повтора, генерация возвращена
    check("[титул, 1 фото — только титульный лист] failed UNREADABLE_PAGES после одного повтора (2 запроса), резерв возвращён, одна строка ai_generations",
      r.status === 202 && nn.status === "failed" && nn.error_code === "UNREADABLE_PAGES" && sc.calls.length === 2 && genOk(id, gensBefore, startsBefore, "failed"),
      { st: nn.status, err: nn.error_code, calls: sc.calls.length, ledger: sim.ledger.get(id) });
    continue;
  }
  const parts = partSizes(n);
  const c = nn.content;
  const heads = c?.sections.map((s: any) => s.heading) || [];
  check(`[титул, ${n} фото] готово без повторов: запросов ${parts.length} (${parts.join("+")}), титульный лист не вызвал отказ`,
    nn.status === "ready" && JSON.stringify(sc.calls.map((x) => x.pages.length)) === JSON.stringify(parts), { st: nn.status, err: nn.error_code, calls: sc.calls.map((x) => x.pages) });
  check(`[титул, ${n} фото] конспект по страницам 2…${n}; титульный лист отмечен unreadable (index 0), всего ${n} страниц`,
    JSON.stringify(heads) === JSON.stringify(ids(n).slice(1).map((p) => "Пункт " + p)) && c.meta.pages.length === n
      && c.meta.pages[0].readable === "unreadable" && c.meta.pages.slice(1).every((p: any) => p.readable === "ok"), { heads, pages: c?.meta.pages });
  check(`[титул, ${n} фото] одна генерация: один резерв, списана один раз, одна строка ai_generations`, genOk(id, gensBefore, startsBefore, "success"),
    { ledger: sim.ledger.get(id), gens: sim.gens.length - gensBefore });
}

// 1б. прежняя инструкция (как в v27): титульный лист в 1-й части → короткий отказ; теперь — один повтор и конспект
for (const n of [3, 6]) {
  reset();
  sc.titles = new Set([1]);
  sc.refuse = new Set([0]); // первый ответ — короткий отказ, как 07.11 (23 токена)
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length, uploadsBefore = sc.uploads;
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  const parts = n <= 4 ? [n, n] : [3, 3, 3];
  check(`[как 07.11, ${n} фото] короткий отказ на первый запрос → один повтор с уточнением → готово (запросов ${parts.length})`,
    nn.status === "ready" && JSON.stringify(sc.calls.map((x) => x.pages.length)) === JSON.stringify(parts)
      && /не читаются, но это фотографии страниц учебника/.test(sc.calls[1].prompt), { st: nn.status, err: nn.error_code, calls: sc.calls.map((x) => x.pages) });
  check(`[как 07.11, ${n} фото] при повторе фото заново не загружались в GigaChat (${n} загрузок)`, sc.uploads - uploadsBefore === n, sc.uploads - uploadsBefore);
  const g = sim.gens[sim.gens.length - 1];
  check(`[как 07.11, ${n} фото] одна генерация, списана один раз; токены в строке — сумма всех запросов (с отказом)`,
    genOk(id, gensBefore, startsBefore, "success") && g.input_tokens === sc.calls.reduce((a, x) => a + 2700 + 1930 * x.pages.length, 0)
      && g.output_tokens === 23 + 300 * (n - 1), g);
  const d = unreadableLogs();
  check(`[как 07.11, ${n} фото] в лог записана диагностика отказа: код, длина, метки причин (cover), без текста ответа`,
    d.length === 1 && /"error":"UNREADABLE_PAGES"/.test(d[0]) && /"reasons":\["cover"/.test(d[0]) && /"output_tokens":23/.test(d[0]) && /"warnings":1/.test(d[0]), d);
  check(`[как 07.11, ${n} фото] в логе нет текста ответа модели, имён и текста учебника`, safeLog(), logs.filter((l) => !safeLog() && l.includes("unreadable")));
  check(`[как 07.11, ${n} фото] метрики: unreadable_retry = true`, logs.some((l) => l.includes("metrics") && l.includes('"unreadable_retry":true')));
}

// 2. короткий отказ без титульного листа: 1–8 фото, отказ на первый запрос (части 1) и на первый запрос части 2
for (let n = 1; n <= 8; n++) {
  for (const at of n > 6 ? [0, 1, 2] : n > 4 ? [0, 1] : [0]) {
    reset();
    sc.refuse = new Set([at]);
    const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
    const { id, paths } = makeNote(n);
    await start(id, paths);
    const nn = note(id);
    const parts = partSizes(n);
    const expected = [...parts.slice(0, at + 1), ...parts.slice(at)];
    const heads = nn.content?.sections.map((s: any) => s.heading) || [];
    check(`[короткий отказ, ${n} фото, ${n > 4 ? "часть " + (at + 1) : "один запрос"}] один повтор → готово, все страницы в конспекте, запросов ${expected.length}`,
      nn.status === "ready" && JSON.stringify(sc.calls.map((x) => x.pages.length)) === JSON.stringify(expected)
        && JSON.stringify(heads) === JSON.stringify(ids(n).map((p) => "Пункт " + p)), { st: nn.status, err: nn.error_code, calls: sc.calls.map((x) => x.pages), heads });
    check(`[короткий отказ, ${n} фото${n > 4 ? ", часть " + (at + 1) : ""}] одна генерация, списана один раз; лог безопасен`,
      genOk(id, gensBefore, startsBefore, "success") && unreadableLogs().length === 1 && safeLog(), { ledger: sim.ledger.get(id), d: unreadableLogs() });
  }
}

// 3. отказ дважды подряд — не больше одного повтора, генерация возвращена
for (const n of [2, 4, 6, 8]) {
  reset();
  sc.refuse = new Set([0, 1]);
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  check(`[отказ дважды, ${n} фото] не больше одного повтора: 2 запроса, failed UNREADABLE_PAGES, вторая часть не запускалась, резерв возвращён`,
    nn.status === "failed" && nn.error_code === "UNREADABLE_PAGES" && sc.calls.length === 2 && sc.continuationHits === 0 && genOk(id, gensBefore, startsBefore, "failed")
      && [...sim.files.keys()].some((k) => k.includes(id)), { st: nn.status, err: nn.error_code, calls: sc.calls.length, ledger: sim.ledger.get(id) });
  check(`[отказ дважды, ${n} фото] диагностика записана для обеих попыток`, unreadableLogs().length === 2 && safeLog(), unreadableLogs());
}

// 4. длинный подробный отказ (страницы действительно не читаются) — без повтора
for (const n of [3, 7]) {
  reset();
  sc.refuseLong = new Set([0]);
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  check(`[длинный отказ, ${n} фото] без повтора: 1 запрос, failed UNREADABLE_PAGES, резерв возвращён`,
    nn.status === "failed" && nn.error_code === "UNREADABLE_PAGES" && sc.calls.length === 1 && genOk(id, gensBefore, startsBefore, "failed"),
    { st: nn.status, calls: sc.calls.length });
  const d = unreadableLogs();
  check(`[длинный отказ, ${n} фото] диагностика: все страницы unreadable, метка blurry, без текста предупреждений`,
    d.length === 1 && d[0].includes('"pages":"' + Array(partSizes(n)[0]).fill("unreadable").join(",") + '"') && /"reasons":\[[^\]]*"blurry"/.test(d[0]) && safeLog(), d);
}

// 5. на повтор не хватает времени — повтора нет
for (const n of [4, 8]) {
  reset();
  sc.refuse = new Set([0]);
  sc.chatMs = 100_000; // ответ «длился» 100 с: из 140 с осталось меньше, чем нужно на полноценный повтор
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  check(`[мало времени, ${n} фото] короткий отказ, но повтор не успеет → без повтора: 1 запрос, failed, резерв возвращён`,
    nn.status === "failed" && nn.error_code === "UNREADABLE_PAGES" && sc.calls.length === 1 && genOk(id, gensBefore, startsBefore, "failed")
      && logs.some((l) => l.includes("retry skipped: not enough time")), { st: nn.status, calls: sc.calls.length });
}
skew = 0;

// 6. настоящие ошибки провайдера (авторизация, квота, ограничения) — повтора нет
for (const [status, code] of [[403, "AI_AUTH"], [429, "AI_RATE_LIMITED"], [400, "AI_BAD_REQUEST"]] as const) {
  for (const n of [3, 6]) {
    reset();
    sc.chatStatus = new Map([[0, status]]);
    const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
    const { id, paths } = makeNote(n);
    await start(id, paths);
    const nn = note(id);
    check(`[HTTP ${status}, ${n} фото] без повтора: 1 запрос к модели, failed ${code}, вторая часть не запускалась, резерв возвращён`,
      nn.status === "failed" && nn.error_code === code && sc.calls.length === 1 && sc.continuationHits === 0 && genOk(id, gensBefore, startsBefore, "failed")
        && unreadableLogs().length === 0, { st: nn.status, err: nn.error_code, calls: sc.calls.length, ledger: sim.ledger.get(id) });
  }
}

// 7. повтор после отказа сам упал с ошибкой провайдера — генерация возвращена, третьего запроса нет
{
  reset();
  sc.refuse = new Set([0]);
  sc.chatStatus = new Map([[1, 429]]);
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(4);
  await start(id, paths);
  const nn = note(id);
  check("[отказ, затем 429] 2 запроса, failed AI_RATE_LIMITED, резерв возвращён, одна строка ai_generations",
    nn.status === "failed" && nn.error_code === "AI_RATE_LIMITED" && sc.calls.length === 2 && genOk(id, gensBefore, startsBefore, "failed"), { st: nn.status, err: nn.error_code, calls: sc.calls.length });
}


// ---------- v66.2: части не больше 3 фото, предел 90 с на часть, повтор части, диагностика ----------
{
  const { splitPages, PART_CALL_MS } = await import("../../supabase/functions/analyze-pages/parts.ts");
  const ok = [1, 2, 3, 4, 5, 6, 7, 8].every((n) => {
    const r = splitPages(n);
    return JSON.stringify(r.map(([a, b]) => b - a)) === JSON.stringify(partSizes(n)) && r[0][0] === 0 && r[r.length - 1][1] === n
      && r.every(([, b], i) => i === r.length - 1 || r[i + 1][0] === b);
  });
  check("[части] деление: 1–4 — один запрос; 5 → 3+2, 6 → 3+3, 7 → 3+2+2, 8 → 3+3+2; страницы подряд, без пропусков; предел части 90 с",
    ok && PART_CALL_MS === 90_000, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => splitPages(n)));
  const { partRetryFits } = await import("../../supabase/functions/analyze-pages/index.ts");
  check("[части] повтор внутри вызова — только если успеет: осталось 85 с после ответа 50 с → да; 100 с/45 с → да; 60 с/50 с → нет; 47 с после тайм-аута 90 с → нет",
    partRetryFits(85_000, 50_000) && partRetryFits(100_000, 45_000) && !partRetryFits(60_000, 50_000) && !partRetryFits(47_000, 90_000));
}
const { planLabel } = await import("../../supabase/functions/analyze-pages/parts.ts");
const gensOf = (id: string) => sim.gens.filter((g) => g.note_id === id);
const inTok = (sizes: number[]) => sizes.reduce((a, n) => a + 2700 + 1930 * n, 0);
// резерв генерации: 1–4 страницы — как раньше (600 с), по частям — 1200 с
reset();
{
  const a = makeNote(4), b = makeNote(8);
  await start(a.id, a.paths);
  const la = sim.starts[sim.starts.length - 1].lease;
  await start(b.id, b.paths);
  const lb = sim.starts[sim.starts.length - 1].lease;
  check("[резерв] срок резерва генерации: 4 страницы — 600 с (как v65), 8 страниц — 1200 с (до трёх частей и повтор)", la === 600 && lb === 1200, { la, lb });
}

// ---------- v66.3: повтор части после тайм-аута — больше времени и меньше фото (3 → 2+1), не больше двух повторов ----------
const pagesOf = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i + 1);
const P = (...xs: number[]) => JSON.stringify(xs);
const callPages = () => sc.calls.map((c) => JSON.stringify(c.pages));
type Case = { n: number; label: string; hang?: number[]; eof?: number[]; hangMid?: number[]; expect: number[][]; ok: boolean; why?: RegExp };
const cases: Case[] = [
  { n: 8, label: "часть 1 (3 фото) не ответила → 2+1", hang: [0], expect: [[1, 2, 3], [1, 2], [3], [4, 5, 6], [7, 8]], ok: true },
  { n: 8, label: "часть 1, затем её половина 2 фото → 1+1", hang: [0, 1], expect: [[1, 2, 3], [1, 2], [1], [2], [3], [4, 5, 6], [7, 8]], ok: true },
  { n: 8, label: "часть 2 (3 фото) → 2+1", hang: [1], expect: [[1, 2, 3], [4, 5, 6], [4, 5], [6], [7, 8]], ok: true },
  { n: 8, label: "часть 3 (2 фото) → 1+1", hang: [2], expect: [[1, 2, 3], [4, 5, 6], [7, 8], [7], [8]], ok: true },
  { n: 7, label: "часть 3 из 3+2+2 → 1+1", hang: [2], expect: [[1, 2, 3], [4, 5], [6, 7], [6], [7]], ok: true },
  { n: 6, label: "часть 2 из 3+3 → 2+1", hang: [1], expect: [[1, 2, 3], [4, 5, 6], [4, 5], [6]], ok: true },
  { n: 5, label: "часть 1 из 3+2 → 2+1", hang: [0], expect: [[1, 2, 3], [1, 2], [3], [4, 5]], ok: true },
  { n: 8, label: "тайм-аут на разных частях: часть 1, затем стр. 4–6 (часть 3 плана 2*+1*+3+2)", hang: [0, 3], expect: [[1, 2, 3], [1, 2], [3], [4, 5, 6], [4, 5], [6], [7, 8]], ok: true },
  { n: 8, label: "три тайм-аута подряд: третий — без повтора (предел 2 повтора)", hang: [0, 1, 2], expect: [[1, 2, 3], [1, 2], [1]], ok: false, why: /no retry: retry limit 2/ },
  { n: 8, label: "третий тайм-аут на части из 3 фото (её ещё можно поделить) — всё равно без повтора: предел 2", hang: [0, 1, 5], expect: [[1, 2, 3], [1, 2], [1], [2], [3], [4, 5, 6]], ok: false, why: /no retry: retry limit 2/ },
  { n: 8, label: "одно фото не ответило и при долгом ожидании — без повтора", hang: [2, 3], expect: [[1, 2, 3], [4, 5, 6], [7, 8], [7]], ok: false, why: /no retry: one page already had the longest wait/ },
  { n: 8, label: "поток закрылся раньше конца (сеть) → та же часть с долгим ожиданием", eof: [1], expect: [[1, 2, 3], [4, 5, 6], [4, 5, 6], [7, 8]], ok: true },
  { n: 8, label: "частичный ответ: два фрагмента и тишина до тайм-аута → 2+1, начало ответа не используется", hangMid: [0], expect: [[1, 2, 3], [1, 2], [3], [4, 5, 6], [7, 8]], ok: true },
];
for (const cs of cases) {
  reset();
  timers.fast = true;
  sc.hang = new Set(cs.hang || []);
  sc.eof = new Set(cs.eof || []);
  sc.hangMid = new Set(cs.hangMid || []);
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(cs.n);
  await start(id, paths);
  const nn = note(id);
  const t = `[повтор, ${cs.n} фото, ${cs.label}]`;
  check(`${t} запросы к модели: ${cs.expect.map((x) => x.length).join(", ")} фото — ровно такие страницы и в таком порядке`,
    JSON.stringify(callPages()) === JSON.stringify(cs.expect.map((x) => JSON.stringify(x))), sc.calls.map((c) => c.pages));
  const g = gensOf(id);
  if (cs.ok) {
    const heads = nn.content?.sections.map((s: any) => s.heading) || [];
    const c = nn.content;
    check(`${t} готово: каждая страница ровно один раз — разделы «Пункт 1…${cs.n}», meta.pages 0…${cs.n - 1}, термины без дублей`,
      nn.status === "ready" && JSON.stringify(heads) === JSON.stringify(pagesOf(0, cs.n).map((p) => "Пункт " + p))
        && c.meta.pages.length === cs.n && c.meta.pages.every((p: any, i: number) => p.index === i)
        && pagesOf(0, cs.n).every((p) => c.glossary.terms.filter((x: any) => x.term === "Термин " + p).length === 1 && (plainText(c).match(new RegExp("Страница " + p + "\\*", "g")) || []).length === 1)
        && c.conclusion === "Итог всей темы.",
      { st: nn.status, err: nn.error_code, heads });
    const answered = sc.calls.filter((_, i) => !(cs.hang || []).includes(i) && !(cs.eof || []).includes(i) && !(cs.hangMid || []).includes(i));
    check(`${t} одна генерация: один резерв, списана один раз, одна строка ai_generations; токены — только ответивших запросов`,
      sim.starts.length - startsBefore === 1 && sim.ledger.get(id) === "charged" && sim.gens.length - gensBefore === 1 && g.length === 1
        && g[0].status === "success" && g[0].input_tokens === inTok(answered.map((c) => c.pages.length)),
      { l: sim.ledger.get(id), g });
  } else {
    check(`${t} failed AI_TIMEOUT, причина в логе; резерв возвращён, фото сохранены, одна строка ai_generations, конспект не записан`,
      nn.status === "failed" && nn.error_code === "AI_TIMEOUT" && sim.ledger.get(id) === "refunded" && paths.every((p) => sim.files.has(p))
        && g.length === 1 && g[0].status === "failed" && !nn.content && logs.some((l) => cs.why!.test(l)),
      { st: nn.status, err: nn.error_code, l: sim.ledger.get(id), g: g.length, logs: logs.filter((l) => /no retry|retrying/.test(l)) });
  }
  if (cs.hang?.[0] === 0 && cs.ok) {
    check(`${t} первая попытка ждёт 90 с, повтор — 120 с; в лог — план до и после, этап и время ожидания`,
      timers.asked.includes(90_000) && timers.asked.includes(120_000)
        && logs.some((l) => l.includes("retrying in a new call, plan " + (cs.n === 5 ? "3+2 → 2*+1*+2" : "3+3+2 → 2*+1*+3+2")))
        && logs.some((l) => /stage=chat timeout/.test(l) && /chat_ms=\d+/.test(l) && /ttft_ms=-1/.test(l) && /end=timeout/.test(l))
        && logs.some((l) => l.includes("metrics") && l.includes('"part_retry":true') && l.includes('"stream_end":"timeout"') && l.includes('"ttft_ms":-1')),
      { asked: [...new Set(timers.asked)], logs: logs.filter((l) => /timeout|retrying/.test(l)).slice(0, 4) });
  }
  if (cs.hangMid) {
    check(`${t} метрики обрыва: первый токен пришёл (ttft_ms ≥ 0), 2 фрагмента, причина timeout; текст ответа в лог не попал`,
      logs.some((l) => /stage=chat timeout/.test(l) && /ttft_ms=\d+/.test(l) && /chunks=2 /.test(l) && /tokens=-1/.test(l) && /end=timeout/.test(l))
        && logs.some((l) => l.includes("metrics") && l.includes('"stream_chunks":2') && l.includes('"stream_end":"timeout"'))
        && !logs.some((l) => l.includes("Ученики разбирают") || l.includes("Страница 1") || l.includes("PAGE:")),
      logs.filter((l) => /timeout|metrics/.test(l)).slice(0, 3));
  }
  if (cs.eof) {
    check(`${t} поток без конца ответа → AI_NETWORK (end=eof), повтор той же части с долгим ожиданием`,
      logs.some((l) => /AI_NETWORK/.test(l) && /stream ended/.test(l)) && logs.some((l) => l.includes("plan 3+3+2 → 3+3*+2")), logs.filter((l) => /AI_NETWORK|plan/.test(l)).slice(0, 3));
  }
}

// поток: успешный ответ — метрики в лог и в metrics, только числа; 1–4 фото поток не запрашивают
reset();
{
  sc.firstTokenMs = 7_000;
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const ok = logs.filter((l) => /ai provider=gigachat .* status=200 /.test(l));
  check("[поток] 8 фото: все запросы частей — stream: true; в лог — время до первого токена, генерация, фрагменты, токены, причина окончания",
    note(id).status === "ready" && sc.streamReq.length === 3 && sc.streamReq.every(Boolean) && ok.length === 3
      && ok.every((l) => /ttft_ms=7\d{3} /.test(l) && /gen_ms=\d+/.test(l) && /chunks=\d+ /.test(l) && /tokens=(900|600) /.test(l) && /end=stop/.test(l))
      && logs.some((l) => l.includes("metrics") && /"ttft_ms":7\d{3}/.test(l) && l.includes('"stream_end":"stop"') && /"stream_tokens":(900|600)/.test(l)),
    ok.slice(0, 2));
  check("[поток] в логах нет текста конспекта, учебника и фото", !logs.some((l) => l.includes("Ученики разбирают") || l.includes("Страница 1") || l.includes("Термин 1") || l.includes("PAGE:")));
}
reset();
{
  const { id, paths } = makeNote(4);
  await start(id, paths);
  check("[поток] 1–4 фото — как раньше: поток не запрашивается (stream: false), ответ одним JSON, готово",
    note(id).status === "ready" && sc.streamReq.length === 1 && sc.streamReq[0] === false && !logs.some((l) => /ttft_ms=/.test(l)), sc.streamReq);
}
reset();
{
  sc.noStream = true;
  const { id, paths } = makeNote(8);
  await start(id, paths);
  check("[поток] сервер ответил обычным JSON на stream: true — разбирается как раньше (end=not_streamed), готово",
    note(id).status === "ready" && sc.calls.length === 3 && logs.some((l) => /end=not_streamed/.test(l)), { st: note(id).status, err: note(id).error_code });
}
for (const [mode, label] of [["badChunk", "неразборчивый фрагмент"], ["errorEvent", "событие ошибки в потоке"]] as const) {
  reset();
  (sc as any)[mode] = new Set([1]);
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const nn = note(id);
  check(`[поток] ${label} во второй части → AI_ERROR без повтора части: failed, резерв возвращён, одна строка ai_generations`,
    nn.status === "failed" && nn.error_code === "AI_ERROR" && sc.calls.length === 2 && sim.ledger.get(id) === "refunded" && gensOf(id).length === 1
      && logs.some((l) => l.includes("metrics") && l.includes(mode === "badChunk" ? '"stream_end":"bad_chunk"' : '"stream_end":"error"'))
      && logs.some((l) => /stream failed: AI_ERROR/.test(l) && /chunks=2 /.test(l)) && !logs.some((l) => l.includes("internal error") || l.includes("Ученики разбирают")),
    { st: nn.status, err: nn.error_code, calls: sc.calls.length });
}

// общий бюджет генерации: часть, которая не уложится в 10 мин от запуска, не начинается
reset();
{
  timers.fast = true;
  sc.hang = new Set([0]);
  sc.chatMs = 140_000; // каждый запрос к модели «длится» 140 с
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const nn = note(id);
  check("[бюджет] запросы по 140 с: после 4 запросов (560 с) последняя часть плана 2*+1*+3+2 не начинается и не передаётся (3 передачи, не 4) — failed AI_TIMEOUT, резерв возвращён, одна строка ai_generations",
    nn.status === "failed" && nn.error_code === "AI_TIMEOUT" && sc.calls.length === 4 && sc.continuationHits === 3 && sim.ledger.get(id) === "refunded" && gensOf(id).length === 1
      && logs.some((l) => /generation budget exhausted before part 4/.test(l)),
    { st: nn.status, err: nn.error_code, calls: sc.calls.map((c) => c.pages), l: logs.filter((l) => /budget|failed/.test(l)) });
}
{
  const { fitsGeneration, retryPlan, planFor, GEN_BUDGET_MS, PART_RETRY_CALL_MS, MAX_PART_RETRIES } = await import("../../supabase/functions/analyze-pages/parts.ts");
  const plan = planFor(8);
  check("[бюджет] оценка: в начале 8 фото помещаются; через 520 с часть с повтором (120 с) не начинается; повтор после 400 с из 2+1+3+2 — тоже нет",
    GEN_BUDGET_MS === 600_000 && PART_RETRY_CALL_MS === 120_000 && MAX_PART_RETRIES === 2 && fitsGeneration(0, plan, 0)
      && !fitsGeneration(520_000, retryPlan(plan, 2, "AI_TIMEOUT")!, 2) && !fitsGeneration(400_000, retryPlan(plan, 0, "AI_TIMEOUT")!, 0));
  const r1 = retryPlan(plan, 0, "AI_TIMEOUT")!, r2 = retryPlan(r1, 0, "AI_TIMEOUT")!;
  check("[план] 3 → 2+1, 2 → 1+1, одно фото после долгого ожидания → без повтора, сеть → та же часть; страницы подряд без пропусков",
    planLabel(r1) === "2*+1*+3+2" && planLabel(r2) === "1*+1*+1*+3+2" && retryPlan(r2, 0, "AI_TIMEOUT") === null
      && planLabel(retryPlan(plan, 1, "AI_NETWORK")!) === "3+3*+2"
      && [r1, r2].every((pl) => pl[0].from === 0 && pl[pl.length - 1].to === 8 && pl.every((x, i) => i === 0 || x.from === pl[i - 1].to)));
}

// 1–4 фото — тайм-ауты как раньше: без предела 90 с и без повтора части
reset();
timers.fast = true;
sc.hang = new Set([0]);
{
  const { id, paths } = makeNote(4);
  await start(id, paths);
  const nn = note(id);
  check("[1–4 как v65] 4 фото, модель не ответила: предел 90 с не задан (ожидание — весь бюджет ~140 с), повтора нет, failed AI_TIMEOUT, резерв возвращён",
    !timers.asked.includes(90_000) && timers.asked.some((ms) => ms > 130_000) && sc.calls.length === 1 && sc.continuationHits === 0
      && nn.status === "failed" && nn.error_code === "AI_TIMEOUT" && sim.ledger.get(id) === "refunded" && gensOf(id).length === 1,
    { asked: timers.asked, calls: sc.calls.length, st: nn.status });
}
reset();
{
  const { id, paths } = makeNote(3);
  await start(id, paths);
  check("[1–4 как v65] 3 фото без ошибок: один запрос, без текста про части, предел 90 с не задан, готово",
    note(id).status === "ready" && sc.calls.length === 1 && !/часть \d из/.test(sc.calls[0].prompt) && !timers.asked.includes(90_000));
}

// ответ модели с ошибкой (не тайм-аут) во второй и третьей части — без повтора части
for (const [n, failAt, label] of [[8, 1, "вторая часть"], [8, 2, "третья часть"], [7, 2, "третья часть (3+2+2)"]] as const) {
  reset();
  sc.chatFailOn = failAt;
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  const g = gensOf(id);
  const sizes = partSizes(n);
  check(`[ошибка, ${n} фото, ${label}] HTTP 500 — без повтора части: failed AI_ERROR, резерв возвращён, одна строка ai_generations с токенами готовых частей`,
    nn.status === "failed" && nn.error_code === "AI_ERROR" && sim.ledger.get(id) === "refunded" && sc.calls.length === failAt + 1
      && g.length === 1 && g[0].status === "failed" && g[0].input_tokens === inTok(sizes.slice(0, failAt)) && !nn.content,
    { st: nn.status, err: nn.error_code, l: sim.ledger.get(id), g, calls: sc.calls.length });
}

// ответ на передачу потерян при трёх частях — итог согласован, одна строка ai_generations
reset();
{
  sc.holdContinuation = async (req) => {
    const r = await handler(req);
    void r;
    throw new TypeError("connection reset");
  };
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const nn = note(id);
  check("[8, ответ на передачу потерян] failed CONTINUATION_FAILED, резерв возвращён, конспект не записан, ровно одна строка ai_generations",
    nn.status === "failed" && sim.ledger.get(id) === "refunded" && !nn.content && gensOf(id).length === 1, { st: nn.status, g: gensOf(id).length });
}

// ---------- v66.4: повреждённый JSON — ограниченный ремонт и повтор с местом ошибки ----------
for (const [n, at, label] of [[8, 1, "8 фото, часть 2 (поток)"], [3, 0, "3 фото (обычный путь 1–4)"], [5, 0, "5 фото, часть 1"]] as const) {
  reset();
  sc.badJson = new Map([[at, "double"]]);
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  const heads = nn.content?.sections.map((s: any) => s.heading) || [];
  check(`[JSON, ${label}] две запятые подряд — исправлено без повтора: готово, запросов ${partSizes(n).length}, все разделы и страницы на месте, в лог — тип ошибки`,
    nn.status === "ready" && sc.calls.length === partSizes(n).length && JSON.stringify(heads) === JSON.stringify(Array.from({ length: n }, (_, i) => "Пункт " + (i + 1)))
      && nn.content.meta.pages.length === n && sim.ledger.get(id) === "charged" && gensOf(id).length === 1
      && logs.some((l) => /json repaired/.test(l) && /"kind":"double_comma"/.test(l)) && logs.some((l) => /"json_repaired":1/.test(l)),
    { st: nn.status, err: nn.error_code, calls: sc.calls.length, heads });
}
for (const [n, label] of [[8, "8 фото, часть 1"], [4, "4 фото (обычный путь)"]] as const) {
  reset();
  sc.badJson = new Map([[0, "missing"]]);
  const { id, paths } = makeNote(n);
  await start(id, paths);
  const nn = note(id);
  const retryPromptText = sc.calls[1]?.prompt || "";
  check(`[JSON, ${label}] поле без значения — не угадывается: повтор с местом ошибки (⟪!⟫), «Не копируй прошлый ответ», подсказкой «нет значения»; второй ответ — готово`,
    nn.status === "ready" && sc.calls.length === partSizes(n).length + 1 && JSON.stringify(sc.calls[0].pages) === JSON.stringify(sc.calls[1].pages)
      && /Место ошибки JSON в твоём прошлом ответе/.test(retryPromptText) && /"warnings":⟪!⟫,"z":\[\]/.test(retryPromptText)
      && /Не копируй прошлый ответ/.test(retryPromptText) && /после двоеточия нет значения/.test(retryPromptText)
      && sim.ledger.get(id) === "charged" && gensOf(id).length === 1,
    { st: nn.status, err: nn.error_code, calls: sc.calls.length, p: retryPromptText.slice(0, 300) });
  check(`[JSON, ${label}] фрагмент ответа (текст учебника) в лог не попал: в логе только тип и позиция ошибки`,
    !logs.filter((l) => l.startsWith("[analyze-pages]")).some((l) => l.includes("⟪!⟫") || l.includes("Ученики разбирают") || l.includes("Место ошибки"))
      && logs.some((l) => /"kind":"missing_value"/.test(l)),
    logs.filter((l) => /json|critical/.test(l)).slice(0, 3));
}
reset();
{
  sc.badJson = new Map([[0, "missing"], [1, "missing"]]);
  const { id, paths } = makeNote(8);
  await start(id, paths);
  const nn = note(id);
  check("[JSON, 8 фото] неисправимый JSON дважды — failed AI_BAD_JSON без повтора части (это не тайм-аут), резерв возвращён, фото сохранены, одна строка ai_generations",
    nn.status === "failed" && nn.error_code === "AI_BAD_JSON" && sc.calls.length === 2 && sc.continuationHits === 0 && sim.ledger.get(id) === "refunded"
      && paths.every((p) => sim.files.has(p)) && gensOf(id).length === 1 && gensOf(id)[0].status === "failed",
    { st: nn.status, err: nn.error_code, calls: sc.calls.length });
}

// подделанное продолжение с верной подписью: неверная форма → 400; неверные готовые части или исчерпанный бюджет → failed без ИИ
reset();
{
  const { signContinuation, planFor } = await import("../../supabase/functions/analyze-pages/parts.ts");
  const { id, paths } = makeNote(8);
  sim.notes.get(id)!.stage = "analyzing";
  const plan = planFor(8);
  const base = { note_id: id, user_id: "u1", paths, handoff_at: String(sim.notes.get(id)!.updated_at), exp: Date.now() + 60_000, t0: Date.now(),
    acc: { input: 0, output: 0, ms: 0, attempts: 0, model: "", provider: "" }, plan, retries: 0 };
  const prev2 = { sections: [], meta: { pages: [{}, {}, {}] } };
  const bad = [
    { ...base, part: 0, prev: null },
    { ...base, part: 3, prev: prev2 },
    { ...base, part: 1, prev: null },
    { ...base, paths: paths.slice(0, 4), plan: [{ from: 0, to: 2 }, { from: 2, to: 4 }], part: 1, prev: prev2 },
    { ...base, part: 1, prev: prev2, plan: [{ from: 0, to: 4 }, { from: 4, to: 8 }] },
    { ...base, part: 1, prev: prev2, plan: [{ from: 0, to: 3 }, { from: 4, to: 8 }] },
    { ...base, part: 1, prev: prev2, plan: [{ from: 0, to: 3 }, { from: 3, to: 6 }] },
    { ...base, part: 1, prev: prev2, retries: 3 },
    { ...base, part: 1, prev: prev2, t0: undefined },
    { ...base, part: 1, prev: prev2, plan: undefined },
  ];
  const st: number[] = [];
  for (const c of bad) {
    const s2 = await signContinuation("svc-secret-test", c as never);
    st.push((await post(JSON.stringify({ continuation: s2.payload, sig: s2.sig }))).status);
  }
  await settle();
  check("[продолжение] с верной подписью неверная форма → 400: первая часть не как повтор, часть вне плана, без готовых частей, 1–4 страницы, " +
    "часть больше 3 фото, пропуск или нехватка страниц в плане, больше 2 повторов, без времени запуска, без плана",
    st.length === 10 && st.every((x) => x === 400) && sc.calls.length === 0, st);
}
for (const [label, patch, code, re] of [
  ["готовые части не совпадают с началом части (2 страницы вместо 3)", { prev: { sections: [], meta: { pages: [{}, {}] } } }, "CONTINUATION_FAILED", /do not match/],
  ["генерация идёт уже 590 с — часть не уложится в 10 мин", { t0: -590_000 }, "AI_TIMEOUT", /generation budget exhausted before part 2/],
] as const) {
  reset();
  const { signContinuation, planFor } = await import("../../supabase/functions/analyze-pages/parts.ts");
  const { id, paths } = makeNote(8);
  sim.ledger.set(id, "reserved");
  sim.notes.get(id)!.stage = "analyzing";
  const c: any = { note_id: id, user_id: "u1", paths, handoff_at: String(sim.notes.get(id)!.updated_at), exp: Date.now() + 60_000, t0: Date.now(),
    acc: { input: 0, output: 0, ms: 0, attempts: 0, model: "", provider: "" }, plan: planFor(8), retries: 0, part: 1,
    prev: { sections: [], meta: { pages: [{}, {}, {}] } }, ...patch };
  if (c.t0 < 0) c.t0 = Date.now() + c.t0;
  const s2 = await signContinuation("svc-secret-test", c);
  const r = await post(JSON.stringify({ continuation: s2.payload, sig: s2.sig }));
  await settle();
  const nn = note(id);
  check(`[продолжение] ${label}: ИИ не вызывается, failed ${code}, резерв возвращён, фото сохранены`,
    r.status === 202 && sc.calls.length === 0 && nn.status === "failed" && nn.error_code === code && sim.ledger.get(id) === "refunded"
      && paths.every((p) => sim.files.has(p)) && logs.some((l) => re.test(l)),
    { r: r.status, st: nn.status, err: nn.error_code, l: sim.ledger.get(id) });
}

console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (имитация Supabase и GigaChat; настоящий ИИ не вызывался)`);
Deno.exit(fail ? 1 : 0);
