(() => {
  if (window.__marketRadarLoaded) return;
  window.__marketRadarLoaded = true;

  if (window.top !== window.self) return;

  /** SpikeX Trading Bracket v1 — locked source of truth. Do not change outside bracket rules. */
  const BRACKET = Object.freeze({
    ID: "spikex-bracket-v1",
    VERSION: "1",
    LOCKED: true,
    PHILOSOPHY: "Bhaav Bhagwan Hai",
    MIN_ODDS: 2.5,
    MAX_ODDS: 8.0,
    MIN_SPIKE_CRICKET: 15,
    MIN_SPIKE_FOOTBALL: 20,
    STARTING_BANKROLL: 100000,
    POSITION_PCT: 0.25,
    MAX_OPEN_TRADES: 1,
    TARGET_PCT: 0.1,
    STOP_PCT: 0.05,
    MEMORY_DEPTH: 3,
    SPIKE_COOLDOWN_MS: 8000,
    MIN_CLOSED_TRADES: 100
  });

  /** Per-sport research brackets — shared bankroll/trade rules, sport-specific odds + spike. */
  const SPORT_BRACKETS = Object.freeze({
    cricket: Object.freeze({
      label: "Cricket",
      minOdds: 2.5,
      maxOdds: 8.0,
      minSpikePct: 15,
      note: "Discrete jumps (wickets, boundaries); mid-range odds zone"
    }),
    football: Object.freeze({
      label: "Football",
      minOdds: 2.5,
      maxOdds: 10.0,
      minSpikePct: 10,
      note: "Noisier flow; higher spike bar; draw/runners can sit 8–10"
    }),
    other: Object.freeze({
      label: "Other",
      minOdds: 2.5,
      maxOdds: 8.0,
      minSpikePct: 15,
      note: "Defaults to cricket profile"
    })
  });

  const PAPER_TRADING_ENABLED = false;
  const DEMO_TRADING_ENABLED = true;

  /** Gemini is optional (Expert panel). Auto spike path is rule-only — no API. */
  const GEMINI_ON_AUTO_SPIKE = false;
  const GEMINI_GATE_TRADES = false;
  const GEMINI_APPROVE_CLASSIFICATION = "EMOTIONAL_OVERREACTION";
  const GEMINI_MIN_APPROVE_CONFIDENCE = 0.75;

  const SPIKE_ALERT_TESTING = false;
  /** Mid-range odds only — longshots/favorites skip. */
  const ODDS_BRACKET_FILTER_ENABLED = true;
  const MEMORY_DEPTH = 3;
  const SPIKE_COOLDOWN_MS = 180000;
  const SPIKE_MIN_PCT = 20;
  /** Bigger than this is suspend/scrape junk (e.g. 187 → 3.05), not a trade. */
  const SPIKE_MAX_PCT = 40;
  const SANE_ODDS_MIN = 1.2;
  const SANE_ODDS_MAX = 20;
  const MAX_SIGNALS_PER_MATCH = 1;
  const MATCH_SIGNAL_GAP_MS = 300000;
  const TELEGRAM_DEMO_UPDATES = false;
  const TEST_MAX_OPEN_TRADES = 25;
  const ALERT_FLASH_MS = 6000;
  const TELEGRAM_STORAGE_KEY = "marketRadar.telegram";
  const TRADING_STORAGE_KEY = "marketRadar.trading";
  const PAPER_STORAGE_KEY = "marketRadar.paper";
  const VALIDATION_STORAGE_KEY = "marketRadar.validation";
  const ODDS_MEMORY_STORAGE_KEY = "marketRadar.oddsMemory";
  const UI_STORAGE_KEY = "marketRadar.ui";
  const BRACKET_CONFIG_STORAGE_KEY = "marketRadar.bracketConfig";
  const MAX_VALIDATION_ROWS = 1000;
  const ODDS_MEMORY_MAX_POINTS_PER_RUNNER = 3000;
  const ODDS_MEMORY_MAX_MATCHES = 10;
  const ODDS_MEMORY_SAVE_MS = 10000;

  function getTradeExitReason(result, options = {}) {
    if (options.manual) return "MANUAL";
    return result === "WIN" ? "TARGET" : "STOP";
  }

  const bracketConfigDefaults = {
    oddsFilterEnabled: ODDS_BRACKET_FILTER_ENABLED,
    overrideSportOdds: false,
    minOdds: BRACKET.MIN_ODDS,
    maxOdds: BRACKET.MAX_ODDS
  };

  let bracketConfig = { ...bracketConfigDefaults };

  const UI_PANEL_DEFAULTS = {
    bracket: true,
    paper: true,
    chart: true,
    live: true,
    validation: true,
    telegram: false,
    expert: false,
    minimized: false,
    consoleHeight: 400
  };

  const CHART_HISTORY_MAX = 50;
  const DEMO_TRADE_UPDATE_MIN_MS = 10000;
  const DEMO_TRADE_UPDATE_ODDS_EPS = 0.01;
  const DEMO_TRADE_UPDATE_HEARTBEAT_MS = 90000;

  const PAPER_STARTING_BANKROLL = BRACKET.STARTING_BANKROLL;
  const PAPER_POSITION_PCT = BRACKET.POSITION_PCT;
  /** ~12% odds move ≈ 10–15% on stake (BACK: entry/exit−1). */
  const PAPER_TARGET_PCT = 0.12;
  const PAPER_STOP_PCT = 0.06;

  const settings = {
    telegramAlertsEnabled: true,
    telegramBotToken: "",
    telegramChatId: ""
  };

  const tradingSettings = {
    autoTradingEnabled: true
  };

  const paper = {
    enabled: true,
    state: "FLAT",
    bankroll: PAPER_STARTING_BANKROLL,
    startingBankroll: PAPER_STARTING_BANKROLL,
    openTrade: null,
    openTrades: [],
    matchBooks: {}
  };
  let paperTradeSeq = 0;
  let paperReady = true;
  let paperSessionMutated = false;
  let paperCloudSaveTimer = null;
  const demoTradeUpdateState = new Map();

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!chrome.storage?.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(data) {
    return new Promise((resolve) => {
      if (!chrome.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set(data, resolve);
    });
  }

  function hasTelegramConfigured() {
    return Boolean(settings.telegramBotToken.trim() && parseTelegramChatIds(settings.telegramChatId).length);
  }

  async function ensureTelegramConfigured() {
    if (hasTelegramConfigured()) return true;
    try {
      await loadTelegramSettings();
    } catch (error) {
      console.warn("[SpikeX Telegram] config reload failed:", error?.message || error);
    }
    return hasTelegramConfigured();
  }

  async function sendTelegramAlert(text, context = "alert") {
    if (!settings.telegramAlertsEnabled) {
      console.log("[SpikeX Telegram] skipped (alerts off):", context);
      return { ok: false, skipped: true, reason: "alerts off" };
    }

    await ensureTelegramConfigured();
    if (!hasTelegramConfigured()) {
      telegramStatus = "Need bot token & chat ID";
      panelApi?.updateTelegramStatusUi?.();
      console.warn("[SpikeX Telegram] not configured:", context);
      return { ok: false, reason: "not configured" };
    }

    console.log("[SpikeX Telegram] sending:", context);
    let ok = await sendTelegramMessage(text);
    if (!ok) {
      await ensureTelegramConfigured();
      ok = await sendTelegramMessage(text);
    }
    if (!ok) {
      console.warn("[SpikeX Telegram] send failed:", context, telegramStatus);
    } else {
      console.log("[SpikeX Telegram] sent:", context);
    }
    return { ok, status: telegramStatus };
  }

  function normalizeTelegramToken(token) {
    return String(token || "").trim();
  }

  function normalizeTelegramChatId(chatId) {
    const raw = String(chatId || "").trim();
    if (!raw) return "";
    if (/^-?\d{6,}$/.test(raw)) return raw;
    return "";
  }

  function parseTelegramChatIds(raw) {
    const ids = [];
    const seen = new Set();
    const normalized = String(raw || "")
      .replace(/[\n\r;]+/g, ",")
      .split(",");

    for (const part of normalized) {
      const token = part.trim();
      if (!token) continue;
      const id = normalizeTelegramChatId(token);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    return ids;
  }

  function mergeTelegramChatIds(...sources) {
    const merged = [];
    const seen = new Set();
    for (const raw of sources) {
      for (const id of parseTelegramChatIds(raw)) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
      }
    }
    return merged.join(", ");
  }

  function cloudConfigApi() {
    return window.__spikexCloudConfig || window.__spikexTelegramConfig || null;
  }

  function cloudOddsApi() {
    return window.__spikexCloudOdds || null;
  }

  function geminiReviewApi() {
    return window.__spikexGeminiReview || null;
  }

  function isValidTelegramToken(token) {
    return /^\d+:[A-Za-z0-9_-]{20,}$/.test(String(token || "").trim());
  }

  function pickTelegramToken(...sources) {
    const normalized = sources.map((s) => normalizeTelegramToken(s)).filter(Boolean);
    for (const token of normalized) {
      if (isValidTelegramToken(token)) return token;
    }
    return normalized[0] || "";
  }

  function telegramTokenFormatHint() {
    return "Use BotFather token — e.g. 123456789:ABCdefGHIjklMNOpqrsTUVwxyz";
  }

  function formatTelegramApiError(data, status) {
    const desc = String(data?.description || data?.error_code || "").trim();
    if (!desc) return `HTTP ${status}`;
    if (/unauthorized/i.test(desc)) return "Invalid bot token";
    if (/chat not found/i.test(desc)) return "Chat ID not found — send /start to your bot first";
    if (/bot was blocked/i.test(desc)) return "Bot blocked — unblock in Telegram";
    if (/can't initiate/i.test(desc)) return "Start your bot in Telegram first (/start)";
    return desc;
  }

  function telegramStatusLabel() {
    if (!settings.telegramBotToken.trim()) return "Enter bot token";
    if (!isValidTelegramToken(settings.telegramBotToken)) return "Invalid token format";
    if (!parseTelegramChatIds(settings.telegramChatId).length) return "Enter chat ID(s)";
    if (!settings.telegramAlertsEnabled) return "Alerts off";
    return telegramStatus || "Ready";
  }

  function normalizeOdds(price) {
    if (price == null || price === "") return null;
    const n = Number(price);
    return Number.isFinite(n) ? n : null;
  }

  function isSaneMatchOdds(price) {
    const p = normalizeOdds(price);
    return p != null && p >= SANE_ODDS_MIN && p <= SANE_ODDS_MAX;
  }

  function resolveSportKind(sportName, sportId) {
    const name = String(sportName || "").toLowerCase();
    const id = String(sportId || "");
    if (id === "4" || name.includes("cricket")) return "cricket";
    if (id === "1" || name.includes("football") || name.includes("soccer")) return "football";
    return "other";
  }

  function getSportBracket(sportName, sportId) {
    const kind = resolveSportKind(sportName, sportId);
    return SPORT_BRACKETS[kind] || SPORT_BRACKETS.cricket;
  }

  function demoTrader() {
    return window.__spikexDemoTrader || null;
  }

  function isAutoTradingEnabled() {
    return tradingSettings.autoTradingEnabled !== false;
  }

  async function saveTradingSettings() {
    await storageSet({
      [TRADING_STORAGE_KEY]: {
        autoTradingEnabled: tradingSettings.autoTradingEnabled
      }
    });
  }

  function applyTradingSettings(saved) {
    if (!saved) return;
    tradingSettings.autoTradingEnabled = saved.autoTradingEnabled !== false;
  }

  async function loadTradingSettings() {
    const data = await storageGet(TRADING_STORAGE_KEY);
    applyTradingSettings(data[TRADING_STORAGE_KEY]);
  }

  function getMinSpikePct() {
    return SPIKE_MIN_PCT;
  }

  function getOddsLimits(sportName, sportId) {
    if (!bracketConfig.oddsFilterEnabled) return null;
    if (bracketConfig.overrideSportOdds) {
      return { minOdds: bracketConfig.minOdds, maxOdds: bracketConfig.maxOdds };
    }
    const sport = getSportBracket(sportName, sportId);
    return { minOdds: sport.minOdds, maxOdds: sport.maxOdds };
  }

  function isPriceInBracket(price, sportName, sportId) {
    const p = normalizeOdds(price);
    if (p == null || p < 1.01) return false;
    if (SPIKE_ALERT_TESTING) return true;
    const limits = getOddsLimits(sportName, sportId);
    if (!limits) return true;
    return p >= limits.minOdds && p <= limits.maxOdds;
  }

  function getOddsBracketLabel(sportName, sportId) {
    if (!bracketConfig.oddsFilterEnabled) return "off (testing)";
    if (bracketConfig.overrideSportOdds) {
      return `override ${bracketConfig.minOdds}–${bracketConfig.maxOdds}`;
    }
    const sport = getSportBracket(sportName, sportId);
    return `${sport.minOdds}–${sport.maxOdds}`;
  }

  function runnerInBracket(runner, sportName, sportId) {
    if (SPIKE_ALERT_TESTING) {
      return normalizeOdds(runner.back) != null || normalizeOdds(runner.lay) != null;
    }
    if (isPriceInBracket(runner.back, sportName, sportId)) return true;
    if (isPriceInBracket(runner.lay, sportName, sportId)) return true;
    return false;
  }

  function countRunnersInBracket(focusedMatch) {
    if (!focusedMatch?.runners?.length) return 0;
    return focusedMatch.runners.filter((runner) =>
      runnerInBracket(runner, focusedMatch.sportName, focusedMatch.sportId)
    ).length;
  }

  async function saveBracketConfig() {
    await storageSet({ [BRACKET_CONFIG_STORAGE_KEY]: { ...bracketConfig } });
  }

  async function loadBracketConfig() {
    const data = await storageGet(BRACKET_CONFIG_STORAGE_KEY);
    const saved = data[BRACKET_CONFIG_STORAGE_KEY];
    if (saved) applyBracketConfigFromSession(saved);
  }

  function countAllValidationSignals() {
    let total = 0;
    for (const match of Object.values(validationStore.matches)) {
      total += match.rows?.length || 0;
    }
    return total;
  }

  function getBracketMetrics() {
    const stats = getPaperStats();
    const closedTrades = stats.totalTrades;
    return {
      ...stats,
      signalCount: countAllValidationSignals(),
      tradeCount: closedTrades + stats.openCount,
      strategyLocked: closedTrades < BRACKET.MIN_CLOSED_TRADES,
      tradesUntilUnlock: Math.max(0, BRACKET.MIN_CLOSED_TRADES - closedTrades)
    };
  }

  /** Locked v1 direction hypothesis — research only; statistics decide after 100 trades. */
  function bracketTradeHypothesis(delta) {
    if (delta == null || delta === 0) return null;
    return delta > 0 ? "BACK" : "LAY";
  }

  const validationStore = {
    matches: {}
  };
  let validationSeq = 0;

  /** Tab-local match context — never persisted; each tab tracks its own detail page. */
  let tabMatchContext = { eventId: null, matchName: null };
  let detailResolveTimer = null;

  function isSyntheticEventId(eventId) {
    const id = String(eventId || "");
    return !id || id.startsWith("dom-") || id.startsWith("live-") || !/^\d+$/.test(id);
  }

  function canonicalMatchKey(fmOrRunners, eventIdFallback = "") {
    const runners = Array.isArray(fmOrRunners) ? fmOrRunners : fmOrRunners?.runners;
    if (runners?.length) {
      const names = sanitizeRunners(runners)
        .map((r) => normalizeChartKey(r.runnerName))
        .filter((n) => n && !/^draw$/i.test(n))
        .sort();
      if (names.length >= 2) return names.join("|");
    }
    return String(eventIdFallback || fmOrRunners?.eventId || "");
  }

  function stableSyntheticEventId(runners, matchName) {
    const names = sanitizeRunners(runners)
      .map((r) => normalizeChartKey(r.runnerName))
      .filter((n) => n && !/^draw$/i.test(n))
      .sort();
    if (names.length >= 2) {
      return `live-${names[0]}-v-${names[1]}`.slice(0, 48);
    }
    return `live-${String(matchName || "match")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .slice(0, 36)}`;
  }

  function getPageMatchHintFromDom() {
    const parts = [
      document.title,
      document.querySelector("h1")?.textContent,
      document.querySelector("h2")?.textContent
    ];
    const bodyHead = (document.body?.innerText || "").slice(0, 8000);
    const vsLine = bodyHead.match(/[^\n]{4,80}\s+v(?:s)?\.?\s[^\n]{4,80}/i);
    if (vsLine) parts.push(vsLine[0]);

    const skip = /^(back|lay|matched|susp|lock|the draw|draw|—|-|\d+\.?\d*)$/i;
    const oddsRe = /^\d+(?:\.\d{1,2})?$/;
    for (const row of document.querySelectorAll("tr, [role='row']")) {
      const prices = [...row.querySelectorAll("button, span, td, div")]
        .map((el) => (el.textContent || "").trim())
        .filter((text) => oddsRe.test(text));
      if (prices.length < 2) continue;
      const label = (
        row.querySelector("td:first-child, th:first-child, [class*='runner'], [class*='team']")
          ?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!label || label.length > 55 || skip.test(label)) continue;
      parts.push(label);
      if (parts.filter((p) => p && p.length > 4).length >= 3) break;
    }

    const teams = parts.filter(Boolean);
    if (teams.length >= 2 && !/\sv/i.test(teams.join(" "))) {
      const names = teams.slice(-2);
      parts.push(`${names[0]} v ${names[1]}`);
    }
    return parts.filter(Boolean).join(" ").slice(0, 600);
  }

  function oddsDetect() {
    return globalThis.__spikexOddsDetect || null;
  }

  function scrapeRunnersFromDomInContentScript() {
    if (!isOnMatchDetailPage()) return [];

    const scrapeRoot =
      oddsDetect()?.appScrapeRoot?.() || document.getElementById("root") || document;
    const shared = oddsDetect()?.scrapeRunnersFromDom(scrapeRoot);
    if (shared?.length) return shared;

    const oddsRe = /^\d+(?:\.\d{1,2})?$/;
    const skipNames = /^(back|lay|matched|susp|lock|—|-)$/i;
    const runners = [];
    const seen = new Set();

    function tryRow(row) {
      const prices = [...row.querySelectorAll("button, span, td, div")]
        .map((el) => (el.textContent || "").trim())
        .filter((text) => oddsRe.test(text))
        .map(Number)
        .filter((n) => n >= 1.01 && n <= 1000);
      if (!prices.length) return;

      let name = (
        row.querySelector(
          "td:first-child, th:first-child, [class*='runner'], [class*='Runner'], [class*='team'], [class*='Team']"
        )?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      if (!name || skipNames.test(name) || name.length > 55) {
        const text = (row.textContent || "").replace(/\s+/g, " ").trim();
        name = text.replace(/\d+(?:\.\d+)?/g, " ").replace(/\s+/g, " ").trim().split(/\s{2,}/)[0] || "";
      }

      if (!name || skipNames.test(name) || name.length > 55 || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      const back = prices[0];
      const lay = prices[prices.length - 1];
      runners.push({
        runnerId: name.toLowerCase().replace(/\s+/g, "-"),
        runnerName: name,
        back,
        lay,
        backText: back != null ? back.toFixed(2) : "—",
        layText: lay != null ? lay.toFixed(2) : "—",
        suspended: false,
        runnerStatus: null
      });
    }

    for (const row of document.querySelectorAll("tr, [role='row'], [class*='runner-row'], [class*='RunnerRow']")) {
      tryRow(row);
    }

    if (!runners.length) {
      for (const el of document.querySelectorAll("[class*='runner'], [class*='Runner'], li")) {
        if (el.querySelectorAll("button, span, td, div").length < 2) continue;
        tryRow(el);
      }
    }

    return runners;
  }

  function isOnMatchDetailPage() {
    const od = oddsDetect();
    if (od) return od.isOddsDetailPage(null);
    return /MATCH\s*ODDS/i.test(document.body?.innerText?.slice(0, 12000) || "");
  }

  const BLOCKED_RUNNER_NAMES =
    /^(signals|trades|matches|research|paper|charts|odds|validation|telegram|live|sport|open|spike|memory)$/i;

  function isBlockedRunnerName(name) {
    return BLOCKED_RUNNER_NAMES.test(String(name || "").trim());
  }

  function sanitizeRunners(runners) {
    return (runners || []).filter((r) => r?.runnerName && !isBlockedRunnerName(r.runnerName));
  }

  function buildMatchNameFromRunners(runners) {
    const teams = sanitizeRunners(runners).filter((r) => !/the draw|^draw$/i.test(r.runnerName));
    if (teams.length >= 2) return `${teams[0].runnerName} v ${teams[1].runnerName}`;
    return getPageMatchHintFromDom() || teams[0]?.runnerName || "Live match";
  }

  function hasUsableFocusedMatch(fm) {
    return Boolean(fm?.runners?.length);
  }

  function isReduxFocusedMatch(fm) {
    const source = String(fm?.source || "");
    return source !== "live-page" && source !== "dom";
  }

  function sportFromPagePath() {
    const path = (location.pathname || "").toLowerCase();
    if (path.includes("/cricket")) return { sportId: "4", sportName: "Cricket" };
    if (path.includes("/football") || path.includes("/soccer")) return { sportId: "1", sportName: "Football" };
    if (path.includes("/tennis")) return { sportId: "2", sportName: "Tennis" };
    return null;
  }

  function detectSportFromPage() {
    const fromPath = sportFromPagePath();
    if (fromPath) return fromPath;

    const text = `${document.title || ""} ${document.body?.innerText || ""}`.slice(0, 12000).toLowerCase();
    if (/fifa|football|soccer|world cup|premier league|uefa|champions league|la liga|serie a/.test(text)) {
      return { sportId: "1", sportName: "Football" };
    }
    if (/cricket|ipl|t20|vitality blast|ashes|bbl/.test(text)) {
      return { sportId: "4", sportName: "Cricket" };
    }
    if (/tennis|wimbledon|atp|wta|us open|roland garros/.test(text)) {
      return { sportId: "2", sportName: "Tennis" };
    }
    return { sportId: "4", sportName: "Cricket" };
  }

  function scrapeCompetitionFromPage() {
    const body = (document.body?.innerText || "").slice(0, 15000);
    const patterns = [
      /FIFA\s+World\s+Cup(?:\s+\d{4})?/i,
      /Vitality\s+Blast/i,
      /Indian\s+Premier\s+League/i,
      /\bIPL\b/,
      /Premier\s+League/i,
      /UEFA[^\n]{0,50}/i,
      /Champions\s+League/i
    ];
    for (const re of patterns) {
      const match = body.match(re);
      if (match) return match[0].trim().slice(0, 80);
    }
    return "";
  }

  /** Live score / status lines from the Cricway page for Gemini matchContext. */
  function scrapeLiveMatchContextFromPage() {
    if (!isOnMatchDetailPage()) return "";

    const chunks = [];
    const selectors = [
      '[class*="scorecard" i]',
      '[class*="Scorecard" i]',
      '[class*="score-board" i]',
      '[class*="scoreBoard" i]',
      '[class*="live-score" i]',
      '[class*="LiveScore" i]',
      '[class*="match-info" i]',
      '[class*="MatchInfo" i]'
    ];

    const isFancyMarketLine = (line) =>
      /\b(?:over\s+runs?|odd\s*even|last\s*digit|run\s*bhav|fall\s*of\s*wicket|session|fancy|bookmaker|tied\s*match|completed\s*match|toss|boundary\s*bhav)\b/i.test(
        line
      ) ||
      /^\d+\s*over\b/i.test(line) ||
      /\b(?:PB|PG|TSK|MINY)\b.+\b(?:over|runs?|digit|bhav)\b/i.test(line);

    const isScoreSituationLine = (line) => {
      if (isFancyMarketLine(line)) return false;
      if (/\d+\s*\/\s*\d+(?:\s*[\(-]\s*\d+(?:\.\d+)?\s*(?:ov|overs?)?|\s+in\s+\d)/i.test(line)) {
        return true;
      }
      if (/\b(?:CRR|RRR)\b\s*:?\s*\d+(?:\.\d+)?/i.test(line)) return true;
      if (/\b(?:current|required)\s+run\s*rate\b/i.test(line)) return true;
      if (/\bneed[s]?\s+\d+\s+runs?\s+off\s+\d+/i.test(line)) return true;
      if (/\brequire[sd]?\s+\d+\s+(?:runs?\s+)?(?:from|off|in)\b/i.test(line)) return true;
      if (/\btarget\s*:?\s*\d{2,4}\b/i.test(line)) return true;
      if (/\bpartnership\b.{0,20}\d+/i.test(line)) return true;
      if (/\byet\s+to\s+bat\b|\binnings\s+break\b|\bbatting\b.{0,30}\bbowling\b/i.test(line)) {
        return true;
      }
      if (line.length <= 40 && /\b(?:HT|FT|ET)\b/.test(line) && /\d+\s*[-:]\s*\d+/.test(line)) {
        return true;
      }
      return false;
    };

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("#market-radar-panel")) continue;
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length >= 8 && text.length <= 500 && isScoreSituationLine(text)) {
          chunks.push(text);
        }
      }
    }

    const body = (document.body?.innerText || "").slice(0, 30000);
    const lines = body
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const skip =
      /^(back|lay|matched|cash\s*out|loss\s*cut|deposit|withdraw|my bets|signals|trades|research|telegram|spike|gemini|odds|charts|validation|expert|alerts|manual|auto|1-click)/i;

    for (const line of lines) {
      if (line.length < 6 || line.length > 200) continue;
      if (skip.test(line)) continue;
      if (isScoreSituationLine(line)) chunks.push(line);
    }

    const seen = new Set();
    const out = [];
    for (const chunk of chunks) {
      const key = chunk.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(chunk);
      if (out.join(" | ").length >= 900) break;
    }

    return out.join(" | ").slice(0, 1000);
  }

  function firstDefined(...vals) {
    for (const v of vals) {
      if (v == null || v === "") continue;
      return v;
    }
    return null;
  }

  function numOrNull(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function pickScorecardField(obj, keys) {
    if (!obj || typeof obj !== "object") return null;
    for (const key of keys) {
      if (obj[key] != null && obj[key] !== "") return obj[key];
    }
    const lower = Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [String(k).toLowerCase(), v])
    );
    for (const key of keys) {
      const hit = lower[String(key).toLowerCase()];
      if (hit != null && hit !== "") return hit;
    }
    return null;
  }

  function decodeHtmlEntities(text) {
    return String(text || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseScoreToken(text) {
    const m = String(text || "").match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return { score: `${m[1]}/${m[2]}`, runs: Number(m[1]), wickets: Number(m[2]) };
  }

  function parseOverToken(text) {
    const m = String(text || "").match(/\((\d+(?:\.\d+)?)\)/);
    return m ? m[1] : null;
  }

  function parseCrrToken(text) {
    const m = String(text || "").match(/\bCRR\b\s*:?\s*(\d+(?:\.\d+)?)/i);
    return m ? Number(m[1]) : null;
  }

  function parseBallEvents(overLabel, balls) {
    const over = String(overLabel || "").replace(/^over\s+/i, "").trim();
    return (balls || []).map((raw, i) => {
      const token = String(raw || "").trim().toUpperCase();
      let event = token;
      if (token === "W" || token === "WKT" || token === "OUT") event = "WICKET";
      else if (token === "4") event = "FOUR";
      else if (token === "6") event = "SIX";
      else if (token === "WD" || token === "NB" || token === "LB" || token === "B") event = token;
      return { ball: over ? `${over}.${i + 1}` : String(i + 1), event };
    });
  }

  function cleanPlayerName(text) {
    let name = decodeHtmlEntities(text);
    name = name
      .replace(/\.cls-[\w-]+\s*\{[\s\S]*?\}/g, " ")
      .replace(/\{[^}]*fill[^}]*\}/g, " ")
      .replace(/\bcls-\w+\b/gi, " ")
      .replace(/#[0-9a-f]{3,8}/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const parts = name
      .split(/[^A-Za-z.'-]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 1 && !/^(cls|svg|none|fill)$/i.test(p));
    name = parts.join(" ").trim();
    if (!name || name.length < 3) return "";
    return name;
  }

  function cellPlayerName(td) {
    if (!td) return "";
    const clone = td.cloneNode(true);
    for (const el of clone.querySelectorAll("style, script, svg, defs")) el.remove();
    return cleanPlayerName(clone.textContent || "") || cleanPlayerName(td.textContent || "");
  }

  function parseCricwayScorecardHtml(html) {
    const raw = String(html || "");
    if (!/sc_cw-main-container|Cricket Scoreboard/i.test(raw)) return null;

    let doc = null;
    try {
      doc = new DOMParser().parseFromString(raw, "text/html");
    } catch {
      doc = null;
    }

    const textOf = (root, sel) => {
      if (!root) return "";
      const el = root.querySelector(sel);
      return decodeHtmlEntities(el?.textContent || "");
    };

    const desktop = doc?.querySelector(".sc_cw-header-desktop") || doc?.body || null;
    const leftName = textOf(desktop, ".sc_cw-header-score-container-left-desktop")
      ? decodeHtmlEntities(
          desktop.querySelector(".sc_cw-header-grid-row-desktop .sc_cw-header-team-name-desktop")
            ?.textContent || ""
        )
      : "";
    const names = [...(desktop?.querySelectorAll(".sc_cw-header-team-name-desktop") || [])].map((el) =>
      decodeHtmlEntities(el.textContent)
    );
    const teamLeft = names[0] || leftName || null;
    const teamRight = names[1] || null;

    const leftBlock = decodeHtmlEntities(
      desktop?.querySelector(".sc_cw-header-score-container-left-desktop")?.textContent || ""
    );
    const rightBlock = decodeHtmlEntities(
      desktop?.querySelector(".sc_cw-header-score-container-right-desktop")?.textContent || ""
    );

    const leftScore = parseScoreToken(leftBlock);
    const rightScore = parseScoreToken(rightBlock);
    const leftOvers = parseOverToken(leftBlock);
    const rightOvers = parseOverToken(rightBlock);
    const leftCrr = parseCrrToken(leftBlock);
    const rightCrr = parseCrrToken(rightBlock);

    const comment =
      textOf(desktop, ".sc_cw-header-primary-comment-desktop") ||
      textOf(doc, ".sc_cw-header-primary-comment-mobile");
    const statusLine =
      textOf(desktop, ".sc_cs-header-target-desktop") ||
      textOf(doc, ".sc_cs-header-target-mobile");

    const partnership = decodeHtmlEntities(
      doc?.querySelector(".sc_cw-info-section-desktop .sc_cw-info-part-desktop")?.textContent || ""
    );
    let lastWicket = "";
    for (const el of doc?.querySelectorAll(".sc_cw-info-section-desktop .sc_cw-info-part-desktop") || []) {
      const t = decodeHtmlEntities(el.textContent);
      if (/last\s*wicket/i.test(t)) lastWicket = t.replace(/^last\s*wicket:\s*/i, "");
    }

    const overBlocks = [...(doc?.querySelectorAll(".sc_cw-over-desktop .sc_cw-current-over-desktop") || [])];
    const oversParsed = overBlocks.map((block) => {
      const label = decodeHtmlEntities(block.querySelector(".sc_cw-over-part-name-desktop")?.textContent || "");
      const balls = [...block.querySelectorAll(".sc_cw-over-part-balls")].map((el) =>
        decodeHtmlEntities(el.textContent)
      );
      return { label, balls };
    });
    const currentOver = oversParsed[0] || null;
    const previousOver = oversParsed[1] || null;
    const lastOverRuns = previousOver
      ? previousOver.balls.reduce((sum, b) => {
          const n = Number(String(b).replace(/[^\d]/g, ""));
          return sum + (Number.isFinite(n) ? n : 0);
        }, 0)
      : null;

    const batsmen = [];
    for (const table of doc?.querySelectorAll(".sc_cw-table-desktop table") || []) {
      const header = decodeHtmlEntities(table.querySelector("thead th")?.textContent || "");
      if (!/^batsmen$/i.test(header)) continue;
      for (const row of table.querySelectorAll("tbody tr")) {
        const tds = [...row.querySelectorAll(":scope > td")];
        const name = cellPlayerName(tds[0]);
        if (!name) continue;
        batsmen.push({
          name,
          runs: numOrNull(tds[1]?.textContent),
          balls: numOrNull(tds[2]?.textContent),
          fours: numOrNull(tds[3]?.textContent),
          sixes: numOrNull(tds[4]?.textContent),
          strikeRate: numOrNull(tds[5]?.textContent)
        });
      }
    }

    let bowler = null;
    for (const table of doc?.querySelectorAll(".sc_cw-table-desktop table") || []) {
      const header = decodeHtmlEntities(table.querySelector("thead th")?.textContent || "");
      if (!/^bowler$/i.test(header)) continue;
      const tds = [...(table.querySelector("tbody tr")?.querySelectorAll(":scope > td") || [])];
      const name = cellPlayerName(tds[0]);
      if (!name) continue;
      bowler = {
        name,
        overs: decodeHtmlEntities(tds[1]?.textContent || "") || null,
        runs: numOrNull(tds[2]?.textContent),
        maidens: numOrNull(tds[3]?.textContent),
        wickets: numOrNull(tds[4]?.textContent),
        economy: numOrNull(tds[5]?.textContent)
      };
      break;
    }

    const rightAllOut = rightScore?.wickets === 10;
    const leftAllOut = leftScore?.wickets === 10;
    let battingTeam = teamRight;
    let bowlingTeam = teamLeft;
    let battingScore = rightScore;
    let battingOvers = rightOvers;
    let battingCrr = rightCrr;
    if (rightAllOut && !leftAllOut) {
      battingTeam = teamLeft;
      bowlingTeam = teamRight;
      battingScore = leftScore;
      battingOvers = leftOvers;
      battingCrr = leftCrr;
    } else if (!rightAllOut && leftAllOut) {
      battingTeam = teamRight;
      bowlingTeam = teamLeft;
      battingScore = rightScore;
      battingOvers = rightOvers;
      battingCrr = rightCrr;
    }

    const leadMatch = statusLine.match(/\b(lead|trail)s?\s+by\s+(\d+)\s+runs?/i);
    const needMatch = statusLine.match(/\bneed[s]?\s+(\d+)\s+runs?\b/i);
    const targetMatch = statusLine.match(/\btarget\s*:?\s*(\d{2,4})\b/i);

    const recentEvents = [
      ...parseBallEvents(previousOver?.label, previousOver?.balls || []),
      ...parseBallEvents(currentOver?.label, currentOver?.balls || [])
    ].slice(-12);

    return {
      innings: leftAllOut || rightAllOut ? 2 : 1,
      battingTeam: battingTeam || null,
      bowlingTeam: bowlingTeam || null,
      score: battingScore?.score || null,
      overs: battingOvers || null,
      target: targetMatch ? Number(targetMatch[1]) : null,
      runsRequired: needMatch ? Number(needMatch[1]) : null,
      ballsRemaining: null,
      currentRunRate: battingCrr,
      requiredRunRate: parseCrrToken(statusLine.replace(/CRR/i, "RRR")) || null,
      wicketsInHand:
        battingScore && battingScore.wickets != null ? Math.max(0, 10 - battingScore.wickets) : null,
      lastOverRuns,
      recentEvents: recentEvents.length ? recentEvents : null,
      lastBall: comment || null,
      status: statusLine || null,
      partnership: partnership.replace(/^partnership:\s*/i, "") || null,
      lastWicket: lastWicket || null,
      battingTeamScore: battingScore?.score || null,
      otherTeam: bowlingTeam
        ? {
            name: bowlingTeam,
            score: (bowlingTeam === teamLeft ? leftScore : rightScore)?.score || null,
            overs: bowlingTeam === teamLeft ? leftOvers : rightOvers,
            currentRunRate: bowlingTeam === teamLeft ? leftCrr : rightCrr
          }
        : null,
      leadBy: leadMatch ? Number(leadMatch[2]) : null,
      leadTrail: leadMatch ? leadMatch[1].toLowerCase() : null,
      batsmen: batsmen.length ? batsmen : null,
      bowler,
      currentOver: currentOver ? `${currentOver.label}: ${currentOver.balls.join(" ")}` : null,
      source: "redux.catalog.scorecard.html"
    };
  }

  /** Best-effort structured cricket context from Redux scorecard + DOM text. */
  function buildStructuredMatchContext(options = {}) {
    const raw = options.scorecard !== undefined ? options.scorecard : board.scorecard;
    const domText = options.domText !== undefined ? options.domText : scrapeLiveMatchContextFromPage();
    const ctx = {
      innings: null,
      battingTeam: null,
      bowlingTeam: null,
      score: null,
      overs: null,
      target: null,
      runsRequired: null,
      ballsRemaining: null,
      currentRunRate: null,
      requiredRunRate: null,
      wicketsInHand: null,
      lastOverRuns: null,
      recentEvents: null,
      source: null
    };

    if (typeof raw === "string" && /<html|<div class="sc_cw-/i.test(raw)) {
      const parsed = parseCricwayScorecardHtml(raw);
      if (parsed) return parsed;
    }

    if (raw && typeof raw === "object") {
      ctx.source = "redux.catalog.scorecard";
      const sc = raw.data && typeof raw.data === "object" ? { ...raw, ...raw.data } : raw;

      ctx.innings = numOrNull(
        pickScorecardField(sc, ["innings", "inning", "inningsNumber", "currentInnings"])
      );
      ctx.battingTeam = firstDefined(
        pickScorecardField(sc, ["battingTeam", "batting_team", "batTeam", "teamBatting", "batting"])
      );
      ctx.bowlingTeam = firstDefined(
        pickScorecardField(sc, ["bowlingTeam", "bowling_team", "bowlTeam", "teamBowling", "bowling"])
      );
      ctx.score = firstDefined(
        pickScorecardField(sc, ["score", "currentScore", "runsWickets", "displayScore"]),
        (() => {
          const runs = pickScorecardField(sc, ["runs", "totalRuns"]);
          const wkts = pickScorecardField(sc, ["wickets", "wkts", "wicket"]);
          if (runs != null && wkts != null) return `${runs}/${wkts}`;
          return null;
        })()
      );
      ctx.overs = firstDefined(
        pickScorecardField(sc, ["overs", "over", "currentOvers", "oversBowled"])
      );
      ctx.target = numOrNull(pickScorecardField(sc, ["target", "targetScore", "chaseTarget"]));
      ctx.runsRequired = numOrNull(
        pickScorecardField(sc, ["runsRequired", "runs_required", "needRuns", "requiredRuns", "toWin"])
      );
      ctx.ballsRemaining = numOrNull(
        pickScorecardField(sc, [
          "ballsRemaining",
          "balls_remaining",
          "ballsLeft",
          "remainingBalls",
          "balls"
        ])
      );
      ctx.currentRunRate = numOrNull(
        pickScorecardField(sc, ["currentRunRate", "crr", "CRR", "runRate", "currentRR"])
      );
      ctx.requiredRunRate = numOrNull(
        pickScorecardField(sc, ["requiredRunRate", "rrr", "RRR", "reqRR", "requiredRR"])
      );
      ctx.wicketsInHand = numOrNull(
        pickScorecardField(sc, ["wicketsInHand", "wickets_remaining", "wicketsLeft"])
      );
      ctx.lastOverRuns = numOrNull(
        pickScorecardField(sc, ["lastOverRuns", "last_over_runs", "thisOverRuns"])
      );
      const events = pickScorecardField(sc, ["recentEvents", "lastBalls", "ballByBall", "commentary"]);
      if (Array.isArray(events) && events.length) ctx.recentEvents = events.slice(0, 12);

      if (ctx.score && ctx.wicketsInHand == null) {
        const m = String(ctx.score).match(/(\d+)\s*\/\s*(\d+)/);
        if (m) ctx.wicketsInHand = Math.max(0, 10 - Number(m[2]));
      }

      // nested home/away shapes
      if (!ctx.score) {
        const batting = sc.batting || sc.battingTeamStats || sc.currentBatting || null;
        if (batting && typeof batting === "object") {
          const runs = pickScorecardField(batting, ["runs", "score", "total"]);
          const wkts = pickScorecardField(batting, ["wickets", "wkts"]);
          const overs = pickScorecardField(batting, ["overs", "over"]);
          if (runs != null && wkts != null) ctx.score = `${runs}/${wkts}`;
          if (overs != null) ctx.overs = String(overs);
          if (!ctx.battingTeam) {
            ctx.battingTeam = firstDefined(pickScorecardField(batting, ["name", "team", "teamName"]));
          }
        }
      }
    }

    if (domText) {
      if (!ctx.source) ctx.source = "dom";
      else ctx.source = `${ctx.source}+dom`;

      if (!ctx.score) {
        const m = domText.match(/(\d+\s*\/\s*\d+)/);
        if (m) ctx.score = m[1].replace(/\s+/g, "");
      }
      if (!ctx.overs) {
        const m = domText.match(/\((\d+(?:\.\d+)?)\s*(?:ov|overs)\)|\b(\d+(?:\.\d+)?)\s+overs?\b/i);
        if (m) ctx.overs = m[1] || m[2];
      }
      if (ctx.currentRunRate == null) {
        const m = domText.match(/\bCRR\b\s*:?\s*(\d+(?:\.\d+)?)/i);
        if (m) ctx.currentRunRate = Number(m[1]);
      }
      if (ctx.requiredRunRate == null) {
        const m = domText.match(/\bRRR\b\s*:?\s*(\d+(?:\.\d+)?)/i);
        if (m) ctx.requiredRunRate = Number(m[1]);
      }
      if (ctx.target == null) {
        const m = domText.match(/\btarget\s*:?\s*(\d{2,4})\b/i);
        if (m) ctx.target = Number(m[1]);
      }
      if (ctx.runsRequired == null || ctx.ballsRemaining == null) {
        const m = domText.match(/\bneed[s]?\s+(\d+)\s+runs?\s+off\s+(\d+)/i);
        if (m) {
          ctx.runsRequired = Number(m[1]);
          ctx.ballsRemaining = Number(m[2]);
        }
      }
      if (ctx.score && ctx.wicketsInHand == null) {
        const m = String(ctx.score).match(/(\d+)\s*\/\s*(\d+)/);
        if (m) ctx.wicketsInHand = Math.max(0, 10 - Number(m[2]));
      }
    }

    const hasAny = Object.entries(ctx).some(([k, v]) => k !== "source" && v != null);
    return hasAny ? ctx : null;
  }

  function formatMatchContextForPrompt(matchContext) {
    if (!matchContext) return "";
    if (typeof matchContext === "string") return matchContext.trim();
    try {
      const compact = {};
      for (const [key, value] of Object.entries(matchContext)) {
        if (value == null || value === "") continue;
        compact[key] = value;
      }
      return JSON.stringify(compact, null, 2);
    } catch {
      return String(matchContext);
    }
  }

  function buildReviewContextProbe(entry = null, ctx = null) {
    const fm = board.focusedMatch;
    const domText = scrapeLiveMatchContextFromPage();
    const matchContext = buildStructuredMatchContext({ domText });
    const scorecard = board.scorecard ?? null;
    const marketContext = {
      previousOdds: ctx?.baseline ?? entry?.from ?? null,
      currentOdds: entry?.to ?? ctx?.currentBack ?? null,
      spikePercent: ctx?.spikeDelta ?? entry?.delta ?? null,
      timestamp: new Date(entry?.at || Date.now()).toISOString()
    };

    return {
      available: {
        onDetailPage: isOnMatchDetailPage(),
        reduxScorecardPresent: scorecard != null,
        reduxScorecardType: scorecard == null ? "null" : typeof scorecard,
        reduxScorecardKeys:
          scorecard && typeof scorecard === "object" ? Object.keys(scorecard).slice(0, 50) : [],
        reduxScorecardSample:
          typeof scorecard === "string"
            ? `html:${scorecard.length} chars`
            : scorecard && typeof scorecard === "object"
              ? JSON.parse(JSON.stringify(scorecard))
              : scorecard,
        sportsRadarWSConnected: Boolean(board.sportsRadarWSConnected),
        betFairWSConnected: Boolean(board.betFairWSConnected),
        domContextText: domText || null,
        reduxDebug: board.reduxDebug || null
      },
      sport: entry?.sportName || fm?.sportName || detectSportFromPage().sportName,
      tournament: entry?.tournament || fm?.competitionName || scrapeCompetitionFromPage() || "—",
      match: entry?.matchName || fm?.eventName || resolveLiveMatchName(),
      market: "Match Odds",
      runner: entry?.runnerName || ctx?.runnerName || null,
      marketContext,
      matchContext,
      matchContextPromptText: formatMatchContextForPrompt(matchContext) || null
    };
  }

  function forceTrackCurrentMatch() {
    ensureDetailOdds();
    const fm = board.focusedMatch;
    if (fm?.runners?.length) {
      trackBoardUpdate({
        pageMode: "detail",
        focusedMatch: fm,
        at: Date.now()
      });
    }
    return fm;
  }

  function tryEnsureOneClick(force = false) {
    if (!isOnMatchDetailPage()) return;
    demoTrader()?.ensureOneClickEnabled?.({ force });
  }

  function ensureDetailOdds() {
    if (!isOnMatchDetailPage()) return false;

    board.pageMode = "detail";
    const reduxFm = isReduxFocusedMatch(board.focusedMatch) ? board.focusedMatch : null;
    if (!syncLivePageMatch(reduxFm)) return false;

    board.focusedMatch = mergeDomWithRedux(board.focusedMatch, reduxFm);
    tryEnsureOneClick();
    return true;
  }

  function startLivePagePoll() {
    if (window.__mrLivePagePollStarted) return;
    window.__mrLivePagePollStarted = true;

    ensureDetailOdds();
    panelApi?.render?.(getViewState());

    window.setInterval(() => {
      if (!isOnMatchDetailPage()) return;

      const reduxFm = isReduxFocusedMatch(board.focusedMatch) ? board.focusedMatch : null;
      if (!syncLivePageMatch(reduxFm)) return;

      board.focusedMatch = mergeDomWithRedux(board.focusedMatch, reduxFm);
      trackBoardUpdate({
        pageMode: "detail",
        focusedMatch: board.focusedMatch,
        at: Date.now()
      });
      panelApi?.render?.(getViewState(), { liveOnly: true });
    }, 400);
  }

  /** DOM scrape is primary on match detail pages; Redux only enriches metadata. */
  function mergeDomWithRedux(domFm, reduxFm) {
    if (!domFm?.runners?.length) return reduxFm || domFm;
    if (!reduxFm?.runners?.length && !reduxFm?.eventId) return domFm;

    return {
      ...domFm,
      eventId:
        reduxFm?.eventId && !isSyntheticEventId(reduxFm.eventId)
          ? String(reduxFm.eventId)
          : domFm.eventId,
      eventName: domFm.eventName || reduxFm?.eventName || "Live match",
      sportId: reduxFm?.sportId || domFm.sportId,
      sportName: reduxFm?.sportName || domFm.sportName,
      competitionName: reduxFm?.competitionName || domFm.competitionName || scrapeCompetitionFromPage() || "",
      marketSuspended: Boolean(reduxFm?.marketSuspended),
      eventSuspended: Boolean(reduxFm?.eventSuspended),
      runners: domFm.runners
    };
  }

  function resolveFocusedMatch(data) {
    const onDetail = isOnMatchDetailPage() || data?.pageMode === "detail";
    const reduxFm = hasUsableFocusedMatch(data?.focusedMatch)
      ? data.focusedMatch
      : isReduxFocusedMatch(board.focusedMatch)
        ? board.focusedMatch
        : null;

    if (onDetail) {
      if (syncLivePageMatch(reduxFm)) {
        board.focusedMatch = mergeDomWithRedux(board.focusedMatch, reduxFm);
        board.pageMode = "detail";
        return board.focusedMatch;
      }

      if (hasUsableFocusedMatch(reduxFm)) {
        board = { ...board, pageMode: "detail", focusedMatch: reduxFm };
        return reduxFm;
      }

      if (hasUsableFocusedMatch(board.focusedMatch)) {
        board = { ...board, pageMode: "detail" };
        return board.focusedMatch;
      }

      board = { ...board, pageMode: "detail" };
      return null;
    }

    const fm = reduxFm || data?.focusedMatch || board.focusedMatch || null;
    if (fm) board = { ...board, focusedMatch: fm };
    return fm;
  }

  /** Scrape visible odds from the Cricway page (primary source on detail pages). */
  function syncLivePageMatch(reduxHint = null) {
    if (!isOnMatchDetailPage()) return false;

    const runners = sanitizeRunners(scrapeRunnersFromDomInContentScript());
    if (!runners.length) return false;

    const matchName = buildMatchNameFromRunners(runners);
    const prev = board.focusedMatch;
    const pageSport = detectSportFromPage();
    const eventId =
      reduxHint?.eventId && !isSyntheticEventId(reduxHint.eventId)
        ? String(reduxHint.eventId)
        : prev?.eventId && !isSyntheticEventId(prev.eventId)
          ? String(prev.eventId)
          : tabMatchContext.eventId || prev?.eventId || stableSyntheticEventId(runners, matchName);

    board = {
      ...board,
      pageMode: "detail",
      focusedMatch: {
        eventId,
        eventName: matchName,
        status: "IN_PLAY",
        isLive: true,
        sportId:
          reduxHint?.sportId ||
          pageSport?.sportId ||
          prev?.sportId ||
          board.trackSportId ||
          "4",
        sportName:
          reduxHint?.sportName ||
          pageSport?.sportName ||
          prev?.sportName ||
          board.trackSportName ||
          "Cricket",
        competitionName:
          reduxHint?.competitionName || prev?.competitionName || scrapeCompetitionFromPage() || "",
        source: "live-page",
        marketSuspended: runners.every((r) => r.suspended || r.back == null),
        eventSuspended: false,
        runners
      }
    };
    return true;
  }

  async function resolveDetailPageMatch(data) {
    if (data?.pageMode !== "detail" && !isOnMatchDetailPage()) return null;

    const fm = resolveFocusedMatch(data);
    if (!fm?.runners?.length) return null;

    updateTabMatchContext(fm);
    syncValidationForMatch(fm.eventId, fm.eventName);
    resetWatchState(fm.eventId, fm);

    return { eventId: fm.eventId, matchName: fm.eventName };
  }

  function scheduleDetailPageResolve(data) {
    if (data?.pageMode !== "detail" && !isOnMatchDetailPage()) return;
    resolveFocusedMatch(data);
    panelApi?.render?.(getViewState());
    clearTimeout(detailResolveTimer);
    detailResolveTimer = setTimeout(() => {
      void resolveDetailPageMatch(data);
    }, 200);
  }

  function getCurrentMatchContext() {
    const fm = board.focusedMatch;
    if (fm?.eventId) {
      return {
        eventId: String(fm.eventId),
        matchName: fm.eventName || tabMatchContext.matchName || null
      };
    }
    return { ...tabMatchContext };
  }

  function updateTabMatchContext(fm) {
    if (!fm?.eventId) return;
    tabMatchContext = {
      eventId: String(fm.eventId),
      matchName: fm.eventName || fm.matchName || null
    };
  }

  function ensureMatchPaperBook(eventId, matchName) {
    const id = String(eventId || "");
    if (!id) return null;
    if (!paper.matchBooks[id]) {
      paper.matchBooks[id] = { eventId: id, matchName: matchName || "", trades: [] };
    } else if (matchName) {
      paper.matchBooks[id].matchName = matchName;
    }
    return paper.matchBooks[id];
  }

  function getAllClosedTrades() {
    const all = [];
    for (const book of Object.values(paper.matchBooks || {})) {
      all.push(...(book.trades || []));
    }
    return all.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  }

  function chartHasDataForMatch(eventId) {
    const prefix = `${eventId}:`;
    for (const [key, points] of chartOddsHistory.entries()) {
      if (key.startsWith(prefix) && points?.length > 1) return true;
    }
    return false;
  }

  function getTradesForMatch(eventId, matchName, limit = Infinity) {
    const book = paper.matchBooks[String(eventId)];
    let rows = book?.trades ? [...book.trades] : [];
    if (!rows.length) {
      rows = getAllClosedTrades().filter((trade) => tradeBelongsToMatch(trade, eventId, matchName));
    }
    return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  }

  function getMaxOpenTrades() {
    if (DEMO_TRADING_ENABLED) return 1;
    return SPIKE_ALERT_TESTING ? TEST_MAX_OPEN_TRADES : BRACKET.MAX_OPEN_TRADES;
  }

  function syncPaperOpenTradeLegacy() {
    if (!Array.isArray(paper.openTrades)) {
      paper.openTrades = paper.openTrade ? [paper.openTrade] : [];
    }
    paper.openTrade = paper.openTrades[0] || null;
    paper.state = paper.openTrades.length ? "IN_TRADE" : "FLAT";
  }

  function getOpenTrades() {
    syncPaperOpenTradeLegacy();
    return paper.openTrades;
  }

  function getOpenTradeCount() {
    return getOpenTrades().length;
  }

  function findOpenTrade(tradeId) {
    return getOpenTrades().find((t) => t.tradeId === tradeId) || null;
  }

  function getMatchPaperStats(eventId, matchName) {
    const trades = getTradesForMatch(eventId, matchName);
    const wins = trades.filter((t) => t.result === "WIN").length;
    const losses = trades.filter((t) => t.result === "LOSS").length;
    const totalTrades = trades.length;
    const matchPnl = trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
    const matchOpenTrades = getOpenTrades().filter((t) =>
      tradeBelongsToMatch(t, eventId, matchName)
    );
    const openTrade = matchOpenTrades[0] || null;
    const otherOpenTrade =
      getOpenTradeCount() > matchOpenTrades.length
        ? getOpenTrades().find((t) => !tradeBelongsToMatch(t, eventId, matchName)) || null
        : null;

    return {
      eventId: String(eventId),
      matchName,
      trades,
      wins,
      losses,
      totalTrades,
      matchPnl,
      winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
      openTrade,
      openTrades: matchOpenTrades,
      otherOpenTrade,
      state: matchOpenTrades.length ? "IN_TRADE" : otherOpenTrade ? "OTHER_MATCH" : "FLAT"
    };
  }

  let storeConnected = false;
  let scriptReady = false;
  let searchAttempts = 0;
  let board = {
    liveCount: 0,
    groups: [],
    betFairWSConnected: null,
    pageMode: "list",
    focusedMatch: null
  };
  let panelApi = null;
  let panelRootRef = null;
  let uiPanelState = { ...UI_PANEL_DEFAULTS };

  async function loadUiPanelState() {
    const data = await storageGet(UI_STORAGE_KEY);
    const saved = data[UI_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      uiPanelState = { ...UI_PANEL_DEFAULTS, ...saved };
    }
  }

  async function saveUiPanelState() {
    const payload = { ...uiPanelState, selectedRunnerKey: selectedRunnerKey || "" };
    await storageSet({ [UI_STORAGE_KEY]: payload });
  }

  function saveSelectedRunnerKey() {
    void saveUiPanelState();
  }

  function isPanelOpen(id) {
    const el = panelRootRef?.querySelector(`details[data-panel="${id}"]`);
    if (el) return el.open;
    return uiPanelState[id] ?? UI_PANEL_DEFAULTS[id] ?? true;
  }

  function renderPanel(id, title, badgeHtml, bodyHtml) {
    const consoleColumn =
      id === "bracket" ||
      id === "paper" ||
      id === "chart" ||
      id === "live" ||
      id === "validation";
    const open = consoleColumn || isPanelOpen(id);
    return `
      <details class="mr-panel${consoleColumn ? " mr-console-column" : ""}" data-panel="${id}" ${open ? "open" : ""}>
        <summary class="mr-panel-summary">
          <span class="mr-panel-title">${title}</span>
          ${badgeHtml ? `<span class="mr-panel-badge">${badgeHtml}</span>` : ""}
        </summary>
        <div class="mr-panel-body">${bodyHtml}</div>
      </details>
    `;
  }

  function formatTelegramStatusShort(state) {
    if (!settings.telegramBotToken?.trim()) return "NO BOT";
    if (!state.settings?.telegramAlertsEnabled) return "OFF";
    if (!state.settings?.telegramChatId?.trim()) return "NO CHAT";
    const s = state.telegramStatus || "—";
    if (/fail|error|invalid|wrong|blocked|need bot|need chat/i.test(s)) return "ERR";
    if (/sent|ok/i.test(s)) return "OK";
    if (s === "—" || s === "Ready") return "ON";
    return "ON";
  }

  function getSpikeWatchStatus(fm) {
    if (!fm?.runners?.length) {
      return { inBracket: 0, total: 0, memoryReady: 0, armed: false };
    }

    let inBracket = 0;
    let memoryReady = 0;
    const eventId = String(fm.eventId || "");

    for (const runner of fm.runners) {
      if (!runnerInBracket(runner, fm.sportName, fm.sportId)) continue;
      inBracket += 1;

      const runnerKey = String(runner.runnerId || runner.runnerName);
      const mem = priceMemory.get(`${eventId}:${runnerKey}`);
      if (mem?.history?.length >= MEMORY_DEPTH) memoryReady += 1;
    }

    return {
      inBracket,
      total: fm.runners.length,
      memoryReady,
      armed: inBracket > 0
    };
  }

  function getResearchProgress() {
    const signals = countAllValidationSignals();
    const closed = getAllClosedTrades().length;
    const matchIds = new Set();
    for (const match of Object.values(validationStore.matches)) {
      if (match.eventId && match.rows?.length) matchIds.add(String(match.eventId));
    }
    for (const book of Object.values(paper.matchBooks || {})) {
      if (book.eventId) matchIds.add(String(book.eventId));
    }
    for (const trade of getAllClosedTrades()) {
      if (trade.eventId) matchIds.add(String(trade.eventId));
    }
    for (const trade of getOpenTrades()) {
      if (trade.eventId) matchIds.add(String(trade.eventId));
    }
    return {
      signals,
      trades: DEMO_TRADING_ENABLED
        ? (demoTrader()?.getStats?.()?.closedCount ?? 0) + (demoTrader()?.getStats?.()?.openCount ?? 0)
        : closed + getOpenTradeCount(),
      matches: matchIds.size,
      closed,
      closedTarget: BRACKET.MIN_CLOSED_TRADES
    };
  }

  function renderStatusStripValues(state) {
    const fm = state.board?.focusedMatch;
    const ctx = getCurrentMatchContext();
    const onDetailPage = state.board?.pageMode === "detail";
    const onDetail = onDetailPage && (fm?.runners?.length || ctx.eventId);
    const sport = fm?.sportName
      ? getSportBracket(fm.sportName, fm.sportId).label
      : onDetail
        ? "—"
        : "—";
    const sportWithComp =
      fm?.competitionName && sport !== "—" ? `${sport} · ${fm.competitionName}` : fm?.competitionName || sport;
    const openTrades = DEMO_TRADING_ENABLED
      ? state.demo?.openCount ?? 0
      : state.paper?.openCount ?? getOpenTradeCount();
    const eventId = onDetail ? String(fm.eventId) : null;
    const signalRows = eventId
      ? validationRowsForView(eventId, fm?.eventName || ctx.matchName).length
      : 0;

    let matchLabel = "Open match page";
    if (fm?.eventName && fm?.runners?.length) matchLabel = fm.eventName;
    else if (ctx.matchName && (fm?.runners?.length || isOnMatchDetailPage())) matchLabel = ctx.matchName;
    else if (onDetailPage && isOnMatchDetailPage()) matchLabel = "Reading odds…";
    else if (onDetailPage) matchLabel = state.storeConnected ? "Reading odds…" : "Connecting…";
    else if (!state.storeConnected && state.scriptReady) matchLabel = "Connecting…";

    const tg = formatTelegramStatusShort(state);
    const cw = state.cricwayAccount || {};
    return {
      match: matchLabel,
      sport: sportWithComp,
      openTrades: `${openTrades}/${getMaxOpenTrades()}`,
      cricwayBalance: formatCricwayBalance(cw.balance),
      cricwayBalanceState: cw.balance != null ? "ok" : "off",
      telegram: tg,
      telegramState: /ERR|NO/i.test(tg) ? "error" : tg === "OFF" || tg === "NO BOT" || tg === "NO CHAT" ? "off" : "ok",
      exportEnabled: signalRows > 0,
      exportEventId: eventId
    };
  }

  function formatBracketBadge(state) {
    const b = state.bracket || getBracketMetrics();
    const pnlClass = b.totalPnl >= 0 ? "mr-ok" : "mr-warn";
    return `<span class="${pnlClass}">${formatInr(b.totalPnl)}</span> · ${b.tradeCount} trades · ${b.winRate.toFixed(0)}% WR`;
  }

  function formatPaperBadge(state) {
    const n = DEMO_TRADING_ENABLED
      ? state.demo?.openCount ?? 0
      : state.paper?.openCount ?? 0;
    if (n <= 0) return "";
    return n > 1 ? `${n} OPEN` : "OPEN";
  }

  function formatLiveBadge(state) {
    const fm = state.board?.focusedMatch;
    if (!fm) return "";
    if (fm.marketSuspended) return `<span class="mr-warn">SUSPENDED</span>`;
    return `<span class="mr-ok">LIVE</span>`;
  }

  function formatValidationBadge(state) {
    const s = state.validation?.summary;
    if (!s) return "";
    const cls = s.netPnl >= 0 ? "mr-ok" : "mr-warn";
    return `${s.totalSignals} signals · <span class="${cls}">${formatInr(s.netPnl)}</span>`;
  }

  const priceMemory = new Map();
  const chartOddsHistory = new Map();
  const oddsMemoryStore = { matches: {} };
  const oddsMemoryLastTick = new Map();
  let oddsMemoryDirty = false;
  let oddsMemorySaveTimer = null;
  let oddsMemoryPointsSinceSave = 0;
  const lastSpikeAt = new Map();
  const matchSpikeCount = new Map();
  const lastMatchSpikeAt = new Map();
  const matchProfitTaken = new Set();
  const pendingExitWatch = new Map();
  let selectedRunnerKey = null;
  let tickChanges = 0;
  let totalSpikes = 0;
  let recentSpikes = [];
  let lastBoardAt = 0;
  let watchedEventId = null;
  let watchedMatchKey = null;
  let lastMarketSuspended = false;
  let activeAlert = null;
  let alertFlashUntil = 0;
  let telegramStatus = "—";
  let telegramCloudStatus = "";
  let cricwayAccount = { balance: null, username: null, source: null, updatedAt: 0 };

  function refreshCricwayAccount() {
    const scraped = oddsDetect()?.scrapeCricwayAccount?.();
    if (!scraped) return cricwayAccount;
    if (scraped.ok) {
      cricwayAccount = {
        balance: scraped.balance,
        username: scraped.username || cricwayAccount.username,
        source: scraped.source,
        updatedAt: scraped.at
      };
    }
    return cricwayAccount;
  }

  function formatCricwayBalance(amount) {
    if (!Number.isFinite(amount)) return "—";
    return amount.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function startAccountPoll() {
    if (window.__mrAccountPollStarted) return;
    window.__mrAccountPollStarted = true;

    const tick = () => {
      refreshCricwayAccount();
      panelApi?.updateCricwayBalanceUi?.();
    };

    tick();
    window.setInterval(tick, 1500);
  }

  function handleBridgeMessage(data) {
    if (data?.source !== "market-radar") return;

    if (data.type === "board-ready") {
      scriptReady = true;
      panelApi?.render?.(getViewState());
      return;
    }

    if (data.type === "store-found") {
      storeConnected = true;
      scriptReady = true;
      panelApi?.render?.(getViewState());
      return;
    }

    if (data.type === "bridge-status") {
      searchAttempts = data.attempts || searchAttempts + 1;
      panelApi?.render?.(getViewState());
      return;
    }

    if (data.type === "live-board") {
      storeConnected = true;
      scriptReady = true;
      lastBoardAt = data.at;

      const onDetail = data.pageMode === "detail" || isOnMatchDetailPage();
      const reduxFm = data.focusedMatch || null;

      board = {
        at: data.at,
        liveCount: data.liveCount || 0,
        groups: data.groups || [],
        betFairWSConnected: data.betFairWSConnected,
        sportsRadarWSConnected: data.sportsRadarWSConnected,
        secondaryMapSize: data.secondaryMapSize || 0,
        scorecard: data.scorecard !== undefined ? data.scorecard : board.scorecard ?? null,
        reduxDebug: data.reduxDebug || board.reduxDebug || null,
        trackSportName: data.trackSportName || board.trackSportName || "All sports",
        trackSportId: data.trackSportId || board.trackSportId || null,
        pageMode: onDetail ? "detail" : data.pageMode || board.pageMode || "list",
        focusedMatch: board.focusedMatch
      };

      if (onDetail) {
        if (syncLivePageMatch(reduxFm)) {
          board.focusedMatch = mergeDomWithRedux(board.focusedMatch, reduxFm);
        } else if (hasUsableFocusedMatch(reduxFm)) {
          board.focusedMatch = reduxFm;
        }
      } else {
        board.focusedMatch = reduxFm || board.focusedMatch || null;
      }

      trackBoardUpdate({ ...data, pageMode: board.pageMode, focusedMatch: board.focusedMatch });
      panelApi?.render?.(getViewState(), { liveOnly: true });
    }
  }

  function pctChange(oldPrice, newPrice) {
    if (oldPrice == null || newPrice == null || oldPrice === 0) return null;
    return ((newPrice - oldPrice) / oldPrice) * 100;
  }

  function pushHistory(history, price) {
    if (price == null || !Number.isFinite(price)) return history;
    const next = [...history, price];
    while (next.length > MEMORY_DEPTH) next.shift();
    return next;
  }

  function pushChartPoint(key, back, at) {
    if (back == null || !Number.isFinite(back)) return;
    const prev = chartOddsHistory.get(key) || [];
    const last = prev[prev.length - 1];
    if (last && last.back === back) return;
    const next = [...prev, { at: at || Date.now(), back }];
    while (next.length > CHART_HISTORY_MAX) next.shift();
    chartOddsHistory.set(key, next);
  }

  function pushChartPointForRunner(eventId, runnerKey, runnerName, back, at) {
    const keys = new Set(
      [runnerKey, normalizeChartKey(runnerName), chartKeySlug(runnerName)].filter(Boolean)
    );
    for (const key of keys) {
      pushChartPoint(`${eventId}:${key}`, back, at);
    }
  }

  function clearChartHistory(eventId) {
    if (!eventId) {
      chartOddsHistory.clear();
      return;
    }
    const prefix = `${eventId}:`;
    for (const key of chartOddsHistory.keys()) {
      if (key.startsWith(prefix)) chartOddsHistory.delete(key);
    }
  }

  function ensureOddsMemoryMatch(eventId, matchName, sportName) {
    const id = String(eventId);
    if (!oddsMemoryStore.matches[id]) {
      oddsMemoryStore.matches[id] = {
        eventId: id,
        matchName: matchName || "",
        sportName: sportName || "",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        runners: {}
      };
    } else {
      if (matchName) oddsMemoryStore.matches[id].matchName = matchName;
      if (sportName) oddsMemoryStore.matches[id].sportName = sportName;
    }
    return oddsMemoryStore.matches[id];
  }

  function trimOddsMemoryRunnerSeries(series) {
    while (series.length > ODDS_MEMORY_MAX_POINTS_PER_RUNNER) {
      series.shift();
    }
  }

  function trimOddsMemoryMatches() {
    const entries = Object.values(oddsMemoryStore.matches);
    if (entries.length <= ODDS_MEMORY_MAX_MATCHES) return;
    entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const keep = new Set(entries.slice(0, ODDS_MEMORY_MAX_MATCHES).map((m) => m.eventId));
    for (const id of Object.keys(oddsMemoryStore.matches)) {
      if (!keep.has(id)) {
        delete oddsMemoryStore.matches[id];
        for (const key of [...oddsMemoryLastTick.keys()]) {
          if (key.startsWith(`${id}:`)) oddsMemoryLastTick.delete(key);
        }
      }
    }
  }

  function recordOddsMemoryFromMatch(fm) {
    if (!fm?.eventId || !fm?.runners?.length) return;

    const eventId = String(fm.eventId);
    const match = ensureOddsMemoryMatch(eventId, fm.eventName, fm.sportName);
    let anyNew = false;

    for (const runner of fm.runners) {
      const back = normalizeOdds(runner.back);
      const lay = normalizeOdds(runner.lay);
      if (back == null && lay == null) continue;

      const runnerKey = String(runner.runnerId || runner.runnerName || "");
      if (!runnerKey) continue;

      const tickKey = `${eventId}:${runnerKey}`;
      const prev = oddsMemoryLastTick.get(tickKey);
      if (prev && prev.back === back && prev.lay === lay) continue;

      oddsMemoryLastTick.set(tickKey, { back, lay });

      if (!match.runners[runnerKey]) {
        match.runners[runnerKey] = { runnerName: runner.runnerName || runnerKey, points: [] };
      } else if (runner.runnerName) {
        match.runners[runnerKey].runnerName = runner.runnerName;
      }

      match.runners[runnerKey].points.push({ at: Date.now(), back, lay });
      trimOddsMemoryRunnerSeries(match.runners[runnerKey].points);
      anyNew = true;
      oddsMemoryPointsSinceSave += 1;
    }

    if (anyNew) {
      match.updatedAt = Date.now();
      oddsMemoryDirty = true;
      scheduleOddsMemorySave();
    }

    void cloudOddsApi()?.recordMatchOdds?.(fm);
  }

  function scheduleOddsMemorySave() {
    if (oddsMemorySaveTimer) return;
    oddsMemorySaveTimer = window.setTimeout(() => {
      oddsMemorySaveTimer = null;
      void flushOddsMemorySave();
    }, ODDS_MEMORY_SAVE_MS);
  }

  async function flushOddsMemorySave() {
    if (!oddsMemoryDirty && oddsMemoryPointsSinceSave < 20) return;
    oddsMemoryDirty = false;
    oddsMemoryPointsSinceSave = 0;
    trimOddsMemoryMatches();
    await storageSet({ [ODDS_MEMORY_STORAGE_KEY]: oddsMemoryStore });
  }

  function rebuildOddsMemoryLastTick() {
    oddsMemoryLastTick.clear();
    for (const match of Object.values(oddsMemoryStore.matches)) {
      for (const [runnerKey, runner] of Object.entries(match.runners || {})) {
        const pts = runner.points;
        if (!pts?.length) continue;
        const last = pts[pts.length - 1];
        oddsMemoryLastTick.set(`${match.eventId}:${runnerKey}`, { back: last.back, lay: last.lay });
      }
    }
  }

  async function loadOddsMemory() {
    const data = await storageGet(ODDS_MEMORY_STORAGE_KEY);
    if (data[ODDS_MEMORY_STORAGE_KEY]?.matches) {
      oddsMemoryStore.matches = data[ODDS_MEMORY_STORAGE_KEY].matches;
      rebuildOddsMemoryLastTick();
    }
  }

  function getOddsMemoryStats(eventId) {
    const id = eventId != null ? String(eventId) : null;
    const match = id ? oddsMemoryStore.matches[id] : null;
    if (match) {
      let points = 0;
      let runners = 0;
      for (const runner of Object.values(match.runners || {})) {
        runners += 1;
        points += runner.points?.length || 0;
      }
      return { eventId: id, matchName: match.matchName, runners, points, updatedAt: match.updatedAt };
    }
    const all = Object.values(oddsMemoryStore.matches);
    return {
      matches: all.length,
      totalPoints: all.reduce(
        (sum, m) =>
          sum +
          Object.values(m.runners || {}).reduce((runnerSum, runner) => runnerSum + (runner.points?.length || 0), 0),
        0
      )
    };
  }

  function normalizeChartKey(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function chartKeySlug(value) {
    return normalizeChartKey(value).replace(/\s+/g, "-");
  }

  function runnerKeysForLookup(runner) {
    const keys = new Set();
    const id = String(runner?.runnerId || "").trim();
    const name = String(runner?.runnerName || "").trim();
    if (id) keys.add(id);
    if (name) {
      keys.add(name);
      keys.add(normalizeChartKey(name));
      keys.add(chartKeySlug(name));
    }
    return [...keys].filter(Boolean);
  }

  function getChartHistory(eventId, runnerKey) {
    return chartOddsHistory.get(`${eventId}:${runnerKey}`) || [];
  }

  function getChartHistoryForRunner(eventId, runner) {
    const id = String(eventId || "");
    if (!id) return [];

    const subject =
      typeof runner === "string" ? { runnerId: runner, runnerName: runner } : runner;
    for (const key of runnerKeysForLookup(subject)) {
      const series = getChartHistory(id, key);
      if (series.length) return series;
    }

    const target = normalizeChartKey(subject?.runnerName || subject?.runnerId);
    if (!target) return [];

    const prefix = `${id}:`;
    let best = [];
    for (const [key, series] of chartOddsHistory) {
      if (!key.startsWith(prefix) || !series?.length) continue;
      const part = normalizeChartKey(key.slice(prefix.length));
      if (part === target || part.includes(target) || target.includes(part)) {
        if (series.length > best.length) best = series;
      }
    }
    return best;
  }

  function aliasChartHistoryToRunners(eventId, oddsByRunner, runners, signalRows) {
    const id = String(eventId || "");
    if (!id) return;

    for (const [rawKey, points] of Object.entries(oddsByRunner || {})) {
      if (!points?.length) continue;
      chartOddsHistory.set(`${id}:${rawKey}`, points);
      chartOddsHistory.set(`${id}:${normalizeChartKey(rawKey)}`, points);
      chartOddsHistory.set(`${id}:${chartKeySlug(rawKey)}`, points);
    }

    function aliasSeriesToRunner(series, runner) {
      if (!series?.length) return;
      for (const key of runnerKeysForLookup(runner)) {
        chartOddsHistory.set(`${id}:${key}`, series);
      }
    }

    for (const sig of signalRows || []) {
      const selId = String(sig.runnerKey || "");
      if (!selId) continue;
      const series =
        oddsByRunner?.[selId] ||
        chartOddsHistory.get(`${id}:${selId}`) ||
        getChartHistory(id, selId);
      if (!series?.length) continue;

      aliasSeriesToRunner(series, {
        runnerId: selId,
        runnerName: sig.runnerName || sig.runner || selId
      });

      const sigName = normalizeChartKey(sig.runnerName || sig.runner);
      for (const runner of runners || []) {
        if (sigName && normalizeChartKey(runner.runnerName) === sigName) {
          aliasSeriesToRunner(series, runner);
        }
      }
    }

    for (const runner of runners || []) {
      aliasSeriesToRunner(getChartHistoryForRunner(id, runner), runner);
    }
  }

  function filterSignalsForRunner(rows, runner, runnerKey) {
    const keys = new Set([...runnerKeysForLookup(runner), String(runnerKey || "")].filter(Boolean));
    const name = normalizeChartKey(runner?.runnerName);
    return (rows || []).filter((row) => {
      const rk = String(row.runnerKey || "");
      if (keys.has(rk)) return true;
      const rowName = normalizeChartKey(row.runnerName);
      if (name && rowName === name) return true;
      if (name && rk && (normalizeChartKey(rk).includes(name) || name.includes(normalizeChartKey(rk)))) {
        return true;
      }
      return false;
    });
  }

  function buildSeriesFromSignals(signals) {
    const points = [];
    for (const row of signals || []) {
      const baseAt = row.at || Date.now();
      if (row.mem1 != null) points.push({ at: baseAt - 2000, back: Number(row.mem1) });
      if (row.mem2 != null) points.push({ at: baseAt - 1000, back: Number(row.mem2) });
      if (row.mem3 != null) points.push({ at: baseAt - 500, back: Number(row.mem3) });
      const cur = row.currentPrice ?? row.backOdds;
      if (cur != null) points.push({ at: baseAt, back: Number(cur) });
    }
    points.sort((a, b) => a.at - b.at);
    const deduped = [];
    for (const p of points) {
      const last = deduped[deduped.length - 1];
      if (last && last.at === p.at && last.back === p.back) continue;
      deduped.push(p);
    }
    return deduped;
  }

  function mergeChartSeries(...arrays) {
    const map = new Map();
    for (const arr of arrays) {
      for (const p of arr || []) {
        if (p?.back == null || !Number.isFinite(p.back)) continue;
        map.set(`${p.at}:${p.back}`, p);
      }
    }
    return [...map.values()].sort((a, b) => a.at - b.at);
  }

  function resolveSelectedRunner(fm) {
    const runners = fm?.runnerTrack || fm?.runners || [];
    if (!runners.length) return null;

    if (selectedRunnerKey?.startsWith(`${fm.eventId}:`)) {
      const runnerKey = selectedRunnerKey.slice(String(fm.eventId).length + 1);
      const found = runners.find((r) => String(r.runnerId || r.runnerName) === runnerKey);
      if (found) return found;
    }

    const inBracket = runners.find((r) => runnerInBracket(r, fm.sportName, fm.sportId));
    return inBracket || runners[0];
  }

  function playSpikeTone() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
      window.setTimeout(() => ctx.close(), 300);
    } catch {
      /* ignore */
    }
  }

  function inferMatchState(fm) {
    const status = String(fm?.status || "").toUpperCase();
    const pageText = (document.body?.innerText || "").toUpperCase();
    if (/INNINGS?\s+BREAK/.test(pageText)) return "INNINGS_BREAK";
    if (/\bCHASE\b|2ND INN|SECOND INN/.test(pageText)) return "CHASE";
    if (status === "IN_PLAY") return "IN_PLAY";
    if (status === "OPEN" || status === "NOT_STARTED") return "PRE_MATCH";
    return status || "UNKNOWN";
  }

  function getValidationMatch(eventId) {
    return validationStore.matches[String(eventId)] || null;
  }

  function ensureValidationMatch(eventId, matchName) {
    const key = String(eventId);
    if (!validationStore.matches[key]) {
      validationStore.matches[key] = {
        eventId: key,
        matchName: matchName || "Unknown",
        rows: []
      };
    } else if (matchName) {
      validationStore.matches[key].matchName = matchName;
    }
    return validationStore.matches[key];
  }

  function findValidationRow(eventId, rowId) {
    const match = getValidationMatch(eventId);
    return match?.rows.find((row) => row.id === rowId) || null;
  }

  async function saveValidationStore() {
    await storageSet({
      [VALIDATION_STORAGE_KEY]: {
        matches: validationStore.matches,
        validationSeq
      }
    });
  }

  function applyValidationStore(saved) {
    if (!saved) return;
    validationStore.matches = saved.matches || {};
    validationSeq = Number(saved.validationSeq) || validationSeq;
  }

  async function loadValidationStore() {
    const data = await storageGet(VALIDATION_STORAGE_KEY);
    applyValidationStore(data[VALIDATION_STORAGE_KEY]);
  }

  function trimValidationRows(match) {
    while (match.rows.length > MAX_VALIDATION_ROWS) {
      match.rows.shift();
    }
  }

  function normalizeMatchKey(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function matchNameTeams(name) {
    const norm = normalizeMatchKey(name);
    if (!norm) return [];
    return norm
      .split(/\s+v(?:s)?\.?\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1)
      .sort();
  }

  function matchNamesEquivalent(a, b) {
    const na = normalizeMatchKey(a);
    const nb = normalizeMatchKey(b);
    if (!na || !nb) return false;
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const teamsA = matchNameTeams(a);
    const teamsB = matchNameTeams(b);
    return (
      teamsA.length >= 2 &&
      teamsB.length >= 2 &&
      teamsA.length === teamsB.length &&
      teamsA.every((team, i) => team === teamsB[i])
    );
  }

  function validationKeysForMatch(eventId) {
    const keys = new Set();
    if (eventId) keys.add(String(eventId));

    for (const [key, match] of Object.entries(validationStore.matches)) {
      if (eventId && match.eventId && String(match.eventId) === String(eventId)) {
        keys.add(key);
      }
    }

    return [...keys];
  }

  function consolidateValidationMatches(eventId, matchName) {
    const primaryKey = String(eventId || "");
    if (!primaryKey) return primaryKey;

    const keys = validationKeysForMatch(primaryKey);
    const primary = ensureValidationMatch(primaryKey, matchName);
    const seenIds = new Set(primary.rows.map((row) => row.id));
    let changed = false;

    for (const key of keys) {
      if (key === primaryKey) continue;
      const other = validationStore.matches[key];
      if (!other?.rows?.length) {
        delete validationStore.matches[key];
        changed = true;
        continue;
      }
      for (const row of other.rows) {
        if (seenIds.has(row.id)) continue;
        primary.rows.push({ ...row, eventId: primaryKey, match: matchName || row.match });
        seenIds.add(row.id);
        changed = true;
      }
      delete validationStore.matches[key];
      changed = true;
    }

    if (changed) {
      primary.matchName = matchName || primary.matchName;
      primary.rows.sort((a, b) => a.at - b.at);
      trimValidationRows(primary);
      void saveValidationStore();
    }

    return primaryKey;
  }

  function tradeBelongsToMatch(trade, eventId, matchName) {
    if (!trade) return false;
    if (trade.eventId && String(trade.eventId) === String(eventId)) return true;
    if (!matchName || !trade.match) return false;
    return normalizeMatchKey(trade.match) === normalizeMatchKey(matchName);
  }

  function backfillValidationFromPaper(eventId, matchName) {
    if (!eventId) return false;

    const match = ensureValidationMatch(eventId, matchName);
    const existingTradeIds = new Set(
      match.rows.filter((row) => row.tradeId).map((row) => row.tradeId)
    );
    let changed = false;

    const candidates = getTradesForMatch(eventId, matchName);
    for (const trade of getOpenTrades()) {
      if (tradeBelongsToMatch(trade, eventId, matchName)) {
        candidates.push({ ...trade, isOpen: true });
      }
    }

    for (const trade of candidates) {
      if (existingTradeIds.has(trade.tradeId)) continue;

      if (trade.signalRowId) {
        const linked = findValidationRow(eventId, trade.signalRowId);
        if (linked) {
          linked.tradeId = trade.tradeId;
          linked.paperAction = trade.side;
          linked.entryOdds = trade.entryOdds;
          linked.targetOdds = trade.targetOdds;
          linked.stopOdds = trade.stopOdds;
          linked.currentOdds = trade.isOpen ? trade.entryOdds : trade.exitOdds;
          linked.tradeStatus = trade.isOpen ? "OPEN" : trade.result;
          linked.pnl = trade.isOpen ? null : trade.pnl;
          if (trade.isOpen) {
            linked.notes = "Paper trade opened";
          } else {
            linked.notes = `${trade.result} @ ${formatOdds(trade.exitOdds)}`;
          }
          existingTradeIds.add(trade.tradeId);
          changed = true;
          continue;
        }
      }

      validationSeq += 1;
      const isOpen = Boolean(trade.isOpen);
      match.rows.push({
        id: `sig-backfill-${trade.tradeId}`,
        at: trade.openedAt || trade.closedAt || Date.now(),
        match: trade.match || matchName,
        eventId: String(eventId),
        runner: trade.runner,
        runnerKey: String(trade.runnerKey || trade.runner),
        backOdds: trade.side === "BACK" ? trade.entryOdds : null,
        layOdds: trade.side === "LAY" ? trade.entryOdds : null,
        mem1: null,
        mem2: null,
        mem3: null,
        oldestPrice: null,
        currentPrice: isOpen ? trade.entryOdds : trade.exitOdds,
        priceChangePct: null,
        spikeDirection: trade.side === "BACK" ? "up" : "down",
        paperAction: trade.side,
        entryOdds: trade.entryOdds,
        targetOdds: trade.targetOdds,
        stopOdds: trade.stopOdds,
        currentOdds: isOpen ? trade.entryOdds : trade.exitOdds,
        tradeStatus: isOpen ? "OPEN" : trade.result,
        pnl: isOpen ? null : trade.pnl,
        matchState: "UNKNOWN",
        notes: "Backfilled from paper trade history",
        tradeId: trade.tradeId
      });
      existingTradeIds.add(trade.tradeId);
      changed = true;
    }

    if (changed) {
      match.rows.sort((a, b) => a.at - b.at);
      trimValidationRows(match);
      saveValidationStore();
    }

    return changed;
  }

  function syncValidationForMatch(eventId, matchName) {
    if (!eventId) return;
    consolidateValidationMatches(eventId, matchName);
    backfillValidationFromPaper(eventId, matchName);
  }

  function recordValidationSignal(ctx) {
    const match = ensureValidationMatch(ctx.eventId, ctx.matchName);
    validationSeq += 1;

    const decision = ctx.decision || "NONE";
    let notes = "";
    if (ctx.paperSkipped) {
      notes = SPIKE_ALERT_TESTING
        ? `Paper skipped — max ${TEST_MAX_OPEN_TRADES} open trades`
        : "Paper skipped — max 1 open trade";
    }
    else if (ctx.paperBlockedSuspended) notes = "Paper blocked — market suspended";
    else if (ctx.paperBlockedOutsideOdds) notes = "Paper blocked — odds outside bracket";
    else if (ctx.paperBlocked) notes = "Paper blocked";

    const row = {
      id: `sig-${Date.now()}-${validationSeq}`,
      at: Date.now(),
      match: ctx.matchName,
      eventId: String(ctx.eventId),
      runner: ctx.runnerName,
      runnerKey: String(ctx.runnerKey),
      backOdds: ctx.back,
      layOdds: ctx.lay,
      mem1: ctx.history[0] ?? null,
      mem2: ctx.history[1] ?? null,
      mem3: ctx.history[2] ?? null,
      oldestPrice: ctx.baseline,
      currentPrice: ctx.currentBack,
      priceChangePct: ctx.spikeDelta,
      spikeDirection: ctx.spikeDelta > 0 ? "up" : "down",
      paperAction: decision,
      entryOdds: null,
      targetOdds: null,
      stopOdds: null,
      currentOdds:
        decision === "LAY"
          ? ctx.lay ?? ctx.back
          : decision === "BACK"
            ? ctx.back
            : ctx.back,
      tradeStatus: "NONE",
      pnl: null,
      matchState: ctx.matchState || "UNKNOWN",
      notes,
      tradeId: null
    };

    match.rows.push(row);
    match.rows.sort((a, b) => a.at - b.at);
    trimValidationRows(match);
    void saveValidationStore();

    return row.id;
  }

  function linkValidationTradeOpen(eventId, signalRowId, trade) {
    const row = findValidationRow(eventId, signalRowId);
    if (!row) return;
    row.tradeId = trade.tradeId;
    row.paperAction = trade.side;
    row.entryOdds = trade.entryOdds;
    row.targetOdds = trade.targetOdds;
    row.stopOdds = trade.stopOdds;
    row.currentOdds = trade.entryOdds;
    row.tradeStatus = "OPEN";
    row.notes = "Paper trade opened";
    saveValidationStore();
  }

  function updateValidationTradeClose(trade, options = {}) {
    const match = getValidationMatch(trade.eventId);
    if (!match) return;
    const row = match.rows.find((r) => r.tradeId === trade.tradeId);
    if (!row) return;
    row.tradeStatus = trade.result;
    row.pnl = trade.pnl;
    row.currentOdds = trade.exitOdds;
    row.notes = options.manual
      ? `Manual close @ ${formatOdds(trade.exitOdds)}`
      : `${trade.result} @ ${formatOdds(trade.exitOdds)}`;
    saveValidationStore();
  }

  function refreshValidationOpenOdds(fm) {
    const rows = validationRowsForView(fm.eventId, fm.eventName);
    if (!rows.length) return;
    let changed = false;

    for (const row of rows) {
      if (row.tradeStatus !== "OPEN") continue;
      const runner = fm.runners.find(
        (r) => String(r.runnerId || r.runnerName) === row.runnerKey
      );
      if (!runner) continue;
      const nextOdds = row.paperAction === "LAY" ? runner.lay ?? runner.back : runner.back;
      if (nextOdds != null && nextOdds !== row.currentOdds) {
        row.currentOdds = nextOdds;
        changed = true;
      }
    }

    if (changed) saveValidationStore();
  }

  function getValidationSummary(eventId, matchName) {
    const rows = validationRowsForView(eventId, matchName);
    const closed = rows.filter((r) => r.tradeStatus === "WIN" || r.tradeStatus === "LOSS");
    const pnls = closed.map((r) => r.pnl).filter((v) => v != null);

    let bestTrade = null;
    let worstTrade = null;
    for (const row of closed) {
      if (row.pnl == null) continue;
      if (!bestTrade || row.pnl > bestTrade.pnl) bestTrade = row;
      if (!worstTrade || row.pnl < worstTrade.pnl) worstTrade = row;
    }

    return {
      totalSignals: rows.length,
      spikeUp: rows.filter((r) => r.spikeDirection === "up").length,
      spikeDown: rows.filter((r) => r.spikeDirection === "down").length,
      backWins: rows.filter((r) => r.paperAction === "BACK" && r.tradeStatus === "WIN").length,
      backLosses: rows.filter((r) => r.paperAction === "BACK" && r.tradeStatus === "LOSS").length,
      layWins: rows.filter((r) => r.paperAction === "LAY" && r.tradeStatus === "WIN").length,
      layLosses: rows.filter((r) => r.paperAction === "LAY" && r.tradeStatus === "LOSS").length,
      bestTrade,
      worstTrade,
      netPnl: pnls.reduce((sum, v) => sum + v, 0)
    };
  }

  function validationRowsForView(eventId) {
    if (!eventId) return [];
    const keys = validationKeysForMatch(eventId);
    const seen = new Set();
    const rows = [];

    for (const key of keys) {
      const match = validationStore.matches[key];
      if (!match?.rows?.length) continue;
      for (const row of match.rows) {
        if (seen.has(row.id)) continue;
        if (row.eventId && String(row.eventId) !== String(eventId)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }

    return rows.sort((a, b) => b.at - a.at);
  }

  function clearValidationLogs(eventId, { all = false } = {}) {
    if (all) {
      validationStore.matches = {};
      validationSeq = 0;
    } else if (eventId) {
      const key = String(eventId);
      if (validationStore.matches[key]) validationStore.matches[key].rows = [];
      for (const [k, match] of Object.entries(validationStore.matches)) {
        if (k !== key && String(match.eventId) === key) delete validationStore.matches[k];
      }
    }
    void saveValidationStore();
    panelApi?.render?.(getViewState());
  }

  function buildValidationJsonPayload(eventId, matchName) {
    const rows = validationRowsForView(eventId, matchName);
    if (!rows.length) return null;
    const match = getValidationMatch(eventId);

    return {
      exportedAt: new Date().toISOString(),
      eventId: String(eventId),
      matchName: matchName || match?.matchName || rows[0]?.match || "",
      summary: getValidationSummary(eventId, matchName),
      rows
    };
  }

  async function copyValidationJson(eventId, buttonEl) {
    const ctx = getCurrentMatchContext();
    const payload = buildValidationJsonPayload(eventId, ctx.matchName);
    if (!payload) return;

    const text = JSON.stringify(payload, null, 2);

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }

    if (buttonEl) {
      const prev = buttonEl.textContent;
      buttonEl.textContent = "Copied!";
      window.setTimeout(() => {
        buttonEl.textContent = prev;
      }, 1500);
    }
  }

  function formatInr(amount) {
    if (!Number.isFinite(amount)) return "₹—";
    return `₹${Math.round(amount).toLocaleString("en-IN")}`;
  }

  function roundOdds(value) {
    return Math.round(value * 100) / 100;
  }

  function calcTargetStop(side, entryOdds) {
    if (side === "BACK") {
      return {
        targetOdds: roundOdds(entryOdds * (1 - PAPER_TARGET_PCT)),
        stopOdds: roundOdds(entryOdds * (1 + PAPER_STOP_PCT))
      };
    }
    return {
      targetOdds: roundOdds(entryOdds * (1 + PAPER_TARGET_PCT)),
      stopOdds: roundOdds(entryOdds * (1 - PAPER_STOP_PCT))
    };
  }

  function calcTradePnl(side, entryOdds, exitOdds, stake) {
    if (side === "BACK") return stake * (entryOdds / exitOdds - 1);
    return stake * (exitOdds / entryOdds - 1);
  }

  function pnlFormulaText(side, entryOdds, exitOdds, stake, pnl) {
    if (side === "BACK") {
      return `stake×(entry/exit−1) = ${stake}×(${formatOdds(entryOdds)}/${formatOdds(exitOdds)}−1) = ${pnl.toFixed(2)}`;
    }
    return `stake×(exit/entry−1) = ${stake}×(${formatOdds(exitOdds)}/${formatOdds(entryOdds)}−1) = ${pnl.toFixed(2)}`;
  }

  function expectedResultFromBarriers(trade) {
    const { side, exitOdds, targetOdds, stopOdds } = trade;
    if (side === "BACK") {
      if (exitOdds <= targetOdds) return "WIN";
      if (exitOdds >= stopOdds) return "LOSS";
      return "MID";
    }
    if (exitOdds >= targetOdds) return "WIN";
    if (exitOdds <= stopOdds) return "LOSS";
    return "MID";
  }

  function expectedResultFromPnl(pnl) {
    if (pnl > 0) return "WIN";
    if (pnl < 0) return "LOSS";
    return "FLAT";
  }

  /** User rule-of-thumb: LAY exit>entry alone is not a WIN label. */
  function simpleOddsDirection(side, entryOdds, exitOdds) {
    if (side === "BACK") {
      if (exitOdds < entryOdds) return "profit";
      if (exitOdds > entryOdds) return "loss";
      return "flat";
    }
    if (exitOdds > entryOdds) return "mtm+ (not auto-WIN)";
    if (exitOdds < entryOdds) return "loss";
    return "flat";
  }

  function auditClosedTrade(trade) {
    const pnlRecomputed = calcTradePnl(trade.side, trade.entryOdds, trade.exitOdds, trade.stake);
    const expectedFromBarriers = expectedResultFromBarriers(trade);
    const expectedFromPnl = expectedResultFromPnl(pnlRecomputed);

    return {
      tradeId: trade.tradeId,
      side: trade.side,
      entryOdds: trade.entryOdds,
      exitOdds: trade.exitOdds,
      targetOdds: trade.targetOdds,
      stopOdds: trade.stopOdds,
      actualResult: trade.result,
      expectedFromPnl,
      expectedFromBarriers,
      oddsDirection: simpleOddsDirection(trade.side, trade.entryOdds, trade.exitOdds),
      pnl: trade.pnl,
      pnlRecomputed,
      pnlFormula: pnlFormulaText(trade.side, trade.entryOdds, trade.exitOdds, trade.stake, pnlRecomputed),
      pnlMatchesResult: expectedFromPnl === trade.result,
      barriersMatchResult: expectedFromBarriers === trade.result,
      pnlStoredOk: Math.abs((trade.pnl ?? 0) - pnlRecomputed) < 0.02
    };
  }

  function logPaperTradeAudit(trade) {
    const audit = auditClosedTrade(trade);
    console.log(
      [
        "[Market Radar] Paper trade closed",
        `side=${audit.side}`,
        `entry=${formatOdds(audit.entryOdds)}`,
        `exit=${formatOdds(audit.exitOdds)}`,
        `target=${formatOdds(audit.targetOdds)}`,
        `stop=${formatOdds(audit.stopOdds)}`,
        `actual=${audit.actualResult}`,
        `expected(PnL)=${audit.expectedFromPnl}`,
        `expected(barrier)=${audit.expectedFromBarriers}`,
        `oddsDir=${audit.oddsDirection}`,
        audit.pnlFormula
      ].join(" · ")
    );
  }

  function getPaperAuditRows(limit = 20) {
    return getAllClosedTrades().slice(0, limit).map(auditClosedTrade);
  }

  function getPaperAuditRowsForMatch(eventId, matchName, limit = 20) {
    return getTradesForMatch(eventId, matchName, limit).map(auditClosedTrade);
  }

  function getPaperStats() {
    const closed = getAllClosedTrades();
    const wins = closed.filter((t) => t.result === "WIN").length;
    const losses = closed.filter((t) => t.result === "LOSS").length;
    const totalTrades = closed.length;
    const totalPnl = paper.bankroll - paper.startingBankroll;
    return {
      bankroll: paper.bankroll,
      openCount: getOpenTradeCount(),
      totalTrades,
      wins,
      losses,
      winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
      totalPnl,
      roi: paper.startingBankroll ? (totalPnl / paper.startingBankroll) * 100 : 0
    };
  }

  function paperStatePayload() {
    syncPaperOpenTradeLegacy();
    return {
      enabled: true,
      state: paper.state,
      bankroll: paper.bankroll,
      startingBankroll: paper.startingBankroll,
      openTrade: paper.openTrades[0] || null,
      openTrades: paper.openTrades,
      matchBooks: paper.matchBooks,
      paperTradeSeq
    };
  }

  function savePaperState() {
    paperSessionMutated = true;
    const payload = paperStatePayload();
    storageSet({ [PAPER_STORAGE_KEY]: payload });

    const api = cloudConfigApi();
    if (!api?.saveSystemPaper) return;
    clearTimeout(paperCloudSaveTimer);
    paperCloudSaveTimer = setTimeout(() => {
      void api.saveSystemPaper(payload).catch((error) => {
        console.warn("[SpikeX] Paper cloud save:", error?.message || error);
      });
    }, 400);
  }

  async function refreshSystemPaperFromCloud() {
    const api = cloudConfigApi();
    if (!api?.loadSystemPaper) return;
    try {
      const remote = await api.loadSystemPaper();
      if (remote) applyPaperState(remote, { force: true });
    } catch (error) {
      console.warn("[SpikeX] Paper cloud load:", error?.message || error);
    }
  }

  function migrateLegacyTrades(saved) {
    paper.matchBooks = saved.matchBooks && typeof saved.matchBooks === "object" ? saved.matchBooks : {};
    if (Array.isArray(saved.trades) && saved.trades.length) {
      for (const trade of saved.trades) {
        const book = ensureMatchPaperBook(trade.eventId, trade.match);
        if (!book.trades.some((t) => t.tradeId === trade.tradeId)) {
          book.trades.push(trade);
        }
      }
      for (const book of Object.values(paper.matchBooks)) {
        book.trades.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
        if (book.trades.length > 50) book.trades = book.trades.slice(0, 50);
      }
    }
  }

  function applyPaperState(saved, { force = false } = {}) {
    if (!saved) {
      if (paperSessionMutated && !force) return;
      paper.enabled = true;
      paper.state = "FLAT";
      paper.bankroll = PAPER_STARTING_BANKROLL;
      paper.startingBankroll = PAPER_STARTING_BANKROLL;
      paper.openTrades = [];
      syncPaperOpenTradeLegacy();
      return;
    }
    if (paperSessionMutated && !force) return;
    paper.enabled = true;
    paper.bankroll = Number(saved.bankroll) || PAPER_STARTING_BANKROLL;
    paper.startingBankroll = Number(saved.startingBankroll) || PAPER_STARTING_BANKROLL;
    if (Array.isArray(saved.openTrades) && saved.openTrades.length) {
      paper.openTrades = saved.openTrades;
    } else if (saved.openTrade) {
      paper.openTrades = [saved.openTrade];
    } else {
      paper.openTrades = [];
    }
    syncPaperOpenTradeLegacy();
    migrateLegacyTrades(saved);
    paperTradeSeq = Number(saved.paperTradeSeq) || getAllClosedTrades().length;
  }

  async function loadPaperState() {
    const api = cloudConfigApi();
    if (api?.loadSystemPaper) {
      try {
        const remote = await api.loadSystemPaper();
        if (remote) {
          applyPaperState(remote, { force: true });
          await storageSet({ [PAPER_STORAGE_KEY]: paperStatePayload() });
          return;
        }
      } catch (error) {
        console.warn("[SpikeX] Paper cloud load:", error?.message || error);
      }
    }

    const data = await storageGet(PAPER_STORAGE_KEY);
    const saved = data[PAPER_STORAGE_KEY];
    if (saved) applyPaperState(saved, { force: true });
  }

  function isPaperOpenTradeStale(trade) {
    if (!trade) return false;
    const age = Date.now() - (trade.openedAt || 0);
    if (age > 2 * 60 * 60 * 1000) return true;
    const fm = board.focusedMatch;
    if (fm?.eventId && trade.eventId && String(fm.eventId) !== String(trade.eventId)) {
      return true;
    }
    return false;
  }

  async function clearStalePaperTradeIfNeeded() {
    for (const open of [...getOpenTrades()]) {
      if (!isPaperOpenTradeStale(open)) continue;
      const exitOdds = getOpenTradeExitPrice(open);
      const pnl = calcTradePnl(open.side, open.entryOdds, exitOdds, open.stake);
      closePaperTrade(exitOdds, pnl >= 0 ? "WIN" : "LOSS", {
        manual: true,
        stale: true,
        tradeId: open.tradeId
      });
    }
  }

  function formatPaperOpenMessage(trade) {
    return [
      "📈 PAPER TRADE OPEN",
      "",
      `Match: ${trade.match}`,
      `Runner: ${trade.runner}`,
      `Side: ${trade.side}`,
      "",
      `Entry: ${formatOdds(trade.entryOdds)}`,
      `Target: ${formatOdds(trade.targetOdds)}`,
      `Stop: ${formatOdds(trade.stopOdds)}`,
      "",
      `Bankroll: ${formatInr(trade.bankrollAtEntry)}`,
      `Stake: ${formatInr(trade.stake)}`
    ].join("\n");
  }

  function formatPaperCloseMessage(trade) {
    const header = trade.result === "WIN" ? "✅ PAPER TRADE WIN" : "❌ PAPER TRADE LOSS";
    return [
      header,
      "",
      `Match: ${trade.match}`,
      `Runner: ${trade.runner}`,
      "",
      `Entry: ${formatOdds(trade.entryOdds)}`,
      `Exit: ${formatOdds(trade.exitOdds)}`,
      "",
      `PnL: ${formatInr(trade.pnl)}`,
      `Bankroll: ${formatInr(paper.bankroll)}`
    ].join("\n");
  }

  function formatPaperManualCloseMessage(trade) {
    return [
      "📤 PAPER TRADE CLOSED (manual)",
      "",
      `Match: ${trade.match}`,
      `Runner: ${trade.runner}`,
      `Side: ${trade.side}`,
      "",
      `Entry: ${formatOdds(trade.entryOdds)}`,
      `Exit: ${formatOdds(trade.exitOdds)}`,
      "",
      `PnL: ${formatInr(trade.pnl)}`,
      `Bankroll: ${formatInr(paper.bankroll)}`
    ].join("\n");
  }

  function sendPaperTelegram(text) {
    if (!settings.telegramAlertsEnabled) return;
    void sendTelegramMessage(text);
  }

  function getPaperOpenBlockReason(spikeEntry, eventId, runnerKey) {
    const openTrades = getOpenTrades();
    const maxOpen = getMaxOpenTrades();

    if (SPIKE_ALERT_TESTING) {
      if (openTrades.length >= maxOpen) {
        return `Max ${maxOpen} open trades (testing)`;
      }
      const duplicate = openTrades.find(
        (t) =>
          String(t.eventId) === String(eventId) &&
          String(t.runnerKey) === String(runnerKey) &&
          !isPaperOpenTradeStale(t)
      );
      if (duplicate) {
        return `Already open on ${duplicate.runner}`;
      }
    } else if (openTrades.length) {
      const open = openTrades[0];
      return open.match
        ? `Already in trade on ${open.runner} (${open.match})`
        : `Already in trade on ${open.runner} (max 1 open)`;
    }
    if (spikeEntry.marketSuspended || spikeEntry.runnerSuspended) {
      return "Market or runner suspended";
    }

    const side = spikeEntry.decision || bracketTradeHypothesis(spikeEntry.delta);
    const entryOdds = normalizeOdds(
      spikeEntry.entryPrice ?? spikeEntryPrice(side, spikeEntry.to, spikeEntry.lay)
    );
    if (!side || entryOdds == null || entryOdds < 1.01) {
      return "Invalid entry side or odds";
    }
    if (!isPriceInBracket(entryOdds, board.focusedMatch?.sportName, board.focusedMatch?.sportId)) {
      return `Entry odds ${formatOdds(entryOdds)} outside bracket (${getOddsBracketLabel(board.focusedMatch?.sportName, board.focusedMatch?.sportId)})`;
    }

    const stake = Math.round(paper.bankroll * PAPER_POSITION_PCT);
    if (stake <= 0) {
      return `Insufficient bankroll (${formatInr(paper.bankroll)})`;
    }
    return null;
  }

  function formatPaperSkipMessage(entry, reason) {
    const decision = entry.decision || bracketTradeHypothesis(entry.delta);
    return [
      "⏭️ PAPER TRADE SKIPPED",
      "",
      `Match: ${entry.matchName}`,
      `Runner: ${entry.runnerName}`,
      `Side: ${spikeActionLabel(decision)}`,
      `Entry: ${formatOdds(entry.entryPrice ?? spikeEntryPrice(decision, entry.to, entry.lay))}`,
      "",
      `Reason: ${reason}`
    ].join("\n");
  }

  function openPaperTradeSync(spikeEntry, eventId, runnerKey, signalRowId) {
    const blockReason = getPaperOpenBlockReason(spikeEntry, eventId, runnerKey);
    if (blockReason) return { trade: null, blockReason };

    const side = spikeEntry.decision || bracketTradeHypothesis(spikeEntry.delta);
    const entryOdds = normalizeOdds(
      spikeEntry.entryPrice ?? spikeEntryPrice(side, spikeEntry.to, spikeEntry.lay)
    );
    const stake = Math.round(paper.bankroll * PAPER_POSITION_PCT);
    const levels = calcTargetStop(side, entryOdds);
    paperTradeSeq += 1;

    const trade = {
      tradeId: `pt-${Date.now()}-${paperTradeSeq}`,
      eventId: String(eventId),
      runnerKey: String(runnerKey),
      match: spikeEntry.matchName,
      runner: spikeEntry.runnerName,
      side,
      entryOdds,
      targetOdds: levels.targetOdds,
      stopOdds: levels.stopOdds,
      stake,
      bankrollAtEntry: paper.bankroll,
      openedAt: Date.now(),
      signalRowId: signalRowId || null
    };

    paper.openTrades.push(trade);
    syncPaperOpenTradeLegacy();
    ensureMatchPaperBook(eventId, spikeEntry.matchName);
    if (signalRowId) linkValidationTradeOpen(eventId, signalRowId, trade);
    savePaperState();

    return { trade, blockReason: null };
  }

  function tryOpenPaperTrade(spikeEntry, eventId, runnerKey, signalRowId, done) {
    if (!PAPER_TRADING_ENABLED) return;
    const finish = (trade, blockReason) => {
      if (trade) {
        sendPaperTelegram(formatPaperOpenMessage(trade));
      } else if (blockReason) {
        sendPaperTelegram(formatPaperSkipMessage(spikeEntry, blockReason));
      }
      panelApi?.render?.(getViewState());
      done?.(trade, blockReason);
    };

    void (async () => {
      await refreshSystemPaperFromCloud();
      await clearStalePaperTradeIfNeeded();
      const { trade, blockReason } = openPaperTradeSync(spikeEntry, eventId, runnerKey, signalRowId);
      finish(trade, blockReason);
    })();
  }

  function resolveDemoTradeLevels(tradeOrSide, entryOddsMaybe) {
    if (tradeOrSide?.targetOdds != null && tradeOrSide?.stopOdds != null) {
      return { targetOdds: tradeOrSide.targetOdds, stopOdds: tradeOrSide.stopOdds };
    }
    const side = tradeOrSide?.side || tradeOrSide;
    const entryOdds = tradeOrSide?.entryOdds ?? entryOddsMaybe;
    return calcTargetStop(side, entryOdds);
  }

  function appendTargetStopLines(lines, levels) {
    lines.push(
      "",
      "Target:",
      formatOdds(levels.targetOdds),
      "",
      "Stop:",
      formatOdds(levels.stopOdds)
    );
  }

  function markDemoTradeUpdateSent(tradeId, currentOdds) {
    demoTradeUpdateState.set(tradeId, {
      lastSentAt: Date.now(),
      lastOdds: currentOdds
    });
  }

  function seedDemoTradeUpdateStateFromLedger() {
    const dt = demoTrader();
    if (!dt) return;
    const now = Date.now();
    for (const open of dt.getOpenTrades()) {
      if (demoTradeUpdateState.has(open.tradeId)) continue;
      demoTradeUpdateState.set(open.tradeId, {
        lastSentAt: now,
        lastOdds: open.entryOdds ?? null
      });
    }
  }

  function ensureDemoTradeUpdateBaseline(tradeId, currentOdds) {
    if (demoTradeUpdateState.has(tradeId)) return true;
    demoTradeUpdateState.set(tradeId, {
      lastSentAt: Date.now(),
      lastOdds: currentOdds
    });
    return false;
  }

  function clearDemoTradeUpdateState(tradeId) {
    demoTradeUpdateState.delete(tradeId);
  }

  function shouldSendDemoTradeUpdate(tradeId, currentOdds) {
    const prev = demoTradeUpdateState.get(tradeId);
    if (!prev) return false;

    const elapsed = Date.now() - prev.lastSentAt;
    if (elapsed < DEMO_TRADE_UPDATE_MIN_MS) return false;
    if (prev.lastOdds == null || !Number.isFinite(prev.lastOdds)) return true;
    if (Math.abs(currentOdds - prev.lastOdds) >= DEMO_TRADE_UPDATE_ODDS_EPS) return true;
    return elapsed >= DEMO_TRADE_UPDATE_HEARTBEAT_MS;
  }

  function openTradeMatchesFocus(open, fm) {
    if (!open || !fm) return false;
    if (String(open.eventId) === String(fm.eventId)) return true;

    const openMatch = normalizeChartKey(open.match || "");
    const fmMatch = normalizeChartKey(fm.eventName || "");
    if (!openMatch || !fmMatch) return false;
    return openMatch === fmMatch || openMatch.includes(fmMatch) || fmMatch.includes(openMatch);
  }

  function findRunnerForOpenTrade(open, runners) {
    if (!runners?.length) return null;

    const tradeKeys = new Set(
      [
        String(open.runnerKey || ""),
        String(open.runner || ""),
        normalizeChartKey(open.runner || ""),
        chartKeySlug(open.runner || "")
      ].filter(Boolean)
    );

    for (const runner of runners) {
      for (const key of runnerKeysForLookup(runner)) {
        if (tradeKeys.has(key)) return runner;
      }
    }

    const target = normalizeChartKey(open.runner || "");
    if (!target) return null;
    return (
      runners.find((runner) => normalizeChartKey(runner.runnerName) === target) ||
      runners.find(
        (runner) =>
          normalizeChartKey(runner.runnerName).includes(target) ||
          target.includes(normalizeChartKey(runner.runnerName))
      ) ||
      null
    );
  }

  function pruneDemoTradeUpdateState(openTradeIds) {
    for (const id of demoTradeUpdateState.keys()) {
      if (!openTradeIds.has(id)) demoTradeUpdateState.delete(id);
    }
  }

  function demoEntryStake() {
    return demoTrader()?.getStake?.() || 100;
  }

  function getDemoTradeCurrentOdds(open, runner) {
    return normalizeOdds(open.side === "BACK" ? runner.back : runner.lay ?? runner.back);
  }

  function formatSideOrderLine(side, odds, stake) {
    return `${spikeActionLabel(side)} @ ${formatOdds(odds)} · ${formatInr(stake)}`;
  }

  function appendExitPlanLines(lines) {
    lines.push(
      "",
      "Exit:",
      "Target odds → Cash Out",
      "Stop odds → Loss Cut",
      "(Cricway auto-hedges — no manual opposite bet)"
    );
  }

  function formatDemoOpenUpdateTelegram(trade, runner) {
    const currentOdds = getDemoTradeCurrentOdds(trade, runner);
    const levels = resolveDemoTradeLevels(trade);

    return [
      "📊 Open Trade Update",
      "",
      "Match:",
      trade.match || "—",
      "",
      "Selection:",
      trade.runner || "—",
      "",
      "Trade ID:",
      trade.tradeId,
      "",
      "Entry:",
      formatSideOrderLine(trade.side, trade.entryOdds, trade.stake),
      "",
      "Now:",
      `${spikeActionLabel(trade.side)} @ ${formatOdds(currentOdds)}`,
      "",
      "Target:",
      formatOdds(levels.targetOdds),
      "",
      "Stop:",
      formatOdds(levels.stopOdds),
      "",
      "Exit plan:",
      "Target → Cash Out · Stop → Loss Cut",
      "",
      "Status:",
      "OPEN — monitoring"
    ].join("\n");
  }

  function formatDemoEntryTelegram(entry, trade, error, statusOverride) {
    const side = trade?.side || entry.decision || bracketTradeHypothesis(entry.delta);
    const entryOdds = normalizeOdds(
      trade?.entryOdds ?? entry.entryPrice ?? spikeEntryPrice(side, entry.to, entry.lay)
    );
    const stake = trade?.stake ?? demoEntryStake();
    const levels = resolveDemoTradeLevels(trade || { side, entryOdds }, entryOdds);
    const sign = entry.delta > 0 ? "+" : "";
    const lines = [
      "⚡ Spike Detected",
      "",
      "Match:",
      entry.matchName || "—",
      "",
      "Market:",
      "Match Odds",
      "",
      "Selection:",
      entry.runnerName || "—",
      "",
      "Entry:",
      formatSideOrderLine(side, entryOdds, stake),
      "",
      "Spike:",
      `${sign}${Number(entry.delta).toFixed(0)}%`,
      "",
      "Memory:",
      String(MEMORY_DEPTH)
    ];
    appendTargetStopLines(lines, levels);
    appendExitPlanLines(lines);
    lines.push("", "Mode:", "Click only — your 1-click stake");
    if (statusOverride) {
      lines.push("", "Status:", statusOverride);
    } else if (trade) {
      lines.push("", "Status:", "EXECUTED", "", "Trade ID:", trade.tradeId);
    } else {
      lines.push("", "Status:", "FAILED", "", "Error:", error || "Unknown");
    }
    return lines.join("\n");
  }

  function notifyManualSpike(entry) {
    activeAlert = entry;
    alertFlashUntil = Date.now() + ALERT_FLASH_MS;
    playSpikeTone();
    panelApi?.flashHeader?.();
    // Telegram is sent once from the Gemini opportunity gate, not here.
    panelApi?.render?.(getViewState());
  }

  function formatDemoExitTelegram(trade) {
    const levels = resolveDemoTradeLevels(trade);
    const isLossCut =
      trade.exitMethod === "losscut" ||
      trade.exitSide === "LOSS CUT" ||
      /stop/i.test(String(trade.exitReason || ""));
    const exitLabel = isLossCut ? "Loss Cut" : "Cash Out";
    const title = isLossCut ? "🛑 LOSS CUT" : "💰 CASH OUT";
    const stake = Number(trade.stake) || 0;
    const pnl = Number(trade.pnl);
    const pnlPct = stake > 0 && Number.isFinite(pnl) ? ((pnl / stake) * 100).toFixed(1) : null;
    const lines = [
      title,
      "",
      "Match:",
      trade.match || "—",
      "",
      "Selection:",
      trade.runner || "—",
      "",
      "Side:",
      trade.side || "—",
      "",
      "Entry:",
      formatOdds(trade.entryOdds),
      "",
      "Exit:",
      `${exitLabel} @ ${formatOdds(trade.exitOdds)}`,
      "",
      "Target was:",
      formatOdds(levels.targetOdds),
      "",
      "Stop was:",
      formatOdds(levels.stopOdds),
      "",
      "PnL:",
      `${formatInr(trade.pnl)}${pnlPct != null ? ` (${pnlPct}% of stake)` : ""}${trade.pnlEstimated ? " (est.)" : ""}`
    ];
    if (Number(trade.pnl) > 0) {
      lines.push("", "Status:", "Match done — no more entries");
    } else {
      lines.push("", "Status:", "Stop hit — one more entry allowed if a fresh 20% spike comes");
    }
    return lines.join("\n");
  }

  function tryExecuteDemoTrade(spikeEntry, eventId, runnerKey, signalRowId) {
    const dt = demoTrader();
    if (!DEMO_TRADING_ENABLED || !dt) return;

    void (async () => {
      const side = spikeEntry.decision || bracketTradeHypothesis(spikeEntry.delta);
      const entryOdds = normalizeOdds(
        spikeEntry.entryPrice ?? spikeEntryPrice(side, spikeEntry.to, spikeEntry.lay)
      );

      const levels = calcTargetStop(side, entryOdds);

      const result = await dt.executeEntry({
        runnerName: spikeEntry.runnerName,
        side,
        entryOdds,
        targetOdds: levels.targetOdds,
        stopOdds: levels.stopOdds,
        eventId,
        runnerKey,
        matchName: spikeEntry.matchName,
        marketName: "Match Odds",
        signalRowId
      });

      if (result.ok && result.trade && signalRowId) {
        markDemoTradeUpdateSent(result.trade.tradeId, result.trade.entryOdds);
        linkValidationTradeOpen(eventId, signalRowId, {
          tradeId: result.trade.tradeId,
          side: result.trade.side,
          entryOdds: result.trade.entryOdds,
          targetOdds: result.trade.targetOdds,
          stopOdds: result.trade.stopOdds,
          runner: result.trade.runner
        });
      } else if (!result.ok && settings.telegramAlertsEnabled) {
        void sendTelegramAlert(
          [
            "⚠️ ENTRY noted — auto click failed",
            "",
            result.error || "Could not place BACK/LAY",
            "",
            "Still watching odds for Cash Out / Loss Cut."
          ].join("\n"),
          "entry-click-failed"
        );
      }

      panelApi?.render?.(getViewState());
    })();
  }

  function closePaperTrade(exitOdds, result, options = {}) {
    const openTrades = getOpenTrades();
    const open = options.tradeId
      ? findOpenTrade(options.tradeId)
      : openTrades[0] || null;
    if (!open) return false;

    const pnl = calcTradePnl(open.side, open.entryOdds, exitOdds, open.stake);
    const closed = {
      ...open,
      closedAt: Date.now(),
      exitOdds,
      result,
      pnl,
      pnlPercent: open.stake ? (pnl / open.stake) * 100 : 0,
      manualClose: Boolean(options.manual)
    };

    paper.bankroll += pnl;
    const book = ensureMatchPaperBook(open.eventId, open.match);
    book.trades.unshift(closed);
    while (book.trades.length > 50) book.trades.pop();
    paper.openTrades = openTrades.filter((t) => t.tradeId !== open.tradeId);
    syncPaperOpenTradeLegacy();
    savePaperState();
    logPaperTradeAudit(closed);
    updateValidationTradeClose(closed, options);
    saveGeminiTradeResult(closed);
    if (options.manual && !options.stale) {
      sendPaperTelegram(formatPaperManualCloseMessage(closed));
    } else if (!options.manual) {
      sendPaperTelegram(formatPaperCloseMessage(closed));
    }
    panelApi?.render?.(getViewState());
    return true;
  }

  function getOpenTradeExitPrice(openTrade) {
    const fm = board.focusedMatch;
    if (fm && String(fm.eventId) === String(openTrade.eventId)) {
      const runner = fm.runners?.find(
        (r) => String(r.runnerId || r.runnerName) === String(openTrade.runnerKey)
      );
      if (runner) {
        const price = normalizeOdds(
          openTrade.side === "BACK" ? runner.back : runner.lay ?? runner.back
        );
        if (price != null) return price;
      }
    }
    return openTrade.entryOdds;
  }

  function closePaperTradeManually(tradeId) {
    const open = tradeId ? findOpenTrade(tradeId) : getOpenTrades()[0];
    if (!open) return false;
    const exitOdds = getOpenTradeExitPrice(open);
    const pnl = calcTradePnl(open.side, open.entryOdds, exitOdds, open.stake);
    const result = pnl >= 0 ? "WIN" : "LOSS";
    return closePaperTrade(exitOdds, result, { manual: true, tradeId: open.tradeId });
  }

  function resetPaperAndValidation() {
    paper.enabled = true;
    paper.state = "FLAT";
    paper.bankroll = PAPER_STARTING_BANKROLL;
    paper.startingBankroll = PAPER_STARTING_BANKROLL;
    paper.openTrades = [];
    syncPaperOpenTradeLegacy();
    paper.matchBooks = {};
    paperTradeSeq = 0;
    paperSessionMutated = true;
    savePaperState();

    validationStore.matches = {};
    validationSeq = 0;
    saveValidationStore();

    clearSpikeMemory();
    clearChartHistory();
    selectedRunnerKey = null;
    panelApi?.render?.(getViewState());
    return true;
  }

  function checkDemoTradeUpdates(fm) {
    const dt = demoTrader();
    if (!DEMO_TRADING_ENABLED || !dt || !fm?.runners?.length || !isMarketTradable(fm)) return;
    if (!TELEGRAM_DEMO_UPDATES || !settings.telegramAlertsEnabled) return;

    const openTrades = dt.getOpenTrades();
    const openIds = new Set(openTrades.map((t) => t.tradeId));

    for (const open of openTrades) {
      if (!openTradeMatchesFocus(open, fm)) continue;

      const runner = findRunnerForOpenTrade(open, fm.runners);
      if (!runner) continue;

      const currentOdds = getDemoTradeCurrentOdds(open, runner);
      if (currentOdds == null) continue;
      if (!ensureDemoTradeUpdateBaseline(open.tradeId, currentOdds)) continue;
      if (!shouldSendDemoTradeUpdate(open.tradeId, currentOdds)) continue;

      markDemoTradeUpdateSent(open.tradeId, currentOdds);
      void sendTelegramMessage(formatDemoOpenUpdateTelegram(open, runner));
    }

    pruneDemoTradeUpdateState(openIds);
  }

  function checkDemoTradeExit(fm) {
    const dt = demoTrader();
    if (!DEMO_TRADING_ENABLED || !isAutoTradingEnabled() || !dt || !fm?.runners?.length || !isMarketTradable(fm)) {
      return;
    }

    void dt.checkExits(
      (open) => {
        const runner = findRunnerForOpenTrade(open, fm.runners);
        if (!runner || !openTradeMatchesFocus(open, fm)) return null;
        return { back: runner.back, lay: runner.lay };
      },
      (open, currentOdds) => {
        const levels =
          open.targetOdds != null && open.stopOdds != null
            ? { targetOdds: open.targetOdds, stopOdds: open.stopOdds }
            : calcTargetStop(open.side, open.entryOdds);
        if (open.side === "BACK") {
          if (currentOdds <= levels.targetOdds) return { exit: true, reason: "Profit Target" };
          if (currentOdds >= levels.stopOdds) return { exit: true, reason: "Stop Loss" };
        } else {
          if (currentOdds >= levels.targetOdds) return { exit: true, reason: "Profit Target" };
          if (currentOdds <= levels.stopOdds) return { exit: true, reason: "Stop Loss" };
        }
        return { exit: false };
      }
    ).then((results) => {
      for (const result of results) {
        if (!result?.ok || !result.trade) continue;
        clearDemoTradeUpdateState(result.trade.tradeId);
        updateValidationTradeClose(
          {
            tradeId: result.trade.tradeId,
            result: result.trade.pnl >= 0 ? "WIN" : "LOSS",
            exitOdds: result.trade.exitOdds,
            pnl: result.trade.pnl,
            side: result.trade.side,
            entryOdds: result.trade.entryOdds
          },
          { manual: false }
        );
        saveGeminiTradeResult(result.trade);
        markMatchTradeClosed(result.trade.eventId, result.trade.pnl);
      }
      if (results.length) panelApi?.render?.(getViewState());
    });
  }

  function checkPaperTradeExit(fm) {
    if (!PAPER_TRADING_ENABLED) return;
    if (!fm?.runners?.length || !isMarketTradable(fm)) return;

    for (const open of [...getOpenTrades()]) {
      if (String(fm.eventId) !== String(open.eventId)) continue;

      const runner = fm.runners.find(
        (r) => String(r.runnerId || r.runnerName) === String(open.runnerKey)
      );
      if (!runner || !isRunnerTradable(runner, fm)) continue;

      const price = open.side === "BACK" ? runner.back : runner.lay ?? runner.back;
      if (price == null || !Number.isFinite(price)) continue;

      if (open.side === "BACK") {
        if (price <= open.targetOdds) closePaperTrade(price, "WIN", { tradeId: open.tradeId });
        else if (price >= open.stopOdds) closePaperTrade(price, "LOSS", { tradeId: open.tradeId });
        continue;
      }

      if (price >= open.targetOdds) closePaperTrade(price, "WIN", { tradeId: open.tradeId });
      else if (price <= open.stopOdds) closePaperTrade(price, "LOSS", { tradeId: open.tradeId });
    }
  }

  function spikeDecision(delta) {
    return bracketTradeHypothesis(delta);
  }

  function spikeActionLabel(decision) {
    if (decision === "BACK") return "BACK";
    if (decision === "LAY") return "LAY";
    return "—";
  }

  function spikeReason(decision) {
    if (decision === "BACK") return "Locked v1 hypothesis: spike up → BACK (research)";
    if (decision === "LAY") return "Locked v1 hypothesis: spike down → LAY (research)";
    return "";
  }

  function spikeEntryPrice(decision, back, lay) {
    const backOdds = normalizeOdds(back);
    const layOdds = normalizeOdds(lay);
    if (decision === "BACK") return backOdds;
    if (decision === "LAY") return layOdds ?? backOdds;
    return backOdds;
  }

  function formatOdds(price) {
    return price != null && Number.isFinite(price) ? Number(price).toFixed(2) : "—";
  }

  function resolveLiveMatchName(fallback = "") {
    const fm = board.focusedMatch;
    const ctx = getCurrentMatchContext();
    if (fm?.eventName && fm.eventName !== "Live match") return fm.eventName;
    if (ctx.matchName) return ctx.matchName;
    if (fm?.runners?.length) {
      const built = buildMatchNameFromRunners(fm.runners);
      if (built && built !== "Live match") return built;
    }
    const hint = getPageMatchHintFromDom();
    if (hint) return hint.slice(0, 120);
    return fallback || fm?.eventName || "Live match";
  }

  function buildSpikeEntry(base) {
    const fm = board.focusedMatch;
    return {
      ...base,
      matchName: resolveLiveMatchName(base.matchName),
      runnerName: base.runnerName || "—",
      sportName: base.sportName || fm?.sportName || null,
      tournament: base.tournament || fm?.competitionName || null,
      eventId: base.eventId || fm?.eventId || getCurrentMatchContext().eventId || null,
      pageUrl: location.href
    };
  }

  function buildGeminiReviewPayload(entry, ctx, signalRowId) {
    const structured = buildStructuredMatchContext();
    const matchContextText = formatMatchContextForPrompt(structured);
    return {
      reviewId: signalRowId,
      eventId: String(ctx.eventId),
      sport: entry.sportName || board.focusedMatch?.sportName || "Unknown",
      tournament: entry.tournament || board.focusedMatch?.competitionName || "—",
      match: entry.matchName || ctx.matchName,
      market: "Match Odds",
      runner: entry.runnerName || ctx.runnerName,
      oldOdds: ctx.baseline,
      newOdds: entry.to ?? ctx.currentBack,
      spikePct: ctx.spikeDelta,
      timestamp: new Date(entry.at || Date.now()).toISOString(),
      marketContext: {
        previousOdds: ctx.baseline ?? null,
        currentOdds: entry.to ?? ctx.currentBack ?? null,
        spikePercent: ctx.spikeDelta ?? null,
        timestamp: new Date(entry.at || Date.now()).toISOString()
      },
      matchContext: structured || undefined,
      // prompt helper still accepts string; keep serialized copy for Gemini text
      matchContextText: matchContextText || undefined
    };
  }

  async function requestGeminiTradeApproval(entry, ctx, signalRowId) {
    if (!signalRowId || !ctx?.eventId) {
      return { approved: false, error: "missing signal or event id" };
    }
    const api = geminiReviewApi();
    if (!api?.reviewSpike) {
      return { approved: false, error: "Gemini module not loaded" };
    }

    const result = await api.reviewSpike(buildGeminiReviewPayload(entry, ctx, signalRowId));
    const review = result?.review;
    if (!review?.classification) {
      return {
        approved: false,
        error: result?.error || "Gemini review failed",
        classification: null
      };
    }

    const classification = review.classification;
    const confidence =
      review.confidence != null && Number.isFinite(Number(review.confidence))
        ? Number(review.confidence)
        : null;
    const classOk = classification === GEMINI_APPROVE_CLASSIFICATION;
    const confOk = confidence != null && confidence >= GEMINI_MIN_APPROVE_CONFIDENCE;
    const approved = classOk && confOk;

    let rejectReason = null;
    if (classOk && !confOk) {
      rejectReason =
        confidence == null
          ? `missing confidence (need ≥${Math.round(GEMINI_MIN_APPROVE_CONFIDENCE * 100)}%)`
          : `low confidence ${Math.round(confidence * 100)}% (need ≥${Math.round(GEMINI_MIN_APPROVE_CONFIDENCE * 100)}%)`;
    }

    return {
      approved,
      classification,
      confidence,
      shortReason: review.shortReason || "",
      model: review.model || null,
      rejectReason,
      error: result?.error || null
    };
  }

  function patchValidationGeminiGate(eventId, signalRowId, gate) {
    const row = findValidationRow(eventId, signalRowId);
    if (!row) return;

    if (gate.pending) {
      row.notes = "Gemini suggestion pending…";
      void saveValidationStore();
      return;
    }

    if (gate.classification) {
      row.geminiClassification = gate.classification;
      row.geminiConfidence = gate.confidence ?? null;
    }

    const conf =
      gate.confidence != null && Number.isFinite(gate.confidence)
        ? ` (${Math.round(gate.confidence * 100)}%)`
        : "";
    const reason = gate.shortReason ? ` — ${gate.shortReason.slice(0, 80)}` : "";

    if (gate.error && !gate.classification) {
      row.notes = `Gemini suggestion unavailable: ${String(gate.error).slice(0, 100)}`;
    } else {
      row.notes = `Gemini: ${gate.classification || "no classification"}${conf}${reason}`;
    }

    void saveValidationStore();
  }

  function formatGeminiGateMessage(entry, gate, approved) {
    const decision = entry.decision || bracketTradeHypothesis(entry.delta);
    const sign = entry.delta > 0 ? "+" : "";
    const lines = [
      approved ? "✅ GEMINI APPROVED — TRADE" : "🛑 GEMINI BLOCKED — NO TRADE",
      "",
      "Match:",
      entry.matchName || "—",
      "",
      "Runner:",
      entry.runnerName || "—",
      "",
      "Odds:",
      `${formatOdds(entry.from)} → ${formatOdds(entry.to)}`,
      "",
      `Spike: ${sign}${Number(entry.delta).toFixed(1)}%`,
      `Would trade: ${spikeActionLabel(decision)} @ ${formatOdds(entry.entryPrice ?? spikeEntryPrice(decision, entry.to, entry.lay))}`,
      ""
    ];
    if (gate.classification) {
      lines.push(`Classification: ${gate.classification}`);
      if (gate.confidence != null) lines.push(`Confidence: ${Math.round(gate.confidence * 100)}%`);
      if (!approved && gate.rejectReason) lines.push(`Blocked: ${gate.rejectReason}`);
      if (gate.shortReason) lines.push("", gate.shortReason);
    } else if (gate.error) {
      lines.push(`Error: ${gate.error}`);
    }
    return lines.join("\n");
  }

  async function handleSpikeAfterGemini({ entry, eventId, runnerKey, signalRowId, tradeSkipped, ctx }) {
    const row = findValidationRow(eventId, signalRowId);
    if (row) {
      const decision = entry.decision || bracketTradeHypothesis(entry.delta);
      row.notes = `Rule: ${spikeActionLabel(decision)} · ${Number(entry.delta).toFixed(1)}% · no Gemini`;
      void saveValidationStore();
    }

    if (GEMINI_ON_AUTO_SPIKE) {
      void (async () => {
        patchValidationGeminiGate(eventId, signalRowId, { pending: true });
        let gate = { approved: false, error: "Gemini review failed" };
        try {
          gate = await requestGeminiTradeApproval(entry, ctx, signalRowId);
        } catch (error) {
          gate = { approved: false, error: error?.message || "Gemini review failed" };
        }
        patchValidationGeminiGate(eventId, signalRowId, gate);
        panelApi?.render?.(getViewState());
      })();
    }

    if (tradeSkipped) return;

    if (DEMO_TRADING_ENABLED) {
      if (isAutoTradingEnabled()) {
        tryExecuteDemoTrade(entry, eventId, runnerKey, signalRowId);
      } else {
        notifyManualSpike(entry);
      }
      return;
    }

    if (SPIKE_ALERT_TESTING) triggerSpikeAlert(entry);
    tryOpenPaperTrade(entry, eventId, runnerKey, signalRowId);
  }

  function saveGeminiTradeResult(trade) {
    if (!trade?.signalRowId || !trade?.eventId) return;
    void geminiReviewApi()?.saveTradeResult?.({
      reviewId: trade.signalRowId,
      eventId: trade.eventId,
      match: trade.match,
      runner: trade.runner,
      pnl: trade.pnl ?? null,
      tradeId: trade.tradeId,
      exitOdds: trade.exitOdds ?? null,
      tradeResult: trade.result || (trade.pnl >= 0 ? "WIN" : "LOSS")
    });
  }

  function expertRunnerOptions(fm) {
    return (fm?.runners || []).filter((r) => r?.runnerName && !/^(the\s*)?draw$/i.test(r.runnerName));
  }

  function expertRunnerQuote(runner) {
    return normalizeOdds(runner?.back ?? runner?.lay);
  }

  function expertFillFromMatch(runnerNameHint = null) {
    forceTrackCurrentMatch();
    const reduxFm = isReduxFocusedMatch(board.focusedMatch) ? board.focusedMatch : null;
    syncLivePageMatch(reduxFm);
    if (board.focusedMatch && reduxFm) {
      board.focusedMatch = mergeDomWithRedux(board.focusedMatch, reduxFm);
    }

    const fm = board.focusedMatch;
    if (!fm?.runners?.length) return null;

    const runners = expertRunnerOptions(fm);
    let runner = null;
    if (runnerNameHint) {
      runner =
        fm.runners.find((r) => normalizeChartKey(r.runnerName) === normalizeChartKey(runnerNameHint)) ||
        null;
    }
    if (selectedRunnerKey && String(selectedRunnerKey).startsWith(`${fm.eventId}:`)) {
      const rk = selectedRunnerKey.slice(String(fm.eventId).length + 1);
      runner = fm.runners.find((r) => String(r.runnerId || r.runnerName) === rk) || runner;
    }
    if (!runner) {
      runner = runners.find((r) => expertRunnerQuote(r) != null) || runners[0] || fm.runners[0];
    }

    const runnerKey = String(runner?.runnerId || runner?.runnerName || "");
    const mem = priceMemory.get(`${fm.eventId}:${runnerKey}`);
    let newOdds = expertRunnerQuote(runner);
    let oldOdds = normalizeOdds(mem?.history?.[0] ?? mem?.back ?? mem?.lay ?? null);

    if (oldOdds == null && newOdds != null) {
      oldOdds = Math.round((newOdds / 1.2) * 100) / 100;
    }
    if (oldOdds != null && newOdds == null) {
      newOdds = oldOdds;
    }

    const spikePct =
      oldOdds != null && newOdds != null ? pctChange(oldOdds, newOdds) : null;

    const matchLabel =
      fm.eventName && fm.eventName !== "Live match"
        ? fm.eventName
        : buildMatchNameFromRunners(fm.runners);

    return {
      sport: fm.sportName || detectSportFromPage().sportName,
      tournament: fm.competitionName || scrapeCompetitionFromPage() || "—",
      match: matchLabel,
      market: "Match Odds",
      runner: runner?.runnerName || "—",
      oldOdds,
      newOdds,
      spikePct,
      matchContext: buildStructuredMatchContext(),
      eventId: String(fm.eventId || "")
    };
  }

  async function runExpertViewReview(payload) {
    return geminiReviewApi()?.callGemini?.(payload) || { ok: false, error: "Gemini not loaded" };
  }

  function formatSpikeMessage(entry) {
    const sign = entry.delta > 0 ? "+" : "";
    const spikeDir = entry.dir === "up" ? "↑ UP" : "↓ DOWN";
    const decision = entry.decision || bracketTradeHypothesis(entry.delta);
    const entryOdds = normalizeOdds(
      entry.entryPrice ?? spikeEntryPrice(decision, entry.to, entry.lay)
    );
    const levels = calcTargetStop(decision, entryOdds);
    const lines = [
      "🔥 ENTRY",
      "",
      "Match:",
      entry.matchName || resolveLiveMatchName(),
      ""
    ];

    if (entry.sportName) {
      lines.push("Sport:", entry.sportName, "");
    }

    lines.push(
      "Runner:",
      entry.runnerName || "—",
      "",
      "Odds:",
      `${formatOdds(entry.from)} → ${formatOdds(entry.to)}`,
      "",
      "Move:",
      `${sign}${Number(entry.delta).toFixed(1)}% (${spikeDir})`,
      "",
      "Action:",
      spikeActionLabel(decision),
      "",
      "Target (Cash Out):",
      `${formatOdds(levels.targetOdds)}  (~${Math.round(PAPER_TARGET_PCT * 100)}% odds)`,
      "",
      "Stop (Loss Cut):",
      formatOdds(levels.stopOdds),
      "",
      "Next alerts:",
      "Cash Out or Loss Cut only — no more spikes this trade"
    );

    if (entry.pageUrl) {
      lines.push("", "Link:", entry.pageUrl);
    }

    return lines.join("\n");
  }

  function buildTelegramTestSpikeEntry() {
    const fm = board.focusedMatch;
    const runner = fm?.runners?.find((r) => r.back != null) || fm?.runners?.[0];
    return buildSpikeEntry({
      matchName: resolveLiveMatchName("Open a match page for live context"),
      runnerName: runner?.runnerName || "—",
      sportName: fm?.sportName,
      eventId: fm?.eventId,
      from: runner?.back ?? 7.8,
      to: runner?.back != null ? runner.back * 1.05 : 10,
      delta: 5,
      dir: "up",
      decision: "BACK"
    });
  }

  async function sendTelegramToChat(token, chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || "").slice(0, 4000),
        disable_web_page_preview: true
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: formatTelegramApiError(data, res.status) };
    }
    return { ok: true };
  }

  async function sendTelegramMessage(text) {
    const token = normalizeTelegramToken(settings.telegramBotToken);
    const chatIds = parseTelegramChatIds(settings.telegramChatId);

    if (!token) {
      telegramStatus = "Need bot token";
      panelApi?.updateTelegramStatusUi?.();
      return false;
    }
    if (!isValidTelegramToken(token)) {
      telegramStatus = `Invalid bot token — ${telegramTokenFormatHint()}`;
      panelApi?.updateTelegramStatusUi?.();
      return false;
    }
    if (!chatIds.length) {
      telegramStatus = "Need chat ID";
      panelApi?.updateTelegramStatusUi?.();
      return false;
    }

    try {
      const results = [];
      for (const chatId of chatIds) {
        results.push({
          chatId,
          ...(await sendTelegramToChat(token, chatId, text))
        });
      }

      const sent = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      if (sent.length === results.length) {
        telegramStatus =
          results.length === 1 ? "Sent ✓" : `Sent ✓ to ${sent.length} chats`;
        panelApi?.updateTelegramStatusUi?.();
        return true;
      }

      if (sent.length > 0) {
        const failHint = failed
          .map((r) => `${r.chatId}: ${r.error}`)
          .slice(0, 2)
          .join(" · ");
        telegramStatus = `Sent ${sent.length}/${results.length} — ${failHint}`;
        panelApi?.updateTelegramStatusUi?.();
        return true;
      }

      telegramStatus =
        results.length === 1
          ? failed[0].error
          : failed.map((r) => `${r.chatId}: ${r.error}`).slice(0, 2).join(" · ");
      panelApi?.updateTelegramStatusUi?.();
      return false;
    } catch (error) {
      telegramStatus = error?.message || "Send failed — check network";
      panelApi?.updateTelegramStatusUi?.();
      return false;
    }
  }

  function sendTelegramSpikeAlert(entry) {
    if (!settings.telegramAlertsEnabled) return;
    armExitWatch(entry);
    void sendTelegramAlert(formatSpikeMessage(entry), "entry");
  }

  function armExitWatch(entry) {
    const eventId = String(entry.eventId || "");
    if (!eventId) return;
    const side = entry.decision || bracketTradeHypothesis(entry.delta);
    const entryOdds = normalizeOdds(
      entry.entryPrice ?? spikeEntryPrice(side, entry.to, entry.lay)
    );
    const levels = calcTargetStop(side, entryOdds);
    pendingExitWatch.set(eventId, {
      eventId,
      matchName: entry.matchName,
      runnerName: entry.runnerName,
      runnerKey: entry.runnerKey || entry.runnerName,
      side,
      entryOdds,
      targetOdds: levels.targetOdds,
      stopOdds: levels.stopOdds,
      stake: demoEntryStake()
    });
  }

  function checkArmedExitWatch(fm) {
    if (!fm?.eventId || !fm.runners?.length) return;
    const watch = pendingExitWatch.get(String(fm.eventId));
    if (!watch) return;

    const runner = findRunnerForOpenTrade(
      { runnerKey: watch.runnerKey, runner: watch.runnerName, eventId: watch.eventId },
      fm.runners
    );
    if (!runner) return;

    const currentOdds =
      watch.side === "BACK" ? runner.back : runner.lay ?? runner.back;
    if (currentOdds == null || !Number.isFinite(currentOdds)) return;

    let hit = null;
    if (watch.side === "BACK") {
      if (currentOdds <= watch.targetOdds) hit = "cashout";
      else if (currentOdds >= watch.stopOdds) hit = "losscut";
    } else if (currentOdds >= watch.targetOdds) hit = "cashout";
    else if (currentOdds <= watch.stopOdds) hit = "losscut";

    if (!hit) return;

    pendingExitWatch.delete(String(fm.eventId));
    const pnl = calcTradePnl(watch.side, watch.entryOdds, currentOdds, watch.stake);
    markMatchTradeClosed(watch.eventId, pnl);
    void sendTelegramAlert(
      formatWatchExitTelegram(watch, currentOdds, hit, pnl),
      hit === "losscut" ? "loss-cut" : "cash-out"
    );
  }

  function formatWatchExitTelegram(watch, currentOdds, hit, pnl) {
    const isLoss = hit === "losscut";
    const stake = Number(watch.stake) || 0;
    const pnlPct = stake > 0 ? ((pnl / stake) * 100).toFixed(1) : null;
    return [
      isLoss ? "🛑 LOSS CUT" : "💰 CASH OUT",
      "",
      "Match:",
      watch.matchName || "—",
      "",
      "Selection:",
      watch.runnerName || "—",
      "",
      "Side:",
      watch.side,
      "",
      "Entry:",
      formatOdds(watch.entryOdds),
      "",
      "Now:",
      formatOdds(currentOdds),
      "",
      "Hit:",
      isLoss
        ? `Stop ${formatOdds(watch.stopOdds)}`
        : `Target ${formatOdds(watch.targetOdds)}`,
      "",
      "PnL (est.):",
      `${formatInr(pnl)}${pnlPct != null ? ` (${pnlPct}% of stake)` : ""}`,
      "",
      "Status:",
      isLoss
        ? "Stop hit — one more entry allowed if a fresh 20% spike comes"
        : "Match done — no more entries"
    ].join("\n");
  }

  function telegramSettingsPayload() {
    return {
      telegramAlertsEnabled: settings.telegramAlertsEnabled,
      telegramBotToken: normalizeTelegramToken(settings.telegramBotToken),
      telegramChatId: String(settings.telegramChatId || "").trim()
    };
  }

  async function saveTelegramSettings() {
    const payload = telegramSettingsPayload();
    const api = cloudConfigApi();

    if (api) {
      try {
        const remote = await api.loadTelegramConfig().catch(() => null);
        payload.telegramChatId = mergeTelegramChatIds(
          remote?.telegramChatId,
          payload.telegramChatId
        );
        payload.telegramBotToken = pickTelegramToken(
          payload.telegramBotToken,
          remote?.telegramBotToken
        );
        settings.telegramChatId = payload.telegramChatId;
        settings.telegramBotToken = payload.telegramBotToken;
        if (!isValidTelegramToken(payload.telegramBotToken)) {
          telegramCloudStatus = "Invalid bot token — not saved to cloud";
        } else {
          await api.saveTelegramConfig(payload);
          telegramCloudStatus = "Saved to cloud";
        }
      } catch (error) {
        telegramCloudStatus = "Cloud save failed";
        console.warn("[SpikeX] Telegram cloud save:", error?.message || error);
      }
    }

    await storageSet({ [TELEGRAM_STORAGE_KEY]: payload });
    panelApi?.syncTelegramInputs?.();
  }

  function applyTelegramSettings(saved) {
    if (!saved) return;
    settings.telegramAlertsEnabled = saved.telegramAlertsEnabled !== false;
    settings.telegramBotToken = String(saved.telegramBotToken || "");
    settings.telegramChatId = String(saved.telegramChatId || "");
  }

  async function loadTelegramSettings() {
    const data = await storageGet(TELEGRAM_STORAGE_KEY);
    applyTelegramSettings(data[TELEGRAM_STORAGE_KEY]);

    const api = cloudConfigApi();
    if (api) {
      try {
        const remote = await api.loadTelegramConfig();
        if (remote) {
          settings.telegramBotToken = pickTelegramToken(
            remote.telegramBotToken,
            settings.telegramBotToken
          );
          settings.telegramChatId = mergeTelegramChatIds(
            remote.telegramChatId,
            settings.telegramChatId
          );
          if (remote.telegramAlertsEnabled === false) {
            settings.telegramAlertsEnabled = false;
          }
          await storageSet({ [TELEGRAM_STORAGE_KEY]: telegramSettingsPayload() });
          if (!isValidTelegramToken(settings.telegramBotToken)) {
            telegramCloudStatus = "Cloud token invalid — paste BotFather token";
          } else {
            telegramCloudStatus =
              remote.telegramBotToken || remote.telegramChatId ? "Loaded from cloud" : "";
          }
        }
      } catch (error) {
        telegramCloudStatus = "Cloud load failed — using local";
        console.warn("[SpikeX] Telegram cloud load:", error?.message || error);
      }
    }

    panelApi?.syncTelegramInputs?.();
  }

  function applyBracketConfigFromSession(saved) {
    if (!saved) return;
    bracketConfig = {
      ...bracketConfigDefaults,
      ...saved,
      minOdds: Number(saved.minOdds ?? bracketConfigDefaults.minOdds),
      maxOdds: Number(saved.maxOdds ?? bracketConfigDefaults.maxOdds),
      oddsFilterEnabled: saved.oddsFilterEnabled !== false,
      overrideSportOdds: saved.overrideSportOdds === true
    };
    if (bracketConfig.minOdds > bracketConfig.maxOdds) {
      bracketConfig.minOdds = bracketConfigDefaults.minOdds;
      bracketConfig.maxOdds = bracketConfigDefaults.maxOdds;
    }
    if (ODDS_BRACKET_FILTER_ENABLED && !SPIKE_ALERT_TESTING) {
      bracketConfig.oddsFilterEnabled = true;
      if (!bracketConfig.overrideSportOdds) {
        bracketConfig.minOdds = BRACKET.MIN_ODDS;
        bracketConfig.maxOdds = BRACKET.MAX_ODDS;
      }
    } else if (SPIKE_ALERT_TESTING || !ODDS_BRACKET_FILTER_ENABLED) {
      bracketConfig.oddsFilterEnabled = false;
    }
  }

  async function bootLocal() {
    await Promise.all([
      loadUiPanelState(),
      loadTelegramSettings(),
      loadTradingSettings(),
      PAPER_TRADING_ENABLED ? loadPaperState() : Promise.resolve(),
      demoTrader()?.loadLedger?.() || Promise.resolve(),
      loadValidationStore(),
      loadOddsMemory(),
      loadBracketConfig()
    ]);
    if (uiPanelState.selectedRunnerKey) selectedRunnerKey = uiPanelState.selectedRunnerKey;
    paperReady = true;
    if (PAPER_TRADING_ENABLED) await refreshSystemPaperFromCloud();
    seedDemoTradeUpdateStateFromLedger();
    refreshCricwayAccount();
    void geminiReviewApi()?.ensureApiKey?.();
    tryEnsureOneClick(true);
    panelApi?.syncMinimized?.();
    panelApi?.render?.(getViewState());
    panelApi?.updateCricwayBalanceUi?.();
  }

  function hasOpenTradeOnMatch(eventId) {
    const id = String(eventId || "");
    if (!id) return false;
    const demoOpen = demoTrader()?.getOpenTrades?.() || [];
    if (demoOpen.some((t) => String(t.eventId) === id)) return true;
    return getOpenTrades().some((t) => String(t.eventId) === id);
  }

  function matchSpikeQuotaOk(eventId) {
    const id = String(eventId || "");
    if (!id) return false;
    if (matchProfitTaken.has(id)) return false;
    if (hasOpenTradeOnMatch(id)) return false;
    if ((matchSpikeCount.get(id) || 0) >= MAX_SIGNALS_PER_MATCH) return false;
    return true;
  }

  function recordMatchSpike(eventId) {
    const id = String(eventId || "");
    matchSpikeCount.set(id, (matchSpikeCount.get(id) || 0) + 1);
    lastMatchSpikeAt.set(id, Date.now());
  }

  function markMatchTradeClosed(eventId, pnl) {
    const id = String(eventId || "");
    if (!id) return;
    if (Number(pnl) > 0) {
      matchProfitTaken.add(id);
      matchSpikeCount.set(id, MAX_SIGNALS_PER_MATCH);
      return;
    }
    matchSpikeCount.set(id, 0);
  }

  function triggerSpikeAlert(entry) {
    activeAlert = entry;
    alertFlashUntil = Date.now() + ALERT_FLASH_MS;
    playSpikeTone();
    panelApi?.flashHeader?.();
    window.setTimeout(() => {
      if (activeAlert === entry) activeAlert = null;
      panelApi?.render?.(getViewState());
    }, ALERT_FLASH_MS);
  }

  function trackRunner(
    eventId,
    runnerKey,
    back,
    lay,
    matchName,
    runnerName,
    spikesEnabled,
    matchState,
    sportName,
    sportId,
    tradable
  ) {
    back = normalizeOdds(back);
    lay = normalizeOdds(lay);
    if (!isSaneMatchOdds(back)) back = null;
    if (lay != null && !isSaneMatchOdds(lay)) lay = null;
    const key = `${eventId}:${runnerKey}`;
    const prev = priceMemory.get(key) || { history: [], back: null };
    if (prev.back != null && !isSaneMatchOdds(prev.back)) {
      prev.back = null;
      prev.history = [];
    }
    let dir = null;
    let delta = null;
    let spike = false;
    let spikeDelta = null;
    const minSpikePct = getMinSpikePct(sportName, sportId);

    if (!tradable) {
      return { dir, delta, spike, spikeDelta, suspended: true };
    }

    const backChanged = back != null && prev.back != null && back !== prev.back;
    const layChanged = lay != null && prev.lay != null && lay !== prev.lay;

    if (backChanged) {
      pushChartPointForRunner(eventId, runnerKey, runnerName, back, Date.now());
      delta = pctChange(prev.back, back);
      dir = back > prev.back ? "up" : "down";
      tickChanges += 1;

      const history = pushHistory(prev.history, prev.back);
      const vsLast = pctChange(prev.back, back);
      const vsWindow =
        history.length >= MEMORY_DEPTH ? pctChange(history[0], back) : null;
      const lastHit =
        vsLast != null &&
        Math.abs(vsLast) >= minSpikePct &&
        Math.abs(vsLast) <= SPIKE_MAX_PCT;
      const windowHit =
        vsWindow != null &&
        Math.abs(vsWindow) >= minSpikePct &&
        Math.abs(vsWindow) <= SPIKE_MAX_PCT;
      spikeDelta = lastHit
        ? vsLast
        : windowHit
          ? vsWindow
          : vsLast;

      if (paperReady && spikesEnabled && (lastHit || windowHit)) {
          const last = lastSpikeAt.get(key) || 0;
          if (Date.now() - last >= SPIKE_COOLDOWN_MS && matchSpikeQuotaOk(eventId)) {
            const decision = bracketTradeHypothesis(spikeDelta);
            const entryPrice = spikeEntryPrice(decision, back, lay);
            if (isPriceInBracket(entryPrice, sportName, sportId)) {
              spike = true;
              lastSpikeAt.set(key, Date.now());
              recordMatchSpike(eventId);
              totalSpikes += 1;

              const entry = buildSpikeEntry({
                at: Date.now(),
                matchName,
                runnerName,
                sportName,
                eventId,
                runnerKey,
                from: lastHit ? prev.back : history[0],
                to: back,
                lay,
                delta: spikeDelta,
                dir: spikeDelta > 0 ? "up" : "down",
                decision,
                reason: spikeReason(decision),
                entryPrice
              });

              recentSpikes.unshift(entry);
              while (recentSpikes.length > 12) recentSpikes.pop();

              triggerSpikeAlert(entry);
              sendTelegramSpikeAlert(entry);

              const tradeSkipped = DEMO_TRADING_ENABLED
                ? Boolean(demoTrader()?.canOpenTrade?.(eventId, runnerKey))
                : getOpenTradeCount() >= getMaxOpenTrades();
              const signalRowId = recordValidationSignal({
                eventId,
                matchName,
                runnerName,
                runnerKey,
                back,
                lay,
                history,
                baseline: lastHit ? prev.back : history[0],
                currentBack: back,
                spikeDelta,
                decision,
                matchState,
                sportName,
                paperSkipped: Boolean(tradeSkipped),
                paperBlocked: false,
                paperBlockedOutsideOdds: false
              });

              console.info(
                "[SpikeX spike]",
                runnerName,
                `${formatOdds(entry.from)} → ${formatOdds(back)}`,
                `${Number(spikeDelta).toFixed(1)}%`
              );

              void handleSpikeAfterGemini({
                entry,
                eventId,
                runnerKey,
                signalRowId,
                tradeSkipped,
                ctx: {
                  eventId,
                  matchName,
                  runnerName,
                  baseline: lastHit ? prev.back : history[0],
                  currentBack: back,
                  spikeDelta
                }
              });
            } else {
              console.info(
                "[SpikeX spike skipped] outside odds bracket",
                runnerName,
                formatOdds(entryPrice)
              );
            }
          }
      }
    }

    if (prev.back == null && back != null && !backChanged) {
      pushChartPoint(key, back, Date.now());
    }

    if (tradable) {
      priceMemory.set(key, {
        history: back != null ? pushHistory(prev.history, back) : prev.history,
        back: back != null ? back : prev.back,
        lay: lay != null ? lay : prev.lay
      });
    }

    return { dir, delta, spike, spikeDelta, suspended: false };
  }

  function clearSpikeMemory() {
    priceMemory.clear();
    lastSpikeAt.clear();
    recentSpikes = [];
    totalSpikes = 0;
    activeAlert = null;
    alertFlashUntil = 0;
  }

  function resetWatchState(eventId, fm = null) {
    const nextKey = String(eventId || "");
    if (!nextKey || watchedMatchKey === nextKey) return;

    if (watchedEventId) {
      clearChartHistory(watchedEventId);
      selectedRunnerKey = null;
    }
    clearSpikeMemory();
    watchedEventId = nextKey;
    watchedMatchKey = nextKey;
  }

  function isRunnerTradable(runner, fm) {
    if (fm?.marketSuspended) return false;
    if (runner?.suspended) return false;
    return true;
  }

  function isMarketTradable(fm) {
    return fm && !fm.marketSuspended;
  }

  function trackBoardUpdate(data) {
    tickChanges = 0;
    const onDetail = data.pageMode === "detail" || isOnMatchDetailPage();
    let fm = onDetail ? resolveFocusedMatch(data) : data.focusedMatch || board.focusedMatch;

    if (onDetail) {
      board.pageMode = "detail";
      scheduleDetailPageResolve(data);
    }

    if (onDetail && fm?.eventId && fm?.runners?.length) {
      updateTabMatchContext(fm);
      syncValidationForMatch(fm.eventId, fm.eventName);
      resetWatchState(fm.eventId, fm);
    }

    if (onDetail && fm?.runners?.length) {
      const suspended = Boolean(fm.marketSuspended);
      // Keep pre-suspend prices. Wickets suspend the market; wiping memory
      // drops the jump vs the last live odds, so no spike fires on reopen.
      lastMarketSuspended = suspended;

      const matchState = inferMatchState(fm);
      const tradableMarket = isMarketTradable(fm);

      if (tradableMarket) {
        fm.runnerTrack = fm.runners.map((runner) => {
          const tradable = isRunnerTradable(runner, fm);
          const info = trackRunner(
            fm.eventId,
            runner.runnerId || runner.runnerName,
            runner.back,
            runner.lay,
            fm.eventName,
            runner.runnerName,
            true,
            matchState,
            fm.sportName,
            fm.sportId,
            tradable
          );
          return { ...runner, track: info };
        });
        refreshValidationOpenOdds(fm);
      } else {
        fm.runnerTrack = fm.runners.map((runner) => ({
          ...runner,
          track: { dir: null, delta: null, spike: false, spikeDelta: null, suspended: true }
        }));
      }

      recordOddsMemoryFromMatch(fm);

      checkDemoTradeExit(fm);
      checkArmedExitWatch(fm);
      checkDemoTradeUpdates(fm);
      checkPaperTradeExit(fm);
      board = { ...board, pageMode: "detail", focusedMatch: fm };
      tryEnsureOneClick();
    }
  }

  function getViewState() {
    ensureDetailOdds();
    const ctx = getCurrentMatchContext();
    const onDetail = board.pageMode === "detail" && ctx.eventId;
    if (onDetail) {
      syncValidationForMatch(ctx.eventId, ctx.matchName);
    }

    const globalPaper = PAPER_TRADING_ENABLED ? getPaperStats() : null;
    const matchPaper =
      PAPER_TRADING_ENABLED && onDetail ? getMatchPaperStats(ctx.eventId, ctx.matchName) : null;
    const demoStats = DEMO_TRADING_ENABLED ? demoTrader()?.getStats?.() || {} : null;

    return {
      storeConnected,
      scriptReady,
      searchAttempts,
      board,
      tickChanges,
      totalSpikes,
      recentSpikes,
      activeAlert,
      alertFlashUntil,
      telegramStatus,
      settings,
      paper: PAPER_TRADING_ENABLED
        ? {
            ...globalPaper,
            global: globalPaper,
            match: matchPaper,
            enabled: true,
            state: matchPaper?.state || paper.state,
            openTrade: matchPaper?.openTrade || null,
            otherOpenTrade: matchPaper?.otherOpenTrade || null,
            recentTrades: onDetail ? getTradesForMatch(ctx.eventId, ctx.matchName, 6) : [],
            auditRows: onDetail ? getPaperAuditRowsForMatch(ctx.eventId, ctx.matchName, 20) : []
          }
        : null,
      demo: DEMO_TRADING_ENABLED
        ? {
            ...demoStats,
            openTrades: demoTrader()?.getOpenTrades?.() || [],
            closedTrades: demoTrader()?.getClosedTrades?.(6) || [],
            autoTrading: isAutoTradingEnabled()
          }
        : null,
      trading: { ...tradingSettings },
      validation: {
        eventId: onDetail ? ctx.eventId : null,
        matchName:
          getValidationMatch(ctx.eventId)?.matchName || ctx.matchName || null,
        rows: onDetail ? validationRowsForView(ctx.eventId, ctx.matchName) : [],
        summary: onDetail ? getValidationSummary(ctx.eventId, ctx.matchName) : null
      },
      bracket: getBracketMetrics(),
      bracketConfig: { ...bracketConfig },
      cricwayAccount: { ...cricwayAccount }
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    handleBridgeMessage(event.data);
  });

  document.addEventListener("market-radar-bridge", (event) => {
    handleBridgeMessage(event.detail);
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function encodeChartSeriesAttr(series) {
    try {
      return encodeURIComponent(
        JSON.stringify((series || []).map((p) => ({ at: p.at, back: p.back })))
      );
    } catch {
      return "";
    }
  }

  function decodeChartSeriesAttr(raw) {
    try {
      return JSON.parse(decodeURIComponent(raw || ""));
    } catch {
      return [];
    }
  }

  function chartPlotCoords(series, width, height, index) {
    if (!series?.length) return null;
    if (series.length === 1) {
      return {
        pctX: 50,
        pctY: 50,
        point: series[0]
      };
    }

    const prices = series.map((p) => p.back);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 0.01;
    const pad = 6;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    const i = Math.max(0, Math.min(series.length - 1, index));
    const x = pad + (i / (series.length - 1)) * innerW;
    const y = pad + innerH - ((series[i].back - minP) / range) * innerH;

    return {
      pctX: (x / width) * 100,
      pctY: (y / height) * 100,
      point: series[i]
    };
  }

  function buildSparklineSvg(series, signals, width, height) {
    if (!series.length) {
      return `<svg class="mr-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><text x="50%" y="54%" text-anchor="middle" fill="#555" font-size="9">—</text></svg>`;
    }

    if (series.length === 1) {
      const y = (height / 2).toFixed(1);
      const x = (width / 2).toFixed(1);
      return `<svg class="mr-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><line x1="6" y1="${y}" x2="${width - 6}" y2="${y}" stroke="#334155" stroke-width="1"/><circle cx="${x}" cy="${y}" r="2.5" fill="#94a3b8"/></svg>`;
    }

    const prices = series.map((p) => p.back);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 0.01;
    const pad = 6;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;

    const coords = series.map((p, i) => {
      const x = pad + (i / (series.length - 1)) * innerW;
      const y = pad + innerH - ((p.back - minP) / range) * innerH;
      return { x, y, at: p.at, back: p.back };
    });

    const path = coords
      .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(" ");

    const markers = signals
      .map((sig) => {
        const c = coordAtSignalTime(coords, series, sig.at);
        if (!c) return "";

        const action =
          sig.paperAction === "BACK" || sig.paperAction === "LAY"
            ? sig.paperAction
            : sig.spikeDirection === "up"
              ? "BACK"
              : "LAY";
        const isBack = action === "BACK";
        const odds = sig.currentPrice ?? sig.backOdds;
        const delta = sig.priceChangePct;
        const deltaStr =
          delta != null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%` : "—";
        const ts = new Date(sig.at).toLocaleTimeString();
        const tip = `${ts} · ${formatOdds(odds)} · ${deltaStr} · ${action}`;
        const color = isBack ? "#4ade80" : "#f87171";
        const x = c.x.toFixed(1);
        const y = c.y.toFixed(1);
        const labelY = isBack ? (c.y - 5).toFixed(1) : (c.y + 9).toFixed(1);

        return `<g class="mr-chart-marker mr-chart-marker-${action.toLowerCase()}"><title>${escapeHtml(tip)}</title><circle cx="${x}" cy="${y}" r="2" fill="${color}"/><text x="${x}" y="${labelY}" text-anchor="middle" fill="${color}" font-size="7" font-weight="700">${isBack ? "▲" : "▼"}</text></g>`;
      })
      .join("");

    return `<svg class="mr-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#ff9f0a" stroke-width="1.2"/>${markers}</svg>`;
  }

  function coordAtSignalTime(coords, series, at) {
    if (!coords.length) return null;
    if (coords.length === 1) return coords[0];

    for (let i = 0; i < series.length; i++) {
      if (Math.abs(series[i].at - at) < 500) return coords[i];
    }

    const t0 = series[0].at;
    const t1 = series[series.length - 1].at;
    if (at <= t0) return coords[0];
    if (at >= t1) return coords[coords.length - 1];

    for (let i = 1; i < series.length; i++) {
      if (at <= series[i].at) {
        const span = series[i].at - series[i - 1].at || 1;
        const ratio = (at - series[i - 1].at) / span;
        return {
          x: coords[i - 1].x + ratio * (coords[i].x - coords[i - 1].x),
          y: coords[i - 1].y + ratio * (coords[i].y - coords[i - 1].y),
          at,
          back: null
        };
      }
    }

    return coords[coords.length - 1];
  }

  function renderMatchWaitPanel(id, title, badge = "") {
    const msg = isOnMatchDetailPage() ? "Reading odds…" : "Open a match page";
    return renderPanel(id, title, badge, `<div class="mr-empty mr-wait">${msg}</div>`);
  }

  function getChartRunnersForView(state) {
    const ctx = getCurrentMatchContext();
    const fm = state.board?.focusedMatch;
    const eventId = fm?.eventId && !isSyntheticEventId(fm.eventId) ? fm.eventId : ctx.eventId;
    const rows = [];
    const seen = new Set();

    for (const runner of fm?.runners || []) {
      const runnerKey = String(runner.runnerId || runner.runnerName);
      if (!runnerKey || seen.has(runnerKey)) continue;
      seen.add(runnerKey);
      rows.push({ runner, runnerKey, eventId });
    }

    if (eventId) {
      const prefix = `${eventId}:`;
      for (const key of chartOddsHistory.keys()) {
        if (!key.startsWith(prefix)) continue;
        const runnerKey = key.slice(prefix.length);
        if (seen.has(runnerKey)) continue;
        seen.add(runnerKey);
        rows.push({ runner: null, runnerKey, eventId });
      }
    }

    return { eventId, rows };
  }

  function resolveRunnerForChart(runner, runnerKey, fm) {
    const key = String(runnerKey);
    const tracked = fm?.runnerTrack?.find((r) => String(r.runnerId || r.runnerName) === key);
    if (tracked) return tracked;
    const live = fm?.runners?.find((r) => String(r.runnerId || r.runnerName) === key);
    if (live) return live;
    return runner || { runnerId: key, runnerName: key };
  }

  function renderSingleRunnerChart(runner, runnerKey, eventId, state, fm) {
    const r = resolveRunnerForChart(runner, runnerKey, fm);
    const allSignals = state.validation?.rows || [];
    const signals = filterSignalsForRunner(allSignals, r, runnerKey);
    let series = eventId ? getChartHistoryForRunner(eventId, r) : [];
    if (series.length < 2 && signals.length) {
      series = mergeChartSeries(series, buildSeriesFromSignals(signals));
    }
    if (!series.length && r?.back != null) {
      series = [{ at: Date.now(), back: r.back }];
    }
    const delta = r?.track?.spikeDelta ?? r?.track?.delta;
    const deltaStr =
      delta != null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%` : "—";
    const deltaCls = delta == null ? "" : delta >= 0 ? "mr-ok" : "mr-warn";
    const runnerLabel = r?.runnerName || runnerKey || "Runner";
    const lastBack = series[series.length - 1]?.back;
    const lay = r?.lay;

    return `
      <div class="mr-chart" data-runner-key="${escapeHtml(runnerKey)}">
        <div class="mr-chart-head">
          <span class="mr-chart-runner">${escapeHtml(runnerLabel)}</span>
          <span class="mr-chart-odds">${formatOdds(r?.back ?? lastBack)}</span>
          ${lay != null ? `<span class="mr-chart-lay">${formatOdds(lay)}</span>` : ""}
          <span class="mr-chart-delta ${deltaCls}">${deltaStr}</span>
        </div>
        <div class="mr-chart-plot" data-series="${encodeChartSeriesAttr(series)}">
          ${buildSparklineSvg(series, signals, 240, 52)}
          <div class="mr-chart-hover-dot" hidden></div>
          <div class="mr-chart-tip" hidden></div>
        </div>
      </div>
    `;
  }

  function renderSpikeChartSection(state) {
    if (state.board.pageMode !== "detail") return "";

    const fm = state.board?.focusedMatch;
    const { eventId, rows } = getChartRunnersForView(state);
    if (!rows.length) return renderMatchWaitPanel("chart", "Charts");

    const chartsHtml = rows
      .map(({ runner, runnerKey }) =>
        renderSingleRunnerChart(runner, runnerKey, eventId, state, fm)
      )
      .join("");

    return renderPanel(
      "chart",
      "Charts",
      `${rows.length} run`,
      `<div class="mr-chart-stack">${chartsHtml}</div>`
    );
  }

  function renderValidationSection(state) {
    const v = state.validation;
    if (state.board.pageMode !== "detail") return "";
    const ctx = getCurrentMatchContext();
    if (!ctx.eventId && !state.board?.focusedMatch) return renderMatchWaitPanel("validation", "Signal Log");

    const eventId = v?.eventId || ctx.eventId;
    if (!eventId) return renderMatchWaitPanel("validation", "Signal Log");

    const rows = v.rows || [];

    const body = rows.length
      ? rows
          .map((row) => {
            const sign = row.priceChangePct > 0 ? "+" : "";
            const pnlText =
              row.pnl != null ? formatInr(row.pnl) : row.tradeStatus === "OPEN" ? "…" : "—";
            const statusClass =
              row.tradeStatus === "WIN"
                ? "mr-ok"
                : row.tradeStatus === "LOSS"
                  ? "mr-warn"
                  : row.tradeStatus === "OPEN"
                    ? "mr-paper-live"
                    : "";
            return `<tr>
              <td>${escapeHtml(new Date(row.at).toLocaleTimeString())}</td>
              <td>${escapeHtml(row.runner)}</td>
              <td>${formatOdds(row.mem1)}</td>
              <td>${formatOdds(row.mem2)}</td>
              <td>${formatOdds(row.mem3)}</td>
              <td>${sign}${row.priceChangePct?.toFixed?.(1) ?? "—"}%</td>
              <td>${escapeHtml(row.paperAction)}</td>
              <td class="${statusClass}">${escapeHtml(row.tradeStatus)}</td>
              <td>${formatOdds(row.entryOdds)}</td>
              <td>${formatOdds(row.currentOdds)}</td>
              <td>${pnlText}</td>
              <td class="mr-val-notes">${escapeHtml(row.notes || "")}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="12" class="mr-empty">—</td></tr>`;

    const inner = `
      <div class="mr-validation" data-event-id="${escapeHtml(eventId)}">
        <div class="mr-validation-toolbar">
          <span class="mr-validation-summary">${rows.length ? `${rows.length} this match · newest first` : "No signals this match"}</span>
          <button type="button" class="mr-clear-signals" data-event-id="${escapeHtml(eventId)}" ${rows.length ? "" : "disabled"}>Clear</button>
          <button type="button" class="mr-clear-signals-all" title="Clear stored logs for every match">Clear all</button>
        </div>
        <div class="mr-validation-scroll">
          <table class="mr-table mr-validation-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Runner</th>
                <th>M1</th>
                <th>M2</th>
                <th>M3</th>
                <th>Δ%</th>
                <th>Hyp</th>
                <th>Res</th>
                <th>Entry</th>
                <th>Now</th>
                <th>PnL</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;

    return renderPanel("validation", "Signal Log", rows.length ? String(rows.length) : "", inner);
  }

  function renderResearchBody(state) {
    const rp = getResearchProgress();
    const fm = state.board?.focusedMatch;
    const watch = getSpikeWatchStatus(fm);
    const activeSport = getSportBracket(fm?.sportName, fm?.sportId);
    const activeOdds = getOddsLimits(fm?.sportName, fm?.sportId);
    const oddsBracketLabel = getOddsBracketLabel(fm?.sportName, fm?.sportId);
    const b = state.bracket || getBracketMetrics();
    const tg = formatTelegramStatusShort(state);
    const om = fm?.eventId
      ? getOddsMemoryStats(fm.eventId)
      : getOddsMemoryStats();
    const oddsMemoryLabel = fm?.eventId
      ? `${om.points} ticks · ${om.runners} runners (saved locally)`
      : `${om.matches} matches · ${om.totalPoints} ticks saved`;

    return `
      <div class="mr-research">
        <table class="mr-kv-table mr-research-progress">
          <tbody>
            <tr><th>Signals</th><td>${rp.signals}</td></tr>
            <tr><th>Trades</th><td>${rp.trades}</td></tr>
            <tr><th>Matches</th><td>${rp.matches}</td></tr>
            <tr><th>Closed</th><td>${rp.closed}/${rp.closedTarget}</td></tr>
            <tr><th>Spike bar</th><td>≥${getMinSpikePct()}% · odds ${BRACKET.MIN_ODDS}–${BRACKET.MAX_ODDS} · 1 entry/match · then Cash Out / Loss Cut only · target ~${Math.round(PAPER_TARGET_PCT * 100)}%</td></tr>
            <tr><th>Odds bracket</th><td>${escapeHtml(oddsBracketLabel)}${activeOdds ? ` (${activeOdds.minOdds}–${activeOdds.maxOdds})` : " — all odds"}</td></tr>
            <tr><th>Armed</th><td>${watch.memoryReady > 0 && watch.inBracket > 0 ? '<span class="mr-ok">Yes</span>' : '<span class="mr-warn">No — need 3 ticks on in-bracket runners</span>'}</td></tr>
            <tr><th>Odds memory</th><td>${oddsMemoryLabel}</td></tr>
            <tr><th>Spikes seen</th><td>${state.totalSpikes ?? 0}</td></tr>
            <tr><th>Telegram</th><td>${escapeHtml(tg)}</td></tr>
          </tbody>
        </table>
        <div class="mr-bracket-grid mr-bracket-compact">
          <span>${DEMO_TRADING_ENABLED ? `${isAutoTradingEnabled() ? '<span class="mr-ok">AUTO</span>' : '<span class="mr-warn">MANUAL</span>'} · ${escapeHtml(oddsBracketLabel)} · ≥${getMinSpikePct()}% · Gemini suggest` : SPIKE_ALERT_TESTING ? `<span class="mr-warn">TESTING</span> · all odds · ≥${SPIKE_MIN_PCT}% · ${MEMORY_DEPTH} ticks` : `${escapeHtml(activeSport.label)} ${activeOdds ? `${activeOdds.minOdds}–${activeOdds.maxOdds}` : "—"} · ≥${activeSport.minSpikePct}% · LOCKED`}</span>
          <span class="${b.totalPnl >= 0 ? "mr-ok" : "mr-warn"}">${formatInr(b.totalPnl)} · ${b.winRate.toFixed(0)}% WR</span>
        </div>
        <details class="mr-bracket-advanced">
          <summary>Advanced</summary>
          <div class="mr-bracket-test">
            <label class="mr-bracket-test-toggle">
              <input type="checkbox" class="mr-odds-filter-enabled" ${bracketConfig.oddsFilterEnabled ? "checked" : ""} />
              Filter
            </label>
            <label class="mr-bracket-test-toggle">
              <input type="checkbox" class="mr-override-sport-odds" ${bracketConfig.overrideSportOdds ? "checked" : ""} ${bracketConfig.oddsFilterEnabled ? "" : "disabled"} />
              Override
            </label>
            <label class="mr-bracket-test-field">
              Min<input type="number" class="mr-min-odds" min="1.01" max="100" step="0.1" value="${bracketConfig.minOdds}" ${bracketConfig.oddsFilterEnabled && bracketConfig.overrideSportOdds ? "" : "disabled"} />
            </label>
            <label class="mr-bracket-test-field">
              Max<input type="number" class="mr-max-odds" min="1.01" max="1000" step="0.1" value="${bracketConfig.maxOdds}" ${bracketConfig.oddsFilterEnabled && bracketConfig.overrideSportOdds ? "" : "disabled"} />
            </label>
            <button type="button" class="mr-paper-reset-all">Reset</button>
          </div>
        </details>
      </div>
    `;
  }

  function renderBracketSection(state) {
    return renderPanel("bracket", "Research", "", renderResearchBody(state));
  }

  function renderTradesBody(state) {
    const d = state.demo || {};
    const cw = state.cricwayAccount || {};
    const cwLabel = cw.username ? `Cricway (${escapeHtml(cw.username)})` : "Cricway";
    const openTrades = d.openTrades || [];
    const lastClosed = d.closedTrades?.[0] || null;

    let openCell = "—";
    if (openTrades.length) {
      openCell = openTrades
        .map(
          (t) =>
            `${escapeHtml(t.side)} ${escapeHtml(t.runner)} @ ${formatOdds(t.entryOdds)} · T ${formatOdds(t.targetOdds)} · S ${formatOdds(t.stopOdds)}`
        )
        .join("<br>");
    }

    let lastCell = "—";
    if (lastClosed) {
      const cls = (lastClosed.pnl ?? 0) >= 0 ? "mr-ok" : "mr-warn";
      lastCell = `<span class="${cls}">${escapeHtml(lastClosed.side)} ${formatOdds(lastClosed.entryOdds)}→${formatOdds(lastClosed.exitOdds)} ${formatInr(lastClosed.pnl)}</span>`;
    }

    const statusCell = d.lastError
      ? `<span class="mr-warn">${escapeHtml(d.lastError)}</span>`
      : escapeHtml(d.lastAction || "Ready");

    return `
      <table class="mr-kv-table">
        <tbody>
          <tr><th>${cwLabel}</th><td class="mr-cw-balance">${formatCricwayBalance(cw.balance)}</td></tr>
          <tr><th>Mode</th><td class="${d.autoTrading ? "mr-ok" : "mr-warn"}">${d.autoTrading ? "AUTO · click only" : "MANUAL"}</td></tr>
          <tr><th>Open</th><td>${openCell}</td></tr>
          <tr><th>Total PnL</th><td class="${(d.totalPnl ?? 0) >= 0 ? "mr-ok" : "mr-warn"}">${formatInr(d.totalPnl ?? 0)}</td></tr>
          <tr><th>Last Closed</th><td>${lastCell}</td></tr>
          <tr><th>Status</th><td>${statusCell}</td></tr>
        </tbody>
      </table>
    `;
  }

  function renderPaperBody(state) {
    if (DEMO_TRADING_ENABLED) return renderTradesBody(state);
    return "";
  }

  function renderPaperDashboard(state) {
    const panelTitle = DEMO_TRADING_ENABLED ? "Trades" : "Paper";

    if (DEMO_TRADING_ENABLED) {
      return renderPanel("paper", panelTitle, formatPaperBadge(state), renderTradesBody(state));
    }

    if (state.board.pageMode !== "detail") {
      const p = state.paper;
      if (!p) return "";
      return renderPanel(
        "paper",
        panelTitle,
        "",
        `<table class="mr-kv-table"><tbody>
          <tr><th>Cricway</th><td class="mr-cw-balance">${formatCricwayBalance(state.cricwayAccount?.balance)}</td></tr>
          <tr><th>Paper bank</th><td>${formatInr(p.bankroll)}</td></tr>
        </tbody></table>`
      );
    }
    const ctx = getCurrentMatchContext();
    if (!state.board?.focusedMatch?.runners?.length && !ctx.eventId) {
      return renderMatchWaitPanel("paper", panelTitle, formatPaperBadge(state));
    }
    if (!state.board?.focusedMatch) return renderMatchWaitPanel("paper", panelTitle, formatPaperBadge(state));
    return renderPanel("paper", panelTitle, formatPaperBadge(state), renderPaperBody(state));
  }
  function buildLiveOddsRows(state) {
    const focused = state.board.focusedMatch;
    if (!focused) return "";

    const sportName = focused.sportName;
    const sportId = focused.sportId;
    const selected = resolveSelectedRunner(focused);
    const selectedKey = selected ? String(selected.runnerId || selected.runnerName) : null;

    return (focused.runnerTrack || focused.runners || [])
      .map((runner) => {
        const runnerKey = String(runner.runnerId || runner.runnerName);
        const suspendedCls = runner.suspended ? "mr-runner-suspended" : "";
        const inBracket = runnerInBracket(runner, sportName, sportId);
        const selectedCls = runnerKey === selectedKey ? " mr-row-selected" : "";
        const status = runner.suspended ? "SUSP" : inBracket ? "IN" : "OUT";
        const statusCls = runner.suspended ? "mr-warn" : inBracket ? "mr-ok" : "mr-muted";

        return `
          <tr class="mr-odds-row${selectedCls}" data-runner-key="${escapeHtml(runnerKey)}">
            <td>${escapeHtml(runner.runnerName)}</td>
            <td class="mr-focused-odds ${suspendedCls}">${escapeHtml(runner.backText)}</td>
            <td class="mr-odds-lay ${suspendedCls}">${escapeHtml(runner.layText)}</td>
            <td class="${statusCls}">${status}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderLiveOddsBody(state) {
    const focused = state.board.focusedMatch;
    if (!focused) return `<div class="mr-empty">—</div>`;

    const rowsHtml = buildLiveOddsRows(state);

    return `
      <table class="mr-table mr-focused-table">
        <thead><tr><th>Runner</th><th>Back</th><th>Lay</th><th>Status</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }
  function renderDetailPage(state) {
    if (!state.board.focusedMatch?.runners?.length) {
      return `<div class="mr-empty mr-wait">${isOnMatchDetailPage() ? "Reading odds…" : "Open a match page"}</div>`;
    }
    return renderPanel("live", "Odds", "", renderLiveOddsBody(state));
  }

  function renderBoardHtml(state) {
    if (state.board.pageMode !== "detail" && !isOnMatchDetailPage()) {
      return `<div class="mr-empty">Open a match page</div>`;
    }
    const ctx = getCurrentMatchContext();
    if (!state.board.focusedMatch?.runners?.length && ctx.eventId) {
      return `<div class="mr-empty mr-wait">Loading odds…</div>`;
    }
    return renderDetailPage(state);
  }

  function createPanel() {
    const root = document.createElement("div");
    root.id = "market-radar-panel";
    root.innerHTML = `
      <div class="mr-resize-handle" title="Drag to resize"></div>
      <header class="mr-header">
        <span class="mr-brand">SX</span>
        <div class="mr-status-strip">
          <div class="mr-stat mr-stat-match-wrap"><span class="mr-stat-v mr-stat-match">—</span></div>
          <div class="mr-stat"><span class="mr-stat-k">SPORT</span><span class="mr-stat-v mr-stat-sport">—</span></div>
          <div class="mr-stat"><span class="mr-stat-k">OPEN</span><span class="mr-stat-v mr-stat-open">0/1</span></div>
          <div class="mr-stat"><span class="mr-stat-k">CW</span><span class="mr-stat-v mr-stat-cw">—</span></div>
          <div class="mr-stat"><span class="mr-stat-k">TG</span><span class="mr-stat-v mr-stat-tg">OFF</span></div>
          <button type="button" class="mr-trading-toggle" title="Toggle auto/manual trading">AUTO</button>
          <button type="button" class="mr-alerts-toggle" title="Toggle Telegram alerts">ALERTS ON</button>
          <button type="button" class="mr-expert-open" title="Gemini expert spike review">EXPERT</button>
          <button type="button" class="mr-export-json" disabled title="Export signal log JSON">JSON</button>
        </div>
        <button type="button" class="mr-toggle" aria-label="Collapse panel" title="Collapse">▾</button>
      </header>
      <div class="mr-body">
        <div class="mr-main-scroll">
          <div class="mr-bracket-wrap"></div>
          <div class="mr-paper-wrap"></div>
          <div class="mr-chart-wrap"></div>
          <div class="mr-table-wrap mr-board-wrap"></div>
          <div class="mr-validation-wrap"></div>
        </div>
        <details class="mr-settings mr-panel" data-panel="expert">
          <summary class="mr-panel-summary">
            <span class="mr-panel-title">Expert View</span>
            <span class="mr-panel-badge mr-expert-badge">Gemini</span>
          </summary>
          <div class="mr-panel-body">
            <section class="mr-expert">
              <p class="mr-expert-hint">Gemini classifies spikes as <strong>EMOTIONAL_OVERREACTION</strong> vs <strong>JUSTIFIED_REPRICING</strong>. This is a suggestion only — it does not block trades or Telegram.</p>
              <div class="mr-expert-grid">
                <label class="mr-expert-field">
                  Sport
                  <input type="text" class="mr-expert-sport" placeholder="Football" />
                </label>
                <label class="mr-expert-field">
                  Tournament
                  <input type="text" class="mr-expert-tournament" placeholder="FIFA World Cup 2026" />
                </label>
                <label class="mr-expert-field mr-expert-span2">
                  Match
                  <input type="text" class="mr-expert-match" placeholder="Canada v Bosnia" />
                </label>
                <label class="mr-expert-field">
                  Market
                  <input type="text" class="mr-expert-market" value="Match Odds" />
                </label>
                <label class="mr-expert-field">
                  Runner
                  <input type="text" class="mr-expert-runner" placeholder="Canada" list="mr-expert-runners" />
                  <datalist id="mr-expert-runners"></datalist>
                </label>
                <label class="mr-expert-field">
                  Old odds
                  <input type="number" class="mr-expert-old-odds" min="1.01" step="0.01" placeholder="2.38" />
                </label>
                <label class="mr-expert-field">
                  New odds
                  <input type="number" class="mr-expert-new-odds" min="1.01" step="0.01" placeholder="3.05" />
                </label>
                <label class="mr-expert-field">
                  Spike %
                  <input type="number" class="mr-expert-spike-pct" step="0.1" placeholder="28.1" />
                </label>
              </div>
              <label class="mr-expert-field mr-expert-context">
                Match context (optional)
                <textarea class="mr-expert-context-input" rows="4" placeholder="Score, momentum, cards, team news — anything you know about the live match situation."></textarea>
              </label>
              <div class="mr-expert-actions">
                <button type="button" class="mr-expert-fill">Fill from match</button>
                <button type="button" class="mr-expert-run">Run Expert Review</button>
              </div>
              <pre class="mr-expert-result" hidden></pre>
            </section>
          </div>
        </details>
        <details class="mr-settings mr-panel" data-panel="telegram">
          <summary class="mr-panel-summary">
            <span class="mr-panel-title">Telegram</span>
            <span class="mr-panel-badge mr-stat-tg-inline">OFF</span>
          </summary>
          <div class="mr-panel-body">
            <section class="mr-telegram">
              <label class="mr-telegram-toggle">
                <input type="checkbox" class="mr-telegram-enabled" checked />
                Alerts on
              </label>
              <p class="mr-telegram-hint">Bot token from <strong>@BotFather</strong> — format <code>123456789:ABCdef...</code>. Chat IDs are <strong>comma-separated</strong>. Each person must open your bot and tap <strong>Start</strong>.</p>
              <p class="mr-telegram-cloud"></p>
              <label class="mr-telegram-field">
                Bot token
                <input type="password" class="mr-telegram-token" placeholder="123456:ABC..." autocomplete="off" />
              </label>
              <label class="mr-telegram-field">
                Chat IDs
                <textarea class="mr-telegram-chat" rows="3" placeholder="1327411160, 1248568854" autocomplete="off"></textarea>
              </label>
              <div class="mr-telegram-actions">
                <button type="button" class="mr-telegram-test">Test</button>
                <span class="mr-telegram-status">—</span>
              </div>
            </section>
          </div>
        </details>
      </div>
    `;

    document.documentElement.appendChild(root);
    panelRootRef = root;

    root.addEventListener(
      "toggle",
      (event) => {
        const panel = event.target.closest?.("details[data-panel]");
        if (!panel || event.target !== panel) return;
        uiPanelState[panel.dataset.panel] = panel.open;
        saveUiPanelState();
      },
      true
    );

    const toggle = root.querySelector(".mr-toggle");
    const statMatch = root.querySelector(".mr-stat-match");
    const statSport = root.querySelector(".mr-stat-sport");
    const statOpen = root.querySelector(".mr-stat-open");
    const statCw = root.querySelector(".mr-stat-cw");
    const statTg = root.querySelector(".mr-stat-tg");
    const tradingToggleBtn = root.querySelector(".mr-trading-toggle");
    const alertsToggleBtn = root.querySelector(".mr-alerts-toggle");
    const exportJsonBtn = root.querySelector(".mr-export-json");
    const expertOpenBtn = root.querySelector(".mr-expert-open");
    const mainScroll = root.querySelector(".mr-main-scroll");
    const boardWrap = root.querySelector(".mr-board-wrap");
    const bracketWrap = root.querySelector(".mr-bracket-wrap");
    const chartWrap = root.querySelector(".mr-chart-wrap");
    const validationWrap = root.querySelector(".mr-validation-wrap");
    const paperWrap = root.querySelector(".mr-paper-wrap");
    const header = root.querySelector(".mr-header");
    const telegramEnabledEl = root.querySelector(".mr-telegram-enabled");
    const telegramTokenEl = root.querySelector(".mr-telegram-token");
    const telegramChatEl = root.querySelector(".mr-telegram-chat");
    const telegramTestEl = root.querySelector(".mr-telegram-test");
    const telegramStatusEl = root.querySelector(".mr-telegram-status");
    const telegramCloudEl = root.querySelector(".mr-telegram-cloud");
    const expertPanelEl = root.querySelector('[data-panel="expert"]');
    const expertSportEl = root.querySelector(".mr-expert-sport");
    const expertTournamentEl = root.querySelector(".mr-expert-tournament");
    const expertMatchEl = root.querySelector(".mr-expert-match");
    const expertMarketEl = root.querySelector(".mr-expert-market");
    const expertRunnerEl = root.querySelector(".mr-expert-runner");
    const expertOldOddsEl = root.querySelector(".mr-expert-old-odds");
    const expertNewOddsEl = root.querySelector(".mr-expert-new-odds");
    const expertSpikePctEl = root.querySelector(".mr-expert-spike-pct");
    const expertContextEl = root.querySelector(".mr-expert-context-input");
    const expertFillBtn = root.querySelector(".mr-expert-fill");
    const expertRunBtn = root.querySelector(".mr-expert-run");
    const expertResultEl = root.querySelector(".mr-expert-result");
    const expertRunnersList = root.querySelector("#mr-expert-runners");

    function readExpertPayload() {
      const oldOdds = normalizeOdds(expertOldOddsEl.value);
      const newOdds = normalizeOdds(expertNewOddsEl.value);
      let spikePct = Number(expertSpikePctEl.value);
      if (!Number.isFinite(spikePct) && oldOdds != null && newOdds != null) {
        spikePct = pctChange(oldOdds, newOdds);
      }
      return {
        sport: expertSportEl.value.trim() || "—",
        tournament: expertTournamentEl.value.trim() || "—",
        match: expertMatchEl.value.trim() || "—",
        market: expertMarketEl.value.trim() || "Match Odds",
        runner: expertRunnerEl.value.trim() || "—",
        oldOdds,
        newOdds,
        spikePct,
        matchContext: expertContextEl.value.trim(),
        timestamp: new Date().toISOString()
      };
    }

    function fillExpertForm(data) {
      if (!data) return false;
      expertSportEl.value = data.sport || "";
      expertTournamentEl.value = data.tournament || "";
      expertMatchEl.value = data.match || "";
      expertMarketEl.value = data.market || "Match Odds";
      expertRunnerEl.value = data.runner || "";
      expertOldOddsEl.value = data.oldOdds != null ? Number(data.oldOdds).toFixed(2) : "";
      expertNewOddsEl.value = data.newOdds != null ? Number(data.newOdds).toFixed(2) : "";
      expertSpikePctEl.value =
        data.spikePct != null && Number.isFinite(data.spikePct) ? Number(data.spikePct).toFixed(1) : "";
      if (data.matchContext != null) expertContextEl.value = data.matchContext;
      return true;
    }

    function syncExpertRunnerList() {
      if (!expertRunnersList) return;
      const fm = board.focusedMatch;
      expertRunnersList.innerHTML = expertRunnerOptions(fm)
        .map((r) => `<option value="${escapeHtml(r.runnerName || "")}"></option>`)
        .join("");
    }

    function showExpertResult(text, isError = false) {
      if (!expertResultEl) return;
      expertResultEl.hidden = false;
      expertResultEl.textContent = text;
      expertResultEl.classList.toggle("mr-expert-result-err", isError);
    }

    function mergeExpertFill(data) {
      if (!data) return false;
      const ctx = expertContextEl?.value || "";
      fillExpertForm({ ...data, matchContext: ctx || data.matchContext || "" });
      return Boolean(data.oldOdds != null && data.newOdds != null);
    }

    function openExpertPanel() {
      if (!expertPanelEl) return;
      expertPanelEl.open = true;
      uiPanelState.expert = true;
      saveUiPanelState();
      syncExpertRunnerList();
      const hint = expertRunnerEl?.value?.trim() || null;
      const data = expertFillFromMatch(hint);
      const filled = mergeExpertFill(data);
      if (filled && data) {
        showExpertResult(`Tracking ${data.match} · ${data.tournament} · ${data.sport}.`, false);
      } else if (!filled) {
        showExpertResult("Open a match page, then click Fill from match.", true);
      }
      expertContextEl?.focus();
    }

    function syncExpertPanelOpen() {
      if (expertPanelEl) expertPanelEl.open = isPanelOpen("expert");
    }

    function syncPaperInputs() {
      /* Paper trading locked ON by Bracket v1 */
    }

    exportJsonBtn.addEventListener("click", () => {
      const eventId = exportJsonBtn.dataset.eventId;
      if (!eventId || exportJsonBtn.disabled) return;
      void copyValidationJson(eventId, exportJsonBtn);
    });

    validationWrap.addEventListener("click", (event) => {
      const clearAll = event.target.closest(".mr-clear-signals-all");
      if (clearAll) {
        event.preventDefault();
        event.stopPropagation();
        if (window.confirm("Clear signal logs for every match?")) {
          clearValidationLogs(null, { all: true });
        }
        return;
      }
      const clearOne = event.target.closest(".mr-clear-signals");
      if (!clearOne || clearOne.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const eventId = clearOne.dataset.eventId;
      if (!eventId) return;
      if (window.confirm("Clear signal log for this match?")) {
        clearValidationLogs(eventId);
      }
    });

    expertOpenBtn?.addEventListener("click", () => {
      openExpertPanel();
    });

    expertFillBtn?.addEventListener("click", () => {
      syncExpertRunnerList();
      const hint = expertRunnerEl?.value?.trim() || null;
      const data = expertFillFromMatch(hint);
      const filled = mergeExpertFill(data);
      if (!filled) showExpertResult("Open a match page with live odds first.", true);
      else showExpertResult(`Tracking ${data.match} · ${data.tournament}.`, false);
    });

    expertPanelEl?.addEventListener("toggle", () => {
      if (!expertPanelEl?.open) return;
      syncExpertRunnerList();
      const hint = expertRunnerEl?.value?.trim() || null;
      mergeExpertFill(expertFillFromMatch(hint));
    });

    expertRunBtn?.addEventListener("click", async () => {
      let payload = readExpertPayload();
      if (payload.oldOdds == null || payload.newOdds == null) {
        const hint = expertRunnerEl?.value?.trim() || null;
        mergeExpertFill(expertFillFromMatch(hint));
        payload = readExpertPayload();
      }
      if (payload.oldOdds == null || payload.newOdds == null) {
        showExpertResult(
          "No live odds found. Open a match page → Fill from match → or type old/new odds manually.",
          true
        );
        return;
      }
      if (!Number.isFinite(payload.spikePct)) {
        showExpertResult("Enter spike % or valid old/new odds.", true);
        return;
      }

      expertRunBtn.disabled = true;
      expertRunBtn.textContent = "Reviewing…";
      showExpertResult("Asking Gemini…");

      try {
        const key = await geminiReviewApi()?.ensureApiKey?.();
        if (!key) {
          showExpertResult("Gemini API key missing — add geminiApiKey to Firestore spikex/config.", true);
          return;
        }

        const result = await runExpertViewReview(payload);
        if (!result?.ok) {
          showExpertResult(`Error: ${result?.error || "Gemini failed"}`, true);
          return;
        }

        const conf =
          result.confidence != null ? `${Math.round(result.confidence * 100)}%` : "—";
        showExpertResult(
          [
            `Classification: ${result.classification}`,
            `Confidence: ${conf}`,
            result.model ? `Model: ${result.model}` : "",
            "",
            result.shortReason || "—"
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (error) {
        showExpertResult(`Error: ${error?.message || error}`, true);
      } finally {
        expertRunBtn.disabled = false;
        expertRunBtn.textContent = "Run Expert Review";
      }
    });

    for (const el of [expertOldOddsEl, expertNewOddsEl]) {
      el?.addEventListener("input", () => {
        const oldOdds = normalizeOdds(expertOldOddsEl.value);
        const newOdds = normalizeOdds(expertNewOddsEl.value);
        if (oldOdds != null && newOdds != null) {
          const spike = pctChange(oldOdds, newOdds);
          if (spike != null) expertSpikePctEl.value = spike.toFixed(1);
        }
      });
    }

    boardWrap.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-runner-key]");
      if (!row) return;
      const fm = board?.focusedMatch;
      if (!fm) return;
      selectedRunnerKey = `${fm.eventId}:${row.dataset.runnerKey}`;
      saveSelectedRunnerKey();
      panelApi?.render?.(getViewState());
    });

    bracketWrap.addEventListener("click", (event) => {
      if (!event.target.classList.contains("mr-paper-reset-all")) return;
      const openNote = getOpenTradeCount()
        ? `\n\nThis will also close/clear ${getOpenTradeCount()} open trade(s) without recording an exit.`
        : "";
      const ok = window.confirm(
        `Reset everything?\n\n• Bankroll → ${formatInr(PAPER_STARTING_BANKROLL)}\n• Clear all paper trades\n• Clear all validation signals${openNote}`
      );
      if (ok) resetPaperAndValidation();
    });

    bracketWrap.addEventListener("change", (event) => {
      const target = event.target;
      if (target.classList.contains("mr-odds-filter-enabled")) {
        bracketConfig.oddsFilterEnabled = target.checked;
        saveBracketConfig();
        panelApi?.render?.(getViewState());
        return;
      }
      if (target.classList.contains("mr-override-sport-odds")) {
        bracketConfig.overrideSportOdds = target.checked;
        saveBracketConfig();
        panelApi?.render?.(getViewState());
        return;
      }
      if (target.classList.contains("mr-min-odds") || target.classList.contains("mr-max-odds")) {
        const min = Number(bracketWrap.querySelector(".mr-min-odds")?.value);
        const max = Number(bracketWrap.querySelector(".mr-max-odds")?.value);
        if (Number.isFinite(min) && Number.isFinite(max) && min <= max && min >= 1.01) {
          bracketConfig.minOdds = min;
          bracketConfig.maxOdds = max;
          saveBracketConfig();
          panelApi?.render?.(getViewState());
        }
      }
    });

    let telegramSaveTimer = null;

    function readTelegramFromInputs() {
      settings.telegramAlertsEnabled = telegramEnabledEl.checked;
      const token = telegramTokenEl.value.trim();
      const chat = telegramChatEl.value.trim();
      if (token) settings.telegramBotToken = token;
      if (chat) settings.telegramChatId = chat;
    }

    function scheduleTelegramSave() {
      readTelegramFromInputs();
      clearTimeout(telegramSaveTimer);
      telegramSaveTimer = setTimeout(() => {
        void saveTelegramSettings();
      }, 400);
    }

    function syncTradingToggleButton() {
      if (!tradingToggleBtn) return;
      const auto = isAutoTradingEnabled();
      tradingToggleBtn.textContent = auto ? "AUTO" : "MANUAL";
      tradingToggleBtn.classList.toggle("mr-trading-auto", auto);
      tradingToggleBtn.classList.toggle("mr-trading-manual", !auto);
      tradingToggleBtn.title = auto
        ? "Auto trading on — click for manual (alerts only)"
        : "Manual mode — click for auto trading";
    }

    function setAutoTradingEnabled(enabled) {
      tradingSettings.autoTradingEnabled = Boolean(enabled);
      syncTradingToggleButton();
      void saveTradingSettings();
      panelApi?.render?.(getViewState());
    }

    function syncAlertsToggleButton() {
      if (!alertsToggleBtn) return;
      const on = settings.telegramAlertsEnabled;
      alertsToggleBtn.textContent = on ? "ALERTS ON" : "ALERTS OFF";
      alertsToggleBtn.classList.toggle("mr-alerts-on", on);
      alertsToggleBtn.classList.toggle("mr-alerts-off", !on);
      alertsToggleBtn.title = on ? "Turn Telegram alerts off" : "Turn Telegram alerts on";
    }

    function setTelegramAlertsEnabled(enabled) {
      settings.telegramAlertsEnabled = Boolean(enabled);
      if (telegramEnabledEl) telegramEnabledEl.checked = settings.telegramAlertsEnabled;
      syncAlertsToggleButton();
      void saveTelegramSettings();
      panelApi?.render?.(getViewState());
    }

    function updateTelegramStatusUi() {
      const tgShort = formatTelegramStatusShort({ settings, telegramStatus });
      telegramStatusEl.textContent = telegramStatusLabel();
      if (telegramCloudEl) {
        telegramCloudEl.textContent = telegramCloudStatus || "";
      }
      const tgBadge = root.querySelector(".mr-stat-tg-inline");
      if (tgBadge) tgBadge.textContent = tgShort;
      syncAlertsToggleButton();
    }

    function syncTelegramInputs() {
      const active = document.activeElement;
      const editing =
        active === telegramChatEl ||
        active === telegramTokenEl ||
        active === telegramEnabledEl;
      if (!editing) {
        telegramEnabledEl.checked = settings.telegramAlertsEnabled;
        telegramTokenEl.value = settings.telegramBotToken;
        telegramChatEl.value = settings.telegramChatId;
      }
      updateTelegramStatusUi();
      const settingsEl = root.querySelector(".mr-settings");
      if (settingsEl) {
        settingsEl.open = isPanelOpen("telegram");
      }
      syncExpertPanelOpen();
      syncExpertRunnerList();
    }

    tradingToggleBtn?.addEventListener("click", () => {
      setAutoTradingEnabled(!isAutoTradingEnabled());
    });

    alertsToggleBtn?.addEventListener("click", () => {
      setTelegramAlertsEnabled(!settings.telegramAlertsEnabled);
    });

    telegramEnabledEl.addEventListener("change", () => {
      readTelegramFromInputs();
      syncAlertsToggleButton();
      saveTelegramSettings();
      panelApi?.render?.(getViewState());
    });

    for (const el of [telegramChatEl, telegramTokenEl]) {
      el.addEventListener("input", scheduleTelegramSave);
      el.addEventListener("blur", () => {
        readTelegramFromInputs();
        clearTimeout(telegramSaveTimer);
        saveTelegramSettings();
      });
    }

    window.addEventListener("pagehide", () => {
      readTelegramFromInputs();
      clearTimeout(telegramSaveTimer);
      saveTelegramSettings();
    });

    telegramTestEl.addEventListener("click", async () => {
      readTelegramFromInputs();
      telegramStatus = "Testing…";
      updateTelegramStatusUi();
      await saveTelegramSettings();
      await sendTelegramAlert(formatSpikeMessage(buildTelegramTestSpikeEntry()), "test");
    });

    function applyConsoleHeight() {
      if (root.classList.contains("mr-collapsed")) {
        root.style.height = "";
        return;
      }
      let h = Number(uiPanelState.consoleHeight) || UI_PANEL_DEFAULTS.consoleHeight;
      if (h === 340) h = UI_PANEL_DEFAULTS.consoleHeight;
      const maxH = Math.floor(window.innerHeight * 0.7);
      root.style.height = `${Math.min(Math.max(220, h), maxH)}px`;
    }

    function setPanelMinimized(minimized) {
      root.classList.toggle("mr-collapsed", minimized);
      toggle.textContent = minimized ? "▴" : "▾";
      toggle.title = minimized ? "Expand console" : "Collapse console";
      toggle.setAttribute("aria-label", minimized ? "Expand console" : "Collapse console");
      uiPanelState.minimized = minimized;
      applyConsoleHeight();
      saveUiPanelState();
    }

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setPanelMinimized(!root.classList.contains("mr-collapsed"));
    });

    header.addEventListener("click", (event) => {
      if (event.target === toggle) return;
      if (root.classList.contains("mr-collapsed")) {
        setPanelMinimized(false);
      }
    });

    header.addEventListener("dblclick", (event) => {
      if (event.target === toggle) return;
      setPanelMinimized(!root.classList.contains("mr-collapsed"));
    });

    setPanelMinimized(Boolean(uiPanelState.minimized));
    applyConsoleHeight();

    chartWrap.addEventListener("mousemove", (event) => {
      const plot = event.target.closest(".mr-chart-plot");
      if (!plot) {
        chartWrap.querySelectorAll(".mr-chart-tip, .mr-chart-hover-dot").forEach((el) => {
          el.hidden = true;
        });
        return;
      }

      const series = decodeChartSeriesAttr(plot.dataset.series);
      if (!series.length) return;

      const svg = plot.querySelector(".mr-chart-svg");
      const width = svg?.viewBox?.baseVal?.width || 240;
      const height = svg?.viewBox?.baseVal?.height || 52;
      const plotRect = plot.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - plotRect.left) / plotRect.width));
      const idx =
        series.length === 1 ? 0 : Math.round(ratio * (series.length - 1));
      const coord = chartPlotCoords(series, width, height, idx);
      if (!coord) return;

      const tip = plot.querySelector(".mr-chart-tip");
      const dot = plot.querySelector(".mr-chart-hover-dot");
      const ts = new Date(coord.point.at).toLocaleTimeString();
      if (tip) {
        tip.textContent = `${ts} · ${formatOdds(coord.point.back)}`;
        tip.hidden = false;
        tip.style.left = `${coord.pctX}%`;
        tip.style.top = `${coord.pctY}%`;
      }
      if (dot) {
        dot.hidden = false;
        dot.style.left = `${coord.pctX}%`;
        dot.style.top = `${coord.pctY}%`;
      }
    });

    chartWrap.addEventListener("mouseleave", () => {
      chartWrap.querySelectorAll(".mr-chart-tip, .mr-chart-hover-dot").forEach((el) => {
        el.hidden = true;
      });
    });

    const resizeHandle = root.querySelector(".mr-resize-handle");
    let resizing = false;
    let resizeStartY = 0;
    let resizeStartH = 0;

    resizeHandle.addEventListener("mousedown", (event) => {
      if (root.classList.contains("mr-collapsed")) return;
      resizing = true;
      resizeStartY = event.clientY;
      resizeStartH = root.offsetHeight;
      resizeHandle.classList.add("mr-resizing");
      document.body.classList.add("mr-console-resizing");
      event.preventDefault();
    });

    window.addEventListener("mousemove", (event) => {
      if (!resizing) return;
      const maxH = Math.floor(window.innerHeight * 0.7);
      const nextH = Math.min(Math.max(220, resizeStartH + (resizeStartY - event.clientY)), maxH);
      root.style.height = `${nextH}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      resizeHandle.classList.remove("mr-resizing");
      document.body.classList.remove("mr-console-resizing");
      uiPanelState.consoleHeight = root.offsetHeight;
      saveUiPanelState();
    });

    function render(state, options = {}) {
      const { liveOnly = false } = options;
      const strip = renderStatusStripValues(state);

      statMatch.textContent = strip.match;
      statSport.textContent = strip.sport;
      statOpen.textContent = strip.openTrades;
      if (statCw) {
        statCw.textContent = strip.cricwayBalance;
        statCw.className = `mr-stat-v mr-stat-cw mr-cw-${strip.cricwayBalanceState}`;
      }
      if (statTg) {
        statTg.textContent = strip.telegram;
        statTg.className = `mr-stat-v mr-stat-tg mr-tg-${strip.telegramState}`;
      }
      exportJsonBtn.disabled = !strip.exportEnabled;
      exportJsonBtn.dataset.eventId = strip.exportEventId || "";

      root.classList.toggle("mr-alert-active", Date.now() < state.alertFlashUntil);

      if (liveOnly) {
        boardWrap.innerHTML = renderBoardHtml(state);
        paperWrap.innerHTML = renderPaperDashboard(state);
        chartWrap.innerHTML = renderSpikeChartSection(state);
        return;
      }

      updateTelegramStatusUi();
      syncTradingToggleButton();
      bracketWrap.innerHTML = renderBracketSection(state);
      paperWrap.innerHTML = renderPaperDashboard(state);
      chartWrap.innerHTML = renderSpikeChartSection(state);
      validationWrap.innerHTML = renderValidationSection(state);
      boardWrap.innerHTML = renderBoardHtml(state);
    }

    function flashHeader() {
      alertFlashUntil = Date.now() + ALERT_FLASH_MS;
      root.classList.add("mr-alert-active");
      window.setTimeout(() => {
        if (Date.now() >= alertFlashUntil) {
          root.classList.remove("mr-alert-active");
        }
      }, ALERT_FLASH_MS);
    }

    function updateCricwayBalanceUi() {
      const strip = renderStatusStripValues(getViewState());
      if (statCw) {
        statCw.textContent = strip.cricwayBalance;
        statCw.className = `mr-stat-v mr-stat-cw mr-cw-${strip.cricwayBalanceState}`;
      }
      for (const el of root.querySelectorAll(".mr-cw-balance")) {
        el.textContent = strip.cricwayBalance;
      }
    }

    return {
      render,
      flashHeader,
      syncTelegramInputs,
      updateTelegramStatusUi,
      updateCricwayBalanceUi,
      syncPaperInputs,
      syncMinimized: () => {
        setPanelMinimized(Boolean(uiPanelState.minimized));
        applyConsoleHeight();
      }
    };
  }

  function nudge() {
    document.dispatchEvent(new CustomEvent("market-radar-nudge"));
  }

  window.__spikexSpikeDebug = () => {
    const fm = board.focusedMatch;
    const watch = getSpikeWatchStatus(fm);
    const limits = getOddsLimits(fm?.sportName, fm?.sportId);
    const memory = {};
    if (fm?.eventId) {
      for (const runner of fm.runners || []) {
        const rk = String(runner.runnerId || runner.runnerName);
        const key = `${fm.eventId}:${rk}`;
        const mem = priceMemory.get(key);
        memory[runner.runnerName] = {
          back: runner.back,
          lay: runner.lay,
          inBracket: runnerInBracket(runner, fm.sportName, fm.sportId),
          history: mem?.history || [],
          historyLen: mem?.history?.length || 0,
          armed: (mem?.history?.length || 0) >= MEMORY_DEPTH
        };
      }
    }
    const out = {
      onDetailPage: isOnMatchDetailPage(),
      storeConnected,
      eventId: fm?.eventId || null,
      matchKey: watchedMatchKey,
      sport: fm?.sportName,
      minSpikePct: getMinSpikePct(fm?.sportName, fm?.sportId),
      oddsBracket: limits,
      oddsFilterOn: bracketConfig.oddsFilterEnabled,
      geminiGate: GEMINI_GATE_TRADES,
      geminiMinConfidence: GEMINI_MIN_APPROVE_CONFIDENCE,
      watch,
      totalSpikes,
      recentSpikes: recentSpikes.slice(0, 5),
      memory,
      tips: []
    };
    if (!out.onDetailPage) out.tips.push("Open a match detail page (Match Odds visible).");
    if (watch.inBracket === 0 && limits) {
      out.tips.push(`All runners outside odds bracket ${limits.minOdds}–${limits.maxOdds} — no spikes will fire.`);
    }
    if (watch.memoryReady === 0 && watch.inBracket > 0) {
      out.tips.push("Need 3 back-odds ticks per runner before spikes can fire — wait for price moves.");
    }
    if (watch.inBracket > 0 && watch.memoryReady > 0) {
      out.tips.push("Watching — waiting for ≥" + out.minSpikePct + "% move from oldest of last 3 ticks.");
    }
    console.log("[SpikeX spike debug]", out);
    return out;
  };

  window.__spikexTelegramDebug = async () => {
    await ensureTelegramConfigured();
    const out = {
      alertsEnabled: settings.telegramAlertsEnabled,
      hasToken: Boolean(settings.telegramBotToken.trim()),
      tokenValid: isValidTelegramToken(normalizeTelegramToken(settings.telegramBotToken)),
      chatIds: parseTelegramChatIds(settings.telegramChatId),
      configured: hasTelegramConfigured(),
      lastStatus: telegramStatus,
      cloudStatus: telegramCloudStatus
    };
    console.log("[SpikeX Telegram debug]", out);
    if (out.configured && out.alertsEnabled) {
      const test = await sendTelegramAlert("SpikeX Telegram test — config OK.", "debug-test");
      out.testSend = test;
      console.log("[SpikeX Telegram debug] test send:", test);
    }
    return out;
  };

  window.__spikexMatchContext = () => {
    const payload = buildReviewContextProbe();
    console.log("[SpikeX match context]", payload);
    return payload;
  };

  // Page console ("top") can't see content-script window.* — bridge via postMessage.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "spikex-page") return;
    if (event.data?.type !== "match-context-request") return;
    const payload = buildReviewContextProbe();
    window.postMessage(
      { source: "spikex-cs", type: "match-context-result", payload, at: Date.now() },
      "*"
    );
  });

  window.__spikexOddsMemory = {
    stats: getOddsMemoryStats,
    exportMatch: (eventId) => {
      const match = oddsMemoryStore.matches[String(eventId || "")];
      return match ? JSON.parse(JSON.stringify(match)) : null;
    },
    exportAll: () => JSON.parse(JSON.stringify(oddsMemoryStore)),
    flush: () => flushOddsMemorySave(),
    clearMatch: async (eventId) => {
      const id = String(eventId || "");
      if (!id) return false;
      delete oddsMemoryStore.matches[id];
      for (const key of [...oddsMemoryLastTick.keys()]) {
        if (key.startsWith(`${id}:`)) oddsMemoryLastTick.delete(key);
      }
      oddsMemoryDirty = true;
      await flushOddsMemorySave();
      return true;
    }
  };

  window.__marketRadarPaperAudit = () => {
    const rows = getPaperAuditRows(20);
    rows.forEach(logPaperTradeAudit);
    console.table(
      rows.map((r) => ({
        side: r.side,
        entry: r.entryOdds,
        exit: r.exitOdds,
        target: r.targetOdds,
        stop: r.stopOdds,
        actual: r.actualResult,
        expectedPnl: r.expectedFromPnl,
        expectedBarrier: r.expectedFromBarriers,
        pnl: r.pnlRecomputed.toFixed(2),
        match: r.pnlMatchesResult && r.barriersMatchResult
      }))
    );
    return rows;
  };

  panelApi = createPanel();
  void bootLocal();
  startLivePagePoll();
  startAccountPoll();

  nudge();
  window.setInterval(nudge, 3000);
})();
