(() => {
  if (window.__spikexCloudOdds) return;

  const PROJECT_ID = "spikex-11403";
  const API_KEY = "AIzaSyBsnbT-v6ZYi-ZqJA3feplWpDuhKYUHpl8";
  const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const MATCHES = "matches";
  const SYNC_MS = 15000;
  const MAX_POINTS = 3000;

  const docs = new Map();
  const teamMap = new Map();
  const loaded = new Set();
  const syncTimers = new Map();

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

  function fromFirestoreValue(value) {
    if (!value || typeof value !== "object") return null;
    if ("stringValue" in value) return value.stringValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return value.doubleValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("nullValue" in value) return null;
    if ("arrayValue" in value) {
      return (value.arrayValue?.values || []).map(fromFirestoreValue);
    }
    if ("mapValue" in value) {
      const out = {};
      for (const [key, entry] of Object.entries(value.mapValue?.fields || {})) {
        out[key] = fromFirestoreValue(entry);
      }
      return out;
    }
    return null;
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

  function emptyTeamOdds() {
    return { back: [], lay: [] };
  }

  function emptyDoc() {
    return {
      team1: emptyTeamOdds(),
      team2: emptyTeamOdds()
    };
  }

  function isDrawRunner(name) {
    return /^(the\s*)?draw$/i.test(String(name || "").trim());
  }

  function matchTeams(runners) {
    return (runners || []).filter((runner) => runner?.runnerName && !isDrawRunner(runner.runnerName)).slice(0, 2);
  }

  function runnerKey(runner) {
    return String(runner.runnerId || runner.runnerName || "");
  }

  function resolveTeamSlots(eventId, runners) {
    const id = String(eventId);
    const teams = matchTeams(runners);
    if (teams.length < 2) return null;

    let map = teamMap.get(id);
    if (!map) {
      map = {
        team1: runnerKey(teams[0]),
        team2: runnerKey(teams[1])
      };
      teamMap.set(id, map);
    }
    return map;
  }

  function trimSeries(arr) {
    while (arr.length > MAX_POINTS) arr.shift();
  }

  function pushSeries(arr, value) {
    if (value == null || !Number.isFinite(value)) return false;
    if (arr.length && arr[arr.length - 1] === value) return false;
    arr.push(value);
    trimSeries(arr);
    return true;
  }

  function parseDoc(rawDoc) {
    if (!rawDoc?.fields) return emptyDoc();
    const team1 = fromFirestoreValue(rawDoc.fields.team1) || emptyTeamOdds();
    const team2 = fromFirestoreValue(rawDoc.fields.team2) || emptyTeamOdds();
    return {
      team1: {
        back: Array.isArray(team1.back) ? team1.back : [],
        lay: Array.isArray(team1.lay) ? team1.lay : []
      },
      team2: {
        back: Array.isArray(team2.back) ? team2.back : [],
        lay: Array.isArray(team2.lay) ? team2.lay : []
      }
    };
  }

  async function ensureDoc(eventId) {
    const id = String(eventId);
    if (docs.has(id)) return docs.get(id);

    let data = emptyDoc();
    if (!loaded.has(id)) {
      loaded.add(id);
      try {
        const existing = await firestoreRequest("GET", `${MATCHES}/${encodeURIComponent(id)}`);
        if (existing) data = parseDoc(existing);
      } catch (error) {
        console.warn("[SpikeX Firebase Odds] load failed:", error?.message || error);
      }
    }

    docs.set(id, data);
    return data;
  }

  function scheduleSync(eventId) {
    const id = String(eventId);
    if (syncTimers.has(id)) return;
    syncTimers.set(
      id,
      window.setTimeout(() => {
        syncTimers.delete(id);
        void flushOdds(id);
      }, SYNC_MS)
    );
  }

  async function flushOdds(eventId) {
    const id = String(eventId);
    const data = docs.get(id);
    if (!data) return { ok: false, error: "no local doc" };

    const fields = toFirestoreFields(data);
    const mask = ["team1", "team2"].map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");

    try {
      let res = await firestoreRequest("PATCH", `${MATCHES}/${encodeURIComponent(id)}`, { fields }, mask);
      if (res === null) {
        res = await firestoreRequest(
          "POST",
          `${MATCHES}?documentId=${encodeURIComponent(id)}`,
          { fields }
        );
      }
      return { ok: true, eventId: id };
    } catch (error) {
      console.warn("[SpikeX Firebase Odds] save failed:", error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async function recordMatchOdds(focusedMatch) {
    if (!focusedMatch?.eventId || !focusedMatch?.runners?.length) {
      return { ok: false, error: "no focused match" };
    }

    const slots = resolveTeamSlots(focusedMatch.eventId, focusedMatch.runners);
    if (!slots) return { ok: false, error: "need two teams" };

    const data = await ensureDoc(focusedMatch.eventId);
    let changed = false;

    for (const runner of focusedMatch.runners) {
      const key = runnerKey(runner);
      let slot = null;
      if (key === slots.team1) slot = "team1";
      else if (key === slots.team2) slot = "team2";
      else continue;

      const back = runner.back != null ? Number(runner.back) : null;
      const lay = runner.lay != null ? Number(runner.lay) : null;
      if (pushSeries(data[slot].back, back)) changed = true;
      if (pushSeries(data[slot].lay, lay)) changed = true;
    }

    if (changed) scheduleSync(focusedMatch.eventId);
    return { ok: true, changed, eventId: String(focusedMatch.eventId) };
  }

  window.__spikexCloudOdds = {
    recordMatchOdds,
    flushOdds,
    getLocalOdds: (eventId) => docs.get(String(eventId)) || null
  };
})();
