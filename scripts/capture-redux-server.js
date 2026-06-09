const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3847;
const HOST = "127.0.0.1";
const OUT_FILE = path.join(__dirname, "../captures/cricway-redux.json");

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/redux") {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, body);
    console.log(`[capture-redux] saved ${OUT_FILE} (${body.length} bytes)`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[capture-redux] listening on http://${HOST}:${PORT}/redux`);
  console.log(`[capture-redux] writing to ${OUT_FILE}`);
});
