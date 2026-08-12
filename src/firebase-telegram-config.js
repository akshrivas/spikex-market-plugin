(() => {
  if (window.__spikexTelegramConfig) return;

  const PROJECT_ID = "spikex-11403";
  const API_KEY = "AIzaSyBsnbT-v6ZYi-ZqJA3feplWpDuhKYUHpl8";
  const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const CONFIG_PATH = "spikex/config";
  const PAPER_PATH = "spikex/paper";

  function toFirestoreValue(value) {
    if (value == null) return { nullValue: null };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
    if (typeof value === "number") return { doubleValue: value };
    return { stringValue: String(value) };
  }

  function fromFirestoreValue(value) {
    if (!value || typeof value !== "object") return null;
    if ("stringValue" in value) return value.stringValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return value.doubleValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("nullValue" in value) return null;
    return null;
  }

  function documentToObject(doc) {
    const out = {};
    if (!doc?.fields) return out;
    for (const [key, value] of Object.entries(doc.fields)) {
      out[key] = fromFirestoreValue(value);
    }
    return out;
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

  async function loadTelegramConfig() {
    const doc = await firestoreRequest("GET", CONFIG_PATH);
    if (!doc) return null;
    const raw = documentToObject(doc);
    return {
      telegramAlertsEnabled: raw.telegramAlertsEnabled !== false,
      telegramBotToken: String(raw.telegramBotToken || "").trim(),
      telegramChatId: String(raw.telegramChatId || "").trim(),
      geminiApiKey: String(raw.geminiApiKey || "").trim(),
      geminiModel: String(raw.geminiModel || "").trim(),
      updatedAt: raw.updatedAt || null
    };
  }

  async function saveTelegramConfig(config) {
    const fields = {
      telegramAlertsEnabled: toFirestoreValue(config.telegramAlertsEnabled !== false),
      telegramBotToken: toFirestoreValue(String(config.telegramBotToken || "").trim()),
      telegramChatId: toFirestoreValue(String(config.telegramChatId || "").trim()),
      updatedAt: toFirestoreValue(new Date().toISOString())
    };
    const fieldPaths = Object.keys(fields);
    const mask = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");

    let res = await firestoreRequest("PATCH", CONFIG_PATH, { fields }, mask);
    if (res === null) {
      res = await firestoreRequest("POST", "spikex?documentId=config", { fields });
    }
    return res;
  }

  async function loadSystemPaper() {
    const doc = await firestoreRequest("GET", PAPER_PATH);
    if (!doc) return null;
    const raw = documentToObject(doc);
    if (!raw.paperData) return null;
    try {
      return JSON.parse(raw.paperData);
    } catch {
      return null;
    }
  }

  async function saveSystemPaper(paperPayload) {
    const fields = {
      paperData: toFirestoreValue(JSON.stringify(paperPayload)),
      updatedAt: toFirestoreValue(new Date().toISOString())
    };
    const fieldPaths = Object.keys(fields);
    const mask = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");

    let res = await firestoreRequest("PATCH", PAPER_PATH, { fields }, mask);
    if (res === null) {
      res = await firestoreRequest("POST", "spikex?documentId=paper", { fields });
    }
    return res;
  }

  window.__spikexCloudConfig = {
    loadTelegramConfig,
    saveTelegramConfig,
    loadSystemPaper,
    saveSystemPaper
  };
  window.__spikexTelegramConfig = window.__spikexCloudConfig;
})();
