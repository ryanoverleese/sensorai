// netlify/functions/chat.js
const fetch = require("node-fetch");

// -----------------------------
// CONFIGURATION
// -----------------------------
const API_KEY = process.env.PROBE_API_KEY;               // your IrriMAX key
const BASE = process.env.PROBE_API_BASE || "https://www.irrimaxlive.com/api/";
const LOGGER = "25x4gcityw";                       // replace with your logger name
const MODEL = "gpt-4o-mini";                             // OpenAI model

// -----------------------------
// HELPERS
// -----------------------------

function ok(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function err(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function toIrrimaxTimestamp(d) {
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

function parseDepthAndDate(message) {
  const depthMatch = message.match(/(\d+)\s*(?:in|inch|")/i);
  const dateMatch = message.match(/(?:on\s*)?([A-Za-z]+\s+\d{1,2})/i);
  const depth = depthMatch ? parseInt(depthMatch[1]) : null;
  let date = null;
  if (dateMatch) {
    const thisYear = new Date().getFullYear();
    date = new Date(`${dateMatch[1]}, ${thisYear}`);
  }
  return { depth, date };
}

// -----------------------------
// IRRIMAX DATA FETCHERS
// -----------------------------

async function getLatestSoilData() {
  const url = `${BASE}?cmd=getlast&key=${API_KEY}&name=${LOGGER}&pane=0`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IrriMAX ${r.status}`);
  const txt = await r.text();
  console.log("IRRIMAX RAW RESPONSE:", txt);
  const parts = txt.split(",");
  const lastValue = parts[0];
  const unit = parts[4] || "";
  const timestamp = parts[5] || "";
  return { value: parseFloat(lastValue), unit, timestamp };
}

async function getSoilDataForDateAndPane(dateObj, paneNo = 0) {
  const start = new Date(dateObj);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 0);

  const from = toIrrimaxTimestamp(start);
  const to = toIrrimaxTimestamp(end);

  const url = `${BASE}?cmd=getgraphvalues&key=${API_KEY}&name=${LOGGER}&pane=${paneNo}&from=${from}&to=${to}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IrriMAX ${r.status}`);
  const csv = await r.text();
  const lines = csv.trim().split("\n");
  if (lines.length < 2) throw new Error("No data found for that day/pane");

  const lastLine = lines[lines.length - 1].split(",");
  const value = parseFloat(lastLine[1]); // adjust index if needed after seeing CSV sample
  const timestamp = lastLine[0];
  return { value, timestamp };
}

// -----------------------------
// OPENAI CALL
// -----------------------------
async function callOpenAI(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

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
          { role: "system", content: "You are an agronomy assistant who interprets soil sensor data and answers clearly, referencing real data when given." },
          { role: "user", content: prompt },
        ],
      }),
    });

    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } 
    catch { throw new Error(`OpenAI returned non-JSON (${r.status}) ${raw.slice(0,200)}`); }
    if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------
// MAIN HANDLER
// -----------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return err(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const msg = body.message || "";

  if (msg === "__ping") return ok({ ok: true, echo: "__pong" });

  try {
    const { depth, date } = parseDepthAndDate(msg);
    let soil;
    let context = "";

    if (depth && date) {
      // e.g. "6 inch" => pane 1, adjust map as needed
      const paneMap = { 4: 0, 6: 1, 8: 2, 12: 3 };
      const pane = paneMap[depth] ?? 0;
      soil = await getSoilDataForDateAndPane(date, pane);
      context = `Soil temp at ${depth}" depth on ${date.toDateString()} was ${soil.value}°F at ${soil.timestamp}.`;
    } 
    else if (/yesterday/i.test(msg)) {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      soil = await getSoilDataForDateAndPane(y, 0);
      context = `Yesterday's soil temp was ${soil.value}°F at ${soil.timestamp}.`;
    } 
    else {
      soil = await getLatestSoilData();
      context = `Current soil temp is ${soil.value}${soil.unit} as of ${soil.timestamp}.`;
    }

    const reply = await callOpenAI(`${context}\nUser asked: ${msg}`);
    return ok({ threadId: null, response: reply, runStatus: "completed" });

  } catch (e) {
    console.error("Chat function error:", e);
    return err(502, { error: "Chat function error", detail: String(e) });
  }
};
