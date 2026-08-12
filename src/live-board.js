(() => {
  const NS =
    window.__marketRadarLiveBoard ||
    (window.__marketRadarLiveBoard = {
      booted: false,
      subscribed: false,
      retryTimer: null,
      publishTimer: null,
      publishRaf: 0,
      retryCount: 0
    });

  if (NS.booted) {
    NS.tryConnect?.();
    return;
  }
  NS.booted = true;

  const FIND_RETRY_MS = 500;

  const SPORT_MAP = {
    "1": "Football",
    "2": "Tennis",
    "4": "Cricket",
    "7": "Horse Racing",
    "4339": "Greyhound Racing",
    "7522": "Basketball",
    "7511": "Baseball"
  };

  function post(type, payload = {}) {
    const detail = { source: "market-radar", type, ...payload };
    window.postMessage(detail, "*");
    document.dispatchEvent(new CustomEvent("market-radar-bridge", { detail }));
  }

  post("board-ready", { at: Date.now() });

  function isReduxStore(obj) {
    return (
      obj &&
      typeof obj.getState === "function" &&
      typeof obj.dispatch === "function" &&
      typeof obj.subscribe === "function"
    );
  }

  function storeFromProps(props) {
    if (!props) return null;
    if (isReduxStore(props.store)) return props.store;
    if (isReduxStore(props.value?.store)) return props.value.store;
    return null;
  }

  function storeFromHookState(state, depth = 0) {
    if (!state || depth > 50) return null;
    if (isReduxStore(state.store)) return state.store;
    if (state.memoizedState) {
      const nested = storeFromHookState(state.memoizedState, depth + 1);
      if (nested) return nested;
    }
    return storeFromHookState(state.next, depth + 1);
  }

  function fiberFromElement(el) {
    const key = Object.keys(el).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")
    );
    if (!key) return null;
    const holder = el[key];
    if (holder?.current) return holder.current;
    if (holder?.stateNode?.current) return holder.stateNode.current;
    if (holder?.tag != null) return holder;
    return null;
  }

  function walkFiber(node, depth = 0, visited = new Set()) {
    if (!node || depth > 300 || visited.has(node)) return null;
    visited.add(node);

    const fromProps =
      storeFromProps(node.memoizedProps) || storeFromProps(node.pendingProps);
    if (fromProps) return fromProps;

    const fromHooks = storeFromHookState(node.memoizedState);
    if (fromHooks) return fromHooks;

    return (
      walkFiber(node.child, depth + 1, visited) ||
      walkFiber(node.sibling, depth + 1, visited)
    );
  }

  function pickCatalogStore(store) {
    if (!isReduxStore(store)) return null;
    try {
      if (store.getState()?.catalog != null) return store;
    } catch {
      return null;
    }
    return null;
  }

  function findStore() {
    if (isReduxStore(window.__marketRadarCachedStore)) {
      try {
        if (window.__marketRadarCachedStore.getState()?.catalog != null) {
          return window.__marketRadarCachedStore;
        }
      } catch {
        window.__marketRadarCachedStore = null;
      }
    }

    const root = document.getElementById("root");
    if (root) {
      const fiber = fiberFromElement(root);
      if (fiber) {
        const fromRoot = pickCatalogStore(walkFiber(fiber));
        if (fromRoot) {
          window.__marketRadarCachedStore = fromRoot;
          return fromRoot;
        }
      }
    }

    const nodes = document.querySelectorAll("#root, #root *");
    for (const el of nodes) {
      let fiber = fiberFromElement(el);
      for (let depth = 0; fiber && depth < 14; depth += 1) {
        const found =
          pickCatalogStore(storeFromProps(fiber.memoizedProps)) ||
          pickCatalogStore(storeFromProps(fiber.pendingProps)) ||
          pickCatalogStore(storeFromHookState(fiber.memoizedState));
        if (found) {
          window.__marketRadarCachedStore = found;
          return found;
        }
        fiber = fiber.return;
      }
    }

    return null;
  }

  function sportLabel(sportId, eventTypes) {
    const match = eventTypes?.find((item) => String(item.id) === String(sportId));
    return match?.name || SPORT_MAP[String(sportId)] || `Sport ${sportId}`;
  }

  function firstPrice(prices) {
    const price = prices?.[0]?.price;
    return price != null && price !== "" ? Number(price) : null;
  }

  function formatBack(back) {
    return back != null && Number.isFinite(back) ? back.toFixed(2) : "—";
  }

  function isMarketSuspended(market, event) {
    if (event?.eventSuspended) return true;
    if (!market) return false;
    if (market.suspend || market.disable) return true;
    const status = String(market.status || "").toUpperCase();
    return status === "SUSPENDED" || status === "CLOSED";
  }

  function isRunnerSuspended(runner, marketSuspended) {
    if (marketSuspended) return true;
    return String(runner?.status || "").toUpperCase() === "SUSPENDED";
  }

  function runnerColumn(runner, marketSuspended) {
    if (!runner) {
      return { back: null, lay: null, label: "—", suspended: true };
    }
    const suspended = isRunnerSuspended(runner, marketSuspended);
    return {
      back: firstPrice(runner.backPrices),
      lay: firstPrice(runner.layPrices),
      label: runner.runnerName || runner.RunnerName || "—",
      suspended,
      runnerStatus: runner.status || null
    };
  }

  function normalizeEventId(id) {
    return String(id || "")
      .split(":")
      .join("_");
  }

  function eventIdVariants(id) {
    const raw = String(id || "");
    const normalized = normalizeEventId(raw);
    return [...new Set([raw, normalized].filter(Boolean))];
  }

  function isDetailPage(catalog) {
    if (globalThis.__spikexOddsDetect?.isOddsDetailPage) {
      return globalThis.__spikexOddsDetect.isOddsDetailPage(catalog);
    }
    if (catalog?.selectedEvent?.id) return true;
    const bodyText = document.body?.innerText || "";
    if (/MATCH\s*ODDS|winner|who will win/i.test(bodyText.slice(0, 12000))) return true;
    if (/\/exchange_sports\//i.test(location.pathname) && !/\/inplay\/?$/i.test(location.pathname)) {
      return true;
    }
    return false;
  }

  function pickLiveMarket(event, catalog, multiMarket, options = {}) {
    if (globalThis.__spikexOddsDetect?.pickLiveMarket) {
      return globalThis.__spikexOddsDetect.pickLiveMarket(event, catalog, multiMarket, options);
    }

    const eventId = normalizeEventId(event.eventId || "");
    const onDetail = options.onDetail ?? false;
    const wsOn = Boolean(catalog.betFairWSConnected);

    if (onDetail && event.matchOdds?.runners?.length) {
      return { market: event.matchOdds, source: "matchOdds" };
    }

    if (event.matchOddsData?.runners?.length) {
      return { market: event.matchOddsData, source: "matchOddsData" };
    }

    if (event.matchOdds?.runners?.length) {
      return { market: event.matchOdds, source: "matchOdds" };
    }

    for (const id of eventIdVariants(eventId)) {
      for (const [key, market] of Object.entries(catalog.secondaryMatchOddsMap || {})) {
        if (String(key).startsWith(`${id}-`) && market?.runners?.length) {
          return { market, source: "secondary" };
        }
      }
    }

    return { market: null, source: "none" };
  }

  function firstRunnerBack(market) {
    const runner = market?.runners?.[0];
    return firstPrice(runner?.backPrices);
  }

  function runnersByColumn(runners) {
    const sorted = [...(runners || [])].sort(
      (a, b) => Number(a.sort || 99) - Number(b.sort || 99)
    );

    const one =
      sorted.find((r) => String(r.sort) === "1") ||
      sorted.find((r) => !/draw/i.test(r.runnerName || "")) ||
      sorted[0] ||
      null;

    const draw =
      sorted.find((r) => String(r.sort) === "3") ||
      sorted.find((r) => /draw/i.test(r.runnerName || r.RunnerName || "")) ||
      null;

    const two =
      sorted.find((r) => String(r.sort) === "2") ||
      sorted.find((r) => r !== one && r !== draw) ||
      sorted[1] ||
      null;

    return { one, draw, two };
  }

  function isLiveEvent(event) {
    if (!event?.enabled) return false;
    return String(event.status || "").toUpperCase() === "IN_PLAY";
  }

  function findEventById(eventsTree, eventId) {
    for (const id of eventIdVariants(eventId)) {
      for (const sportId of Object.keys(eventsTree || {})) {
        for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
          const event = eventsTree[sportId][competitionId]?.[id];
          if (event) {
            return { event, sportId, competitionId };
          }
        }
      }
    }
    return null;
  }

  function findEventBySelection(catalog) {
    const eventsTree = catalog.events || {};
    const eventId = normalizeEventId(catalog.selectedEvent?.id);
    if (eventId) {
      const located = findEventById(eventsTree, eventId);
      if (located) return located;
    }

    const sportId = catalog.selectedEventType?.id;
    const competitionId = normalizeEventId(catalog.selectedCompetition?.id);
    if (sportId && competitionId && eventId) {
      const event = eventsTree[sportId]?.[competitionId]?.[eventId];
      if (event) return { event, sportId, competitionId };
    }

    return null;
  }

  function collectInPlayEvents(eventsTree) {
    const rows = [];
    for (const sportId of Object.keys(eventsTree || {})) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
          const event = eventsTree[sportId][competitionId][eventId];
          if (isLiveEvent(event)) {
            rows.push({ event, sportId, competitionId });
          }
        }
      }
    }
    return rows;
  }

  function findInPlayOnDetailPage(eventsTree) {
    const inPlay = collectInPlayEvents(eventsTree);
    if (!inPlay.length) return null;

    const hint = getPageMatchHint();
    if (hint) {
      for (const row of inPlay) {
        if (eventMatchesHint(row.event, hint)) return row;
      }
    }

    const haystack = normalizeName(
      `${document.title} ${document.body?.innerText?.slice(0, 15000) || ""}`
    );
    for (const row of inPlay) {
      const eventName = row.event.eventName || row.event.customEventName;
      const tokens = tokenSet(eventName);
      if (tokens.length < 2) continue;
      const hits = tokens.filter((t) => haystack.includes(t)).length;
      if (hits >= Math.min(2, tokens.length)) return row;
    }

    if (inPlay.length === 1) return inPlay[0];
    return null;
  }

  function eventNameCandidates(event) {
    const names = [];
    const primary = event?.eventName || event?.customEventName;
    if (primary) names.push(primary);
    if (event?.homeTeam && event?.awayTeam) {
      names.push(`${event.homeTeam} v ${event.awayTeam}`);
      names.push(`${event.homeTeam} vs ${event.awayTeam}`);
    }
    return names;
  }

  function eventMatchesHint(event, hint) {
    if (!hint) return false;
    for (const name of eventNameCandidates(event)) {
      if (namesMatch(hint, name)) return true;
    }
    return false;
  }

  function findAnyEventOnDetailPage(eventsTree) {
    const hint = getPageMatchHint();
    const haystack = normalizeName(
      `${hint} ${document.title} ${document.body?.innerText?.slice(0, 15000) || ""}`
    );
    let best = null;

    for (const sportId of Object.keys(eventsTree || {})) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
          const event = eventsTree[sportId][competitionId][eventId];
          if (!event?.enabled) continue;
          const eventName = event.eventName || event.customEventName;
          if (hint && eventMatchesHint(event, hint)) {
            if (!best || isLiveEvent(event)) best = { event, sportId, competitionId };
            continue;
          }
          const tokens = tokenSet(eventName);
          if (tokens.length < 2) continue;
          const hits = tokens.filter((t) => haystack.includes(t)).length;
          if (hits >= Math.min(2, tokens.length)) {
            if (!best || isLiveEvent(event)) best = { event, sportId, competitionId };
          }
        }
      }
    }

    return best;
  }

  function normalizeName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTeamToken(token) {
    return String(token || "")
      .toLowerCase()
      .replace(/^(cd|fc|sc|ac|cf|de|rc|sd|ud|real|atletico)\s+/i, "")
      .trim();
  }

  function tokenSet(value) {
    return normalizeName(value)
      .split(/\s+v(?:s)?\.?\s+|\s+vs\s+/)
      .flatMap((part) => part.split(/\s+/))
      .map(normalizeTeamToken)
      .filter((part) => part.length > 2);
  }

  function namesMatch(hint, eventName) {
    const h = normalizeName(hint);
    const e = normalizeName(eventName);
    if (!h || !e) return false;
    if (h.includes(e) || e.includes(h)) return true;

    const hintTokens = tokenSet(h);
    const eventTokens = tokenSet(e);
    if (!hintTokens.length || !eventTokens.length) return false;

    let hits = 0;
    for (const token of eventTokens) {
      if (
        hintTokens.some(
          (hintToken) =>
            hintToken.includes(token) ||
            token.includes(hintToken) ||
            normalizeTeamToken(hintToken) === normalizeTeamToken(token)
        )
      ) {
        hits += 1;
      }
    }

    return hits >= Math.min(2, eventTokens.length);
  }

  function extractTeamNamesFromOddsDom() {
    const teams = [];
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
      if (!teams.includes(label)) teams.push(label);
      if (teams.length >= 2) break;
    }

    return teams;
  }

  function getPageMatchHint() {
    const parts = [
      document.title,
      document.querySelector("h1")?.textContent,
      document.querySelector("h2")?.textContent,
      document.querySelector("h3")?.textContent
    ];

    const bodyHead = (document.body?.innerText || "").slice(0, 8000);
    const vsLine = bodyHead.match(/[^\n]{4,80}\s+v(?:s)?\.?\s[^\n]{4,80}/i);
    if (vsLine) parts.push(vsLine[0]);

    const oddsTeams = extractTeamNamesFromOddsDom();
    if (oddsTeams.length >= 2) {
      parts.push(`${oddsTeams[0]} v ${oddsTeams[1]}`);
    } else if (oddsTeams.length === 1) {
      parts.push(oddsTeams[0]);
    }

    for (const el of document.querySelectorAll(
      "[class*='event'], [class*='match'], [class*='team'], [class*='Event'], [class*='Match']"
    )) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 8 && text.length < 120 && /\sv(?:s)?\.?\s/i.test(text)) {
        parts.push(text);
      }
    }

    return parts.filter(Boolean).join(" ").slice(0, 600);
  }

  function collectMapEventIds(catalog, multiMarket) {
    const ids = new Set();
    for (const key of Object.keys(catalog.secondaryMatchOddsMap || {})) {
      const eventId = normalizeEventId(String(key).split("-")[0]);
      if (eventId) ids.add(eventId);
    }
    for (const key of Object.keys(multiMarket?.secondaryMultiMatchOddsMap || {})) {
      const eventId = normalizeEventId(String(key).split("-")[0]);
      if (eventId) ids.add(eventId);
    }
    return ids;
  }

  function pickMarketFromMaps(eventId, catalog, multiMarket) {
    for (const id of eventIdVariants(eventId)) {
      for (const [key, market] of Object.entries(catalog.secondaryMatchOddsMap || {})) {
        if (String(key).startsWith(`${id}-`) && market?.runners?.length) return market;
      }
      for (const [key, market] of Object.entries(multiMarket?.secondaryMultiMatchOddsMap || {})) {
        if (String(key).startsWith(`${id}-`) && market?.runners?.length) return market;
      }
    }
    return null;
  }

  function findEventFromCatalogDetails(catalog) {
    const hint = getPageMatchHint();
    const urlIds = extractEventIdsFromPage();
    const slug = eventSlugFromPage();
    let best = null;
    let bestScore = -1;

    forEachCatalogDetail(catalog, (item, key) => {
      const located = locatedFromDetailItem(item, key, catalog);
      if (!located) return;

      const eventName = located.event.eventName || located.event.customEventName || located.event.name;
      if (hint && eventName && !namesMatch(hint, eventName) && !eventMatchesHint(located.event, hint)) {
        return;
      }

      const score = scoreLocatedEvent(located, catalog, hint, urlIds, slug);
      if (score > bestScore) {
        bestScore = score;
        best = located;
      }
    });

    return best;
  }

  function buildSyntheticLocated(eventId, catalog, multiMarket, hint) {
    const market = pickMarketFromMaps(eventId, catalog, multiMarket);
    if (!market?.runners?.length) return null;

    const teams = market.runners
      .map((r) => r.runnerName || r.RunnerName)
      .filter((name) => name && !/draw/i.test(name));
    const eventName =
      hint ||
      (teams.length >= 2 ? `${teams[0]} v ${teams[1]}` : teams[0]) ||
      getPageMatchHint() ||
      "Live match";

    return {
      event: {
        eventId,
        eventName,
        enabled: true,
        status: "IN_PLAY",
        matchOdds: market
      },
      sportId: String(catalog.selectedEventType?.id || "1"),
      competitionId: normalizeEventId(catalog.selectedCompetition?.id || "0")
    };
  }

  function findEventFromSecondaryMaps(store) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const eventsTree = catalog.events || {};
    const hint = getPageMatchHint();
    const eventIds = collectMapEventIds(catalog, state.multiMarket);
    if (!eventIds.size) return null;

    let best = null;
    for (const eventId of eventIds) {
      const located = findEventById(eventsTree, eventId);
      if (located) {
        const eventName = located.event.eventName || located.event.customEventName;
        if (!hint || namesMatch(hint, eventName)) return located;
        if (!best) best = located;
        continue;
      }
      const synthetic = buildSyntheticLocated(eventId, catalog, state.multiMarket, hint);
      if (synthetic && isDetailPage(catalog)) {
        if (!hint || namesMatch(hint, synthetic.event.eventName)) return synthetic;
        if (!best) best = synthetic;
      }
    }

    if (isDetailPage(catalog)) {
      if (eventIds.size === 1) {
        const eventId = [...eventIds][0];
        return best || buildSyntheticLocated(eventId, catalog, state.multiMarket, hint);
      }
      if (hint) {
        for (const eventId of eventIds) {
          const located = findEventById(eventsTree, eventId);
          if (located && namesMatch(hint, located.event.eventName || located.event.customEventName)) {
            return located;
          }
        }
      }
    }

    return best;
  }

  function extractEventIdFromPage() {
    const fromUrl = globalThis.__spikexOddsDetect?.eventIdsFromPageUrl?.() || [];
    if (fromUrl.length) return fromUrl[0];

    for (const el of document.querySelectorAll("[data-event-id], [data-eventid], [data-id]")) {
      const raw =
        el.getAttribute("data-event-id") ||
        el.getAttribute("data-eventid") ||
        el.getAttribute("data-id");
      if (raw && /^\d{5,}$/.test(String(raw))) return normalizeEventId(raw);
    }

    return null;
  }

  function extractEventIdsFromPage() {
    const ids = new Set(globalThis.__spikexOddsDetect?.eventIdsFromPageUrl?.() || []);
    const domId = extractEventIdFromPage();
    if (domId) ids.add(domId);
    const selectedId = normalizeEventId(globalThis.__marketRadarCachedStore?.getState?.()?.catalog?.selectedEvent?.id);
    if (selectedId) ids.add(selectedId);
    return [...ids];
  }

  function eventSlugFromPage() {
    return globalThis.__spikexOddsDetect?.slugFromPagePath?.() || "";
  }

  function forEachCatalogDetail(catalog, fn) {
    const details = catalog?.details;
    if (!details || typeof details !== "object") return;

    if (Array.isArray(details)) {
      for (const item of details) fn(item, null);
      return;
    }

    for (const [key, item] of Object.entries(details)) {
      if (!item || typeof item !== "object") continue;
      fn(item, key);
    }
  }

  function locatedFromDetailItem(item, key, catalog) {
    const event = item.event || item;
    const eventId = normalizeEventId(event.eventId || item.eventId || key);
    if (!eventId) return null;

    return {
      event: event.eventId ? event : { ...event, eventId },
      sportId: String(event.sportId || item.sportId || catalog.selectedEventType?.id || "4"),
      competitionId: normalizeEventId(
        event.competitionId || item.competitionId || catalog.selectedCompetition?.id || "0"
      )
    };
  }

  function scoreLocatedEvent(located, catalog, hint, urlIds, slug) {
    if (!located?.event) return -1;

    const event = located.event;
    const eventId = normalizeEventId(event.eventId || "");
    const eventName = event.eventName || event.customEventName || "";
    let score = 0;

    for (const id of urlIds) {
      if (eventIdVariants(eventId).includes(id)) score += 320;
    }

    const selectedId = normalizeEventId(catalog.selectedEvent?.id);
    if (selectedId && eventIdVariants(eventId).includes(selectedId)) score += 300;

    const eventSlug = String(event.eventSlug || "").toLowerCase();
    if (slug && eventSlug && (eventSlug === slug || eventSlug.includes(slug) || slug.includes(eventSlug))) {
      score += 260;
    }

    if (hint && (namesMatch(hint, eventName) || eventMatchesHint(event, hint))) score += 220;
    if (isLiveEvent(event)) score += 40;
    if (event.enabled !== false) score += 10;

    return score;
  }

  function scanStoreForFocusedMatch(store) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const multiMarket = state.multiMarket || {};
    const eventsTree = catalog.events || {};
    const hint = getPageMatchHint();
    const urlIds = extractEventIdsFromPage();
    const slug = eventSlugFromPage();
    const od = globalThis.__spikexOddsDetect;

    let best = null;
    let bestScore = -1;

    function consider(located) {
      if (!located?.event) return;

      const eventScore = scoreLocatedEvent(located, catalog, hint, urlIds, slug);
      const candidates = od?.collectMarketCandidates
        ? od.collectMarketCandidates(located.event, catalog, multiMarket, { onDetail: true })
        : [];

      for (const entry of candidates) {
        if (!od?.marketHasRunners?.(entry.market)) continue;

        const marketScore = od.scorePrimaryMarket(entry.market);
        const total = eventScore + marketScore;
        if (total > bestScore) {
          bestScore = total;
          best = { located, market: entry.market, source: entry.source };
        }
      }
    }

    for (const sportId of Object.keys(eventsTree)) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
          consider({
            event: eventsTree[sportId][competitionId][eventId],
            sportId,
            competitionId
          });
        }
      }
    }

    forEachCatalogDetail(catalog, (item, key) => {
      const located = locatedFromDetailItem(item, key, catalog);
      if (located) consider(located);
    });

    for (const eventId of collectMapEventIds(catalog, multiMarket)) {
      const located = findEventById(eventsTree, eventId);
      if (located) {
        consider(located);
      } else {
        const synthetic = buildSyntheticLocated(eventId, catalog, multiMarket, hint);
        if (synthetic) consider(synthetic);
      }
    }

    if (!best) return null;

    return buildFocusedMatchFromLocated(best.located, store, {
      market: best.market,
      source: best.source
    });
  }

  function scrapeRunnersFromDom() {
    if (!isDetailPage({})) return [];
    return globalThis.__spikexOddsDetect?.scrapeRunnersFromDom(document) || [];
  }

  function extractFocusedMatchFromDom(catalog) {
    if (!isDetailPage(catalog)) return null;

    const runners = scrapeRunnersFromDom();
    if (!runners.length) return null;

    const teams = runners.filter((r) => !/the draw|^draw$/i.test(r.runnerName));
    const hint = getPageMatchHint();
    const eventName =
      hint ||
      (teams.length >= 2
        ? `${teams[0].runnerName} v ${teams[1].runnerName}`
        : teams[0]?.runnerName || "Live match");
    const eventId = extractEventIdFromPage() || `dom-${normalizeName(eventName).replace(/\s+/g, "-").slice(0, 40)}`;
    const sportId = String(catalog.selectedEventType?.id || (teams.length === 3 ? "1" : "4"));

    return {
      eventId,
      eventName,
      status: "IN_PLAY",
      isLive: true,
      sportId,
      sportName: sportLabel(sportId, catalog.eventTypes),
      source: "dom",
      marketStatus: null,
      marketSuspended: false,
      eventSuspended: false,
      debugBack: { matchOdds: teams[0]?.back ?? null, matchOddsData: null },
      runners
    };
  }

  function buildFocusedMatchFromLocated(located, store, override = null) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const event = located.event;
    const onDetail = isDetailPage(catalog);
    const picked = override?.market
      ? { market: override.market, source: override.source || "scan" }
      : pickLiveMarket(event, catalog, state.multiMarket, { onDetail });
    const { market, source } = picked;
    const marketSuspended = isMarketSuspended(market, event);
    let runners = [...(market?.runners || [])]
      .sort((a, b) => Number(a.sort || 99) - Number(b.sort || 99))
      .map((runner) => {
        const col = runnerColumn(runner, marketSuspended);
        return {
          runnerId: String(runner.runnerId || col.label),
          runnerName: col.label,
          back: col.back,
          lay: col.lay,
          backText: col.suspended ? "SUSP" : formatBack(col.back),
          layText: col.suspended ? "SUSP" : formatBack(col.lay),
          suspended: col.suspended,
          runnerStatus: col.runnerStatus
        };
      });

    if (!runners.length) {
      runners = scrapeRunnersFromDom();
    }

    if (!runners.length) return null;

    return {
      eventId: normalizeEventId(event.eventId || ""),
      eventName: event.eventName || event.customEventName || getPageMatchHint() || "Unknown",
      competitionName: event.competitionName || catalog.selectedCompetition?.name || "",
      status: event.status || "unknown",
      isLive: isLiveEvent(event),
      sportId: located.sportId,
      sportName: sportLabel(located.sportId, catalog.eventTypes),
      source,
      marketStatus: market?.status || null,
      marketSuspended,
      eventSuspended: Boolean(event.eventSuspended),
      debugBack: {
        matchOdds: firstRunnerBack(event.matchOdds),
        matchOddsData: firstRunnerBack(event.matchOddsData)
      },
      runners
    };
  }

  function findFocusedEvent(store) {
    const catalog = store.getState().catalog || {};
    const eventsTree = catalog.events || {};

    const fromSelection = findEventBySelection(catalog);
    if (fromSelection) return fromSelection;

    const selectedId = catalog.selectedEvent?.id;
    if (selectedId) {
      const located = findEventById(eventsTree, String(selectedId));
      if (located) return located;
    }

    for (const urlId of extractEventIdsFromPage()) {
      const located = findEventById(eventsTree, urlId);
      if (located) return located;
    }

    const hint = getPageMatchHint();
    if (hint) {
      let best = null;
      for (const sportId of Object.keys(eventsTree)) {
        for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
          for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
            const event = eventsTree[sportId][competitionId][eventId];
            const eventName = event.eventName || event.customEventName;
            if (!namesMatch(hint, eventName) && !eventMatchesHint(event, hint)) continue;
            if (!best || isLiveEvent(event)) {
              best = { event, sportId, competitionId };
            }
          }
        }
      }
      if (best) return best;
    }

    if (isDetailPage(catalog)) {
      return (
        findInPlayOnDetailPage(eventsTree) ||
        findAnyEventOnDetailPage(eventsTree) ||
        findEventFromSecondaryMaps(store) ||
        findEventFromCatalogDetails(catalog)
      );
    }

    return null;
  }

  function extractFocusedMatch(store) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const onDetail = isDetailPage(catalog);

    if (onDetail) {
      let located = findFocusedEvent(store);
      if (!located) located = findEventFromSecondaryMaps(store);
      if (!located) located = findEventFromCatalogDetails(catalog);
      if (located) {
        const fromRedux = buildFocusedMatchFromLocated(located, store);
        if (fromRedux?.runners?.length) return fromRedux;
      }

      const scanned = scanStoreForFocusedMatch(store);
      if (scanned?.runners?.length) return scanned;

      return extractFocusedMatchFromDom(catalog);
    }

    let located = findFocusedEvent(store);
    if (!located) located = findEventFromSecondaryMaps(store);
    if (!located) located = findEventFromCatalogDetails(catalog);

    if (located) {
      return buildFocusedMatchFromLocated(located, store);
    }

    if (onDetail) {
      return extractFocusedMatchFromDom(catalog);
    }

    return null;
  }

  function extractLiveBoard(store, sportId = null) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const eventsTree = catalog.events || {};
    const onDetail = isDetailPage(catalog);
    const focusedMatch = extractFocusedMatch(store);
    const groups = new Map();

    if (onDetail) {
      const urlIds = extractEventIdsFromPage();
      return {
        at: Date.now(),
        pageMode: "detail",
        trackSportId: focusedMatch?.sportId || catalog.selectedEventType?.id || null,
        trackSportName: focusedMatch?.sportName || sportLabel(catalog.selectedEventType?.id, catalog.eventTypes) || "—",
        liveCount: focusedMatch ? 1 : 0,
        betFairWSConnected: Boolean(catalog.betFairWSConnected),
        secondaryMapSize: Object.keys(catalog.secondaryMatchOddsMap || {}).length,
        focusedMatch,
        groups: [],
        reduxDebug: {
          selectedEventId: catalog.selectedEvent?.id || null,
          urlIds,
          slug: eventSlugFromPage(),
          marketSource: focusedMatch?.source || null,
          runnerCount: focusedMatch?.runners?.length || 0
        }
      };
    }

    const sportIds = sportId ? [String(sportId)] : Object.keys(eventsTree);

    for (const sid of sportIds) {
      for (const competitionId of Object.keys(eventsTree[sid] || {})) {
        for (const eventId of Object.keys(eventsTree[sid][competitionId] || {})) {
          const event = eventsTree[sid][competitionId][eventId];
          if (!isLiveEvent(event)) continue;

          const { market, source } = pickLiveMarket(event, catalog, state.multiMarket, {
            onDetail: false
          });
          const cols = runnersByColumn(market?.runners);
          const marketSuspended = isMarketSuspended(market, event);
          const one = runnerColumn(cols.one, marketSuspended);
          const draw = runnerColumn(cols.draw, marketSuspended);
          const two = runnerColumn(cols.two, marketSuspended);

          const sportName = sportLabel(sid, catalog.eventTypes);
          if (!groups.has(sid)) {
            groups.set(sid, { sportId: sid, sportName, matches: [] });
          }

          groups.get(sid).matches.push({
            eventId: String(event.eventId || eventId),
            eventName: event.eventName || event.customEventName || "Unknown",
            competitionName: event.competitionName || "",
            source,
            one: { ...one, text: formatBack(one.back) },
            x: { ...draw, text: formatBack(draw.back) },
            two: { ...two, text: formatBack(two.back) }
          });
        }
      }
    }

    const orderedGroups = [...groups.values()]
      .map((group) => ({
        ...group,
        matches: group.matches.sort((a, b) =>
          a.eventName.localeCompare(b.eventName)
        )
      }))
      .sort((a, b) => {
        if (focusedMatch?.sportId && a.sportId === focusedMatch.sportId) return -1;
        if (focusedMatch?.sportId && b.sportId === focusedMatch.sportId) return 1;
        return a.sportName.localeCompare(b.sportName);
      });

    const liveCount = orderedGroups.reduce((sum, g) => sum + g.matches.length, 0);

    return {
      at: Date.now(),
      pageMode: "list",
      trackSportId: sportId,
      trackSportName: sportId ? sportLabel(sportId, catalog.eventTypes) : "All sports",
      liveCount,
      betFairWSConnected: Boolean(catalog.betFairWSConnected),
      secondaryMapSize: Object.keys(catalog.secondaryMatchOddsMap || {}).length,
      focusedMatch,
      groups: orderedGroups
    };
  }

  function publishBoard(store) {
    post("live-board", extractLiveBoard(store));
  }

  function schedulePublish(store) {
    if (NS.publishRaf) return;
    NS.publishRaf = requestAnimationFrame(() => {
      NS.publishRaf = 0;
      publishBoard(store);
    });
  }

  function attachStore(store) {
    if (NS.subscribed) return;
    NS.subscribed = true;

    publishBoard(store);

    store.subscribe(() => schedulePublish(store));

    if (!store.__marketRadarDispatchWrapped) {
      const dispatch = store.dispatch.bind(store);
      store.dispatch = (action) => {
        const result = dispatch(action);
        schedulePublish(store);
        return result;
      };
      store.__marketRadarDispatchWrapped = true;
    }

    if (NS.publishTimer) window.clearInterval(NS.publishTimer);
    NS.publishTimer = null;

    post("store-found", { liveCount: extractLiveBoard(store).liveCount });
  }

  function tryConnect() {
    NS.retryCount += 1;
    const store = findStore();

    if (store) {
      attachStore(store);
      if (NS.retryTimer) {
        window.clearInterval(NS.retryTimer);
        NS.retryTimer = null;
      }
      return true;
    }

    post("bridge-status", { found: false, attempts: NS.retryCount });
    return false;
  }

  NS.tryConnect = tryConnect;

  tryConnect();
  NS.retryTimer = window.setInterval(tryConnect, FIND_RETRY_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryConnect();
  });

  document.addEventListener("market-radar-nudge", tryConnect);
})();
