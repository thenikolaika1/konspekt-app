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
      const anims = document.getAnimations().map((a) => (a.transitionProperty || a.animationName || "anim") + "@" + (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? "?").toString().slice(0, 40));
      const imgs = [...document.querySelectorAll("img")].filter((i) => !(i.complete && i.naturalWidth)).map((i) => i.getAttribute("src"));
      const icons = [...document.querySelectorAll(".ui-icon,.kt-glyph,.kt,.thumb")].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); }).join(",");
      window.__frames.push({ n, screen: document.querySelector(".app")?.className.split(" ").find((c) => c.startsWith("scr-")), anims, imgs, icons });
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
  const bad = fr.slice(first).filter((f) => f.anims.length || f.imgs.length);
  const iconSizes = new Set(fr.slice(first).map((f) => f.icons));
  console.log(`[${ENGINE}] ${label} → ${scr}: frames with animations/unloaded images: ${bad.length}` +
    (bad.length ? " " + JSON.stringify(bad.slice(0, 3).map((f) => ({ n: f.n - first, anims: f.anims.slice(0, 4), imgs: f.imgs }))) : "") +
    ` | icon size sets: ${iconSizes.size}`);
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
await step("Home → note menu", () => p.tap(".note-card [data-note-menu]"));
console.log(`[${ENGINE}] JS errors:`, errors);
await browser.close();
