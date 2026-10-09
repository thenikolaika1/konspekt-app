/**
 * Edge Function account-key: ключ восстановления аккаунта — без email, телефона и обычного пароля.
 *
 * POST { signOutOthers?: boolean, currentKey?: string } с заголовком Authorization: Bearer <JWT пользователя> → 200 { key }
 *
 * Ключ — 25 символов base32 (125 бит случайности из crypto.getRandomValues). Supabase Auth хранит его
 * как пароль (bcrypt) служебного логина, вычисляемого из самого ключа (keyLogin): адрес в зоне .invalid
 * (RFC 2606) никуда не доставляется, письма на него не уходят. Мы ключ не храним и не пишем в журнал.
 *
 * - user_id не меняется: анонимный пользователь становится постоянным (email_confirm), его конспекты,
 *   доступ и журнал лимита остаются как есть;
 * - каждый вызов выпускает новый ключ, старый перестаёт работать сразу (ротация);
 *   сменить уже выданный ключ можно только с текущим ключом: одной украденной сессии для этого мало;
 * - signOutOthers — заодно завершить сессии на других устройствах (если ключ мог попасть к чужим);
 * - ключ меняет только сам владелец по своему JWT; аккаунты с настоящим email этот путь не трогает.
 *
 * Секреты только из окружения функции: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (передаёт Supabase).
 */

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { keyLogin, newRecoveryKey, normalizeKey } from "./key.ts";

const ALLOWED_ORIGINS = ["https://thenikolaika1.github.io"];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
export const LOGIN_DOMAIN = "@id.konspekt.invalid";

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

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const adminKey = serviceKey();
  if (!url || !adminKey) {
    console.error("[account-key] server misconfigured");
    return json(500, { error: "SERVER_MISCONFIGURED" }, cors);
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "UNAUTHORIZED" }, cors);
  const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return json(401, { error: "UNAUTHORIZED" }, cors);

  // только анонимный пользователь или уже защищённый ключом; настоящий email/телефон этот путь не меняет
  const keyAccount = (user.email || "").endsWith(LOGIN_DOMAIN);
  if (!user.is_anonymous && !keyAccount) return json(403, { error: "NOT_ALLOWED" }, cors);
  if (user.phone) return json(403, { error: "NOT_ALLOWED" }, cors);

  let body: { signOutOthers?: unknown; currentKey?: unknown } = {};
  try {
    body = (await req.json()) || {};
  } catch { /* пустое тело — без завершения других сессий */ }

  // смена ключа: нужен текущий ключ (его служебный логин должен совпасть с логином аккаунта)
  if (keyAccount) {
    const current = typeof body.currentKey === "string" ? normalizeKey(body.currentKey) : null;
    if (!current) return json(403, { error: "CURRENT_KEY_REQUIRED" }, cors);
    if ((await keyLogin(current)).email !== user.email) return json(403, { error: "CURRENT_KEY_INVALID" }, cors);
  }

  const key = newRecoveryKey();
  const login = await keyLogin(key);
  const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
    email: login.email,
    password: login.password,
    email_confirm: true,
  });
  if (updateError) {
    // в журнал — только код, без ключа и служебного логина
    console.error("[account-key] update failed:", updateError.code || updateError.status || "error");
    return json(500, { error: "KEY_FAILED" }, cors);
  }

  if (body.signOutOthers === true) {
    const { error: outError } = await admin.auth.admin.signOut(token, "others");
    if (outError) console.warn("[account-key] sign out others failed:", outError.code || outError.status || "error");
  }

  console.log("[account-key] key issued" + (keyAccount ? " (rotation)" : " (first)") + (body.signOutOthers === true ? ", others signed out" : ""));
  return json(200, { key }, cors);
});
