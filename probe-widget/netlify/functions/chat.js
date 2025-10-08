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

function safeToF(c) {
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

    // ---- Compress the data ----
    const step = Math.max(1, Math.floor(data.length / 360));
    const reduced = data.filter((_, i) => i % step === 0);

    // ---- Depth mapping (cm -> inches) ----
    const depthMap = [2, 6, 10, 14, 18, 22, 26, 30, 33, 37, 41, 45];

    // ---- Build compact history ----
    const compactHistory = reduced.map(row => {
      const dt = row["Date Time"];
      const temps = headers
        .filter(h => h.startsWith("T"))
        .map((h, i) => {
          const v = safeToF(row[h]);
          return v !== null ? `${depthMap[i] || i * 4 + 2}"=${v.toFixed(1)}°F` : null;
        })
        .filter(Boolean)
        .join(", ");

      const moist = headers
        .filter(h => h.startsWith("A"))
        .map((h, i) => {
          const m = parseFloat(row[h]);
          return !isNaN(m) ? `${depthMap[i] || i * 4 + 2}"=${m.toFixed(1)}%` : null;
        })
        .filter(Boolean)
        .join(", ");

      return `${dt} | Temp: ${temps} | Moist: ${moist}`;
    }).join("\n");

    // ---- GPT Prompt ----
    const prompt = `
You are Acre Insights' soil data analysis assistant.
You have direct access to actual IrriMAX probe readings below.

Each line includes a timestamp followed by temperature (°F) and moisture (%) at each depth.
Use this dataset to answer questions about specific dates, times, depths, or patterns accurately.
If a timestamp isn't exact, find the closest value in the dataset.

Here is the data (past ~180 days):
${compactHistory}

User message:
"${message}"
`;

    const gptRes = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt
    });

    const reply = gptRes.output?.[0]?.content?.[0]?.text || "No response generated.";

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
