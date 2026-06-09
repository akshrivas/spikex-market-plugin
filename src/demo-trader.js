(() => {
  if (window.__spikexDemoTrader) return;

  const STORAGE_KEY = "marketRadar.demoTrades";
  const DEFAULT_STAKE = 100;
  const MAX_OPEN_TRADES = 1;

  const ledger = {
    openTrades: [],
    closedTrades: [],
    seq: 0,
    lastError: null,
    lastAction: null,
    stake: DEFAULT_STAKE
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function genTradeId() {
    ledger.seq += 1;
    return `dt-${Date.now()}-${ledger.seq}`;
  }

  function calcTradePnl(side, entryOdds, exitOdds, stake) {
    if (side === "BACK") return stake * (entryOdds / exitOdds - 1);
    return stake * (exitOdds / entryOdds - 1);
  }

  function isPanelNode(el) {
    return Boolean(el?.closest?.("#market-radar-panel"));
  }

  function findRunnerRow(runnerName) {
    const target = normalizeName(runnerName);
    if (!target) return null;

    const rows = document.querySelectorAll(
      "tr, [role='row'], li, div[class*='runner' i], div[class*='Runner' i], div[class*='team' i]"
    );

    let best = null;
    let bestScore = 0;

    for (const row of rows) {
      if (isPanelNode(row)) continue;

      const labelEl = row.querySelector(
        "td:first-child, th:first-child, [class*='runner-name' i], [class*='RunnerName' i], [class*='team-name' i], [class*='TeamName' i]"
      );
      const label = normalizeName(labelEl?.textContent || "");
      if (!label) continue;

      let score = 0;
      if (label === target) score = 100;
      else if (label.includes(target) || target.includes(label)) score = 70;
      else continue;

      const prices = collectPriceButtons(row);
      if (!prices.length) continue;
      score += prices.length;

      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }

    return best;
  }

  function collectPriceButtons(row) {
    const oddsRe = /^\d+\.\d{1,2}$/;
    const hits = [];

    for (const el of row.querySelectorAll("button, a, span, td, div")) {
      if (isPanelNode(el)) continue;
      const text = (el.textContent || "").trim();
      if (!oddsRe.test(text)) continue;
      const price = Number(text);
      if (!Number.isFinite(price) || price < 1.01) continue;
      const clickable = el.closest("button, a") || el;
      hits.push({ el: clickable, price, text });
    }

    return hits;
  }

  function clickRunnerSide(row, side) {
    const buttons = collectPriceButtons(row);
    if (!buttons.length) return { ok: false, error: "No odds buttons found for runner" };

    const pick = side === "LAY" && buttons.length > 1 ? buttons[buttons.length - 1] : buttons[0];
    try {
      pick.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      pick.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      pick.el.click();
      return { ok: true, price: pick.price };
    } catch (error) {
      return { ok: false, error: error?.message || "Click failed" };
    }
  }

  function isVisible(el) {
    if (!el || isPanelNode(el)) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  }

  function getNativeInputSetter() {
    return (
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
    );
  }

  function walkShadowRoots(root, visit) {
    if (!root) return;
    visit(root);
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const node of nodes) {
      if (node.shadowRoot) walkShadowRoots(node.shadowRoot, visit);
    }
  }

  function collectElements(root, selector, results = []) {
    if (!root) return results;
    walkShadowRoots(root, (scope) => {
      try {
        scope.querySelectorAll(selector).forEach((el) => {
          if (isVisible(el)) results.push(el);
        });
      } catch {
        /* ignore bad selectors in shadow trees */
      }
    });
    return results;
  }

  function findBetslipRoot() {
    const selectors = [
      '[class*="betslip" i]',
      '[class*="bet-slip" i]',
      '[class*="BetSlip" i]',
      '[class*="bet_slip" i]',
      '[id*="betslip" i]',
      '[class*="betSlip" i]',
      '[class*="right-panel" i]',
      '[class*="RightPanel" i]',
      '[class*="slip-panel" i]',
      '[class*="SlipPanel" i]',
      'aside[class*="bet" i]',
      '[data-testid*="betslip" i]',
      '[data-testid*="bet-slip" i]'
    ];

    for (const sel of selectors) {
      for (const el of collectElements(document, sel)) {
        if (/place\s*bet|stake|potential|liability/i.test(el.textContent || "")) return el;
        return el;
      }
    }

    const submit = findSubmitButton(document);
    if (submit) {
      let node = submit.parentElement;
      for (let i = 0; i < 10 && node; i += 1, node = node.parentElement) {
        if (/betslip|bet slip|stake|place bet/i.test(node.textContent || "")) return node;
      }
    }

    return null;
  }

  function scoreStakeCandidate(el) {
    let score = 0;
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.type || "").toLowerCase();
    const attrs = [
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("class"),
      el.getAttribute("data-testid")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (attrs.includes("stake")) score += 60;
    if (attrs.includes("amount") || attrs.includes("wager") || attrs.includes("liability")) score += 45;
    if (type === "number" || type === "tel") score += 35;
    if (el.getAttribute("inputmode") === "decimal" || el.getAttribute("inputmode") === "numeric") {
      score += 30;
    }
    if (tag === "input") score += 20;
    if (tag === "textarea") score += 10;
    if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "spinbutton") {
      score += 25;
    }
    if (el.closest('[class*="betslip" i], [class*="bet-slip" i], [class*="BetSlip" i]')) score += 40;
    if (el.closest('[class*="slip" i]')) score += 15;

    const localRoot = el.closest("div, section, aside, form, article") || el.parentElement;
    if (localRoot && /place\s*bet|potential|liability|profit|loss/i.test(localRoot.textContent || "")) {
      score += 20;
    }

    if (attrs.includes("search") || attrs.includes("email") || attrs.includes("password")) score -= 120;
    if (el.closest('[class*="login" i], [class*="search" i], #market-radar-panel')) score -= 120;
    if (el.readOnly || el.disabled) score -= 80;

    return score;
  }

  function findStakeInputs(scope = document) {
    const selectors = [
      'input[type="number"]',
      'input[type="tel"]',
      'input[type="text"]',
      'input[inputmode="decimal"]',
      'input[inputmode="numeric"]',
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"])',
      '[contenteditable="true"]',
      '[role="spinbutton"]'
    ];

    const ranked = new Map();
    for (const sel of selectors) {
      for (const el of collectElements(scope, sel)) {
        const score = scoreStakeCandidate(el);
        if (score <= 0) continue;
        ranked.set(el, Math.max(ranked.get(el) || 0, score));
      }
    }

    return [...ranked.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([el]) => el);
  }

  function findSubmitButton(scope = document) {
    const patterns = [/place\s*bets?/i, /submit/i, /confirm/i, /place\s*order/i];
    let best = null;
    let bestScore = 0;

    for (const btn of collectElements(scope, "button, [role='button'], a, div, span")) {
      const text = (btn.textContent || "").trim();
      if (!text || text.length > 40) continue;
      if (!patterns.some((p) => p.test(text))) continue;

      let score = 10;
      if (/place\s*bet/i.test(text)) score += 20;
      if (btn.closest('[class*="betslip" i], [class*="bet-slip" i], [class*="BetSlip" i]')) score += 15;
      if (score > bestScore) {
        bestScore = score;
        best = btn;
      }
    }

    return best;
  }

  function findStakeNearSubmitButton(scope = document) {
    const btn = findSubmitButton(scope);
    if (!btn) return null;

    let node = btn.parentElement;
    for (let i = 0; i < 10 && node; i += 1, node = node.parentElement) {
      const inputs = findStakeInputs(node);
      if (inputs.length) return inputs[0];
    }
    return null;
  }

  function syncReactInput(input, value) {
    const tracker = input._valueTracker;
    if (tracker) tracker.setValue(String(input.value ?? ""));
    const setter = getNativeInputSetter();
    if (setter) setter.call(input, value);
    else input.value = value;
  }

  function fillStakeElement(el, amount) {
    const str = String(amount);
    if (!el) return false;

    try {
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } catch {
      /* ignore */
    }

    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") {
      el.focus({ preventScroll: true });
      el.click?.();
      syncReactInput(el, str);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: str,
          inputType: "insertFromPaste"
        })
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));

      if (String(el.value ?? "").replace(/[^\d.]/g, "") === str) return true;

      el.focus({ preventScroll: true });
      el.select?.();
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, str);
      } catch {
        /* ignore */
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: str }));
      return String(el.value ?? "").replace(/[^\d.]/g, "") === str || String(el.value ?? "").includes(str);
    }

    if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "spinbutton") {
      el.focus({ preventScroll: true });
      el.textContent = str;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: str }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return (el.textContent || "").includes(str);
    }

    return false;
  }

  function fillStakeInput(amount, root = document) {
    const scopes = [root, findBetslipRoot(), document].filter(Boolean);
    const seen = new Set();

    for (const scope of scopes) {
      const ordered = [
        ...findStakeInputs(scope),
        findStakeNearSubmitButton(scope)
      ].filter(Boolean);

      for (const input of ordered) {
        if (seen.has(input)) continue;
        seen.add(input);
        if (fillStakeElement(input, amount)) return true;
      }
    }

    return false;
  }

  function clickQuickStakeButton(amount, root = document) {
    const targets = new Set([String(amount), String(Math.round(amount))]);
    const scopes = [root, findBetslipRoot(), document].filter(Boolean);

    for (const scope of scopes) {
      for (const btn of collectElements(scope, "button, [role='button'], span, div, a")) {
        const text = (btn.textContent || "").trim().replace(/[₹$,]/g, "");
        if (!targets.has(text)) continue;
        btn.click();
        return true;
      }
    }
    return false;
  }

  function clickSubmitButton(root = document) {
    const scopes = [root, findBetslipRoot(), document].filter(Boolean);
    for (const scope of scopes) {
      const btn = findSubmitButton(scope);
      if (!btn) continue;
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      btn.click();
      return true;
    }
    return false;
  }

  async function waitForStakeInput(maxMs = 3500) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const slip = findBetslipRoot();
      const scopes = [slip, document].filter(Boolean);
      for (const scope of scopes) {
        const input = findStakeInputs(scope)[0] || findStakeNearSubmitButton(scope);
        if (input) return input;
      }
      await sleep(150);
    }
    return null;
  }

  async function submitStakeOrder(stake, root) {
    await sleep(400);

    for (let attempt = 0; attempt < 14; attempt += 1) {
      const slip = root || findBetslipRoot() || document;

      if (fillStakeInput(stake, slip)) {
        await sleep(220);
        if (clickSubmitButton(slip)) return { ok: true };
        return { ok: false, error: "Place bet button not found" };
      }

      if (clickQuickStakeButton(stake, slip)) {
        await sleep(220);
        if (clickSubmitButton(slip)) return { ok: true };
      }

      await waitForStakeInput(attempt === 0 ? 600 : 250);
      await sleep(120);
    }

    const probe = probeBetslip();
    ledger.lastError = `Stake input not found (${probe.inputCount} inputs, slip=${probe.hasSlip ? "yes" : "no"})`;
    return { ok: false, error: ledger.lastError };
  }

  function probeBetslip() {
    const slip = findBetslipRoot();
    const inputs = findStakeInputs(slip || document);
    return {
      hasSlip: Boolean(slip),
      slipClass: slip?.className || null,
      inputCount: inputs.length,
      inputs: inputs.slice(0, 6).map((el) => ({
        tag: el.tagName,
        type: el.type || null,
        placeholder: el.placeholder || null,
        aria: el.getAttribute("aria-label"),
        name: el.name || null,
        score: scoreStakeCandidate(el),
        value: el.value ?? el.textContent ?? ""
      })),
      submitText: findSubmitButton(slip || document)?.textContent?.trim() || null
    };
  }

  function elementText(el) {
    return String(el?.textContent || el?.getAttribute?.("aria-label") || "").trim();
  }

  function safeClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } catch {
      /* ignore */
    }
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }

  function isToggleOn(el) {
    if (!el) return false;
    if (el.type === "checkbox" || el.type === "radio") return Boolean(el.checked);
    if (el.getAttribute("aria-checked") === "true") return true;
    if (el.getAttribute("aria-pressed") === "true") return true;
    const cls = String(el.className || "").toLowerCase();
    if (/\b(on|active|enabled|checked|selected)\b/.test(cls)) return true;
    return false;
  }

  function findOneClickControl() {
    const oneClickRe = /1[\s-]?click|one[\s-]?click|quick\s*bet/i;
    let best = null;
    let bestScore = 0;

    for (const label of collectElements(document, "label, span, div, p, button, a")) {
      const text = elementText(label);
      if (!text || text.length > 90 || !oneClickRe.test(text)) continue;

      const forId = label.getAttribute("for");
      if (forId) {
        const linked = document.getElementById(forId);
        if (linked && isVisible(linked)) return linked;
      }

      const inner = label.querySelector(
        'input[type="checkbox"], input[type="radio"], button, [role="switch"], [role="checkbox"]'
      );
      if (inner && isVisible(inner)) return inner;

      if (label.matches('button, [role="switch"], [role="checkbox"], input[type="checkbox"]')) {
        let score = 25;
        if (label.closest('[class*="betslip" i], [class*="bet" i], [class*="slip" i]')) score += 35;
        if (score > bestScore) {
          bestScore = score;
          best = label;
        }
      }
    }

    for (const el of collectElements(
      document,
      'input[type="checkbox"], [role="switch"], [role="checkbox"], button, span, div'
    )) {
      const attrs = [
        el.name,
        el.id,
        el.className,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-testid")
      ]
        .filter(Boolean)
        .join(" ");
      if (!oneClickRe.test(attrs) && !oneClickRe.test(elementText(el))) continue;

      let score = 20;
      if (el.closest('[class*="betslip" i], [class*="bet" i], [class*="slip" i]')) score += 30;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  let oneClickLastAttempt = 0;
  const ONE_CLICK_RETRY_MS = 2500;

  function enableOneClick() {
    const control = findOneClickControl();
    if (!control) {
      return { ok: false, error: "1-click control not found" };
    }

    if (isToggleOn(control)) {
      return { ok: true, alreadyOn: true, control: control.tagName };
    }

    const clickable =
      control.matches('input[type="checkbox"], input[type="radio"]') && control.id
        ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) || control
        : control;

    safeClick(clickable);
    if (!isToggleOn(control) && clickable !== control) safeClick(control);

    const on = isToggleOn(control);
    if (on) {
      ledger.lastError = null;
      ledger.lastAction = "1-click enabled";
      return { ok: true, toggled: true, control: control.tagName };
    }

    return { ok: false, error: "1-click toggle did not turn on", control: control.tagName };
  }

  function ensureOneClickEnabled(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && now - oneClickLastAttempt < ONE_CLICK_RETRY_MS) {
      const control = findOneClickControl();
      if (control && isToggleOn(control)) return { ok: true, alreadyOn: true, skipped: true };
    }
    oneClickLastAttempt = now;
    return enableOneClick();
  }

  function findMatchOddsRoot() {
    for (const el of collectElements(document, "div, section, table, thead, header")) {
      const block = el.closest?.("div, section, table") || el;
      const text = elementText(block).slice(0, 200);
      if (/match\s*odds/i.test(text) && /cash\s*out|loss\s*cut/i.test(text)) {
        return block;
      }
    }
    return null;
  }

  function parseSignedAmount(text) {
    const m = String(text || "").match(/([+-])\s*([\d,]+(?:\.\d+)?)/);
    if (!m) {
      const plain = String(text || "").match(/₹?\s*([\d,]+(?:\.\d+)?)/);
      if (plain) return Number(plain[1].replace(/,/g, ""));
      return null;
    }
    const sign = m[1] === "-" ? -1 : 1;
    return sign * Number(m[2].replace(/,/g, ""));
  }

  function scrapeMatchOddsPnL() {
    const root = findMatchOddsRoot() || document;
    const entries = [];
    const seen = new Set();

    for (const row of collectElements(root, "tr, [role='row'], li, div")) {
      if (isPanelNode(row)) continue;
      const text = (row.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 140 || text.length < 4) continue;
      if (!/\d+\.\d{1,2}/.test(text)) continue;

      const pnlMatches = [...text.matchAll(/([+-]\s*\d+(?:\.\d+)?)/g)];
      if (!pnlMatches.length) continue;

      const labelEl = row.querySelector(
        "td:first-child, th:first-child, [class*='runner' i], [class*='team' i], [class*='name' i]"
      );
      let runnerLabel = (labelEl?.textContent || text.split(/[+-]\s*\d/)[0] || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!runnerLabel || runnerLabel.length < 3) continue;
      if (/^(back|lay|min|max|cash|loss|matched)$/i.test(runnerLabel)) continue;

      const pnl = parseSignedAmount(pnlMatches[pnlMatches.length - 1][1]);
      if (pnl == null || !Number.isFinite(pnl)) continue;

      const key = normalizeName(runnerLabel);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ runner: runnerLabel, pnl });
    }

    return entries;
  }

  function scrapeExposure() {
    const head = (document.body?.innerText || "").slice(0, 8000);
    const m = head.match(/Exp(?:osure)?\s*:?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) return Number(m[1].replace(/,/g, ""));
    return null;
  }

  function scrapeMyBetsCount() {
    const m = (document.body?.innerText || "").match(/My\s*Bets\s*\(\s*(\d+)\s*\)/i);
    return m ? Number(m[1]) : null;
  }

  function captureExitSnapshot() {
    return {
      at: Date.now(),
      pnlPanel: scrapeMatchOddsPnL(),
      exposure: scrapeExposure(),
      myBetsCount: scrapeMyBetsCount()
    };
  }

  function runnerNamesMatch(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right) return false;
    if (left === right) return true;
    return left.includes(right) || right.includes(left);
  }

  function getPositionPnl(trade, exitOdds) {
    const panel = scrapeMatchOddsPnL();
    const row = panel.find((entry) => runnerNamesMatch(entry.runner, trade.runner));
    if (row && Number.isFinite(row.pnl)) return row.pnl;
    if (exitOdds == null) return null;
    return calcTradePnl(trade.side, trade.entryOdds, exitOdds, trade.stake);
  }

  function chooseExitMethodFromTrigger(reason) {
    if (/stop\s*loss/i.test(reason || "")) return "losscut";
    if (/profit\s*target|target/i.test(reason || "")) return "cashout";
    return "cashout";
  }

  function pnlSpread(rows) {
    if (!rows?.length) return null;
    const values = rows.map((r) => r.pnl).filter((v) => Number.isFinite(v));
    if (values.length < 2) return null;
    return Math.max(...values) - Math.min(...values);
  }

  function verifyExitNeutralized(before, after) {
    const reasons = [];
    const beforeSpread = pnlSpread(before?.pnlPanel);
    const afterSpread = pnlSpread(after?.pnlPanel);

    if (afterSpread != null && afterSpread <= 20) {
      reasons.push(`P/L converged (spread ${afterSpread.toFixed(2)})`);
    } else if (beforeSpread != null && afterSpread != null && afterSpread < beforeSpread * 0.35) {
      reasons.push(`P/L spread reduced ${beforeSpread.toFixed(2)} → ${afterSpread.toFixed(2)}`);
    }

    if (before?.exposure != null && after?.exposure != null) {
      if (after.exposure <= 5 || after.exposure <= before.exposure * 0.25) {
        reasons.push(`Exposure reduced ${before.exposure} → ${after.exposure}`);
      }
    }

    if (before?.myBetsCount != null && after?.myBetsCount != null && after.myBetsCount < before.myBetsCount) {
      reasons.push(`My Bets count ${before.myBetsCount} → ${after.myBetsCount}`);
    }

    if (reasons.length) {
      return { ok: true, reason: reasons.join("; ") };
    }

    return {
      ok: false,
      reason: `Exit not verified (P/L spread ${afterSpread ?? "—"}, exposure ${after?.exposure ?? "—"})`
    };
  }

  function findMarketExitButton(trade, kind) {
    const isCashout = kind === "cashout";
    const re = isCashout ? /^cash\s*out/i : /loss\s*cut/i;
    const targetRunner = normalizeName(trade?.runner || "");
    let best = null;
    let bestScore = 0;

    for (const btn of collectElements(document, "button, [role='button'], a, span, div")) {
      const text = elementText(btn);
      if (!text || text.length > 55) continue;
      if (!re.test(text.trim())) continue;
      if (isCashout && /loss\s*cut/i.test(text)) continue;
      if (!isCashout && /cash\s*out/i.test(text)) continue;

      let score = 20;
      if (/₹|\d+\.\d{2}/.test(text)) score += 25;

      const zone = btn.closest("div, section, header, table, thead, tr");
      const zoneText = normalizeName(zone?.textContent || "");
      if (/match\s*odds|\bmo\b/.test(zoneText)) score += 45;
      if (targetRunner && zoneText.includes(targetRunner)) score += 35;

      if (score > bestScore) {
        bestScore = score;
        best = btn;
      }
    }

    return best;
  }

  function findCashoutButton(trade) {
    return findMarketExitButton(trade, "cashout");
  }

  function findLossCutButton(trade) {
    return findMarketExitButton(trade, "losscut");
  }

  function parseCashoutAmount(text) {
    const m = String(text || "").match(/₹?\s*([\d,]+(?:\.\d+)?)/);
    if (m) return Number(m[1].replace(/,/g, ""));
    return null;
  }

  async function clickConfirmIfPresent() {
    const patterns = [/^confirm$/i, /^yes$/i, /^ok$/i, /cash\s*out/i, /proceed/i];
    for (const btn of collectElements(document, "button, [role='button'], a")) {
      const text = elementText(btn);
      if (!text || text.length > 40 || /cancel|close|no/i.test(text)) continue;
      if (patterns.some((p) => p.test(text))) {
        safeClick(btn);
        return true;
      }
    }
    return false;
  }

  async function clickMarketExitButton(trade, kind) {
    const findBtn = kind === "cashout" ? findCashoutButton : findLossCutButton;
    const label = kind === "cashout" ? "Cashout" : "Loss Cut";

    for (let attempt = 0; attempt < 14; attempt += 1) {
      const btn = findBtn(trade);
      if (btn) {
        const exitAmount = parseCashoutAmount(elementText(btn));
        safeClick(btn);
        await sleep(350);
        await clickConfirmIfPresent();
        await sleep(450);
        return { ok: true, exitAmount };
      }
      await sleep(220);
    }
    return { ok: false, error: `${label} button not found` };
  }

  async function executeCashout(trade) {
    const result = await clickMarketExitButton(trade, "cashout");
    if (!result.ok) return result;
    return { ok: true, cashoutAmount: result.exitAmount };
  }

  async function executeLossCut(trade) {
    const result = await clickMarketExitButton(trade, "losscut");
    if (!result.ok) return result;
    return { ok: true, lossCutAmount: result.exitAmount };
  }

  async function executeExchangeExit(trade, exitOdds, reason = "Strategy exit") {
    const method = chooseExitMethodFromTrigger(reason);
    const before = captureExitSnapshot();

    const action =
      method === "cashout" ? await executeCashout(trade) : await executeLossCut(trade);
    if (!action.ok) {
      return { ok: false, error: action.error, method, before };
    }

    await sleep(700);
    const after = captureExitSnapshot();
    const verification = verifyExitNeutralized(before, after);
    if (!verification.ok) {
      return {
        ok: false,
        error: verification.reason,
        method,
        before,
        after
      };
    }

    const exitAmount = action.cashoutAmount ?? action.lossCutAmount ?? null;
    return { ok: true, method, exitAmount, verification, before, after };
  }

  function probeOneClick() {
    const control = findOneClickControl();
    return {
      found: Boolean(control),
      on: control ? isToggleOn(control) : false,
      text: control ? elementText(control).slice(0, 80) : null,
      tag: control?.tagName || null
    };
  }

  function probeCashout(trade = null) {
    const open = trade || ledger.openTrades[0] || null;
    const btn = open ? findCashoutButton(open) : null;
    return {
      openTrade: open?.runner || null,
      found: Boolean(btn),
      text: btn ? elementText(btn).slice(0, 80) : null
    };
  }

  function probeLossCut(trade = null) {
    const open = trade || ledger.openTrades[0] || null;
    const btn = open ? findLossCutButton(open) : null;
    return {
      openTrade: open?.runner || null,
      found: Boolean(btn),
      text: btn ? elementText(btn).slice(0, 80) : null
    };
  }

  function probeExitState(trade = null) {
    const open = trade || ledger.openTrades[0] || null;
    const snapshot = captureExitSnapshot();
    const exitOdds = open?.entryOdds ?? null;
    return {
      openTrade: open?.runner || null,
      exitTriggers: { "Profit Target": "cashout", "Stop Loss": "losscut" },
      positionPnl: open ? getPositionPnl(open, exitOdds) : null,
      cashout: probeCashout(open),
      lossCut: probeLossCut(open),
      snapshot
    };
  }

  async function persistLedger() {
    const payload = {
      openTrades: ledger.openTrades,
      closedTrades: ledger.closedTrades.slice(0, 100),
      seq: ledger.seq,
      stake: ledger.stake
    };
    if (chrome.storage?.local) {
      await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: payload }, resolve));
    }
  }

  async function loadLedger() {
    if (!chrome.storage?.local) return;
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (items) => resolve(items[STORAGE_KEY] || null));
    });
    if (!data) return;
    ledger.openTrades = Array.isArray(data.openTrades) ? data.openTrades : [];
    ledger.closedTrades = Array.isArray(data.closedTrades) ? data.closedTrades : [];
    ledger.seq = Number(data.seq) || 0;
    ledger.stake = DEFAULT_STAKE;
  }

  function getOpenTrades() {
    return ledger.openTrades;
  }

  function getClosedTrades(limit = 20) {
    return ledger.closedTrades.slice(0, limit);
  }

  function getStats() {
    const closed = ledger.closedTrades;
    const pnls = closed.map((t) => Number(t.pnl) || 0);
    const wins = closed.filter((t) => (Number(t.pnl) || 0) > 0).length;
    return {
      openCount: ledger.openTrades.length,
      closedCount: closed.length,
      totalPnl: pnls.reduce((sum, v) => sum + v, 0),
      wins,
      losses: closed.length - wins,
      lastError: ledger.lastError,
      lastAction: ledger.lastAction,
      stake: ledger.stake
    };
  }

  function canOpenTrade(eventId, runnerKey) {
    if (ledger.openTrades.length >= MAX_OPEN_TRADES) {
      return "Max open demo trades reached";
    }
    const dup = ledger.openTrades.find(
      (t) => String(t.eventId) === String(eventId) && String(t.runnerKey) === String(runnerKey)
    );
    if (dup) return `Already open on ${dup.runner}`;
    return null;
  }

  async function executeEntry(ctx) {
    const {
      runnerName,
      side,
      stake = ledger.stake,
      entryOdds,
      targetOdds = null,
      stopOdds = null,
      eventId,
      runnerKey,
      matchName,
      marketName = "Match Odds",
      signalRowId = null
    } = ctx;

    const block = canOpenTrade(eventId, runnerKey);
    if (block) return { ok: false, error: block };

    const row = findRunnerRow(runnerName);
    if (!row) {
      ledger.lastError = `Runner row not found: ${runnerName}`;
      return { ok: false, error: ledger.lastError };
    }

    const click = clickRunnerSide(row, side);
    if (!click.ok) {
      ledger.lastError = click.error;
      return click;
    }

    await sleep(400);

    const trade = {
      tradeId: genTradeId(),
      eventId: String(eventId || ""),
      runnerKey: String(runnerKey || ""),
      marketId: String(eventId || ""),
      selectionId: String(runnerKey || ""),
      match: matchName || "",
      marketName,
      runner: runnerName,
      side,
      entryOdds: entryOdds ?? click.price,
      stake,
      targetOdds,
      stopOdds,
      entryMethod: "click-only",
      openedAt: Date.now(),
      status: "OPEN",
      signalRowId
    };

    ledger.openTrades.push(trade);
    ledger.lastError = null;
    ledger.lastAction = `CLICK ${side} ${runnerName} @ ${trade.entryOdds}`;
    await persistLedger();
    return { ok: true, trade };
  }

  async function executeExit(trade, exitOdds, reason = "Strategy exit") {
    if (!trade) return { ok: false, error: "No open trade" };

    const exitAction = await executeExchangeExit(trade, exitOdds, reason);
    if (!exitAction.ok) {
      ledger.lastError = exitAction.error;
      return exitAction;
    }

    const resolvedExitOdds = exitOdds ?? trade.entryOdds;
    const estimatedPnl = calcTradePnl(trade.side, trade.entryOdds, resolvedExitOdds, trade.stake);
    const methodLabel = exitAction.method === "cashout" ? "CASHOUT" : "LOSS CUT";
    const closed = {
      ...trade,
      status: "CLOSED",
      closedAt: Date.now(),
      exitSide: methodLabel,
      exitMethod: exitAction.method,
      exitOdds: resolvedExitOdds,
      exitAmount: exitAction.exitAmount,
      cashoutAmount: exitAction.method === "cashout" ? exitAction.exitAmount : null,
      lossCutAmount: exitAction.method === "losscut" ? exitAction.exitAmount : null,
      exitSnapshotBefore: exitAction.before,
      exitSnapshotAfter: exitAction.after,
      exitVerified: exitAction.verification?.reason,
      pnl: exitAction.exitAmount ?? estimatedPnl,
      pnlEstimated: exitAction.exitAmount == null,
      exitReason: reason
    };

    ledger.openTrades = ledger.openTrades.filter((t) => t.tradeId !== trade.tradeId);
    ledger.closedTrades.unshift(closed);
    if (ledger.closedTrades.length > 100) ledger.closedTrades.length = 100;
    ledger.lastError = null;
    ledger.lastAction = `${methodLabel} ${trade.runner} (${reason})`;
    await persistLedger();
    return { ok: true, trade: closed };
  }

  async function checkExits(getRunnerQuote, shouldExit) {
    const results = [];
    for (const open of [...ledger.openTrades]) {
      const quote = getRunnerQuote(open);
      if (!quote) continue;
      const currentOdds = open.side === "BACK" ? quote.back : quote.lay ?? quote.back;
      if (currentOdds == null) continue;

      const exitCheck = shouldExit(open, currentOdds, quote);
      if (!exitCheck?.exit) continue;

      const result = await executeExit(open, currentOdds, exitCheck.reason || "Exit");
      results.push(result);
    }
    return results;
  }

  window.__spikexDemoTrader = {
    loadLedger,
    persistLedger,
    getOpenTrades,
    getClosedTrades,
    getStats,
    canOpenTrade,
    executeEntry,
    executeExit,
    checkExits,
    calcTradePnl,
    setStake(amount) {
      const n = Number(amount);
      if (Number.isFinite(n) && n > 0) ledger.stake = Math.round(n);
    },
    getStake() {
      return ledger.stake;
    },
    probeBetslip,
    probeOneClick,
    enableOneClick,
    ensureOneClickEnabled,
    probeCashout,
    probeLossCut,
    probeExitState,
    scrapeMatchOddsPnL,
    captureExitSnapshot,
    chooseExitMethodFromTrigger,
    getPositionPnl,
    debugCashout(trade) {
      return executeCashout(trade || ledger.openTrades[0] || null);
    },
    debugLossCut(trade) {
      return executeLossCut(trade || ledger.openTrades[0] || null);
    },
    debugExchangeExit(trade, exitOdds, reason) {
      return executeExchangeExit(
        trade || ledger.openTrades[0] || null,
        exitOdds ?? null,
        reason || "Profit Target"
      );
    }
  };
})();
