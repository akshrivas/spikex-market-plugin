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
      minSpikePct: 20,
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

  /** Testing: no odds bracket, low spike bar, alerts even with open paper trade */
  const SPIKE_ALERT_TESTING = true;

  const MEMORY_DEPTH = SPIKE_ALERT_TESTING ? 2 : BRACKET.MEMORY_DEPTH;
  const SPIKE_COOLDOWN_MS = SPIKE_ALERT_TESTING ? 3000 : BRACKET.SPIKE_COOLDOWN_MS;
  const SPIKE_TEST_MIN_PCT = 10;
  const TEST_MAX_OPEN_TRADES = 25;
  const ALERT_FLASH_MS = 6000;
  const TELEGRAM_STORAGE_KEY = "marketRadar.telegram";
  const PAPER_STORAGE_KEY = "marketRadar.paper";
  const VALIDATION_STORAGE_KEY = "marketRadar.validation";
  const UI_STORAGE_KEY = "marketRadar.ui";
  const BRACKET_CONFIG_STORAGE_KEY = "marketRadar.bracketConfig";
  const MAX_VALIDATION_ROWS = 1000;

  function getTradeExitReason(result, options = {}) {
    if (options.manual) return "MANUAL";
    return result === "WIN" ? "TARGET" : "STOP";
  }

  const bracketConfigDefaults = {
    oddsFilterEnabled: !SPIKE_ALERT_TESTING,
    overrideSportOdds: false,
    minOdds: BRACKET.MIN_ODDS,
    maxOdds: 20
  };

  let bracketConfig = { ...bracketConfigDefaults };

  const UI_PANEL_DEFAULTS = {
    bracket: true,
    paper: true,
    chart: true,
    live: true,
    validation: true,
    telegram: false,
    minimized: false,
    consoleHeight: 400
  };

  const CHART_HISTORY_MAX = 50;

  const PAPER_STARTING_BANKROLL = BRACKET.STARTING_BANKROLL;
  const PAPER_POSITION_PCT = BRACKET.POSITION_PCT;
  const PAPER_TARGET_PCT = BRACKET.TARGET_PCT;
  const PAPER_STOP_PCT = BRACKET.STOP_PCT;

  const settings = {
    telegramAlertsEnabled: true,
    telegramBotToken: "",
    telegramChatId: ""
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

  function normalizeTelegramToken(token) {
    return String(token || "").trim();
  }

  function normalizeTelegramChatId(chatId) {
    const raw = String(chatId || "").trim();
    if (!raw) return "";
    if (/^-?\d+$/.test(raw)) return Number(raw);
    return raw;
  }

  function parseTelegramChatIds(raw) {
    const ids = [];
    const seen = new Set();

    for (const part of String(raw || "").split(/[\s,;]+/)) {
      const token = part.trim();
      if (!token) continue;
      const normalized = normalizeTelegramChatId(token);
      const key = String(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(normalized);
    }

    return ids;
  }

  function mergeTelegramChatIds(...sources) {
    const merged = [];
    const seen = new Set();
    for (const raw of sources) {
      for (const id of parseTelegramChatIds(raw)) {
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(id);
      }
    }
    return merged.map(String).join("\n");
  }

  function cloudConfigApi() {
    return window.__spikexCloudConfig || window.__spikexTelegramConfig || null;
  }

  function isValidTelegramToken(token) {
    return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token);
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
    if (!parseTelegramChatIds(settings.telegramChatId).length) return "Enter chat ID(s)";
    if (!settings.telegramAlertsEnabled) return "Alerts off";
    return telegramStatus || "Ready";
  }

  function normalizeOdds(price) {
    if (price == null || price === "") return null;
    const n = Number(price);
    return Number.isFinite(n) ? n : null;
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

  function getMinSpikePct(sportName, sportId) {
    if (SPIKE_ALERT_TESTING) return SPIKE_TEST_MIN_PCT;
    return getSportBracket(sportName, sportId).minSpikePct;
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
    return !id || id.startsWith("dom-") || !/^\d+$/.test(id);
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

  function buildMatchNameFromRunners(runners) {
    const teams = (runners || []).filter((r) => !/the draw|^draw$/i.test(r.runnerName));
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

  function ensureDetailOdds() {
    if (!isOnMatchDetailPage()) return false;

    board.pageMode = "detail";
    const reduxFm = isReduxFocusedMatch(board.focusedMatch) ? board.focusedMatch : null;
    if (!syncLivePageMatch(reduxFm)) return false;

    board.focusedMatch = mergeDomWithRedux(board.focusedMatch, reduxFm);
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

    const runners = scrapeRunnersFromDomInContentScript();
    if (!runners.length) return false;

    const matchName = buildMatchNameFromRunners(runners);
    const prev = board.focusedMatch;
    const pathSport = sportFromPagePath();
    const eventId =
      reduxHint?.eventId && !isSyntheticEventId(reduxHint.eventId)
        ? String(reduxHint.eventId)
        : prev?.eventId && !isSyntheticEventId(prev.eventId)
          ? String(prev.eventId)
          : tabMatchContext.eventId || prev?.eventId || `live-${matchName.toLowerCase().replace(/\s+/g, "-").slice(0, 36)}`;

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
          pathSport?.sportId ||
          prev?.sportId ||
          board.trackSportId ||
          (runners.length >= 3 ? "1" : "4"),
        sportName:
          reduxHint?.sportName ||
          pathSport?.sportName ||
          prev?.sportName ||
          board.trackSportName ||
          (runners.length >= 3 ? "Football" : "Cricket"),
        source: "live-page",
        marketSuspended: false,
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
    resetWatchState(fm.eventId);

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
    if (s === "—" || s === "Ready") return "ON";
    if (/sent|ok/i.test(s)) return "OK";
    if (/fail|error/i.test(s)) return "ERR";
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
      trades: closed + getOpenTradeCount(),
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
    const openTrades = state.paper?.openCount ?? getOpenTradeCount();
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
      sport,
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
    const n = state.paper?.openCount ?? 0;
    if (n <= 0) return "";
    return SPIKE_ALERT_TESTING && n > 1 ? `${n} OPEN` : "OPEN";
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
  const lastSpikeAt = new Map();
  let selectedRunnerKey = null;
  let tickChanges = 0;
  let totalSpikes = 0;
  let recentSpikes = [];
  let lastBoardAt = 0;
  let watchedEventId = null;
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
        secondaryMapSize: data.secondaryMapSize || 0,
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

  function validationKeysForMatch(eventId, matchName) {
    const keys = new Set();
    if (eventId) keys.add(String(eventId));

    for (const [key, match] of Object.entries(validationStore.matches)) {
      if (matchName && matchNamesEquivalent(match.matchName, matchName)) {
        keys.add(key);
      }
      if (eventId && match.eventId && String(match.eventId) === String(eventId)) {
        keys.add(key);
      }
    }

    return [...keys];
  }

  function consolidateValidationMatches(eventId, matchName) {
    const primaryKey = String(eventId || "");
    if (!primaryKey) return primaryKey;

    const keys = validationKeysForMatch(primaryKey, matchName);
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

  function validationRowsForView(eventId, matchName) {
    if (!eventId && !matchName) return [];
    consolidateValidationMatches(eventId, matchName);
    const keys = validationKeysForMatch(eventId, matchName);
    const seen = new Set();
    const rows = [];

    for (const key of keys) {
      const match = validationStore.matches[key];
      if (!match?.rows?.length) continue;
      for (const row of match.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }

    return rows.sort((a, b) => a.at - b.at);
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

  function checkPaperTradeExit(fm) {
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
      eventId: base.eventId || fm?.eventId || getCurrentMatchContext().eventId || null,
      pageUrl: location.href
    };
  }

  function formatSpikeMessage(entry) {
    const sign = entry.delta > 0 ? "+" : "";
    const spikeDir = entry.dir === "up" ? "↑ UP" : "↓ DOWN";
    const decision = entry.decision || bracketTradeHypothesis(entry.delta);
    const lines = [
      "🔥 SPIKE DETECTED",
      "",
      "Match:",
      entry.matchName || resolveLiveMatchName(),
      ""
    ];

    if (entry.sportName) {
      lines.push("Sport:", entry.sportName, "");
    }
    if (entry.eventId) {
      lines.push("Event:", String(entry.eventId), "");
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
      "Hypothesis:",
      spikeActionLabel(decision)
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
      telegramStatus = "Bot token format looks wrong";
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
    void sendTelegramMessage(formatSpikeMessage(entry));
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
        if (!payload.telegramBotToken && remote?.telegramBotToken) {
          payload.telegramBotToken = remote.telegramBotToken;
        }
        settings.telegramChatId = payload.telegramChatId;
        settings.telegramBotToken = payload.telegramBotToken;
        await api.saveTelegramConfig(payload);
        telegramCloudStatus = "Saved to cloud";
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
          settings.telegramBotToken =
            remote.telegramBotToken || settings.telegramBotToken;
          settings.telegramChatId = mergeTelegramChatIds(
            remote.telegramChatId,
            settings.telegramChatId
          );
          if (remote.telegramAlertsEnabled === false) {
            settings.telegramAlertsEnabled = false;
          }
          await storageSet({ [TELEGRAM_STORAGE_KEY]: telegramSettingsPayload() });
          telegramCloudStatus = remote.telegramBotToken || remote.telegramChatId ? "Loaded from cloud" : "";
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
    if (SPIKE_ALERT_TESTING) {
      bracketConfig.oddsFilterEnabled = false;
    }
  }

  async function bootLocal() {
    await Promise.all([
      loadUiPanelState(),
      loadTelegramSettings(),
      loadPaperState(),
      loadValidationStore(),
      loadBracketConfig()
    ]);
    if (uiPanelState.selectedRunnerKey) selectedRunnerKey = uiPanelState.selectedRunnerKey;
    paperReady = true;
    await refreshSystemPaperFromCloud();
    refreshCricwayAccount();
    panelApi?.syncMinimized?.();
    panelApi?.render?.(getViewState());
    panelApi?.updateCricwayBalanceUi?.();
  }

  function triggerSpikeAlert(entry) {
    activeAlert = entry;
    alertFlashUntil = Date.now() + ALERT_FLASH_MS;
    playSpikeTone();
    sendTelegramSpikeAlert(entry);
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
    const key = `${eventId}:${runnerKey}`;
    const prev = priceMemory.get(key) || { history: [], back: null };
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
      if (paperReady && spikesEnabled && history.length >= MEMORY_DEPTH) {
        const baseline = history[0];
        spikeDelta = pctChange(baseline, back);
        if (spikeDelta != null && Math.abs(spikeDelta) >= minSpikePct) {
          const last = lastSpikeAt.get(key) || 0;
          if (Date.now() - last >= SPIKE_COOLDOWN_MS) {
            const decision = bracketTradeHypothesis(spikeDelta);
            const entryPrice = spikeEntryPrice(decision, back, lay);
            if (isPriceInBracket(entryPrice, sportName, sportId)) {
              spike = true;
              lastSpikeAt.set(key, Date.now());
              totalSpikes += 1;

              const entry = buildSpikeEntry({
                at: Date.now(),
                matchName,
                runnerName,
                sportName,
                eventId,
                from: baseline,
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

              const paperSkipped = getOpenTradeCount() >= getMaxOpenTrades();
              const signalRowId = recordValidationSignal({
                eventId,
                matchName,
                runnerName,
                runnerKey,
                back,
                lay,
                history,
                baseline,
                currentBack: back,
                spikeDelta,
                decision,
                matchState,
                sportName,
                paperSkipped,
                paperBlocked: false,
                paperBlockedOutsideOdds: false
              });

              if (SPIKE_ALERT_TESTING || !paperSkipped) {
                triggerSpikeAlert(entry);
              }
              if (!paperSkipped) {
                tryOpenPaperTrade(entry, eventId, runnerKey, signalRowId);
              }
            }
          }
        }
      }
    }

    if (prev.back == null && back != null && !backChanged) {
      pushChartPoint(key, back, Date.now());
    }

    if (tradable) {
      priceMemory.set(key, {
        history: pushHistory(prev.history, back),
        back,
        lay
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

  function resetWatchState(eventId) {
    const nextId = String(eventId || "");
    if (watchedEventId === nextId) return;
    if (watchedEventId) {
      clearChartHistory(watchedEventId);
      selectedRunnerKey = null;
    }
    watchedEventId = nextId;
    clearSpikeMemory();
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
      resetWatchState(fm.eventId);
    }

    if (onDetail && fm?.runners?.length) {
      const suspended = Boolean(fm.marketSuspended);
      if (!suspended && lastMarketSuspended) {
        clearSpikeMemory();
      }
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

      checkPaperTradeExit(fm);
      board = { ...board, pageMode: "detail", focusedMatch: fm };
    }
  }

  function getViewState() {
    ensureDetailOdds();
    const ctx = getCurrentMatchContext();
    const onDetail = board.pageMode === "detail" && ctx.eventId;
    if (onDetail) {
      syncValidationForMatch(ctx.eventId, ctx.matchName);
    }

    const globalPaper = getPaperStats();
    const matchPaper = onDetail ? getMatchPaperStats(ctx.eventId, ctx.matchName) : null;

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
      paper: {
        ...globalPaper,
        global: globalPaper,
        match: matchPaper,
        enabled: true,
        state: matchPaper?.state || paper.state,
        openTrade: matchPaper?.openTrade || null,
        otherOpenTrade: matchPaper?.otherOpenTrade || null,
        recentTrades: onDetail ? getTradesForMatch(ctx.eventId, ctx.matchName, 6) : [],
        auditRows: onDetail ? getPaperAuditRowsForMatch(ctx.eventId, ctx.matchName, 20) : []
      },
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
    const b = state.bracket || getBracketMetrics();
    const tg = formatTelegramStatusShort(state);

    return `
      <div class="mr-research">
        <table class="mr-kv-table mr-research-progress">
          <tbody>
            <tr><th>Signals</th><td>${rp.signals}</td></tr>
            <tr><th>Trades</th><td>${rp.trades}</td></tr>
            <tr><th>Matches</th><td>${rp.matches}</td></tr>
            <tr><th>Closed</th><td>${rp.closed}/${rp.closedTarget}</td></tr>
            <tr><th>In bracket</th><td>${watch.inBracket}/${watch.total} runners</td></tr>
            <tr><th>Spike memory</th><td>${watch.memoryReady}/${watch.inBracket || watch.total} ready (3 ticks)</td></tr>
            <tr><th>Spikes seen</th><td>${state.totalSpikes ?? 0}</td></tr>
            <tr><th>Telegram</th><td>${escapeHtml(tg)}</td></tr>
          </tbody>
        </table>
        <div class="mr-bracket-grid mr-bracket-compact">
          <span>${SPIKE_ALERT_TESTING ? `<span class="mr-warn">TESTING</span> · all odds · ≥${SPIKE_TEST_MIN_PCT}% · ${MEMORY_DEPTH} ticks` : `${escapeHtml(activeSport.label)} ${activeOdds ? `${activeOdds.minOdds}–${activeOdds.maxOdds}` : "—"} · ≥${activeSport.minSpikePct}% · LOCKED`}</span>
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

  function renderPaperBody(state) {
    const p = state.paper;
    const mp = p?.match;
    if (!p) return "";

    const matchPnl = mp?.matchPnl ?? 0;
    const lastClosed = mp?.trades?.[0] || null;
    let openCell = "—";
    const openTrades = mp?.openTrades?.length
      ? mp.openTrades
      : p.openTrade
        ? [p.openTrade]
        : [];
    if (openTrades.length) {
      openCell = openTrades
        .map(
          (t) =>
            `${escapeHtml(t.side)} ${escapeHtml(t.runner)} @ ${formatOdds(t.entryOdds)}`
        )
        .join("<br>");
    } else if (p.otherOpenTrade) {
      openCell = `${escapeHtml(p.otherOpenTrade.side)} · other match`;
    }

    let lastCell = "—";
    if (lastClosed) {
      const cls = lastClosed.result === "WIN" ? "mr-ok" : "mr-warn";
      lastCell = `<span class="${cls}">${escapeHtml(lastClosed.side)} ${formatOdds(lastClosed.entryOdds)}→${formatOdds(lastClosed.exitOdds)} ${formatInr(lastClosed.pnl)}</span>`;
    }

    const cw = state.cricwayAccount || {};
    const cwLabel = cw.username ? `Cricway (${escapeHtml(cw.username)})` : "Cricway";

    return `
      <table class="mr-kv-table">
        <tbody>
          <tr><th>${cwLabel}</th><td class="mr-cw-balance">${formatCricwayBalance(cw.balance)}</td></tr>
          <tr><th>Paper bank</th><td>${formatInr(p.bankroll)}</td></tr>
          <tr><th>Match PnL</th><td class="${matchPnl >= 0 ? "mr-ok" : "mr-warn"}">${formatInr(matchPnl)}</td></tr>
          <tr><th>Open</th><td>${openCell}</td></tr>
          <tr><th>Last Closed</th><td>${lastCell}</td></tr>
        </tbody>
      </table>
    `;
  }

  function renderPaperDashboard(state) {
    if (state.board.pageMode !== "detail") {
      const p = state.paper;
      if (!p) return "";
      return renderPanel(
        "paper",
        "Paper",
        "",
        `<table class="mr-kv-table"><tbody>
          <tr><th>Cricway</th><td class="mr-cw-balance">${formatCricwayBalance(state.cricwayAccount?.balance)}</td></tr>
          <tr><th>Paper bank</th><td>${formatInr(p.bankroll)}</td></tr>
        </tbody></table>`
      );
    }
    const ctx = getCurrentMatchContext();
    if (!state.board?.focusedMatch?.runners?.length && !ctx.eventId) {
      return renderMatchWaitPanel("paper", "Paper", formatPaperBadge(state));
    }
    if (!state.board?.focusedMatch?.runners?.length && ctx.eventId) {
      const p = state.paper;
      const mp = getMatchPaperStats(ctx.eventId, ctx.matchName);
      return renderPanel(
        "paper",
        "Paper",
        formatPaperBadge(state),
        `<table class="mr-kv-table"><tbody>
          <tr><th>Cricway</th><td class="mr-cw-balance">${formatCricwayBalance(state.cricwayAccount?.balance)}</td></tr>
          <tr><th>Paper bank</th><td>${formatInr(p.bankroll)}</td></tr>
          <tr><th>Match PnL</th><td>${formatInr(mp?.matchPnl ?? 0)}</td></tr>
        </tbody></table>`
      );
    }
    if (!state.board?.focusedMatch) return renderMatchWaitPanel("paper", "Paper", formatPaperBadge(state));
    return renderPanel("paper", "Paper", formatPaperBadge(state), renderPaperBody(state));
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
          <button type="button" class="mr-alerts-toggle" title="Toggle Telegram alerts">ALERTS ON</button>
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
              <p class="mr-telegram-hint">Token &amp; chat IDs save to cloud — same on every browser. Each person must open your bot and tap <strong>Start</strong>. One chat ID per line.</p>
              <p class="mr-telegram-cloud"></p>
              <label class="mr-telegram-field">
                Bot token
                <input type="password" class="mr-telegram-token" placeholder="123456:ABC..." autocomplete="off" />
              </label>
              <label class="mr-telegram-field">
                Chat IDs
                <textarea class="mr-telegram-chat" rows="3" placeholder="1327411160&#10;1248568854" autocomplete="off"></textarea>
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
    const alertsToggleBtn = root.querySelector(".mr-alerts-toggle");
    const exportJsonBtn = root.querySelector(".mr-export-json");
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

    function syncPaperInputs() {
      /* Paper trading locked ON by Bracket v1 */
    }

    exportJsonBtn.addEventListener("click", () => {
      const eventId = exportJsonBtn.dataset.eventId;
      if (!eventId || exportJsonBtn.disabled) return;
      void copyValidationJson(eventId, exportJsonBtn);
    });

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
      settings.telegramBotToken = telegramTokenEl.value.trim();
      settings.telegramChatId = telegramChatEl.value.trim();
    }

    function scheduleTelegramSave() {
      readTelegramFromInputs();
      clearTimeout(telegramSaveTimer);
      telegramSaveTimer = setTimeout(() => {
        void saveTelegramSettings();
      }, 400);
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
    }

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
      void sendTelegramMessage(formatSpikeMessage(buildTelegramTestSpikeEntry()));
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
