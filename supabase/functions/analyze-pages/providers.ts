/**
 * AI-провайдеры для analyze-pages: единый вызов «сообщения → текст ответа модели».
 *
 * Порядок провайдеров задаётся PROVIDER_ORDER: первый — основной, остальные — резервные.
 * Сейчас: OpenRouter (qwen/qwen3.8-27b:free) → Z.AI (glm-4.6v-flash).
 *
 * Переключение на резервный провайдер происходит только при ошибке самого провайдера:
 * HTTP-ошибка (429, 5xx, 4xx — в том числе «нет доступного бесплатного vision-endpoint»),
 * таймаут, сетевая ошибка, ошибка в теле ответа, пустой ответ. Если модель ответила,
 * но конспект не прошёл проверку качества, это решает index.ts (повтор у того же провайдера).
 *
 * Ключи берутся только из окружения функции (Deno.env) и никогда не пишутся в лог.
 * В лог попадают: провайдер, модель, HTTP-статус, время, причина переключения.
 */

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

export type ProviderId = "openrouter" | "zai";

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
export const PROVIDER_ORDER: ProviderId[] = ["openrouter", "zai"];

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
      return await callProvider(PROVIDERS[id], messages, timeout);
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
