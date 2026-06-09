(() => {
  const NS =
    window.__marketRadarBridge ||
    (window.__marketRadarBridge = {
      booted: false,
      subscribed: false,
      retryTimer: null,
      snapshotTimer: null,
      publishQueued: false,
      lastPrices: new Map(),
      publishCount: 0,
      watcherTimer: null
    });

  if (NS.booted) {
    NS.tryConnect?.();
    return;
  }
  NS.booted = true;

  const FIND_RETRY_MS = 250;
  const SNAPSHOT_MS = 500;
  const SPORT_MAP = {
    "1": "Football",
    "2": "Tennis",
    "4": "Cricket",
    "7": "Horse Racing",
    "4339": "Greyhound Racing",
    "7522": "Basketball",
    "7511": "Baseball",
    "99994": "Kabaddi"
  };
  const SIMULATED = [/SRL/i, /simulated\s*reality/i];

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

  function getRootFiber() {
    const root = document.getElementById("root");
    if (!root) return null;

    const key = Object.keys(root).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")
    );
    if (!key) return null;

    const holder = root[key];
    return holder?.current || holder?.stateNode?.current || holder;
  }

  function walkFiber(node, depth = 0) {
    if (!node || depth > 300) return null;

    const fromProps =
      storeFromProps(node.memoizedProps) || storeFromProps(node.pendingProps);
    if (fromProps) return fromProps;

    const fromHooks = storeFromHookState(node.memoizedState);
    if (fromHooks) return fromHooks;

    return walkFiber(node.child, depth + 1) || walkFiber(node.sibling, depth + 1);
  }

  function findStore() {
    if (isReduxStore(window.__marketRadarCachedStore)) {
      return window.__marketRadarCachedStore;
    }

    const store = walkFiber(getRootFiber());
    if (!store?.getState?.()?.catalog) return null;

    window.__marketRadarCachedStore = store;
    return store;
  }

  function getBackPrice(runner) {
    const raw = runner?.backPrices?.[0]?.price;
    if (raw == null || raw === "") return null;
    const price = Number(raw);
    return Number.isFinite(price) && price >= 1.01 ? price : null;
  }

  function shouldIncludeEvent(event) {
    const name = event?.eventName || event?.customEventName || "";
    const status = String(event?.status || "").toUpperCase();
    if (!name || (status !== "IN_PLAY" && event?.forcedInplay !== true)) return false;
    if (event?.virtualEvent === true) return false;
    if (event?.eventSuspended) return false;
    if (event?.enabled === false) return false;
    if (SIMULATED.some((pattern) => pattern.test(name))) return false;
    return true;
  }

  function sportLabel(sportId, eventTypes) {
    const match = eventTypes?.find((item) => String(item.id) === String(sportId));
    return match?.name || SPORT_MAP[String(sportId)] || "Unknown";
  }

  function findEventById(eventsTree, eventId) {
    for (const sportId of Object.keys(eventsTree)) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        const event = eventsTree[sportId][competitionId]?.[eventId];
        if (event) return { event, sportId };
      }
    }
    return null;
  }

  function runnerKey(matchName, runnerName) {
    return `${matchName}|${runnerName}`.toLowerCase();
  }

  function pickLiveMarket(event) {
    const matchOdds = event?.matchOdds;
    const matchOddsData = event?.matchOddsData;

    if (matchOdds?.runners?.length && getBackPrice(matchOdds.runners[0])) {
      return matchOdds;
    }

    if (matchOddsData?.runners?.length && getBackPrice(matchOddsData.runners[0])) {
      return matchOddsData;
    }

    return matchOdds || matchOddsData;
  }

  function addMarketRunners(map, market, context) {
    if (!market?.runners?.length || market.disable || market.suspend) return;

    for (const runner of market.runners) {
      if (String(runner?.status || "").toUpperCase() === "SUSPENDED") continue;

      const backPrice = getBackPrice(runner);
      if (!backPrice) continue;

      const runnerName = runner.runnerName || runner.RunnerName;
      if (!runnerName) continue;

      const key = runnerKey(context.matchName, runnerName);
      map.set(key, {
        key,
        sport: context.sport,
        match: context.matchName,
        runner: runnerName,
        backPrice,
        eventId: context.eventId
      });
    }
  }

  function overlayLiveMarkets(map, markets, eventsTree, eventTypes) {
    for (const mapKey of Object.keys(markets || {})) {
      const dash = mapKey.indexOf("-");
      const eventId = dash >= 0 ? mapKey.slice(0, dash) : mapKey;
      const located = findEventById(eventsTree, eventId);
      if (!located || !shouldIncludeEvent(located.event)) continue;

      const matchName = located.event.eventName || located.event.customEventName;
      const sport = sportLabel(located.sportId, eventTypes);
      addMarketRunners(map, markets[mapKey], {
        sport,
        matchName,
        eventId: String(eventId)
      });
    }
  }

  function extractRunnersFromStore(store) {
    const state = store.getState();
    const catalog = state.catalog || {};
    const eventsTree = catalog.events || {};
    const map = new Map();

    for (const sportId of Object.keys(eventsTree)) {
      const sport = sportLabel(sportId, catalog.eventTypes);

      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
          const event = eventsTree[sportId][competitionId][eventId];
          if (!shouldIncludeEvent(event)) continue;

          const matchName = event.eventName || event.customEventName;
          addMarketRunners(map, pickLiveMarket(event), {
            sport,
            matchName,
            eventId: String(event.eventId || eventId)
          });
        }
      }
    }

    overlayLiveMarkets(
      map,
      catalog.secondaryMatchOddsMap,
      eventsTree,
      catalog.eventTypes
    );

    overlayLiveMarkets(
      map,
      state.multiMarket?.secondaryMultiMatchOddsMap,
      eventsTree,
      catalog.eventTypes
    );

    return {
      runners: [...map.values()],
      liveCount: map.size,
      secondaryMapSize: Object.keys(catalog.secondaryMatchOddsMap || {}).length,
      multiMapSize: Object.keys(state.multiMarket?.secondaryMultiMatchOddsMap || {}).length
    };
  }

  function countStorePriceChanges(runners) {
    let changes = 0;

    for (const runner of runners) {
      const previous = NS.lastPrices.get(runner.key);
      if (previous != null && previous !== runner.backPrice) {
        changes += 1;
      }
      NS.lastPrices.set(runner.key, runner.backPrice);
    }

    return changes;
  }

  function findRunnerInCatalog(store, eventId, runnerId) {
    const catalog = store.getState().catalog || {};
    const located = findEventById(catalog.events || {}, eventId);
    if (!located) return null;

    const event = located.event;
    const branches = [
      { name: "matchOdds", market: event.matchOdds },
      { name: "matchOddsData", market: event.matchOddsData }
    ];

    for (const branch of branches) {
      const runner = branch.market?.runners?.find(
        (item) => String(item.runnerId) === String(runnerId)
      );
      if (runner) {
        return {
          branch: branch.name,
          event,
          runner
        };
      }
    }

    return null;
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

  function pickFirstInPlayRunner(store) {
    const eventsTree = store.getState().catalog?.events || {};

    for (const sportId of Object.keys(eventsTree)) {
      for (const competitionId of Object.keys(eventsTree[sportId] || {})) {
        for (const eventId of Object.keys(eventsTree[sportId][competitionId] || {})) {
          const event = eventsTree[sportId][competitionId][eventId];
          if (!shouldIncludeEvent(event)) continue;

          for (const branch of ["matchOddsData", "matchOdds"]) {
            const runner = event[branch]?.runners?.[0];
            if (!runner?.runnerId) continue;

            return {
              eventId: String(event.eventId || eventId),
              runnerId: String(runner.runnerId),
              runnerName: runner.runnerName || runner.RunnerName,
              matchName: event.eventName || event.customEventName,
              branch
            };
          }
        }
      }
    }

    return null;
  }

  function post(type, payload = {}) {
    const detail = { source: "market-radar", type, ...payload };
    window.postMessage(detail, "*");
    document.dispatchEvent(new CustomEvent("market-radar-bridge", { detail }));
  }

  function stopRunnerWatcher() {
    if (NS.watcherTimer) {
      window.clearInterval(NS.watcherTimer);
      NS.watcherTimer = null;
    }
  }

  function startRunnerWatcher(options = {}) {
    stopRunnerWatcher();

    const store = findStore();
    if (!store) {
      const error = "Redux store not found";
      console.error("[Market Radar Watcher]", error);
      post("watcher-result", { ok: false, error });
      return { ok: false, error };
    }

    let eventId = options.eventId;
    let runnerId = options.runnerId;
    let picked = null;

    if (!eventId || !runnerId) {
      picked = pickFirstInPlayRunner(store);
      if (!picked) {
        const error = "No IN_PLAY runner found in catalog.events";
        console.error("[Market Radar Watcher]", error);
        post("watcher-result", { ok: false, error });
        return { ok: false, error };
      }
      eventId = picked.eventId;
      runnerId = picked.runnerId;
    }

    const durationMs = options.durationMs || 60000;
    const intervalMs = options.intervalMs || 1000;
    const maxTicks = Math.floor(durationMs / intervalMs);
    const scanAllBranches = options.scanAllBranches !== false;
    const uniquePrices = new Set();
    const branchStats = new Map();
    const logs = [];
    let tick = 0;

    function trackBranchPrices(branchSnapshot) {
      for (const [branch, price] of Object.entries(branchSnapshot.branches || {})) {
        if (price == null || price === "") continue;
        if (!branchStats.has(branch)) {
          branchStats.set(branch, new Set());
        }
        branchStats.get(branch).add(Number(price));
      }
    }

    console.log("[Market Radar Watcher] starting", {
      eventId,
      runnerId,
      durationMs,
      intervalMs,
      scanAllBranches,
      autoPicked: picked
    });

    post("watcher-start", {
      eventId,
      runnerId,
      durationMs,
      intervalMs,
      scanAllBranches,
      autoPicked: picked
    });

    function sample() {
      tick += 1;
      const timestamp = new Date().toISOString();
      const branchSnapshot = sampleAllReduxBranches(store, eventId, runnerId);
      trackBranchPrices(branchSnapshot);

      const found = findRunnerInCatalog(store, eventId, runnerId);
      const price = found?.runner?.backPrices?.[0]?.price ?? null;

      if (price != null && price !== "") {
        uniquePrices.add(Number(price));
      }

      const entry = {
        tick,
        timestamp,
        price,
        branch: found?.branch || null,
        branches: branchSnapshot.branches,
        betFairWSConnected: branchSnapshot.betFairWSConnected,
        secondaryMapSize: branchSnapshot.secondaryMapSize,
        multiMapSize: branchSnapshot.multiMapSize,
        eventId,
        runnerId,
        runnerName: found?.runner?.runnerName || found?.runner?.RunnerName || null,
        matchName: found?.event?.eventName || found?.event?.customEventName || null
      };

      logs.push(entry);
      console.log("[Market Radar Watcher]", entry);
      post("watcher-tick", entry);

      if (tick >= maxTicks) {
        stopRunnerWatcher();

        const branchSummary = {};
        let liveBranch = null;

        for (const [branch, prices] of branchStats) {
          branchSummary[branch] = {
            uniquePrices: prices.size,
            prices: [...prices]
          };
          if (prices.size > 1 && !liveBranch) {
            liveBranch = branch;
          }
        }

        const anyBranchLive = Object.values(branchSummary).some(
          (item) => item.uniquePrices > 1
        );

        const result = {
          ok: true,
          eventId,
          runnerId,
          uniquePrices: uniquePrices.size,
          prices: [...uniquePrices],
          branchSummary,
          liveBranch,
          betFairWSConnected: branchSnapshot.betFairWSConnected,
          dreamWSConnected: branchSnapshot.dreamWSConnected,
          secondaryMapSize: branchSnapshot.secondaryMapSize,
          multiMapSize: branchSnapshot.multiMapSize,
          logs,
          verdict: anyBranchLive
            ? "CASE_A_REDUX_LIVE"
            : "CASE_B_REDUX_STATIC"
        };

        console.log("[Market Radar Watcher] RESULT", result);
        post("watcher-result", result);
      }
    }

    sample();
    NS.watcherTimer = window.setInterval(sample, intervalMs);

    return {
      ok: true,
      eventId,
      runnerId,
      message: `Watcher running for ${durationMs / 1000}s`
    };
  }

  NS.startRunnerWatcher = startRunnerWatcher;
  NS.stopRunnerWatcher = stopRunnerWatcher;

  function publishFromStore() {
    const store = findStore();
    if (!store) return false;

    const catalog = store.getState().catalog;
    if (!catalog) return false;

    const extracted = extractRunnersFromStore(store);
    const storePriceChanges = countStorePriceChanges(extracted.runners);
    NS.publishCount += 1;

    post("runners-snapshot", {
      runners: extracted.runners,
      meta: {
        runnerCount: extracted.liveCount,
        secondaryMapSize: extracted.secondaryMapSize,
        multiMapSize: extracted.multiMapSize,
        storePriceChanges,
        publishCount: NS.publishCount,
        source: "redux-store"
      }
    });

    post("catalog-snapshot", {
      catalog: {
        events: catalog.events,
        secondaryMatchOddsMap: catalog.secondaryMatchOddsMap,
        eventTypes: catalog.eventTypes
      }
    });

    return true;
  }

  function schedulePublish() {
    if (NS.publishQueued) return;
    NS.publishQueued = true;
    requestAnimationFrame(() => {
      NS.publishQueued = false;
      publishFromStore();
    });
  }

  function attachStore(store) {
    if (NS.subscribed) return;
    NS.subscribed = true;

    const dispatch = store.dispatch.bind(store);
    store.dispatch = (action) => {
      const result = dispatch(action);
      schedulePublish();
      return result;
    };

    store.subscribe(schedulePublish);
    publishFromStore();

    post("store-found", {
      hasCatalog: true,
      sportCount: Object.keys(store.getState()?.catalog?.events || {}).length
    });

    NS.snapshotTimer = window.setInterval(publishFromStore, SNAPSHOT_MS);
  }

  function tryConnect() {
    const store = findStore();
    if (store) {
      attachStore(store);
      if (NS.retryTimer) {
        window.clearInterval(NS.retryTimer);
        NS.retryTimer = null;
      }
      return true;
    }

    post("bridge-status", { found: false });
    return false;
  }

  NS.tryConnect = tryConnect;

  tryConnect();
  NS.retryTimer = window.setInterval(tryConnect, FIND_RETRY_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryConnect();
  });

  document.addEventListener("market-radar-nudge", tryConnect);

  document.addEventListener("market-radar-start-watcher", (event) => {
    startRunnerWatcher(event.detail || {});
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "market-radar") return;

    if (event.data.type === "export-store-request") {
      const store = findStore();
      if (!store) {
        post("store-export", { ok: false, error: "Redux store not found" });
        return;
      }

      const catalog = store.getState().catalog;
      const extracted = extractRunnersFromStore(store);

      post("store-export", {
        ok: true,
        exportedAt: new Date().toISOString(),
        url: location.href,
        catalog,
        runners: extracted.runners,
        meta: {
          runnerCount: extracted.liveCount,
          secondaryMapSize: extracted.secondaryMapSize,
          source: "redux-store"
        }
      });
      return;
    }

    if (event.data.type === "start-runner-watcher") {
      startRunnerWatcher(event.data);
    }
  });

  document.addEventListener("market-radar-export", () => {
    window.postMessage(
      { source: "market-radar", type: "export-store-request" },
      "*"
    );
  });
})();
