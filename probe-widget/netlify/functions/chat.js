const fetch = require("node-fetch");

// ----------------------------
// CONFIGURATION
// ----------------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const IRRIMAX_KEY = process.env.PROBE_API_KEY;
const IRRIMAX_BASE = process.env.PROBE_API_BASE || "https://api.irrimaxlive.com/av1/";
const LOGGER = "25x4gcityw"; // replace with your actual logger ID
const MODEL = "gpt-4o-mini";

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

function parseDepth(text) {
  text = text.toLowerCase();
  const cmMatch = text.match(/(\d+)\s*cm/);
  const inchMatch = text.match(/(\d+)\s*(in|inch|inches)/);
  let depthCm = 15; // default to 15 cm (~6 in)
  if (cmMatch) depthCm = parseInt(cmMatch[1]);
  if (inchMatch) depthCm = parseInt(inchMatch[1]) * 2.54;
  return depthCm;
}

function closestDepthColumn(headers, depthCm) {
  const tCols = headers
    .filter(h => /^T\d+\(\d+\)/.test(h))
    .map(h => ({
      name: h,
      depth: parseInt(h.match(/\((\d+)\)/)?.[1] || 0)
    }));
  let closest = tCols[0];
  for (const col of tCols) {
    if (Math.abs(col.depth - depthCm) < Math.abs(closest.depth - depthCm))
      closest = col;
  }
  return closest?.name;
}

// ----------------------------
// MAIN HANDLER
// ----------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return err(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const msg = body.message || "";

  if (msg === "__ping") return ok({ ok: true, echo: "__pong" });

  try {
    // Detect if user asked for soil temp
    const lower = msg.toLowerCase();
    if (lower.includes("soil temp")) {
      const depthCm = parseDepth(lower);
      const result = await getSoilTemp(depthCm);
      return ok({
        threadId: null,
        response: result,
        runStatus: "completed",
      });
    }

    // Default: let OpenAI handle it
    const ai = await askOpenAI(msg);
    return ok({
      threadId: null,
      response: ai,
      runStatus: "completed",
    });

  } catch (e) {
    console.error("Chat function error:", e);
    return err(502, { error: "Chat function error", detail: String(e) });
  }
};

// ----------------------------
// DATA FUNCTIONS
// ----------------------------
async function getSoilTemp(depthCm) {
  const url = `${IRRIMAX_BASE}?cmd=getgraphvalues&key=${IRRIMAX_KEY}&name=${LOGGER}`;
  const r = await fetch(url);
  const csv = await r.text();
console.log("IRRIMAX CSV HEADERS SAMPLE:", csv.split("\n")[0]);

  const lines = csv.trim().split("\n");
  const headers = lines[0].split(",");
  const lastRow = lines[lines.length - 1].split(",");

  const colName = closestDepthColumn(headers, depthCm);
  if (!colName) throw new Error("No temperature columns found in data.");

  const idx = headers.indexOf(colName);
  const valueC = parseFloat(lastRow[idx]);
  const timestamp = lastRow[0];

  const valueF = (valueC * 9) / 5 + 32;

  return `At ${timestamp}, the soil temperature at approximately ${depthCm.toFixed(0)} cm (${(depthCm/2.54).toFixed(1)} in) was ${valueC.toFixed(1)}°C (${valueF.toFixed(1)}°F).`;
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
          { role: "system", content: "You are a helpful agronomy assistant that helps interpret soil probe data." },
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
