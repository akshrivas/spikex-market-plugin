(() => {
  if (window.__spikexFirebaseResearch) return;

  /** Sync with firebase.config.js */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBsnbT-v6ZYi-ZqJA3feplWpDuhKYUHpl8",
    projectId: "spikex-11403"
  };

  const PROJECT_ID = FIREBASE_CONFIG.projectId;
  const API_KEY = FIREBASE_CONFIG.apiKey;
  const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const AUTH_SIGN_IN = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
  const AUTH_SIGN_UP = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;
  const AUTH_REFRESH = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;
  const AUTH_STORAGE_KEY = "spikexAuth";
  const ODDS_SNAPSHOT_MS = 30000;
  const GLOBAL_MATCHES = "matches";
  const GLOBAL_CONFIG_PATH = "spikex/config";
  /** Older builds wrote under spikex/{doc}/matches — keep reads only as fallback. */
  const LEGACY_GLOBAL_MATCH_PREFIXES = ["matches", "spikex/matches"];
  const DEFAULT_PAPER = Object.freeze({
    enabled: true,
    state: "FLAT",
    bankroll: 100000,
    startingBankroll: 100000,
    openTrade: null,
    matchBooks: {},
    paperTradeSeq: 0
  });

  const ensuredGlobalMatches = new Set();
  const ensuredUserMatches = new Set();
  let lastOddsSnapshotAt = 0;
  let lastOddsSnapshotMatchId = null;
  let sessionSaveTimer = null;
  let pendingSessionFields = {};
  let authChangeHandler = null;
  let lastCloudError = null;
  let lastUserCloudError = null;
  let cachedTelegramBotToken = "";

  const AUTH_ERROR_HINTS = {
    INVALID_LOGIN_CREDENTIALS: "Wrong email or password",
    INVALID_PASSWORD: "Wrong password",
    EMAIL_NOT_FOUND: "No account — use Sign Up first",
    EMAIL_EXISTS: "Email taken — Sign In instead",
    WEAK_PASSWORD: "Password too weak (min 6 characters)",
    OPERATION_NOT_ALLOWED: "Enable Email/Password in Firebase Console → Authentication",
    CONFIGURATION_NOT_FOUND: "Enable Email/Password in Firebase Console → Authentication",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts — wait and retry"
  };

  function formatAuthError(data) {
    const code = data?.error?.message || "";
    return AUTH_ERROR_HINTS[code] || code || "Authentication failed";
  }

  function setCloudError(message) {
    lastCloudError = message || null;
  }

  function setUserCloudError(message) {
    lastUserCloudError = message || null;
  }

  function getCloudError() {
    return lastUserCloudError || lastCloudError || null;
  }

  function clearCloudErrors() {
    lastCloudError = null;
    lastUserCloudError = null;
  }

  function parseFirestoreError(text) {
    if (!text) return "Firestore request failed";
    try {
      const json = JSON.parse(text);
      const status = json?.error?.status || "";
      if (status === "PERMISSION_DENIED") {
        return "Firestore rules blocked — allow spikex/matches + users/{uid} for signed-in user";
      }
      return json?.error?.message || text.slice(0, 120);
    } catch {
      return text.slice(0, 120);
    }
  }

  const authState = {
    uid: null,
    email: null,
    idToken: null,
    refreshToken: null,
    expiresAt: 0
  };

  const syncStatus = {
    state: "idle",
    pending: 0,
    lastOkAt: 0,
    lastErrAt: 0,
    lastPendingAt: 0,
    errCount: 0
  };

  function markSyncPending() {
    syncStatus.pending += 1;
    syncStatus.state = "sync";
    syncStatus.lastPendingAt = Date.now();
  }

  function markSyncOk() {
    syncStatus.pending = Math.max(0, syncStatus.pending - 1);
    syncStatus.lastOkAt = Date.now();
    if (syncStatus.pending === 0) syncStatus.state = "ok";
  }

  function markSyncErr() {
    syncStatus.pending = Math.max(0, syncStatus.pending - 1);
    syncStatus.lastErrAt = Date.now();
    syncStatus.errCount += 1;
    syncStatus.state = syncStatus.pending > 0 ? "sync" : "err";
  }

  function reconcileSyncStatus() {
    if (syncStatus.pending <= 0) return;
    const staleMs = Date.now() - (syncStatus.lastPendingAt || 0);
    if (staleMs > 45000) {
      syncStatus.pending = 0;
      syncStatus.state = "err";
      syncStatus.lastErrAt = Date.now();
    }
  }

  function getSyncStatus() {
    reconcileSyncStatus();
    return { ...syncStatus };
  }

  function logError(label, error) {
    console.warn(`[SpikeX Firebase] ${label}:`, error?.message || error);
  }

  function isAuthenticated() {
    return Boolean(authState.uid && authState.idToken);
  }

  function getAuthState() {
    return {
      uid: authState.uid,
      email: authState.email,
      isAuthenticated: isAuthenticated()
    };
  }

  function onAuthChange(handler) {
    authChangeHandler = handler;
  }

  function notifyAuthChange() {
    authChangeHandler?.(getAuthState());
  }

  function persistAuthSession() {
    if (!authState.refreshToken || !authState.email) return;
    try {
      sessionStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({
          refreshToken: authState.refreshToken,
          email: authState.email,
          uid: authState.uid
        })
      );
    } catch {
      /* ignore */
    }
  }

  function clearAuthSession() {
    try {
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function applyAuthTokens(data) {
    authState.uid = data.localId || data.user_id;
    authState.email = data.email || authState.email;
    authState.idToken = data.idToken || data.id_token;
    authState.refreshToken = data.refreshToken || data.refresh_token || authState.refreshToken;
    const expiresIn = Number(data.expiresIn || data.expires_in || 3600);
    authState.expiresAt = Date.now() + expiresIn * 1000;
    ensuredGlobalMatches.clear();
    ensuredUserMatches.clear();
    persistAuthSession();
    notifyAuthChange();
  }

  async function refreshIdToken(refreshToken) {
    const res = await fetch(AUTH_REFRESH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error?.message || "Token refresh failed");
    }
    applyAuthTokens(data);
    return authState;
  }

  async function ensureFreshToken() {
    if (!authState.refreshToken) return false;
    if (authState.idToken && Date.now() < authState.expiresAt - 60000) return true;
    try {
      await refreshIdToken(authState.refreshToken);
      return true;
    } catch (error) {
      logError("ensureFreshToken", error);
      return false;
    }
  }

  async function loadGlobalTelegramConfig() {
    try {
      const doc = await getDocument(GLOBAL_CONFIG_PATH, { publicAccess: true });
      if (!doc) {
        cachedTelegramBotToken = "";
        return { telegramBotToken: "" };
      }
      const raw = documentToObject(doc);
      cachedTelegramBotToken = String(raw.telegramBotToken || "").trim();
      return { telegramBotToken: cachedTelegramBotToken };
    } catch (error) {
      logError("loadGlobalTelegramConfig", error);
      return { telegramBotToken: cachedTelegramBotToken };
    }
  }

  function getTelegramBotToken() {
    return cachedTelegramBotToken;
  }

  function hasTelegramBotConfigured() {
    return Boolean(cachedTelegramBotToken);
  }

  async function initAuth() {
    void loadGlobalTelegramConfig();
    try {
      const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!saved?.refreshToken) return false;
      authState.email = saved.email || null;
      authState.uid = saved.uid || null;
      await refreshIdToken(saved.refreshToken);
      if (isAuthenticated()) {
        await initializeUserProfileIfNeeded();
      }
      return isAuthenticated();
    } catch (error) {
      clearAuthSession();
      logError("initAuth", error);
      return false;
    }
  }

  async function signIn(email, password) {
    const res = await fetch(AUTH_SIGN_IN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(formatAuthError(data));
    }
    setCloudError(null);
    clearCloudErrors();
    applyAuthTokens(data);
    await initializeUserProfileIfNeeded();
    return getAuthState();
  }

  async function signUp(email, password) {
    const res = await fetch(AUTH_SIGN_UP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(formatAuthError(data));
    }
    setCloudError(null);
    clearCloudErrors();
    applyAuthTokens(data);
    await initializeUserProfileIfNeeded();
    return getAuthState();
  }

  function signOut() {
    authState.uid = null;
    authState.email = null;
    authState.idToken = null;
    authState.refreshToken = null;
    authState.expiresAt = 0;
    ensuredGlobalMatches.clear();
    ensuredUserMatches.clear();
    clearCloudErrors();
    clearAuthSession();
    notifyAuthChange();
  }

  function globalMatchRoot(matchId, prefix = GLOBAL_MATCHES) {
    return `${prefix}/${encodeURIComponent(String(matchId))}`;
  }

  function userMatchRoot(matchId) {
    return `${userRoot()}/matches/${encodeURIComponent(String(matchId))}`;
  }

  function userRoot() {
    if (!authState.uid) throw new Error("Not authenticated");
    return `users/${encodeURIComponent(authState.uid)}`;
  }

  function matchRoot(matchId) {
    return globalMatchRoot(matchId);
  }

  function sessionDocPath() {
    return `${userRoot()}/profile/session`;
  }

  function toFirestoreValue(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { nullValue: null };
      if (Number.isInteger(value)) return { integerValue: String(value) };
      return { doubleValue: value };
    }
    if (typeof value === "string") return { stringValue: value };
    return { stringValue: String(value) };
  }

  function toFirestoreFields(obj) {
    const fields = {};
    for (const [key, value] of Object.entries(obj)) {
      fields[key] = toFirestoreValue(value);
    }
    return fields;
  }

  function fromFirestoreValue(value) {
    if (!value || typeof value !== "object") return null;
    if ("stringValue" in value) return value.stringValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return value.doubleValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("nullValue" in value) return null;
    if ("timestampValue" in value) return value.timestampValue;
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

  function parseJsonField(raw, fallback = null) {
    if (raw == null || raw === "") return fallback;
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async function firestorePublicRequest(method, path, body, extraQuery = "") {
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
      const message = parseFirestoreError(text) || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (json) setCloudError(null);
    return json;
  }

  async function firestoreRequest(method, path, body, extraQuery = "", retryAuth = true) {
    if (!isAuthenticated()) throw new Error("Not authenticated");
    const tokenOk = await ensureFreshToken();
    if (!tokenOk || !authState.idToken) {
      const err = new Error("Auth token expired — sign in again");
      setUserCloudError(err.message);
      throw err;
    }

    const q = extraQuery ? `${extraQuery}&key=${API_KEY}` : `key=${API_KEY}`;
    const url = `${BASE}/${path}?${q}`;
    const opts = {
      method,
      headers: { Authorization: `Bearer ${authState.idToken}` }
    };
    if (body != null && method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = parseFirestoreError(text) || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;

      if (res.status === 403 && retryAuth && authState.refreshToken) {
        try {
          await refreshIdToken(authState.refreshToken);
          return firestoreRequest(method, path, body, extraQuery, false);
        } catch (refreshErr) {
          logError("firestoreRequest refresh", refreshErr);
        }
      }

      if (res.status === 403) {
        setUserCloudError(message);
      }
      throw err;
    }
    setUserCloudError(null);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async function createDocument(path, fields, { publicAccess = false } = {}) {
    const req = publicAccess ? firestorePublicRequest : firestoreRequest;
    return req("POST", path, { fields });
  }

  async function patchDocument(path, fields, fieldPaths, { publicAccess = false } = {}) {
    const mask = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    const req = publicAccess ? firestorePublicRequest : firestoreRequest;
    return req("PATCH", path, { fields }, mask);
  }

  async function getDocument(path, { publicAccess = false } = {}) {
    const req = publicAccess ? firestorePublicRequest : firestoreRequest;
    return req("GET", path);
  }

  async function listAllDocuments(collectionPath, pageSize = 300, { publicAccess = false } = {}) {
    const req = publicAccess ? firestorePublicRequest : firestoreRequest;
    const docs = [];
    let pageToken = "";
    for (;;) {
      const extra = pageToken
        ? `pageSize=${pageSize}&pageToken=${encodeURIComponent(pageToken)}`
        : `pageSize=${pageSize}`;
      const res = await req("GET", collectionPath, null, extra);
      if (res?.documents?.length) docs.push(...res.documents);
      pageToken = res?.nextPageToken || "";
      if (!pageToken) break;
    }
    return docs;
  }

  function safeRunGlobal(label, fn) {
    try {
      markSyncPending();
      const result = fn();
      if (result && typeof result.then === "function") {
        let settled = false;
        const finish = (ok, error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (ok) markSyncOk();
          else {
            markSyncErr();
            logError(label, error);
          }
        };
        const timer = window.setTimeout(() => {
          finish(false, new Error(`${label} timed out`));
        }, 30000);
        result.then(() => finish(true)).catch((error) => finish(false, error));
      } else {
        markSyncOk();
      }
    } catch (error) {
      markSyncErr();
      logError(label, error);
    }
  }

  function safeRun(label, fn) {
    if (!isAuthenticated()) return;
    try {
      markSyncPending();
      const result = fn();
      if (result && typeof result.then === "function") {
        let settled = false;
        const finish = (ok, error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (ok) {
            markSyncOk();
            if (label === "saveSession") setUserCloudError(null);
          } else {
            markSyncErr();
            logError(label, error);
            if (label === "saveSession" && error?.status === 403) {
              setUserCloudError("Paper save denied — sign out and sign in again");
            }
          }
        };
        const timer = window.setTimeout(() => {
          finish(false, new Error(`${label} timed out`));
        }, 30000);
        result.then(() => finish(true)).catch((error) => finish(false, error));
      } else {
        markSyncOk();
      }
    } catch (error) {
      markSyncErr();
      logError(label, error);
    }
  }

  async function ensureSessionDoc() {
    const path = sessionDocPath();
    const fields = toFirestoreFields({ updatedAt: new Date().toISOString() });
    try {
      await createDocument(`${userRoot()}/profile?documentId=session`, fields);
    } catch (error) {
      if (error.status !== 409 && error.status !== 400) throw error;
    }
  }

  async function writeSessionFields(fields) {
    await ensureSessionDoc();
    const paths = Object.keys(fields);
    try {
      await patchDocument(sessionDocPath(), toFirestoreFields(fields), paths);
    } catch (error) {
      if (error.status === 404) {
        await createDocument(`${userRoot()}/profile?documentId=session`, toFirestoreFields(fields));
      } else {
        throw error;
      }
    }
  }

  function queueSessionSave(partial) {
    if (!isAuthenticated()) return;
    for (const [key, value] of Object.entries(partial)) {
      pendingSessionFields[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      const batch = { ...pendingSessionFields, updatedAt: new Date().toISOString() };
      pendingSessionFields = {};
      safeRun("saveSession", () => writeSessionFields(batch));
    }, 350);
  }

  function saveSessionPartial(partial) {
    queueSessionSave(partial);
  }

  function flushSessionSave() {
    if (!Object.keys(pendingSessionFields).length) return;
    const batch = { ...pendingSessionFields, updatedAt: new Date().toISOString() };
    pendingSessionFields = {};
    clearTimeout(sessionSaveTimer);
    safeRun("saveSession", () => writeSessionFields(batch));
  }

  async function initializeUserProfileIfNeeded() {
    if (!isAuthenticated()) return;
    await ensureFreshToken();

    const doc = await getDocument(sessionDocPath());
    if (!doc) {
      await writeSessionFields({
        paperData: JSON.stringify(DEFAULT_PAPER),
        updatedAt: new Date().toISOString()
      });
      return;
    }

    const raw = documentToObject(doc);
    if (!raw.paperData) {
      await patchDocument(
        sessionDocPath(),
        toFirestoreFields({
          paperData: JSON.stringify(DEFAULT_PAPER),
          updatedAt: new Date().toISOString()
        }),
        ["paperData", "updatedAt"]
      );
    }
  }

  async function loadSession() {
    if (!isAuthenticated()) return null;
    try {
      await ensureFreshToken();
      await initializeUserProfileIfNeeded();
      const doc = await getDocument(sessionDocPath());
      if (!doc) return null;
      const raw = documentToObject(doc);
      setUserCloudError(null);
      return {
        paper: parseJsonField(raw.paperData),
        telegram: parseJsonField(raw.telegramData),
        ui: parseJsonField(raw.uiData),
        bracketConfig: parseJsonField(raw.bracketConfigData),
        selectedRunnerKey: raw.selectedRunnerKey || null,
        updatedAt: raw.updatedAt || null
      };
    } catch (error) {
      logError("loadSession", error);
      if (error.status === 403) {
        setUserCloudError("Sign out and sign in again — session access denied");
      }
      throw error;
    }
  }

  async function ensureGlobalMatchDoc(matchId, matchName, sport) {
    const id = String(matchId);
    if (ensuredGlobalMatches.has(id)) return;

    const fields = toFirestoreFields({
      matchId: id,
      matchName: matchName || "",
      sport: sport || "",
      createdAt: new Date().toISOString()
    });

    try {
      await createDocument(`${GLOBAL_MATCHES}?documentId=${encodeURIComponent(id)}`, fields, {
        publicAccess: true
      });
    } catch (error) {
      if (error.status === 409 || error.status === 400) {
        await patchDocument(
          globalMatchRoot(id),
          toFirestoreFields({ matchName: matchName || "", sport: sport || "" }),
          ["matchName", "sport"],
          { publicAccess: true }
        );
      } else {
        throw error;
      }
    }

    ensuredGlobalMatches.add(id);
  }

  async function ensureUserMatchDoc(matchId, matchName, sport) {
    const id = String(matchId);
    const cacheKey = `${authState.uid}:${id}`;
    if (ensuredUserMatches.has(cacheKey)) return;

    const fields = toFirestoreFields({
      matchId: id,
      matchName: matchName || "",
      sport: sport || "",
      userId: authState.uid,
      createdAt: new Date().toISOString()
    });

    try {
      await createDocument(`${userRoot()}/matches?documentId=${encodeURIComponent(id)}`, fields);
    } catch (error) {
      if (error.status === 409 || error.status === 400) {
        await patchDocument(
          userMatchRoot(id),
          toFirestoreFields({ matchName: matchName || "", sport: sport || "" }),
          ["matchName", "sport"]
        );
      } else {
        throw error;
      }
    }

    ensuredUserMatches.add(cacheKey);
  }

  async function ensureMatchDoc(matchId, matchName, sport) {
    return ensureGlobalMatchDoc(matchId, matchName, sport);
  }

  async function saveMatchPaper(matchId, payload) {
    if (!isAuthenticated()) return;
    await ensureFreshToken();
    const id = String(matchId);
    await ensureUserMatchDoc(id, payload.matchName, payload.sport);
    await patchDocument(
      userMatchRoot(id),
      toFirestoreFields({
        paperData: JSON.stringify({
          trades: payload.trades || [],
          matchName: payload.matchName || "",
          updatedAt: new Date().toISOString()
        })
      }),
      ["paperData"]
    );
  }

  async function loadMatchPaper(matchId) {
    if (!isAuthenticated()) return null;
    try {
      await ensureFreshToken();
      const doc = await getDocument(userMatchRoot(String(matchId)));
      if (!doc) return null;
      const raw = documentToObject(doc);
      return parseJsonField(raw.paperData);
    } catch (error) {
      logError("loadMatchPaper", error);
      return null;
    }
  }

  function saveSignal(payload) {
    safeRunGlobal("saveSignal", () => {
      const matchId = String(payload.matchId || "");
      const signalId = String(payload.signalId || "");
      if (!matchId || !signalId) return null;

      return (async () => {
        await ensureGlobalMatchDoc(matchId, payload.matchName, payload.sport);
        const rowJson = JSON.stringify(payload.row || {});
        try {
          await createDocument(
            `${globalMatchRoot(matchId)}/signals?documentId=${encodeURIComponent(signalId)}`,
            toFirestoreFields({
              signalId,
              timestamp: new Date(payload.timestamp || Date.now()).toISOString(),
              rowJson
            }),
            { publicAccess: true }
          );
        } catch (error) {
          if (error.status === 409 || error.status === 400) {
            await patchDocument(
              `${globalMatchRoot(matchId)}/signals/${encodeURIComponent(signalId)}`,
              toFirestoreFields({
                timestamp: new Date(payload.timestamp || Date.now()).toISOString(),
                rowJson
              }),
              ["timestamp", "rowJson"],
              { publicAccess: true }
            );
          } else {
            throw error;
          }
        }
      })();
    });
  }

  function saveAlert(payload) {
    safeRunGlobal("saveAlert", () => {
      const matchId = String(payload.matchId || "");
      if (!matchId) return null;

      return (async () => {
        await ensureGlobalMatchDoc(matchId, payload.matchName, payload.sport);
        await createDocument(
          `${globalMatchRoot(matchId)}/alerts`,
          toFirestoreFields({
            timestamp: new Date(payload.timestamp || Date.now()).toISOString(),
            signalType: payload.signalType || "NONE",
            currentPrice: payload.currentPrice ?? null,
            oldestPrice: payload.oldestPrice ?? null,
            mem1: payload.mem1 ?? null,
            mem2: payload.mem2 ?? null,
            mem3: payload.mem3 ?? null,
            priceChangePct: payload.priceChangePct ?? null
          }),
          { publicAccess: true }
        );
      })();
    });
  }

  function saveTradeOpen(payload) {
    safeRun("saveTradeOpen", () => {
      const matchId = String(payload.matchId || "");
      const tradeId = String(payload.tradeId || "");
      if (!matchId || !tradeId) return null;

      return (async () => {
        await ensureUserMatchDoc(matchId, payload.matchName, payload.sport);
        await createDocument(
          `${userMatchRoot(matchId)}/trades?documentId=${encodeURIComponent(tradeId)}`,
          toFirestoreFields({
            tradeId,
            side: payload.side || "",
            runner: payload.runner || "",
            runnerKey: payload.runnerKey || "",
            matchName: payload.matchName || "",
            entryOdds: payload.entryOdds ?? null,
            targetOdds: payload.targetOdds ?? null,
            stopOdds: payload.stopOdds ?? null,
            stake: payload.stake ?? null,
            bankrollAtEntry: payload.bankrollAtEntry ?? null,
            signalRowId: payload.signalRowId || "",
            tradeJson: JSON.stringify(payload.trade || {}),
            exitOdds: null,
            pnl: null,
            status: "OPEN",
            exitReason: null,
            openedAt: new Date(payload.openedAt || Date.now()).toISOString(),
            closedAt: null
          })
        );
      })();
    });
  }

  function saveTradeClose(payload) {
    safeRun("saveTradeClose", () => {
      const matchId = String(payload.matchId || "");
      const tradeId = String(payload.tradeId || "");
      if (!matchId || !tradeId) return null;

      return (async () => {
        await ensureUserMatchDoc(matchId, payload.matchName, payload.sport);
        await patchDocument(
          `${userMatchRoot(matchId)}/trades/${encodeURIComponent(tradeId)}`,
          toFirestoreFields({
            exitOdds: payload.exitOdds ?? null,
            pnl: payload.pnl ?? null,
            status: payload.status || "CLOSED",
            exitReason: payload.exitReason || null,
            result: payload.status || "",
            tradeJson: JSON.stringify(payload.trade || {}),
            closedAt: new Date(payload.closedAt || Date.now()).toISOString()
          }),
          ["exitOdds", "pnl", "status", "exitReason", "result", "tradeJson", "closedAt"]
        );
      })();
    });
  }

  function saveOddsTick(payload) {
    safeRunGlobal("saveOddsTick", () => {
      const matchId = String(payload.matchId || "");
      if (!matchId) return null;

      return (async () => {
        await ensureGlobalMatchDoc(matchId, payload.matchName, payload.sport);
        await createDocument(
          `${globalMatchRoot(matchId)}/odds`,
          toFirestoreFields({
            kind: "tick",
            timestamp: new Date(payload.timestamp || Date.now()).toISOString(),
            selectionId: String(payload.selectionId || ""),
            selectionName: payload.selectionName || "",
            odds: payload.back ?? payload.odds ?? null,
            back: payload.back ?? null,
            lay: payload.lay ?? null,
            changedSide: payload.changedSide || null
          }),
          { publicAccess: true }
        );
      })();
    });
  }

  function maybeSaveOddsSnapshot(focusedMatch) {
    safeRunGlobal("saveOddsSnapshot", () => {
      if (!focusedMatch?.eventId || !focusedMatch.runners?.length) return null;

      const matchId = String(focusedMatch.eventId);
      const now = Date.now();
      if (matchId === lastOddsSnapshotMatchId && now - lastOddsSnapshotAt < ODDS_SNAPSHOT_MS) {
        return null;
      }
      lastOddsSnapshotAt = now;
      lastOddsSnapshotMatchId = matchId;

      return (async () => {
        await ensureGlobalMatchDoc(matchId, focusedMatch.eventName, focusedMatch.sportName);
        const ts = new Date(now).toISOString();
        const writes = focusedMatch.runners.map((runner) => {
          const selectionId = String(runner.runnerId || runner.runnerName || "");
          if (runner.back == null && runner.lay == null) return null;
          return createDocument(
            `${globalMatchRoot(matchId)}/odds`,
            toFirestoreFields({
              kind: "snapshot",
              timestamp: ts,
              selectionId,
              selectionName: runner.runnerName || "",
              odds: runner.back ?? null,
              back: runner.back ?? null,
              lay: runner.lay ?? null,
              changedSide: null
            }),
            { publicAccess: true }
          );
        });
        await Promise.allSettled(writes.filter(Boolean));
      })();
    });
  }

  function normalizeRunnerChartKey(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function runnerChartSlug(value) {
    return normalizeRunnerChartKey(value).replace(/\s+/g, "-");
  }

  function parseOddsDocs(docs, limitPerRunner) {
    const byRunner = {};

    function addPoint(key, at, back) {
      if (!key || back == null) return;
      if (!byRunner[key]) byRunner[key] = [];
      const points = byRunner[key];
      const last = points[points.length - 1];
      if (last && last.at === at && last.back === Number(back)) return;
      points.push({ at, back: Number(back) });
    }

    for (const doc of docs) {
      const row = documentToObject(doc);
      if (row.kind !== "tick" && row.kind !== "snapshot") continue;
      const selectionId = String(row.selectionId || "");
      const selectionName = String(row.selectionName || "").trim();
      const back = row.back ?? row.odds;
      if (!selectionId || back == null) continue;

      const at = Date.parse(row.timestamp) || Date.now();
      addPoint(selectionId, at, back);
      if (selectionName) {
        addPoint(normalizeRunnerChartKey(selectionName), at, back);
        addPoint(runnerChartSlug(selectionName), at, back);
      }
    }

    for (const key of Object.keys(byRunner)) {
      byRunner[key].sort((a, b) => a.at - b.at);
      if (byRunner[key].length > limitPerRunner) {
        byRunner[key] = byRunner[key].slice(-limitPerRunner);
      }
    }
    return byRunner;
  }

  async function loadOddsHistory(matchId, limitPerRunner = 50) {
    const id = String(matchId || "");
    if (!id) return {};

    for (const prefix of LEGACY_GLOBAL_MATCH_PREFIXES) {
      try {
        const docs = await listAllDocuments(`${globalMatchRoot(id, prefix)}/odds`, 400, {
          publicAccess: true
        });
        const byRunner = parseOddsDocs(docs, limitPerRunner);
        if (Object.keys(byRunner).length) return byRunner;
      } catch (error) {
        logError(`loadOddsHistory:${prefix}`, error);
      }
    }

    return {};
  }

  async function loadMatchSignals(matchId) {
    const id = String(matchId || "");
    if (!id) return [];

    for (const prefix of LEGACY_GLOBAL_MATCH_PREFIXES) {
      try {
        const docs = await listAllDocuments(`${globalMatchRoot(id, prefix)}/signals`, 500, {
          publicAccess: true
        });
        const rows = [];
        for (const doc of docs) {
          const row = documentToObject(doc);
          const parsed = parseJsonField(row.rowJson);
          if (parsed) rows.push(parsed);
        }
        if (rows.length) {
          rows.sort((a, b) => (a.at || 0) - (b.at || 0));
          return rows;
        }
      } catch (error) {
        logError(`loadMatchSignals:${prefix}`, error);
      }
    }

    return [];
  }

  function docIdFromName(name) {
    return String(name || "")
      .split("/")
      .pop()
      .split("?")[0];
  }

  function namesMatchHint(hint, eventName) {
    const h = String(hint || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const e = String(eventName || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!h || !e) return false;
    if (h.includes(e) || e.includes(h)) return true;

    const tokens = (value) =>
      value
        .split(/\s+v(?:s)?\.?\s+|\s+vs\s+/i)
        .flatMap((part) => part.split(/\s+/))
        .map((t) => t.replace(/^(cd|fc|sc|ac|cf|de|rc|sd|ud)\s+/i, ""))
        .filter((t) => t.length > 2);

    const hintTokens = tokens(h);
    const eventTokens = tokens(e);
    if (!hintTokens.length || !eventTokens.length) return false;

    let hits = 0;
    for (const token of eventTokens) {
      if (hintTokens.some((ht) => ht.includes(token) || token.includes(ht))) hits += 1;
    }
    return hits >= Math.min(2, eventTokens.length);
  }

  async function findMatchIdByHint(hint) {
    const needle = String(hint || "").trim();
    if (!needle) return null;

    try {
      const docs = await listAllDocuments(GLOBAL_MATCHES, 120, { publicAccess: true });
      let best = null;
      for (const doc of docs) {
        const raw = documentToObject(doc);
        const matchName = raw.matchName || "";
        const eventId = docIdFromName(doc.name);
        if (!eventId || !/^\d+$/.test(eventId)) continue;
        if (!namesMatchHint(needle, matchName)) continue;
        return { eventId, matchName: matchName || needle };
      }
      return best;
    } catch (error) {
      logError("findMatchIdByHint", error);
      return null;
    }
  }

  window.__spikexFirebaseResearch = {
    loadGlobalTelegramConfig,
    getTelegramBotToken,
    hasTelegramBotConfigured,
    initAuth,
    signIn,
    signUp,
    signOut,
    getAuthState,
    isAuthenticated,
    onAuthChange,
    saveAlert,
    saveSignal,
    saveTradeOpen,
    saveTradeClose,
    saveOddsTick,
    maybeSaveOddsSnapshot,
    saveMatchPaper,
    loadMatchPaper,
    getSyncStatus,
    getCloudError,
    saveSessionPartial,
    flushSessionSave,
    loadSession,
    loadOddsHistory,
    loadMatchSignals,
    findMatchIdByHint,
    ensureMatchDoc: (matchId, matchName, sport) =>
      safeRunGlobal("ensureMatchDoc", () => ensureGlobalMatchDoc(matchId, matchName, sport))
  };
})();
