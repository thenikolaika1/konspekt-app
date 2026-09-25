// Покадровая проверка мигания: для каждого перехода пишет, что в каждом кадре нового экрана
// анимируется (CSS transitions), какие картинки ещё не загружены и менялись ли размеры иконок.
// node flicker.mjs <url> <engine: chromium|webkit>
import pw from "playwright";
const [,, URL, ENGINE = "chromium"] = process.argv;
const browser = await pw[ENGINE].launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: ENGINE !== "firefox", hasTouch: true });
const p = await ctx.newPage();
const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(URL); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("k-first", "1"); }); await p.reload(); await p.waitForTimeout(1200);
await p.evaluate(() => {
  window.__frames = [];
  window.__rec = (label) => {
    window.__frames = []; let n = 0;
    const tick = () => {
      const scr = document.querySelector("#app > .app");
      // отпечаток иконок нового экрана: если он меняется после первого кадра — это подмена иконки
      const icons = scr ? [...scr.querySelectorAll(".ui-icon,.kt-glyph,.thumb")].map((e) => e.outerHTML.length + ":" + (e.getAttribute("class") || "")).join("|") : "";
      const imgs = scr ? [...scr.querySelectorAll("img")].filter((i) => !(i.complete && i.naturalWidth)).map((i) => i.getAttribute("src")) : [];
      const anims = [];
      window.__frames.push({ n, screen: scr?.className.split(" ").find((c) => c.startsWith("scr-")), anims, imgs, icons });
      if (++n < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
});
async function step(label, action) {
  await p.evaluate(() => window.__rec());
  await action();
  await p.waitForTimeout(900);
  const fr = await p.evaluate(() => window.__frames);
  const scr = fr[fr.length - 1].screen; const first = fr.findIndex((f) => f.screen === scr);
  const final = fr[fr.length - 1].icons;
  const swaps = fr.slice(first).filter((f) => f.screen === scr && f.icons !== final).length;
  const unloaded = fr.slice(first).filter((f) => f.imgs.length).length;
  console.log(`[${ENGINE}] ${label} → ${scr}: icon swaps after first frame: ${swaps} | frames with unloaded covers: ${unloaded}`);
}
await step("Home → + (New Bookmark)", () => p.tap(".bookmarks [data-go=new-bookmark]"));
await step("New Bookmark → back", () => p.tap("[data-back]"));
await step("Home → + again", () => p.tap(".bookmarks [data-go=new-bookmark]"));
await step("pick icon", () => p.tap('[data-icon="leaf"]'));
await step("pick color", () => p.tap('[data-color="#e7f4e9"]'));
await step("back → Home", () => p.tap("[data-back]"));
await step("Home → Camera", () => p.tap(".hero [data-go=camera]"));
await step("Camera → back", () => p.tap("[data-back]"));
await step("Home → Camera again", () => p.tap(".hero [data-go=camera]"));
await step("Camera → back", () => p.tap("[data-back]"));
await step("Home → All Bookmarks", () => p.tap("[data-go=bookmarks]"));
await step("All Bookmarks → История", () => p.tap('[data-bookmark="bm-history"]'));
await step("История → back", () => p.tap("[data-back]"));
await step("All Bookmarks → back", () => p.tap("[data-back]"));
await step("Home → История", () => p.tap('.bookmarks [data-bookmark="bm-history"]'));
await step("История → back", () => p.tap("[data-back]"));
await step("Home → All Notes", () => p.tap("[data-go=all-notes]"));
await step("All Notes → back", () => p.tap("[data-back]"));
for (let i = 1; i <= 10; i++) {
  await step("loop " + i + ": Home → +", () => p.tap(".bookmarks [data-go=new-bookmark]"));
  await step("loop " + i + ": back", () => p.tap("[data-back]"));
}
await step("Home → note menu", () => p.tap(".note-card [data-note-menu]"));
console.log(`[${ENGINE}] JS errors:`, errors);
await browser.close();
