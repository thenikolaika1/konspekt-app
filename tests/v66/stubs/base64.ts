// Заглушка jsr:@std/encoding/base64 для теста (без сети).
export function encodeBase64(data: Uint8Array | ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
