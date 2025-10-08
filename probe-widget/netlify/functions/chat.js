// netlify/functions/chat.js
const fetch = require("node-fetch");

// Helper: return JSON success
function ok(obj) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// Helper: return JSON error
function err(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// ---- main handler ----
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return err(405, { error: "Method not allowed" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }

  // simple test ping
  if (body.message === "__ping") {
    return ok({ ok: true, echo: "__pong" });
  }

  try {
    const result = await callOpenAI(body.message);
    return ok({
      threadId: null,
      response: result,
      runStatus: "completed",
    });
  } catch (e) {
    console.error("Chat function error:", e);
    return err(502, {
      error: "OpenAI timeout or error",
      detail: String(e),
    });
  }
};

// ---- helper functions ----
async function callOpenAI(userMsg) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful agronomy assistant." },
          { role: "user", content: String(userMsg || "Hello") },
        ],
      }),
    });

    const raw = await r.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("OpenAI non-JSON:", r.status, raw.slice(0, 500));
      throw new Error(`OpenAI returned non-JSON (${r.status})`);
    }

    if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timeout);
  }
}
