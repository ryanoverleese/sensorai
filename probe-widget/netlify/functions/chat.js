// netlify/functions/chat.js
const fetch = require("node-fetch");

// ================================
// CONFIGURATION
// ================================
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PROBE_KEY = process.env.PROBE_API_KEY;
const BASE_URL = process.env.PROBE_API_BASE || "https://www.irrimaxlive.com/api/";
const LOGGER = "25x4gcityw";
const MODEL = "gpt-4o-mini";

// ================================
// HELPERS
// ================================
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
function toIrrimaxDate(date) {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// ================================
// FETCH PROBE DATA (CSV → parsed)
// ================================
async function getProbeData({ start, end }) {
  if (!PROBE_KEY) throw new Error("Missing PROBE_API_KEY");

  // Auto 7-day window if not specified
  if (!start && !end) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    start = toIrrimaxDate(weekAgo);
    end = toIrrimaxDate(now);
    console.log("[auto-range]", start, "to", end);
  }

  const url = `${BASE_URL}?cmd=getreadings&key=${PROBE_KEY}&name=${LOGGER}&from=${start}&to=${end}`;
  console.log("[fetching]", url);

  const res = await fetch(url);
  const csv = await res.text();
  if (!res.ok) throw new Error(`IrriMAX error: ${res.status}`);
  if (!csv.includes("Date Time")) throw new Error("Invalid IrriMAX response");

  const lines = csv.split("\n").filter((l) => l.trim());
  const headers = lines[0].split(",");
  const dataRows = lines.slice(1).map((r) => r.split(","));

  return { headers, dataRows };
}

// ================================
// ANALYZE TRENDS + SUMMARIZE
// ================================
async function analyzeWithOpenAI(prompt, csvSummary) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a soil data analyst who interprets IrriMAX probe data for farmers in simple language. Use Fahrenheit and inches. Round decimals sensibly." },
        {
          role: "user",
          content: `${prompt}\n\nHere’s the data summary:\n${csvSummary}`,
        },
      ],
    }),
  });

  const json = await res.json();
  return json?.choices?.[0]?.message?.content || "No response.";
}

// ================================
// MAIN HANDLER
// ================================
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return err(405, { error: "Method not allowed" });

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return err(400, { error: "Invalid JSON" });
  }

  const msg = body.message?.toLowerCase() || "";
  console.log("[user]", msg);

  try {
    // Check if user gave a timeframe
    if (/trend|since|week|month|year|past/i.test(msg)) {
      const { headers, dataRows } = await getProbeData({});

      const tempCols = headers
        .map((h, i) => (h.startsWith("T") ? i : -1))
        .filter((i) => i >= 0);

      if (!tempCols.length) throw new Error("No temperature columns found.");

      const latest = dataRows[dataRows.length - 1];
      const temps = tempCols.map((i) => ({
        depth: headers[i].replace("T", "").replace(/\(.*\)/, ""),
        val: parseFloat(latest[i] || 0),
      }));

      const summary = temps
        .map((t) => `${t.depth}" = ${t.val.toFixed(1)}°C`)
        .join(", ");

      const trendPrompt = `Analyze soil temperature and moisture changes across depths using these readings. If the user mentioned a timeframe, use it. Otherwise, assume a 7-day window. Emphasize any unusual changes, peaks, or dips.\n\n${summary}`;
      const analysis = await analyzeWithOpenAI(trendPrompt, summary);

      return ok({ response: analysis });
    }

    // If asking for basic reading
    if (/temp|moisture|sensor/i.test(msg)) {
      const { headers, dataRows } = await getProbeData({});
      const latest = dataRows[dataRows.length - 1];
      const date = new Date(latest[0]);
      const formattedDate = date.toLocaleString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

      const temps = headers
        .map((h, i) =>
          h.startsWith("T")
            ? {
                depth: Math.round(parseFloat(h.match(/\((\d+)/)?.[1] || 0) / 2.54),
                val: parseFloat(latest[i] || 0),
              }
            : null
        )
        .filter(Boolean);

      const moistures = headers
        .map((h, i) =>
          h.startsWith("A")
            ? {
                depth: Math.round(parseFloat(h.match(/\((\d+)/)?.[1] || 0) / 2.54),
                val: parseFloat(latest[i] || 0),
              }
            : null
        )
        .filter(Boolean);

     let lines = "";

if (msg.includes("moisture") && !msg.includes("temp")) {
  // --- Only moisture ---
  lines = moistures
    .map((m) => `• ${m.depth}" — ${m.val.toFixed(1)}% moisture`)
    .join("\n");

} else if (msg.includes("temp") || msg.includes("temperature")) {
  // --- Only temperature ---
  lines = temps
    .map((t) => `• ${t.depth}" — ${Math.round(t.val * 9 / 5 + 32)}°F`)
    .join("\n");

} else {
  // --- Both ---
  lines = temps
    .map((t, i) => {
      const m = moistures[i];
      return `• ${t.depth}" — ${Math.round(t.val * 9 / 5 + 32)}°F, ${m?.val.toFixed(1)}% moisture`;
    })
    .join("\n");
}

const summary = `**Soil Conditions — ${formattedDate}**\n${lines}`;


      return ok({ response: summary });
    }

    // No timeframe specified
    return ok({
      response:
        "Sure — over what time period would you like me to check the trend?",
    });
  } catch (e) {
    console.error("Chat function error:", e);
    return err(500, { error: "Chat function error", detail: e.message });
  }
};
