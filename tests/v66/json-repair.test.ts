// v66.4: разбор и ремонт JSON ответа модели (study-content.ts) — без сети и без ИИ.
// Ремонт строго ограничен: лишние запятые вне строк, сырые переводы строки/табуляция внутри строк; текст не меняется.
// Запуск: deno run --allow-read tests/v66/json-repair.test.ts
import { jsonDiag, jsonErrorContext, jsonRetryHint, parseModelJson, repairJsonSyntax, validateStudyContent } from "../../supabase/functions/analyze-pages/study-content.ts";
import { retryPrompt } from "../../supabase/functions/analyze-pages/prompt.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || info === undefined ? "" : " → " + JSON.stringify(info).slice(0, 400)));
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------- корректный JSON не трогается ----------
{
  const good = { meta: { title: "§ 5. Тема", pages: [{ index: 0, readable: "ok" }] }, sections: [{ heading: "1. Пункт, с запятой", blocks: [{ type: "PARAGRAPH", text: "Текст, «цитата», запятые,, внутри строки, [скобки,] {и,} \\\"кавычка\\\"" }] }], remember: [] };
  const text = JSON.stringify(good);
  const r = parseModelJson(text);
  check("корректный JSON: разобран строго (без ремонта и диагностики), значение то же", r.repaired === false && r.diag === null && eq(r.value, good), r);
  check("корректный JSON: repairJsonSyntax не меняет ни одного символа", repairJsonSyntax(text) === text);
  const fenced = parseModelJson("Вот ответ:\n```json\n" + text + "\n```");
  check("корректный JSON в ```json и с текстом вокруг — тот же объект, без ремонта", fenced.repaired === false && eq(fenced.value, good));
}

// ---------- лишние запятые вне строк — исправляются, значения те же ----------
const fixable: [string, string, unknown, string][] = [
  ["две запятые подряд в объекте (как в v30: «Expected double-quoted property name»)", '{"a":"x",,"b":"y"}', { a: "x", b: "y" }, "double_comma"],
  ["две запятые подряд через пробелы и перевод строки", '{"a":1, \n ,"b":2}', { a: 1, b: 2 }, "double_comma"],
  ["три запятые подряд", '{"a":1,,,"b":2}', { a: 1, b: 2 }, "double_comma"],
  ["две запятые подряд в массиве", '{"a":["x",,"y"]}', { a: ["x", "y"] }, "double_comma"],
  ["запятая сразу после {", '{,"a":1}', { a: 1 }, "leading_comma"],
  ["запятая сразу после [", '{"a":[,"x","y"]}', { a: ["x", "y"] }, "leading_comma"],
  ["висячая запятая перед }", '{"a":1,"b":2,}', { a: 1, b: 2 }, "trailing_comma"],
  ["висячая запятая перед ]", '{"a":["x","y",]}', { a: ["x", "y"] }, "trailing_comma"],
  ["две висячие запятые перед ]", '{"a":["x",,]}', { a: ["x"] }, ""],
  ["вложенные объекты и массивы: лишние запятые на разных уровнях",
    '{"sections":[{"heading":"1. А","blocks":[{"type":"LIST","items":["a",,"b"]},,{"type":"PARAGRAPH","text":"т"}]},{"heading":"2. Б","blocks":[,{"type":"PARAGRAPH","text":"у"}]}],"glossary":{"terms":[{"term":"Т","definition":"о",},]}}',
    { sections: [{ heading: "1. А", blocks: [{ type: "LIST", items: ["a", "b"] }, { type: "PARAGRAPH", text: "т" }] }, { heading: "2. Б", blocks: [{ type: "PARAGRAPH", text: "у" }] }], glossary: { terms: [{ term: "Т", definition: "о" }] } }, ""],
];
for (const [name, text, want, kind] of fixable) {
  const r = parseModelJson(text);
  check("исправлено: " + name + " — значение то же, порядок тот же" + (kind ? ", тип ошибки " + kind : ""),
    r.repaired === true && eq(r.value, want) && (!kind || r.diag?.kind === kind), { r, want });
}

// ---------- запятые, кавычки и экранирование ВНУТРИ строк не трогаются ----------
{
  const inner = '{"a":"x,,y","b":"[,1] {,} ,]","c":"он сказал \\"да,, нет\\" и ушёл","d":"обратный слэш \\\\, затем запятая",,"e":"конец"}';
  const r = parseModelJson(inner);
  check("строки с запятыми, скобками, экранированными кавычками и обратным слэшем — содержимое строк без изменений, лишняя запятая между полями убрана",
    r.repaired === true && eq(r.value, { a: "x,,y", b: "[,1] {,} ,]", c: 'он сказал "да,, нет" и ушёл', d: "обратный слэш \\, затем запятая", e: "конец" }), r);
  const raw = '{"a":"строка 1\nстрока 2\tтаб",,"b":"x"}';
  const r2 = parseModelJson(raw);
  check("сырой перевод строки и табуляция в строке + лишняя запятая: текст тот же (\\n, \\t), запятая убрана", r2.repaired === true && eq(r2.value, { a: "строка 1\nстрока 2\tтаб", b: "x" }), r2);
}

// ---------- повреждения, которые нельзя безопасно исправить, — не исправляются ----------
const unfixable: [string, string, string][] = [
  ["поле без значения («a»: ,)", '{"a":,"b":1}', "missing_value"],
  ["неэкранированная кавычка внутри текста", '{"a":"он сказал "да" и ушёл"}', "missing_comma_or_unescaped_quote"],
  ["пропущена запятая между полями", '{"a":"x" "b":"y"}', "missing_comma_or_unescaped_quote"],
  ["незакрытая строка (обрыв ответа)", '{"a":"текст без конца', "no_object"],
  ["незакрытый массив", '{"a":["x","y"}', ""],
  ["лишняя запятая И поле без значения в одном ответе", '{"a":1,,"b":,"c":2}', ""],
];
for (const [name, text, kind] of unfixable) {
  const r = parseModelJson(text);
  check("не исправляется: " + name + " — value = null (ошибка остаётся, догадок нет)" + (kind ? ", тип " + kind : ""),
    r.value === null && r.repaired === false && (!kind || r.diag?.kind === kind), r);
}

// ---------- диагностика и подсказки ----------
{
  check("тип ошибки: две запятые / после { или [ / поле без значения / висячая запятая",
    jsonDiag('{"a":1,,"b":2}')?.kind === "double_comma" && jsonDiag('{"a":[,1]}')?.kind === "leading_comma" &&
      jsonDiag('{"a":,"b":1}')?.kind === "missing_value" && jsonDiag('{"a":1,}')?.kind === "trailing_comma" && jsonDiag('{"a":1}') === null);
  const hints = ["double_comma", "leading_comma", "missing_value"].map((kind) => jsonRetryHint({ kind, pos: 1, len: 2, at: "PUNCT:," }));
  check("подсказки модели для новых типов — конкретные, без текста ответа",
    /две запятые подряд/.test(hints[0]) && /после \{ или \[/.test(hints[1]) && /нет значения/.test(hints[2]), hints);
  const pad = "Учебный текст страницы. ".repeat(10);
  const src = '{"a":"' + pad + '","b":,"c":1}';
  const d = jsonDiag(src)!;
  const ctx = jsonErrorContext(src, d);
  check("фрагмент вокруг ошибки: ±60 знаков, место отмечено ⟪!⟫, начало обрезано «…»",
    ctx.includes('"b":⟪!⟫,"c":1}') && ctx.startsWith("…") && ctx.length <= 60 + 60 + 6, ctx);
  check("фрагмента нет, если нет позиции", jsonErrorContext(src, null) === "" && jsonErrorContext("", d) === "");
  const p1 = retryPrompt(["ответ не является корректным JSON по схеме: x"]);
  const p2 = retryPrompt(["ответ не является корректным JSON по схеме: x"], ctx);
  check("повторный запрос без фрагмента — прежний текст (как v65/v66.3): без «Место ошибки» и «Не копируй»",
    !p1.includes("Место ошибки") && !p1.includes("Не копируй") && p1.includes("- ответ не является корректным JSON по схеме: x\n\nСоставь конспект заново"));
  check("повторный запрос с фрагментом: место ошибки, «Не копируй прошлый ответ», правила запятых и кавычек; остальной текст на месте",
    p2.includes("«" + ctx + "»") && p2.includes("Не копируй прошлый ответ: сформируй JSON заново") && p2.includes("не две подряд и не после { или [") &&
      p2.includes("Составь конспект заново") && p2.endsWith(p1.slice(p1.indexOf("Составь конспект заново"))));
}

// ---------- ремонт не удаляет разделы, не меняет текст и не теряет страницы ----------
{
  const content = {
    meta: { title: "§ 5. Тема", subject: "physics", pages: [0, 1, 2].map((i) => ({ index: i, readable: "ok" })), sourceOutline: ["1. Первый", "2. Второй", "3. Третий"] },
    lead: "Главное.",
    sections: ["1. Первый", "2. Второй", "3. Третий"].map((h, i) => ({ heading: h, blocks: [{ type: "PARAGRAPH", text: "**Страница " + (i + 1) + "**: текст, с запятыми, и «кавычками».", sourcePage: i }] })),
    glossary: { terms: [{ term: "Термин", definition: "Определение, с запятой." }], dates: [], people: [], formulas: [] },
    remember: ["Факт"], conclusion: "Итог.", selfCheck: [{ q: "Вопрос?", a: "Ответ." }], warnings: [],
  };
  const good = JSON.stringify(content);
  // те же данные, но модель поставила лишние запятые между разделами, блоками и в массиве страниц
  const broken = good.replace('},{"heading":"2.', '},,{"heading":"2.').replace('"pages":[{', '"pages":[,{').replace('"remember":["Факт"]', '"remember":["Факт",]');
  const r = parseModelJson(broken);
  check("ремонт реального конспекта: тот же объект, что и без лишних запятых", r.repaired === true && eq(r.value, content), { broken: broken.slice(0, 200) });
  const v = validateStudyContent(r.value, 3);
  check("после ремонта: 3 раздела в том же порядке, текст каждого раздела без изменений, 3 страницы (0, 1, 2)",
    v.ok && v.content.sections.map((s) => s.heading).join("|") === "1. Первый|2. Второй|3. Третий" &&
      v.content.sections.every((s, i) => s.blocks[0].text === content.sections[i].blocks[0].text) &&
      eq(v.content.meta.pages.map((p) => p.index), [0, 1, 2]), v);
}

console.log(`ИТОГО: ${pass} PASS, ${fail} FAIL (разбор JSON; сеть и ИИ не вызывались)`);
Deno.exit(fail ? 1 : 0);
