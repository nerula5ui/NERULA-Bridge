#!/usr/bin/env node
// ============================================================
//  Hermes Free AI Manager
//  Adds Nous Hermes FREE models to OpenCode / Claude Code /
//  Claude Desktop. Fixes every known Claude Desktop quirk:
//    - BOM-free JSON writes (BOM makes Desktop parser fail)
//    - claude-* model ids only (Desktop id validation)
//    - OAuth latch clearing (token caches) so 3p mode activates
//    - claude.ai cookie latch moved to backup
//    - gateway configLibrary profile with appliedId
//  Requires: Node.js >= 18, Hermes installed on this PC.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

// ---------- constants ----------
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

const SHIM_PORT = 8765;          // Anthropic-compatible shim
const HERMES_PORT = 8645;        // Hermes proxy (Nous Portal)
const BRIDGE_PORT = 8787;        // PREAMER bridge (optional, health only)
const SHIM_KEY = "sk-shim";

const HERMES_EXE = path.join(LOCAL, "hermes", "bin", "hermes.exe");
const SHIM_PATH = path.join(HOME, ".config", "opencode", "nous-shim.js");
const SHIM_BUNDLED = path.join(APP_DIR, "assets", "nous-shim.js");
const OPENCODE_JSON = path.join(HOME, ".config", "opencode", "opencode.json");
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const PREAMER_MCP = path.join(HOME, "Desktop", "PREAMER", "mcp", "server.js");

const CLAUDE_PKG_DIR = path.join(LOCAL, "Packages", "Claude_pzs8sxrjxfjjc");
const CLAUDE_3P = path.join(CLAUDE_PKG_DIR, "LocalCache", "Local", "Claude-3p");
const CLAUDE_CONFIG_LIB = path.join(CLAUDE_3P, "configLibrary");
const CLAUDE_DATA = path.join(LOCAL, "Claude-Data", "claude_pzs8sxrjxfjjc");
const CLAUDE_DEVICE_CFG = path.join(CLAUDE_DATA, "claude_desktop_config.json");
const CLAUDE_STATE = path.join(CLAUDE_DATA, "config.json");
const CLAUDE_3P_DEVICE_CFG = path.join(CLAUDE_3P, "claude_desktop_config.json");
const CLAUDE_COOKIES_DIR = path.join(CLAUDE_DATA, "Network");
const STARTUP_BAT = path.join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "start-hermes-proxy.bat");

// Desktop only accepts ids containing claude/anthropic family names and
// REJECTS hermes/longcat/solar/step/gpt/glm... inside the id.
const DESKTOP_MODELS = [
  { name: "claude-beam",  labelOverride: "Beam 1.0 - Hermes"  },
  { name: "claude-flash", labelOverride: "Step 3.7 - Hermes"  },
  { name: "claude-cat",   labelOverride: "LongCat 2.5 - Hermes" },
  { name: "claude-sun",   labelOverride: "Solar Mini - Hermes" },
];

const OPENCODE_FREE_MODELS = {
  "beam-free":    { name: "Beam 501B Free" },
  "step-free":    { name: "Step 3.7 Flash Free" },
  "longcat-free": { name: "LongCat 2.5 Free" },
  "solar-free":   { name: "Solar Mini 4 Free" },
};

// ---------- tiny utils ----------
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};
if (process.platform === "win32" && !process.env.FORCE_COLOR && !process.stdout.isTTY) {
  // keep colors off when piped (safer for logs)
  for (const k of Object.keys(C)) C[k] = "";
}
const ok   = (m) => console.log(`${C.green}  [OK]${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}  [!!]${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}  [XX]${C.reset} ${m}`);
const info = (m) => console.log(`${C.cyan}  [..]${C.reset} ${m}`);
const line = (t = "HELMES FREE AI MANAGER") => console.log(`\n${C.bold}${C.blue}============================================================${C.reset}\n${C.bold}${C.blue}  ${t}${C.reset}\n${C.bold}${C.blue}============================================================${C.reset}`);

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function backupOnce(file, tag = "bak-hm") {
  try {
    if (fs.existsSync(file) && !fs.existsSync(file + "." + tag)) {
      fs.copyFileSync(file, file + "." + tag);
    }
  } catch {}
}

function readJSON(file) {
  let t = fs.readFileSync(file, "utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // strip BOM if present
  return JSON.parse(t);
}

// Always BOM-free: JSON.stringify output is plain UTF-8 text.
function writeJSON(file, obj) {
  ensureDir(path.dirname(file));
  backupOnce(file);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function writeText(file, text, { backup = true } = {}) {
  ensureDir(path.dirname(file));
  if (backup) backupOnce(file);
  fs.writeFileSync(file, text.replace(/\n/g, "\r\n"), "utf8");
}

function portUp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1", timeout: timeoutMs });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
  });
}

function waitPort(port, ms = 15000) {
  const end = Date.now() + ms;
  return new Promise(async (resolve) => {
    while (Date.now() < end) {
      if (await portUp(port, 800)) return resolve(true);
      await new Promise(r => setTimeout(r, 500));
    }
    resolve(false);
  });
}

function startDetached(exe, args) {
  try {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

function killProcess(name) {
  try {
    spawn("taskkill", ["/F", "/IM", `${name}.exe`], { stdio: "ignore", windowsHide: true });
  } catch {}
}

// POST a tiny request through the shim to prove the full chain works.
// 200 = OK, 429 = reachable (rate limited) -> still wired correctly.
function pingShim(timeoutMs = 45000) {
  // model id depends on the active source: Hermes uses claude-beam alias,
  // custom providers pass real ids through.
  let model = "claude-beam";
  if (providerMode() === "custom") {
    const ms = customModels();
    if (ms.length) model = ms[0].real;
  }
  const body = JSON.stringify({
    model, max_tokens: 8,
    messages: [{ role: "user", content: "ping" }],
  });
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: SHIM_PORT, path: "/v1/messages", method: "POST",
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        "x-api-key": SHIM_KEY, "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      let buf = "";
      res.on("data", c => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, body: buf.slice(0, 300) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.end(body);
  });
}

// ---------- preflight ----------
async function preflight({ needShim = true } = {}) {
  let okAll = true;
  const mode = providerMode();

  if (mode === "custom") {
    const p = readProvider();
    ok(`Custom provider mode: ${p.baseUrl} (${(p.models || []).length} models) — Hermes not required.`);
  } else {
    // 1. Hermes installed?
    if (fs.existsSync(HERMES_EXE)) {
      ok(`Hermes installed: ${HERMES_EXE}`);
    } else {
      fail(`Hermes is NOT installed (missing: ${HERMES_EXE})`);
      console.log(`${C.yellow}       -> Install the Nous Hermes app first, or use option 8 (custom provider, no Hermes).${C.reset}`);
      return false;
    }

    // 2. Hermes proxy up? start if not
    if (await portUp(HERMES_PORT)) {
      ok(`Hermes proxy running on :${HERMES_PORT}`);
    } else {
      info(`Starting Hermes proxy...`);
      startDetached(HERMES_EXE, ["proxy", "start"]);
      if (await waitPort(HERMES_PORT, 20000)) ok(`Hermes proxy started on :${HERMES_PORT}`);
      else { fail(`Hermes proxy did not start on :${HERMES_PORT}`); okAll = false; }
    }
  }

  if (!needShim) return okAll;

  // 3. shim file present? restore from bundled copy if missing
  if (!fs.existsSync(SHIM_PATH)) {
    if (fs.existsSync(SHIM_BUNDLED)) {
      ensureDir(path.dirname(SHIM_PATH));
      fs.copyFileSync(SHIM_BUNDLED, SHIM_PATH);
      ok(`Restored shim from bundled copy -> ${SHIM_PATH}`);
    } else {
      fail(`Shim file missing and no bundled copy: ${SHIM_PATH}`);
      okAll = false;
      return okAll;
    }
  }

  // 4. shim up? start if not
  if (await portUp(SHIM_PORT)) {
    ok(`Shim (Anthropic gateway) running on :${SHIM_PORT}`);
  } else {
    info(`Starting shim gateway...`);
    startDetached(process.execPath, [SHIM_PATH]);
    if (await waitPort(SHIM_PORT, 15000)) ok(`Shim started on :${SHIM_PORT}`);
    else { fail(`Shim did not start on :${SHIM_PORT}`); okAll = false; }
  }
  return okAll;
}

// ---------- install: OpenCode ----------
function installOpenCode() {
  let j;
  try {
    j = fs.existsSync(OPENCODE_JSON) ? readJSON(OPENCODE_JSON) : { $schema: "https://opencode.ai/config.json" };
  } catch (e) {
    fail(`opencode.json is not valid JSON: ${e.message}`);
    warn(`Keeping a copy at ${OPENCODE_JSON}.broken and writing a fresh file.`);
    try { fs.copyFileSync(OPENCODE_JSON, OPENCODE_JSON + ".broken"); } catch {}
    j = { $schema: "https://opencode.ai/config.json" };
  }

  j.provider = j.provider || {};
  if (providerMode() === "custom") {
    const ms = customModels();
    const models = {};
    for (const m of ms) models[m.real] = { name: m.label || m.real };
    j.provider["custom-free"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "Free AI (custom)",
      options: { baseURL: `http://127.0.0.1:${SHIM_PORT}/v1`, apiKey: "sk-free" },
      models,
    };
    if (!j.model || !String(j.model).startsWith("custom-free/")) {
      j.model = `custom-free/${ms[0].real}`;
    }
    ok(`OpenCode config updated (BOM-free): ${OPENCODE_JSON}`);
    ok(`Provider "custom-free" with ${ms.length} model(s); default: ${j.model}`);
  } else {
    j.provider["nous-free"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "Nous Portal",
      options: { baseURL: `http://127.0.0.1:${SHIM_PORT}/v1`, apiKey: "sk-free" },
      models: OPENCODE_FREE_MODELS,
    };
    if (!j.model) j.model = "nous-free/beam-free";
    ok(`OpenCode config updated (BOM-free): ${OPENCODE_JSON}`);
    ok(`Provider "nous-free" with 4 free models; default: ${j.model}`);
    console.log(`${C.dim}       Models in OpenCode: beam-free / step-free / longcat-free / solar-free${C.reset}`);
  }
}

// ---------- install: Claude Code ----------
function installClaudeCode() {
  const ms = customModels();
  const mainModel = providerMode() === "custom" && ms.length ? ms[0].real : "claude-beam";
  const fastModel = providerMode() === "custom" && ms.length > 1 ? ms[1].real
    : providerMode() === "custom" ? ms[0].real : "claude-sun";

  let s = {};
  try {
    s = fs.existsSync(CLAUDE_SETTINGS) ? readJSON(CLAUDE_SETTINGS) : {};
  } catch (e) {
    warn(`settings.json unreadable (${e.message}) — creating a fresh one (old kept as .bak-hm).`);
    s = {};
  }
  s.env = {
    ...(s.env || {}),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${SHIM_PORT}`,
    ANTHROPIC_AUTH_TOKEN: SHIM_KEY,
    ANTHROPIC_MODEL: mainModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: mainModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mainModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fastModel,
    ANTHROPIC_SMALL_FAST_MODEL: fastModel,
  };
  writeJSON(CLAUDE_SETTINGS, s);
  ok(`Claude Code settings updated (BOM-free): ${CLAUDE_SETTINGS}`);
  ok(`Claude Code now uses ${SHIM_PORT} gateway, model: ${mainModel}`);

  // dedicated launcher
  const launcher = path.join(APP_DIR, "Claude-Code-Hermes.bat");
  writeText(launcher, [
    "@echo off",
    "title Claude Code - Free AI Models",
    `set ANTHROPIC_BASE_URL=http://127.0.0.1:${SHIM_PORT}`,
    `set ANTHROPIC_AUTH_TOKEN=${SHIM_KEY}`,
    `set ANTHROPIC_MODEL=${mainModel}`,
    `set ANTHROPIC_DEFAULT_SONNET_MODEL=${mainModel}`,
    `set ANTHROPIC_DEFAULT_OPUS_MODEL=${mainModel}`,
    `set ANTHROPIC_DEFAULT_HAIKU_MODEL=${fastModel}`,
    `set ANTHROPIC_SMALL_FAST_MODEL=${fastModel}`,
    "echo Starting Claude Code with free AI models...",
    "call claude",
  ].join("\n"));
  ok(`Launcher created: ${launcher}`);
  console.log(`${C.dim}       Double-click "Claude-Code-Hermes.bat" to start Claude Code.${C.reset}`);
}

// ---------- install: Claude Desktop ----------
function gatewayKeys() {
  const mode = providerMode();
  const inferenceModels = mode === "custom"
    ? customModels().map(m => ({ name: m.alias, labelOverride: m.label || m.real }))
    : DESKTOP_MODELS;
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${SHIM_PORT}`,
    inferenceGatewayApiKey: SHIM_KEY,
    inferenceGatewayAuthScheme: "x-api-key",
    inferenceCredentialKind: "static",
    inferenceModels,
  };
}

function installClaudeDesktop() {
  if (!fs.existsSync(CLAUDE_PKG_DIR)) {
    fail(`Claude Desktop (MSIX) is not installed: ${CLAUDE_PKG_DIR}`);
    return false;
  }

  // close it first, otherwise it rewrites our config on exit
  info(`Closing Claude Desktop (if running)...`);
  killProcess("claude");

  // device config (the real userData config, per --user-data-dir)
  const gw = gatewayKeys();
  for (const file of [CLAUDE_DEVICE_CFG, CLAUDE_3P_DEVICE_CFG]) {
    let j = {};
    try { j = fs.existsSync(file) ? readJSON(file) : {}; } catch { j = {}; }
    Object.assign(j, gw, { deploymentMode: "3p", disableClaudeAiSignIn: true });
    writeJSON(file, j);
    ok(`Gateway config written (BOM-free): ${path.basename(path.dirname(file))}\\${path.basename(file)}`);
  }

  // configLibrary profile (the one Desktop actually reads at launch)
  ensureDir(CLAUDE_CONFIG_LIB);
  let appliedId = null, entries = [];
  try {
    const meta = readJSON(path.join(CLAUDE_CONFIG_LIB, "_meta.json"));
    appliedId = meta.appliedId || null;
    entries = Array.isArray(meta.entries) ? meta.entries : [];
  } catch {}
  if (!appliedId) appliedId = crypto.randomUUID();
  const profile = { ...gw, deploymentMode: "3p", disableClaudeAiSignIn: true };
  writeJSON(path.join(CLAUDE_CONFIG_LIB, `${appliedId}.json`), profile);
  if (!entries.some(e => e && e.id === appliedId)) entries.push({ id: appliedId, name: "Hermes Free" });
  writeJSON(path.join(CLAUDE_CONFIG_LIB, "_meta.json"), { appliedId, entries });
  ok(`configLibrary profile written (id ${appliedId.slice(0, 8)}...)`);

  // break the OAuth latch so third-party mode actually activates
  try {
    const st = readJSON(CLAUDE_STATE);
    const removed = [];
    for (const k of ["oauth:tokenCache", "oauth:tokenCacheV2", "lastKnownAccountUuid"]) {
      if (st[k] !== undefined) { delete st[k]; removed.push(k); }
    }
    writeJSON(CLAUDE_STATE, st);
    if (removed.length) ok(`OAuth latch cleared (removed: ${removed.join(", ")})`);
    else ok(`OAuth latch already clear`);
  } catch (e) {
    warn(`Could not update app state (${e.message}) — continuing.`);
  }

  // break the claude.ai cookie latch (cookies are backed up, not deleted)
  try {
    const moved = [];
    for (const f of fs.readdirSync(CLAUDE_COOKIES_DIR)) {
      if (/^Cookies(-journal)?$/.test(f)) {
        const from = path.join(CLAUDE_COOKIES_DIR, f);
        const to = path.join(CLAUDE_COOKIES_DIR, f + ".bak-hm-cookies");
        try { fs.rmSync(to, { force: true }); } catch {}
        fs.renameSync(from, to);
        moved.push(f);
      }
    }
    if (moved.length) ok(`claude.ai session cookies moved to backup (${moved.join(", ")})`);
    else ok(`No active claude.ai cookies to move`);
  } catch (e) {
    warn(`Cookie step skipped (${e.message}).`);
  }

  // relaunch
  info(`Restarting Claude Desktop...`);
  startDetached("explorer.exe", ["shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude"]);
  ok(`Claude Desktop relaunched`);

  console.log(`
${C.bold}  What to check in Claude Desktop:${C.reset}`);
  console.log(`${C.dim}   1. Open a NEW chat
   2. Click the model name next to the send button
   3. You should see:  Beam 1.0 - Hermes / Step 3.7 - Hermes /
                       LongCat 2.5 - Hermes / Solar Mini - Hermes
   NOTE: model ids are claude-* on purpose (Desktop rejects other names).${C.reset}`);
  return true;
}

// ---------- health check ----------
async function healthCheck() {
  const rows = [];
  rows.push(["Hermes app", fs.existsSync(HERMES_EXE) ? "installed" : "NOT INSTALLED"]);
  rows.push(["Hermes proxy :8645", (await portUp(HERMES_PORT)) ? "UP" : "DOWN"]);
  rows.push(["Shim gateway :8765", (await portUp(SHIM_PORT)) ? "UP" : "DOWN"]);
  rows.push(["PREAMER bridge :8787", (await portUp(BRIDGE_PORT)) ? "UP" : "DOWN"]);
  rows.push(["OpenCode config", fs.existsSync(OPENCODE_JSON) ? "present" : "missing"]);
  rows.push(["Claude Code settings", fs.existsSync(CLAUDE_SETTINGS) ? "present" : "missing"]);
  rows.push(["Claude Desktop", fs.existsSync(CLAUDE_PKG_DIR) ? "installed" : "not installed"]);

  console.log(`\n${C.bold}  STATUS${C.reset}`);
  for (const [k, v] of rows) {
    const good = /installed$|present|^UP$/.test(v) && !/NOT|missing|DOWN/.test(v);
    const col = good ? C.green : C.yellow;
    console.log(`   ${k.padEnd(24)} ${col}${v}${C.reset}`);
  }

  if (await portUp(SHIM_PORT)) {
    info(`Pinging model API through the shim (tiny request)...`);
    const r = await pingShim();
    if (r.status === 200) ok(`API works end-to-end (200)`);
    else if (r.status === 429) warn(`API reachable but rate-limited right now (429) — still wired correctly`);
    else fail(`API problem: HTTP ${r.status} — ${r.body}`);
  }
}

// ---------- backup ----------
function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(APP_DIR, "backup", ts);
  ensureDir(dest);
  const manifest = { created: new Date().toISOString(), files: [] };

  const sources = [
    ["nous-shim.js", SHIM_PATH],
    ["opencode.json", OPENCODE_JSON],
    ["opencode.env", path.join(HOME, ".config", "opencode", ".env")],
    ["claude-code-settings.json", CLAUDE_SETTINGS],
    ["start-hermes-proxy.bat", STARTUP_BAT],
    ["claude_desktop_config.json", CLAUDE_DEVICE_CFG],
    ["claude_state_config.json", CLAUDE_STATE],
    ["claude-3p_desktop_config.json", CLAUDE_3P_DEVICE_CFG],
  ];
  try {
    if (fs.existsSync(CLAUDE_CONFIG_LIB)) {
      for (const f of fs.readdirSync(CLAUDE_CONFIG_LIB)) {
        sources.push([`configLibrary__${f}`, path.join(CLAUDE_CONFIG_LIB, f)]);
      }
    }
  } catch {}

  for (const [name, src] of sources) {
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dest, name));
        manifest.files.push({ name, source: src, ok: true });
      } else {
        manifest.files.push({ name, source: src, ok: false });
      }
    } catch (e) {
      manifest.files.push({ name, source: src, ok: false, error: e.message });
    }
  }
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // keep the bundled shim copy fresh so restores always use the newest working version
  try {
    if (fs.existsSync(SHIM_PATH)) fs.copyFileSync(SHIM_PATH, SHIM_BUNDLED);
  } catch {}

  const nOk = manifest.files.filter(f => f.ok).length;
  ok(`Backup saved: ${dest} (${nOk} files)`);
  ok(`Bundled shim copy refreshed: ${SHIM_BUNDLED}`);
  console.log(`${C.dim}       This folder IS your saved Hermes project. Keep it!${C.reset}`);
}

// ---------- autostart ----------
function installAutostart() {
  const shimNode = process.execPath;
  const lines = [
    "@echo off",
    `start "" /MIN "${HERMES_EXE}" proxy start`,
    `start "" /MIN "${shimNode}" "${SHIM_PATH}"`,
  ];
  if (fs.existsSync(PREAMER_MCP)) {
    lines.push(`start "" /MIN "${shimNode}" "${PREAMER_MCP}"`);
  }
  writeText(STARTUP_BAT, lines.join("\n"), { backup: true });
  ok(`Autostart written: ${STARTUP_BAT}`);
  console.log(`${C.dim}       Hermes proxy + shim (+ PREAMER) start on every Windows login.${C.reset}`);
}

// ---------- custom provider (no Hermes needed) ----------
// The same shim is provider-agnostic: it can forward to ANY OpenAI-compatible
// endpoint (OpenRouter, Z.ai, Groq, Google AI Studio, ...). Config lives in
// ~/.hermes-manager.json so both the manager and the shim see it.
const PROVIDER_CFG = path.join(HOME, ".hermes-manager.json");

const PRESETS = [
  { id: "1", name: "OpenRouter",          baseUrl: "https://openrouter.ai/api/v1",  hint: "free ':free' models, key: openrouter.ai/keys" },
  { id: "2", name: "Z.ai (GLM Flash)",    baseUrl: "https://api.z.ai/api/paas/v4",  hint: "GLM-4.7-Flash / GLM-4.5-Flash are free, key: z.ai API" },
  { id: "3", name: "Groq",                baseUrl: "https://api.groq.com/openai/v1", hint: "free Llama/Mixtral tier, key: console.groq.com" },
  { id: "4", name: "Google AI Studio",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", hint: "Gemini free tier, key: aistudio.google.com" },
  { id: "5", name: "Custom URL",          baseUrl: "",                               hint: "any OpenAI-compatible endpoint" },
];

function readProvider() {
  try {
    let t = fs.readFileSync(PROVIDER_CFG, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch { return { mode: "hermes" }; }
}

function providerMode() {
  const p = readProvider();
  return (p && p.mode === "custom" && p.baseUrl) ? "custom" : "hermes";
}

function customModels() {
  const p = readProvider();
  return (p && Array.isArray(p.models)) ? p.models : [];
}

function writeProvider(obj) {
  backupOnce(PROVIDER_CFG, "bak-pc");
  fs.writeFileSync(PROVIDER_CFG, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function restartShim() {
  return new Promise(async (resolve) => {
    info(`Restarting the shim gateway so the new source takes effect...`);
    spawn("powershell", ["-NoProfile", "-Command",
      `Get-NetTCPConnection -LocalPort ${SHIM_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`],
      { stdio: "ignore", windowsHide: true });
    await new Promise(r => setTimeout(r, 2000));
    if (!fs.existsSync(SHIM_PATH) && fs.existsSync(SHIM_BUNDLED)) {
      ensureDir(path.dirname(SHIM_PATH));
      fs.copyFileSync(SHIM_BUNDLED, SHIM_PATH);
    }
    startDetached(process.execPath, [SHIM_PATH]);
    resolve(await waitPort(SHIM_PORT, 15000));
  });
}

// Same path-joining rule as the shim: if base has a version segment it is the
// full prefix, otherwise /v1 is appended.
function providerEndpoint(baseUrl, sub) {
  const base = String(baseUrl).replace(/\/+$/, "");
  return /\/(v\d+|v1beta|openai)(\/|$)/i.test(base) ? base + sub : base + "/v1" + sub;
}

// GET {base}/models to auto-discover model ids (OpenAI-compatible).
function fetchModelIds(baseUrl, apiKey, timeoutMs = 20000) {
  const url = new URL(providerEndpoint(baseUrl, "/models"));
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(url, {
      method: "GET", timeout: timeoutMs,
      headers: { Authorization: "Bearer " + apiKey },
    }, (res) => {
      let buf = "";
      res.on("data", c => (buf += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(buf);
          const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : (Array.isArray(j) ? j : []));
          resolve(arr.map(m => (typeof m === "string" ? m : m.id)).filter(Boolean));
        } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function pickFreeIds(ids, baseUrl) {
  const free = ids.filter(id => /:free/i.test(id));
  let list = free.length ? free : ids;
  // prefer GLM / deepseek / llama for coding, keep order
  return list.slice(0, 8);
}

async function customProviderMenu() {
  line("CUSTOM PROVIDER (NO HERMES NEEDED)");
  console.log(`  Use ANY OpenAI-compatible API as the model source.
  The same gateway shim translates it for OpenCode / Claude Code / Claude Desktop.
  Free keys: openrouter.ai/keys | z.ai | console.groq.com | aistudio.google.com\n`);

  for (const p of PRESETS) {
    console.log(`   [${p.id}] ${C.bold}${p.name}${C.reset}${p.baseUrl ? C.dim + "  " + p.baseUrl + C.reset : ""}`);
    console.log(`        ${C.dim}${p.hint}${C.reset}`);
  }
  console.log(`   [R] Switch back to ${C.bold}Hermes mode${C.reset}`);
  console.log(`   [0] Back\n`);

  const c1 = (await ask(`  Choose provider: `)) || "";
  console.log("");
  if (c1.trim() === "0" || c1.trim() === "") return;
  if (c1.trim().toLowerCase() === "r") {
    writeProvider({ mode: "hermes" });
    const up = await restartShim();
    if (up) ok(`Back to Hermes mode — shim restarted on :${SHIM_PORT}`);
    else fail(`Shim did not restart — run Health check.`);
    return;
  }

  const preset = PRESETS.find(p => p.id === c1.trim());
  if (!preset) { fail(`Unknown provider.`); return; }

  let baseUrl = preset.baseUrl;
  if (!baseUrl) baseUrl = ((await ask(`  Base URL (OpenAI-compatible, e.g. https://host/v1): `)) || "").trim();
  if (!baseUrl) { fail(`No base URL given.`); return; }

  const apiKey = ((await ask(`  API key: `)) || "").trim();
  if (!apiKey) { fail(`No API key given.`); return; }

  info(`Discovering models from ${baseUrl} ...`);
  let ids = await fetchModelIds(baseUrl, apiKey);
  let models = [];
  if (ids && ids.length) {
    const chosen = pickFreeIds(ids);
    ok(`Discovered ${ids.length} models; using first ${chosen.length}: ${chosen.join(", ")}`);
    console.log(`  ${C.dim}Press ENTER to accept, or type a comma-separated list of model ids to use instead:${C.reset}`);
    const manual = ((await ask(`  Models [default: discovered]: `)) || "").trim();
    if (manual) {
      models = manual.split(",").map(s => s.trim()).filter(Boolean).slice(0, 8)
        .map((real, i) => ({ alias: `claude-${i + 1}`, real, label: real.split("/").pop() }));
    } else {
      models = chosen.map((real, i) => ({ alias: `claude-${i + 1}`, real, label: real.split("/").pop() }));
    }
  } else {
    warn(`Could not auto-discover models (some providers do not expose /models).`);
    const manual = ((await ask(`  Enter model ids, comma separated (e.g. glm-4.7-flash, glm-4.5-flash): `)) || "").trim();
    if (!manual) { fail(`No models given.`); return; }
    models = manual.split(",").map(s => s.trim()).filter(Boolean).slice(0, 8)
      .map((real, i) => ({ alias: `claude-${i + 1}`, real, label: real.split("/").pop() }));
  }

  writeProvider({ mode: "custom", baseUrl, apiKey, models, updatedAt: new Date().toISOString() });
  ok(`Provider saved to ${PROVIDER_CFG}`);
  const up = await restartShim();
  if (!up) { fail(`Shim did not restart — run Health check.`); return; }
  ok(`Shim restarted on :${SHIM_PORT} -> ${baseUrl}`);

  // prove the chain works before writing configs
  info(`Testing one tiny request through the new source...`);
  const test = await pingShim();
  if (test.status === 200) ok(`Custom provider works end-to-end!`);
  else if (test.status === 429) warn(`Provider reachable but rate-limited right now (429) — still wired.`);
  else { fail(`Provider test failed (HTTP ${test.status}): ${test.body}`); warn(`Config kept — check the API key / URL, then re-run option 8.`); return; }

  const t = ((await ask(`  Install to [1] OpenCode, [2] Claude Code, [3] Claude Desktop, [4] ALL: `)) || "4").trim();
  console.log("");
  if (t === "0") return;
  await runInstall(["opencode", "claude-code", "claude-desktop", "all"].includes(t) ? t : "all");
}

// ---------- menu ----------
// ---------- input ----------
// Piped stdin: slurp ALL input up front and serve asks from a queue.
// (Creating a fresh readline per question loses buffered lines between asks.)
let stdinEOF = false;
const pipedLines = [];
if (!process.stdin.isTTY) {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    for (const l of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) pipedLines.push(l);
    stdinEOF = true;
  });
} else {
  process.stdin.once("end", () => { stdinEOF = true; });
}

// Input helper: works interactively (TTY) and with piped stdin (scripted).
function ask(q) {
  process.stdout.write(q);
  if (!process.stdin.isTTY) {
    return new Promise((res) => {
      const wait = () => {
        if (pipedLines.length) return res(pipedLines.shift());
        if (stdinEOF) return res(null);
        setTimeout(wait, 25);
      };
      wait();
    });
  }
  return new Promise((res) => {
    if (stdinEOF) return res(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { rl.close(); } catch {} res(v); } };
    const onEnd = () => { stdinEOF = true; finish(null); };
    process.stdin.once("end", onEnd);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", (v) => { process.stdin.removeListener("end", onEnd); finish(v); });
  });
}

async function menu() {
  console.clear();
  const mode = providerMode();
  line("HERMES FREE AI MANAGER");
  console.log(`  ${C.dim}Adds FREE AI models to your AI tools. English UI on purpose.${C.reset}`);
  console.log(`  ${C.dim}Current model source: ${C.bold}${mode === "custom" ? "CUSTOM provider (" + readProvider().baseUrl + ")" : "Hermes (Nous Portal)"}${C.reset}\n`);
  console.log(`   ${C.bold}[1]${C.reset} Install to ${C.bold}OpenCode${C.reset}`);
  console.log(`   ${C.bold}[2]${C.reset} Install to ${C.bold}Claude Code${C.reset}`);
  console.log(`   ${C.bold}[3]${C.reset} Install to ${C.bold}Claude Desktop${C.reset}`);
  console.log(`   ${C.bold}[4]${C.reset} Install to ${C.bold}ALL${C.reset} (OpenCode + Claude Code + Claude Desktop)`);
  console.log(`   ${C.bold}[5]${C.reset} Health check (services / API ping)`);
  console.log(`   ${C.bold}[6]${C.reset} Backup Hermes setup (save this project)`);
  console.log(`   ${C.bold}[7]${C.reset} Reinstall Windows autostart (proxy + shim on login)`);
  console.log(`   ${C.bold}[8]${C.reset} ${C.bold}Custom provider${C.reset} (no Hermes needed — OpenRouter / Z.ai / Groq / Google)`);
  console.log(`   ${C.bold}[0]${C.reset} Exit\n`);

  const choice = await ask(`  Choose: `);
  if (choice === null) return; // stdin closed/EOF, exit cleanly
  const pick = choice.trim();
  console.log("");

  switch (pick) {
    case "1": await runInstall("opencode"); break;
    case "2": await runInstall("claude-code"); break;
    case "3": await runInstall("claude-desktop"); break;
    case "4": await runInstall("all"); break;
    case "5": await healthCheck(); break;
    case "6": backup(); break;
    case "7": installAutostart(); break;
    case "8": await customProviderMenu(); break;
    case "0": return;
    case "": break; // just ENTER -> back to menu
    default: fail(`Unknown option: ${pick}`);
  }
  console.log("");
  if (await ask(`  Press ENTER to go back to the menu...`) === null) return;
  return menu();
}

async function runInstall(target) {
  line("INSTALLING HERMES FREE MODELS");
  const targets = target === "all"
    ? ["opencode", "claude-code", "claude-desktop"]
    : [target];

  if (!(await preflight())) {
    fail(`Preflight failed — nothing was changed.`);
    return;
  }
  let allGood = true;
  for (const t of targets) {
    console.log(`\n${C.magenta}${C.bold}  >> ${t}${C.reset}`);
    try {
      if (t === "opencode") installOpenCode();
      else if (t === "claude-code") installClaudeCode();
      else if (t === "claude-desktop") allGood = installClaudeDesktop() && allGood;
    } catch (e) {
      fail(`${t}: ${e.message}`);
      allGood = false;
    }
  }
  console.log("");
  if (allGood) ok(`Done! Free Hermes models are wired in.`);
  else warn(`Finished with warnings — see messages above.`);
}

// ---------- CLI entry ----------
const arg = (process.argv[2] || "").toLowerCase();

if (arg === "--check") await healthCheck();
else if (arg === "--backup") backup();
else if (arg === "--autostart") installAutostart();
else if (arg === "--install") {
  const t = (process.argv[3] || "").toLowerCase();
  if (!["opencode", "claude-code", "claude-desktop", "all"].includes(t)) {
    console.log("Usage: hermes-manager.mjs --install <opencode|claude-code|claude-desktop|all>");
    process.exit(1);
  }
  await runInstall(t);
} else {
  await menu();
}
