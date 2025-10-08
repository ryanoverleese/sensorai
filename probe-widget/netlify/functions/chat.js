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
  const n = parseFloat(c);
  if (isNaN(n)) return null;
  return (n * 9) / 5 + 32;
}

function fmtDateTime(d) {
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
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---- Pull up to 180 days of data ----
    const now = new Date();
    const startDate = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const from = fmtDateTime(startDate);
    const to = fmtDateTime(now);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${apiKey}&name=${loggerId}&from=${from}&to=${to}`;
    console.log("[IrriMAX URL]:", url);

    const res = await fetch(url);
    const csvText = await res.text();

    if (!csvText.includes("Date Time")) throw new Error("Invalid CSV from IrriMAX API");

    const { headers, data } = parseCSV(csvText);
    console.log(`[CSV parsed] ${data.length} rows`);

    // ---- Compress the data (keep every 12h or so) ----
    const step = Math.max(1, Math.floor(data.length / 360)); // about 180 days * 2/day
    const reduced = data.filter((_, i) => i % step === 0);

    // ---- Depth mapping (cm -> inches) ----
    const depthMap = [2, 6, 10, 14, 18, 22, 26, 30, 33, 37, 41, 45];

    // ---- Build compact history string ----
    const compactHistory = reduced.map(row => {
      const dt = row["Date Time"];
      const temps = headers
        .filter(h => h.startsWith("T"))
        .map((h, i) => `${depthMap[i] || i * 4 + 2}"=${toF(row[h]).toFixed(1)}°F`)
        .join(", ");
      const moist = headers
        .filter(h => h.startsWith("A"))
        .map((h, i) => `${depthMap[i] || i * 4 + 2}"=${parseFloat(row[h] || "0").toFixed(1)}%`)
        .join(", ");
      return `${dt} | Temp: ${temps} | Moist: ${moist}`;
    }).join("\n");

    // ---- Feed full context to GPT ----
    const prompt = `
You are Acre Insights' soil data analysis assistant.
You have direct access to actual IrriMAX probe readings below.

Each line has a date/time followed by temperature (°F) and moisture (%) at depths in inches.
Use these readings to precisely answer questions about specific dates, times, depths, or trends.

Be concise, clear, and factual — reference real values from the dataset.
If no data exists for an exact timestamp, find and report the closest reading.

Here is the actual data (past ~180 days):
${compactHistory}

User message:
"${message}"
`;

    const gptRes = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt
    });

    const reply = gptRes.output[0]?.content[0]?.text || "No response generated.";

    return {
      statusCode: 200,
      body: JSON.stringify({ response: reply })
    };
  } catch (err) {
    console.error("Chat function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
