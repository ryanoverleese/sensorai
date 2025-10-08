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

function parseUserDateTime(msg) {
  // e.g. "september 15", "sept 15 9 pm", "sep 15 at 8:00am"
  const dateRegex = /(?:on|for|at|around|on the)?\s*([a-zA-Z]+)\s*(\d{1,2})(?:[,\s]+(\d{4}))?/i;
  const timeRegex = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

  const dateMatch = msg.match(dateRegex);
  const timeMatch = msg.match(timeRegex);

  if (!dateMatch) return null;

  const monthName = dateMatch[1];
  const day = parseInt(dateMatch[2]);
  const year = dateMatch[3] ? parseInt(dateMatch[3]) : new Date().getFullYear();

  let hour = 12;
  let minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  }

  const parsed = new Date(`${monthName} ${day}, ${year} ${hour}:${minute}`);
  if (isNaN(parsed)) return null;
  return parsed;
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
    let daysBack = 7;
    const now = new Date();

    const matchDays = msg.match(/past\s+(\d+)\s*day/i);
    const matchWeeks = msg.match(/past\s+(\d+)\s*week/i);
    const matchMonths = msg.match(/past\s+(\d+)\s*month/i);

    if (matchDays) daysBack = parseInt(matchDays[1]);
    else if (matchWeeks) daysBack = parseInt(matchWeeks[1]) * 7;
    else if (matchMonths) daysBack = parseInt(matchMonths[1]) * 30;
    else if (msg.includes("past week")) daysBack = 7;
    else if (msg.includes("past two weeks")) daysBack = 14;
    else if (msg.includes("past month")) daysBack = 30;

    const sinceMatch = msg.match(/since\s+([a-zA-Z]+)\s*(\d{1,2})?/);
    if (sinceMatch) {
      const monthName = sinceMatch[1];
      const dayNum = sinceMatch[2] ? parseInt(sinceMatch[2]) : 1;
      const startDateGuess = new Date(`${monthName} ${dayNum}, ${now.getFullYear()}`);
      if (!isNaN(startDateGuess)) {
        daysBack = Math.floor((now - startDateGuess) / (1000 * 60 * 60 * 24));
      }
    }

    if (daysBack > 120) daysBack = 120;

    const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const from = fmtDateTime(startDate);
    const to = fmtDateTime(now);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${apiKey}&name=${loggerId}&from=${from}&to=${to}`;
    console.log("[IrriMAX URL]:", url);

    const r = await fetch(url);
    const csvText = await r.text();

    if (!csvText.includes("Date Time")) throw new Error("Invalid CSV from IrriMAX API");

    const { headers, data } = parseCSV(csvText);
    console.log(`[CSV parsed] ${data.length} rows`);

    // ---------------- DATA PROCESSING ----------------
    const depthMap = [2, 6, 10, 14, 18, 22, 26, 30, 33, 37, 41, 45];
    const latest = data[data.length - 1];
    const latestDate = new Date(latest["Date Time"]);

    const temps = headers
      .filter(h => h.startsWith("T"))
      .map((h, i) => ({
        header: h,
        depth: depthMap[i] || (i * 4 + 2)
      }));

    const moistures = headers
      .filter(h => h.startsWith("A"))
      .map((h, i) => ({
        header: h,
        depth: depthMap[i] || (i * 4 + 2)
      }));

    // --- User asked for a specific time/date? ---
    const userDateTime = parseUserDateTime(msg);
    const depthMatch = msg.match(/(\d+)\s*(?:in|inch|inches|")/i);
    const focusDepth = depthMatch ? parseInt(depthMatch[1]) : null;
    console.log("[Focus Depth]:", focusDepth, " [User date/time]:", userDateTime);

    if (userDateTime && focusDepth) {
      // Find closest reading
      let closestRow = null;
      let closestDiff = Infinity;

      for (const row of data) {
        const dt = new Date(row["Date Time"]);
        const diff = Math.abs(dt - userDateTime);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestRow = row;
        }
      }

      if (closestRow && closestDiff < 2 * 60 * 60 * 1000) {
        const tHeader = temps.find(t => t.depth === focusDepth)?.header;
        const mHeader = moistures.find(m => m.depth === focusDepth)?.header;
        const tVal = toF(parseFloat(closestRow[tHeader] || "0")).toFixed(1);
        const mVal = parseFloat(closestRow[mHeader] || "0").toFixed(1);
        const dtFormatted = new Date(closestRow["Date Time"]).toLocaleString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        });

        return {
          statusCode: 200,
          body: JSON.stringify({
            response: `At ${dtFormatted}, the soil at ${focusDepth}" was ${tVal}°F and ${mVal}% moisture.`
          })
        };
      }
    }

    // --- If not a precise time request, fall back to GPT ---
    const summary = depthMap.map((d, i) => {
      const tHeader = temps[i]?.header;
      const mHeader = moistures[i]?.header;
      if (!tHeader || !mHeader) return "";
      const tVals = data.map(r => parseFloat(r[tHeader] || "0"));
      const mVals = data.map(r => parseFloat(r[mHeader] || "0"));
      if (!tVals.length || !mVals.length) return "";
      const lastT = toF(tVals[tVals.length - 1]).toFixed(1);
      const lastM = mVals[mVals.length - 1].toFixed(1);
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

    const prompt = `
You are Acre Insights' soil data assistant.
Here is real probe data from the past ${daysBack} days, ending ${formattedDate}.

Data summary (depths in inches):
${summary}

User message:
"${message}"

Use this data to answer clearly and naturally.
If the user asks for a date/time (like "on Sept 15 at 9pm"), use the closest reading within ±1h.
If they ask for trends or patterns, analyze changes.
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
