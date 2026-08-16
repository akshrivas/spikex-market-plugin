(() => {
  if (window.__spikexGeminiReview) return;

  const GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-flash-latest"
  ];
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

  let apiKey = "";
  let configModel = "";
  let apiKeyLoaded = false;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function cloudConfigApi() {
    return window.__spikexCloudConfig || window.__spikexTelegramConfig || null;
  }

  function cloudGeminiApi() {
    return window.__spikexCloudGemini || null;
  }

  async function ensureApiKey() {
    if (apiKeyLoaded) return apiKey;
    apiKeyLoaded = true;
    try {
      const cfg = await cloudConfigApi()?.loadTelegramConfig?.();
      apiKey = String(cfg?.geminiApiKey || "").trim();
      configModel = String(cfg?.geminiModel || "").trim();
    } catch (error) {
      console.warn("[SpikeX Gemini] config load failed:", error?.message || error);
    }
    return apiKey;
  }

  function modelChain() {
    if (configModel) {
      return [configModel, ...GEMINI_MODELS.filter((m) => m !== configModel)];
    }
    return GEMINI_MODELS;
  }

  function isQuotaError(message) {
    return /quota|rate.?limit|resource_exhausted|429/i.test(String(message || ""));
  }

  function isModelUnavailable(message) {
    return /not found|not supported for generatecontent|404/i.test(String(message || ""));
  }

  function shouldTryNextModel(message) {
    return isQuotaError(message) || isModelUnavailable(message);
  }

  function parseRetrySeconds(message) {
    const match = String(message || "").match(/retry in (\d+(?:\.\d+)?)s/i);
    return match ? Math.ceil(Number(match[1])) : null;
  }

  function buildPrompt(payload) {
    const spikePct = Number(payload.spikePct);
    const spikeStr = Number.isFinite(spikePct) ? spikePct.toFixed(1) : String(payload.spikePct ?? "—");
    const matchContextRaw = payload.matchContextText || payload.matchContext || "";
    const matchContext =
      typeof matchContextRaw === "string"
        ? matchContextRaw.trim()
        : (() => {
            try {
              return JSON.stringify(matchContextRaw, null, 2);
            } catch {
              return String(matchContextRaw || "").trim();
            }
          })();
    const hasMatchContext = Boolean(matchContext);

    return [
      "You are classifying a betting-odds spike.",
      "Use ONLY the information explicitly provided below.",
      "Do not use outside knowledge, live score lookups, or assumed match events.",
      "Do not invent scorecard details, momentum, wickets, boundaries, goals, red cards, or news.",
      hasMatchContext
        ? "Match context is present — you may use only the non-null fields provided."
        : "No scorecard, momentum, or recent-event data is provided — do not analyze or invent those.",
      "",
      "Provided fields:",
      `Sport: ${payload.sport || "—"}`,
      `Tournament: ${payload.tournament || "—"}`,
      `Match: ${payload.match || "—"}`,
      `Market: ${payload.market || "Match Odds"}`,
      `Runner: ${payload.runner || "—"}`,
      `Previous odds: ${payload.oldOdds ?? payload.marketContext?.previousOdds ?? "—"}`,
      `Current odds: ${payload.newOdds ?? payload.marketContext?.currentOdds ?? "—"}`,
      `Spike: ${spikeStr}%`,
      `Timestamp: ${payload.timestamp || payload.marketContext?.timestamp || new Date().toISOString()}`,
      "",
      `A spike of ${spikeStr}% occurred on the specified runner.`,
      "",
      ...(hasMatchContext ? ["Match context:", matchContext, ""] : []),
      "Classify the movement as:",
      "1. EMOTIONAL_OVERREACTION",
      "or",
      "2. JUSTIFIED_REPRICING",
      "",
      "Rules:",
      "- Be conservative. Default to JUSTIFIED_REPRICING unless the spike looks clearly excessive vs the provided context.",
      "- Base the classification only on the provided fields" +
        (hasMatchContext ? " and match context." : "."),
      "- Ignore null/empty match-context fields.",
      "- If match context shows a wicket, dismissal, boundary burst, red card, or similar event that aligns with the odds move, classify JUSTIFIED_REPRICING.",
      "- EMOTIONAL_OVERREACTION only when the odds jump looks larger than the provided on-field facts support, or the facts do not explain a move this size.",
      "- Use high confidence (≥ 0.75) only when the provided facts clearly support that call.",
      "- If the provided information is insufficient to classify confidently, say so clearly in shortReason.",
      "- When information is insufficient, do not guess causal match events; set classification to JUSTIFIED_REPRICING and confidence low (≤ 0.3).",
      "- You must still return one of the two classification values.",
      "",
      "Return JSON only:",
      "{",
      '  "classification": "EMOTIONAL_OVERREACTION" | "JUSTIFIED_REPRICING",',
      '  "confidence": 0.0-1.0,',
      '  "shortReason": "one or two sentences"',
      "}",
      "",
      "Do not provide betting advice.",
      "Do not predict winners.",
      "Do not suggest BACK or LAY.",
      "Only classify the spike."
    ].join("\n");
  }

  function parseGeminiJson(text) {
    if (!text) return null;
    const trimmed = String(text).trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fenced ? fenced[1].trim() : trimmed;
    try {
      return JSON.parse(raw);
    } catch {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  function normalizeClassification(value) {
    const raw = String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (raw.includes("JUSTIFIED")) return "JUSTIFIED_REPRICING";
    if (raw.includes("EMOTIONAL") || raw.includes("OVERREACTION")) return "EMOTIONAL_OVERREACTION";
    return null;
  }

  function normalizeReview(parsed) {
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "invalid Gemini JSON" };
    }
    const classification = normalizeClassification(parsed.classification);
    if (!classification) {
      return { ok: false, error: "missing classification" };
    }
    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = null;
    else confidence = Math.max(0, Math.min(1, confidence));

    return {
      ok: true,
      classification,
      confidence,
      shortReason: String(parsed.shortReason || parsed.reason || "").trim().slice(0, 500)
    };
  }

  async function callGeminiModel(model, key, prompt) {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = `HTTP ${res.status}`;
      try {
        message = JSON.parse(text)?.error?.message || message;
      } catch {
        if (text) message = text.slice(0, 240);
      }
      return { ok: false, error: message, model };
    }

    const data = await res.json().catch(() => null);
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n") || "";
    const parsed = parseGeminiJson(text);
    const review = normalizeReview(parsed);
    if (!review.ok) return { ...review, raw: text.slice(0, 400), model };
    return { ok: true, ...review, raw: text.slice(0, 400), model };
  }

  async function callGemini(payload) {
    const key = await ensureApiKey();
    if (!key) return { ok: false, error: "Gemini API key not configured" };

    const prompt = buildPrompt(payload);
    const models = modelChain();
    let lastError = "";

    for (const model of models) {
      let result = await callGeminiModel(model, key, prompt);
      if (result.ok) return result;

      lastError = result.error || "Gemini failed";

      if (isQuotaError(lastError)) {
        const waitSec = parseRetrySeconds(lastError);
        if (waitSec != null && waitSec <= 45) {
          await sleep(waitSec * 1000);
          result = await callGeminiModel(model, key, prompt);
          if (result.ok) return result;
          lastError = result.error || lastError;
        }
      }

      if (shouldTryNextModel(lastError)) continue;

      return { ok: false, error: lastError, model, triedModels: models };
    }

    if (isQuotaError(lastError)) {
      return {
        ok: false,
        error:
          "Gemini quota exceeded on all tried models. Enable billing in Google AI Studio or set geminiModel in spikex/config (e.g. gemini-2.5-flash).",
        triedModels: models
      };
    }

    if (isModelUnavailable(lastError)) {
      return {
        ok: false,
        error: `No Gemini model available. Tried: ${models.join(", ")}. Set geminiModel in spikex/config.`,
        triedModels: models
      };
    }

    return { ok: false, error: lastError, triedModels: models };
  }

  function buildFirestoreRecord(payload, review, extra = {}) {
    return {
      match: payload.match || "",
      runner: payload.runner || "",
      oldOdds: payload.oldOdds ?? null,
      newOdds: payload.newOdds ?? null,
      spikePct: payload.spikePct ?? null,
      geminiClassification: review?.classification || null,
      geminiConfidence: review?.confidence ?? null,
      geminiReason: review?.shortReason || null,
      pnl: extra.pnl ?? null,
      sport: payload.sport || null,
      tournament: payload.tournament || null,
      market: payload.market || "Match Odds",
      timestamp: payload.timestamp || new Date().toISOString(),
      reviewedAt: new Date().toISOString(),
      tradeId: extra.tradeId || null,
      geminiModel: review?.model || null,
      geminiError: extra.geminiError || null,
      matchContext: payload.matchContext
        ? typeof payload.matchContext === "string"
          ? payload.matchContext.slice(0, 2000)
          : JSON.stringify(payload.matchContext).slice(0, 2000)
        : null
    };
  }

  async function reviewSpike(payload) {
    const eventId = String(payload.eventId || "");
    const reviewId = String(payload.reviewId || "");
    if (!eventId || !reviewId) {
      return { ok: false, error: "missing eventId or reviewId" };
    }

    const gemini = await callGemini(payload);
    const record = buildFirestoreRecord(
      payload,
      gemini.ok ? gemini : null,
      { geminiError: gemini.ok ? null : gemini.error || "Gemini failed" }
    );

    const saved = await cloudGeminiApi()?.saveGeminiReview?.(eventId, reviewId, record);
    return {
      ok: gemini.ok,
      review: gemini.ok ? gemini : null,
      saved,
      error: gemini.ok ? saved?.error : gemini.error
    };
  }

  async function saveTradeResult(payload) {
    const eventId = String(payload.eventId || "");
    const reviewId = String(payload.reviewId || payload.signalRowId || "");
    if (!eventId || !reviewId) return { ok: false, error: "missing eventId or reviewId" };

    const patch = {
      match: payload.match || "",
      runner: payload.runner || "",
      oldOdds: payload.oldOdds ?? null,
      newOdds: payload.newOdds ?? null,
      spikePct: payload.spikePct ?? null,
      pnl: payload.pnl ?? null,
      tradeId: payload.tradeId || null,
      closedAt: new Date().toISOString(),
      exitOdds: payload.exitOdds ?? null,
      tradeResult: payload.tradeResult || null
    };

    if (payload.geminiClassification) patch.geminiClassification = payload.geminiClassification;
    if (payload.geminiConfidence != null) patch.geminiConfidence = payload.geminiConfidence;
    if (payload.geminiReason) patch.geminiReason = payload.geminiReason;

    return cloudGeminiApi()?.updateGeminiReviewPnl?.(eventId, reviewId, patch) || { ok: false };
  }

  window.__spikexGeminiReview = {
    reviewSpike,
    saveTradeResult,
    callGemini,
    ensureApiKey
  };
})();
