#!/usr/bin/env node
// Выпуск одноразовых кодов раннего доступа (Friends & Family).
//
// Запуск локально (не в CI и не на сервере):
//   node tools/ff-invite-codes.mjs --count 5 --quota 5 --label "F&F октябрь"
//
// Печатает:
//   1) открытые коды — раздать людям лично (никуда не коммитить, не вставлять в SQL);
//   2) SQL только с sha256 кодов — выполнить в Supabase SQL Editor.
// Нормализация совпадает с private.invite_code_hash(): регистр, пробелы и дефисы не важны.
// quota задаётся при выпуске и сохраняется у каждого кода; числа по умолчанию нет.

import { createHash, randomInt } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const count = Number(args.count);
const quota = Number(args.quota);
const label = args.label ?? null;
if (!Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(quota) || quota < 1) {
  console.error('Usage: node tools/ff-invite-codes.mjs --count <1..200> --quota <N> [--label "..."]');
  process.exit(1);
}

// 29 символов без похожих (0/O, 1/I/L, U/V): 12 символов ≈ 58 бит — перебор невозможен
const ALPHABET = "ABCDEFGHJKMNPQRSTWXYZ23456789";
const code = () => {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
};
const normalize = (c) => c.toUpperCase().replace(/[^0-9A-Z]/g, "");
const hash = (c) => createHash("sha256").update(normalize(c), "utf8").digest("hex");
const sqlText = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

const codes = Array.from({ length: count }, code);
console.log("# Коды (раздать лично; не сохранять в репозиторий и не вставлять в SQL):");
for (const c of codes) console.log(c);
console.log("\n-- SQL для Supabase SQL Editor (только хэши):");
for (const c of codes) console.log(`select private.admin_add_beta_invite('${hash(c)}', ${quota}, ${sqlText(label)});`);
