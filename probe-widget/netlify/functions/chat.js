const fetch = require("node-fetch");

// ----------------------------
// CONFIGURATION
// ----------------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-mini";

// IrriMAX configuration
const IRRIMAX_KEY = "72c6113e-02bc-42cb-b106-dc4bec979857";
const IRRIMAX_BASE = "https://www.irrimaxlive.com/api"; // ✅ confirmed working base (no trailing slash)
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

function parseDepth(text) {
  text = text.toLowerCase();
  const cmMatch = text.match(/(\d+)\s*cm/);
  const inchMatch = text.match(/(\d+)\s*(in|inch|inches)/);
  let depthCm = 15; // default ≈ 6"
  if (cmMatch) depthCm = parseInt(cmMatch[1]);
  if (inchMatch) depthCm = parseInt(inchMatch[1]) * 2.54;
  return depthCm;
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
    // Detect whether they asked for temp or moisture
    const isTemp = msg.includes("temp");
    const isMoisture = msg.includes("moisture") || msg.includes("vwc");
    const wantsBoth = isTemp && isMoisture;

    if (isTemp || isMoisture || wantsBoth) {
      const depthCm = parseDepth(msg);
      const result = await getSoilProfile(depthCm, isTemp, isMoisture, wantsBoth);
      return ok({ threadId: null, response: result, runStatus: "completed" });
    }

    // Default fallback to OpenAI for non-data questions
    const ai = await askOpenAI(body.message || "");
    return ok({ threadId: null, response: ai, runStatus: "completed" });

  } catch (e) {
    console.error("Chat function error:", e);
    return err(502, { error: "Chat function error", detail: String(e) });
  }
};

// ----------------------------
// DATA PARSER
// ----------------------------
async function getSoilProfile(depthCm, isTemp, isMoisture, wantsBoth) {
  const url = `${IRRIMAX_BASE}?cmd=getreadings&key=${IRRIMAX_KEY}&name=${LOGGER}`;
  const r = await fetch(url);
  const csv = await r.text();

  const lines = csv.trim().split("\n");
  const headers = lines[0].split(",");
  const lastRow = lines[lines.length - 1].split(",");
  const timestamp = lastRow[0];

  // Format timestamp nicely
  const d = new Date(timestamp.replace(" ", "T"));
  const options = { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  const formattedDate = d.toLocaleString("en-US", options);

  // Identify all temperature and moisture columns
  const tempCols = headers
    .filter(h => /^T\d+\(\d+\)/.test(h))
    .map(h => ({
      name: h,
      depthCm: parseInt(h.match(/\((\d+)\)/)?.[1] || 0),
      valueC: parseFloat(lastRow[headers.indexOf(h)]),
    }));

  const moistCols = headers
    .filter(h => /^A\d+\(\d+\)/.test(h))
    .map(h => ({
      name: h,
      depthCm: parseInt(h.match(/\((\d+)\)/)?.[1] || 0),
      valuePct: parseFloat(lastRow[headers.indexOf(h)]),
    }));

  // Utility conversions
  const cmToIn = cm => Math.round(cm / 2.54);
  const toF = c => Math.round((c * 9) / 5 + 32);

  // Helper to find nearest depth
  const findClosest = (cols, targetCm) => {
    if (!cols.length) return null;
    let closest = cols[0];
    for (const c of cols) {
      if (Math.abs(c.depthCm - targetCm) < Math.abs(closest.depthCm - targetCm)) closest = c;
    }
    return closest;
  };

  let response = `As of ${formattedDate}:\n`;

  // Determine if they want all depths or just one
  const wantsAll = /each|all|every|profile/.test((isTemp || isMoisture) ? "each" : "");

  if (wantsAll) {
    // Show readings for all depths
    const depths = [...new Set([...tempCols.map(c => c.depthCm), ...moistCols.map(c => c.depthCm)])].sort((a, b) => a - b);
    for (const cm of depths) {
      const inch = cmToIn(cm);
      const t = tempCols.find(c => c.depthCm === cm);
      const a = moistCols.find(c => c.depthCm === cm);
      if (isTemp && !isMoisture && t) {
        response += `• ${inch}" — ${toF(t.valueC)}°F\n`;
      } else if (isMoisture && !isTemp && a) {
        response += `• ${inch}" — ${a.valuePct.toFixed(1)}%\n`;
      } else if (wantsBoth && t && a) {
        response += `• ${inch}" — ${toF(t.valueC)}°F, ${a.valuePct.toFixed(1)}%\n`;
      }
    }
  } else {
    // Single depth lookup
    const t = findClosest(tempCols, depthCm);
    const a = findClosest(moistCols, depthCm);
    const inch = cmToIn(depthCm);
    if (isTemp && !isMoisture && t) {
      response += `The soil temperature at ${inch}" was ${toF(t.valueC)}°F.`;
    } else if (isMoisture && !isTemp && a) {
      response += `The soil moisture at ${inch}" was ${a.valuePct.toFixed(1)}%.`;
    } else if (wantsBoth && t && a) {
      response += `At ${inch}", the soil temperature was ${toF(t.valueC)}°F and the moisture was ${a.valuePct.toFixed(1)}%.`;
    } else {
      response += "I couldn’t find matching data for that depth.";
    }
  }

  return response.trim();
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
