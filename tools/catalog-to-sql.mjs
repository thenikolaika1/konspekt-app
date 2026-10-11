#!/usr/bin/env node
// Справочник аналитики (analytics.catalog_paragraphs) из каталога библиотеки.
//
// Запуск из корня репозитория (локально):
//   node tools/catalog-to-sql.mjs > supabase/migrations/<время>_analytics_catalog.sql
//
// Печатает SQL-миграцию: upsert всех материалов каталога по постоянному id и retired = true для id,
// которых в каталоге больше нет (строки не удаляются — старые просмотры остаются в отчётах).
// Запускать после каждого изменения js/library-catalog.js, которое добавляет, убирает или переименовывает материалы.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({ console });
ctx.window = ctx;
for (const f of ["js/study-content.js", "js/library.js", "js/library-catalog.js"]) {
  vm.runInContext(readFileSync(f, "utf8"), ctx, { filename: f });
}
const catalog = ctx.K.library.catalog();

const q = (v) => (v === null || v === undefined || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const rows = [];
for (const s of catalog.subjects) {
  for (const b of s.books) {
    b.paragraphs.forEach((p, i) => {
      if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(p.id)) throw new Error("id не подходит для аналитики: " + p.id);
      const summary = !p.number;
      rows.push(
        `  (${[q(p.id), q(s.id), q(s.title), q(b.id), q(b.title), q(b.authors), q(b.grade), q(p.number), q(p.title), q(p.chapter), q(p.kind),
          (i + 1) * 10, summary].join(", ")})`,
      );
    });
  }
}
const ids = new Set(rows.map((r) => r.match(/^\s+\('([^']+)'/)[1]));
if (ids.size !== rows.length) throw new Error("повторяющиеся id в каталоге");

console.log(`-- Справочник материалов библиотеки для аналитики. СГЕНЕРИРОВАНО: node tools/catalog-to-sql.mjs — не править вручную.
-- Материалов: ${rows.length}. Применять после 20261011130000_analytics.

insert into analytics.catalog_paragraphs
  (id, subject_id, subject_title, book_id, book_title, book_authors, grade, number, title, chapter, kind, sort_order, is_summary)
values
${rows.join(",\n")}
on conflict (id) do update set
  subject_id = excluded.subject_id, subject_title = excluded.subject_title, book_id = excluded.book_id,
  book_title = excluded.book_title, book_authors = excluded.book_authors, grade = excluded.grade, number = excluded.number,
  title = excluded.title, chapter = excluded.chapter, kind = excluded.kind, sort_order = excluded.sort_order,
  is_summary = excluded.is_summary, retired = false, updated_at = now();

update analytics.catalog_paragraphs set retired = true, updated_at = now()
 where not retired and id not in (${[...ids].map(q).join(", ")});`);
