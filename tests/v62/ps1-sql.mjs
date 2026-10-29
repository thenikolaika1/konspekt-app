#!/usr/bin/env node
// Достаёт из supabase/release/v62-local-pg17-check.ps1 SQL-запросы и регулярное выражение фильтра оглавления копии,
// чтобы prodcopy.test.sh выполнил ИМЕННО их (PowerShell в среде тестов нет). Печатает JSON:
//   { q: [запросы Q "..."], struct, funcs, objs, rows (шаблон с $vals), skip (регулярное выражение), roles: [...] }
import { readFileSync } from "node:fs";

const s = readFileSync(process.argv[2], "utf8").replace(/^﻿/, "");
const one = (re, what) => {
  const m = s.match(re);
  if (!m) throw new Error("в скрипте не найдено: " + what);
  return m[1];
};
// строка PowerShell в двойных кавычках: `" → "
const ps = (x) => x.replace(/`"/g, '"');
const q = [...s.matchAll(/\bQ (?:\(?"((?:[^"`]|`.)*)"|'([^']*)')/g)].map((m) => (m[1] !== undefined ? ps(m[1]) : m[2]));
const rowsParts = one(/Lines \(Q \(((?:"[^"]*"\s*\+?\s*)+)\)\)/, "запрос числа строк");
const rows = [...rowsParts.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
const roles = [...one(/\$roles = @\(([^)]*)\)/, "роли").matchAll(/'([^']+)'/g)].map((m) => m[1]);
// разбор журнала pg_restore: регулярные выражения цикла по строкам (по порядку) и список событийных триггеров Supabase
const loop = one(/(foreach \(\$ln in \(\$script:lastErr[\s\S]*?\n  \})\n/, "цикл разбора журнала");
const logre = [...loop.matchAll(/-match '([^']*)'/g)].map((m) => m[1]);
const known = one(/\$b\.cmd -match '([^']*)'/, "образец известной ошибки");
const evt = [...one(/\$superOwnedEvt = @\(([^)]*)\)/, "триггеры Supabase").matchAll(/'([^']+)'/g)].map((m) => m[1]);
console.log(JSON.stringify({
  q,
  struct: ps(one(/\$structSql = "([^"]*)"/, "$structSql")),
  funcs: ps(one(/\$funcsSql = "([^"]*)"/, "$funcsSql")),
  objs: ps(one(/\$objs = Q "([^"]*)"/, "$objs")),
  rows,
  skip: one(/\$skip = @\(\$toc \| Where-Object \{ \$_ -match '([^']*)' \}\)/, "фильтр vault"),
  roles,
  logre,
  known,
  evt,
}));
