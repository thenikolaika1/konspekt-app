/*
 * Библиотека готовых конспектов: каталог «Класс → Предмет → Учебник → Параграф → Конспект».
 *
 * Готовый конспект показывается как есть: AI не вызывается, токены не расходуются, новый конспект не создаётся.
 * v62: публичный каталог (js/library-index.js) — только структура и пометка ready; сам текст конспекта приходит
 * с сервера (K.cloud.libraryParagraph → public.get_library_paragraph) только при действующем пробном периоде,
 * Premium или у владельца и хранится лишь в памяти страницы до выхода из аккаунта или окончания доступа (forget()).
 * Без каталога библиотека пуста и экран показывает пустое состояние.
 *
 * Формат каталога (нормализованный: каждый конспект хранится один раз):
 *   {
 *     grades:   [{ id: "8", title: "8 класс" }],                       // классы, которые показывает библиотека
 *     profiles: [{ id: "it", title: "ИТ" }],                            // необязательные профили обучения
 *     subjects: [{ id, title, books: [{ id, title, grade: "8", profiles?: ["it", …], authors?, publisher?, edition?,
 *                                        paragraphs: [{ id, number, order?, chapter?, title, ready?, content? }] }] }]
 *   }
 * Учебник ссылается на класс (grade) и на профили (profiles) по id — один учебник может относиться
 * к нескольким профилям без копирования конспектов. Класс без учебников показывается честно пустым.
 * Класс учебника — первое число из grade («8», «8 класс»); класс, упомянутый в учебнике, но не объявленный
 * в grades, добавляется автоматически. Параграфы идут по order (если не задан — первое число из number × 10);
 * повторный id на одном уровне отбрасывается, неизвестный профиль у учебника — тоже (с предупреждением).
 * ready — конспект есть на сервере; content — StudyContent (js/study-content.js), тот же формат, что у конспектов
 * по фото: в публичном каталоге его нет, он бывает только в тестовых каталогах.
 */
(() => {
  const K = (window.K = window.K || {});
  const EMPTY = { grades: [], profiles: [], subjects: [] };
  let catalog = EMPTY;

  const list = (v) => (Array.isArray(v) ? v : []);
  const firstNumber = (v) => parseInt(String(v ?? "").match(/\d+/)?.[0] || "0", 10);
  const gradeKey = (v) => String(firstNumber(v) || "");
  const orderOf = (p) => (Number.isFinite(p?.order) ? p.order : firstNumber(p?.number) * 10);
  const byOrder = (items) =>
    items
      .map((p, i) => [p, i])
      .sort((a, c) => orderOf(a[0]) - orderOf(c[0]) || a[1] - c[1])
      .map(([p]) => p);
  // элементы с id, без повторов (первый выигрывает)
  const unique = (items, where) => {
    const seen = new Set();
    return list(items).filter((x) => {
      if (!x || typeof x.id !== "string" || !x.id || seen.has(x.id)) {
        console.warn("Библиотека: пропущен элемент без id или с повторным id в", where, x?.id);
        return false;
      }
      seen.add(x.id);
      return true;
    });
  };

  function clean(next) {
    const profiles = unique(next.profiles, "profiles");
    const known = new Set(profiles.map((p) => p.id));
    const subjects = unique(next.subjects, "subjects").map((s) => ({
      ...s,
      books: unique(s.books, s.id).map((b) => {
        const own = list(b.profiles).filter((id) => known.has(id) || void console.warn("Библиотека: неизвестный профиль", id, "у учебника", b.id));
        return { ...b, grade: gradeKey(b.grade), profiles: [...new Set(own)], paragraphs: byOrder(unique(b.paragraphs, s.id + "/" + b.id)) };
      }),
    }));
    // классы: объявленные + упомянутые в учебниках; по номеру
    const grades = unique(list(next.grades).map((g) => g && { ...g, id: gradeKey(g.id) }), "grades");
    const ids = new Set(grades.map((g) => g.id));
    subjects.forEach((s) => s.books.forEach((b) => b.grade && !ids.has(b.grade) && (ids.add(b.grade), grades.push({ id: b.grade }))));
    grades.forEach((g) => (g.title = g.title || g.id + " класс"));
    grades.sort((a, b) => firstNumber(a.id) - firstNumber(b.id));
    return { grades, profiles, subjects };
  }

  const grades = () => catalog.grades;
  const grade = (id) => grades().find((g) => g.id === gradeKey(id)) || null;
  const profiles = () => catalog.profiles;
  const profile = (id) => profiles().find((p) => p.id === id) || null;
  // скрытые предметы (K.config.hiddenLibrarySubjects) экраны библиотеки не видят; catalog() по-прежнему отдаёт всё
  const hidden = new Set(list((K.config || {}).hiddenLibrarySubjects));
  const subjects = () => catalog.subjects.filter((s) => !hidden.has(s.id));
  const subject = (id) => subjects().find((s) => s.id === id) || null;
  /** учебники предмета; с gradeId — только этого класса */
  const books = (subjectId, gradeId) => list(subject(subjectId)?.books).filter((b) => !gradeId || b.grade === gradeKey(gradeId));
  const book = (subjectId, bookId) => books(subjectId).find((b) => b.id === bookId) || null;
  const paragraphs = (subjectId, bookId) => list(book(subjectId, bookId)?.paragraphs);
  const paragraph = (subjectId, bookId, paragraphId) => paragraphs(subjectId, bookId).find((p) => p.id === paragraphId) || null;
  /** предметы, у которых есть учебники этого класса */
  const subjectsIn = (gradeId) => subjects().filter((s) => books(s.id, gradeId).length);
  /** учебники, относящиеся к профилю (один учебник — в нескольких профилях, без копий) */
  const booksForProfile = (profileId) => subjects().flatMap((s) => s.books.filter((b) => b.profiles.includes(profileId)).map((b) => ({ subjectId: s.id, book: b })));
  /** готов ли конспект параграфа (текст — на сервере, ready, или прямо в тестовом каталоге) */
  const isReady = (p) => !!(p && (p.ready || p.content));
  const readyIn = (items) => items.filter(isReady).length;
  /** число готовых конспектов: учебника, предмета в классе или всего класса */
  const readyCount = ({ gradeId, subjectId, bookId } = {}) =>
    (subjectId ? [subject(subjectId)].filter(Boolean) : subjects())
      .flatMap((s) => books(s.id, gradeId).filter((b) => !bookId || b.id === bookId))
      .reduce((n, b) => n + readyIn(b.paragraphs), 0);

  /** Подключение каталога: данные (js/library-index.js) или тесты. Неверный формат — пустой каталог. */
  function setCatalog(next) {
    catalog = next && Array.isArray(next.subjects) ? clean(next) : EMPTY;
    forget();
  }

  // тексты, полученные с сервера в этой сессии: только в памяти (не в localStorage и не в кэше PWA)
  const texts = new Map();
  const loading = new Map();
  let generation = 0;
  const keyOf = (subjectId, bookId, paragraphId) => subjectId + "/" + bookId + "/" + paragraphId;
  /** текст параграфа, если он уже есть: из памяти или из тестового каталога; иначе null */
  function text(subjectId, bookId, paragraphId) {
    const p = paragraph(subjectId, bookId, paragraphId);
    if (!p) return null;
    return p.content || texts.get(keyOf(subjectId, bookId, paragraphId)) || null;
  }
  /**
   * Текст параграфа с сервера (один запрос на параграф, повторные вызовы ждут его). Ошибка — Error с кодом:
   * ACCESS_REQUIRED (e.access — состояние доступа с сервера), NOT_FOUND, LIBRARY_UNAVAILABLE (нет облака)
   * или сетевая ошибка K.cloud (CONNECTION_LOST и т. п.).
   */
  function load(subjectId, bookId, paragraphId) {
    const ready = text(subjectId, bookId, paragraphId);
    if (ready) return Promise.resolve(ready);
    const p = paragraph(subjectId, bookId, paragraphId);
    if (!isReady(p)) return Promise.reject(new Error("NOT_FOUND"));
    const key = keyOf(subjectId, bookId, paragraphId);
    if (loading.has(key)) return loading.get(key);
    const cloud = K.cloud;
    if (!cloud?.enabled || typeof cloud.libraryParagraph !== "function") return Promise.reject(new Error("LIBRARY_UNAVAILABLE"));
    const gen = generation;
    const job = cloud
      .libraryParagraph(subjectId, bookId, paragraphId)
      .then((content) => {
        if (!content || typeof content !== "object") throw new Error("NOT_FOUND");
        if (gen === generation) texts.set(key, content); // после forget() ответ старого запроса не сохраняется
        return content;
      })
      .finally(() => loading.get(key) === job && loading.delete(key));
    loading.set(key, job);
    return job;
  }
  /** забыть все полученные тексты (выход из аккаунта, смена аккаунта, доступ закончился) */
  function forget() {
    generation++;
    texts.clear();
    loading.clear();
  }
  /** полная копия каталога (для тестов и расширения данными) */
  const exportCatalog = () => JSON.parse(JSON.stringify(catalog));

  K.library = {
    grades, grade, profiles, profile, subjects, subject, subjectsIn, books, book, booksForProfile, paragraphs, paragraph,
    ready: isReady, readyCount, text, load, forget, setCatalog, catalog: exportCatalog,
  };
})();
