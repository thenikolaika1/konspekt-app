/*
 * Библиотека готовых конспектов: каталог «Класс → Предмет → Учебник → Параграф → Конспект».
 *
 * Готовый конспект показывается из каталога как есть: AI не вызывается, токены не расходуются,
 * новый конспект не создаётся. Данные каталога — js/library-catalog.js; без него каталог пуст и экран
 * библиотеки показывает пустое состояние.
 *
 * Формат каталога (нормализованный: каждый конспект хранится один раз):
 *   {
 *     grades:   [{ id: "8", title: "8 класс" }],                       // классы, которые показывает библиотека
 *     profiles: [{ id: "it", title: "ИТ" }],                            // необязательные профили обучения
 *     subjects: [{ id, title, books: [{ id, title, grade: "8", profiles?: ["it", …], authors?, publisher?, edition?,
 *                                        paragraphs: [{ id, number, order?, chapter?, title, content? }] }] }]
 *   }
 * Учебник ссылается на класс (grade) и на профили (profiles) по id — один учебник может относиться
 * к нескольким профилям без копирования конспектов. Класс без учебников показывается честно пустым.
 * Класс учебника — первое число из grade («8», «8 класс»); класс, упомянутый в учебнике, но не объявленный
 * в grades, добавляется автоматически. Параграфы идут по order (если не задан — первое число из number × 10);
 * повторный id на одном уровне отбрасывается, неизвестный профиль у учебника — тоже (с предупреждением).
 * content — StudyContent (js/study-content.js), тот же формат, что у конспектов по фото.
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
  const subjects = () => catalog.subjects;
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
  const readyIn = (items) => items.filter((p) => p.content).length;
  /** число готовых конспектов: учебника, предмета в классе или всего класса */
  const readyCount = ({ gradeId, subjectId, bookId } = {}) =>
    (subjectId ? [subject(subjectId)].filter(Boolean) : subjects())
      .flatMap((s) => books(s.id, gradeId).filter((b) => !bookId || b.id === bookId))
      .reduce((n, b) => n + readyIn(b.paragraphs), 0);

  /** Подключение каталога: данные (js/library-catalog.js) или тесты. Неверный формат — пустой каталог. */
  function setCatalog(next) {
    catalog = next && Array.isArray(next.subjects) ? clean(next) : EMPTY;
  }
  /** полная копия каталога (для тестов и расширения данными) */
  const exportCatalog = () => JSON.parse(JSON.stringify(catalog));

  K.library = { grades, grade, profiles, profile, subjects, subject, subjectsIn, books, book, booksForProfile, paragraphs, paragraph, readyCount, setCatalog, catalog: exportCatalog };
})();
