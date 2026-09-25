// QA движения: реальные touch-события (CDP), листы A–G, переходы, быстрые нажатия, прокрутка, reduced motion.
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await chromium.launch(process.env.PW_EXEC ? { executablePath: process.env.PW_EXEC } : {});
  const res = {};
  const mk = async (reduced) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
    await p.goto(URL); await p.evaluate(() => { localStorage.clear(); localStorage.setItem('k-first', '1'); }); await p.reload(); await p.waitForTimeout(900);
    const cdp = await ctx.newCDPSession(p);
    return { ctx, p, cdp, errs };
  };
  const touch = async (cdp, type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // палец: от (x,y) на dy за steps шагов, с паузой между шагами (скорость)
  const swipe = async (p, cdp, x, y, dy, steps, stepMs, dx = 0) => {
    await touch(cdp, 'touchStart', x, y);
    for (let i = 1; i <= steps; i++) { await touch(cdp, 'touchMove', x + (dx * i) / steps, y + (dy * i) / steps); await p.waitForTimeout(stepMs); }
    await touch(cdp, 'touchEnd', 0, 0);
  };
  const state = (p) => p.evaluate(() => ({ overlays: document.querySelectorAll('#app > .overlay').length, closing: document.querySelectorAll('#app > .overlay.closing').length, ghosts: document.querySelectorAll('.screen-ghost').length,
    sheetT: (() => { const s = document.querySelector('#app > .overlay:not(.closing) .sheet'); return s ? getComputedStyle(s).transform : null; })(), bodyOv: getComputedStyle(document.body).overflowY, screen: document.querySelector('#app > .app').className.match(/scr-[\w-]+/)[0], y: scrollY }));
  const openMenu = async (p) => { await p.tap('.note-card [data-note-menu]'); await p.waitForTimeout(450); };
  const sheetTop = (p) => p.evaluate(() => document.querySelector('#app > .overlay .sheet').getBoundingClientRect().top);

  let { ctx, p, cdp, errs } = await mk(false);
  // A: тап по затемнению
  await openMenu(p); let s0 = await state(p); await p.mouse.click(195, 120); await p.waitForTimeout(400); let s1 = await state(p);
  res['A backdrop tap closes'] = s0.overlays === 1 && s1.overlays === 0 && s1.bodyOv !== 'hidden';
  // B: короткий жест — возврат
  await openMenu(p); let top = await sheetTop(p);
  await swipe(p, cdp, 195, top + 40, 50, 5, 16); await p.waitForTimeout(450); s1 = await state(p);
  res['B small drag snaps back'] = s1.overlays === 1 && (s1.sheetT === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(s1.sheetT));
  // во время перетаскивания лист следует за пальцем, затемнение слабеет
  await touch(cdp, 'touchStart', 195, top + 40); for (let i = 1; i <= 6; i++) { await touch(cdp, 'touchMove', 195, top + 40 + i * 12); await p.waitForTimeout(20); }
  await p.waitForTimeout(40);
  const mid = await p.evaluate(() => { const s = document.querySelector('#app > .overlay .sheet'); return { t: s.style.transform, bg: s.closest('.overlay').style.backgroundColor }; });
  { const ty = +((mid.t.match(/translate3d\(0px, ([\d.]+)px/) || [])[1] || 0), al = +((mid.bg.match(/rgba\([^)]*, ([\d.]+)\)/) || [])[1] || 1);
    res['drag follows finger + scrim fades'] = ty > 30 && al < 0.32; }
  res['_drag sample'] = mid;
  await p.screenshot({ path: 'prod-check-results/sheet-mid-drag.png' });
  await touch(cdp, 'touchEnd', 0, 0); await p.waitForTimeout(450);
  // C: длинный медленный жест — закрытие
  await swipe(p, cdp, 195, top + 40, 200, 20, 25); await p.waitForTimeout(450); s1 = await state(p);
  res['C long drag closes'] = s1.overlays === 0;
  // D: быстрый короткий взмах — закрытие по скорости
  await openMenu(p); top = await sheetTop(p);
  await swipe(p, cdp, 195, top + 40, 90, 3, 8); await p.waitForTimeout(450); s1 = await state(p);
  res['D fast flick closes'] = s1.overlays === 0;
  // E: жест вверх — лист остаётся
  await openMenu(p); top = await sheetTop(p);
  await swipe(p, cdp, 195, top + 60, -120, 8, 16); await p.waitForTimeout(450); s1 = await state(p);
  res['E upward drag stays'] = s1.overlays === 1 && s1.closing === 0;
  // горизонтальный жест не закрывает
  await swipe(p, cdp, 195, top + 60, 20, 8, 16, 160); await p.waitForTimeout(400); s1 = await state(p);
  res['horizontal gesture ignored'] = s1.overlays === 1;
  // F: тап по действию работает
  await p.tap('[data-open-note]'); await p.waitForTimeout(500); s1 = await state(p);
  res['F tap action works'] = s1.screen === 'scr-note' && s1.overlays === 0;
  await p.tap('[data-back]'); await p.waitForTimeout(450);
  // G: 10 раз открыть/закрыть
  for (let i = 0; i < 10; i++) { await openMenu(p); if (i % 2) await p.mouse.click(195, 120); else { const t = await sheetTop(p); await swipe(p, cdp, 195, t + 40, 220, 8, 10); } await p.waitForTimeout(420); }
  s1 = await state(p); res['G 10x open/close clean'] = s1.overlays === 0 && s1.ghosts === 0 && s1.bodyOv !== 'hidden';
  // переименование: лист → окно, одно затемнение
  await openMenu(p); await p.tap('[data-rename="note"]'); await p.waitForTimeout(60);
  const mid2 = await p.evaluate(() => [...document.querySelectorAll('#app > .overlay')].map(o => o.className + ' bg=' + getComputedStyle(o).backgroundColor));
  await p.waitForTimeout(400);
  res['rename: single scrim during swap'] = mid2.filter(x => !/bg=rgba\(0, 0, 0, 0\)|transparent|rgba\(16, 24, 52, 0\)/.test(x) && !x.includes('closing')).length === 1;
  res['_rename overlays mid'] = mid2;
  await p.tap('[data-close]'); await p.waitForTimeout(400);

  // переходы: направление вперёд / назад
  const transform = async (sel, action) => {
    await p.evaluate(() => { window.__tr = []; let n = 0; const t = () => { const a = document.querySelector('#app > .app'), g = document.querySelector('.screen-ghost > .app'); window.__tr.push({ a: a && getComputedStyle(a).transform, g: g && getComputedStyle(g).transform }); if (++n < 8) requestAnimationFrame(t); }; requestAnimationFrame(t); });
    await action(); await p.waitForTimeout(420);
    return p.evaluate(() => window.__tr);
  };
  const tx = (m) => (m && m !== 'none' ? +m.split(',')[4] : 0);
  let tr = await transform('', () => p.tap('[data-go=all-notes]'));
  const fwd = tr.find(f => f.g); res['forward: new from right, old to left'] = !!fwd && tx(fwd.a) > 0 && tx(fwd.g) <= 0; res['_fwd'] = fwd;
  tr = await transform('', () => p.tap('[data-back]'));
  const bck = tr.find(f => f.g); res['back: new from left, old to right'] = !!bck && tx(bck.a) < 0 && tx(bck.g) >= 0; res['_back'] = bck;
  await p.waitForTimeout(300);
  res['no ghost left after transitions'] = (await state(p)).ghosts === 0;

  // быстрые нажатия
  for (const sel of ['.hero [data-go=camera]', '[data-back]', '[data-go=all-notes]', '[data-back]', '.bookmarks [data-bookmark="bm-history"]', '[data-back]', '.bookmarks [data-go=new-bookmark]', '[data-back]']) { await p.tap(sel).catch(() => {}); await p.waitForTimeout(230); }
  await p.waitForTimeout(400); s1 = await state(p);
  res['rapid navigation ends clean on home'] = s1.screen === 'scr-home' && s1.ghosts === 0 && s1.overlays === 0;
  // двойной тап по карточке: один экран, «назад» ведёт на главную
  await p.evaluate(() => { const c = document.querySelector('.note-card'); c.click(); c.click(); }); await p.waitForTimeout(400);
  await p.tap('[data-back]'); await p.waitForTimeout(400); s1 = await state(p);
  res['double tap card → single history entry'] = s1.screen === 'scr-home';
  // прокрутка: главная → конспект → назад
  await p.evaluate(() => scrollTo(0, 260)); await p.waitForTimeout(100); const y0 = await p.evaluate(() => scrollY);
  await p.tap('.note-list .note-card:nth-child(2)'); await p.waitForTimeout(450); await p.tap('[data-back]'); await p.waitForTimeout(450);
  res['home scroll restored'] = Math.abs((await p.evaluate(() => scrollY)) - y0) < 3; res['_scroll'] = [y0, await p.evaluate(() => scrollY)];
  // камера: страница появляется и исчезает
  await p.evaluate(() => scrollTo(0, 0)); await p.tap('.hero [data-go=camera]'); await p.waitForTimeout(400);
  await p.setInputFiles('#cameraInput', ['03-camera.png']); await p.waitForSelector('.page-thumb');
  res['new page thumb animates in'] = await p.evaluate(() => document.querySelector('.page-thumb').classList.contains('enter') && document.querySelector('.page-thumb').getAnimations().length > 0);
  await p.waitForTimeout(400);
  res['_camera page count'] = await p.textContent('.pages-count');
  res['JS errors'] = errs.length === 0 ? true : errs;
  await ctx.close();

  // уменьшенное движение: переходы без смещения, лист закрывается сразу
  ({ ctx, p, cdp, errs } = await mk(true));
  await p.evaluate(() => { window.__tr = []; let n = 0; const t = () => { const a = document.querySelector('#app > .app'); window.__tr.push(getComputedStyle(a).transform); if (++n < 6) requestAnimationFrame(t); }; requestAnimationFrame(t); });
  await p.tap('[data-go=all-notes]'); await p.waitForTimeout(300);
  const rtr = await p.evaluate(() => window.__tr);
  await p.tap('[data-back]'); await p.waitForTimeout(200); await openMenu(p); await p.mouse.click(195, 120); await p.waitForTimeout(60);
  res['reduced motion: no slide, instant close'] = rtr.every(t => t === 'none') && (await state(p)).overlays === 0 && (await p.evaluate(() => document.querySelectorAll('.screen-ghost').length)) === 0;
  await ctx.close();
  await b.close();
  for (const [k, v] of Object.entries(res)) console.log((k.startsWith('_') ? '   ' : v === true ? 'PASS ' : 'FAIL ') + k + (v === true ? '' : ' → ' + JSON.stringify(v)));
})();
