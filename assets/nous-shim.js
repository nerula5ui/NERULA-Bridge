// Local shim: accepts OpenCode's friendly model ids and forwards to an
// OpenAI-compatible upstream (Nous Hermes proxy by default, or any custom
// provider configured by Hermes Manager in ~/.hermes-manager.json),
// rewriting the model field upstream.
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---- Hermes Manager provider config (optional) ----
// When ~/.hermes-manager.json exists with mode "custom", this shim forwards to
// that OpenAI-compatible endpoint instead of the local Hermes proxy. That way
// Claude Code / Claude Desktop work with providers like OpenRouter, Z.ai, Groq
// or Google AI Studio without Hermes being installed at all.
const CONFIG_FILE = path.join(os.homedir(), ".hermes-manager.json");

let UPSTREAM = "http://127.0.0.1:8645";
let AUTH = "Bearer sk-shim";

const alias = {
  "beam-free":    "meituan/longcat-2.5:free",   // portal removed beam :free on 2026-11-10; strongest remaining free model
  "step-free":    "stepfun/step-3.7-flash:free",
  "longcat-free": "meituan/longcat-2.5:free",
  "solar-free":   "upstage/solar-mini4:free",
  // Anthropic-style names — Claude Desktop validates ids and only accepts
  // ones containing "claude"/"anthropic"/family names (and rejects "hermes",
  // "longcat", "solar", "step-3"...). These route to the same upstream models.
  "claude-beam":  "meituan/longcat-2.5:free",   // portal removed beam :free on 2026-11-10
  "claude-flash": "stepfun/step-3.7-flash:free",
  "claude-cat":   "meituan/longcat-2.5:free",
  "claude-sun":   "upstage/solar-mini4:free",
};

(function loadProviderConfig() {
  try {
    let t = fs.readFileSync(CONFIG_FILE, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // strip BOM
    const c = JSON.parse(t);
    if (c && c.mode === "custom" && c.baseUrl) {
      UPSTREAM = String(c.baseUrl);
      if (c.apiKey) AUTH = "Bearer " + c.apiKey;
      for (const m of c.models || []) {
        if (m && m.alias && m.real) alias[m.alias] = m.real;
      }
      console.log("[shim] custom provider: " + UPSTREAM + " (" + (c.models || []).length + " models)");
    }
  } catch { /* no config -> default Hermes mode */ }
})();

// Build the full upstream endpoint. If the configured base already contains a
// version segment (/v1, /v4, /v1beta, /openai, ...), it is the full prefix and
// we only append the resource; otherwise append /v1/<sub>.
function endpoint(sub) {
  const base = UPSTREAM.replace(/\/+$/, "");
  return /\/(v\d+|v1beta|openai)(\/|$)/i.test(base) ? base + sub : base + "/v1" + sub;
}

function httpMod() {
  return UPSTREAM.startsWith("https") ? https : http;
}

const PORT = 8765;

function listModels() {
  const label = {
    "claude-beam":  "Claude Beam 1.0 (Hermes)",
    "claude-flash": "Claude Flash 3.7 (Hermes)",
    "claude-cat":   "Claude Cat 2.5 (Hermes)",
    "claude-sun":   "Claude Sun (Hermes)",
  };
  const data = Object.entries(alias).map(([k, v]) => ({
    id: k, object: "model", owned_by: "nous", name: v, display_name: label[k] || v,
  }));
  return { object: "list", data };
}

/* ================================================================
 * Anthropic Messages API -> OpenAI Chat Completions translator
 * (for Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:8765)
 * ================================================================ */

function anthropicToOpenAI(anthropic, reqModel) {
  const oai = { model: reqModel, max_tokens: anthropic.max_tokens || 4096, messages: [] };
  if (anthropic.temperature !== undefined) oai.temperature = anthropic.temperature;
  if (anthropic.top_p !== undefined) oai.top_p = anthropic.top_p;

  const sys = anthropic.system;
  const sysText = typeof sys === "string" ? sys
    : Array.isArray(sys) ? sys.map(b => b.text || "").join("\n") : "";
  if (sysText) oai.messages.push({ role: "system", content: sysText });

  if (Array.isArray(anthropic.tools) && anthropic.tools.length) {
    oai.tools = anthropic.tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object" } },
    }));
  }
  if (anthropic.tool_choice === "auto") oai.tool_choice = "auto";
  else if (anthropic.tool_choice === "any") oai.tool_choice = "required";
  else if (anthropic.tool_choice && anthropic.tool_choice.type === "tool")
    oai.tool_choice = { type: "function", function: { name: anthropic.tool_choice.name } };

  for (const m of anthropic.messages || []) {
    const role = m.role; // "user" | "assistant"
    const content = m.content;
    if (typeof content === "string") {
      oai.messages.push({ role, content });
      continue;
    }
    // structured blocks
    let textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const b of content || []) {
      if (b.type === "text") textParts.push(b.text || "");
      else if (b.type === "thinking") { /* dropped */ }
      else if (b.type === "tool_use")
        toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      else if (b.type === "tool_result") {
        let c = b.content;
        if (Array.isArray(c)) c = c.map(x => (x.text || "")).join("\n");
        toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof c === "string" ? c : JSON.stringify(c) });
      }
    }
    if (role === "assistant") {
      const msg = { role: "assistant", content: textParts.join("") || (toolCalls.length ? null : "") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      oai.messages.push(msg);
    } else {
      if (textParts.length) oai.messages.push({ role: "user", content: textParts.join("") });
      for (const tr of toolResults) oai.messages.push(tr);
    }
  }
  return oai;
}

function openAIToAnthropic(resp, model) {
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content.length) content.push({ type: "text", text: msg.content });
  else if (Array.isArray(msg.content))
    for (const c of msg.content) if (c.text) content.push({ type: "text", text: c.text });
  let stopReason = choice.finish_reason === "length" ? "max_tokens" : "end_turn";
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    stopReason = "tool_use";
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const usage = resp.usage || {};
  return {
    id: resp.id || ("msg_" + Date.now().toString(36)),
    type: "message", role: "assistant", model,
    content,
    stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

function postJSON(path_, obj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const url = endpoint(path_);
    const req = httpMod().request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length, Authorization: AUTH },
    }, (res) => {
      let buf = "";
      res.on("data", c => (buf += c));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("bad upstream: " + buf.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// True streaming relay: forward stream:true upstream and translate OpenAI
// delta chunks into Anthropic SSE deltas as they arrive (no full buffering).
function streamUpstream(oaiBody, onData) {
  oaiBody.stream = true;
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(oaiBody), "utf8");
    const url = endpoint("/chat/completions");
    const req = httpMod().request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length, Authorization: AUTH },
    }, (res) => {
      if (res.statusCode !== 200) {
        let buf = "";
        res.on("data", c => (buf += c));
        res.on("end", () => reject(new Error("upstream " + res.statusCode + ": " + buf.slice(0, 200))));
        return;
      }
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) onData(line.slice(5).trim());
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function sendAnthropicStreaming(res, anthropic, oaiBody) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const msgId = "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: anthropic.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

  let blockIdx = 0;
  let open = null; // { kind: "text" } | { kind: "tool", ti }
  const tools = new Map(); // upstream tool index -> state
  let stopReason = "end_turn";
  let outTokens = 0;

  const closeOpen = () => {
    if (open) {
      sse(res, "content_block_stop", { type: "content_block_stop", index: blockIdx });
      blockIdx++;
      open = null;
    }
  };

  return streamUpstream(oaiBody, (payload) => {
    if (!payload || payload === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    const choice = (chunk.choices && chunk.choices[0]) || {};
    const delta = choice.delta || {};
    if (chunk.usage) outTokens = chunk.usage.completion_tokens || outTokens;

    const text = typeof delta.content === "string" ? delta.content : "";
    if (text) {
      if (!open || open.kind !== "text") {
        closeOpen();
        sse(res, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
        open = { kind: "text" };
      }
      sse(res, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text } });
    }

    for (const tc of delta.tool_calls || []) {
      const ti = tc.index !== undefined ? tc.index : 0;
      let t = tools.get(ti);
      if (!t) {
        closeOpen();
        t = { id: tc.id || ("toolu_" + Date.now().toString(36)), name: (tc.function && tc.function.name) || "", args: "" };
        sse(res, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } });
        tools.set(ti, t);
        open = { kind: "tool", ti };
      }
      if (tc.function && tc.function.arguments) {
        t.args += tc.function.arguments;
        sse(res, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
      }
    }

    if (choice.finish_reason) {
      if (choice.finish_reason === "length") stopReason = "max_tokens";
      else if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") stopReason = "tool_use";
      else stopReason = "end_turn";
    }
  }).then(() => {
    closeOpen();
    if (!tools.size && !outTokens) { /* no usage info upstream; fine */ }
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTokens } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  }).catch((e) => {
    console.error("[anthropic] stream relay error:", e && e.stack || e);
    try {
      sse(res, "error", { type: "error", error: { type: "api_error", message: "shim: " + e.message } });
      res.end();
    } catch {}
  });
}

function sendAnthropicResponse(res, anthropic, upstream, wantsStream) {
  if (wantsStream) return sendAnthropicStreaming(res, anthropic, upstream);
  const shifted = postJSON("/v1/chat/completions", upstream);
  shifted.then((oaiResp) => {
    const msg = openAIToAnthropic(oaiResp, anthropic.model);
    if (!wantsStream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(msg));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    sse(res, "message_start", { type: "message_start", message: { id: msg.id, type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } } });
    let idx = 0;
    for (const block of msg.content) {
      if (block.type === "text") {
        sse(res, "content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: idx });
      } else if (block.type === "tool_use") {
        sse(res, "content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: idx });
      }
      idx++;
    }
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  }).catch((e) => {
    console.error("[anthropic] upstream error:", e && e.stack || e);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "shim: " + e.message } }));
    } else {
      try { res.end(); } catch {}
    }
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    // normalize: ignore query strings and trailing slashes so Desktop/CLI variants all match
    const rawUrl = req.url || "/v1/models";
    let path = rawUrl.replace(/\?.*$/, "").replace(/\/+$/, "") || "/v1/models";

    // CORS for any renderer-originated fetches (Electron)
    console.log("[req]", new Date().toISOString(), req.method, rawUrl, "body=" + body.length, "ua=" + (req.headers["user-agent"] || "").slice(0, 60));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    // Claude Desktop's ConfigHealth probe sends HEAD / — answer immediately
    if (req.method === "HEAD" && (path === "/" || path === "/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end();
      return;
    }

    if (path === "/v1/models" || path.endsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listModels()));
      return;
    }

    if (/\/(v1\/)?messages\/count_tokens$/.test(path)) {
      try {
        const j = JSON.parse(body.toString("utf8"));
        const text = JSON.stringify(j.messages || "") + JSON.stringify(j.system || "");
        const id2 = alias[(j.model || "").replace(/#.*$/, "")] ? (j.model || "").replace(/#.*$/, "") : "beam-free";
        const est = Math.ceil(text.length / 4);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "ctok_" + Date.now().toString(36), input_tokens: Math.max(est, 1), model: id2 }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(e) } }));
      }
      return;
    }

    if (/\/(v1\/)?messages$/.test(path) && req.method === "POST") {
      try {
        const j = JSON.parse(body.toString("utf8"));
        const modelKey = (j.model || "beam-free").replace(/#.*$/, "");
        const realModel = alias[modelKey] || modelKey; // real id sent upstream
        const oaiBody = anthropicToOpenAI(j, realModel);
        // force non-stream upstream, we emit our own SSE to the client
        delete oaiBody.stream;
        const upstreamModel = oaiBody.model;
        oaiBody.model = realModel;
        // return the friendly name to the client in the final message
        sendAnthropicResponse(res, { ...j, model: modelKey }, oaiBody, j.stream === true);
      } catch (e) {
        console.error("[anthropic] /v1/messages error:", e && e.stack || e);
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(e) } }));
        }
      }
      return;
    }

    // Rewrite the friendly id to the real Portal id in any JSON body
    if (body.length > 0) {
      try {
        const json = JSON.parse(body.toString("utf8"));
        if (json.model && alias[json.model]) json.model = alias[json.model];
        body = Buffer.from(JSON.stringify(json), "utf8");
      } catch { /* not JSON - forward as is */ }
    }

    const url = new URL(endpoint(path));
    const upstreamReq = httpMod().request(url, {
      method: req.method,
      headers: { ...req.headers, host: url.host, "content-length": body.length, authorization: AUTH },
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstreamReq.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "shim upstream error: " + e.message } }));
    });
    upstreamReq.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log("nous shim on http://127.0.0.1:" + PORT + "/v1"));
