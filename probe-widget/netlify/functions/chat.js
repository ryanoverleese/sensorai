const fetch = require("node-fetch");

// ----------------------------
// CONFIGURATION
// ----------------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-mini";

// Your IrriMAX settings:
const IRRIMAX_KEY = "72c6113e-02bc-42cb-b106-dc4bec979857";
const IRRIMAX_BASE = "https://www.irrimaxlive.com/api";
const LOGGER = "25x4gcityw";

// ----------------------------
// HELPERS
// ----------------------------
function ok(obj) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function err(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function toF(c) {
  return (c * 9) / 5 + 32;
}

function parseDepth(text) {
  text = text.toLowerCase();
  const cmMatch = text.match(/(\d+)\s*cm/);
  const inchMatch = text.match(/(\d+)\s*(in|inch|inches)/);
  let depthCm = 15; // default ≈ 6 inch
  if (cmMatch) depthCm = parseInt(cmMatch[1]);
  if (inchMatch) depthCm = parseInt(inchMatch[1]) * 2.54;
  return depthCm;
}

function findClosestColumn(headers, type, depthCm) {
  // type = "T" (temperature) or "A" (moisture)
  const cols = headers
    .filter(h => new RegExp(`^${type}\\d+\\(\\d+\\)`).test(h))
    .map(h => ({
      name: h,
      depth: parseInt(h.match(/\((\d+)\)/)?.[1] || 0)
    }));
  if (!cols.length) return null;
  let closest = cols[0];
  for (const col of cols) {
    if (Math.abs(col.depth - depthCm) < Math.abs(closest.depth - depthCm))
      closest = col;
  }
  return closest;
}

// ----------------------------
// MAIN HANDLER
// ----------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return err(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const msg = (body.message || "").toLowerCase();

  if (msg === "__ping") return ok({ ok: true, echo: "__pong" });

  try {
    // Determine intent
    if (msg.includes("soil") || msg.includes("temp") || msg.includes("moisture")) {
      const depthCm = parseDepth(msg);
      const isTemp = msg.includes("temp");
      const isMoisture = msg.includes("moisture") || msg.includes("vwc");
      const result = await getSoilReading(depthCm, isTemp, isMoisture);
      return ok({ threadId: null, response: result, runStatus: "completed" });
    }

    // Default fallback to AI
    const ai = await askOpenAI(body.message || "");
    return ok({ threadId: null, response: ai, runStatus: "completed" });

  } catch (e) {
    console.error("Chat function error:", e);
    return err(502, { error: "Chat function error", detail: String(e) });
  }
};

// ----------------------------
// DATA FETCH + PARSE
// ----------------------------
async function getSoilReading(depthCm, isTemp, isMoisture) {
  const url = `${IRRIMAX_BASE}?cmd=getreadings&key=${IRRIMAX_KEY}&name=${LOGGER}`;
  const r = await fetch(url);
  const csv = await r.text();

  const lines = csv.trim().split("\n");
  const headers = lines[0].split(",");
  const lastRow = lines[lines.length - 1].split(",");
  const timestamp = lastRow[0];

  // Select column type
  let type = "T";
  if (isMoisture) type = "A";

  const colInfo = findClosestColumn(headers, type, depthCm);
  if (!colInfo) throw new Error(`No ${type} columns found`);

  const idx = headers.indexOf(colInfo.name);
  const value = parseFloat(lastRow[idx]);

  // Build human-readable depth label
  const depthIn = depthCm / 2.54;
  const label = `${colInfo.depth} cm (${depthIn.toFixed(1)} in)`;

  if (type === "T") {
    const valueF = toF(value);
    return `At ${timestamp}, the soil temperature at ${label} was ${value.toFixed(1)} °C (${valueF.toFixed(1)} °F).`;
  } else {
    return `At ${timestamp}, the volumetric water content (moisture) at ${label} was ${value.toFixed(2)}%.`;
  }
}

// ----------------------------
// OPENAI FALLBACK
// ----------------------------
async function askOpenAI(userMsg) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a helpful agronomy assistant that interprets soil probe data from IrriMAX Live." },
          { role: "user", content: userMsg },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `OpenAI error ${r.status}`);
    return data?.choices?.[0]?.message?.content || "";

  } finally {
    clearTimeout(timeout);
  }
}
