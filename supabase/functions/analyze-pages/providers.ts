/**
 * AI-провайдеры для analyze-pages: единый вызов «сообщения → текст ответа модели».
 *
 * Порядок провайдеров задаётся PROVIDER_ORDER: первый — основной, остальные — резервные.
 * Сейчас: GigaChat (GigaChat-2-Max) → OpenRouter (qwen/qwen3.8-27b:free) → Z.AI (glm-4.6v-flash).
 *
 * Переключение на резервный провайдер происходит только при ошибке самого провайдера:
 * HTTP-ошибка (429, 5xx, 4xx — в том числе «нет доступного бесплатного vision-endpoint»),
 * таймаут, сетевая ошибка (в том числе TLS), ошибка в теле ответа, пустой ответ. Если модель ответила,
 * но конспект не прошёл проверку качества, это решает index.ts (повтор у того же провайдера).
 *
 * GigaChat устроен иначе, чем OpenAI-совместимые провайдеры (см. callGigaChat):
 * OAuth-токен по GIGACHAT_AUTH_KEY (кэшируется до истечения), TLS с корневым CA Минцифры (ca.ts),
 * каждая фотография загружается через Files API и передаётся отдельным user-сообщением со своим attachment,
 * после запроса загруженные файлы удаляются — при успехе, ошибке и таймауте.
 *
 * Ключи и токены берутся только из окружения функции (Deno.env) и никогда не пишутся в лог.
 * В лог попадают: провайдер, модель, HTTP-статус, время, число страниц, finish reason, причина переключения.
 */

import { RUSSIAN_TRUSTED_ROOT_CA } from "./ca.ts";

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

export type ProviderId = "gigachat" | "openrouter" | "zai";

export type Reply = {
  provider: ProviderId;
  /** модель, которая фактически ответила (как её вернул провайдер) */
  model: string;
  text: string;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
};

/** Ошибка провайдера: code — код для notes.error_code, detail — безопасный текст для лога. */
export class ProviderError extends Error {
  constructor(public code: string, public detail = "", public provider = "", public status = 0) {
    super(code);
  }
}

type ProviderDef = {
  id: ProviderId;
  model: string;
  keyEnv: string;
  url: string;
  /** дополнительные поля тела запроса, специфичные для провайдера */
  extraBody: Record<string, unknown>;
  extraHeaders: Record<string, string>;
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  gigachat: {
    id: "gigachat",
    model: "GigaChat-2-Max",
    keyEnv: "GIGACHAT_AUTH_KEY",
    url: "https://gigachat.devices.sberbank.ru/api/v1/chat/completions",
    extraBody: {},
    extraHeaders: {},
  },
  openrouter: {
    id: "openrouter",
    model: "qwen/qwen3.8-27b:free",
    keyEnv: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    extraBody: {},
    // необязательные заголовки атрибуции OpenRouter
    extraHeaders: { "HTTP-Referer": "https://thenikolaika1.github.io/konspekt-app/", "X-Title": "Konspekt by NK" },
  },
  zai: {
    id: "zai",
    model: "glm-4.6v-flash",
    keyEnv: "ZAI_API_KEY",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    // без режима рассуждений ответ приходит быстрее и укладывается в лимит времени функции
    extraBody: { thinking: { type: "disabled" } },
    extraHeaders: {},
  },
};

/** Основной провайдер — первый; при его ошибке пробуются следующие по порядку. */
export const PROVIDER_ORDER: ProviderId[] = ["gigachat", "openrouter", "zai"];

export const GIGACHAT = {
  oauthUrl: "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
  apiUrl: "https://gigachat.devices.sberbank.ru/api/v1",
  scope: "GIGACHAT_API_PERS",
  /** токен обновляется заранее, если до истечения осталось меньше этого */
  tokenRefreshMs: 60_000,
  /** на удаление загруженных файлов после запроса — отдельный короткий лимит, вне таймаута генерации */
  cleanupMs: 8_000,
};

export const TIMEOUTS = {
  /** основной провайдер ждём не дольше этого, чтобы резервному осталось время */
  primaryMaxMs: 75_000,
  /** сколько времени оставить резервному провайдеру, если основной завис */
  fallbackReserveMs: 40_000,
  /** меньше этого — вызов не начинаем */
  minCallMs: 5_000,
};

/** Провайдеры, для которых задан ключ, в порядке PROVIDER_ORDER. */
export function configuredProviders(): ProviderId[] {
  return PROVIDER_ORDER.filter((id) => !!Deno.env.get(PROVIDERS[id].keyEnv));
}

/**
 * Один запрос к модели с автоматическим переключением на резервный провайдер при ошибке провайдера.
 * prefer — провайдер, который надо попробовать первым (для повтора: тот же, что дал первый ответ).
 */
export async function generate(messages: ChatMessage[], deadline: number, prefer?: ProviderId): Promise<Reply> {
  const available = configuredProviders();
  const order = prefer && available.includes(prefer) ? [prefer, ...available.filter((p) => p !== prefer)] : available;
  if (!order.length) throw new ProviderError("SERVER_MISCONFIGURED", "no AI provider key configured");

  let lastError: ProviderError | null = null;
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const remaining = deadline - Date.now();
    const hasNext = i < order.length - 1;
    // пока есть резервный провайдер, основной не может занять всё оставшееся время
    const timeout = hasNext ? Math.min(TIMEOUTS.primaryMaxMs, remaining - TIMEOUTS.fallbackReserveMs) : remaining;
    if (timeout < TIMEOUTS.minCallMs) {
      if (hasNext) {
        console.warn("[analyze-pages] skip provider=" + id + ": not enough time left (" + remaining + " ms)");
        continue;
      }
      throw lastError || new ProviderError("AI_TIMEOUT", "no time left", id);
    }
    try {
      return await (id === "gigachat" ? callGigaChat(messages, timeout) : callProvider(PROVIDERS[id], messages, timeout));
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("AI_ERROR", String(e), id);
      lastError = err;
      const next = order.slice(i + 1).find((p) => p);
      if (next)
        console.warn(
          "[analyze-pages] fallback " + id + " → " + next + ": " + err.code + (err.status ? " (HTTP " + err.status + ")" : "") +
            (err.detail ? " " + err.detail : ""),
        );
    }
  }
  throw lastError || new ProviderError("AI_ERROR", "all providers failed");
}

/** HTTP-статус → код ошибки для notes.error_code (одинаково для всех провайдеров). */
function codeForStatus(status: number): string {
  if (status === 429) return "AI_RATE_LIMITED";
  if (status === 401 || status === 403) return "AI_AUTH";
  if (status >= 500) return "AI_ERROR";
  if (status === 404) return "AI_NO_ENDPOINT";
  return "AI_BAD_REQUEST";
}

async function callProvider(p: ProviderDef, messages: ChatMessage[], timeout: number): Promise<Reply> {
  const key = Deno.env.get(p.keyEnv) || "";
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const images = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((c) => c.type === "image_url").length : 0), 0);
  let res: Response;
  let body = "";
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, ...p.extraHeaders },
      body: JSON.stringify({
        model: p.model,
        messages,
        temperature: 0.2,
        max_tokens: 12000,
        stream: false,
        ...p.extraBody,
      }),
      signal: ctrl.signal,
    });
    // тело читается под тем же таймаутом: OpenRouter может быстро отдать заголовки и долго держать тело открытым
    body = await res.text();
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    console.warn("[analyze-pages] ai provider=" + p.id + " model=" + p.model + " " + (aborted ? "timeout" : "network error") + " after " + (Date.now() - started) + " ms");
    throw new ProviderError(aborted ? "AI_TIMEOUT" : "AI_NETWORK", aborted ? "timeout " + timeout + " ms" : String(e).slice(0, 200), p.id);
  } finally {
    clearTimeout(timer);
  }

  // полное время ответа: от запроса до конца тела
  const ms = Date.now() - started;
  if (!res.ok) {
    // тело ошибки может содержать подробности запроса — в лог только статус и начало текста
    const detail = body.slice(0, 300);
    console.warn("[analyze-pages] ai provider=" + p.id + " model=" + p.model + " status=" + res.status + " ms=" + ms + " images=" + images);
    throw new ProviderError(codeForStatus(res.status), res.status + " " + detail, p.id, res.status);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  // OpenRouter может вернуть 200 с ошибкой в теле (в том числе ошибку выбранной модели)
  const bodyError = data?.error || data?.choices?.[0]?.error;
  if (!data || bodyError) {
    const status = Number(bodyError?.code) || 0;
    console.warn("[analyze-pages] ai provider=" + p.id + " model=" + p.model + " status=200 body-error=" + (status || "?") + " ms=" + ms);
    throw new ProviderError(status ? codeForStatus(status) : "AI_ERROR", String(bodyError?.message || "invalid response").slice(0, 300), p.id, status);
  }

  const choice = data.choices?.[0];
  const raw = choice?.message?.content;
  const text = Array.isArray(raw) ? raw.map((x: { text?: string }) => x?.text || "").join("") : String(raw || "");
  const model = String(data.model || p.model);
  console.log(
    "[analyze-pages] ai provider=" + p.id + " model=" + p.model + (model !== p.model ? " → " + model : "") + " status=200 ms=" + ms +
      " images=" + images + " finish=" + (choice?.finish_reason || "?"),
  );
  if (choice?.finish_reason === "sensitive" || choice?.finish_reason === "content_filter") throw new ProviderError("AI_REFUSED", "", p.id, 200);
  if (!text.trim()) throw new ProviderError("AI_EMPTY_REPLY", "empty completion", p.id, 200);
  return {
    provider: p.id,
    model,
    text,
    truncated: choice?.finish_reason === "length",
    inputTokens: Number(data.usage?.prompt_tokens) || 0,
    outputTokens: Number(data.usage?.completion_tokens) || 0,
  };
}

// ---------- GigaChat ----------

type GigaMessage = { role: "system" | "user" | "assistant"; content: string; attachments?: string[] };

// HTTP-клиент с дополнительным доверенным CA Минцифры; проверка TLS-сертификатов остаётся включённой
let gigaClient: unknown;
function gigaHttpClient(): unknown {
  if (gigaClient === undefined) {
    // deno-lint-ignore no-explicit-any
    const create = (Deno as any).createHttpClient as ((o: { caCerts: string[] }) => unknown) | undefined;
    try {
      gigaClient = create ? create({ caCerts: [RUSSIAN_TRUSTED_ROOT_CA] }) : null;
    } catch (e) {
      console.warn("[analyze-pages] gigachat: custom CA client unavailable:", String(e).slice(0, 200));
      gigaClient = null;
    }
  }
  return gigaClient;
}

function gigaFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const client = gigaHttpClient();
  if (!client) throw new ProviderError("AI_NETWORK", "custom CA client unavailable", "gigachat");
  return fetch(url, { ...init, client, signal } as RequestInit);
}

// Access token живёт 30 минут; кэш на уровне экземпляра функции, обновление — заранее или после 401
let gigaToken: { value: string; expiresAt: number } | null = null;

/** Сброс кэша токена (для тестов). */
export function resetGigaChatToken() {
  gigaToken = null;
}

async function gigaAccessToken(signal: AbortSignal, force = false): Promise<string> {
  if (!force && gigaToken && gigaToken.expiresAt - Date.now() > GIGACHAT.tokenRefreshMs) return gigaToken.value;
  gigaToken = null;
  const key = Deno.env.get(PROVIDERS.gigachat.keyEnv) || "";
  const res = await gigaFetch(GIGACHAT.oauthUrl, {
    method: "POST",
    headers: {
      Authorization: "Basic " + key,
      RqUID: crypto.randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "scope=" + GIGACHAT.scope,
  }, signal);
  const body = await res.text();
  // тело ответа OAuth в лог не пишем: при успехе в нём токен
  if (!res.ok) throw new ProviderError(codeForStatus(res.status), "oauth HTTP " + res.status, "gigachat", res.status);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  const value = typeof data?.access_token === "string" ? data.access_token : "";
  if (!value) throw new ProviderError("AI_AUTH", "oauth: no access token", "gigachat", res.status);
  const expiresAt = Number(data.expires_at) || Date.now() + 25 * 60_000;
  gigaToken = { value, expiresAt };
  return value;
}

function decodeDataUrl(url: string): { bytes: Uint8Array<ArrayBuffer>; mime: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) throw new ProviderError("AI_BAD_REQUEST", "image is not a data URL", "gigachat");
  const bin = atob(m[2]);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
}

/**
 * GigaChat-2-Max: OAuth → загрузка каждой страницы через Files API → chat/completions, где каждая фотография —
 * отдельное user-сообщение со своим attachment (документированный вариант) → удаление загруженных файлов.
 * timeout покрывает всё, кроме удаления файлов (у него свой короткий лимит, чтобы файлы удалились и после таймаута).
 */
async function callGigaChat(messages: ChatMessage[], timeout: number): Promise<Reply> {
  const p = PROVIDERS.gigachat;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const fileIds: string[] = [];
  let pages = 0;
  let stage = "oauth";
  let refreshed = false;

  // запрос к API с токеном; при 401 токен один раз обновляется
  const api = async (path: string, init: RequestInit): Promise<{ res: Response; body: string }> => {
    for (;;) {
      const token = await gigaAccessToken(ctrl.signal);
      const res = await gigaFetch(GIGACHAT.apiUrl + path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: "Bearer " + token, Accept: "application/json" } }, ctrl.signal);
      const body = await res.text();
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        gigaToken = null;
        continue;
      }
      return { res, body };
    }
  };
  const fail = (status: number, body: string) => {
    console.warn("[analyze-pages] ai provider=gigachat model=" + p.model + " stage=" + stage + " status=" + status + " ms=" + (Date.now() - started) + " images=" + pages);
    return new ProviderError(codeForStatus(status), stage + " HTTP " + status + " " + body.slice(0, 200), "gigachat", status);
  };

  try {
    await gigaAccessToken(ctrl.signal);

    // сообщения GigaChat: картинки → отдельные user-сообщения с attachment, текст — как есть
    const out: GigaMessage[] = [];
    for (const m of messages) {
      if (typeof m.content === "string") {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      const texts: string[] = [];
      for (const part of m.content) {
        if (part.type !== "image_url") {
          texts.push(part.text);
          continue;
        }
        stage = "upload";
        const { bytes, mime } = decodeDataUrl(part.image_url.url);
        const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: mime }), "page-" + (pages + 1) + "." + ext);
        form.append("purpose", "general");
        const { res, body } = await api("/files", { method: "POST", body: form });
        if (!res.ok) throw fail(res.status, body);
        let id = "";
        try {
          id = String(JSON.parse(body).id || "");
        } catch { /* нет id */ }
        if (!id) throw new ProviderError("AI_ERROR", "upload: no file id", "gigachat", res.status);
        fileIds.push(id);
        out.push({ role: "user", content: "Фотография страницы index " + pages + ".", attachments: [id] });
        pages++;
      }
      if (texts.length) out.push({ role: m.role, content: texts.join("\n\n") });
    }

    stage = "chat";
    const { res, body } = await api("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: p.model, messages: out, temperature: 0.2, max_tokens: 12000, stream: false }),
    });
    const ms = Date.now() - started;
    if (!res.ok) throw fail(res.status, body);

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
    const choice = data?.choices?.[0];
    if (!choice) {
      console.warn("[analyze-pages] ai provider=gigachat model=" + p.model + " status=200 body-error ms=" + ms + " images=" + pages);
      throw new ProviderError("AI_ERROR", "invalid response", "gigachat", 200);
    }
    const text = String(choice.message?.content || "");
    // GigaChat отдаёт модель с версией: «GigaChat-2-Max:2.0.28.2»; в ai_generations — имя без версии
    const fullModel = String(data.model || p.model);
    const model = fullModel.split(":")[0] || p.model;
    const finish = String(choice.finish_reason || "?");
    console.log(
      "[analyze-pages] ai provider=gigachat model=" + p.model + (fullModel !== p.model ? " → " + fullModel : "") + " status=200 ms=" + ms +
        " images=" + pages + " finish=" + finish,
    );
    if (finish === "blacklist") throw new ProviderError("AI_REFUSED", "", "gigachat", 200);
    if (finish === "error") throw new ProviderError("AI_ERROR", "finish_reason=error", "gigachat", 200);
    if (!text.trim()) throw new ProviderError("AI_EMPTY_REPLY", "empty completion", "gigachat", 200);
    return {
      provider: "gigachat",
      model,
      text,
      truncated: finish === "length",
      inputTokens: Number(data.usage?.prompt_tokens) || 0,
      outputTokens: Number(data.usage?.completion_tokens) || 0,
    };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const aborted = ctrl.signal.aborted;
    const msg = String((e as Error)?.message || e).slice(0, 200);
    const tls = /certificate|UnknownIssuer|invalid peer|tls/i.test(msg);
    console.warn(
      "[analyze-pages] ai provider=gigachat model=" + p.model + " stage=" + stage + " " + (aborted ? "timeout" : tls ? "tls error" : "network error") +
        " after " + (Date.now() - started) + " ms images=" + pages,
    );
    throw new ProviderError(aborted ? "AI_TIMEOUT" : "AI_NETWORK", aborted ? stage + " timeout " + timeout + " ms" : stage + " " + msg, "gigachat");
  } finally {
    clearTimeout(timer);
    await deleteGigaFiles(fileIds);
  }
}

/** Удаление загруженных страниц из хранилища GigaChat; вызывается всегда (успех, ошибка, таймаут). */
async function deleteGigaFiles(ids: string[]) {
  if (!ids.length) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GIGACHAT.cleanupMs);
  const signal = ctrl.signal;
  let deleted = 0;
  for (const id of ids) {
    if (signal.aborted) break;
    try {
      const token = await gigaAccessToken(signal);
      const res = await gigaFetch(GIGACHAT.apiUrl + "/files/" + encodeURIComponent(id) + "/delete", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      }, signal);
      await res.body?.cancel();
      if (res.ok) deleted++;
    } catch {
      // лимит времени на удаление исчерпан или сеть недоступна — оставшиеся файлы отмечаются в логе ниже
    }
  }
  clearTimeout(timer);
  if (deleted === ids.length) console.log("[analyze-pages] gigachat files deleted=" + deleted);
  else console.warn("[analyze-pages] gigachat cleanup incomplete: deleted=" + deleted + " of " + ids.length);
}
