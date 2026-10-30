#!/usr/bin/env node
// Разбор журнала pg_restore так же, как в v62-local-pg17-check.ps1 (PowerShell в среде тестов нет): регулярные
// выражения берутся из самого скрипта (ps1-sql.mjs → logre, known, evt), здесь повторён только порядок их применения.
// .NET -match без учёта регистра → флаг i. Печатает JSON: { blocks, known: [триггеры], other, unknown, ignored }.
// Запуск: node ps1-restore-log.mjs <ps1.json> <журнал stderr pg_restore>
import { readFileSync } from "node:fs";

const j = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (j.logre.length !== 6) throw new Error("в цикле разбора скрипта ожидалось 6 образцов, найдено " + j.logre.length);
const [reStart, reCmd, reSrv, reLine, reCaret, reIgn] = j.logre.map((x) => new RegExp(x, "iu"));
const reKnown = new RegExp(j.known, "iu");
const blocks = [], unknown = [];
let ignored = 0, cur = null, inCmd = false;
for (const ln of readFileSync(process.argv[3], "utf8").split("\n")) {
  const x = ln.replace(/\r$/, "");
  let m;
  if (inCmd) { if (x === "") { inCmd = false; cur = null; } else cur.cmd += "\n" + x; continue; }
  if ((m = x.match(reStart))) { cur = { msg: m[3], cmd: "" }; blocks.push(cur); continue; }
  if (cur && (m = x.match(reCmd))) { cur.cmd = m[2]; inCmd = true; continue; }
  if (cur && (reSrv.test(x) || reLine.test(x))) { cur.msg += " | " + x.trim(); continue; }
  if (cur && reCaret.test(x)) continue;
  if ((m = x.match(reIgn))) { ignored = +m[2]; continue; }
  if (x === "") continue;
  unknown.push(x);
}
const known = [], other = [];
for (const b of blocks) {
  const m = b.cmd.match(reKnown);
  if (m && j.evt.includes(m[1])) known.push(m[1]); else other.push(b.cmd.split("\n")[0]);
}
console.log(JSON.stringify({ blocks: blocks.length, known, other, unknown, ignored }));
