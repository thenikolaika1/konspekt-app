from pathlib import Path

p = Path("supabase/functions/analyze-pages/providers.ts")
s = p.read_text()

config_old = """  /** сколько страниц загружать в Files API одновременно: быстрее последовательной загрузки, без нагрузки на лимиты */
  uploadConcurrency: 3,
};"""
config_new = """  /** сколько страниц загружать в Files API одновременно: быстрее последовательной загрузки, без нагрузки на лимиты */
  uploadConcurrency: 3,
  /** общий лимит этапа Files API; обычная загрузка занимает ~7–12 с, зависание не должно съедать весь AI-бюджет */
  uploadMaxMs: 18_000,
};"""
if s.count(config_old) != 1:
    raise SystemExit("Expected GIGACHAT config block exactly once")
s = s.replace(config_old, config_new)

stage_old = """    stage = \"upload\";
    t = Date.now();
    await runPool(missing.map((u) => () => upload(u, urls.indexOf(u) + 1)), GIGACHAT.uploadConcurrency);
    timings.uploadMs = Date.now() - t;"""
stage_new = """    stage = \"upload\";
    t = Date.now();
    const uploadCtrl = new AbortController();
    const abortUploads = () => uploadCtrl.abort();
    ctrl.signal.addEventListener(\"abort\", abortUploads, { once: true });
    const uploadTimer = setTimeout(() => uploadCtrl.abort(), Math.min(GIGACHAT.uploadMaxMs, Math.max(1, timeout - (Date.now() - started))));
    try {
      const uploadApi = async (url: string, n: number) => {
        const { bytes, mime } = decodeDataUrl(url);
        const ext = mime === \"image/png\" ? \"png\" : mime === \"image/webp\" ? \"webp\" : \"jpg\";
        const form = new FormData();
        form.append(\"file\", new Blob([bytes], { type: mime }), \"page-\" + n + \".\" + ext);
        form.append(\"purpose\", \"general\");
        for (let retried = false;; retried = true) {
          const token = await gigaAccessToken(uploadCtrl.signal);
          const res = await gigaFetch(GIGACHAT.apiUrl + \"/files\", { method: \"POST\", body: form, headers: { Authorization: \"Bearer \" + token, Accept: \"application/json\" } }, uploadCtrl.signal);
          const body = await res.text();
          if (res.status === 401 && !retried) {
            if (gigaToken?.value === token) gigaToken = null;
            continue;
          }
          if (!res.ok) throw fail(res.status, body);
          let id = \"\";
          try { id = String(JSON.parse(body).id || \"\"); } catch { /* no id */ }
          if (!id) throw new ProviderError(\"AI_ERROR\", \"upload: no file id\", \"gigachat\", res.status);
          s.files.set(url, id);
          uploaded++;
          return;
        }
      };
      await runPool(missing.map((u) => () => uploadApi(u, urls.indexOf(u) + 1)), GIGACHAT.uploadConcurrency);
    } catch (e) {
      if (uploadCtrl.signal.aborted && !ctrl.signal.aborted) {
        throw new ProviderError(\"AI_TIMEOUT\", \"upload timeout \" + GIGACHAT.uploadMaxMs + \" ms\", \"gigachat\");
      }
      throw e;
    } finally {
      clearTimeout(uploadTimer);
      ctrl.signal.removeEventListener(\"abort\", abortUploads);
    }
    timings.uploadMs = Date.now() - t;"""
if s.count(stage_old) != 1:
    raise SystemExit("Expected upload stage exactly once")
s = s.replace(stage_old, stage_new)

p.write_text(s)
assert "uploadMaxMs: 18_000" in s
assert 'new ProviderError("AI_TIMEOUT", "upload timeout "' in s
print("Patched providers.ts: GigaChat Files upload stage capped at 18s")
