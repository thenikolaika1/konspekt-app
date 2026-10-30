#!/usr/bin/env node
// Пробный прогон миграции: тот же SQL, только последняя строка «commit;» заменена на «rollback;» — все шаги и
// самопроверки выполняются, затем транзакция откатывается и база остаётся как была.
// Запуск из корня репозитория: node tools/make-dryrun.mjs <миграция.sql> <пробный прогон.sql>
// tests/v62/prodcopy.test.sh пересобирает файл и сравнивает с supabase/release/v62-dryrun.sql (файлы не должны расходиться).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("Использование: node tools/make-dryrun.mjs <миграция.sql> <пробный прогон.sql>");
  process.exit(2);
}
const sql = readFileSync(src, "utf8");
const end = sql.lastIndexOf("\ncommit;\n");
if (end < 0) throw new Error("в миграции нет строки commit;");
const name = path.basename(src);
const head =
  "-- =====================================================================================\n" +
  "-- ПРОБНЫЙ ПРОГОН — НИЧЕГО НЕ СОХРАНЯЕТ. Сгенерирован: node tools/make-dryrun.mjs из " + name + ":\n" +
  "-- тот же файл, только последняя строка «commit;» заменена на «rollback;». Все шаги и самопроверки миграции\n" +
  "-- выполняются (в том числе ветка PostgreSQL 17 — снятие MAINTAIN), затем транзакция откатывается: база остаётся как была.\n" +
  "-- Назначение: проверить миграцию на той же версии PostgreSQL, что в production, до настоящего применения.\n" +
  "-- На время прогона (доли секунды) функции, которые меняет миграция, заблокированы — как при настоящем применении.\n" +
  "-- Ожидаемый конец вывода: «NOTICE: ПРОБНЫЙ ПРОГОН пройден…» и «ROLLBACK». Ошибка — миграция в этой базе не пройдёт.\n" +
  "-- Не редактировать вручную.\n" +
  "-- =====================================================================================\n";
const tail =
  "\ndo $$ begin raise notice 'ПРОБНЫЙ ПРОГОН пройден: все шаги и самопроверки выполнены, сейчас всё будет отменено (rollback)'; end $$;\n" +
  "rollback;\n";
writeFileSync(out, head + sql.slice(0, end) + tail + sql.slice(end + "\ncommit;\n".length));
console.error("Пробный прогон: " + out);
