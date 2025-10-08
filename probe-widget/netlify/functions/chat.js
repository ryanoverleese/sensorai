const fetch = require("node-fetch");

// -------------------- CONFIG --------------------
const IRRIMAX_KEY = "72c6113e-02bc-42cb-b106-dc4bec979857";
const LOGGER_NAME = "25x4gcityw";
const MODEL = "gpt-4o-mini";

// -------------------- HELPERS --------------------
const ok = (body) => new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } });
const err = (msg) => new Response(`Error: ${msg}`, { status: 500 });

// convert °C → °F
const toF = (c) => (c * 9) / 5 + 32;

// parse IrriMAX CSV
function parseIrrimaxCSV(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  const results = rows.map((r) => {
    const row = {};
    headers.forEach((h, i) => (row[h] = r[i]));
    return row;
  });
  return results;
}

// format date nicely (e.g. October 8, 2025)
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// find most recent record
function latestRecord(records) {
  if (!records.length) return null;
  return records[records.length - 1];
}

// round to nearest whole inch
const cmToIn = (cm) => Math.round(cm / 2.54);

// -------------------- MAIN HANDLER --------------------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return err("Method not allowed");
    const body = JSON.parse(event.body || "{}");
    const msg = (body.message || "").toLowerCase();

    // handle test ping
    if (msg === "__ping") return ok("pong");

    // detect if question asks for trend
    const isTrend = /\btrend\b/.test(msg) || /\bsince\b/.test(msg) || /\bpast\b/.test(msg);
    const hasRange = /\b\d{4}\b|\bjune|july|august|september|october|week|month|season|day|days\b/.test(msg);

    if (isTrend && !hasRange) {
      return ok("Sure — over what time period? (e.g., past week, since June, last month, etc.)");
    }

    if (isTrend) {
      const { from, to } = getDateRangeFromMessage(msg);
      const trendData = await fetchIrrimaxData(from, to);
      const summary = summarizeForAI(trendData);

      const aiResponse = await callOpenAI(
        `You are a soil data analyst. Analyze the following soil moisture and temperature readings by depth over time. 
         Mention any unusual changes, spikes, or stable periods.
         Data summary:\n${summary}`
      );

      return ok(aiResponse);
    }

    // otherwise, just return current readings
    const csv = await fetchIrrimaxCSV();
    const data = parseIrrimaxCSV(csv);
    const last = latestRecord(data);
    if (!last) return ok("No data found.");

    // format date/time
    const dateTime = formatDate(last["Date Time"]);

    // build clean text output (Temp + Moisture)
    let out = `Soil Conditions — ${dateTime}\n`;
    for (let i = 1; i <= 12; i++) {
      const depthIn = cmToIn(i * 10 - 5);
      const tC = parseFloat(last[`T${i}(5)`]);
      const aVWC = parseFloat(last[`A${i}(5)`]);
      if (!isNaN(tC) && !isNaN(aVWC)) {
        out += `• ${depthIn}" — ${Math.round(toF(tC))}°F, ${aVWC.toFixed(1)}% moisture\n`;
      }
    }

    return ok(out);
  } catch (e) {
    console.error("Chat function error:", e);
    return err(e.message);
  }
};

// -------------------- HELPERS --------------------

// basic date range detection from message
function getDateRangeFromMessage(msg) {
  const now = new Date();
  let from = new Date(now);
  if (msg.includes("week")) from.setDate(now.getDate() - 7);
  else if (msg.includes("month")) from.setMonth(now.getMonth() - 1);
  else if (msg.includes("season") || msg.includes("since june")) from = new Date(now.getFullYear(), 5, 1);
  else if (msg.includes("since july")) from = new Date(now.getFullYear(), 6, 1);
  else if (msg.includes("since august")) from = new Date(now.getFullYear(), 7, 1);
  else if (msg.includes("since september")) from = new Date(now.getFullYear(), 8, 1);
  else if (msg.includes("since october")) from = new Date(now.getFullYear(), 9, 1);
  else from.setDate(now.getDate() - 7);

  const to = now;
  return { from, to };
}

// call IrriMAX API for specific date range
async function fetchIrrimaxData(from, to) {
  const fmt = (d) =>
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0");

  const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${IRRIMAX_KEY}&name=${LOGGER_NAME}&from=${fmt(
    from
  )}&to=${fmt(to)}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`IrriMAX error ${r.status}`);
  const csv = await r.text();
  const data = parseIrrimaxCSV(csv);
  return data;
}

// simplified snapshot for AI input
function summarizeForAI(data) {
  if (!data.length) return "No data available.";
  const points = data.length;
  const first = data[0]["Date Time"];
  const last = data[data.length - 1]["Date Time"];
  let summary = `Readings: ${points} points from ${first} to ${last}\n`;

  for (let i = 1; i <= 12; i++) {
    const depth = cmToIn(i * 10 - 5);
    const temps = data.map((r) => parseFloat(r[`T${i}(5)`])).filter((v) => !isNaN(v));
    const moist = data.map((r) => parseFloat(r[`A${i}(5)`])).filter((v) => !isNaN(v));
    if (temps.length) {
      const minT = Math.min(...temps);
      const maxT = Math.max(...temps);
      summary += `${depth}" Temp: ${Math.round(toF(minT))}-${Math.round(toF(maxT))}°F; `;
    }
    if (moist.length) {
      const minM = Math.min(...moist);
      const maxM = Math.max(...moist);
      summary += `Moisture: ${minM.toFixed(1)}-${maxM.toFixed(1)}%\n`;
    }
  }
  return summary;
}

// simple IrriMAX current CSV fetch
async function fetchIrrimaxCSV() {
  const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${IRRIMAX_KEY}&name=${LOGGER_NAME}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IrriMAX ${r.status}`);
  return await r.text();
}

// call OpenAI for interpretation
async function callOpenAI(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are an experienced agronomist who explains soil data clearly." },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `OpenAI ${r.status}`);
    return data.choices?.[0]?.message?.content?.trim() || "No response.";
  } finally {
    clearTimeout(timeout);
  }
}
