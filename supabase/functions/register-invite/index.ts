/**
 * Edge Function register-invite: самостоятельная регистрация ученика по одноразовому приглашению.
 *
 * Запрос: POST { code, id, key } — код приглашения, ID (KN-XXXXXX) и секретный ключ, которые сгенерировало
 * приложение (оно хранит их до подтверждения, поэтому повтор после сбоя продолжает ту же регистрацию).
 * Ответ 200 { status: "ok", id } — аккаунт создан, право beta_invite (quota 1) выдано, код погашен;
 * дальше приложение входит по ID и ключу. Ошибка — { error: CODE } (INVALID, EXPIRED, USED, BUSY, ID_TAKEN,
 * RATE_LIMITED, BAD_REQUEST, TEMPORARY).
 *
 * Шаги (миграция 20261018120000): register_invite_begin (резерв кода под блокировкой) → пользователь Supabase Auth
 * (Admin API, метка резерва в app_metadata) → register_invite_finish (право + погашение одной транзакцией).
 * Admin API и транзакция БД — не одна транзакция; согласованность держат резерв и метка (см. миграцию).
 *
 * Функция вызывается без входа (verify_jwt = false): клиент ещё не имеет аккаунта. Права service_role — только здесь.
 * Ключ уходит только в Supabase Auth (хранится там как bcrypt) и никогда не пишется в журнал.
 */

const ALLOWED_ORIGINS = ["https://thenikolaika1.github.io"];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ID = /^KN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const KEY = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{20}$/;
const PASSWORD_PREFIX = "Kn-2."; // как в js/cloud.js (idLogin)
const REQUEST_TIMEOUT_MS = 10_000;

const ERRORS: Record<string, [number, string]> = {
  invalid: [400, "INVALID"],
  expired: [400, "EXPIRED"],
  used: [409, "USED"],
  busy: [409, "BUSY"],
  id_taken: [409, "ID_TAKEN"],
  rate_limited: [429, "RATE_LIMITED"],
  bad_request: [400, "BAD_REQUEST"],
  invalid_state: [503, "TEMPORARY"],
};

class Temporary extends Error {}

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
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || "";
  } catch {
    return "";
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const emailOf = (id: string) => "id-" + id.toLowerCase() + "@id.konspekt.invalid";

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  const url = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = serviceKey();
  if (!url || !key) {
    console.error("[register-invite] misconfigured");
    return json(500, { error: "TEMPORARY" }, cors);
  }
  const H = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };

  // запрос регистрации — несколько десятков байт; большое тело не читаем вовсе
  if (Number(req.headers.get("content-length") || "0") > 1000) return json(413, { error: "BAD_REQUEST" }, cors);
  let body: { code?: unknown; id?: unknown; key?: unknown };
  try {
    const text = await req.text();
    if (text.length > 1000) return json(400, { error: "BAD_REQUEST" }, cors);
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "BAD_REQUEST" }, cors);
  }
  const code = typeof body.code === "string" ? body.code : "";
  const id = typeof body.id === "string" ? body.id : "";
  const secret = typeof body.key === "string" ? body.key : "";
  if (!code || code.length > 64 || !ID.test(id) || !KEY.test(secret)) return json(400, { error: "BAD_REQUEST" }, cors);

  // IP только как хэш с секретной солью (ограничение частоты); сам IP не хранится
  // IP клиента — из заголовка, который ставит прокси Supabase (клиент его не подменит); запасной — x-forwarded-for
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const ipHash = await sha256Hex("konspekt-register:" + key.slice(-16) + ":" + ip);

  const timed = (init: RequestInit) => ({ ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  async function rpc(fn: string, args: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetch(url + "/rest/v1/rpc/" + fn, timed({ method: "POST", headers: H, body: JSON.stringify(args) }));
    } catch {
      throw new Temporary(fn + ": no response");
    }
    if (!res.ok) throw new Temporary(fn + ": HTTP " + res.status);
    return await res.json();
  }
  async function admin(method: string, path: string, payload?: unknown) {
    try {
      const res = await fetch(url + "/auth/v1/admin/users" + path, timed({ method, headers: H, body: payload ? JSON.stringify(payload) : undefined }));
      let data: Record<string, unknown> = {};
      try {
        data = await res.json();
      } catch { /* пустой ответ */ }
      return { status: res.status, data };
    } catch {
      throw new Temporary("admin " + method + ": no response");
    }
  }

  const fail = (r: string) => {
    const [status, error] = ERRORS[r] || [503, "TEMPORARY"];
    return json(status, { error }, cors);
  };

  try {
    let begin = await rpc("register_invite_begin", { p_code: code, p_kn_id: id, p_ip_hash: ipHash });
    if (begin.result === "done") return json(200, { status: "ok", id }, cors);
    if (begin.result !== "reserved" && begin.result !== "resume") {
      console.log("[register-invite] refused:", begin.result);
      return fail(begin.result);
    }

    // брошенный резерв другого устройства: его пользователь без права — удаляем
    if (begin.orphan_user_id) {
      const del = await admin("DELETE", "/" + begin.orphan_user_id);
      if (del.status >= 300 && del.status !== 404) throw new Temporary("orphan delete: HTTP " + del.status);
      console.log("[register-invite] orphan account removed");
    }

    const reservation: string = begin.reservation;
    let userId: string | null = begin.user_id || null;
    if (!userId) {
      const created = await admin("POST", "", {
        email: emailOf(id),
        password: PASSWORD_PREFIX + secret,
        email_confirm: true,
        user_metadata: { kn_id: id },
        // метка резерва — в app_metadata: её меняет только сервер, пользователь подделать не может
        app_metadata: { kn_reservation: reservation },
      });
      if (created.status === 200 || created.status === 201) {
        userId = String(created.data.id || "");
      } else {
        // не создан: возможно, его уже создал параллельный запрос этого же резерва (двойное нажатие) —
        // Auth отвечает 422 или, при гонке на уникальном email, 500. Проверяем резерв ещё раз и ищем «своего».
        begin = await rpc("register_invite_begin", { p_code: code, p_kn_id: id, p_ip_hash: ipHash });
        if (begin.result === "done") return json(200, { status: "ok", id }, cors);
        if (begin.result === "resume" && begin.reservation === reservation && begin.user_id) userId = begin.user_id;
        else if (created.status === 422) return fail(begin.result === "resume" ? "id_taken" : begin.result);
        else throw new Temporary("create user: HTTP " + created.status);
      }
    } else {
      // повтор: пользователь этого резерва уже создан — ключ задаётся тот, что сейчас у приложения
      const upd = await admin("PUT", "/" + userId, { password: PASSWORD_PREFIX + secret });
      if (upd.status >= 300) throw new Temporary("update user: HTTP " + upd.status);
    }
    if (!userId) throw new Temporary("no user id");

    const fin = await rpc("register_invite_finish", { p_code: code, p_reservation: reservation, p_user_id: userId });
    if (fin.result !== "done") {
      console.log("[register-invite] finish refused:", fin.result);
      return fail(fin.result);
    }
    console.log("[register-invite] registered");
    return json(200, { status: "ok", id }, cors);
  } catch (e) {
    // только код шага и HTTP-статус: без кода приглашения, ID и ключа
    console.warn("[register-invite] temporary:", e instanceof Temporary ? e.message : "internal");
    return json(503, { error: "TEMPORARY" }, cors);
  }
});
