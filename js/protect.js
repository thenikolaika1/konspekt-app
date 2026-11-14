/*
 * Защита текста конспектов от простого копирования (v66).
 *
 * Что делает — только внутри области конспекта (.cn-doc.kn-protected), у всех, кроме владельца:
 *  - обычное выделение выключено (CSS user-select / -webkit-touch-callout — в styles.css);
 *  - copy / cut / contextmenu / selectstart / dragstart в этой области отменяются;
 *  - Ctrl/Cmd+C, Ctrl+Insert, Ctrl/Cmd+X, Ctrl/Cmd+A, Ctrl/Cmd+S, Ctrl/Cmd+P на экране конспекта не срабатывают,
 *    если фокус не в поле ввода (поиск по конспекту, переименование и любые поля работают как обычно);
 *  - если выделение всё же захватило текст конспекта (например, «выделить всё» на другом экране браузера), в буфер
 *    обмена вместо текста кладётся пустая строка;
 *  - печать экрана конспекта выдаёт пустой лист (CSS @media print);
 *  - внизу видимой части конспекта — небольшой полупрозрачный код ученика (псевдоним, не email и не ID входа).
 *
 * Чего это НЕ делает и сделать не может: запретить скриншот, съёмку экрана телефоном, распознавание текста
 * со скриншота, чтение уже загруженной страницы через инструменты разработчика. Защита усложняет простое
 * копирование, а водяной знак показывает, с какого аккаунта сделан снимок экрана.
 * Экранные дикторы (VoiceOver, TalkBack, NVDA) текст по-прежнему читают: user-select не скрывает его
 * от вспомогательных технологий.
 *
 * Код водяного знака: «KN-» + первые 8 знаков SHA-256("konspekt-wm:" + id пользователя Supabase), заглавными.
 * По коду нельзя узнать id, но владелец может найти аккаунт на сервере:
 *   select id from auth.users where upper(left(encode(sha256(convert_to('konspekt-wm:' || id::text, 'UTF8')), 'hex'), 8)) = 'XXXXXXXX';
 * Гость без входа по ID — анонимный аккаунт этого устройства: код указывает на аккаунт, а не на человека.
 */
(() => {
  const K = (window.K = window.K || {});
  const AREA = ".kn-protected";

  // ---------- SHA-256 (синхронно; crypto.subtle асинхронный и есть не везде) ----------
  function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const K32 = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    const bits = len * 8;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(total - 4, bits >>> 0);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K32[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map((x) => x.toString(16).padStart(8, "0")).join("");
  }

  /** короткий код водяного знака для пользователя (без id — пустая строка) */
  const codeCache = new Map();
  function code(uid) {
    if (!uid) return "";
    if (!codeCache.has(uid)) codeCache.set(uid, "KN-" + sha256Hex("konspekt-wm:" + uid).slice(0, 8).toUpperCase());
    return codeCache.get(uid);
  }

  // ---------- водяной знак: один небольшой код внизу видимой части конспекта ----------
  // Ставится последним элементом .cn-doc; CSS (position: sticky; bottom) держит его у нижнего края экрана, пока
  // конспект на экране. Нулевая высота — места в разметке не занимает; pointer-events: none — нажатия проходят насквозь.
  /** разметка водяного знака для вставки в конец .cn-doc (экранным дикторам не виден) */
  function watermark(uid) {
    const c = code(uid);
    if (!c) return "";
    return '<div class="kn-wm" aria-hidden="true" data-wm="' + c + '"><span>' + c + "</span></div>";
  }

  // ---------- перехват копирования ----------
  const inArea = (node) => !!(node && (node.nodeType === 1 ? node : node.parentElement)?.closest?.(AREA));
  const editable = (el) => !!(el && el.closest && el.closest("input,textarea,select,[contenteditable=''],[contenteditable=true]"));
  const protectedScreen = () => !!document.querySelector(AREA);
  // выделение задевает защищённую область?
  function selectionTouchesArea() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    for (const area of document.querySelectorAll(AREA)) {
      for (let i = 0; i < sel.rangeCount; i++) if (sel.getRangeAt(i).intersectsNode(area)) return true;
    }
    return false;
  }
  let blocked = 0; // для тестов: сколько попыток отменено
  const stop = (e) => {
    blocked++;
    e.preventDefault();
  };

  function onCopy(e) {
    if (editable(e.target) && !selectionTouchesArea()) return; // копирование из полей ввода — как обычно
    if (!inArea(e.target) && !selectionTouchesArea()) return;
    if (e.clipboardData) e.clipboardData.setData("text/plain", "");
    stop(e);
  }
  function onContext(e) {
    if (inArea(e.target) && !editable(e.target)) stop(e);
  }
  function onSelectStart(e) {
    if (inArea(e.target) && !editable(e.target)) stop(e);
  }
  function onDragStart(e) {
    if (inArea(e.target)) stop(e);
  }
  function onKey(e) {
    if (!protectedScreen() || editable(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || "").toLowerCase();
    const code = e.code || "";
    const hit =
      (mod && (k === "c" || code === "KeyC" || k === "x" || code === "KeyX" || k === "a" || code === "KeyA" || k === "s" || code === "KeyS" || k === "p" || code === "KeyP")) ||
      (e.ctrlKey && (k === "insert" || code === "Insert"));
    if (hit) stop(e);
  }

  let on = false;
  function install() {
    if (on) return;
    on = true;
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCopy, true);
    document.addEventListener("contextmenu", onContext, true);
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("keydown", onKey, true);
  }

  K.protect = { install, code, watermark, sha256Hex, blocked: () => blocked };
  install();
})();
