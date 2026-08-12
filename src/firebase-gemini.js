(() => {
  if (window.__spikexCloudGemini) return;

  const PROJECT_ID = "spikex-11403";
  const API_KEY = "AIzaSyBsnbT-v6ZYi-ZqJA3feplWpDuhKYUHpl8";
  const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const MATCHES = "matches";

  function toFirestoreValue(value) {
    if (value == null) return { nullValue: null };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") {
      return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    }
    if (typeof value === "string") return { stringValue: value };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(toFirestoreValue) } };
    }
    if (typeof value === "object") {
      const fields = {};
      for (const [key, entry] of Object.entries(value)) {
        fields[key] = toFirestoreValue(entry);
      }
      return { mapValue: { fields } };
    }
    return { stringValue: String(value) };
  }

  function toFirestoreFields(obj) {
    const fields = {};
    for (const [key, value] of Object.entries(obj || {})) {
      fields[key] = toFirestoreValue(value);
    }
    return fields;
  }

  async function firestoreRequest(method, path, body, extraQuery = "") {
    const q = extraQuery ? `${extraQuery}&key=${API_KEY}` : `key=${API_KEY}`;
    const url = `${BASE}/${path}?${q}`;
    const opts = { method };
    if (body != null && method !== "GET") {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = `HTTP ${res.status}`;
      try {
        message = JSON.parse(text)?.error?.message || message;
      } catch {
        if (text) message = text.slice(0, 120);
      }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  function reviewPath(eventId, reviewId) {
    return `${MATCHES}/${encodeURIComponent(String(eventId))}/reviews/${encodeURIComponent(String(reviewId))}`;
  }

  async function saveGeminiReview(eventId, reviewId, record) {
    const id = String(eventId || "");
    const rid = String(reviewId || "");
    if (!id || !rid) return { ok: false, error: "missing eventId or reviewId" };

    const fields = toFirestoreFields(record);
    const path = reviewPath(id, rid);

    try {
      let res = await firestoreRequest("PATCH", path, { fields });
      if (res === null) {
        res = await firestoreRequest(
          "POST",
          `${MATCHES}/${encodeURIComponent(id)}/reviews?documentId=${encodeURIComponent(rid)}`,
          { fields }
        );
      }
      return { ok: true, eventId: id, reviewId: rid };
    } catch (error) {
      console.warn("[SpikeX Firebase Gemini] save failed:", error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async function updateGeminiReviewPnl(eventId, reviewId, patch) {
    const id = String(eventId || "");
    const rid = String(reviewId || "");
    if (!id || !rid) return { ok: false, error: "missing eventId or reviewId" };

    const fields = toFirestoreFields(patch);
    const fieldPaths = Object.keys(patch);
    const mask = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");

    try {
      const res = await firestoreRequest("PATCH", reviewPath(id, rid), { fields }, mask);
      if (res === null) {
        return saveGeminiReview(id, rid, patch);
      }
      return { ok: true, eventId: id, reviewId: rid };
    } catch (error) {
      console.warn("[SpikeX Firebase Gemini] pnl update failed:", error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  window.__spikexCloudGemini = {
    saveGeminiReview,
    updateGeminiReviewPnl
  };
})();
