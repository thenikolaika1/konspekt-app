#!/usr/bin/env node
// Выпуск одноразовых кодов раннего доступа (Friends & Family).
//
// Запуск локально (не в CI и не на сервере):
//   node tools/ff-invite-codes.mjs --count 5 --quota 1 --label "F&F октябрь" --expires 2026-10-19T00:00:00+03:00
//
// Печатает:
//   1) открытые коды — раздать людям лично (никуда не коммитить, не вставлять в SQL);
//   2) SQL только с sha256 кодов — выполнить в Supabase SQL Editor.
// Нормализация совпадает с private.invite_code_normalize() (миграция 20261011120500): регистр, пробелы,
// дефисы и кириллические буквы-двойники (КМРТ = KMPT) не важны.
// quota задаётся при выпуске и сохраняется у каждого кода; числа по умолчанию нет.

import { createHash, randomInt } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const count = Number(args.count);
const quota = Number(args.quota);
const label = args.label ?? null;
// --expires: до какого момента код можно активировать (ISO 8601 с часовым поясом); без него — бессрочно
const expires = args.expires ?? null;
if (expires !== null && (!/(Z|[+-]\d\d:\d\d)$/.test(expires) || Number.isNaN(Date.parse(expires)))) {
  console.error("--expires: ISO 8601 с часовым поясом, например 2026-10-19T00:00:00+03:00");
  process.exit(1);
}
if (!Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(quota) || quota < 1) {
  console.error('Usage: node tools/ff-invite-codes.mjs --count <1..200> --quota <N> [--label "..."] [--expires <ISO 8601>]');
  process.exit(1);
}

// 29 символов без похожих (0/O, 1/I/L, U/V): 12 символов ≈ 58 бит — перебор невозможен.
// Кириллические двойники латинских букв (А, В, С, Е, Н, К, М, Р, Т, Х, У, З→3) при вводе принимаются,
// поэтому алфавит прежний: уже выпущенные коды остаются действительными.
const ALPHABET = "ABCDEFGHJKMNPQRSTWXYZ23456789";
const CYRILLIC = "АВСЕНКМОРТХУЗавсенкмортхуз";
const LATIN = "ABCEHKMOPTXY3abcehkmoptxy3";
const code = () => {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
};
// как private.invite_code_normalize: двойники → латиница, затем только [0-9A-Z]
const normalize = (c) => [...c].map((ch) => { const i = CYRILLIC.indexOf(ch); return i < 0 ? ch : LATIN[i]; }).join("").toUpperCase().replace(/[^0-9A-Z]/g, "");
const hash = (c) => createHash("sha256").update(normalize(c), "utf8").digest("hex");
const sqlText = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

// без повторов внутри выпуска (повтор почти невероятен, но в базе он упал бы на первичном ключе)
const codes = [];
while (codes.length < count) {
  const c = code();
  if (normalize(c).length === 12 && !codes.includes(c)) codes.push(c);
}
console.log("# Коды (раздать лично; не сохранять в репозиторий и не вставлять в SQL):");
for (const c of codes) console.log(c);
console.log("\n-- SQL для Supabase SQL Editor (только хэши):");
for (const c of codes)
  console.log(`select private.admin_add_beta_invite('${hash(c)}', ${quota}, ${sqlText(label)}${expires ? `, ${sqlText(expires)}::timestamptz` : ""});`);
