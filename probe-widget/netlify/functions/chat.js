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
    // Run the OpenAI request with a 10-second timeout
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
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), ms);
  try { return await promise(ac.signal); }
  finally { clearTimeout(timer); }
}

async function callOpenAI(userMsg, signal){
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    signal,
    headers:{
      "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({
      model:"gpt-4o-mini",
      messages:[
        { role:"system", content:"You are a helpful agronomy assistant." },
        { role:"user", content:String(userMsg || "Hello") }
      ]
    })
  });

  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch {
    console.error("OpenAI non-JSON:", r.status, raw.slice(0,500));
    throw new Error(`OpenAI returned non-JSON (${r.status})`);
  }
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return data?.choices?.[0]?.message?.content || "";
}
