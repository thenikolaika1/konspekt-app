/*
 * Konspekt by NK — frontend.
 * Phase 0: полностью локальный flow на mock-данных
 * (камера → фото → processing → Classic Note → сохранение → Недавние).
 *
 * Данные: K.store (js/store.js). Конспект: StudyContent (js/study-content.js),
 * отрисовка — K.modes.classic (js/classic-renderer.js). Генерация — K.generator.
 */
(() => {
  const { esc, study, store, images, generator, modes } = window.K;
  const root = document.querySelector("#app"),
    cam = document.querySelector("#cameraInput"),
    gallery = document.querySelector("#galleryInput");

  const MAX_PAGES = 8;
  const STEPS = ["Изучаем страницы", "Выделяем главное", "Структурируем материал", "Создаём конспект"];
  const BM_ICONS = ["book", "leaf", "atom", "flask", "globe", "folder"];
  const BM_COLORS = ["#f7eadc", "#e7f4e9", "#e7f1fd", "#f0eafa", "#f9e8ed", "#edf0f3"];
  // как цвет выглядит в палитре выбора: насыщенный тон, который станет цветом иконки; сохраняется светлый оттенок из BM_COLORS
  const BM_SWATCHES = ["#cf9164", "#34a06e", "#2f84ea", "#7d64dc", "#cc5f78", "#6f7b9c"];
  const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c || "");

  const S = {
    first: localStorage.getItem("k-first") !== "1",
    screen: localStorage.getItem("k-first") !== "1" ? "welcome" : "home",
    history: [],
    sheet: null,
    noteId: null,
    bookmarkId: null,
    // камера: страницы живут только в памяти до создания конспекта
    pages: [],
    selectedPage: -1,
    pagesLoading: 0,
    pagesMessage: "",
    replacePage: null,
    // генерация
    gen: { run: 0, step: 0, timer: null },
    // форма закладки
    draftBookmark: { icon: "book", color: BM_COLORS[0] },
    editBookmarkId: null,
    bookmarkForNote: null,
  };

  const icon = (n) => {
    const p = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22V5.5Zm16 0A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22V5.5Z"/>',
      leaf: '<path d="M20 3C12 3 5 6 4 12c-1 5 3 8 7 6 5-2 7-8 9-15ZM4 21c3-6 7-9 13-12"/>',
      atom: '<ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
      camera: '<path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
      dots: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
      doc: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
      gallery: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/>',
      back: '<path d="M20 12H4M10 6l-6 6 6 6"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14M10 11v6M14 11v6"/>',
      edit: '<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z"/>',
      folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
      flask: '<path d="M9 2h6M10 2v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L14 8V2M7 16h10"/>',
      globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
      history: '<path d="M5 20V9l7-5 7 5v11M3 21h18M8 12h8M8 16h8"/>',
      physics: '<ellipse cx="12" cy="12" rx="9" ry="3.5"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)"/>',
      biology: '<path d="M19 4C11 4 5 8 5 14c0 4 3 6 6 5 5-1 7-7 8-15ZM5 21c3-6 7-9 12-11"/>',
      help: '<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.8 2.8 0 1 1 4.2 2.4c-1.2.7-1.7 1.2-1.7 2.6M12 18h.01"/>',
      info: '<circle cx="12" cy="12" r="10"/><path d="M12 10v7M12 7h.01"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      dotsv: '<circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>',
      chev: '<path d="m9 6 6 6-6 6"/>',
      palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.7 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3Z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10" cy="7.3" r="1.2" fill="currentColor"/><circle cx="14.5" cy="7.3" r="1.2" fill="currentColor"/>',
      sparkle: '<path d="M12 3c.6 4.2 2.4 6.3 7 7-4.6.7-6.4 2.8-7 7-.6-4.2-2.4-6.3-7-7 4.6-.7 6.4-2.8 7-7Z" fill="currentColor" stroke="none"/>',
      check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
      open: '<path d="M3 5.5c3-1.3 6-1.3 9 .8 3-2.1 6-2.1 9-.8V19c-3-1.3-6-1.3-9 .8-3-2.1-6-2.1-9-.8V5.5ZM12 6.3v13.5"/>',
    };
    if (!p[n]) console.warn("[icon] unknown icon:", n);
    return (
      '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (p[n] || p.doc) +
      "</svg>"
    );
  };

  const art = (type) => {
    if (type === "scan")
      return '<svg class="hero-illustration" viewBox="0 0 180 180" aria-hidden="true"><defs><linearGradient id="hs-ph" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e2eeff"/></linearGradient><linearGradient id="hs-pg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff5da"/><stop offset="1" stop-color="#eed29a"/></linearGradient><linearGradient id="hs-pf" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1d3478"/><stop offset="1" stop-color="#0d1747"/></linearGradient><linearGradient id="hs-sp" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#2b95ff"/><stop offset="1" stop-color="#0a6ee6"/></linearGradient></defs><ellipse cx="92" cy="157" rx="70" ry="12" fill="#1c4fa0" opacity=".13"/><g transform="rotate(-8 85 105)"><path d="M25 75c25-12 46-8 62 5v70c-17-12-38-16-62-5z" fill="url(#hs-pg)" stroke="#cfae6a"/><path d="M87 80c20-14 43-16 68-5v70c-25-10-47-7-68 5z" fill="#fffaf0" stroke="#cfae6a"/><path d="M87 81v69" stroke="#b08a4c"/><path d="M38 94h34M38 104h31M38 114h35M101 92h39M101 102h35M101 112h38M101 122h28" stroke="#b69455" opacity=".6" stroke-width="2"/></g><g transform="translate(75 16) rotate(7 43 64)"><rect x="2" y="4" width="86" height="130" rx="16" fill="#0d1747" opacity=".16"/><rect width="86" height="130" rx="16" fill="url(#hs-pf)"/><rect x="6" y="7" width="74" height="116" rx="11" fill="url(#hs-ph)"/><rect x="31" y="3" width="24" height="4" rx="2" fill="#5a6c9a"/><path d="M17 31h14v3H20v11h-3zm52 0H55v3h11v11h3zM17 98h14v-3H20V84h-3zm52 0H55v-3h11V84h3z" fill="#0a7cf4"/><rect x="27" y="47" width="26" height="5" rx="2.5" fill="#0a7cf4" opacity=".85"/><path d="M27 60h33M27 68h29" stroke="#a9c1e4" stroke-width="3" stroke-linecap="round"/><rect x="25" y="74" width="38" height="11" rx="4" fill="#d8f1e6"/><path d="M30 79.5h26" stroke="#1f9d74" stroke-width="3" stroke-linecap="round"/></g><circle cx="155" cy="29" r="15.5" fill="#fff" opacity=".9"/><circle cx="155" cy="29" r="13" fill="url(#hs-sp)"/><path d="m155 21 2.2 5.8 5.8 2.2-5.8 2.2-2.2 5.8-2.2-5.8-5.8-2.2 5.8-2.2z" fill="#fff"/></svg>';
    if (type === "pages")
      return '<svg class="pages-illustration" viewBox="0 0 260 220" aria-hidden="true"><defs><linearGradient id="pp-hl" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e8f2ff"/><stop offset="1" stop-color="#d1e4fd"/></linearGradient><linearGradient id="pp-sp" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#2b95ff"/><stop offset="1" stop-color="#0a6ee6"/></linearGradient></defs><ellipse cx="130" cy="200" rx="92" ry="12" fill="#1c4fa0" opacity=".12"/><g transform="translate(20 40) rotate(-14 75 80)"><rect width="140" height="160" rx="13" fill="#f0ecfd" stroke="#dcd3f8"/><rect x="18" y="20" width="40" height="8" rx="4" fill="#8f74f0" opacity=".32"/><path d="M18 45h98M18 58h86M18 71h96" stroke="#d9d0f6" stroke-width="5" stroke-linecap="round"/></g><g transform="translate(38 30) rotate(-5 75 80)"><rect x="3" y="5" width="145" height="165" rx="13" fill="#123a5a" opacity=".06"/><rect width="145" height="165" rx="13" fill="#e9f7f0" stroke="#c9e9d9"/><rect x="18" y="20" width="46" height="8" rx="4" fill="#1f9d74" opacity=".38"/><path d="M18 45h105M18 58h94M18 71h104M18 84h76M18 110h105M18 123h88" stroke="#c6e4d6" stroke-width="5" stroke-linecap="round"/></g><g transform="translate(83 18) rotate(8 75 80)"><rect x="3" y="6" width="145" height="165" rx="13" fill="#123a7a" opacity=".09"/><rect width="145" height="165" rx="13" fill="#fff" stroke="#d6e4f5"/><rect x="18" y="20" width="62" height="9" rx="4.5" fill="#0a7cf4" opacity=".85"/><path d="M18 47h105M18 60h92M18 73h105" stroke="#d5deea" stroke-width="5" stroke-linecap="round"/><rect x="18" y="84" width="44" height="10" rx="4" fill="#dcf3e8"/><path d="M24 89h32" stroke="#1f9d74" stroke-width="3.5" stroke-linecap="round"/><rect x="18" y="105" width="109" height="39" rx="8" fill="url(#pp-hl)"/><rect x="18" y="105" width="4" height="39" rx="2" fill="#0a7cf4"/><path d="M30 117h72M30 128h84" stroke="#7fb0ec" stroke-width="4" stroke-linecap="round"/></g><circle cx="216" cy="35" r="25" fill="#fff" opacity=".85"/><circle cx="216" cy="35" r="21" fill="url(#pp-sp)"/><path d="m216 23 3.3 8.7 8.7 3.3-8.7 3.3-3.3 8.7-3.3-8.7-8.7-3.3 8.7-3.3z" fill="#fff"/><circle cx="36" cy="30" r="4" fill="#1f9d74" opacity=".35"/></svg>';
    return "";
  };

  // ---------- helpers ----------

  const logo = () => '<div class="bookmark-logo logo-img"><img src="./assets/logo-mark.png" alt="Konspekt" width="84" height="84"></div>';
  const brand = () => '<div class="brand">Konspekt <span class="badge">by NK</span></div>';
  const app = (c) => '<div class="app ' + (c || "") + '">';

  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    return n + " " + w;
  };
  const notesCount = (n) => plural(n, "конспект", "конспекта", "конспектов");

  const MONTHS = ["янв.", "февр.", "марта", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];
  function formatTime(ts) {
    const d = new Date(ts), now = new Date();
    const hm = d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
    const dayMs = 864e5;
    const diff = Math.round(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / dayMs,
    );
    if (diff === 0) return "Сегодня, " + hm;
    if (diff === 1) return "Вчера, " + hm;
    return d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "") + ", " + hm;
  }

  const back = () => {
    if (S.history.length) {
      S.screen = S.history.pop();
      S.sheet = null;
      render();
      scrollTo(0, 0);
    } else go("home", false);
  };

  const head = (title, sub, more = false, stacked = false) =>
    '<div class="screen-head' + (stacked ? " stacked" : "") + '"><button class="back" data-back aria-label="Назад">' + icon("back") +
    '</button><div class="head-text"><h1>' +
    esc(title) +
    "</h1>" +
    (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") +
    "</div>" +
    (more ? '<button class="more" data-sheet="bookmark" aria-label="Действия">' + icon("dots") + "</button>" : "") +
    "</div>";

  const searchBox = (id, placeholder) =>
    '<label class="search-box">' + icon("search") + '<input class="search" id="' + id + '" placeholder="' + esc(placeholder) + '"></label>';

  // Иконки категорий закладок: собственный двухтоновый набор (inline SVG, без <use>).
  // Классы слоёв: s — мягкая заливка, i — основной контур, a — акцентный контур, af — акцентная заливка.
  // Цвета задаёт тон плитки (.tone-*), поэтому одна иконка работает на любом цвете закладки.
  const BM_GLYPHS = {
    plus: '<path class="i w" d="M12 6.5v11M6.5 12h11"/>',
    book:
      '<path class="s i" d="M7 4.5h9.5c.8 0 1.5.7 1.5 1.5v12c0 .6-.4 1-1 1H8a2.5 2.5 0 0 1-2.5-2.5V6c0-.8.7-1.5 1.5-1.5Z"/>' +
      '<path class="i" d="M5.5 16.5c0-1.1.9-2 2-2H18"/><path class="a" d="M13.5 4.7v5.6l1.5-1.1 1.5 1.1V4.7"/>',
    leaf:
      '<path class="s i" d="M19 5C11.2 5.1 5.5 8.7 5.5 14.4c0 2.8 1.9 4.6 4.6 4.6C16 19 18.9 12.9 19 5Z"/><path class="i" d="M5 19.8c3-4.9 6.7-8.3 11.2-10.5"/>',
    atom:
      '<ellipse class="i" cx="12" cy="12" rx="8.6" ry="3.4" transform="rotate(35 12 12)"/>' +
      '<ellipse class="i" cx="12" cy="12" rx="8.6" ry="3.4" transform="rotate(-35 12 12)"/><circle class="if" cx="12" cy="12" r="1.9"/>',
    flask:
      '<path class="s i" d="M9.5 4h5M10.4 4.2v5l-4.7 8.3A1.7 1.7 0 0 0 7.2 20h9.6a1.7 1.7 0 0 0 1.5-2.5l-4.7-8.3v-5"/><path class="a" d="M7.6 15.5h8.8"/>',
    globe:
      '<circle class="s i" cx="12" cy="12" r="8"/><ellipse class="i" cx="12" cy="12" rx="3.4" ry="8"/><path class="i" d="M4.4 12h15.2"/>',
    folder:
      '<path class="s i" d="M4 7.5c0-1 .8-1.8 1.8-1.8h3.7l1.9 2h6.8c1 0 1.8.8 1.8 1.8v7.5c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8Z"/>',
    more: '<circle class="if" cx="6.5" cy="12" r="1.6"/><circle class="if" cx="12" cy="12" r="1.6"/><circle class="if" cx="17.5" cy="12" r="1.6"/>',
  };
  const bmGlyph = (n) => {
    if (!BM_GLYPHS[n]) console.warn("[icon] unknown bookmark icon:", n);
    const key = BM_GLYPHS[n] ? n : "book";
    return '<svg class="kt-glyph g-' + key + '" viewBox="0 0 24 24" aria-hidden="true">' + BM_GLYPHS[key] + "</svg>";
  };

  // плитка закладки: мягкая поверхность тона; свой цвет закладки меняет только фон
  const bmTile = (b, cls) =>
    '<div class="' + cls + " kt tone-" + esc(b.icon) + '"' + bmIconStyle(b) + ">" + bmGlyph(b.icon) + "</div>";

  // processing и error — промежуточные экраны, в историю «назад» не попадают
  const TRANSIENT = ["processing", "error"];
  function go(s, push = true) {
    if (push && S.screen !== s && !TRANSIENT.includes(S.screen)) S.history.push(S.screen);
    S.screen = s;
    S.sheet = null;
    render();
    scrollTo(0, 0);
  }

  const openSheet = (sheet) => {
    S.sheet = sheet;
    render();
  };
  const closeSheet = () => openSheet(null);

  function openNote(id) {
    if (!store.getNote(id)) return;
    S.noteId = id;
    store.markOpened(id);
    go("note");
  }

  function openBookmark(id) {
    if (!store.getBookmark(id)) return;
    S.bookmarkId = id;
    go("bookmark");
  }

  /**
   * Обложка конспекта: note.thumbnail / note.thumbnailUrl (обложка темы) поверх запасной обложки предмета.
   * Запасная — градиент предмета + листок с иконкой; она же остаётся видна, если картинка не загрузилась.
   */
  function noteThumb(n) {
    const sub = study.subject(n.subject);
    const src = n.thumbnail || n.thumbnailUrl || sub.asset;
    const [c1, c2] = sub.cover;
    return (
      '<div class="thumb ' + sub.thumb + '" style="--cv1:' + c1 + ";--cv2:" + c2 + '">' +
      '<span class="thumb-page">' + icon(sub.icon) + "</span>" +
      (src ? '<img class="thumb-img" src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : "") +
      "</div>"
    );
  }

  // ---------- screens ----------

  function splash() {
    return app("splash") + logo() + brand() + '<div class="tagline">Учись быстрее, запоминая главное.</div></div>';
  }

  function welcome() {
    return (
      app("welcome") +
      logo() +
      brand() +
      '<h1>Превращай учебник<br>в понятный конспект</h1><p>Сфотографируй страницы — ИИ выделит главное и создаст готовый конспект.</p><div class="steps"><div class="step"><div class="step-icon">' +
      icon("camera") +
      '</div>Сфотографируй</div><div class="arrow">→</div><div class="step"><div class="step-icon">' +
      icon("doc") +
      '</div>Получи конспект</div><div class="arrow">→</div><div class="step"><div class="step-icon">' +
      icon("book") +
      '</div>Учись</div></div><button class="primary" data-start>Начать</button></div>'
    );
  }

  function noteCard(n) {
    const sub = study.subject(n.subject);
    return (
      '<div class="note-card" data-note="' + esc(n.id) + '">' +
      noteThumb(n) +
      "<div><h3>" + esc(n.title) + '</h3><div class="meta"><span class="pill ' + sub.pill + " s-" + esc(n.subject) + '">' +
      esc(n.subjectLabel || sub.label) + "</span> · " + esc(formatTime(n.createdAt)) +
      '</div><div class="preview">' + esc(n.preview) + "</div></div>" +
      '<button class="dots" data-note-menu="' + esc(n.id) + '" aria-label="Действия">' + icon("dotsv") + "</button></div>"
    );
  }

  const emptyState = (title, text) =>
    '<div class="empty"><div class="empty-icon">' + icon("doc") + "</div><strong>" + title + "</strong><p>" + text + "</p></div>";

  // свой цвет закладки: сохранённый светлый оттенок — поверхность, иконка — приглушённый цвет той же гаммы
  const BM_INKS = { "#f7eadc": "#95592f", "#e7f4e9": "#3a7a5a", "#e7f1fd": "#2f6db8", "#f0eafa": "#6552aa", "#f9e8ed": "#a04a62", "#edf0f3": "#4b5578" };
  const bmIconStyle = (b) =>
    isColor(b.color)
      ? ' style="--kt-bg:' + b.color + (BM_INKS[b.color.toLowerCase()] ? ";--g-ink:" + BM_INKS[b.color.toLowerCase()] + ";--g-acc:" + BM_INKS[b.color.toLowerCase()] : "") + '"'
      : "";

  function home() {
    const notes = store.listNotes();
    return (
      app() +
      '<div class="top">' +
      brand() +
      '<div class="brand-spark">✦</div></div><div class="home-kicker">ТВОЯ УЧЁБА · В ОДНОМ МЕСТЕ</div><div class="section-row"><h2>Закладки</h2><button class="link" data-go="bookmarks">Все ›</button></div><div class="bookmarks"><button class="bm" data-go="new-bookmark"><div class="bm-icon kt tone-new">' +
      bmGlyph("plus") +
      "</div><span>Новая</span></button>" +
      store
        .listBookmarks()
        .map(
          (b) =>
            '<button class="bm ' + esc(b.cls) + '" data-bookmark="' + esc(b.id) + '">' + bmTile(b, "bm-icon") + "<span>" + esc(b.name) + "</span></button>",
        )
        .join("") +
      '<button class="bm" data-go="bookmarks"><div class="bm-icon kt tone-more">' +
      bmGlyph("more") +
      '</div><span>Ещё</span></button></div><div class="hero"><div class="hero-orb orb-a"></div><div class="hero-orb orb-b"></div><div class="hero-label">✦ AI КОНСПЕКТ</div><h1>Новый конспект</h1><p>Сфотографируй страницы учебника — остальное сделает ИИ</p><button class="primary" data-go="camera">' +
      icon("camera") +
      "Сфотографировать</button>" +
      art("scan") +
      '</div><div class="section-row"><h2>Недавние</h2><button class="link" data-go="all-notes">Все ›</button></div>' +
      (notes.length
        ? '<div class="note-list">' + notes.slice(0, 3).map(noteCard).join("") + "</div>"
        : emptyState("Здесь появятся твои конспекты", "Создай первый конспект из страниц учебника")) +
      "</div>"
    );
  }

  function bookmarks() {
    const list = store.listBookmarks();
    return (
      app() +
      head("Все закладки", plural(list.length, "закладка", "закладки", "закладок"), false, true) +
      '<div class="bm-list">' +
      list
        .map(
          (b) =>
            '<div class="bm-row" data-bookmark="' + esc(b.id) + '">' + bmTile(b, "bm-tile") + "<div><h3>" + esc(b.name) +
            '</h3><div class="meta">' + notesCount(store.notesInBookmark(b.id).length) + '</div></div><span class="chev">' + icon("chev") + "</span></div>",
        )
        .join("") +
      '</div><button class="add-row" data-go="new-bookmark">' + icon("plus") + "<span>Новая закладка</span></button></div>"
    );
  }

  function bookmark() {
    const b = store.getBookmark(S.bookmarkId);
    if (!b) return bookmarks();
    const list = store.notesInBookmark(b.id);
    return (
      app() +
      head(b.name, notesCount(list.length), true) +
      searchBox("bmSearch", "Поиск в " + b.name) + '<div class="note-list" id="bmList">' +
      (list.length ? list.map(noteCard).join("") : emptyState("Пока пусто", "Добавь сюда конспект")) +
      '</div><button class="fab" data-go="camera" aria-label="Новый конспект">' + icon("plus") + "</button></div>"
    );
  }

  function allNotes() {
    const list = store.listNotes();
    return (
      app() +
      head("Все конспекты", notesCount(list.length)) +
      searchBox("noteSearch", "Поиск по конспектам") + '<div class="note-list" id="allList">' +
      (list.length ? list.map(noteCard).join("") : emptyState("Здесь появятся твои конспекты", "Создай первый конспект из страниц учебника")) +
      "</div></div>"
    );
  }

  function cameraScreen() {
    const n = S.pages.length;
    const sel = S.pages[S.selectedPage];
    const canAdd = n + S.pagesLoading < MAX_PAGES;
    const viewfinder = sel
      ? '<img class="shot-preview" src="' + sel.url + '" alt="Страница ' + (S.selectedPage + 1) + '"><div class="hint">Страница ' +
        (S.selectedPage + 1) + " из " + n + '</div><div class="preview-actions"><button data-retake="' + S.selectedPage +
        '">Переснять</button><button data-remove-page="' + S.selectedPage + '">Удалить</button></div>'
      : '<div class="fake-page"></div><div class="guide"></div><div class="hint">Помести страницу в кадр</div>';
    return (
      app("camera") +
      '<div class="screen-head"><button class="back" data-back aria-label="Закрыть">' + icon("close") +
      '</button><div class="camera-title"><b>Новый конспект</b><span>Сфотографируй страницы</span></div><span style="width:40px"></span></div><div class="viewfinder">' +
      viewfinder +
      '</div><div class="camera-bottom"><div class="page-strip">' +
      S.pages
        .map(
          (p, i) =>
            '<div class="page-thumb' + (i === S.selectedPage ? " selected" : "") + '"><img class="page-shot" src="' + p.url +
            '" data-select-page="' + i + '" alt="Страница ' + (i + 1) + '"><button class="page-remove" data-remove-page="' + i +
            '" aria-label="Удалить страницу ' + (i + 1) + '">' + icon("close") + "</button></div>",
        )
        .join("") +
      '<div class="page-shot loading"></div>'.repeat(S.pagesLoading) +
      (canAdd ? '<button class="add-page" data-camera aria-label="Добавить страницу">' + icon("plus") + "<span>Ещё<br>страница</span></button>" : "") +
      '</div><div class="meta pages-count">Страницы · ' + n +
      (S.pagesMessage ? '</div><div class="meta camera-message">' + esc(S.pagesMessage) : "") +
      '</div><div class="camera-actions"><div class="gallery-wrap"><button class="gallery" data-gallery aria-label="Галерея"' + (canAdd ? "" : " disabled") + ">" +
      icon("gallery") +
      '</button><span>Галерея</span></div><button class="shutter" data-camera aria-label="Сфотографировать"' + (canAdd ? "" : " disabled") +
      '></button><button class="primary" data-process ' + (!n || S.pagesLoading ? "disabled" : "") +
      ">" + icon("sparkle") + "Создать конспект</button></div></div></div>"
    );
  }

  function progressRows() {
    return STEPS.map((t, i) => {
      const st = i < S.gen.step ? "done" : i === S.gen.step ? "active" : "";
      return '<div class="progress-row ' + st + '"><span class="step-dot">' + (st === "done" ? icon("check") : "") + "</span>" + t + "</div>";
    }).join("");
  }

  function processing() {
    return (
      app("processing") +
      '<div class="top">' +
      brand() +
      '</div><div class="visual-stage">' +
      art("pages") +
      '</div><div class="spinner"></div><h1>Создаём конспект</h1><p>Изучаем материал и выделяем главное</p><div class="progress-card" id="progress">' +
      progressRows() +
      '</div><p style="margin-top:22px">Готовый конспект откроется автоматически</p></div>'
    );
  }

  function note() {
    const n = store.getNote(S.noteId);
    if (!n) return home();
    const view = modes.classic.render(n.content);
    return (
      app("note-view nt-" + esc(n.content.meta.subject)) +
      '<div class="note-head"><div class="note-head-top"><button class="back" data-back aria-label="Назад">' + icon("back") +
      '</button><div class="note-actions"><button class="circle-btn note-bookmark" data-sheet="add" aria-label="Добавить в закладку">' + icon("bookmark") +
      '</button><button class="circle-btn note-menu" data-note-menu="' + esc(n.id) + '" aria-label="Действия">' + icon("dots") +
      "</button></div></div></div>" +
      '<div class="cn-search"><label class="cn-search-box">' + icon("search") +
      '<input class="cn-search-input" id="inNoteSearch" type="search" autocomplete="off" enterkeyhint="search" placeholder="' + esc(view.searchHint) +
      '" aria-label="Поиск по конспекту"></label><span class="cn-search-count" id="inNoteCount" aria-live="polite"></span></div>' +
      '<div class="cn-doc" id="noteDoc">' +
      view.head +
      view.body +
      "</div></div>"
    );
  }

  function newBookmark() {
    const editing = store.getBookmark(S.editBookmarkId);
    const d = S.draftBookmark;
    return (
      app() +
      head(editing ? "Изменить закладку" : "Новая закладка", editing ? "Название и оформление" : "Создай раздел для своих конспектов", false, true) +
      '<label class="form-label">Название</label><div class="field-wrap"><input class="field" id="bmName" maxlength="40" placeholder="Например, История" value="' +
      esc(editing ? editing.name : "") +
      '"><button class="field-clear" type="button" data-clear-field aria-label="Очистить">' + icon("close") + '</button></div><label class="form-label">Иконка</label><div class="choices" id="icons">' +
      BM_ICONS.map(
        (x) => '<button class="choice ' + (d.icon === x ? "selected" : "") + '" data-icon="' + x + '"><span class="plate kt tone-' + x + '">' + bmGlyph(x) + "</span></button>",
      ).join("") +
      '</div><label class="form-label">Цвет</label><div class="choices colors" id="colors">' +
      BM_COLORS.map(
        (x, i) =>
          '<button class="choice color-choice ' + (d.color === x ? "selected" : "") + '" data-color="' + x + '"><span class="swatch" style="background:' +
          BM_SWATCHES[i] + '"></span></button>',
      ).join("") +
      '</div><button class="primary wide create-bm" data-create-bm>' +
      (editing ? "Сохранить" : "Создать закладку") +
      "</button></div>"
    );
  }

  function profile() {
    return (
      app() +
      head("Профиль", "") +
      '<div class="profile-top"><div class="avatar">Н</div><div><h2>Николай</h2><p>Локальный профиль</p></div></div><h3>Приложение</h3><div class="profile-card"><div class="profile-row"><div class="setting-icon">' +
      icon("doc") +
      "</div><div><b>Конспекты</b><div class=\"meta\">" +
      store.listNotes().length +
      ' сохранено на устройстве</div></div></div><div class="profile-row"><div class="setting-icon">' +
      icon("bookmark") +
      "</div><div><b>Закладки</b><div class=\"meta\">" +
      store.listBookmarks().length +
      ' создано</div></div></div></div><h3>Настройки</h3><div class="settings-card"><div class="setting"><div class="setting-icon">' +
      icon("help") +
      '</div><b>Помощь</b></div><div class="setting"><div class="setting-icon">' +
      icon("info") +
      '</div><b>О приложении</b></div></div><div class="footer-brand">Konspekt by NK</div></div>'
    );
  }

  function error() {
    return (
      app("processing") +
      '<div class="top">' +
      brand() +
      '</div><div class="visual-stage">' +
      art("pages") +
      '</div><div class="error-icon">!</div><h1>Не удалось создать конспект</h1><p>Что-то пошло не так. Твои фотографии сохранены.</p><div class="error-actions"><button class="primary wide" data-retry>Попробовать снова</button><button class="text-action" data-go="camera">Вернуться к страницам</button><p class="error-hint">Проверь подключение к интернету и попробуй ещё раз.</p></div></div>'
    );
  }

  // ---------- sheets & modals ----------

  const CHEV = '<span class="chev">' + icon("chev") + "</span>";

  function sheet() {
    const sh = S.sheet;
    if (!sh) return "";
    if (sh.type === "note") {
      const n = store.getNote(sh.id);
      if (!n) return "";
      return (
        '<div class="overlay" data-backdrop><div class="sheet"><div class="grab"></div><div class="sheet-title">' +
        noteThumb(n) +
        "<div><h3>" + esc(n.title) + '</h3><span class="subject ' + study.subject(n.subject).badge + " s-" + esc(n.subject) + '">' + esc(n.subjectLabel) +
        '</span></div></div><button class="sheet-action" data-open-note="' + esc(n.id) +
        '">' + icon("open") + "<span>Открыть</span>" + CHEV + '</button><button class="sheet-action" data-sheet="add">' + icon("bookmark") +
        "<span>Добавить в закладку</span>" + CHEV + '</button><button class="sheet-action" data-rename="note">' + icon("edit") +
        "<span>Переименовать</span>" + CHEV + '</button><button class="sheet-action danger" data-delete="note">' + icon("trash") +
        "<span>Удалить</span>" + CHEV + "</button></div></div>"
      );
    }
    if (sh.type === "add") {
      const n = store.getNote(sh.id);
      if (!n) return "";
      return (
        '<div class="overlay" data-backdrop><div class="sheet add-sheet"><div class="grab"></div><h2>Добавить в закладку</h2><p class="sub">' + esc(n.title) + '</p><div class="pick-list">' +
        store
          .listBookmarks()
          .map((b) => {
            const on = b.noteIds.includes(n.id);
            return (
              '<button class="pick-row' + (on ? " on" : "") + '" data-toggle-bm="' + esc(b.id) + '">' + bmTile(b, "pick-tile") + '<span class="pick-text"><b>' +
              esc(b.name) + "</b><small>" + notesCount(store.notesInBookmark(b.id).length) + '</small></span><span class="radio">' +
              (on ? icon("check") : "") + "</span></button>"
            );
          })
          .join("") +
        '</div><button class="add-row" data-new-bm-for-note>' + icon("plus") + '<span>Новая закладка</span></button><button class="primary wide" data-close>Готово</button></div></div>'
      );
    }
    if (sh.type === "bookmark") {
      const b = store.getBookmark(sh.id);
      if (!b) return "";
      return (
        '<div class="overlay" data-backdrop><div class="sheet"><div class="grab"></div><div class="sheet-title">' + bmTile(b, "bm-tile") + "<div><h3>" + esc(b.name) +
        '</h3><span class="meta">' + notesCount(store.notesInBookmark(b.id).length) + '</span></div></div><button class="sheet-action" data-rename="bookmark">' +
        icon("edit") + "<span>Переименовать</span>" + CHEV + '</button><button class="sheet-action" data-edit-bm>' + icon("palette") +
        "<span>Изменить оформление</span>" + CHEV + '</button><button class="sheet-action danger" data-delete="bookmark">' + icon("trash") +
        "<span>Удалить закладку</span>" + CHEV + "</button></div></div>"
      );
    }
    if (sh.type === "delete") {
      const isNote = sh.kind === "note";
      const item = isNote ? store.getNote(sh.id) : store.getBookmark(sh.id);
      if (!item) return "";
      return (
        '<div class="overlay modal-wrap" data-backdrop><div class="modal"><div class="warn">' + icon("trash") + "</div><h2>" +
        (isNote ? "Удалить конспект?" : "Удалить закладку?") +
        "</h2><p>«" + esc(isNote ? item.title : item.name) + "» будет удалён" + (isNote ? "" : "а") + '.</p><p class="modal-note">' +
        (isNote ? "Это действие нельзя отменить." : "Конспекты из неё останутся.") +
        '</p><div class="modal-buttons"><button class="secondary" data-close>Отмена</button><button class="danger-btn" data-confirm-delete>Удалить</button></div></div></div>'
      );
    }
    if (sh.type === "rename") {
      const isNote = sh.kind === "note";
      const item = isNote ? store.getNote(sh.id) : store.getBookmark(sh.id);
      if (!item) return "";
      return (
        '<div class="overlay modal-wrap" data-backdrop><div class="modal"><h2>Переименовать</h2><input class="field" id="renameField" maxlength="' +
        (isNote ? 120 : 40) + '" value="' + esc(isNote ? item.title : item.name) +
        '"><div class="modal-buttons"><button class="secondary" data-close>Отмена</button><button class="primary" data-save-rename>Сохранить</button></div></div></div>'
      );
    }
    return "";
  }

  // ---------- render ----------

  const SCREENS = {
    splash,
    welcome,
    home,
    bookmarks,
    bookmark,
    "all-notes": allNotes,
    camera: cameraScreen,
    processing,
    note,
    "new-bookmark": newBookmark,
    profile,
    error,
  };

  function render() {
    const h = (SCREENS[S.screen] || home)();
    root.innerHTML = h + sheet();
    if (S.sheet?.type === "rename") {
      const f = root.querySelector("#renameField");
      f?.focus();
      f?.select();
    }
  }

  // ---------- camera ----------

  function openPicker(input, replaceIndex = null) {
    S.replacePage = replaceIndex;
    S.pagesMessage = "";
    input.click();
  }

  async function addFiles(fileList) {
    const replaceIndex = S.replacePage;
    S.replacePage = null;
    let files = [...fileList];
    if (!files.length) return;
    if (replaceIndex !== null) files = files.slice(0, 1);
    else {
      const free = MAX_PAGES - S.pages.length - S.pagesLoading;
      if (files.length > free) S.pagesMessage = "Можно добавить не больше " + MAX_PAGES + " страниц";
      files = files.slice(0, Math.max(0, free));
    }
    S.pagesLoading += files.length;
    if (S.screen === "camera") render();
    // по одной, чтобы не держать в памяти несколько полноразмерных фото сразу
    for (const f of files) {
      try {
        const page = await images.preparePage(f);
        if (replaceIndex !== null && S.pages[replaceIndex]) {
          images.releasePage(S.pages[replaceIndex]);
          S.pages[replaceIndex] = page;
          S.selectedPage = replaceIndex;
        } else {
          S.pages.push(page);
          S.selectedPage = S.pages.length - 1;
        }
      } catch (e) {
        console.warn("[camera] photo skipped", e);
        S.pagesMessage = "Не удалось открыть одну из фотографий. Попробуй сфотографировать её ещё раз.";
      } finally {
        S.pagesLoading--;
        if (S.screen === "camera") render();
      }
    }
  }

  function removePage(i) {
    const [p] = S.pages.splice(i, 1);
    images.releasePage(p);
    S.pagesMessage = "";
    if (!S.pages.length) S.selectedPage = -1;
    else if (S.selectedPage >= i) S.selectedPage = Math.max(0, S.selectedPage - 1);
    render();
  }

  function clearPages() {
    S.pages.forEach(images.releasePage);
    S.pages = [];
    S.selectedPage = -1;
    S.pagesMessage = "";
  }

  // ---------- generation ----------

  function stopProgress() {
    clearInterval(S.gen.timer);
    S.gen.timer = null;
  }

  async function startGeneration() {
    if (!S.pages.length || S.pagesLoading) return;
    const run = ++S.gen.run;
    S.gen.step = 0;
    stopProgress();
    go("processing");
    // шаги сменяются по времени, последний держится, пока результат не готов
    S.gen.timer = setInterval(() => {
      if (S.gen.step >= STEPS.length - 1) return stopProgress();
      S.gen.step++;
      const el = root.querySelector("#progress");
      if (el) el.innerHTML = progressRows();
    }, 1100);
    try {
      const content = await generator.analyzePages(S.pages);
      if (run !== S.gen.run) return;
      const n = await store.createNote(content, { kind: generator.kind, pageCount: S.pages.length });
      stopProgress();
      clearPages();
      S.noteId = n.id;
      store.markOpened(n.id);
      S.history = ["home"];
      go("note", false);
    } catch (e) {
      if (run !== S.gen.run) return;
      console.error("[generation] failed", e);
      stopProgress();
      S.history = ["home"];
      go("error", false);
    }
  }

  // ---------- events ----------

  async function saveBookmarkForm() {
    const name = root.querySelector("#bmName")?.value.trim();
    if (!name) {
      root.querySelector("#bmName")?.focus();
      return;
    }
    const d = S.draftBookmark;
    try {
      if (store.getBookmark(S.editBookmarkId)) {
        await store.updateBookmark(S.editBookmarkId, { name, icon: d.icon, color: d.color });
        S.editBookmarkId = null;
        back();
      } else {
        const b = await store.createBookmark({ name, icon: d.icon, color: d.color });
        if (S.bookmarkForNote) {
          await store.toggleNoteInBookmark(b.id, S.bookmarkForNote);
          S.bookmarkForNote = null;
          back();
        } else {
          // заменяем экран формы на список закладок
          const prev = S.history.pop() || "home";
          S.screen = prev;
          if (prev === "bookmarks") render();
          else go("bookmarks");
        }
      }
    } catch (e) {
      console.error("[bookmarks] save failed", e);
    }
  }

  async function onClick(e) {
    const t = e.target;
    const el = (sel) => t.closest(sel);
    let x;

    if ((x = el("[data-backdrop]")) && t === x) return closeSheet();
    if (el("[data-close]")) return closeSheet();
    if (el("[data-back]")) return back();

    if (el("[data-start]")) {
      localStorage.setItem("k-first", "1");
      S.first = false;
      return go("home", false);
    }

    // конспекты
    if ((x = el("[data-note-menu]"))) return openSheet({ type: "note", id: x.dataset.noteMenu });
    if ((x = el("[data-open-note]"))) return openNote(x.dataset.openNote);
    if ((x = el("[data-note]"))) return openNote(x.dataset.note);
    if ((x = el("[data-sheet]"))) {
      if (x.dataset.sheet === "add") return openSheet({ type: "add", id: S.sheet?.id || S.noteId });
      if (x.dataset.sheet === "bookmark") return openSheet({ type: "bookmark", id: S.bookmarkId });
    }
    if ((x = el("[data-rename]"))) return openSheet({ type: "rename", kind: x.dataset.rename, id: S.sheet.id });
    if (el("[data-save-rename]")) {
      const v = root.querySelector("#renameField")?.value.trim();
      if (!v) return;
      const { kind, id } = S.sheet;
      try {
        await (kind === "note" ? store.renameNote(id, v) : store.updateBookmark(id, { name: v }));
      } catch (err) {
        console.error("[rename] failed", err);
      }
      return closeSheet();
    }
    if ((x = el("[data-delete]"))) return openSheet({ type: "delete", kind: x.dataset.delete, id: S.sheet.id });
    if (el("[data-confirm-delete]")) {
      const { kind, id } = S.sheet;
      try {
        await (kind === "note" ? store.deleteNote(id) : store.deleteBookmark(id));
      } catch (err) {
        console.error("[delete] failed", err);
      }
      S.sheet = null;
      const onDeleted = kind === "note" ? S.screen === "note" && S.noteId === id : S.screen === "bookmark" && S.bookmarkId === id;
      return onDeleted ? back() : render();
    }

    // закладки
    if ((x = el("[data-toggle-bm]"))) {
      try {
        await store.toggleNoteInBookmark(x.dataset.toggleBm, S.sheet.id);
      } catch (err) {
        console.error("[bookmarks] toggle failed", err);
      }
      return render();
    }
    if (el("[data-new-bm-for-note]")) {
      S.bookmarkForNote = S.sheet.id;
      S.editBookmarkId = null;
      S.draftBookmark = { icon: "book", color: BM_COLORS[0] };
      return go("new-bookmark");
    }
    if ((x = el("[data-bookmark-menu]"))) return openSheet({ type: "bookmark", id: x.dataset.bookmarkMenu });
    if ((x = el("[data-bookmark]"))) return openBookmark(x.dataset.bookmark);
    if (el("[data-edit-bm]")) {
      const b = store.getBookmark(S.sheet.id);
      S.editBookmarkId = b.id;
      S.bookmarkForNote = null;
      S.draftBookmark = { icon: BM_ICONS.includes(b.icon) ? b.icon : "book", color: isColor(b.color) ? b.color : "" };
      return go("new-bookmark");
    }
    if ((x = el("[data-icon]"))) {
      S.draftBookmark.icon = x.dataset.icon;
      root.querySelectorAll("[data-icon]").forEach((y) => y.classList.toggle("selected", y === x));
      return;
    }
    if ((x = el("[data-color]"))) {
      S.draftBookmark.color = x.dataset.color;
      root.querySelectorAll("[data-color]").forEach((y) => y.classList.toggle("selected", y === x));
      return;
    }
    if (el("[data-create-bm]")) return saveBookmarkForm();
    if (el("[data-clear-field]")) {
      const f = root.querySelector("#bmName");
      f.value = "";
      return f.focus();
    }

    // камера
    if ((x = el("[data-remove-page]"))) return removePage(+x.dataset.removePage);
    if ((x = el("[data-retake]"))) return openPicker(cam, +x.dataset.retake);
    if ((x = el("[data-select-page]"))) {
      S.selectedPage = +x.dataset.selectPage;
      return render();
    }
    if (el("[data-camera]")) return openPicker(cam);
    if (el("[data-gallery]")) return openPicker(gallery);
    if (el("[data-process]") || el("[data-retry]")) return startGeneration();

    // навигация
    if ((x = el("[data-go]"))) {
      const to = x.dataset.go;
      if (to === "new-bookmark") {
        S.editBookmarkId = null;
        S.bookmarkForNote = null;
        S.draftBookmark = { icon: "book", color: BM_COLORS[0] };
      }
      return go(to);
    }
  }

  function filterList(listId, notes, q) {
    const box = root.querySelector(listId);
    if (!box) return;
    q = q.trim().toLowerCase();
    const found = notes.filter((n) => (n.title + " " + (n.subjectLabel || "") + " " + (n.preview || "")).toLowerCase().includes(q));
    box.innerHTML = found.length ? found.map(noteCard).join("") : emptyState("Ничего не найдено", "Попробуй другой запрос");
  }

  // ---------- поиск внутри открытого конспекта: подсветка совпадений в уже отрисованном тексте ----------

  const NOTE_FIND = { hits: [], index: -1 };

  function clearNoteMarks(doc) {
    doc.querySelectorAll("mark.cn-hit").forEach((m) => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function findInNote(query) {
    const doc = root.querySelector("#noteDoc");
    const count = root.querySelector("#inNoteCount");
    if (!doc) return;
    clearNoteMarks(doc);
    NOTE_FIND.hits = [];
    NOTE_FIND.index = -1;
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      if (count) count.textContent = "";
      return;
    }
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.toLowerCase().includes(q)) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let from = 0;
      for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
        frag.appendChild(document.createTextNode(text.slice(from, at)));
        const m = document.createElement("mark");
        m.className = "cn-hit";
        m.textContent = text.slice(at, at + q.length);
        frag.appendChild(m);
        NOTE_FIND.hits.push(m);
        from = at + q.length;
      }
      frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
    });
    if (count) count.textContent = NOTE_FIND.hits.length ? "" : "Нет совпадений";
    nextNoteHit();
  }

  function nextNoteHit() {
    const hits = NOTE_FIND.hits;
    const count = root.querySelector("#inNoteCount");
    if (!hits.length) return;
    hits[NOTE_FIND.index]?.classList.remove("current");
    NOTE_FIND.index = (NOTE_FIND.index + 1) % hits.length;
    const m = hits[NOTE_FIND.index];
    m.classList.add("current");
    if (count) count.textContent = NOTE_FIND.index + 1 + " из " + hits.length;
    const bar = root.querySelector(".cn-search");
    const y = m.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0) - 70;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  function onInput(e) {
    if (e.target.id === "inNoteSearch") findInNote(e.target.value);
    if (e.target.id === "noteSearch") filterList("#allList", store.listNotes(), e.target.value);
    if (e.target.id === "bmSearch") filterList("#bmList", store.notesInBookmark(S.bookmarkId), e.target.value);
  }

  function onKeydown(e) {
    if (e.key === "Enter" && e.target.id === "renameField") root.querySelector("[data-save-rename]")?.click();
    if (e.key === "Enter" && e.target.id === "inNoteSearch") {
      e.preventDefault();
      nextNoteHit();
    }
    if (e.key === "Escape" && S.sheet) closeSheet();
  }

  root.addEventListener("click", (e) => {
    onClick(e).catch((err) => console.error(err));
  });
  root.addEventListener("input", onInput);
  document.addEventListener("keydown", onKeydown);
  // Новая версия на сервере: приложение, оставленное открытым (PWA в фоне), обновляется само,
  // когда пользователь возвращается к нему. Не перезагружаем посреди съёмки, обработки и открытого листа.
  const BUILD = ((document.querySelector('script[src*="app.js"]') || {}).src || "").match(/[?&]v=(\d+)/)?.[1];
  async function checkForUpdate() {
    if (!BUILD || document.visibilityState !== "visible" || navigator.onLine === false) return;
    try {
      navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
      const html = await (await fetch("./index.html", { cache: "no-store" })).text();
      const live = html.match(/app\.js\?v=(\d+)/)?.[1];
      if (live && live !== BUILD && !["camera", "processing"].includes(S.screen) && !S.sheet) location.reload();
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", checkForUpdate);

  // обложка не загрузилась — убираем картинку, под ней остаётся обложка предмета
  root.addEventListener("error", (e) => e.target.classList?.contains("thumb-img") && e.target.remove(), true);

  cam.onchange = () => {
    const files = cam.files;
    addFiles(files);
    cam.value = "";
  };
  gallery.onchange = () => {
    const files = gallery.files;
    addFiles(files);
    gallery.value = "";
  };

  store.init().then(render);
})();
