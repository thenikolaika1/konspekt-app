/*
 * Konspekt service worker (Phase 0).
 * Сеть в приоритете: всегда берём свежие файлы с сервера (с перепроверкой HTTP-кэша),
 * успешные ответы кладём в кэш текущей версии только как запасной вариант без сети.
 * При смене VERSION старые кэши удаляются — смешения старых и новых файлов нет.
 * VERSION меняется вместе с ?v= в index.html.
 * v62: кэшируются только GET-ответы своего сайта. Запросы к Supabase (другой адрес; тексты библиотеки — POST
 * public.get_library_paragraph) сюда не попадают и в кэш не кладутся. Активация новой версии удаляет кэши прежних,
 * в том числе с файлом js/library-catalog.js, где до v62 лежали тексты библиотеки.
 */
const VERSION = "konspekt-v68";

// v66: при установке новой версии её стартовая страница и файлы (?v= той же сборки) сразу кладутся в новый кэш.
// Раньше они попадали туда только при следующем запуске с сетью: если первый запуск после обновления был без сети,
// приложение не открывалось (кэш прежней версии к тому времени удалён). Страница другой сборки (сайт ещё не обновился
// целиком) в кэш не кладётся. Любая ошибка здесь не мешает установке — тогда всё работает как раньше.
async function precache() {
  const build = VERSION.replace("konspekt-v", "");
  const res = await fetch(new Request("./", { cache: "no-cache" }));
  if (!res.ok) return;
  const html = await res.clone().text();
  if (!html.includes("app.js?v=" + build + '"')) return;
  const files = [...html.matchAll(/(?:src|href)="(\.\/[^"]+\?v=(\d+))"/g)].filter((m) => m[2] === build).map((m) => m[1]);
  const cache = await caches.open(VERSION);
  await Promise.all(files.map((u) => fetch(new Request(u, { cache: "no-cache" })).then((r) => (r.ok ? cache.put(u, r) : null)).catch(() => {})));
  await cache.put("./", res);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precache().catch(() => {}));
});

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
