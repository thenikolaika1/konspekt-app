from pathlib import Path

p = Path("supabase/functions/analyze-pages/providers.ts")
s = p.read_text()

config_old = """  /** сколько страниц загружать в Files API одновременно: быстрее последовательной загрузки, без нагрузки на лимиты */
  uploadConcurrency: 3,
};"""
config_new = """  /** сколько страниц загружать в Files API одновременно: быстрее последовательной загрузки, без нагрузки на лимиты */
  uploadConcurrency: 3,
  /** лимит одного HTTP upload в Files API; stage может состоять из нескольких волн по uploadConcurrency */
  uploadRequestMaxMs: 18_000,
};"""
if s.count(config_old) != 1:
    raise SystemExit("Expected GIGACHAT config block exactly once")
s = s.replace(config_old, config_new)

api_old = """  const api = async (path: string, init: RequestInit): Promise<{ res: Response; body: string }> => {
    for (let retried = false;; retried = true) {
      const token = await gigaAccessToken(ctrl.signal);
      const res = await gigaFetch(GIGACHAT.apiUrl + path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: \"Bearer \" + token, Accept: \"application/json\" } }, ctrl.signal);"""
api_new = """  const api = async (path: string, init: RequestInit, signal: AbortSignal = ctrl.signal): Promise<{ res: Response; body: string }> => {
    for (let retried = false;; retried = true) {
      const token = await gigaAccessToken(signal);
      const res = await gigaFetch(GIGACHAT.apiUrl + path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: \"Bearer \" + token, Accept: \"application/json\" } }, signal);"""
if s.count(api_old) != 1:
    raise SystemExit("Expected GigaChat api helper exactly once")
s = s.replace(api_old, api_new)

upload_old = """  const upload = async (url: string, n: number) => {
    const { bytes, mime } = decodeDataUrl(url);
    const ext = mime === \"image/png\" ? \"png\" : mime === \"image/webp\" ? \"webp\" : \"jpg\";
    const form = new FormData();
    form.append(\"file\", new Blob([bytes], { type: mime }), \"page-\" + n + \".\" + ext);
    form.append(\"purpose\", \"general\");
    const { res, body } = await api(\"/files\", { method: \"POST\", body: form });
    if (!res.ok) throw fail(res.status, body);
    let id = \"\";
    try {
      id = String(JSON.parse(body).id || \"\");
    } catch { /* нет id */ }
    if (!id) throw new ProviderError(\"AI_ERROR\", \"upload: no file id\", \"gigachat\", res.status);
    s.files.set(url, id);
    uploaded++;
  };"""
upload_new = """  const upload = async (url: string, n: number) => {
    const uploadCtrl = new AbortController();
    const abortUpload = () => uploadCtrl.abort();
    if (ctrl.signal.aborted) abortUpload();
    else ctrl.signal.addEventListener(\"abort\", abortUpload, { once: true });
    const uploadTimer = setTimeout(abortUpload, GIGACHAT.uploadRequestMaxMs);
    try {
      const { bytes, mime } = decodeDataUrl(url);
      const ext = mime === \"image/png\" ? \"png\" : mime === \"image/webp\" ? \"webp\" : \"jpg\";
      const form = new FormData();
      form.append(\"file\", new Blob([bytes], { type: mime }), \"page-\" + n + \".\" + ext);
      form.append(\"purpose\", \"general\");
      const { res, body } = await api(\"/files\", { method: \"POST\", body: form }, uploadCtrl.signal);
      if (!res.ok) throw fail(res.status, body);
      let id = \"\";
      try {
        id = String(JSON.parse(body).id || \"\");
      } catch { /* нет id */ }
      if (!id) throw new ProviderError(\"AI_ERROR\", \"upload: no file id\", \"gigachat\", res.status);
      s.files.set(url, id);
      uploaded++;
    } catch (e) {
      if (uploadCtrl.signal.aborted && !ctrl.signal.aborted) {
        throw new ProviderError(\"AI_TIMEOUT\", \"upload timeout \" + GIGACHAT.uploadRequestMaxMs + \" ms\", \"gigachat\");
      }
      throw e;
    } finally {
      clearTimeout(uploadTimer);
      ctrl.signal.removeEventListener(\"abort\", abortUpload);
    }
  };"""
if s.count(upload_old) != 1:
    raise SystemExit("Expected upload helper exactly once")
s = s.replace(upload_old, upload_new)

p.write_text(s)
assert "uploadRequestMaxMs: 18_000" in s
assert "signal: AbortSignal = ctrl.signal" in s
assert 'new ProviderError("AI_TIMEOUT", "upload timeout "' in s
assert 'api("/files", { method: "POST", body: form }, uploadCtrl.signal)' in s
print("Patched providers.ts: each GigaChat Files HTTP upload capped at 18s")
