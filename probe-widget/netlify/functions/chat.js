const fetch = require("node-fetch");

// ---- Netlify handler ----
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.message === "__ping") {
    return ok({ ok: true, echo: "__pong" });
  }

  try {
    // 10-second timeout for OpenAI request
    const result = await withTimeout(callOpenAI(body.message), 10000);
    return ok({
      threadId: null,
      response: result,
      runStatus: "completed"
    });
  } catch (e) {
    console.error("Chat function error:", e);
    return err(502, { error: "OpenAI timeout or error", detail: String(e) });
  }
};

// ---- Helpers ----
function ok(obj){ return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(obj) }; }
function err(code,obj){ return { statusCode: code, headers: { "Content-Type":"application/json" }, body: JSON.stringify(obj) }; }

async function withTimeout(promise, ms){
  // 🧠 Fixed version: takes a promise, not a function
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    // pass controller.signal if fetch supports it
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(userMsg){
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
      "Cont
