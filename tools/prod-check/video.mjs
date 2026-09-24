// Видео перехода Home → + → back → + в WebKit (как Safari на iPhone), для раскадровки.
import pw from "playwright";
const [,, URL, OUT] = process.argv;
const browser = await pw.webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, recordVideo: { dir: OUT, size: { width: 390, height: 844 } } });
const p = await ctx.newPage();
await p.goto(URL); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(1500);
for (let i = 0; i < 2; i++) {
  await p.tap(".bookmarks [data-go=new-bookmark]"); await p.waitForTimeout(700);
  await p.tap("[data-back]"); await p.waitForTimeout(700);
}
await p.tap(".hero [data-go=camera]"); await p.waitForTimeout(700); await p.tap("[data-back]"); await p.waitForTimeout(700);
await p.tap("[data-go=all-notes]"); await p.waitForTimeout(700); await p.tap("[data-back]"); await p.waitForTimeout(900);
await ctx.close(); await browser.close();
