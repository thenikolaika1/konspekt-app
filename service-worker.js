/*
 * Konspekt service worker (Phase 0).
 * Сеть в приоритете: всегда берём свежие файлы с сервера (с перепроверкой HTTP-кэша),
 * успешные ответы кладём в кэш текущей версии только как запасной вариант без сети.
 * При смене VERSION старые кэши удаляются — смешения старых и новых файлов нет.
 * VERSION меняется вместе с ?v= в index.html.
 */
const VERSION = "konspekt-v19";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req.mode === "navigate" ? new Request(req.url, { cache: "no-cache" }) : new Request(req, { cache: "no-cache" }));
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = (await caches.match(req)) || (req.mode === "navigate" ? await caches.match("./") : undefined);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
