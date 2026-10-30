#!/usr/bin/env node
// Библиотека v62: из исходного каталога с текстами (хранится ВНЕ публичного репозитория) делает
//   1) js/library-index.js — публичный каталог без текстов: классы, предметы, учебники, параграфы, ready;
//   2) SQL-файл с текстами для private.library_paragraphs — ЗАКРЫТЫЙ, в репозиторий не кладётся.
//
// Запуск из корня репозитория:
//   node tools/library-split.mjs --git 53d3203:js/library-catalog.js --index js/library-index.js --seed <вне репозитория>/library-seed.sql
//   (или <исходный library-catalog.js> вместо --git). --git читает исходник прямо из git байт в байт: так его не
//   перекодирует оболочка (PowerShell «git show … > файл» портит кириллицу, и тексты перестают совпадать)
//   [--subjects history,physics]   — чьи тексты заливаются (остальные предметы в каталоге остаются «Скоро»)
//   [--expect <manifest.tsv>]      — контрольные суммы каждого параграфа: SQL проверит их сам и при любом расхождении
//                                    откатит загрузку целиком. Манифест (subject<TAB>book<TAB>paragraph<TAB>sha256 текста
//                                    content::text, как его хранит PostgreSQL) получают на тестовой копии: загрузить SQL
//                                    без --expect, выполнить запрос «Манифест» из конца файла, сохранить вывод.
//
// Повторный запуск с тем же исходником даёт те же файлы. SQL-файл повторяемый: upsert по (предмет, учебник, параграф),
// чужие строки не трогает и ничего не удаляет. Новый класс или учебник (например, 7 класс) — добавить в исходник и
// запустить снова, затем применить SQL и опубликовать новый library-index.js.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import vm from "node:vm";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const gitSpec = opt("--git");
const source = gitSpec ? "git:" + gitSpec : args[0];
const indexOut = opt("--index");
const seedOut = opt("--seed");
const subjects = new Set(opt("--subjects", "history,physics").split(",").filter(Boolean));
const expectFile = opt("--expect");
if (!source || source.startsWith("--") || !indexOut || !seedOut) {
  console.error("Использование: node tools/library-split.mjs (--git <коммит>:<путь> | <исходный каталог>) --index js/library-index.js --seed <файл.sql> [--subjects history,physics] [--expect <манифест>]");
  process.exit(2);
}
const repo = process.cwd();
if (path.resolve(seedOut).startsWith(repo + path.sep)) {
  console.error("SQL с текстами нельзя сохранять внутри репозитория: " + seedOut);
  process.exit(2);
}

// исходник: тот же формат, что у прежнего js/library-catalog.js (window.K.library.setCatalog({...}))
const srcBuf = gitSpec ? execFileSync("git", ["show", gitSpec], { maxBuffer: 256 * 1024 * 1024 }) : readFileSync(source);
const sha = createHash("sha256").update(srcBuf).digest("hex");
// манифест может назначить исходник: строка «# source-sha256 <hex>». Другой исходник (не тот коммит или перекодированный
// оболочкой) — отказ сразу, а не ошибка контрольных сумм при загрузке в базу
if (expectFile) {
  const want = (readFileSync(expectFile, "utf8").match(/^# source-sha256 ([0-9a-f]{64})\b/m) || [])[1];
  if (want && want !== sha) {
    console.error("Исходник не тот: sha256 " + sha + ", манифест ожидает " + want + ".\n" +
      "Если исходник сохранён командой PowerShell «git show … > файл» — она перекодирует текст. Запустите с --git 53d3203:js/library-catalog.js");
    process.exit(3);
  }
}
let raw = null;
const ctx = vm.createContext({ console: { warn() {}, log() {} } });
ctx.window = ctx;
ctx.K = { library: { setCatalog: (c) => (raw = c) } };
vm.runInContext(srcBuf.toString("utf8"), ctx, { filename: path.basename(source) });
if (!raw || !Array.isArray(raw.subjects)) throw new Error("в исходнике нет каталога (setCatalog)");
const catalog = JSON.parse(JSON.stringify(raw));

const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const rows = [];
const index = { ...catalog, subjects: [] };
for (const s of catalog.subjects) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(s.id)) throw new Error("id предмета не подходит: " + s.id);
  const books = (s.books || []).map((b) => {
    if (!ID.test(b.id)) throw new Error("id учебника не подходит: " + b.id);
    const paragraphs = (b.paragraphs || []).map((p) => {
      if (!ID.test(p.id)) throw new Error("id параграфа не подходит: " + p.id);
      // source — служебные пометки о происхождении текста (приложению не нужны), content — сам текст: не публикуются
      const { content, source, ...meta } = p;
      const upload = !!content && subjects.has(s.id);
      if (upload) rows.push({ s: s.id, b: b.id, p: p.id, content });
      return { ...meta, ready: upload };
    });
    return { ...b, paragraphs };
  });
  index.subjects.push({ ...s, books });
}
const keys = new Set(rows.map((r) => r.s + "/" + r.b + "/" + r.p));
if (keys.size !== rows.length) throw new Error("повторяющиеся параграфы в исходнике");

// контрольные суммы из манифеста: ровно по одной на каждый загружаемый параграф
let expect = null;
if (expectFile) {
  expect = new Map();
  for (const line of readFileSync(expectFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
    const [s, b, p, h] = line.trim().split("\t");
    if (!/^[0-9a-f]{64}$/.test(h || "")) throw new Error("строка манифеста не подходит: " + line);
    expect.set(s + "/" + b + "/" + p, h);
  }
  const missing = rows.filter((r) => !expect.has(r.s + "/" + r.b + "/" + r.p)).map((r) => r.s + "/" + r.b + "/" + r.p);
  if (missing.length || expect.size !== rows.length) throw new Error("манифест не совпадает с исходником: нет " + missing.join(", ") + "; строк " + expect.size + " из " + rows.length);
}
const counts = [...subjects].map((id) => id + ": " + rows.filter((r) => r.s === id).length).join(", ");

const indexJs =
  "/*\n" +
  " * Каталог библиотеки готовых конспектов БЕЗ ТЕКСТОВ (v62). СГЕНЕРИРОВАНО: node tools/library-split.mjs — не править вручную.\n" +
  " * Тексты конспектов — в закрытой таблице private.library_paragraphs; приложение получает их через\n" +
  " * public.get_library_paragraph только при действующем пробном периоде, Premium или у владельца.\n" +
  " * ready: true — конспект есть на сервере. Формат — в шапке js/library.js. Подключается после js/library.js.\n" +
  " */\n" +
  "(() => {\n  window.K.library.setCatalog(" +
  JSON.stringify(index, null, 1) +
  ");\n})();\n";
if (/"content"\s*:/.test(indexJs)) throw new Error("в публичный каталог попал текст конспекта");
writeFileSync(indexOut, indexJs);

const lit = (v) => {
  const j = JSON.stringify(v);
  if (j.includes("$kn$")) throw new Error("в тексте встретился разделитель $kn$");
  return "$kn$" + j + "$kn$::jsonb";
};
const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const seed =
  "-- ЗАКРЫТЫЙ ФАЙЛ: тексты платной библиотеки Konspekt. НЕ коммитить, не публиковать, не пересылать.\n" +
  "-- Сгенерировано tools/library-split.mjs из исходника sha256 " + sha + ".\n" +
  "-- Параграфов: " + rows.length + " (" + counts + "). Применять после 20261028120000_v62_paid_library.sql.\n" +
  "-- Повторяемый: upsert по (subject_id, book_id, paragraph_id); другие строки не трогает и ничего не удаляет.\n" +
  "begin;\n" +
  "insert into private.library_paragraphs as l (subject_id, book_id, paragraph_id, content) values\n" +
  rows.map((r) => "(" + [q(r.s), q(r.b), q(r.p), lit(r.content)].join(", ") + ")").join(",\n") +
  "\non conflict (subject_id, book_id, paragraph_id) do update\n" +
  "   set content = excluded.content, updated_at = now()\n" +
  " where l.content is distinct from excluded.content;\n" +
  "do $$\nbegin\n" +
  "  if (select count(*) from private.library_paragraphs l where (l.subject_id, l.book_id, l.paragraph_id) in (" +
  rows.map((r) => "(" + [q(r.s), q(r.b), q(r.p)].join(", ") + ")").join(", ") +
  ")) <> " + rows.length + " then\n" +
  "    raise exception 'загружены не все параграфы';\n  end if;\nend $$;\n" +
  (expect
    ? "-- контрольная сумма каждого параграфа (sha256 content::text); расхождение — откат всей загрузки\n" +
      "do $$\ndeclare v_bad text;\nbegin\n" +
      "  select string_agg(e.s || '/' || e.b || '/' || e.p, ', ') into v_bad\n" +
      "    from (values\n" + rows.map((r) => "    (" + [q(r.s), q(r.b), q(r.p), q(expect.get(r.s + "/" + r.b + "/" + r.p))].join(", ") + ")").join(",\n") +
      "\n  ) as e(s, b, p, h)\n" +
      "    left join private.library_paragraphs l on (l.subject_id, l.book_id, l.paragraph_id) = (e.s, e.b, e.p)\n" +
      "   where l.content is null or encode(sha256(convert_to(l.content::text, 'UTF8')), 'hex') <> e.h;\n" +
      "  if v_bad is not null then\n    raise exception 'контрольная сумма не совпала: %', v_bad;\n  end if;\n" +
      "  raise notice 'контрольные суммы совпали: % параграфов', " + rows.length + ";\nend $$;\n"
    : "") +
  "commit;\n" +
  "-- Проверка (одинаковый результат на тестовой копии и в production означает одинаковые тексты):\n" +
  "select subject_id, count(*) as paragraphs,\n" +
  "       encode(sha256(convert_to(string_agg(book_id || '/' || paragraph_id || '=' || content::text, '|' order by book_id, paragraph_id), 'UTF8')), 'hex') as sha256\n" +
  "  from private.library_paragraphs group by subject_id order by subject_id;\n" +
  "-- Манифест (контрольная сумма каждого параграфа; для --expect):\n" +
  "-- select subject_id || chr(9) || book_id || chr(9) || paragraph_id || chr(9) || encode(sha256(convert_to(content::text, 'UTF8')), 'hex')\n" +
  "--   from private.library_paragraphs order by 1;\n";
writeFileSync(seedOut, seed);
console.error("Каталог без текстов: " + indexOut + "; закрытый SQL: " + seedOut + " — параграфов " + rows.length + " (" + counts + ")" +
  (expect ? "; контрольные суммы каждого параграфа встроены" : ""));
