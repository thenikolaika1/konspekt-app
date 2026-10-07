/**
 * Edge Function analyze-pages: фотографии страниц (private bucket temp-pages) → AI-провайдер
 * (основной GigaChat-2-Max, резервные OpenRouter и Z.AI — см. providers.ts) → StudyContent v1 → public.notes.content.
 *
 * Запрос: POST { note_id, paths[] } с заголовком Authorization: Bearer <JWT пользователя>.
 * Ответ сразу 202 { status: "processing" }; сама генерация идёт в фоне (EdgeRuntime.waitUntil),
 * поэтому закрытие PWA её не прерывает. Клиент узнаёт результат по notes.status.
 *
 * Секреты только из окружения функции:
 *   GIGACHAT_AUTH_KEY, OPENROUTER_API_KEY, ZAI_API_KEY — Edge Function Secrets (заданы вручную);
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY — Supabase передаёт сам.
 * Ключи и фотографии в лог не пишутся.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { SYSTEM_PROMPT, retryPrompt, userPrompt } from "./prompt.ts";
import { type ChatMessage, closeGigaSession, configuredProviders, generate, newGigaSession, ProviderError, type ProviderId, TIMEOUTS } from "./providers.ts";
import { criticalIssues, extractJson, previewOf, qualityIssues, sanitize, SCHEMA_VERSION, type StudyContent, validateStudyContent } from "./study-content.ts";

const BUCKET = "temp-pages";
const MAX_PAGES = 8;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// генерация, которая «висит» в analyzing дольше этого, считается прерванной — её можно запустить снова
const STALE_MS = 5 * 60_000;
// резерв операции лимита (F&F) живёт дольше бюджета генерации: если функцию прервали, резерв истечёт сам
const LEASE_S = 600;
// общий бюджет фоновой работы: меньше лимита времени Edge Function (150 с на бесплатном плане)
const BUDGET_MS = 140_000;
// повторный запрос к модели делаем, только если на него остаётся не меньше этого времени
const MIN_RETRY_MS = 45_000;
// и не меньше, чем длилась предыдущая попытка, с запасом: GigaChat с тем же промптом отвечает примерно столько же
const RETRY_SLACK = 1.2;
// GigaChat (Freemium), qwen/qwen3.8-27b:free и GLM-4.6V-Flash бесплатны; при смене модели здесь указывается цена за 1M токенов
const PRICE_PER_M = { input: 0, output: 0 };

const ALLOWED_ORIGINS = ["https://thenikolaika1.github.io"];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

class StepError extends Error {
  constructor(public code: string, public detail = "") {
    super(code);
  }
}

// ---------- HTTP ----------

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const json = (status: number, body: unknown, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  // проекты на новых API-ключах: {"default":"sb_secret_…"}
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || "";
  } catch {
    return "";
  }
}

function publicKey(): string {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    return keys.default || "";
  } catch {
    return "";
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const adminKey = serviceKey();
  const providers = configuredProviders();
  if (!url || !adminKey || !providers.length) {
    console.error("[analyze-pages] server misconfigured:", { url: !!url, serviceKey: !!adminKey, providers: providers.length });
    return json(500, { error: "SERVER_MISCONFIGURED" }, cors);
  }

  // 1–2. JWT пользователя обязателен; пользователя определяет Supabase Auth
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "UNAUTHORIZED" }, cors);
  const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return json(401, { error: "UNAUTHORIZED" }, cors);

  // 3. вход: note_id и пути фотографий в порядке страниц
  let body: { note_id?: unknown; paths?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_REQUEST" }, cors);
  }
  const noteId = typeof body.note_id === "string" ? body.note_id : "";
  const paths = Array.isArray(body.paths) ? body.paths : [];
  if (!UUID.test(noteId)) return json(400, { error: "BAD_REQUEST" }, cors);
  if (!paths.length) return json(400, { error: "NO_PAGES" }, cors);
  if (paths.length > MAX_PAGES) return json(400, { error: "TOO_MANY_PAGES" }, cors);

  // 5. каждый путь — только внутри папки {user}/{note}/, без подпапок и «..»
  const prefix = user.id + "/" + noteId + "/";
  const okPath = (p: unknown): p is string =>
    typeof p === "string" && p.startsWith(prefix) && FILE_NAME.test(p.slice(prefix.length)) && !p.includes("..");
  if (!paths.every(okPath) || new Set(paths).size !== paths.length) return json(403, { error: "FORBIDDEN_PATH" }, cors);

  // 4. note существует и принадлежит этому пользователю
  const { data: note, error: noteError } = await admin
    .from("notes")
    .select("id,user_id,status,stage,updated_at")
    .eq("id", noteId)
    .maybeSingle();
  if (noteError) {
    console.error("[analyze-pages] note lookup failed:", noteError.message);
    return json(500, { error: "INTERNAL" }, cors);
  }
  if (!note || note.user_id !== user.id) return json(404, { error: "NOT_FOUND" }, cors);
  if (note.status === "ready") return json(200, { status: "ready", note_id: noteId }, cors);

  // место для будущего лимита генераций (сейчас лимита нет — Friends & Family MVP)
  const quota = await checkQuota(admin, user.id);
  if (quota) return json(429, { error: quota }, cors);

  // Атомарно в одной транзакции (start_text_generation, только service_role): захват note из uploading/failed
  // или из «зависшей» генерации и резерв одной операции лимита раннего доступа (op = note_id).
  // Второй одновременный запрос по той же note получит already_processing — второй платной генерации не будет;
  // повтор той же note не занимает второй слот. Итог резерва фиксирует триггер на notes.status:
  // ready → списан, failed → возвращён. Без права или при исчерпанном лимите AI не запускается.
  const { data: start, error: startError } = await admin.rpc("start_text_generation", {
    p_user_id: user.id,
    p_note_id: noteId,
    p_stale_seconds: STALE_MS / 1000,
    p_lease_seconds: LEASE_S,
  });
  if (startError) {
    console.error("[analyze-pages] start failed:", startError.message);
    return json(500, { error: "INTERNAL" }, cors);
  }
  const result = typeof start?.result === "string" ? start.result : "";
  if (result === "ready") return json(200, { status: "ready", note_id: noteId }, cors);
  if (result === "not_found") return json(404, { error: "NOT_FOUND" }, cors);
  if (result === "already_processing") return json(409, { error: "ALREADY_PROCESSING" }, cors);
  if (result === "no_access" || result === "limit_reached") {
    const code = result === "no_access" ? "NO_ACCESS" : "LIMIT_REACHED";
    // note не остаётся «создаётся»: failed с причиной, фотографии сохраняются для повтора, когда доступ появится
    const { error: markError } = await admin
      .from("notes")
      .update({ status: "failed", stage: "failed", error_code: code, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("user_id", user.id)
      .or("status.eq.failed,stage.is.null,stage.neq.analyzing");
    if (markError) console.warn("[analyze-pages] could not mark " + code + ":", markError.message);
    return json(403, { error: code }, cors);
  }
  if (result !== "started") {
    // already_consumed (операция списана, а note не ready) и неизвестный ответ: AI не запускаем
    console.error("[analyze-pages] start refused:", result || "no result");
    return json(409, { error: result === "already_consumed" ? "ALREADY_CONSUMED" : "INTERNAL" }, cors);
  }

  // Хранилище читаем от имени пользователя: RLS Storage дополнительно проверяет, что это его файлы
  const anon = publicKey();
  const storageClient = anon
    ? createClient(url, anon, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    : admin;

  const task = processNote({ admin, storage: storageClient, userId: user.id, noteId, paths });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task);
  else await task;
  return json(202, { status: "processing", note_id: noteId }, cors);
});

// ---------- генерация ----------

/**
 * Хватит ли оставшегося времени на полноценный повтор: провайдер повтора получит
 * min(primaryMaxMs, осталось − резерв на резервные провайдеры), и этого должно хватить
 * на попытку не короче MIN_RETRY_MS и не короче предыдущей попытки с запасом.
 */
export function retryFits(remainingMs: number, lastAttemptMs: number): boolean {
  const providerMs = Math.min(TIMEOUTS.primaryMaxMs, remainingMs - TIMEOUTS.fallbackReserveMs);
  return providerMs >= Math.max(MIN_RETRY_MS, lastAttemptMs * RETRY_SLACK);
}

function checkQuota(_admin: SupabaseClient, _userId: string): Promise<string | null> {
  // Лимит можно включить позже, например: число строк ai_generations пользователя за сутки
  // больше N → return "RATE_LIMITED". Сейчас генерации не ограничены.
  return Promise.resolve(null);
}

type Job = {
  admin: SupabaseClient;
  storage: SupabaseClient;
  userId: string;
  noteId: string;
  paths: string[];
};

/** Как Promise.all(items.map(fn)), но не больше limit одновременно; порядок результатов сохраняется. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Код ошибки для конспекта, который так и остался критически плохим. */
const criticalCode = (issues: { code: string }[]) => (issues.some((i) => i.code === "BROKEN_TEXT") ? "UNREADABLE_PAGES" : "EMPTY_CONTENT");

type Candidate = { content: StudyContent; critical: { code: string; text: string }[]; issues: string[]; model: string; provider: ProviderId };
/** Лучший из вариантов: меньше критических проблем, затем меньше некритических (при равенстве — более новый). */
const better = (a: Candidate, b: Candidate | null) =>
  !b || a.critical.length < b.critical.length || (a.critical.length === b.critical.length && a.issues.length <= b.issues.length);

async function processNote(job: Job) {
  const { admin, storage, noteId, userId, paths } = job;
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const usage = { input: 0, output: 0, model: "" };
  const giga = newGigaSession();
  // безопасные метрики времени: только числа, имена провайдеров и коды — без ключей, токенов, изображений и текста
  const m = {
    page_count: paths.length, storage_ms: 0, oauth_ms: 0, upload_ms: 0, chat_ms: 0, parse_ms: 0, quality_ms: 0,
    sanitize_ms: 0, retry_ms: 0, save_ms: 0, cleanup_ms: 0, total_ms: 0, attempts: 0, provider: "", model: "",
    retry_used: false, fallback_used: false, critical: 0, minor: 0, input_tokens: 0, output_tokens: 0, status: "", error_code: "",
  };
  let aiCalled = false;
  let t = Date.now();

  try {
    // 6. фотографии из private bucket, в порядке страниц (до 4 одновременно)
    const images = await mapLimit(paths, 4, async (path) => {
      const { data, error } = await storage.storage.from(BUCKET).download(path);
      if (error || !data) throw new StepError("STORAGE_READ_FAILED", error?.message || "no data");
      if (data.size > MAX_IMAGE_BYTES) throw new StepError("IMAGE_TOO_LARGE");
      const mime = /^image\/(jpeg|png|webp)$/.test(data.type) ? data.type : "image/jpeg";
      return "data:" + mime + ";base64," + encodeBase64(new Uint8Array(await data.arrayBuffer()));
    });
    m.storage_ms = Date.now() - t;

    // 7–10. все страницы одним запросом; строгий JSON. Повтор — только при критических проблемах
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          { type: "text" as const, text: userPrompt(images.length) },
        ],
      },
    ];

    // model — модель, которая дала этот вариант (в ai_generations пишется модель итогового конспекта)
    let best: Candidate | null = null;
    let last: ReturnType<typeof validateStudyContent> | null = null;
    // повтор идёт к тому же провайдеру (GigaChat переиспользует загруженные страницы); резервный — только при ошибке провайдера
    let used: ProviderId | undefined;
    let lastMs = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && !retryFits(deadline - Date.now(), lastMs)) {
        // полноценный повтор не успеет — заведомо обречённый запрос не начинаем
        console.warn("[analyze-pages] retry skipped: not enough time (" + (deadline - Date.now()) + " ms left, last attempt " + lastMs + " ms)");
        break;
      }
      aiCalled = true;
      m.attempts++;
      if (attempt > 0) m.retry_used = true;
      let reply;
      const attemptStarted = Date.now();
      try {
        reply = await generate(messages, deadline, used, giga);
      } catch (e) {
        if (attempt > 0) m.retry_ms = Date.now() - attemptStarted;
        // повтор не удался из-за провайдеров — остаётся уже полученный вариант
        if (best && e instanceof ProviderError) {
          console.warn("[analyze-pages] retry failed:", e.code, "— keeping first result");
          break;
        }
        throw e;
      }
      lastMs = Date.now() - attemptStarted;
      if (attempt > 0) m.retry_ms = lastMs;
      used = reply.provider;
      m.provider = reply.provider;
      usage.model = reply.model;
      usage.input += reply.inputTokens;
      usage.output += reply.outputTokens;
      m.oauth_ms += reply.timings.oauthMs;
      m.upload_ms += reply.timings.uploadMs;
      m.chat_ms += reply.timings.chatMs;
      if (reply.fallbacks.length) m.fallback_used = true;

      t = Date.now();
      const parsed = extractJson(reply.text);
      const result: ReturnType<typeof validateStudyContent> = parsed
        ? validateStudyContent(parsed, images.length)
        : { ok: false, code: "AI_BAD_JSON", reason: reply.truncated ? "truncated" : "not json" };
      m.parse_ms += Date.now() - t;
      last = result;
      let problems: string[];
      if (result.ok) {
        // 11. критические проблемы → повтор; некритические (оформление, выделения, sourceOutline…) → только в лог
        t = Date.now();
        const candidate: Candidate = {
          content: result.content,
          critical: criticalIssues(result.content, images.length),
          issues: qualityIssues(result.content, images.length),
          model: reply.model,
          provider: reply.provider,
        };
        m.quality_ms += Date.now() - t;
        if (better(candidate, best)) best = candidate;
        if (!candidate.critical.length) break;
        problems = [...candidate.critical.map((i) => i.text), ...candidate.issues];
      } else {
        // страницы действительно не читаются — повтор не поможет
        if (result.code === "UNREADABLE_PAGES" && !best) break;
        problems = [result.code === "AI_BAD_JSON" ? "ответ не является корректным JSON по схеме (" + result.reason + ")" : "в ответе нет ни разделов, ни терминов"];
      }
      console.warn("[analyze-pages] attempt", attempt + 1, "critical:", problems.join(" | "));
      messages.push({ role: "assistant", content: reply.text.slice(0, 4000) });
      messages.push({ role: "user", content: retryPrompt(problems) });
    }
    if (!best) {
      if (!last) throw new StepError("AI_TIMEOUT");
      throw new StepError(last.ok ? "EMPTY_CONTENT" : last.code, last.ok ? "" : last.reason);
    }
    m.critical = best.critical.length;
    m.minor = best.issues.length;
    // результат остался критически плохим (повтор не успел или не помог) — не сохраняем его как конспект
    if (best.critical.length) throw new StepError(criticalCode(best.critical), best.critical.map((i) => i.code).join(","));
    if (best.issues.length) console.warn("[analyze-pages] accepted with issues:", best.issues.join(" | "));
    usage.model = best.model;
    m.provider = best.provider;

    // консервативная чистка: только удаление лишнего и явно повреждённого, без правки текста
    t = Date.now();
    const { content, report } = sanitize(best.content);
    m.sanitize_ms = Date.now() - t;
    if (report.length) console.warn("[analyze-pages] sanitize:", report.join(" | "));
    if (!content.sections.length && !content.glossary.terms.length) throw new StepError("EMPTY_CONTENT", "empty after sanitize");

    // 15. успех: content, статус, данные для списков
    t = Date.now();
    const { error: saveError } = await admin
      .from("notes")
      .update({
        status: "ready",
        stage: "done",
        error_code: null,
        title: content.meta.title,
        subject: content.meta.subject,
        preview: previewOf(content),
        content,
        schema_version: SCHEMA_VERSION,
        updated_at: new Date().toISOString(),
      })
      .eq("id", noteId)
      .eq("user_id", userId);
    m.save_ms = Date.now() - t;
    if (saveError) throw new StepError("SAVE_FAILED", saveError.message);
    m.status = "ready";

    await logGeneration(admin, job, "success", usage, Date.now() - started);

    // временные фотографии больше не нужны: вся папка note (включая дубли от повторных загрузок) и файлы GigaChat
    t = Date.now();
    const folder = userId + "/" + noteId;
    const storageCleanup = (async () => {
      const { data: listed } = await storage.storage.from(BUCKET).list(folder, { limit: 100 });
      const toRemove = [...new Set([...paths, ...(listed || []).filter((f) => f.id).map((f) => folder + "/" + f.name)])];
      const { error: removeError } = await storage.storage.from(BUCKET).remove(toRemove);
      if (removeError) console.warn("[analyze-pages] cleanup failed:", removeError.message);
    })();
    await Promise.all([storageCleanup, closeGigaSession(giga)]);
    m.cleanup_ms = Date.now() - t;
  } catch (e) {
    // 16. ошибка: сначала записываем failed, фотографии остаются для повтора
    const known = e instanceof StepError || e instanceof ProviderError;
    const code = known ? e.code : "INTERNAL";
    m.status = "failed";
    m.error_code = code;
    console.error("[analyze-pages] failed:", code, known ? e.detail : String(e));
    const { error: failError } = await admin
      .from("notes")
      .update({ status: "failed", stage: "failed", error_code: code, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("user_id", userId);
    if (failError) console.error("[analyze-pages] could not mark failed:", failError.message);
    if (aiCalled) await logGeneration(admin, job, "failed", usage, Date.now() - started);
  } finally {
    // файлы GigaChat удаляются в любом случае (после успеха — уже удалены выше, здесь ничего не делается)
    const leftover = await closeGigaSession(giga);
    if (m.status !== "ready") m.cleanup_ms = leftover;
    m.model = usage.model;
    m.input_tokens = usage.input;
    m.output_tokens = usage.output;
    m.total_ms = Date.now() - started;
    console.log("[analyze-pages] metrics " + JSON.stringify(m));
  }
}

async function logGeneration(
  admin: SupabaseClient,
  job: Job,
  status: "success" | "failed",
  usage: { input: number; output: number; model: string },
  latency: number,
) {
  const { error } = await admin.from("ai_generations").insert({
    user_id: job.userId,
    note_id: job.noteId,
    model: usage.model || configuredProviders().join("/"),
    page_count: job.paths.length,
    input_tokens: usage.input,
    output_tokens: usage.output,
    estimated_cost: (usage.input * PRICE_PER_M.input + usage.output * PRICE_PER_M.output) / 1e6,
    latency,
    status,
  });
  if (error) console.warn("[analyze-pages] ai_generations insert failed:", error.message);
}
