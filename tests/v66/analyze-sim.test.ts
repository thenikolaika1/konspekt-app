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
};
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const filler = "Ученики разбирают этот пункт учебника подробно, с определениями, примерами и выводами по каждому абзацу страницы. ";
function contentFor(pages: number[], prompt: string) {
  const second = /часть 2 из 2/.test(prompt);
  const sections = pages.map((p, i) => ({
    heading: sc.continueHeading && second && i === 0 ? "Пункт " + (p - 1) : "Пункт " + p,
    blocks: [{ type: "PARAGRAPH", text: "**Страница " + p + "**: Термин " + p + " и Общий термин. " + filler + filler, sourcePage: i }],
  }));
  return {
    meta: { title: second ? "Другое название" : "§ 5. Тема из восьми страниц", subject: "physics", pages: pages.map((_, i) => ({ index: i, readable: "ok" })), sourceOutline: sections.map((s) => s.heading) },
    lead: second ? "" : "Главное по теме.",
    sections,
    glossary: { terms: [...pages.map((p) => ({ term: "Термин " + p, definition: "Определение термина со страницы " + p + "." })), { term: "Общий термин", definition: "Есть в обеих частях." }], dates: [], people: [], formulas: [] },
    remember: pages.map((p) => "Факт со страницы " + p),
    conclusion: /итог ВСЕЙ темы/.test(prompt) ? "Итог всей темы." : "Итог части.",
    selfCheck: pages.map((p) => ({ q: "Вопрос по странице " + p + "?", a: "Ответ " + p + "." })),
    warnings: [],
  };
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
    sc.calls.push({ pages, prompt });
    if (sc.calls.length - 1 === sc.chatFailOn) return jsonRes(500, { message: "boom" });
    return jsonRes(200, {
      model: "GigaChat-2-Max:2.0", choices: [{ message: { content: JSON.stringify(contentFor(pages, prompt)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2700 + 1930 * pages.length, completion_tokens: 300 * pages.length },
    });
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
};
const note = (id: string) => sim.notes.get(id) as any;
const plainText = (c: any) => JSON.stringify(c.sections);

// ---------- 1–8 страниц ----------
for (let n = 1; n <= 8; n++) {
  reset();
  const gensBefore = sim.gens.length, startsBefore = sim.starts.length;
  const { id, paths } = makeNote(n);
  const r = await start(id, paths);
  const nn = note(id);
  const c = nn.content;
  const expectedParts = n <= 4 ? [n] : [Math.ceil(n / 2), n - Math.ceil(n / 2)];
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
    check(`[${n}] вторая часть: промпт «часть 2 из 2», оглавление и термины первой части, итог всей темы`,
      /часть 2 из 2/.test(sc.calls[1].prompt) && sc.calls[1].prompt.includes("«Пункт 1»") && sc.calls[1].prompt.includes("Термин 1")
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
  check("[лимит базы 4, владелец] 8 страниц: разрешено только владельцу — готово, 2 части, одно списание, в лимит базы ушло 4",
    r.status === 202 && note(id).status === "ready" && sc.calls.length === 2 && sim.ledger.get(id) === "charged"
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
  const p4 = note(id).content.sections.find((s: any) => s.heading === "Пункт 4");
  check("[8] пункт 4 продолжается на странице 5: один раздел «Пункт 4» с текстом страниц 4 и 5, дальше «Пункт 6…8»",
    JSON.stringify(heads) === JSON.stringify(["Пункт 1", "Пункт 2", "Пункт 3", "Пункт 4", "Пункт 6", "Пункт 7", "Пункт 8"])
      && JSON.stringify(p4.blocks).includes("Страница 4") && JSON.stringify(p4.blocks).includes("Страница 5"), heads);
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
    && g[0].input_tokens === 2700 + 1930 * 4 && g[0].page_count === 8, g);
}
reset();
{
  const startsBefore = sim.starts.length;
  await start(failed2.id, failed2.paths);
  check("[8, повтор после ошибки] снова обе части, ready, списано один раз (charged)", note(failed2.id).status === "ready"
    && sim.ledger.get(failed2.id) === "charged" && sim.starts.length - startsBefore === 1 && sc.calls.length === 2);
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
    sc.calls.length === 2 && note(d.id).status === "ready" && sim.ledger.get(d.id) === "charged", { s: second.status, calls: sc.calls.length, st: note(d.id).status, l: sim.ledger.get(d.id) });
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

console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (имитация Supabase и GigaChat; настоящий ИИ не вызывался)`);
Deno.exit(fail ? 1 : 0);
