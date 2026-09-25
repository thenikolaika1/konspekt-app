/*
 * Демо-страница учебника в области сканирования камеры (пустой экран камеры).
 * Это иллюстрация того, что нужно сфотографировать, — не распознанный контент.
 *
 * Вёрстка общая для всех предметов: параграф, заголовок, вводный текст, иллюстрация с подписью,
 * подзаголовок, текст, цветной факт, номер страницы. Предмет задаёт только данные и иллюстрацию
 * (K.demoPage.PAGES). Всё рисуется встроенным SVG — страница видна полностью с первого кадра,
 * без загрузки картинок.
 */
(() => {
  const K = (window.K = window.K || {});
  const W = 265; // ширина страницы в единицах SVG (≈ px на экране 390)
  const H = 346;
  const X = 18; // поля страницы
  const TW = W - X * 2; // ширина колонки текста
  const SERIF = "Georgia,'Times New Roman',serif";
  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

  // строки текста: разная длина, как в настоящем абзаце; bold — более тёмный фрагмент в начале строки
  const lines = (y, widths, opts = {}) =>
    widths
      .map((w, i) => {
        const yy = y + i * 8.2;
        const bold = opts.bold && i === opts.bold.line ? '<rect x="' + X + '" y="' + yy + '" width="' + opts.bold.w + '" height="3.4" rx="1.7" fill="#3a4468"/>' : "";
        const start = bold ? X + opts.bold.w + 3 : X;
        // цветные фрагменты внутри строки: выделенные термины, даты, имена
        const marks = (opts.marks || [])
          .filter((m) => m.line === i)
          .map((m) => '<rect x="' + (X + m.x) + '" y="' + yy + '" width="' + m.w + '" height="3.4" rx="1.7" fill="' + m.color + '"/>')
          .join("");
        return bold + '<rect x="' + start + '" y="' + yy + '" width="' + Math.max(0, w - (start - X)) + '" height="3.4" rx="1.7" fill="#c3cbdb"/>' + marks;
      })
      .join("");

  // иллюстрация истории: корабль Балтийского флота у крепости, закат (в духе обложки конспекта)
  const HISTORY_ART = (x, y, w, h) =>
    '<svg x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" viewBox="0 0 229 88" preserveAspectRatio="xMidYMid slice">' +
    '<defs><linearGradient id="dp-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2757"/><stop offset=".45" stop-color="#6e2437"/>' +
    '<stop offset=".78" stop-color="#cf7440"/><stop offset=".92" stop-color="#eab35a"/></linearGradient>' +
    '<radialGradient id="dp-sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff0c2"/><stop offset=".55" stop-color="#f4c766"/><stop offset="1" stop-color="#f4c766" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="dp-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#23306a"/><stop offset="1" stop-color="#101a44"/></linearGradient>' +
    '<linearGradient id="dp-sail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fbf4e2"/><stop offset="1" stop-color="#e2cda0"/></linearGradient></defs>' +
    '<rect width="229" height="88" fill="url(#dp-sky)"/>' +
    '<circle cx="168" cy="60" r="20" fill="url(#dp-sun)"/><circle cx="168" cy="60" r="7" fill="#fbe3a0"/>' +
    '<path d="M186 64l10-9 8 4 10-7 15 8v10h-43z" fill="#1f6b5a" opacity=".85"/>' + // берег с зеленью
    '<path d="M0 66V52h5v-4h4v4h5v-9h3v-4h4v4h3v9h5v-4h4v4h5v14z" fill="#3a1a2a"/><path d="M19 39l2-6 2 6z" fill="#3a1a2a"/>' +
    '<rect y="64" width="229" height="24" fill="url(#dp-sea)"/>' +
    '<g transform="translate(112 64)">' +
    '<path d="M-22-42v40M-6-48v46M9-40v38" stroke="#2b1520" stroke-width="1.4"/>' +
    '<path d="M-33-39c4 3 6 8 6 13h11c0-5-2-10-6-13z" fill="url(#dp-sail)"/><path d="M-33-22c4 3 6 7 6 12h13c0-5-2-9-6-12z" fill="url(#dp-sail)"/>' +
    '<path d="M-17-45c4 3 6 9 6 15h12c0-6-2-12-6-15z" fill="url(#dp-sail)"/><path d="M-18-26c4 3 6 8 6 14h14c0-6-2-11-6-14z" fill="url(#dp-sail)"/>' +
    '<path d="M-1-37c4 3 5 7 5 11h10c0-4-2-8-5-11z" fill="url(#dp-sail)"/><path d="M-1-23c4 3 5 7 5 11h11c0-4-2-8-5-11z" fill="url(#dp-sail)"/>' +
    '<path d="M-6-48l7 2-7 2z" fill="#c4304a"/>' +
    '<path d="M-40-4h58l-3 4c-1 3-4 6-9 6h-35c-5 0-8-3-9-6z" fill="#3b1a22"/><path d="M-37 0h52" stroke="#e0a846" stroke-width="1.2"/>' +
    "</g>" +
    '<g fill="none" stroke="#e8b35a" stroke-linecap="round" opacity=".85"><path d="M22 74c4-2 8-2 12 0M150 76c5-2 10-2 15 0" stroke-width="1.4"/>' +
    '<path d="M60 82c5-2 10-2 15 0M186 83c5-2 10-2 15 0" stroke-width="1.2" opacity=".6"/></g>' +
    '<path d="M0 80c30-3 60-3 90 0" stroke="#2fb3a0" stroke-width="1" opacity=".35" fill="none"/>' + // бирюзовый блик на воде
    "</svg>";

  const PAGES = {
    history: {
      paragraph: "§ 7",
      running: "ИСТОРИЯ РОССИИ",
      title: "Северная война",
      intro: { widths: [229, 214, 150], marks: [{ line: 1, x: 96, w: 44, color: "#1f66d6" }] },
      art: HISTORY_ART,
      caption: "Балтийский флот Петра I, начало XVIII в.",
      subheading: "Первые годы войны",
      body: { widths: [229, 222, 229, 132], bold: { line: 0, w: 46 }, marks: [{ line: 2, x: 60, w: 30, color: "#a3223e" }] },
      fact: { value: "1700", text: "Начало Северной войны", tone: ["#149157", "#dff3e8", "#0c6a3f"] },
      tail: { widths: [229, 176], marks: [{ line: 0, x: 138, w: 34, color: "#c7641f" }] },
      page: "52",
      colors: { accent: "#1f66d6", rule: "#a3223e" },
    },
  };

  function render(subject) {
    const p = PAGES[subject] || PAGES.history;
    const [factStripe, factBg, factInk] = p.fact.tone;
    let y = 18;
    let s = '<svg class="demo-page" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMin meet" aria-hidden="true">';
    // шапка: пометка параграфа и колонтитул
    s += '<rect x="' + X + '" y="' + y + '" width="30" height="15" rx="4" fill="' + p.colors.accent + '"/>';
    s += '<text x="' + (X + 15) + '" y="' + (y + 10.8) + '" text-anchor="middle" font-family="' + SANS + '" font-size="9.5" font-weight="800" fill="#fff">' + p.paragraph + "</text>";
    s += '<text x="' + (W - X) + '" y="' + (y + 10) + '" text-anchor="end" font-family="' + SANS + '" font-size="6.4" font-weight="700" letter-spacing=".9" fill="#98a0b8">' + p.running + "</text>";
    // заголовок и бордовая линия
    y += 40;
    s += '<text x="' + X + '" y="' + y + '" font-family="' + SERIF + '" font-size="21" font-weight="700" fill="#10163a">' + p.title + "</text>";
    y += 8;
    s += '<rect x="' + X + '" y="' + y + '" width="34" height="2.6" rx="1.3" fill="' + p.colors.rule + '"/><circle cx="' + (X + 40) + '" cy="' + (y + 1.3) + '" r="1.6" fill="#d9a441"/>';
    // вводный абзац
    y += 10;
    s += lines(y, p.intro.widths, { marks: p.intro.marks });
    // иллюстрация с подписью
    y += p.intro.widths.length * 8.2 + 6;
    const artH = 88;
    s += '<clipPath id="dp-clip"><rect x="' + X + '" y="' + y + '" width="' + TW + '" height="' + artH + '" rx="8"/></clipPath>';
    s += '<g clip-path="url(#dp-clip)">' + p.art(X, y, TW, artH) + "</g>";
    s += '<rect x="' + X + '" y="' + y + '" width="' + TW + '" height="' + artH + '" rx="8" fill="none" stroke="rgba(16,22,58,.12)"/>';
    y += artH + 11;
    s += '<text x="' + X + '" y="' + y + '" font-family="' + SERIF + '" font-style="italic" font-size="7.4" fill="#6b7390">' + p.caption + "</text>";
    // подзаголовок и текст
    y += 18;
    s += '<rect x="' + X + '" y="' + (y - 8) + '" width="3" height="10" rx="1.5" fill="' + p.colors.accent + '"/>';
    s += '<text x="' + (X + 8) + '" y="' + y + '" font-family="' + SANS + '" font-size="11.5" font-weight="800" fill="' + p.colors.accent + '">' + p.subheading + "</text>";
    y += 8;
    s += lines(y, p.body.widths, { bold: p.body.bold, marks: p.body.marks });
    // цветной факт
    y += p.body.widths.length * 8.2 + 5;
    s += '<rect x="' + X + '" y="' + y + '" width="' + TW + '" height="30" rx="7" fill="' + factBg + '"/>';
    s += '<rect x="' + X + '" y="' + y + '" width="3.5" height="30" rx="1.75" fill="' + factStripe + '"/>';
    s += '<text x="' + (X + 12) + '" y="' + (y + 20) + '" font-family="' + SANS + '" font-size="14" font-weight="800" fill="' + factInk + '">' + p.fact.value + "</text>";
    s += '<text x="' + (X + 52) + '" y="' + (y + 19.2) + '" font-family="' + SANS + '" font-size="8.6" font-weight="600" fill="#1a2036">' + p.fact.text + "</text>";
    // окончание абзаца и номер страницы
    y += 38;
    s += lines(y, p.tail.widths, { marks: p.tail.marks });
    s += '<path d="M' + X + " " + (H - 20) + "H" + (W - X) + '" stroke="#e6dfcf" stroke-width="1"/>';
    s += '<text x="' + W / 2 + '" y="' + (H - 8) + '" text-anchor="middle" font-family="' + SERIF + '" font-size="8" fill="#8a90a6">' + p.page + "</text>";
    return s + "</svg>";
  }

  K.demoPage = { render, PAGES };
})();
