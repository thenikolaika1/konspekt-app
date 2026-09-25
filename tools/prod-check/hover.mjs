// Наведение: на компьютере (мышь) есть, на телефоне (касание) нет. Плюс кадр перехода на камеру.
import pw from "playwright";
import fs from "fs";
const U = process.argv[2];
fs.mkdirSync("prod-check-results", { recursive: true });
const b = await pw.chromium.launch();
const probe = async (mobile) => {
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(U); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(900);
  const before = await p.evaluate(() => getComputedStyle(document.querySelector(".hero .primary")).filter);
  await p.hover(".hero .primary"); await p.waitForTimeout(300);
  const after = await p.evaluate(() => getComputedStyle(document.querySelector(".hero .primary")).filter);
  if (!mobile) await p.screenshot({ path: "prod-check-results/hover-desktop.png", clip: { x: 385, y: 250, width: 430, height: 260 } });
  await ctx.close();
  return before !== after;
};
console.log((await probe(false)) ? "PASS hover on desktop (mouse)" : "FAIL hover on desktop (mouse)");
console.log(!(await probe(true)) ? "PASS no sticky hover on phone (touch)" : "FAIL hover on phone");
await b.close();
