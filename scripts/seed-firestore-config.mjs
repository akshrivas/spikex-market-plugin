#!/usr/bin/env node
/**
 * Seed Firestore spikex/config (shared Telegram bot token).
 * Usage:
 *   TELEGRAM_BOT_TOKEN="123:ABC..." node scripts/seed-firestore-config.mjs
 * Or place token in scripts/.telegram-bot-token (gitignored, one line).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = "spikex-11403";
const DOC_PATH = "spikex/config";
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5r2go878mk6l.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function readToken() {
  if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    return process.env.TELEGRAM_BOT_TOKEN.trim();
  }
  const file = path.join(__dirname, ".telegram-bot-token");
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8").trim();
  }
  return "";
}

async function getFirebaseAccessToken() {
  const configPath = path.join(os.homedir(), ".config/configstore/firebase-tools.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const refreshToken = config?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("Firebase CLI not logged in. Run: firebase login");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to refresh Firebase access token");
  }
  return data.access_token;
}

async function upsertConfig(token) {
  const accessToken = await getFirebaseAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC_PATH}`;
  const body = {
    fields: {
      telegramBotToken: { stringValue: token },
      updatedAt: { stringValue: new Date().toISOString() }
    }
  };

  let res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (res.status === 404) {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore write failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function verifyPublicRead() {
  const apiKey = "AIzaSyBsnbT-v6ZYi-ZqJA3feplWpDuhKYUHpl8";
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC_PATH}?key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`Public read failed: ${JSON.stringify(data)}`);
  const token = data?.fields?.telegramBotToken?.stringValue || "";
  return Boolean(token);
}

const token = readToken();
if (!token) {
  console.error("Missing bot token.");
  console.error("Set TELEGRAM_BOT_TOKEN env var or create scripts/.telegram-bot-token");
  process.exit(1);
}

if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  console.error("Token format looks invalid (expected 123456789:ABC...)");
  process.exit(1);
}

try {
  await upsertConfig(token);
  const ok = await verifyPublicRead();
  console.log(ok ? "✔ spikex/config seeded and publicly readable" : "⚠ Seeded but public read check failed");
} catch (error) {
  console.error("✗", error.message);
  process.exit(1);
}
