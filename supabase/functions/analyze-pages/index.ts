/**
 * Edge Function analyze-pages: фотографии страниц (private bucket temp-pages) → AI-провайдер
 * (основной GigaChat-2-Max, резервный Z.AI — см. providers.ts) → StudyContent v1 → public.notes.content.
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
import { SYSTEM_PROMPT, retryPrompt, UNREADABLE_RETRY_PROBLEM, userPrompt } from "./prompt.ts";
import { type ChatMessage, closeGigaSession, configuredProviders, generate, newGigaSession, ProviderError, type ProviderId, TIMEOUTS } from "./providers.ts";
import { criticalIssues, jsonErrorContext, jsonRetryHint, parseModelJson, previewOf, qualityIssues, sanitize, SCHEMA_VERSION, type StudyContent, unreadableDiag, validateStudyContent } from "./study-content.ts";
import { type Continuation, CONTINUATION_TTL_MS, contextOf, fitsGeneration, MAX_PART_RETRIES, mergeParts, PART_CALL_MS, partCapMs, partPrompt, planFor, planLabel, retryPlan, signContinuation, SINGLE_MAX, type Usage, validPlan, verifyContinuation } from "./parts.ts";
import type { StreamStats } from "./providers.ts";

const BUCKET = "temp-pages";
const MAX_PAGES = 8;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// генерация, которая «висит» в analyzing дольше этого, считается прерванной — её можно запустить снова
const STALE_MS = 5 * 60_000;
// резерв операции лимита (F&F) живёт дольше бюджета генерации: если функцию прервали, резерв истечёт сам
const LEASE_S = 600;
// генерация по частям (5–8 страниц) может идти дольше: до трёх частей и один повтор части, каждая — свой вызов функции
const LEASE_SPLIT_S = 1200;
// при генерации по частям повтор внутри вызова оставляет такой запас до конца бюджета
const PART_SAFETY_MS = 5_000;
// общий бюджет фоновой работы: меньше лимита времени Edge Function (150 с на бесплатном плане)
const BUDGET_MS = 140_000;
// повторный запрос к модели делаем, только если на него остаётся не меньше этого времени
const MIN_RETRY_MS = 45_000;
// и не меньше, чем длилась предыдущая попытка, с запасом: GigaChat с тем же промптом отвечает примерно столько же
const RETRY_SLACK = 1.2;
// отказ «страницы не читаются» не длиннее этого (знаков ответа) считается коротким: такой ответ GigaChat давал на
// читаемые страницы (07.11.2026: 3 фото, 23 токена за 2,8 с) — один повтор с уточнением, если хватает времени
const SHORT_REFUSAL_CHARS = 600;
// GigaChat (Freemium), qwen/qwen3.8-27b:free и GLM-4.6V-Flash бесплатны; при смене модели здесь указывается цена за 1M токенов
const PRICE_PER_M = { input: 0, output: 0 };

const ALLOWED_ORIGINS = ["https://thenikolaika1.github.io"];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

// Отказы start_text_generation_v2: AI не запускается, note помечается failed с этим кодом (фото остаются для повтора).
export const REFUSALS: Record<string, [number, string]> = {
  no_access: [403, "NO_ACCESS"],
  limit_reached: [403, "LIMIT_REACHED"],
  access_expired: [403, "ACCESS_EXPIRED"],
  too_many_pages: [400, "TOO_MANY_PAGES"],
  ai_paused: [503, "AI_PAUSED"],
  ai_busy: [429, "AI_BUSY"],
  retry_limit: [429, "RETRY_LIMIT"],
  daily_limit: [429, "DAILY_LIMIT"],
  cooldown: [429, "COOLDOWN"],
  ai_unavailable: [503, "AI_UNAVAILABLE"],
};

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

  // продолжение генерации по частям (вторая часть): вызывает только сама функция — запрос подписан ключом сервера
  if (req.headers.get("x-kn-continuation") === "1") return continueNote(req, url, adminKey, cors);

  // 1–2. JWT пользователя обязателен; пользователя определяет Supabase Auth
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "UNAUTHORIZED" }, cors);
  const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return json(401, { error: "UNAUTHORIZED" }, cors);

  // 3. вход: note_id и пути фотографий в порядке страниц
  let body: { note_id?: unknown; paths?: unknown; continuation?: unknown; sig?: unknown };
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

  // Атомарно в одной транзакции (start_text_generation_v2, только service_role): захват note из uploading/failed
  // или из «зависшей» генерации и резерв одной операции лимита (op = note_id) в счёт действующей выдачи доступа
  // (пробный период, оплаченный срок, владелец; срок — по часам сервера). Без выдач — прежняя проверка
  // start_text_generation (участники F&F, служебные аккаунты). Второй одновременный запрос по той же note получит
  // already_processing — второй платной генерации не будет; повтор той же note не занимает второй слот. Итог резерва
  // фиксирует триггер на notes.status: ready → списан, failed → возвращён. Без доступа или при исчерпанном лимите AI не запускается.
  // ЭКСПЕРИМЕНТ v66 (пробные генерации владельца): больше SINGLE_MAX страниц пока разрешено только владельцу.
  // Владелец определяется сервером по его же JWT (get_my_access_v2), клиенту не верим. Для всех остальных лимит базы
  // (private.ai_limits.max_pages = 4) проверяется как раньше — по настоящему числу страниц. Убрать при выпуске, когда
  // лимит базы станет 8 (тогда проверка ниже ни на что не влияет).
  let pagesForLimit = paths.length;
  if (OWNER_PAGE_TEST && paths.length > SINGLE_MAX && (await isOwner(url, token))) {
    console.log("[analyze-pages] owner page test: " + paths.length + " pages");
    pagesForLimit = SINGLE_MAX;
  }

  const { data: start, error: startError } = await admin.rpc("start_text_generation_v2", {
    p_user_id: user.id,
    p_note_id: noteId,
    p_stale_seconds: STALE_MS / 1000,
    p_lease_seconds: paths.length > SINGLE_MAX ? LEASE_SPLIT_S : LEASE_S,
    // лимит страниц (private.ai_limits.max_pages) проверяет база — по тому же списку, что обрабатывается ниже
    p_page_count: pagesForLimit,
  });
  if (startError) {
    console.error("[analyze-pages] start failed:", startError.message);
    return json(500, { error: "INTERNAL" }, cors);
  }
  const result = typeof start?.result === "string" ? start.result : "";
  if (result === "ready") return json(200, { status: "ready", note_id: noteId }, cors);
  if (result === "not_found") return json(404, { error: "NOT_FOUND" }, cors);
  if (result === "already_processing") return json(409, { error: "ALREADY_PROCESSING" }, cors);
  const refusal = Object.hasOwn(REFUSALS, result) ? REFUSALS[result] : undefined;
  if (refusal) {
    const [httpStatus, code] = refusal;
    // note не остаётся «создаётся»: failed с причиной, фотографии сохраняются для повтора, когда доступ появится
    const { error: markError } = await admin
      .from("notes")
      .update({ status: "failed", stage: "failed", error_code: code, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("user_id", user.id)
      .or("status.eq.failed,stage.is.null,stage.neq.analyzing");
    if (markError) console.warn("[analyze-pages] could not mark " + code + ":", markError.message);
    return json(httpStatus, { error: code }, cors);
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

  const task = processNote({ admin, storage: storageClient, userId: user.id, noteId, paths, self: { url, adminKey, publicKey: anon } });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task);
  else await task;
  return json(202, { status: "processing", note_id: noteId }, cors);
});

// ---------- генерация ----------

/** Эксперимент v66: пробные генерации 5–8 страниц — только у владельца (см. обработчик запроса). */
const OWNER_PAGE_TEST = true;

/** Владелец ли это — по его JWT, как его видит база (get_my_access_v2 → status owner). Ошибка — «нет». */
async function isOwner(url: string, token: string): Promise<boolean> {
  const anon = publicKey();
  if (!anon) return false;
  try {
    const client = createClient(url, anon, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.rpc("get_my_access_v2");
    return !error && (data as { status?: string } | null)?.status === "owner";
  } catch {
    return false;
  }
}

/**
 * Хватит ли оставшегося времени на полноценный повтор: провайдер повтора получит
 * min(primaryMaxMs, осталось − резерв на резервные провайдеры), и этого должно хватить
 * на попытку не короче MIN_RETRY_MS и не короче предыдущей попытки с запасом.
 */
export function retryFits(remainingMs: number, lastAttemptMs: number): boolean {
  const providerMs = Math.min(TIMEOUTS.primaryMaxMs, remainingMs - TIMEOUTS.fallbackReserveMs);
  return providerMs >= Math.max(MIN_RETRY_MS, lastAttemptMs * RETRY_SLACK);
}

/**
 * То же для генерации по частям: повтор внутри вызова получит min(предел части, осталось − запас) — его хватит
 * на попытку не короче MIN_RETRY_MS и не короче предыдущей с запасом; иначе повтор заведомо не успеет.
 */
export function partRetryFits(remainingMs: number, lastAttemptMs: number, capMs = PART_CALL_MS): boolean {
  return Math.min(capMs, remainingMs - PART_SAFETY_MS) >= Math.max(MIN_RETRY_MS, lastAttemptMs * RETRY_SLACK);
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
  /** продолжение генерации по частям (из подписанного продолжения): часть, готовые части, расход, был ли повтор */
  cont?: Next;
  /** для передачи следующей части: адрес функции и ключи */
  self?: { url: string; adminKey: string; publicKey: string };
};

/** Что передаётся следующему вызову функции: план частей, номер части, готовое, расход, повторы, начало генерации. */
type Next = Pick<Continuation, "plan" | "part" | "retries" | "prev" | "acc" | "t0">;

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

/**
 * Запрос к модели по этим страницам: строгий JSON, проверка, повтор при критических проблемах (тот же провайдер),
 * резервный провайдер — при ошибке провайдера. Возвращает лучший вариант без критических проблем, иначе StepError.
 * Логика — прежняя (до v66 была внутри processNote); prompt — текст запроса (обычный или для части).
 */
// deno-lint-ignore no-explicit-any
async function runModel(images: string[], prompt: string, deadline: number, giga: ReturnType<typeof newGigaSession>, usage: { input: number; output: number; model: string }, m: any, capMs?: number): Promise<Candidate> {
  // 7–10. все страницы одним запросом; строгий JSON. Повтор — только при критических проблемах
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        { type: "text" as const, text: prompt },
      ],
    },
  ];

  // model — модель, которая дала этот вариант (в ai_generations пишется модель итогового конспекта)
  let best: Candidate | null = null;
  let last: ReturnType<typeof validateStudyContent> | null = null;
  // повтор идёт к тому же провайдеру (GigaChat переиспользует загруженные страницы); резервный — только при ошибке провайдера
  let used: ProviderId | undefined;
  let lastMs = 0;
  let t = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && !(capMs ? partRetryFits(deadline - Date.now(), lastMs, capMs) : retryFits(deadline - Date.now(), lastMs))) {
      // полноценный повтор не успеет — заведомо обречённый запрос не начинаем
      console.warn("[analyze-pages] retry skipped: not enough time (" + (deadline - Date.now()) + " ms left, last attempt " + lastMs + " ms)");
      break;
    }
    m.attempts++;
    if (attempt > 0) m.retry_used = true;
    let reply;
    const attemptStarted = Date.now();
    try {
      // по частям GigaChat отвечает потоком — ради метрик (время до первого токена и т. д.); 1–4 страницы — как раньше
      reply = await generate(messages, deadline, used, giga, capMs, !!capMs);
    } catch (e) {
      if (attempt > 0) m.retry_ms = Date.now() - attemptStarted;
      // время этапов неудачного вызова — в метрики (вход, загрузка фото, ожидание ответа)
      if (e instanceof ProviderError && e.timings) {
        m.oauth_ms += e.timings.oauthMs;
        m.upload_ms += e.timings.uploadMs;
        m.chat_ms += e.timings.chatMs;
        m.fail_stage = e.timings.stage;
        if (e.timings.stream) streamMetrics(m, e.timings.stream);
      }
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
    if (reply.stream) streamMetrics(m, reply.stream);

    t = Date.now();
    const parsed = parseModelJson(reply.text);
    if (parsed.repaired) m.json_repaired++;
    // тип и позиция ошибки JSON — без текста ответа (в нём текст учебника)
    if (parsed.diag) {
      console.warn(
        "[analyze-pages] attempt " + (attempt + 1) + " json " + (parsed.repaired ? "repaired" : "invalid") + ": " +
          JSON.stringify({ ...parsed.diag, truncated: reply.truncated }),
      );
    }
    const result: ReturnType<typeof validateStudyContent> = parsed.value
      ? validateStudyContent(parsed.value, images.length)
      : { ok: false, code: "AI_BAD_JSON", reason: reply.truncated ? "truncated" : parsed.diag?.kind || "not json" };
    m.parse_ms += Date.now() - t;
    last = result;
    let problems: string[];
    // фрагмент вокруг ошибки JSON — только в повторный запрос к модели (не в лог: там может быть текст учебника)
    let jsonContext = "";
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
      if (result.code === "UNREADABLE_PAGES" && !best) {
        // безопасная диагностика: коды, числа и метки причин, без текста ответа и учебника
        console.warn("[analyze-pages] attempt " + (attempt + 1) + " unreadable: " +
          JSON.stringify({ ...unreadableDiag(parsed.value, reply.text.length), finish: reply.truncated ? "length" : "stop", output_tokens: reply.outputTokens, chat_ms: reply.timings.chatMs, images: images.length }));
        // длинный подробный отказ или уже повтор — страницы действительно не читаются, ещё один запрос не поможет;
        // короткий отказ на первой попытке — один повтор (время проверяется в начале следующей попытки: retryFits)
        if (attempt > 0 || reply.text.length > SHORT_REFUSAL_CHARS) break;
        m.unreadable_retry = true;
        problems = [UNREADABLE_RETRY_PROBLEM];
        console.warn("[analyze-pages] attempt", attempt + 1, "critical: short unreadable reply — retrying once");
        messages.push({ role: "assistant", content: reply.text.slice(0, 4000) });
        messages.push({ role: "user", content: retryPrompt(problems) });
        continue;
      }
      problems = [
        result.code === "AI_BAD_JSON"
          ? "ответ не является корректным JSON по схеме: " + (reply.truncated ? "ответ оборван — пиши компактнее" : jsonRetryHint(parsed.diag))
          : "в ответе нет ни разделов, ни терминов",
      ];
      if (result.code === "AI_BAD_JSON" && !reply.truncated) jsonContext = jsonErrorContext(parsed.source, parsed.diag);
    }
    console.warn("[analyze-pages] attempt", attempt + 1, "critical:", problems.join(" | "));
    messages.push({ role: "assistant", content: reply.text.slice(0, 4000) });
    messages.push({ role: "user", content: retryPrompt(problems, jsonContext) });
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
  return best;
}

/** Метрики потока последнего ответа модели в метрики вызова (только числа и код причины). */
// deno-lint-ignore no-explicit-any
function streamMetrics(m: any, s: StreamStats) {
  m.ttft_ms = s.ttftMs;
  m.gen_ms = s.genMs;
  m.stream_chunks = s.chunks;
  m.stream_chars = s.chars;
  m.stream_tokens = s.tokens;
  m.stream_end = s.end;
}

async function processNote(job: Job) {
  const { admin, storage, noteId, userId, paths, cont } = job;
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const usage = { input: 0, output: 0, model: "" };
  const giga = newGigaSession();
  // безопасные метрики времени: только числа, имена провайдеров и коды — без ключей, токенов, изображений и текста
  const m = {
    page_count: paths.length, part: 0, parts: 0, storage_ms: 0, oauth_ms: 0, upload_ms: 0, chat_ms: 0, parse_ms: 0, quality_ms: 0,
    sanitize_ms: 0, retry_ms: 0, save_ms: 0, cleanup_ms: 0, total_ms: 0, attempts: 0, provider: "", model: "",
    retry_used: false, unreadable_retry: false, part_retry: false, fallback_used: false, json_repaired: 0, critical: 0, minor: 0,
    input_tokens: 0, output_tokens: 0, status: "", error_code: "", fail_stage: "", plan: "", retries: 0, gen_elapsed_ms: 0,
    ttft_ms: -1, gen_ms: 0, stream_chunks: 0, stream_chars: 0, stream_tokens: -1, stream_end: "",
  };
  let aiCalled = false;
  let t = Date.now();
  // по частям (больше SINGLE_MAX страниц): этот вызов делает одну часть плана и передаёт готовое следующему.
  // План — из продолжения (после повтора с делением он отличается от исходного) или исходный: splitPages.
  const plan = cont?.plan ?? planFor(paths.length);
  const split = plan.length > 1;
  const partIndex = cont?.part ?? 0;
  const retries = cont?.retries ?? 0;
  // начало всей генерации (запуск пользователем) — для общего бюджета GEN_BUDGET_MS
  const t0 = cont?.t0 ?? started;
  // расход всей генерации: предыдущие вызовы + этот
  const total = (): Usage => ({
    input: (cont?.acc.input || 0) + usage.input,
    output: (cont?.acc.output || 0) + usage.output,
    ms: (cont?.acc.ms || 0) + (Date.now() - started),
    attempts: (cont?.acc.attempts || 0) + m.attempts,
    model: usage.model || cont?.acc.model || "",
    provider: m.provider || cont?.acc.provider || "",
  });

  try {
    if (!plan[partIndex]) throw new StepError("CONTINUATION_FAILED", "bad part " + partIndex);
    const { from, to } = plan[partIndex];
    m.part = split ? partIndex + 1 : 0;
    m.parts = split ? plan.length : 0;
    m.plan = split ? planLabel(plan) : "";
    m.retries = retries;
    m.gen_elapsed_ms = Date.now() - t0;
    // каждая страница — ровно в одной части: готовые части покрывают страницы до from, не больше и не меньше
    if ((cont?.prev?.meta.pages.length ?? 0) !== from) throw new StepError("CONTINUATION_FAILED", "pages before part " + (partIndex + 1) + " do not match");
    // продолжение, которое уже не уложится в общий бюджет генерации, модель не вызывает
    if (cont && !fitsGeneration(Date.now() - t0, plan, partIndex)) throw new StepError("AI_TIMEOUT", "generation budget exhausted before part " + (partIndex + 1));
    // 6. фотографии этой части из private bucket, в порядке страниц
    const images = await mapLimit(paths.slice(from, to), 4, async (path) => {
      const { data, error } = await storage.storage.from(BUCKET).download(path);
      if (error || !data) throw new StepError("STORAGE_READ_FAILED", error?.message || "no data");
      if (data.size > MAX_IMAGE_BYTES) throw new StepError("IMAGE_TOO_LARGE");
      const mime = /^image\/(jpeg|png|webp)$/.test(data.type) ? data.type : "image/jpeg";
      return "data:" + mime + ";base64," + encodeBase64(new Uint8Array(await data.arrayBuffer()));
    });
    m.storage_ms = Date.now() - t;

    const prompt = split
      ? partPrompt(userPrompt(images.length), partIndex, plan.length, from, to, paths.length, cont?.prev ? contextOf(cont.prev) : undefined)
      : userPrompt(images.length);
    aiCalled = true;
    // 1–4 страницы — как раньше; по частям — ожидание ответа на часть не дольше PART_CALL_MS (повтор — PART_RETRY_CALL_MS)
    const best = await runModel(images, prompt, deadline, giga, usage, m, split ? partCapMs(plan[partIndex]) : undefined);
    usage.model = best.model;
    m.provider = best.provider;
    const merged = cont?.prev ? mergeParts(cont.prev, best.content) : best.content;

    if (partIndex < plan.length - 1) {
      // часть готова: файлы GigaChat больше не нужны, следующая часть — в новом вызове функции, если она уложится
      if (!fitsGeneration(Date.now() - t0, plan, partIndex + 1)) throw new StepError("AI_TIMEOUT", "generation budget exhausted before part " + (partIndex + 2));
      await closeGigaSession(giga);
      await handOff(job, { plan, part: partIndex + 1, retries, prev: merged, acc: total(), t0 });
      m.status = "handed_off";
      return;
    }
    if (cont?.prev) {
      const mergedCritical = criticalIssues(merged, paths.length);
      if (mergedCritical.length) throw new StepError(criticalCode(mergedCritical), "merged: " + mergedCritical.map((i) => i.code).join(","));
    }

    // консервативная чистка: только удаление лишнего и явно повреждённого, без правки текста
    t = Date.now();
    const { content, report } = sanitize(merged);
    m.sanitize_ms = Date.now() - t;
    if (report.length) console.warn("[analyze-pages] sanitize:", report.join(" | "));
    if (!content.sections.length && !content.glossary.terms.length) throw new StepError("EMPTY_CONTENT", "empty after sanitize");

    // 15. успех: content, статус, данные для списков
    t = Date.now();
    // продолжение сохраняет, только если генерация всё ещё идёт: если другой вызов уже отметил ошибку (ответ на
    // передачу потерялся) и резерв возвращён, готовый конспект её не перезаписывает — итог остаётся согласованным
    let saveQuery = admin
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
    if (cont) saveQuery = saveQuery.eq("status", "processing");
    const { data: saved, error: saveError } = await saveQuery.select("id");
    m.save_ms = Date.now() - t;
    if (saveError) throw new StepError("SAVE_FAILED", saveError.message);
    if (cont && !(saved && saved.length)) throw new StepError("NOTE_CHANGED", "note is no longer processing");
    m.status = "ready";

    const sum = total();
    await logGeneration(admin, job, "success", sum, sum.ms);

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
    const known = e instanceof StepError || e instanceof ProviderError;
    const code = known ? e.code : "INTERNAL";
    m.error_code = code;
    console.error("[analyze-pages] failed:", code, known ? e.detail : String(e));
    // по частям: модель не ответила (тайм-аут, сеть) — часть повторяется в новом вызове функции с долгим ожиданием
    // (PART_RETRY_CALL_MS), часть из 2–3 фото при тайм-ауте — поделённой пополам (retryPlan). Не больше
    // MAX_PART_RETRIES повторов за генерацию и только если повтор уложится в общий бюджет. Готовые части передаются
    // как есть. Ошибки авторизации, лимитов и ответы с ошибкой не повторяются.
    if (split && e instanceof ProviderError && (code === "AI_TIMEOUT" || code === "AI_NETWORK")) {
      const next = retries < MAX_PART_RETRIES ? retryPlan(plan, partIndex, code) : null;
      const why = retries >= MAX_PART_RETRIES ? "retry limit " + MAX_PART_RETRIES : !next ? "one page already had the longest wait"
        : !fitsGeneration(Date.now() - t0, next, partIndex) ? "generation budget" : "";
      if (next && !why) {
        try {
          await closeGigaSession(giga);
          await handOff(job, { plan: next, part: partIndex, retries: retries + 1, prev: cont?.prev ?? null, acc: total(), t0 });
          m.status = "handed_off";
          m.part_retry = true;
          console.warn("[analyze-pages] part " + (partIndex + 1) + " of " + plan.length + " (pages " + (plan[partIndex].from + 1) + "–" + plan[partIndex].to + "): " + code +
            " — retrying in a new call, plan " + planLabel(plan) + " → " + planLabel(next));
          return;
        } catch (h) {
          console.error("[analyze-pages] part retry not handed off:", h instanceof StepError ? h.detail : String(h));
        }
      } else {
        console.warn("[analyze-pages] part " + (partIndex + 1) + " of " + plan.length + ": " + code + " — no retry: " + why);
      }
    }
    // 16. ошибка: записываем failed, фотографии остаются для повтора
    m.status = "failed";
    let failQuery = admin
      .from("notes")
      .update({ status: "failed", stage: "failed", error_code: code, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("user_id", userId);
    // продолжение не трогает note, которая уже не в работе: итог уже записал другой вызов (и строку ai_generations тоже)
    if (cont) failQuery = failQuery.eq("status", "processing");
    const { data: marked, error: failError } = await failQuery.select("id");
    if (failError) console.error("[analyze-pages] could not mark failed:", failError.message);
    const finalized = !cont || failError || (marked && marked.length);
    const sum = total();
    if ((aiCalled || cont) && finalized) await logGeneration(admin, job, "failed", sum, sum.ms);
  } finally {
    // файлы GigaChat удаляются в любом случае (после успеха — уже удалены выше, здесь ничего не делается)
    const leftover = await closeGigaSession(giga);
    if (m.status !== "ready" && m.status !== "handed_off") m.cleanup_ms = leftover;
    m.model = usage.model;
    m.input_tokens = usage.input;
    m.output_tokens = usage.output;
    m.total_ms = Date.now() - started;
    console.log("[analyze-pages] metrics " + JSON.stringify(m));
  }
}

// ---------- генерация по частям: передача следующей части ----------

/** Сколько ждём ответа следующего вызова функции на передачу (он сразу отвечает 202, работа идёт в фоне). */
const HANDOFF_MS = 15_000;

/**
 * Передача следующей части (или повтора этой): отмечаем note (тот же статус processing/analyzing, новое updated_at —
 * продолжение действует только для этого состояния) и запускаем новый вызов функции с подписанным продолжением.
 * Если он не принят — StepError: note станет failed, резерв генерации вернётся (как при любой ошибке).
 */
async function handOff(job: Job, next: Next) {
  const self = job.self;
  if (!self?.url || !self.adminKey) throw new StepError("CONTINUATION_FAILED", "no self config");
  const { data: marked, error: markError } = await job.admin
    .from("notes")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", job.noteId)
    .eq("user_id", job.userId)
    .eq("status", "processing")
    .eq("stage", "analyzing")
    .select("updated_at")
    .maybeSingle();
  if (markError || !marked) throw new StepError("CONTINUATION_FAILED", markError?.message || "note changed");
  const c: Continuation = {
    note_id: job.noteId, user_id: job.userId, paths: job.paths, handoff_at: String(marked.updated_at),
    exp: Date.now() + CONTINUATION_TTL_MS, ...next,
  };
  const { payload, sig } = await signContinuation(self.adminKey, c);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HANDOFF_MS);
  try {
    const res = await fetch(self.url.replace(/\/$/, "") + "/functions/v1/analyze-pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "x-kn-continuation": "1",
        ...(self.publicKey ? { apikey: self.publicKey, Authorization: "Bearer " + self.publicKey } : {}),
      },
      body: JSON.stringify({ continuation: payload, sig }),
      signal: ctrl.signal,
    });
    await res.body?.cancel();
    // 409 — это продолжение уже принято (повторная доставка того же запроса): следующая часть идёт
    if (res.status !== 202 && res.status !== 409) throw new StepError("CONTINUATION_FAILED", "HTTP " + res.status);
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError("CONTINUATION_FAILED", String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Следующая часть (или повтор части): только по подписанному продолжению (подпись ключом сервера, срок, note та же
 * и в том же состоянии, что при передаче). Захват — условным обновлением updated_at: повтор того же продолжения не
 * запустит вторую обработку. Доступ и резерв генерации проверены при запуске; start_text_generation_v2 здесь не вызывается.
 */
async function continueNote(req: Request, url: string, adminKey: string, cors: Record<string, string>): Promise<Response> {
  let body: { continuation?: unknown; sig?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_REQUEST" }, cors);
  }
  const c = await verifyContinuation(adminKey, body.continuation, body.sig);
  if (!c) return json(403, { error: "FORBIDDEN" }, cors);
  // форма продолжения: только генерация по частям (больше SINGLE_MAX страниц), план покрывает все страницы подряд,
  // часть в пределах плана, первая часть — только как повтор, повторов не больше MAX_PART_RETRIES, после первой — готовые части
  const n = Array.isArray(c.paths) ? c.paths.length : 0;
  if (
    n <= SINGLE_MAX || n > MAX_PAGES || !validPlan(c.plan, n) || !Number.isInteger(c.part) || c.part < 0 || c.part >= c.plan.length ||
    !Number.isInteger(c.retries) || c.retries < 0 || c.retries > MAX_PART_RETRIES || (c.part === 0 && !c.retries) ||
    typeof c.t0 !== "number" || !c.acc || typeof c.acc !== "object" || (c.part > 0 && !c.prev)
  ) return json(400, { error: "BAD_REQUEST" }, cors);
  const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: claimed, error } = await admin
    .from("notes")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", c.note_id)
    .eq("user_id", c.user_id)
    .eq("status", "processing")
    .eq("stage", "analyzing")
    .eq("updated_at", c.handoff_at)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[analyze-pages] continuation claim failed:", error.message);
    return json(500, { error: "INTERNAL" }, cors);
  }
  if (!claimed) return json(409, { error: "ALREADY_PROCESSING" }, cors);
  // фото читаем с ключом сервера: пути — из подписанного продолжения, каждый в папке этого пользователя и note
  const prefix = c.user_id + "/" + c.note_id + "/";
  if (!c.paths.every((p) => typeof p === "string" && p.startsWith(prefix) && !p.includes(".."))) return json(403, { error: "FORBIDDEN_PATH" }, cors);
  const task = processNote({
    admin, storage: admin, userId: c.user_id, noteId: c.note_id, paths: c.paths,
    cont: { plan: c.plan, part: c.part, retries: c.retries, prev: c.prev ?? null, acc: c.acc, t0: c.t0 },
    self: { url, adminKey, publicKey: publicKey() },
  });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task);
  else await task;
  return json(202, { status: "processing", note_id: c.note_id }, cors);
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
