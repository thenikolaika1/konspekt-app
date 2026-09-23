/*
 * Генерация StudyContent из страниц.
 * Phase 0: mock — задержка и тестовый конспект, фотографии никуда не отправляются.
 * Phase 1: здесь будет загрузка страниц и вызов backend; контракт остаётся тем же —
 * Promise<StudyContent>, ошибка — Error с кодом в message (NO_PAGES, …).
 */
(() => {
  const K = (window.K = window.K || {});
  const MOCK_DELAY_MS = 4600;

  async function analyzePages(pages) {
    if (!pages || !pages.length) throw new Error("NO_PAGES");
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    const content = K.mock.analysisResult();
    content.meta.pages = pages.map((_, i) => ({ index: i, readable: "ok" }));
    return content;
  }

  K.generator = { kind: "mock", analyzePages };
})();
