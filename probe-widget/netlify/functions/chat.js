const fetch = require("node-fetch");

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

// ------------------------- MAIN HANDLER -------------------------
exports.handler = async (event) => {
  try {
    const { message } = JSON.parse(event.body || "{}");
    const msg = message?.toLowerCase() || "";
    console.log("[User message]:", msg);

    const apiKey = process.env.PROBE_API_KEY;
    const loggerId = "25x4gcityw";
  const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${apiKey}&name=${loggerId}`;


    const r = await fetch(url);
    const csvText = await r.text();

    if (!csvText.includes("Date Time")) {
      throw new Error("Invalid CSV from IrriMAX API");
    }

    const { headers, data } = parseCSV(csvText);
    const latest = data[data.length - 1];

    // --- Depth mapping (cm -> inches) ---
    const depthMap = [2, 6, 10, 14, 18, 22, 26, 30, 33, 37, 41, 45];

    // Extract sensor values
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

    // --- Detect focus depth ---
    const depthMatch = msg.match(/(\d+)\s*(?:in|inch|inches|")/i);
    let focusDepth = depthMatch ? parseInt(depthMatch[1]) : null;
    console.log("[Focus Depth]:", focusDepth);

    // Filter data if user asked for one depth
    let filteredTemps = temps;
    let filteredMoistures = moistures;

    if (focusDepth) {
      filteredTemps = temps.filter(t => t.depth === focusDepth);
      filteredMoistures = moistures.filter(m => m.depth === focusDepth);
    }

    // --- Determine if asking about temperature or moisture ---
    const wantsTemp = msg.includes("temp");
    const wantsMoisture = msg.includes("moist");

    // Format date
    const date = new Date(latest["Date Time"]);
    const formattedDate = date.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    // --- Response Text ---
    let response = "";

    if (focusDepth) {
      if (wantsTemp && filteredTemps.length) {
        const t = filteredTemps[0];
        response = `**Soil Conditions — ${formattedDate}**\n• ${t.depth}" — ${toF(t.val).toFixed(0)}°F`;
      } else if (wantsMoisture && filteredMoistures.length) {
        const m = filteredMoistures[0];
        response = `**Soil Conditions — ${formattedDate}**\n• ${m.depth}" — ${m.val.toFixed(1)}% moisture`;
      } else if (filteredTemps.length && filteredMoistures.length) {
        const t = filteredTemps[0];
        const m = filteredMoistures[0];
        response = `**Soil Conditions — ${formattedDate}**\n• ${t.depth}" — ${toF(t.val).toFixed(0)}°F, ${m.val.toFixed(1)}% moisture`;
      }
    } else {
      // All depths summary
      const lines = depthMap.map((d, i) => {
        const t = temps[i];
        const m = moistures[i];
        if (!t || !m) return "";
        return `• ${d}" — ${toF(t.val).toFixed(0)}°F, ${m.val.toFixed(1)}% moisture`;
      });
      response = `**Soil Conditions — ${formattedDate}**\n${lines.join("\n")}`;
    }

    // --- If trend or analysis requested, ask GPT ---
    if (msg.includes("trend") || msg.includes("change") || msg.includes("over the past")) {
      const openai = require("openai");
      const client = new openai.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const miniModel = "gpt-4o-mini";

      const trendPrompt = `
You are Acre Insights' probe analysis assistant. 
The user asked: "${message}"

Focus on ${focusDepth ? `${focusDepth}-inch sensor` : "all sensors"}.

Here are the most recent readings (in °F and % moisture):
${depthMap.map((d, i) => {
  const t = temps[i], m = moistures[i];
  return `${d}" — ${toF(t.val).toFixed(0)}°F, ${m.val.toFixed(1)}% moisture`;
}).join("\n")}

Analyze trends in moisture and/or temperature based on context.
`;

      const trendRes = await client.responses.create({
        model: miniModel,
        input: trendPrompt
      });

      const trendText = trendRes.output[0]?.content[0]?.text || "Trend analysis unavailable.";
      response = trendText;
    }

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
