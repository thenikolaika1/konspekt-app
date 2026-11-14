// Сверка с кодом приложения (main): показанный ключ проходит normalizeKey, а пароль = idLogin(...).password.
const fs = require("fs");
const src = fs.readFileSync("main/js/cloud.js", "utf8");
const a = src.indexOf("const ID_ALPHABET"), b = src.indexOf("const idFromEmail");
const part = src.slice(a, b).split("\n").filter((l) => !/AUTH_KEY|ACCOUNT/.test(l)).join("\n");
const K = new Function(part + "; return { ID_ALPHABET, KEY_LEN, normalizeKey, normalizeId, idLogin };")();
const rekey = fs.readFileSync(".github/rekey-test/rekey.ps1", "utf8");
const alpha = /\$a = '([A-Z0-9]+)'/.exec(rekey)[1];
let fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fail++; };
ok("алфавит скрипта = алфавит приложения (" + K.ID_ALPHABET.length + " символ)", alpha === K.ID_ALPHABET);
ok("длина ключа 20 = KEY_LEN приложения", K.KEY_LEN === 20);
ok("email скрипта = email приложения для KN-EK83FF", rekey.includes("'" + K.idLogin("KN-EK83FF", "X").email + "'"));
const rows = JSON.parse(fs.readFileSync("shown.json", "utf8").replace(/^﻿/, ""));
for (const r of [].concat(rows)) {
  const key = K.normalizeKey(r.shown);
  ok("ключ " + r.shown.replace(/[A-Z2-9]/g, "*") + " принимается формой входа приложения", !!key);
  ok("  пароль, заданный скриптом = пароль, который отправит приложение", key && K.idLogin("KN-EK83FF", key).password === r.put);
  ok("  проверка входа скрипта = запрос приложения", key && r.login.password === r.put && r.login.email === K.idLogin("KN-EK83FF", key).email);
  ok("  ключ строчными и без дефисов тоже принимается", K.normalizeKey(r.shown.toLowerCase().replace(/-/g, "")) === key);
}
process.exit(fail ? 1 : 0);
