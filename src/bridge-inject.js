(() => {
  if (window.__marketRadarEarlyInject) return;
  window.__marketRadarEarlyInject = true;

  function injectScript(id, src, onload) {
    if (document.getElementById(id)) {
      onload?.();
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = chrome.runtime.getURL(src);
    script.onload = () => onload?.();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function inject() {
    if (document.getElementById("market-radar-live-board")) return;

    injectScript("market-radar-odds-detect", "src/odds-detect.js", () => {
      injectScript("market-radar-live-board", "src/live-board.js");
    });
  }

  if (document.documentElement) {
    inject();
  } else {
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  }
})();
