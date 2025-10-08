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

    // ---------------- DATE RANGE LOGIC ----------------
    let daysBack = 7; // default 7 days
    const now = new Date();

    // Support "past X days/weeks/months"
    const matchDays = msg.match(/past\s+(\d+)\s*day/i);
    const matchWeeks = msg.match(/past\s+(\d+)\s*week/i);
    const matchMonths = msg.match(/past\s+(\d+)\s*month/i);

    if (matchDays) daysBack = parseInt(matchDays[1]);
    else if (matchWeeks) daysBack = parseInt(matchWeeks[1]) * 7;
    else if (matchMonths) daysBack = parseInt(matchMonths[1]) * 30;
    else if (msg.includes("past week")) daysBack = 7;
    else if (msg.includes("past two weeks")) daysBack = 14;
    else if (msg.includes("past month")) daysBack = 30;

    // Support "since <month> <day>" or "since June"
    const sinceMatch = msg.match(/since\s+([a-zA-Z]+)\s*(\d{1,2})?/);
    if (sinceMatch) {
      const monthName = sinceMatch[1];
      const dayNum = sinceMatch[2] ? parseInt(sinceMatch[2]) : 1;
      const startDateGuess = new Date(`${monthName} ${dayNum}, ${now.getFullYear()}`);
      if (!isNaN(startDateGuess)) {
        daysBack = Math.floor((now - startDateGuess) / (1000 * 60 * 60 * 24));
      }
    }

    // Safety cap: limit to 120 days max for performance
    if (daysBack > 120) daysBack = 120;

    const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const from = fmtDateTime(startDate);
    const to = fmtDateTime(now);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${apiKey}&name=${loggerId}&from=${from}&to=${to}`;
    console.log("[IrriMAX URL]:", url);

    const r = await fetch(url);
    const csvText = await r.text();

    if (!csvText.includes("Date Time")) {
      throw new Error("Invalid CSV from IrriMAX API");
    }

    const { headers, data } = parseCSV(csvText);
    console.log(`[CSV parsed] ${data.length} rows`);

    // ---------------- DATA PROCESSING ----------------
    const depthMap = [2, 6, 10, 14, 18, 22, 26, 30, 33, 37, 41, 45];
    const latest = data[data.length - 1];
    const latestDate = new Date(latest["Date Time"]);

    const temps = headers
      .filter(h => h.startsWith("T"))
      .map((h, i) => ({
        depth: depthMap[i] || (i * 4 + 2),
        values: data.map(d => parseFloat(d[h] || "0"))
      }));

    const moistures = headers
      .filter(h => h.startsWith("A"))
      .map((h, i) => ({
        depth: depthMap[i] || (i * 4 + 2),
        values: data.map(d => parseFloat(d[h] || "0"))
      }));

    // Create a summary string for GPT
    const summary = depthMap.map((d, i) => {
      const tVals = temps[i]?.values || [];
      const mVals = moistures[i]?.values || [];
      if (!tVals.length || !mVals.length) return "";
      const lastT = toF(tVals[tVals.length - 1]).toFixed(1);
      const lastM = mVals[mVals.length - 1]?.toFixed(1);
      const avgT = toF(tVals.reduce((a, b) => a + b, 0) / tVals.length).toFixed(1);
      const avgM = (mVals.reduce((a, b) => a + b, 0) / mVals.length).toFixed(1);
      return `${d}" — latest ${lastT}°F, ${lastM}% moisture; avg ${avgT}°F, ${avgM}% moisture`;
    }).join("\n");

    const formattedDate = latestDate.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    // ---------------- GPT PROMPT ----------------
    const prompt = `
You are Acre Insights' soil data assistant.
Here is real probe data from the past ${daysBack} days, ending ${formattedDate}.

Data summary (depths in inches):
${summary}

User message:
"${message}"

Use this data to answer clearly and naturally. 
If the user asks about trends or patterns, analyze changes over time.
If they ask for a single depth, focus on that.
If they say hello or something casual, reply conversationally but stay relevant to soil or weather context.
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
