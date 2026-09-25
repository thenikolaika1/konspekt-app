// Production (WebKit = Safari): высокое фото 3:4 в большом просмотре камеры видно целиком.
import pw from "playwright";
import fs from "fs";
const PROD = "https://thenikolaika1.github.io/konspekt-app/";
const OUT = "prod-check-results"; fs.mkdirSync(OUT, { recursive: true });
const log = []; const say = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); log.push(s); };
const css = await (await fetch(PROD + "styles.css?v=28", { cache: "no-store" })).text();
say("styles.css?v=28 has fix:", css.includes("max-height:calc(100% - 94px)"), "| index v=28:", (await (await fetch(PROD + "index.html", { cache: "no-store" })).text()).includes("v=28"));
for (const engine of ["webkit", "chromium"]) {
  const b = await pw[engine].launch();
  for (const [W, H] of [[390, 844], [393, 852], [430, 932], [375, 667]]) {
    const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage();
    await p.goto(PROD); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(1000);
    await p.tap(".hero [data-go=camera]"); await p.setInputFiles("#cameraInput", ["tools/prod-check/tall.jpg"]); await p.waitForSelector(".shot-preview"); await p.waitForTimeout(700);
    const m = await p.evaluate(() => { const i = document.querySelector(".shot-preview").getBoundingClientRect(), s = document.querySelector(".camera-bottom").getBoundingClientRect(), h = document.querySelector(".hint").getBoundingClientRect();
      return { imgTop: Math.round(i.top), imgBottom: Math.round(i.bottom), hintBottom: Math.round(h.bottom), sheetTop: Math.round(s.top), ratio: +(i.width / i.height).toFixed(3) }; });
    say(engine, W + "x" + H, JSON.stringify(m), "FULLY VISIBLE:", m.imgBottom <= m.sheetTop && m.imgTop >= m.hintBottom, "aspect 3:4:", Math.abs(m.ratio - 0.75) < 0.01);
    if (W === 390) await p.screenshot({ path: `${OUT}/preview-${engine}-390.png` });
    await ctx.close();
  }
  await b.close();
}
fs.writeFileSync(`${OUT}/report.txt`, log.join("\n") + "\n");
