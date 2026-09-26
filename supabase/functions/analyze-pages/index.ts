/**
 * Edge Function analyze-pages: фотографии страниц (private bucket temp-pages) → Z.AI GLM-4.6V-Flash
 * → StudyContent v1 → public.notes.content.
 *
 * Запрос: POST { note_id, paths[] } с заголовком Authorization: Bearer <JWT пользователя>.
 * Ответ сразу 202 { status: "processing" }; сама генерация идёт в фоне (EdgeRuntime.waitUntil),
 * поэтому закрытие PWA её не прерывает. Клиент узнаёт результат по notes.status.
 *
 * Секреты только из окружения функции:
 *   ZAI_API_KEY               — Edge Function Secrets (задан вручную);
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY — Supabase передаёт сам.
 * Ключи и фотографии в лог не пишутся.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { SYSTEM_PROMPT, retryPrompt, userPrompt } from "./prompt.ts";
import { extractJson, previewOf, SCHEMA_VERSION, validateStudyContent } from "./study-content.ts";

const MODEL = "glm-4.6v-flash";
const ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const BUCKET = "temp-pages";
const MAX_PAGES = 8;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// генерация, которая «висит» в analyzing дольше этого, считается прерванной — её можно запустить снова
const STALE_MS = 5 * 60_000;
// общий бюджет фоновой работы: меньше лимита времени Edge Function (150 с на бесплатном плане)
const BUDGET_MS = 140_000;
// повторный запрос к модели делаем, только если на него остаётся не меньше этого времени
const MIN_RETRY_MS = 45_000;
// GLM-4.6V-Flash бесплатна; при смене модели здесь указывается цена за 1M токенов
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
  const zaiKey = Deno.env.get("ZAI_API_KEY") || "";
  if (!url || !adminKey || !zaiKey) {
    console.error("[analyze-pages] server misconfigured:", { url: !!url, serviceKey: !!adminKey, zaiKey: !!zaiKey });
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

  // Атомарный захват: из uploading/failed или из «зависшей» генерации в analyzing.
  // Второй одновременный запрос по той же note получит 0 строк — второй платной генерации не будет.
  const now = new Date();
  const staleIso = new Date(now.getTime() - STALE_MS).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("notes")
    .update({ status: "processing", stage: "analyzing", error_code: null, updated_at: now.toISOString() })
    .eq("id", noteId)
    .eq("user_id", user.id)
    .or(
      "status.eq.failed," +
        "and(status.eq.processing,stage.is.null)," +
        "and(status.eq.processing,stage.neq.analyzing)," +
        "and(status.eq.processing,stage.eq.analyzing,updated_at.lt." + staleIso + ")",
    )
    .select("id");
  if (claimError) {
    console.error("[analyze-pages] claim failed:", claimError.message);
    return json(500, { error: "INTERNAL" }, cors);
  }
  if (!claimed?.length) return json(409, { error: "ALREADY_PROCESSING" }, cors);

  // Хранилище читаем от имени пользователя: RLS Storage дополнительно проверяет, что это его файлы
  const anon = publicKey();
  const storageClient = anon
    ? createClient(url, anon, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    : admin;

  const task = processNote({ admin, storage: storageClient, zaiKey, userId: user.id, noteId, paths });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task);
  else await task;
  return json(202, { status: "processing", note_id: noteId }, cors);
});

// ---------- генерация ----------

function checkQuota(_admin: SupabaseClient, _userId: string): Promise<string | null> {
  // Лимит можно включить позже, например: число строк ai_generations пользователя за сутки
  // больше N → return "RATE_LIMITED". Сейчас генерации не ограничены.
  return Promise.resolve(null);
}

type Job = {
  admin: SupabaseClient;
  storage: SupabaseClient;
  zaiKey: string;
  userId: string;
  noteId: string;
  paths: string[];
};

async function processNote(job: Job) {
  const { admin, storage, noteId, userId, paths } = job;
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const usage = { input: 0, output: 0 };
  let aiCalled = false;

  try {
    // 6. фотографии из private bucket, в порядке страниц
    const images: string[] = [];
    for (const path of paths) {
      const { data, error } = await storage.storage.from(BUCKET).download(path);
      if (error || !data) throw new StepError("STORAGE_READ_FAILED", error?.message || "no data");
      if (data.size > MAX_IMAGE_BYTES) throw new StepError("IMAGE_TOO_LARGE");
      const mime = /^image\/(jpeg|png|webp)$/.test(data.type) ? data.type : "image/jpeg";
      images.push("data:" + mime + ";base64," + encodeBase64(new Uint8Array(await data.arrayBuffer())));
    }

    // 7–10. все страницы одним запросом; строгий JSON; при неудаче — один повтор
    const messages: ZaiMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          { type: "text" as const, text: userPrompt(images.length) },
        ],
      },
    ];

    let result: ReturnType<typeof validateStudyContent> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && deadline - Date.now() < MIN_RETRY_MS) break;
      aiCalled = true;
      const reply = await callZai(job.zaiKey, messages, deadline);
      usage.input += reply.inputTokens;
      usage.output += reply.outputTokens;
      const parsed = extractJson(reply.text);
      result = parsed
        ? validateStudyContent(parsed, images.length)
        : { ok: false, code: "AI_BAD_JSON", reason: reply.truncated ? "truncated" : "not json" };
      // 11. валидный результат, или страницы действительно не читаются — повтор не поможет
      if (result.ok || result.code === "UNREADABLE_PAGES") break;
      console.warn("[analyze-pages] attempt", attempt + 1, "rejected:", result.code, result.reason);
      messages.push({ role: "assistant", content: reply.text.slice(0, 4000) });
      messages.push({ role: "user", content: retryPrompt(result.reason) });
    }
    if (!result) throw new StepError("AI_TIMEOUT");
    if (!result.ok) throw new StepError(result.code, result.reason);

    // 15. успех: content, статус, данные для списков
    const content = result.content;
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
    if (saveError) throw new StepError("SAVE_FAILED", saveError.message);

    await logGeneration(admin, job, "success", usage, Date.now() - started);

    // временные фотографии больше не нужны: вся папка note (включая дубли от повторных загрузок)
    const folder = userId + "/" + noteId;
    const { data: listed } = await storage.storage.from(BUCKET).list(folder, { limit: 100 });
    const toRemove = [...new Set([...paths, ...(listed || []).filter((f) => f.id).map((f) => folder + "/" + f.name)])];
    const { error: removeError } = await storage.storage.from(BUCKET).remove(toRemove);
    if (removeError) console.warn("[analyze-pages] cleanup failed:", removeError.message);
  } catch (e) {
    // 16. ошибка: сначала записываем failed, фотографии остаются для повтора
    const code = e instanceof StepError ? e.code : "INTERNAL";
    console.error("[analyze-pages] failed:", code, e instanceof StepError ? e.detail : String(e));
    const { error: failError } = await admin
      .from("notes")
      .update({ status: "failed", stage: "failed", error_code: code, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("user_id", userId);
    if (failError) console.error("[analyze-pages] could not mark failed:", failError.message);
    if (aiCalled) await logGeneration(admin, job, "failed", usage, Date.now() - started);
  }
}

async function logGeneration(
  admin: SupabaseClient,
  job: Job,
  status: "success" | "failed",
  usage: { input: number; output: number },
  latency: number,
) {
  const { error } = await admin.from("ai_generations").insert({
    user_id: job.userId,
    note_id: job.noteId,
    model: MODEL,
    page_count: job.paths.length,
    input_tokens: usage.input,
    output_tokens: usage.output,
    estimated_cost: (usage.input * PRICE_PER_M.input + usage.output * PRICE_PER_M.output) / 1e6,
    latency,
    status,
  });
  if (error) console.warn("[analyze-pages] ai_generations insert failed:", error.message);
}

// ---------- Z.AI ----------

type ZaiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ZaiMessage = { role: "system" | "user" | "assistant"; content: string | ZaiPart[] };

async function callZai(key: string, messages: ZaiMessage[], deadline: number) {
  const timeout = deadline - Date.now();
  if (timeout < 5_000) throw new StepError("AI_TIMEOUT");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch(ZAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 12000,
        // без режима рассуждений ответ приходит быстрее и укладывается в лимит времени функции
        thinking: { type: "disabled" },
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new StepError(ctrl.signal.aborted ? "AI_TIMEOUT" : "AI_NETWORK", String(e));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // тело ошибки может содержать подробности запроса — в лог только статус и начало текста
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const code = res.status === 429 ? "AI_RATE_LIMITED" : res.status === 401 || res.status === 403 ? "AI_AUTH" : res.status >= 500 ? "AI_ERROR" : "AI_BAD_REQUEST";
    throw new StepError(code, res.status + " " + detail);
  }

  const data = await res.json().catch(() => null);
  const choice = data?.choices?.[0];
  const raw = choice?.message?.content;
  const text = Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text || "").join("") : String(raw || "");
  if (choice?.finish_reason === "sensitive") throw new StepError("AI_REFUSED");
  return {
    text,
    truncated: choice?.finish_reason === "length",
    inputTokens: Number(data?.usage?.prompt_tokens) || 0,
    outputTokens: Number(data?.usage?.completion_tokens) || 0,
  };
}
