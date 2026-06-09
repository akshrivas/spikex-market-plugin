(() => {
  const NS =
    window.__marketRadarReduxDiff ||
    (window.__marketRadarReduxDiff = {
      booted: false,
      subscribed: false,
      retryTimer: null,
      retryCount: 0,
      prevCatalog: null,
      prevMultiMarket: null,
      lastActionType: "init",
      lastEmitSig: "",
      watcherTimer: null,
      pulseStarted: false
    });

  if (NS.booted) {
    NS.tryConnect?.();
    return;
  }
  NS.booted = true;

  const FIND_RETRY_MS = 500;
  const MAX_CHANGES = 40;

  function post(type, payload = {}) {
    const detail = { source: "market-radar", type, ...payload };
    window.postMessage(detail, "*");
    document.dispatchEvent(new CustomEvent("market-radar-bridge", { detail }));
  }

  post("redux-diff-ready", { at: Date.now() });

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

  function getRootFiber() {
    const candidates = [
      document.getElementById("root"),
      document.querySelector("[data-reactroot]"),
      document.getElementById("app")
    ].filter(Boolean);

    for (const el of candidates) {
      const fiber = fiberFromElement(el);
      if (fiber) return fiber;
    }
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

    const rootFiber = getRootFiber();
    if (rootFiber) {
      const fromRoot = pickCatalogStore(walkFiber(rootFiber));
      if (fromRoot) {
        window.__marketRadarCachedStore = fromRoot;
        return fromRoot;
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

  function summarize(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "string") {
      return value.length > 100 ? `${value.slice(0, 100)}…` : value;
    }
    try {
      const text = JSON.stringify(value);
      return text.length > 140 ? `${text.slice(0, 140)}…` : text;
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  function diffValue(oldVal, newVal, path, changes) {
    if (changes.length >= MAX_CHANGES) return;
    if (Object.is(oldVal, newVal)) return;

    const oldIsObj = oldVal !== null && typeof oldVal === "object";
    const newIsObj = newVal !== null && typeof newVal === "object";

    if (!oldIsObj || !newIsObj) {
      changes.push({
        path,
        oldValue: summarize(oldVal),
        newValue: summarize(newVal)
      });
      return;
    }

    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      if (!Array.isArray(oldVal) || !Array.isArray(newVal)) {
        changes.push({
          path,
          oldValue: summarize(oldVal),
          newValue: summarize(newVal)
        });
        return;
      }

      if (oldVal.length !== newVal.length) {
        changes.push({
          path: `${path}.length`,
          oldValue: summarize(oldVal.length),
          newValue: summarize(newVal.length)
        });
      }

      const limit = Math.min(Math.max(oldVal.length, newVal.length), 12);
      for (let index = 0; index < limit && changes.length < MAX_CHANGES; index += 1) {
        diffValue(oldVal[index], newVal[index], `${path}[${index}]`, changes);
      }
      return;
    }

    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);

    for (const key of keys) {
      if (changes.length >= MAX_CHANGES) break;
      const nextPath = path ? `${path}.${key}` : key;
      diffValue(oldVal[key], newVal[key], nextPath, changes);
    }
  }

  function findEventById(eventsTree, eventId) {
    for (const sportId of Object.keys(eventsTree || {})) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        const event = eventsTree[sportId][competitionId]?.[eventId];
        if (event) return { event, sportId };
      }
    }
    return null;
  }

  function shouldIncludeEvent(event) {
    return String(event?.status || "").toUpperCase() === "IN_PLAY";
  }

  function pickFirstInPlayRunner(store, preferSportId = "4") {
    const eventsTree = store.getState().catalog?.events || {};
    const buckets = [];

    for (const sportId of Object.keys(eventsTree)) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
          const event = eventsTree[sportId][competitionId][eventId];
          if (!shouldIncludeEvent(event)) continue;

          for (const branch of ["matchOddsData", "matchOdds"]) {
            const runner = event[branch]?.runners?.[0];
            if (!runner?.runnerId) continue;

            buckets.push({
              sportId,
              eventId: String(event.eventId || eventId),
              runnerId: String(runner.runnerId),
              runnerName: runner.runnerName || runner.RunnerName,
              matchName: event.eventName || event.customEventName,
              branch
            });
          }
        }
      }
    }

    return (
      buckets.find((item) => item.sportId === preferSportId) ||
      buckets[0] ||
      null
    );
  }

  function sampleAllReduxBranches(store, eventId, runnerId) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const located = findEventById(catalog.events || {}, eventId);
    const branches = {};

    if (located) {
      const event = located.event;
      for (const name of ["matchOdds", "matchOddsData"]) {
        const runner = event[name]?.runners?.find(
          (item) => String(item.runnerId) === String(runnerId)
        );
        branches[`catalog.events.${name}`] = runner?.backPrices?.[0]?.price ?? null;
      }
    }

    for (const [key, market] of Object.entries(catalog.secondaryMatchOddsMap || {})) {
      if (!String(key).startsWith(`${eventId}-`)) continue;
      const runner = market?.runners?.find(
        (item) => String(item.runnerId) === String(runnerId)
      );
      branches[`catalog.secondaryMatchOddsMap.${key}`] =
        runner?.backPrices?.[0]?.price ?? null;
    }

    for (const [key, market] of Object.entries(
      state.multiMarket?.secondaryMultiMatchOddsMap || {}
    )) {
      if (!String(key).startsWith(`${eventId}-`)) continue;
      const runner = market?.runners?.find(
        (item) => String(item.runnerId) === String(runnerId)
      );
      branches[`multiMarket.secondaryMultiMatchOddsMap.${key}`] =
        runner?.backPrices?.[0]?.price ?? null;
    }

    return {
      branches,
      betFairWSConnected: Boolean(catalog.betFairWSConnected),
      dreamWSConnected: Boolean(catalog.dreamWSConnected),
      secondaryMapSize: Object.keys(catalog.secondaryMatchOddsMap || {}).length,
      multiMapSize: Object.keys(state.multiMarket?.secondaryMultiMatchOddsMap || {}).length
    };
  }

  function postStoreHealth(store) {
    const catalog = store.getState().catalog || {};
    post("store-health", {
      betFairWSConnected: Boolean(catalog.betFairWSConnected),
      dreamWSConnected: Boolean(catalog.dreamWSConnected),
      sportsRadarWSConnected: Boolean(catalog.sportsRadarWSConnected),
      secondaryMapSize: Object.keys(catalog.secondaryMatchOddsMap || {}).length,
      multiMapSize: Object.keys(store.getState().multiMarket?.secondaryMultiMatchOddsMap || {})
        .length
    });
  }

  function stopPricePulse() {
    if (NS.watcherTimer) {
      window.clearInterval(NS.watcherTimer);
      NS.watcherTimer = null;
    }
  }

  function startPricePulse(store, options = {}) {
    if (NS.pulseStarted) return;
    NS.pulseStarted = true;
    stopPricePulse();

    const picked = pickFirstInPlayRunner(store, options.preferSportId || "4");
    if (!picked) {
      post("watcher-result", {
        ok: false,
        error: "No IN_PLAY runner found"
      });
      return;
    }

    const { eventId, runnerId } = picked;
    const durationMs = options.durationMs || 30000;
    const intervalMs = options.intervalMs || 2000;
    const maxTicks = Math.floor(durationMs / intervalMs);
    const branchStats = new Map();
    const uniquePrices = new Set();
    let tick = 0;

    function trackBranchPrices(branchSnapshot) {
      for (const [branch, price] of Object.entries(branchSnapshot.branches || {})) {
        if (price == null || price === "") continue;
        if (!branchStats.has(branch)) branchStats.set(branch, new Set());
        branchStats.get(branch).add(Number(price));
        uniquePrices.add(Number(price));
      }
    }

    post("watcher-start", {
      ...picked,
      durationMs,
      intervalMs
    });

    function sample() {
      tick += 1;
      const branchSnapshot = sampleAllReduxBranches(store, eventId, runnerId);
      trackBranchPrices(branchSnapshot);

      const primaryBranch = picked.branch || "matchOddsData";
      const price =
        branchSnapshot.branches[`catalog.events.${primaryBranch}`] ??
        branchSnapshot.branches["catalog.events.matchOddsData"] ??
        null;

      post("watcher-tick", {
        tick,
        timestamp: new Date().toISOString(),
        price,
        branches: branchSnapshot.branches,
        betFairWSConnected: branchSnapshot.betFairWSConnected,
        dreamWSConnected: branchSnapshot.dreamWSConnected,
        secondaryMapSize: branchSnapshot.secondaryMapSize,
        multiMapSize: branchSnapshot.multiMapSize,
        eventId,
        runnerId,
        runnerName: picked.runnerName,
        matchName: picked.matchName
      });

      if (tick >= maxTicks) {
        stopPricePulse();

        const branchSummary = {};
        let liveBranch = null;

        for (const [branch, prices] of branchStats) {
          branchSummary[branch] = {
            uniquePrices: prices.size,
            prices: [...prices]
          };
          if (prices.size > 1 && !liveBranch) liveBranch = branch;
        }

        const anyBranchLive = Object.values(branchSummary).some(
          (item) => item.uniquePrices > 1
        );

        post("watcher-result", {
          ok: true,
          eventId,
          runnerId,
          runnerName: picked.runnerName,
          matchName: picked.matchName,
          uniquePrices: uniquePrices.size,
          prices: [...uniquePrices],
          branchSummary,
          liveBranch,
          betFairWSConnected: branchSnapshot.betFairWSConnected,
          dreamWSConnected: branchSnapshot.dreamWSConnected,
          secondaryMapSize: branchSnapshot.secondaryMapSize,
          multiMapSize: branchSnapshot.multiMapSize,
          verdict: anyBranchLive ? "CASE_A_REDUX_LIVE" : "CASE_B_REDUX_STATIC"
        });
      }
    }

    sample();
    NS.watcherTimer = window.setInterval(sample, intervalMs);
  }

  function collectChanges(store) {
    const state = store.getState();
    const nextCatalog = state.catalog;
    const nextMultiMarket = state.multiMarket;
    const changes = [];

    diffValue(NS.prevCatalog, nextCatalog, "catalog", changes);
    if (changes.length < MAX_CHANGES) {
      diffValue(NS.prevMultiMarket, nextMultiMarket, "multiMarket", changes);
    }

    NS.prevCatalog = nextCatalog;
    NS.prevMultiMarket = nextMultiMarket;

    return changes;
  }

  function emitDiff(store, actionType, source) {
    const changes = collectChanges(store);
    if (!changes.length) return;

    const sig = `${source}|${actionType}|${changes
      .map((change) => `${change.path}:${change.newValue}`)
      .join("|")}`;

    if (sig === NS.lastEmitSig) return;
    NS.lastEmitSig = sig;

    post("redux-diff", {
      at: Date.now(),
      actionType,
      source,
      changes
    });
  }

  function attachStore(store) {
    if (NS.subscribed) return;
    NS.subscribed = true;

    NS.prevCatalog = store.getState().catalog;
    NS.prevMultiMarket = store.getState().multiMarket;

    if (!store.__marketRadarDispatchWrapped) {
      const dispatch = store.dispatch.bind(store);
      store.dispatch = (action) => {
        const actionType =
          typeof action === "string" ? action : action?.type || "unknown_action";

        NS.lastActionType = actionType;
        const result = dispatch(action);
        emitDiff(store, actionType, "dispatch");
        return result;
      };
      store.__marketRadarDispatchWrapped = true;
    }

    store.subscribe(() => {
      emitDiff(store, NS.lastActionType, "subscribe");
    });

    post("store-found", {
      hasCatalog: true,
      hasMultiMarket: Boolean(store.getState().multiMarket)
    });

    postStoreHealth(store);
    startPricePulse(store);
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

    post("bridge-status", {
      found: false,
      attempts: NS.retryCount,
      hasRoot: Boolean(document.getElementById("root"))
    });

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
