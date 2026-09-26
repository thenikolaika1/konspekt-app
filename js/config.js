/*
 * Публичные параметры Supabase для браузера.
 *
 * Здесь только то, что по замыслу Supabase открыто в браузере: Project URL и publishable key.
 * Доступ к данным ограничивают RLS-политики (каждый видит только свои строки и файлы).
 * Серверные секреты (ZAI_API_KEY, service_role / secret key, пароль БД) сюда НЕ добавлять —
 * они живут только в Supabase (Edge Function Secrets).
 *
 * Пустой supabaseUrl → приложение работает как раньше, на mock-генерации без сети.
 */
(() => {
  const K = (window.K = window.K || {});
  K.config = {
    supabaseUrl: "https://ohdeykbkgimvwstkwuuf.supabase.co",
    supabaseKey: "sb_publishable_7t0cfHxy6z5QU4N1qW-4Og_6qcPhaQ_",
    analyzeFunction: "analyze-pages",
    pagesBucket: "temp-pages",
  };
})();
