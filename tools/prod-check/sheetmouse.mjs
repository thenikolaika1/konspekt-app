// Лист в WebKit (движок Safari): перетаскивание мышью (Pointer Events) — возврат, закрытие, тап по затемнению.
import pw from "playwright";
const URL = process.argv[2];
const b = await pw.webkit.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto(URL); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(1000);
const open = async () => { await p.click(".note-card [data-note-menu]"); await p.waitForTimeout(450); return p.evaluate(() => document.querySelector("#app > .overlay .sheet").getBoundingClientRect().top); };
const n = () => p.evaluate(() => document.querySelectorAll("#app > .overlay").length);
const drag = async (y0, dy, steps, ms) => { await p.mouse.move(195, y0); await p.mouse.down(); for (let i = 1; i <= steps; i++) { await p.mouse.move(195, y0 + (dy * i) / steps); await p.waitForTimeout(ms); } await p.mouse.up(); await p.waitForTimeout(450); };
const r = {};
let t = await open(); await drag(t + 40, 50, 5, 16); r["webkit small drag → snap back"] = (await n()) === 1;
await drag(t + 40, 220, 20, 20); r["webkit long drag → close"] = (await n()) === 0;
t = await open(); await drag(t + 40, 60, 3, 6); r["webkit fast flick → close"] = (await n()) === 0;
t = await open(); await p.mouse.click(195, 120); await p.waitForTimeout(450); r["webkit backdrop tap → close"] = (await n()) === 0;
r["webkit body scroll restored"] = (await p.evaluate(() => getComputedStyle(document.body).overflowY)) !== "hidden";
r["webkit JS errors"] = errs.length === 0 || errs;
for (const [k, v] of Object.entries(r)) console.log((v === true ? "PASS " : "FAIL ") + k + (v === true ? "" : " → " + JSON.stringify(v)));
await b.close();
