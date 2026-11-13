// v66: для 1–4 фото analyze-pages v66 ведёт себя как production v33 — печатает след 32 сценариев (TRACE), run.sh сравнивает с dab1677
// Настоящий ИИ, Supabase и production не вызываются. Проверяет: 1–4 фото — один запрос, страницы по порядку, одно списание;
// 5 и больше — TOO_MANY_PAGES у всех, включая владельца; двойной запуск; чужие пути; ошибка ИИ — возврат; повтор.
// Запуск: deno run --allow-env --allow-read --allow-net=sim.local --import-map=tests/v66r/import_map.json tests/v66r/release-analyze.test.ts
//   FN_DIR=путь — проверить другую копию функции (негативный контроль: исходная v33 должна провалить проверки владельца)
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
let micro = 0; const FIXED = 1794400000000;
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
type Call = { pages: number[]; prompt: string; notes: string[] };
const sc = {
  calls: [] as Call[], uploads: 0, fileToPage: new Map<string, number>(), fileToNote: new Map<string, string>(), continuationHits: 0,
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
  /** v66.7: настоящая пауза между фрагментами потока (мс) — проверка, что медленный, но идущий ответ сторож не обрывает */
  chunkDelayMs: 0,
  /** v66.8: вызовы, где часть повторяет все разделы готовых частей (как ce2880ac) / копирует один абзац во все разделы (22bea179) */
  repeatPrev: new Set<number>(),
  dupPara: new Set<number>(),
  /** v66.8: сколько первых запросов на удаление файла GigaChat отклонить (файл ещё занят после обрыва ответа) */
  deleteFail: 0,
  /** v34.1: вызовы, где модель отвечает JSON без разделов и терминов (как стр. 4 в fbd4eba6, 09.11.2026) */
  empty: new Set<number>(),
  /** адреса, по которым функция вызвала следующую часть */
  contUrls: [] as string[],
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
    async pull(ctl) {
      if (sc.chunkDelayMs && i > 0) await new Promise((r) => realSetTimeout(r, sc.chunkDelayMs));
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
    sc.contUrls.push(u);
    if (sc.selfStatus) return jsonRes(sc.selfStatus, { error: "x" });
    const req = new Request(u, init);
    if (sc.holdContinuation) return sc.holdContinuation(req);
    return handler(req);
  }
  if (u.includes("/oauth")) return jsonRes(200, { access_token: "t", expires_at: Date.now() + 3_600_000 });
  if (u.endsWith("/files") && init.method === "POST") {
    const file = (init.body as FormData).get("file") as File;
    // в каждом фото — номер страницы и задание (note), которому оно принадлежит: «PAGE:3|<8 знаков id>»
    const [pageStr, noteTag = ""] = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer())).replace("PAGE:", "").split("|");
    const page = Number(pageStr);
    const id = "f" + ++sc.uploads;
    sc.fileToPage.set(id, page);
    sc.fileToNote.set(id, noteTag);
    return jsonRes(200, { id });
  }
  if (/\/files\/[^/]+\/delete$/.test(u)) {
    if (sc.deleteFail > 0) return (sc.deleteFail--, jsonRes(409, { message: "file is in use" }));
    return (sc.deleted++, jsonRes(200, { deleted: true }));
  }
  if (u.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init.body));
    const pages: number[] = body.messages.filter((m: any) => m.attachments).map((m: any) => sc.fileToPage.get(m.attachments[0])!);
    const prompt = body.messages.filter((m: any) => !m.attachments && m.role === "user").map((m: any) => m.content).join("\n");
    const system = body.messages.find((m: any) => m.role === "system")?.content || "";
    sc.systems.push(system);
    const callNotes: string[] = body.messages.filter((m: any) => m.attachments).map((m: any) => sc.fileToNote.get(m.attachments[0]) ?? "?");
    sc.calls.push({ pages, prompt, notes: callNotes });
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
    if (sc.empty.has(k)) {
      return reply(JSON.stringify({ meta: { title: "Вопросы и задания", subject: "physics", pages: pages.map((_, i) => ({ index: i, readable: "ok" })), sourceOutline: [] },
        lead: "", sections: [], glossary: { terms: [], dates: [], people: [], formulas: [] }, remember: [], conclusion: "", selfCheck: [], warnings: [] }), 95);
    }
    // модель: на одних титульных листах текста нет — отказ; титульный лист среди страниц с текстом — отказ при
    // прежней инструкции, конспект по остальным при новой («НЕ причина для отказа»)
    const titled = pages.some((p) => sc.titles.has(p));
    const allTitles = pages.every((p) => sc.titles.has(p));
    if (sc.refuse.has(k) || allTitles || (titled && !/НЕ причина для отказа/.test(system))) return reply(shortRefusal(), 23);
    const made = contentFor(pages, prompt) as any;
    const tags = [...new Set(callNotes)];
    made.sections.forEach((x: any) => x.blocks.forEach((b: any) => { if (typeof b.text === "string") b.text += " Метка задания: " + tags.join("+") + "."; }));
    if (sc.repeatPrev.has(k)) {
      // модель переписала оглавление темы: разделы готовых частей с «новым» текстом этих страниц, затем свои
      const prev = [...(prompt.match(/УЖЕ ГОТОВЫ[^:]*: ([^\n]*)/)?.[1] || "").matchAll(/«([^»]+)»/g)].map((m) => m[1]);
      made.sections = [
        ...prev.map((h, i) => ({ heading: h, blocks: [{ type: "PARAGRAPH", text: "Со страницы " + pages[0] + " про " + h + ": уникальная фраза номер " + i + " о свойствах, примерах и выводах этого пункта." }] })),
        ...made.sections,
      ];
      made.meta.sourceOutline = made.sections.map((x: any) => x.heading);
    }
    if (sc.dupPara.has(k)) {
      const para = "Один и тот же абзац, скопированный моделью под каждый заголовок: про строение, функции и значение объекта, с примерами и выводами для ученика.";
      made.sections = made.sections.map((x: any) => ({ ...x, blocks: [{ type: "PARAGRAPH", text: para }] }));
    }
    let json = JSON.stringify(made);
    if (sc.badJson.get(k) === "double") json = json.replace(',"sections":', ',,"sections":');
    if (sc.badJson.get(k) === "missing") json = json.replace('"warnings":[]', '"warnings":,"z":[]');
    return reply(json, 300 * pages.filter((p) => !sc.titles.has(p)).length);
  }
  return jsonRes(404, {});
};

const FN_DIR = Deno.env.get("FN_DIR") || "../../supabase/functions/analyze-pages";
await import(FN_DIR + "/index.ts"); // обработчик
sim.maxPages = 4; // как в production: private.ai_limits.max_pages = 4

let noteN = 0;
function makeNote(n: number, user = "u1") {
  const id = crypto.randomUUID();
  noteN++;
  sim.notes.set(id, { id, user_id: user, status: "processing", stage: "uploading", error_code: null, updated_at: sim.clock(), content: null });
  const paths: string[] = [];
  for (let p = 1; p <= n; p++) {
    const path = user + "/" + id + "/" + String(p).padStart(2, "0") + "-pg" + p + ".jpg";
    sim.files.set(path, new TextEncoder().encode("PAGE:" + p + "|" + id.slice(0, 8)));
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
  sc.calls = []; sc.chatFailOn = -1; sc.badJson = new Map(); sc.hang = new Set(); sc.contUrls = []; sc.continuationHits = 0;
  timers.fast = false; logs.length = 0;
};
const note = (id: string) => sim.notes.get(id) as any;
const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);



// дифференциальный прогон: одинаковые сценарии 1–4 фото, вывод — нормализованный след (запросы к ИИ и итог)
const out: unknown[] = [];
const norm = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\b[0-9a-f]{8}\b/g, "<tag>");
const scen: [string, number, string, () => void][] = [];
for (const [tok, uid] of [["tok-u1", "u1"], ["tok-owner", "u-owner"]]) for (let n = 1; n <= 4; n++) {
  scen.push([tok, n, uid, () => {}]);
  scen.push([tok, n, uid, () => { sc.badJson = new Map([[0, "double"]]); }]);
  scen.push([tok, n, uid, () => { sc.chatFailOn = 0; }]);
  scen.push([tok, n, uid, () => { sc.refuse = new Set([0]); }]);
}
for (const [tok, n, uid, setup] of scen) {
  reset(); sc.refuse = new Set(); sc.systems = []; setup();
  const { id, paths } = makeNote(n, uid);
  const r = await start(id, paths, tok);
  const nn = note(id);
  out.push(norm(JSON.stringify({ tok, n, http: r.status, body: r.body?.error ?? r.body?.status, status: nn.status, code: nn.error_code, ledger: sim.ledger.get(id),
    calls: sc.calls.map((c) => ({ pages: c.pages, prompt: c.prompt })), systems: sc.systems, content: nn.content,
    start: sim.starts.at(-1), cont: sc.continuationHits, files: paths.filter((p) => sim.files.has(p)).length })));
}
console.log("TRACE " + JSON.stringify(out));
Deno.exit(0);
