// Mock OpenAI-compatible provider for testing Hermes Manager option 8.
import http from "node:http";

const PORT = 9876;
const MODELS = ["mock-glm-5.3", "mock-deepseek-v4", "mock-llama-4"];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const url = (req.url || "").replace(/\?.*$/, "");
    if (req.method === "GET" && /\/models$/.test(url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: MODELS.map(id => ({ id, object: "model" })) }));
      return;
    }
    if (req.method === "POST" && /\/chat\/completions$/.test(url)) {
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const model = j.model || "mock";
      if (j.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        chunk({ id: "mock-1", choices: [{ index: 0, delta: { role: "assistant", content: "سلام! " } }] });
        chunk({ id: "mock-1", choices: [{ index: 0, delta: { content: "از " } }] });
        chunk({ id: "mock-1", choices: [{ index: 0, delta: { content: "پرووایدر ماک." } }] });
        chunk({ id: "mock-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } });
        chunk("[DONE]");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "mock-1", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content: "سلام! از پرووایدر ماک." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 9 },
        }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found: " + req.method + " " + url } }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log("mock provider on :" + PORT));
