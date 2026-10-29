#!/usr/bin/env node
// v62: перенос 77 параграфов — согласованность публичного каталога (js/library-index.js) и манифеста контрольных сумм
// (supabase/release/v62-library-manifest.tsv), и что закрытых текстов нет в публичных файлах. База не нужна.
// Запуск: node tests/v62/library-manifest.test.mjs (из tests/v62/run.sh)
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS " + name); } else { fail++; console.log(`FAIL ${name} → ${g} ожидалось ${w}`); }
};
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

// манифест
const rows = read("supabase/release/v62-library-manifest.tsv").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t"));
const key = (r) => r.slice(0, 3).join("/");
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
check("M1. манифест: 77 параграфов", rows.length, 77);
check("M1. по предметам: история 26, физика 51", ["history", "physics"].map((s) => rows.filter((r) => r[0] === s).length), [26, 51]);
check("M2. в каждой строке 4 поля, sha256 из 64 hex", rows.filter((r) => r.length !== 4 || !/^[0-9a-f]{64}$/.test(r[3])).length, 0);
check("M2. идентификаторы предмет/учебник/параграф допустимые (как в генераторе)", rows.filter((r) => !r.slice(0, 3).every((x) => ID.test(x))).length, 0);
check("M3. дублей параграфов нет", new Set(rows.map(key)).size, rows.length);
check("M3. одинаковых текстов (контрольных сумм) нет", new Set(rows.map((r) => r[3])).size, rows.length);

// публичный каталог — как его загружает приложение
let cat = null;
const ctx = vm.createContext({ console: { warn() {}, log() {} } });
ctx.window = ctx;
ctx.K = { library: { setCatalog: (c) => (cat = c) } };
vm.runInContext(read("js/library-index.js"), ctx);
const ready = [], all = [], extra = [];
for (const s of cat.subjects) for (const b of s.books || []) for (const p of b.paragraphs || []) {
  const k = s.id + "/" + b.id + "/" + p.id;
  all.push(k);
  if (p.ready) ready.push(k);
  if ("content" in p || "source" in p) extra.push(k);
}
const man = new Set(rows.map(key));
check("M4. «готовые» в каталоге = ровно параграфы манифеста (ни лишних, ни пропущенных)",
  [ready.filter((k) => !man.has(k)), [...man].filter((k) => !ready.includes(k))], [[], []]);
check("M4. каждый параграф манифеста есть в каталоге", [...man].filter((k) => !all.includes(k)).length, 0);
check("M4. в каталоге нет повторяющихся параграфов", new Set(all).size, all.length);
check("M5. в каталоге нет текстов и служебных пометок (content, source)", extra.length, 0);
check("M5. другие предметы (биология) не помечены готовыми", ready.filter((k) => !/^(history|physics)\//.test(k)).length, 0);
const idx = read("js/library-index.js");
check("M5. в js/library-index.js нет полей конспекта (sections, blocks, remember, lead)", /"(sections|blocks|remember|lead)"\s*:/.test(idx), false);

// публичные файлы: старого каталога с текстами нет, ссылок на него нет
check("M6. js/library-catalog.js в рабочем дереве нет", existsSync(path.join(ROOT, "js/library-catalog.js")), false);
const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
check("M6. закрытые файлы не в git (library-seed*.sql, *.source.js, *.dump)",
  tracked.filter((f) => /library-seed.*\.sql$|\.source\.js$|\.dump$/.test(f)), []);
const pub = ["index.html", "service-worker.js", "manifest.json", "app.js", ...tracked.filter((f) => /^js\/.*\.js$/.test(f))];
check("M6. приложение не ссылается на library-catalog.js (кроме пояснения в service worker)",
  pub.filter((f) => existsSync(path.join(ROOT, f)) && f !== "service-worker.js" && read(f).includes("library-catalog")), []);
check("M6. index.html подключает library-index.js, а не каталог с текстами",
  [/js\/library-index\.js\?v=\d+/.test(read("index.html")), /library-catalog/.test(read("index.html"))], [true, false]);
// .gitignore защищает закрытые файлы от случайного git add
const gi = read(".gitignore");
check("M7. .gitignore: library-seed*.sql, *.source.js, *.dump, konspekt-v62/", ["library-seed", ".source.js", ".dump", "konspekt-v62/"].filter((x) => !gi.includes(x)), []);


// генератор: исходник назначен манифестом (# source-sha256); --git читает его из git байт в байт; перекодированный
// оболочкой исходник (как PowerShell «git show … > файл» на русской Windows) отклоняется до записи файлов
const mf = read("supabase/release/v62-library-manifest.tsv");
const wantSrc = (mf.match(/^# source-sha256 ([0-9a-f]{64})\b/m) || [])[1];
check("G1. в манифесте назначен исходник (# source-sha256)", /^[0-9a-f]{64}$/.test(wantSrc || ""), true);
const hasOld = spawnSync("git", ["cat-file", "-e", "53d3203^{commit}"], { cwd: ROOT }).status === 0;
if (!hasOld) {
  console.log("SKIP G2–G5: в клоне нет коммита 53d3203");
} else {
  const src = execSync("git show 53d3203:js/library-catalog.js", { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  check("G2. исходник из git 53d3203 = назначенный манифестом", createHash("sha256").update(src).digest("hex"), wantSrc);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "konspekt-seed-"));   // вне репозитория; удаляется в конце
  try {
    const gen = (srcArgs, tag) => spawnSync("node", ["tools/library-split.mjs", ...srcArgs, "--index", path.join(tmp, tag + ".index.js"),
      "--seed", path.join(tmp, tag + ".seed.sql"), "--expect", "supabase/release/v62-library-manifest.tsv"], { cwd: ROOT, encoding: "utf8" });
    const r = gen(["--git", "53d3203:js/library-catalog.js"], "git");
    const head = existsSync(path.join(tmp, "git.seed.sql")) ? readFileSync(path.join(tmp, "git.seed.sql"), "utf8").split("\n").slice(1, 3) : [];
    check("G3. --git: файл собран, в шапке назначенный исходник и 77 (26/51)",
      [r.status, (head[0] || "").includes(wantSrc), /Параграфов: 77 \(history: 26, physics: 51\)/.test(head[1] || "")], [0, true, true]);
    check("G3. --git: публичный каталог байт в байт = js/library-index.js",
      existsSync(path.join(tmp, "git.index.js")) && readFileSync(path.join(tmp, "git.index.js"), "utf8") === read("js/library-index.js"), true);
    // кириллица, прочитанная в кодировке консоли (cp866) и записанная как UTF-8, — как PowerShell 7 «git show … > файл»
    const cp866 = " АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ ";
    const mangled = Buffer.from([...src].map((b) => (b < 0x80 ? String.fromCharCode(b) : cp866[b - 0x7f] || "?")).join(""), "utf8");
    writeFileSync(path.join(tmp, "mangled.js"), mangled);
    const m = gen([path.join(tmp, "mangled.js")], "bad");
    check("G4. перекодированный исходник: отказ (код 3) с подсказкой про --git, файлы не записаны",
      [m.status, /Исходник не тот/.test(m.stderr) && /--git/.test(m.stderr), existsSync(path.join(tmp, "bad.seed.sql")), existsSync(path.join(tmp, "bad.index.js"))],
      [3, true, false, false]);
    check("G5. генератор не тронул публичный каталог репозитория", spawnSync("git", ["diff", "--quiet", "--", "js/library-index.js"], { cwd: ROOT }).status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
