#!/usr/bin/env node
/**
 * Add Gemini API key to Firestore spikex/config (keeps existing Telegram fields).
 *
 * Usage:
 *   GEMINI_API_KEY="AIza..." node scripts/seed-gemini-key.mjs
 *
 * Or create scripts/.gemini-api-key (gitignored, one line).
 *
 * Requires: firebase login (same as seed-firestore-config.mjs)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = "spikex-11403";
const DOC_PATH = "spikex/config";
const PUBLIC_API_KEY = "AIzaSyBsnbT-v6ZYi-ZqJA3feplWpDuhKYUHpl8";
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5r2go878mk6l.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function readGeminiKey() {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  const file = path.join(__dirname, ".gemini-api-key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
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

async function patchGeminiKey(geminiKey) {
  const accessToken = await getFirebaseAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC_PATH}?updateMask.fieldPaths=geminiApiKey&updateMask.fieldPaths=updatedAt`;
  const body = {
    fields: {
      geminiApiKey: { stringValue: geminiKey },
      updatedAt: { stringValue: new Date().toISOString() }
    }
  };

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (res.status === 404) {
    throw new Error("spikex/config document not found — run seed-firestore-config.mjs first for Telegram, or create spikex/config in Firebase Console");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore write failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function verifyPublicRead() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC_PATH}?key=${PUBLIC_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`Public read failed: ${JSON.stringify(data)}`);
  return String(data?.fields?.geminiApiKey?.stringValue || "").trim();
}

const geminiKey = readGeminiKey();
if (!geminiKey) {
  console.error("Missing Gemini API key.");
  console.error("Set GEMINI_API_KEY env var or create scripts/.gemini-api-key");
  console.error("Get a key: https://aistudio.google.com/apikey");
  process.exit(1);
}

if (!geminiKey.startsWith("AIza")) {
  console.error("Key format looks wrong (Gemini keys usually start with AIza...)");
  process.exit(1);
}

try {
  await patchGeminiKey(geminiKey);
  const saved = await verifyPublicRead();
  console.log(saved ? "✔ geminiApiKey saved to spikex/config" : "⚠ Saved but public read check failed");
  console.log(`  Preview: ${saved.slice(0, 8)}...${saved.slice(-4)}`);
} catch (error) {
  console.error("✗", error.message);
  process.exit(1);
}
