// netlify/functions/chat.js  (TEMP: instant reply)
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Quick ping path so we can test from the browser console
  try {
    const body = JSON.parse(event.body || "{}");
    if (body.message === "__ping") {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, echo: "__pong" }) };
    }
  } catch {}

  // Fallback so ANY call returns quickly for now
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, note: "TEMP fallback" }) };
};
