// Тест загрузки страниц в GigaChat (providers.ts) с имитацией GigaChat API. Время ускорено в SCALE раз:
// 1 мс теста = SCALE мс реального времени. Настоящий GigaChat не вызывается.
// Запуск: node --experimental-transform-types tests/v62/giga-upload.test.mjs [путь к providers.ts]
import { fileURLToPath } from "node:url";
const SCALE = 100;
const realMs = (ms) => Math.round(ms * SCALE);
const providersPath = process.argv[2] || fileURLToPath(new URL("../../supabase/functions/analyze-pages/providers.ts", import.meta.url));

globalThis.Deno = {
  env: { get: (k) => ({ GIGACHAT_AUTH_KEY: "test-key" })[k] }, // только GigaChat, как в production
  createHttpClient: () => ({}),
};

let sc; // сценарий текущего теста
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true });
});
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url), signal = init.signal;
  if (u.includes("/oauth")) return jsonRes(200, { access_token: "tok", expires_at: Date.now() + 3_600_000 });
  if (u.endsWith("/files") && init.method === "POST") {
    const file = init.body.get("file");
    const page = Number(/page-(\d+)/.exec(file.name)[1]);
    sc.uploadCalls.push(page);
    sc.active++; sc.maxActive = Math.max(sc.maxActive, sc.active);
    try {
      const step = sc.upload(page, sc.uploadCalls.filter((p) => p === page).length);
      if (step.hang) await sleep(1e9, signal);
      await sleep(step.ms, signal);
      if (step.status) return jsonRes(step.status, { status: step.status, message: "Too Many Requests" });
      const id = "f" + page + "-" + sc.uploadCalls.length;
      sc.uploaded.push(id);
      return jsonRes(200, { id });
    } finally { sc.active--; }
  }
  if (u.endsWith("/chat/completions")) {
    sc.chatBody = JSON.parse(init.body);
    await sleep(sc.chatMs, signal);
    return jsonRes(200, { model: "GigaChat-2-Max:2.0", choices: [{ message: { content: "{\"ok\":1}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
  if (/\/files\/[^/]+\/delete$/.test(u)) { sc.deleted.push(decodeURIComponent(u.split("/files/")[1].split("/")[0])); return jsonRes(200, {}); }
  throw new Error("unexpected url " + u);
};

const P = await import(providersPath);
const { GIGACHAT, TIMEOUTS, generate, newGigaSession, closeGigaSession, ProviderError } = P;
// ускоряем только время (те же соотношения, что в коде); uploadConcurrency и число попыток — из кода
const orig = { ...GIGACHAT, ...TIMEOUTS };
GIGACHAT.uploadRequestMaxMs = orig.uploadRequestMaxMs / SCALE;
GIGACHAT.cleanupMs = orig.cleanupMs / SCALE;
TIMEOUTS.primaryMaxMs = orig.primaryMaxMs / SCALE;
TIMEOUTS.fallbackReserveMs = orig.fallbackReserveMs / SCALE;
TIMEOUTS.lastReserveMs = orig.lastReserveMs / SCALE;
TIMEOUTS.minCallMs = orig.minCallMs / SCALE;
const BUDGET_MS = 140_000; // index.ts

const img = (n) => "data:image/jpeg;base64," + Buffer.from("page" + n).toString("base64");
const messages = (pages) => [
  { role: "system", content: "s" },
  { role: "user", content: [...Array.from({ length: pages }, (_, i) => ({ type: "image_url", image_url: { url: img(i + 1) } })), { type: "text", text: "t" }] },
];

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name + (extra ? " — " + extra : "")); };

async function run({ pages, upload, chatMs = 530, budget = BUDGET_MS }) {
  sc = { upload, chatMs, uploadCalls: [], uploaded: [], deleted: [], active: 0, maxActive: 0, chatBody: null };
  const giga = newGigaSession();
  const t0 = Date.now();
  let reply = null, error = null;
  try { reply = await generate(messages(pages), t0 + budget / SCALE, undefined, giga); } catch (e) { error = e; }
  const elapsed = realMs(Date.now() - t0);
  await closeGigaSession(giga);
  return { reply, error, elapsed, ...sc };
}

console.log("uploadConcurrency в коде = " + orig.uploadConcurrency + ", uploadAttempts = " + orig.uploadAttempts +
  ", uploadRequestMaxMs = " + orig.uploadRequestMaxMs + ", primaryMaxMs = " + orig.primaryMaxMs);
check("G0. uploadConcurrency = 1, остальные настройки без изменений", orig.uploadConcurrency === 1 && orig.uploadAttempts === 2 &&
  orig.uploadRequestMaxMs === 25_000 && orig.primaryMaxMs === 100_000 && orig.fallbackReserveMs === 30_000 && orig.cleanupMs === 8_000);

// G1–G3: обычные загрузки — строго по одной, по порядку страниц, вложения в chat в том же порядке
for (const pages of [2, 4, 7]) {
  const r = await run({ pages, upload: () => ({ ms: 80 }) }); // 8 с на страницу
  const order = r.chatBody?.messages.filter((m) => m.attachments).map((m) => m.attachments[0].split("-")[0]);
  check("G" + pages + "a. " + pages + " стр.: одновременно не больше 1 загрузки", r.maxActive === 1, "максимум " + r.maxActive);
  check("G" + pages + "b. " + pages + " стр.: порядок загрузки и вложений = порядок страниц",
    r.uploadCalls.join() === Array.from({ length: pages }, (_, i) => i + 1).join() && order?.join() === Array.from({ length: pages }, (_, i) => "f" + (i + 1)).join());
  check("G" + pages + "c. " + pages + " стр.: ответ получен, все файлы удалены", !!r.reply && r.deleted.length === pages, "время ~" + Math.round(r.elapsed / 1000) + " с");
}

// G4: контроль теста — со старым значением 3 те же 4 страницы шли бы по 3 одновременно
GIGACHAT.uploadConcurrency = 3;
{ const r = await run({ pages: 4, upload: () => ({ ms: 80 }) }); check("G4. контроль: при значении 3 было бы 3 одновременных загрузки", r.maxActive === 3, "максимум " + r.maxActive); }
GIGACHAT.uploadConcurrency = orig.uploadConcurrency;

// G5: зависшая страница 2 — повтор один раз, затем AI_TIMEOUT; страницы 3–4 не загружаются
{
  const r = await run({ pages: 4, upload: (p) => (p === 2 ? { hang: true } : { ms: 50 }) });
  check("G5a. зависание стр. 2: AI_TIMEOUT", r.error instanceof ProviderError && r.error.code === "AI_TIMEOUT", r.error?.detail);
  check("G5b. зависание стр. 2: ровно 2 попытки стр. 2, стр. 3–4 не начинались", r.uploadCalls.join() === "1,2,2", r.uploadCalls.join());
  check("G5c. зависание стр. 2: ~5 + 25 + 25 = 55 с, файл стр. 1 удалён", Math.abs(r.elapsed - 55_000) < 3_000 && r.deleted.length === 1, Math.round(r.elapsed / 1000) + " с");
}

// G6: HTTP 429 на загрузке — сразу AI_RATE_LIMITED, без повтора и без следующих страниц
{
  const r = await run({ pages: 3, upload: (p) => (p === 1 ? { ms: 22, status: 429 } : { ms: 50 }) });
  check("G6a. 429: AI_RATE_LIMITED", r.error instanceof ProviderError && r.error.code === "AI_RATE_LIMITED");
  check("G6b. 429: одна попытка, другие страницы не загружались", r.uploadCalls.join() === "1", r.uploadCalls.join());
}

// G7: общий лимит. Каждая страница по 24 с (почти до лимита 25 с), 7 стр. — генерация обрывается на сроке, а не позже
{
  const r = await run({ pages: 7, upload: () => ({ ms: 240 }) });
  check("G9a. 7 стр. по 24 с: AI_TIMEOUT", r.error?.code === "AI_TIMEOUT", r.error?.detail);
  check("G9b. 7 стр. по 24 с: остановка не позже срока 140 с", r.elapsed <= BUDGET_MS + 1_500, Math.round(r.elapsed / 1000) + " с");
}

// G8: 4 стр. по 12 с + chat 53 с (худшее из удачного в логах) — укладывается
{ const r = await run({ pages: 4, upload: () => ({ ms: 120 }), chatMs: 530 });
  check("G10. 4 стр. по 12 с + chat 53 с: успех", !!r.reply, Math.round(r.elapsed / 1000) + " с"); }

console.log("ИТОГО: " + pass + " PASS, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
