(() => {
  if (globalThis.__spikexOddsDetect) return;

  const PRIMARY_MARKET_RES = [
    /^match\s*odds$/i,
    /winner\s*\(?\s*incl\.?\s*super\s*over/i,
    /^winner$/i,
    /who will win/i,
    /win the match/i
  ];

  function bodyTextSlice(max = 20000) {
    return (document.body?.innerText || "").slice(0, max);
  }

  function hasBackLayTable(bodyText) {
    const head = (bodyText || bodyTextSlice()).slice(0, 12000);
    if (!/\bback\b/i.test(head) || !/\blay\b/i.test(head)) return false;
    return /\d+(?:\.\d{1,2})?/.test(head);
  }

  function hasOddsMarketOnPage(bodyText) {
    const body = bodyText || bodyTextSlice();
    if (/MATCH\s*ODDS/i.test(body)) return true;
    if (/winner\s*(?:\(?\s*incl\.?\s*super\s*over\s*\)?)?/i.test(body)) return true;
    if (/who will win/i.test(body)) return true;
    if (hasBackLayTable(body)) return true;
    return false;
  }

  function hasMatchNameOnPage(bodyText) {
    const body = bodyText || bodyTextSlice(8000);
    return /\b[\w.'-]{2,50}\s+v(?:s)?\.?\s+[\w.'-]{2,50}\b/i.test(body);
  }

  function isOddsDetailPage(catalog) {
    if (catalog?.selectedEvent?.id) return true;

    const bodyText = bodyTextSlice();
    if (hasOddsMarketOnPage(bodyText)) return true;

    const path = location.pathname || "";
    if (/\/exchange_sports\//i.test(path) && !/\/inplay\/?$/i.test(path)) return true;
    if (/\/(cricket|football|tennis|soccer|exchange|sports)\b/i.test(path)) return true;
    if (/[?&](event[Ii]d|eventId|marketId)=\d+/i.test(location.search)) return true;
    if (/\/(event|match|game|market)\/\d+/i.test(path)) return true;

    if (hasMatchNameOnPage(bodyText) && /\d+\.\d{2}/.test(bodyText.slice(0, 15000))) return true;
    if (hasMatchNameOnPage(bodyText) && hasBackLayTable(bodyText)) return true;

    if (/\d{1,3}[':]\d{2}/.test(bodyText.slice(0, 5000)) && hasOddsMarketOnPage(bodyText)) {
      return true;
    }

    return false;
  }

  function isSecondaryMarketRunner(name) {
    return /^(over|under)\b/i.test(String(name || "").trim()) || /\b(over|under)\s+\d/i.test(name || "");
  }

  function extractPricesFromRow(row) {
    const oddsRe = /^\d+(?:\.\d{1,2})?$/;
    return [...row.querySelectorAll("button, span, td, div, a")]
      .map((el) => (el.textContent || "").trim())
      .filter((text) => oddsRe.test(text))
      .map(Number)
      .filter((n) => n >= 1.01 && n <= 1000);
  }

  function extractRunnerNameFromRow(row) {
    const skipNames =
      /^(back|lay|matched|susp|lock|min|max|loss cut|the draw|draw|—|-|\d+\.?\d*)$/i;

    let name = (
      row.querySelector(
        "td:first-child, th:first-child, [class*='runner-name'], [class*='RunnerName'], [class*='runner'], [class*='Runner'], [class*='team'], [class*='Team']"
      )?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();

    if (!name || skipNames.test(name) || name.length > 55) {
      const text = (row.textContent || "").replace(/\s+/g, " ").trim();
      name = text.replace(/\d+(?:\.\d+)?/g, " ").replace(/\s+/g, " ").trim().split(/\s{2,}/)[0] || "";
    }

    if (!name || skipNames.test(name) || name.length > 55 || isSecondaryMarketRunner(name)) return "";
    return name;
  }

  function scrapeRowsInRoot(root, seen) {
    const runners = [];

    for (const row of root.querySelectorAll(
      "tr, [role='row'], [class*='runner-row'], [class*='RunnerRow'], li"
    )) {
      if (row.closest("#market-radar-panel")) continue;
      const prices = extractPricesFromRow(row);
      if (!prices.length) continue;

      const name = extractRunnerNameFromRow(row);
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const back = prices[0];
      const lay = prices.length > 1 ? prices[prices.length - 1] : null;
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

    return runners;
  }

  function findPrimaryMarketRoots(root) {
    const roots = new Set();
    const marketLabel =
      /match\s*odds|winner\s*(?:\(?\s*incl|super\s*over)?|who will win|win the match/i;

    for (const el of root.querySelectorAll(
      "h1,h2,h3,h4,h5,span,div,button,summary,label,td,th"
    )) {
      const label = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!label || label.length > 90 || !marketLabel.test(label)) continue;
      const container =
        el.closest("table, tbody, section, [class*='market'], [class*='Market'], [class*='odds']") ||
        el.parentElement?.parentElement;
      if (container) roots.add(container);
    }

    return [...roots];
  }

  function scoreRunnerSet(runners) {
    if (!runners?.length) return -1;
    let score = runners.length === 2 ? 40 : runners.length === 3 ? 35 : 10;
    for (const runner of runners) {
      if (isSecondaryMarketRunner(runner.runnerName)) score -= 20;
    }
    return score;
  }

  function appScrapeRoot() {
    return document.getElementById("root") || document.querySelector("main") || document.body;
  }

  function makeRunner(name, back, lay) {
    return {
      runnerId: name.toLowerCase().replace(/\s+/g, "-"),
      runnerName: name,
      back,
      lay,
      backText: back != null ? back.toFixed(2) : "—",
      layText: lay != null ? lay.toFixed(2) : "—",
      suspended: false,
      runnerStatus: null
    };
  }

  function scrapeRunnersFromText(root = appScrapeRoot()) {
    const text = (root?.innerText || "").replace(/\r/g, "");
    const marketRe =
      /winner\s*(?:\([^)]*super[^)]*\))?|match\s*odds|who will win|win the match/i;
    const idx = text.search(marketRe);
    if (idx < 0) return [];

    const chunk = text.slice(idx, idx + 3000);
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const skipLine =
      /^(back|lay|matched|cash out|min|max|lock|susp|—|-|\d+\/\d+|bets placed|profit|loss cut|rules|refresh|betslip|stake|cancel|clear|login|deposit)/i;
    const oddsLine = /^(\d+\.\d{1,2})$/;
    const runners = [];
    const seen = new Set();

    for (let i = 0; i < lines.length && runners.length < 4; i += 1) {
      const line = lines[i];
      if (skipLine.test(line) || marketRe.test(line)) continue;
      if (oddsLine.test(line) || line.length < 2 || line.length > 45) continue;
      if (isSecondaryMarketRunner(line)) continue;

      const next1 = lines[i + 1];
      const next2 = lines[i + 2];
      if (next1 && oddsLine.test(next1) && next2 && oddsLine.test(next2)) {
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        runners.push(makeRunner(line, parseFloat(next1), parseFloat(next2)));
        i += 2;
      } else if (next1 && oddsLine.test(next1)) {
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        runners.push(makeRunner(line, parseFloat(next1), null));
        i += 1;
      }
    }

    return runners;
  }

  function scrapeRunnersFromButtons(root = appScrapeRoot()) {
    const oddsRe = /^\d+\.\d{1,2}$/;
    const skipNames =
      /^(back|lay|matched|susp|lock|min|max|loss cut|the draw|draw|—|-|\d+\.?\d*)$/i;
    const runners = [];
    const seen = new Set();

    for (const block of root.querySelectorAll(
      "tr, [role='row'], li, div[class*='runner'], div[class*='Runner'], div[class*='team'], div[class*='Team'], div[class*='market'], div[class*='Market']"
    )) {
      if (block.closest("#market-radar-panel")) continue;

      const prices = [...block.querySelectorAll("button, span, td, a")]
        .map((el) => (el.textContent || "").trim())
        .filter((text) => oddsRe.test(text))
        .map(Number)
        .filter((n) => n >= 1.01 && n <= 1000);
      if (!prices.length) continue;

      let name = (
        block.querySelector(
          "[class*='runner-name'], [class*='RunnerName'], [class*='team-name'], [class*='TeamName'], td:first-child, th:first-child"
        )?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      if (!name || skipNames.test(name) || name.length > 55) {
        const text = (block.textContent || "").replace(/\s+/g, " ").trim();
        name = text.replace(/\d+(?:\.\d+)?/g, " ").replace(/\s+/g, " ").trim().split(/\s{2,}/)[0] || "";
      }

      if (!name || skipNames.test(name) || name.length > 55 || isSecondaryMarketRunner(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      runners.push(makeRunner(name, prices[0], prices.length > 1 ? prices[prices.length - 1] : null));
    }

    return runners;
  }

  function scrapeRunnersFromDom(root = appScrapeRoot()) {
    if (root?.closest?.("#market-radar-panel")) return [];

    const seen = new Set();
    const scoped = findPrimaryMarketRoots(root);
    const candidateSets = [];

    if (scoped.length) {
      for (const scope of scoped) {
        const rows = scrapeRowsInRoot(scope, new Set());
        if (rows.length) candidateSets.push(rows);
      }
    }

    const globalRows = scrapeRowsInRoot(root, seen);
    if (globalRows.length) candidateSets.push(globalRows);

    const buttonRows = scrapeRunnersFromButtons(root);
    if (buttonRows.length) candidateSets.push(buttonRows);

    const textRows = scrapeRunnersFromText(root);
    if (textRows.length) candidateSets.push(textRows);

    let best = [];
    let bestScore = -1;
    for (const set of candidateSets) {
      const score = scoreRunnerSet(set);
      if (score > bestScore) {
        bestScore = score;
        best = set;
      }
    }

    return best.sort((a, b) => a.runnerName.localeCompare(b.runnerName));
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

  function runnerHasPrice(runner) {
    if (!runner) return false;
    const back = runner.backPrices?.[0]?.price;
    const lay = runner.layPrices?.[0]?.price;
    return (
      (back != null && back !== "" && Number.isFinite(Number(back))) ||
      (lay != null && lay !== "" && Number.isFinite(Number(lay)))
    );
  }

  function marketHasRunners(market) {
    return Array.isArray(market?.runners) && market.runners.some(runnerHasPrice);
  }

  function isMarketOpen(market) {
    if (!market || market.suspend || market.disable || market.suspended || market.disabled) {
      return false;
    }
    const status = String(market.status || "").toUpperCase();
    return !status || status === "OPEN" || status === "ACTIVE";
  }

  function scorePrimaryMarket(market) {
    if (!marketHasRunners(market)) return -1;

    const name = String(market.marketName || market.marketType || "").trim();
    let score = 0;

    for (let i = 0; i < PRIMARY_MARKET_RES.length; i += 1) {
      if (PRIMARY_MARKET_RES[i].test(name)) {
        score += 100 - i * 5;
        break;
      }
    }

    if (/winner/i.test(name)) score += 40;
    if (/match/i.test(name)) score += 35;
    if (isMarketOpen(market)) score += 25;

    const priced = (market.runners || []).filter(runnerHasPrice).length;
    score += Math.min(priced, 3) * 4;

    if (priced === 2) score += 6;
    if (priced === 3) score += 4;

    return score;
  }

  function pickBestMarketEntry(entries) {
    let best = null;
    let bestScore = -1;

    for (const entry of entries || []) {
      const score = scorePrimaryMarket(entry.market);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    return best;
  }

  function collectMarketCandidates(event, catalog, multiMarket, options = {}) {
    const eventId = normalizeEventId(event?.eventId || "");
    const onDetail = options.onDetail ?? false;
    const wsOn = Boolean(catalog?.betFairWSConnected);
    const candidates = [];
    const seenMarket = new Set();

    function push(market, source) {
      if (!market || typeof market !== "object") return;
      const key = String(market.marketId || `${source}:${market.marketName || ""}`);
      if (seenMarket.has(key)) return;
      seenMarket.add(key);
      candidates.push({ market, source });
    }

    if (onDetail && event?.matchOdds) push(event.matchOdds, "matchOdds");

    for (const id of eventIdVariants(eventId)) {
      for (const [key, market] of Object.entries(catalog?.secondaryMatchOddsMap || {})) {
        if (String(key).startsWith(`${id}-`)) push(market, "secondary");
      }
    }

    for (const id of eventIdVariants(eventId)) {
      for (const [key, market] of Object.entries(multiMarket?.secondaryMultiMatchOddsMap || {})) {
        if (String(key).startsWith(`${id}-`)) push(market, "multi");
      }
    }

    if ((wsOn || onDetail) && event?.matchOdds) push(event.matchOdds, "matchOdds");
    if (event?.matchOddsData) push(event.matchOddsData, "matchOddsData");
    if (event?.matchOdds) push(event.matchOdds, "matchOdds");

    for (const market of event?.raceMarkets || []) {
      push(market, "raceMarkets");
    }

    return candidates;
  }

  function pickLiveMarket(event, catalog, multiMarket, options = {}) {
    const best = pickBestMarketEntry(collectMarketCandidates(event, catalog, multiMarket, options));
    if (best) return best;
    return { market: null, source: "none" };
  }

  function slugFromPagePath() {
    const parts = (location.pathname || "").split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part && !/^\d+$/.test(part) && part.includes("-")) return part.toLowerCase();
    }
    return "";
  }

  function eventIdsFromPageUrl() {
    const ids = new Set();
    const params = new URLSearchParams(location.search || "");
    for (const key of ["eventId", "eventid", "marketId", "eventIId"]) {
      const value = params.get(key);
      if (value && /\d{5,}/.test(value)) ids.add(normalizeEventId(value));
    }

    const pathMatches = location.pathname.match(/\/(\d{7,})(?:[/?#]|$)/g) || [];
    for (const chunk of pathMatches) {
      const match = chunk.match(/(\d{7,})/);
      if (match) ids.add(normalizeEventId(match[1]));
    }

    return [...ids];
  }

  function parseMoneyAmount(text) {
    const raw = String(text || "")
      .trim()
      .replace(/[₹$€£,\s]/g, "");
    const m = raw.match(/^(-?\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0 || n > 50_000_000) return null;
    return n;
  }

  function elementDirectText(el) {
    return [...(el?.childNodes || [])]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join("")
      .trim();
  }

  function isInsideOddsRow(el) {
    const row = el.closest("tr, [role='row'], table, tbody, [class*='runner' i], [class*='market' i]");
    if (!row) return false;
    const ctx = (row.textContent || "").slice(0, 320);
    return /\b(back|lay|matched)\b/i.test(ctx);
  }

  function forEachDomRoot(callback) {
    const queue = [document];
    const seen = new Set();
    while (queue.length) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      callback(root);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) queue.push(el.shadowRoot);
      }
    }
  }

  function scrapeAmountFromElement(el) {
    if (!el || isInsideOddsRow(el)) return null;
    const texts = [elementDirectText(el), (el.textContent || "").trim()];
    for (const t of texts) {
      if (!t || t.length > 24) continue;
      const n = parseMoneyAmount(t);
      if (n != null) return n;
    }
    for (const child of el.querySelectorAll("span, div, p, strong, b, a, label")) {
      const t = (child.textContent || "").trim();
      if (!t || t.length > 24 || isInsideOddsRow(child)) continue;
      const n = parseMoneyAmount(t);
      if (n != null) return n;
    }
    return null;
  }

  function scrapeBalanceFromStorage() {
    const storages = [localStorage, sessionStorage];
    const keyRe = /balance|wallet|available|credit|fund|user/i;
    for (const storage of storages) {
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          if (!key || !keyRe.test(key)) continue;
          const raw = storage.getItem(key);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === "number" && parsed >= 0) return parsed;
            if (parsed && typeof parsed === "object") {
              for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === "number" && /balance|wallet|available|credit|fund/i.test(k)) {
                  return v;
                }
              }
            }
          } catch {
            const n = parseMoneyAmount(raw);
            if (n != null) return n;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function scrapeBalanceFromRedux() {
    const store = globalThis.__marketRadarCachedStore;
    if (!store?.getState) return null;

    const found = { balance: null, username: null };
    const seen = new Set();
    const balanceKeys =
      /balance|wallet|available|credit|fund|chip|point|exposure|avl|mainbal/i;
    const userKeys = /username|user_?name|login_?name|display_?name|account_?name|user_?id/i;

    function walk(obj, depth) {
      if (!obj || depth > 10 || typeof obj !== "object") return;
      if (seen.has(obj)) return;
      seen.add(obj);

      for (const [key, value] of Object.entries(obj)) {
        const k = key.toLowerCase();
        if (typeof value === "number" && balanceKeys.test(k) && value >= 0 && value < 1e9) {
          if (/balance|wallet|available|credit|fund|chip|point|avl|mainbal/i.test(k)) {
            found.balance = value;
          }
        }
        if (typeof value === "string" && userKeys.test(k)) {
          const t = value.trim();
          if (t.length >= 3 && t.length <= 40 && !/^\d+\.\d+$/.test(t)) {
            found.username = t;
          }
        }
        if (value && typeof value === "object") walk(value, depth + 1);
      }
    }

    try {
      walk(store.getState(), 0);
    } catch {
      /* ignore */
    }
    return found.balance != null ? found : null;
  }

  function scrapeBalanceFromHeaderLines() {
    const roots = [
      document.querySelector("header"),
      ...document.querySelectorAll("[class*='header' i], [class*='topbar' i], [class*='navbar' i], nav")
    ].filter(Boolean);

    for (const root of roots) {
      const lines = (root.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 50);

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const n = parseMoneyAmount(line);
        if (n == null || n < 1) continue;
        if (n >= 1.01 && n <= 1.99) continue;

        const prev = lines[i - 1] || "";
        const next = lines[i + 1] || "";
        if (/^(back|lay|matched|min|max)$/i.test(prev)) continue;
        if (/balance|available|wallet|credit|fund/i.test(prev) || /deposit|withdraw/i.test(next)) {
          return n;
        }
        if (/^[a-zA-Z0-9_.-]{4,28}$/.test(prev) && !/^(login|sign|deposit|withdraw|cricway)$/i.test(prev)) {
          return n;
        }
      }
    }
    return null;
  }

  function scrapeBalanceFromViewport() {
    const vw = window.innerWidth;
    const candidates = [];

    forEachDomRoot((root) => {
      for (const el of root.querySelectorAll("span, div, p, strong, a, button, label, h1, h2, h3, h4")) {
        if (el.closest("#market-radar-panel") || isInsideOddsRow(el)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0) continue;

        const inTopBand = rect.top < Math.max(280, window.innerHeight * 0.22);
        const inTopRight = rect.left > vw * 0.5 && rect.top < 360;
        if (!inTopBand && !inTopRight) continue;

        for (const t of [elementDirectText(el), (el.textContent || "").trim()]) {
          if (!t || t.length > 24) continue;
          const n = parseMoneyAmount(t);
          if (n == null || n < 0) continue;
          if (n >= 1.01 && n <= 1.99) continue;
          candidates.push({
            n,
            right: rect.right,
            top: rect.top,
            score: (inTopRight ? 3 : 1) + (n >= 50 ? 2 : 0) + rect.right / vw
          });
        }
      }
    });

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.right - a.right);
    return candidates[0].n;
  }

  function scrapeUsername() {
    for (const sel of [
      "[class*='username' i]",
      "[class*='user-name' i]",
      "[class*='account-name' i]",
      "[class*='profile-name' i]",
      "[class*='user_name' i]"
    ]) {
      const el = document.querySelector(sel);
      const t = (el?.textContent || "").trim();
      if (t && t.length >= 3 && t.length <= 32 && !/^\d+\.\d+$/.test(t) && !/^(login|sign|deposit|withdraw)$/i.test(t)) {
        return t;
      }
    }

    const head = bodyTextSlice(3000).split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of head.slice(0, 30)) {
      if (/^[a-zA-Z0-9_.-]{5,28}$/.test(line) && /\d/.test(line) && /[a-zA-Z]/.test(line)) {
        if (!/^(cricway|deposit|withdraw|login)$/i.test(line)) return line;
      }
    }
    return null;
  }

  function scrapeCricwayAccount() {
    const at = Date.now();
    let balance = null;
    let username = null;
    let source = null;

    const reduxHit = scrapeBalanceFromRedux();
    if (reduxHit?.balance != null) {
      balance = reduxHit.balance;
      username = reduxHit.username || null;
      source = "redux";
    }

    if (balance == null) {
      const stored = scrapeBalanceFromStorage();
      if (stored != null) {
        balance = stored;
        source = "storage";
      }
    }

    const classSelectors = [
      "[class*='balance' i]",
      "[class*='wallet' i]",
      "[class*='available' i]",
      "[class*='user-balance' i]",
      "[class*='account-balance' i]",
      "[class*='header-balance' i]",
      "[class*='avail' i]"
    ];
    if (balance == null) {
      for (const sel of classSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const n = scrapeAmountFromElement(el);
          if (n != null) {
            balance = n;
            source = "class";
            break;
          }
        }
        if (balance != null) break;
      }
    }

    if (balance == null) {
      const fromLines = scrapeBalanceFromHeaderLines();
      if (fromLines != null) {
        balance = fromLines;
        source = "header";
      }
    }

    if (balance == null) {
      const head = bodyTextSlice(6000);
      for (const re of [
        /(?:balance|available|wallet|credit|fund)[:\s]*([₹$]?\s*[\d,]+(?:\.\d{1,2})?)/i,
        /([₹$]?\s*[\d,]+(?:\.\d{1,2})?)\s*(?:balance|available)/i
      ]) {
        const m = head.match(re);
        if (m) {
          const n = parseMoneyAmount(m[1]);
          if (n != null) {
            balance = n;
            source = "text";
            break;
          }
        }
      }
    }

    if (balance == null) {
      const fromViewport = scrapeBalanceFromViewport();
      if (fromViewport != null) {
        balance = fromViewport;
        source = "viewport";
      }
    }

    username = username || scrapeUsername();

    return {
      balance,
      username,
      source,
      at,
      ok: balance != null
    };
  }

  globalThis.__spikexOddsDetect = {
    bodyTextSlice,
    hasOddsMarketOnPage,
    hasBackLayTable,
    hasMatchNameOnPage,
    isOddsDetailPage,
    marketHasRunners,
    runnerHasPrice,
    scorePrimaryMarket,
    collectMarketCandidates,
    pickLiveMarket,
    slugFromPagePath,
    eventIdsFromPageUrl,
    appScrapeRoot,
    scrapeRunnersFromDom,
    scrapeCricwayAccount
  };
})();
