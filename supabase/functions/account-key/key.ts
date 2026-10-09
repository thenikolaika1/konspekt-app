/**
 * Ключ восстановления: формат и служебный логин Supabase Auth.
 * Ключ создаёт браузер (js/cloud.js, newRecoveryKey); keyLogin — тот же алгоритм, что там; тесты проверяют совпадение.
 */

/** Crockford base32: без I, L, O, U — их не спутать при переписывании; 32 символа = ровно 5 бит. */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const KEY_LENGTH = 25; // 125 бит

/** Ввод пользователя → 25 символов алфавита или null. Регистр, пробелы и дефисы не важны; O→0, I/L→1. */
export function normalizeKey(input: string): string | null {
  const s = String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return s.length === KEY_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/**
 * Служебный логин для Supabase Auth, вычисляемый из ключа: адрес — первые 160 бит sha256 в зоне .invalid
 * (недоставляема по RFC 2606), пароль — сам ключ с постоянным префиксом (на случай требований к составу пароля).
 * Bcrypt-хэш пароля хранит Supabase Auth; ни ключ, ни логин мы не храним.
 */
export async function keyLogin(key: string): Promise<{ email: string; password: string }> {
  const k = normalizeKey(key);
  if (!k) throw new Error("KEY_FORMAT");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("konspekt-recovery-v1:" + k));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return { email: "k" + hex.slice(0, 40) + "@id.konspekt.invalid", password: "Kn-1." + k };
}
