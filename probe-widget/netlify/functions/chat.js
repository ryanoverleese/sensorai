const fetch = require("node-fetch");
const { OpenAI } = require("openai");

// ------------------------- HELPERS -------------------------
function parseCSV(csv) {
  const lines = csv.trim().split("\n");
  const headers = lines[0].split(",");
  const data = lines.slice(1).map(line => {
    const parts = line.split(",");
    const obj = {};
    headers.forEach((h, i) => (obj[h.trim()] = parts[i] ? parts[i].trim() : ""));
    return obj;
  });
  return { headers, data };
}

function toF(c) {
  return (parseFloat(c) * 9) / 5 + 32;
}

function fmt(d) {
  const pad = n => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// ------------------------- MAIN HANDLER -------------------------
exports.handler = async (event) => {
  try {
    const { message } = JSON.parse(event.body || "{}");
    const msg = message?.toLowerCase() || "";
    console.log("[User message]:", msg);

    const apiKey = process.env.PROBE_API_KEY;
    const loggerId = "25x4gcityw";
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const miniModel = "gpt-4o-mini";

    // ---------------- INTENT DETECTION ----------------
    const intentPrompt = `
You are an intent parser for a soil data assistant.
Read the user's message and respond ONLY in JSON with:
{
  "intent": "get_current" | "get_trend" | "smalltalk",
  "metric": "temperature" | "moisture" | null,
  "depth": number or null,
  "period": number of days or null
}
User message: "${message}"
`;

    let intent = { intent: "get_current", metric: null, depth: null, period: null };

    try {
      const intentRes = await client.responses.create({
        model: miniModel,
        input: intentPrompt
      });
      const text = intentRes.output[0]?.content[0]?.text || "{}";
      intent = JSON.parse(text);
    } catch (e) {
      console.log("Intent parse failed, using defaults", e.message);
    }

    console.log("[Intent Detected]:", intent);

    if (intent.intent === "smalltalk") {
      const friendly = await client.responses.create({
        model: miniModel,
        input: `You are Acre Insights' friendly assistant. The user said: "${message}". 
        Respond conversationally but briefly — one sentence max.`
      });
      const text = friendly.output[0]?.content[0]?.text || "Hey there! Ready to check your field data?";
      return {
        statusCode: 200,
        body: JSON.stringify({ response: text })
      };
    }

    // ---------------- DATE RANGE ----------------
    let daysBack = intent.period || 7; // default
    const now = new Date();

    const matchDays = msg.match(/past\s+(\d+)\s+day/i);
    if (matchDays) daysBack = parseInt(matchDays[1]);
    if (msg.includes("past week")) daysBack = 7;
    if (msg.includes("past month")) daysBack = 30;

    const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const from = fmt(startDate);
    const to = fmt(now);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${apiKey}&name=${loggerId}&from=${from}&to=${to}`;
    console.log("[IrriMAX URL]:", url);

    const r = await fetch(url);
    const csvText = await r.text();

    if (!csvText.includes("Date Time")) {
      throw new Error("Invalid CSV from IrriMAX API");
    }

    const { headers, data } = parseCSV(csvText);
    const latest = data[data.length - 1];

    // ---------------- DEPTH MAP ----------------
    const depthMap = [2, 6, 10, 14, 18, 22, 26, 30, 33, 37, 41, 45];

    // ---------------- SENSOR EXTRACTION ----------------
    const temps = headers
      .filter(h => h.startsWith("T"))
      .map((h, i) => ({
        depth: depthMap[i] || (i * 4 + 2),
        val: parseFloat(latest[h] || "0")
      }));

    const moistures = headers
      .filter(h => h.startsWith("A"))
      .map((h, i) => ({
        depth: depthMap[i] || (i * 4 + 2),
        val: parseFloat(latest[h] || "0")
      }));

    // ---------------- DETERMINE FOCUS ----------------
    const depthMatch = msg.match(/(\d+)\s*(?:in|inch|inches|")/i);
    const focusDepth = intent.depth || (depthMatch ? parseInt(depthMatch[1]) : null);
    console.log("[Focus Depth]:", focusDepth);

    const wantsTemp = intent.metric === "temperature" || msg.includes("temp");
    const wantsMoisture = intent.metric === "moisture" || msg.includes("moist");

    const date = new Date(latest["Date Time"]);
    const formattedDate = date.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    // ---------------- BUILD RESPONSE ----------------
    let response = "";

    if (focusDepth) {
      const t = temps.find(x => x.depth === focusDepth);
      const m = moistures.find(x => x.depth === focusDepth);

      if (wantsTemp && t) {
        response = `**Soil Temperature — ${formattedDate}**\n• ${focusDepth}" — ${toF(t.val).toFixed(0)}°F`;
      } else if (wantsMoisture && m) {
        response = `**Soil Moisture — ${formattedDate}**\n• ${focusDepth}" — ${m.val.toFixed(1)}%`;
      } else if (t && m) {
        response = `**Soil Conditions — ${formattedDate}**\n• ${focusDepth}" — ${toF(t.val).toFixed(0)}°F, ${m.val.toFixed(1)}% moisture`;
      }
    } else {
      const lines = depthMap.map((d, i) => {
        const t = temps[i];
        const m = moistures[i];
        if (wantsTemp && t) return `• ${d}" — ${toF(t.val).toFixed(0)}°F`;
        if (wantsMoisture && m) return `• ${d}" — ${m.val.toFixed(1)}%`;
        return `• ${d}" — ${toF(t.val).toFixed(0)}°F, ${m.val.toFixed(1)}% moisture`;
      });
      response = `**Soil ${wantsTemp ? "Temperature" : wantsMoisture ? "Moisture" : "Conditions"} — ${formattedDate}**\n${lines.join("\n")}`;
    }

    // ---------------- TREND ANALYSIS ----------------
    if (intent.intent === "get_trend") {
      const trendPrompt = `
You are Acre Insights' probe analysis assistant.
The user asked: "${message}"

Focus on ${focusDepth ? `${focusDepth}-inch sensor` : "all sensors"}.
Here are readings from the past ${daysBack} days (°F and % moisture):
${depthMap.map((d, i) => {
  const t = temps[i], m = moistures[i];
  return `${d}" — ${toF(t.val).toFixed(0)}°F, ${m.val.toFixed(1)}%`;
}).join("\n")}

Analyze trends relevant to the user's query. Respond clearly and concisely.
`;

      const trendRes = await client.responses.create({
        model: miniModel,
        input: trendPrompt
      });

      const trendText = trendRes.output[0]?.content[0]?.text || "Trend analysis unavailable.";
      response = trendText;
    }

    // ---------------- RETURN ----------------
    return {
      statusCode: 200,
      body: JSON.stringify({ response })
    };
  } catch (err) {
    console.error("Chat function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
