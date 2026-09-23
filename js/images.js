/*
 * Подготовка фотографий страниц на устройстве: уменьшение до MAX_SIDE по длинной
 * стороне и JPEG-сжатие. Держим в памяти Blob + objectURL вместо full-res base64.
 * Эти же JPEG позже будут отправляться на сервер.
 */
(() => {
  const K = (window.K = window.K || {});
  const MAX_SIDE = 1600;
  const QUALITY = 0.82;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("IMAGE_DECODE_FAILED"));
      };
      img.src = url;
    });
  }

  async function preparePage(file) {
    const { img, url } = await loadImage(file);
    try {
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error("IMAGE_DECODE_FAILED");
      const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w0 * scale);
      canvas.height = Math.round(h0 * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("IMAGE_ENCODE_FAILED"))), "image/jpeg", QUALITY),
      );
      const page = { id: K.uid(), blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
      canvas.width = canvas.height = 0;
      return page;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const releasePage = (page) => page && URL.revokeObjectURL(page.url);

  K.images = { MAX_SIDE, preparePage, releasePage };
})();
