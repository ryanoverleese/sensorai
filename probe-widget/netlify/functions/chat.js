// netlify/functions/chat.js
const fetch = require("node-fetch");

/* --------------------------- helpers --------------------------- */
function openaiHeaders() {
  return {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
  };
}

async function safeJson(res) {
  try { return await res.json(); }
  catch (e) { return { error: "Invalid JSON", details: e.message }; }
}

// IrriMAX requires YYYYMMDDHHMMSS
function toIrrimax(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Day key: 'YYYY-MM-DD'
function dayKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Normalize YYYY-MM-DD or YYYY/MM/DD → YYYYMMDD (also accepts already-compact)
function normDayStr(s) {
  return String(s || "").replace(/[^0-9]/g, "").slice(0, 8); // keep first 8 digits
}

// Best-effort parse incoming start/end (YYYYMMDD or YYYY-MM-DD)
function coerceDayRange(args, allDays) {
  // if user didn’t pass any, return nulls (no clip)
  let { startDay, endDay } = args || {};
  if (!startDay && !endDay) return { startDay: null, endDay: null };

  // Support multiple aliases from the assistant (“start”, “end” from older code)
  startDay = startDay || args.start || null;
  endDay = endDay || args.end || null;

  // If they sent timestamps (YYYYMMDDHHMMSS), reduce to YYYYMMDD
  if (startDay && /^\d{14}$/.test(startDay)) startDay = startDay.slice(0, 8);
  if (endDay && /^\d{14}$/.test(endDay)) endDay = endDay.slice(0, 8);

  // Normalize
  const sNorm = startDay ? normDayStr(startDay) : null;
  const eNorm = endDay ? normDayStr(endDay) : null;

  // Fallback: if only a single month like '2025-08' is passed
  if (!sNorm && !eNorm && args.month) {
    const m = String(args.month);
    const mClean = m.replace(/[^0-9]/g, "").slice(0, 6); // YYYYMM
    if (mClean.length === 6) {
      return { startDay: mClean + "01", endDay: mClean + "31" };
    }
  }

  // If we still don’t have anything, try to infer from existing days
  if ((!sNorm || !eNorm) && allDays && allDays.length) {
    const sorted = [...allDays].sort();
    return {
      startDay: sNorm || normDayStr(sorted[0]),
      endDay:   eNorm || normDayStr(sorted[sorted.length - 1]),
    };
  }

  return { startDay: sNorm, endDay: eNorm };
}

/* --------------------- IrriMAX CSV utilities ------------------- */
async function fetchIrrimaxCsv(loggerId, startTs, endTs) {
  const key = process.env.PROBE_API_KEY;
  if (!key) return { error: "Missing PROBE_API_KEY" };

  // default: last 6 months (your design)
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(now.getMonth() - 6);

  const from = startTs || toIrrimax(sixMonthsAgo);
  const to   = endTs   || toIrrimax(now);

  const url =
    `https://www.irrimaxlive.com/api/?cmd=getreadings` +
    `&key=${encodeURIComponent(key)}` +
    `&name=${encodeURIComponent(loggerId)}` +
    `&from=${from}&to=${to}`;

  console.log("[IrriMAX URL]:", url.replace(key, "***"));

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    return { error: "IrriMAX fetch failed", status: res.status, details: txt };
  }
  const csv = await res.text();
  return { csv };
}

function parseCsvToRows(csv) {
  const lines = (csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(",");
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (!parts[0]) continue;
    const ts = new Date(parts[0]); // IrriMAX “DateTime” is parseable
    if (isNaN(ts)) continue;

    const rec = { _ts: ts, _day: dayKey(ts) };
    headers.forEach((h, idx) => (rec[h] = parts[idx]));
    rows.push(rec);
  }
  return { headers, rows };
}

// Build daily map with extrema (min/max) and “last” values per day
function dailyRollupWithExtrema(rows, headers) {
  const dayMap = {}; // { 'YYYY-MM-DD': { count, lastAt, last:{}, min:{}, max:{} } }

  // Identify columns
  const isTemp = (h) => /(^|_)T[\w-]*|Temp/i.test(h) && /F$|_F$|Fahrenheit/i.test(h);
  const isMoist = (h) => /^A[\w-]*|VWC|Moist/i.test(h);
  const isBatt = (h) => /Batt|Battery|Voltage/i.test(h);

  const wanted = headers.filter(
    (h) => isTemp(h) || isMoist(h) || isBatt(h)
  );

  for (const r of rows) {
    const d = r._day;
    if (!dayMap[d]) {
      dayMap[d] = { count: 0, lastAt: 0, last: {}, min: {}, max: {} };
    }
    const bucket = dayMap[d];
    bucket.count++;

    for (const h of wanted) {
      const n = Number(r[h]);
      if (!Number.isFinite(n)) continue;

      if (!(h in bucket.min) || n < bucket.min[h]) bucket.min[h] = n;
      if (!(h in bucket.max) || n > bucket.max[h]) bucket.max[h] = n;
    }

    const at = r._ts.getTime();
    if (at >= bucket.lastAt) {
      bucket.lastAt = at;
      for (const h of wanted) {
        bucket.last[h] = Number.isFinite(Number(r[h])) ? Number(r[h]) : r[h];
      }
    }
  }

  return dayMap; // keys = 'YYYY-MM-DD'
}

// Clip a {day: {...}} map by startDay/endDay (accepts dashed or compact)
// **FIX**: normalize both sides so August/September queries work.
function clipDailyMap(dailyMap, startDay, endDay) {
  if (!startDay && !endDay) return dailyMap;
  const out = {};
  const sNorm = startDay ? normDayStr(startDay) : null;
  const eNorm = endDay ? normDayStr(endDay) : null;

  Object.keys(dailyMap).forEach((d) => {
    const dNorm = normDayStr(d); // handle 'YYYY-MM-DD' vs 'YYYYMMDD'
    if ((sNorm && dNorm < sNorm) || (eNorm && dNorm > eNorm)) return;
    out[d] = dailyMap[d];
  });
  return out;
}

/* -------------------------- tool impls ------------------------- */
async function tool_getProbeData(args = {}) {
  // Supports single logger id (default your unit)
  const loggerId = (args.loggerId || "25x4gcityw").trim();

  // If the assistant provided absolute timestamps, pass them through.
  // (Otherwise we default to last ~6 months in fetchIrrimaxCsv)
  const fromTs = args.start && /^\d{14}$/.test(args.start) ? args.start : null;
  const toTs   = args.end   && /^\d{14}$/.test(args.end)   ? args.end   : null;

  const fetched = await fetchIrrimaxCsv(loggerId, fromTs, toTs);
  if (fetched.error) return fetched;

  const { headers, rows } = parseCsvToRows(fetched.csv);
  if (!rows.length) {
    return { loggerId, error: "No rows", details: "CSV returned no data" };
  }
  console.log("[CSV parsed]", rows.length, "rows");

  const daily = dailyRollupWithExtrema(rows, headers);

  // Optional clipping by day if the assistant provided a day window.
  const allDays = Object.keys(daily);
  const { startDay, endDay } = coerceDayRange(args, allDays);
  const clipped = clipDailyMap(daily, startDay, endDay);

  // Build compact payload (safe for tool output size)
  return {
    loggerId,
    dayRange: { startDay, endDay },
    days: clipped, // { 'YYYY-MM-DD': { count, last:{}, min:{}, max:{} } }
    columnsNote: "min/max apply per day; last = most recent reading that day",
  };
}

/* --------------------------- main ------------------------------ */
exports.handler = async (event) => {
  // POST only
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Parse body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const message = typeof body.message === "string" ? body.message.trim() : "";
  let thread_id = body.threadId || null;

  // Ignore empty pings
  if (!message) return { statusCode: 204, body: "" };
  console.log("[User message]:", message);

  const openaiBase = "https://api.openai.com/v1";

  // 1) Create thread if needed
  if (!thread_id) {
    const tRes = await fetch(`${openaiBase}/threads`, {
      method: "POST",
      headers: openaiHeaders(),
    });
    const tJson = await tRes.json();
    thread_id = tJson.id;
  }

  // 2) Add user message
  const mRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({ role: "user", content: message }),
  });
  if (!mRes.ok) {
    const details = await safeJson(mRes);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to add message", details }) };
  }

  // 3) Start run
  let runRes = await fetch(`${openaiBase}/threads/${thread_id}/runs`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
  });
  let run = await runRes.json();

  // 4) Bounded loop (Netlify 10s-ish budget here)
  const MAX_POLL_MS = 9000;
  const POLL_MS = 600;
  const started = Date.now();

  while (!["completed", "failed", "cancelled", "expired"].includes(run.status)) {
    if (run.status === "requires_action") {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
      const outputs = [];

      for (const c of calls) {
        const fname = c.function?.name;
        const args = JSON.parse(c.function?.arguments || "{}");

        if (fname === "get_probe_data") {
          const data = await tool_getProbeData(args);
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });
        } else if (fname === "get_weather_data") {
          // hand off to your Netlify weather function
          const wr = await fetch(`https://soildataai.netlify.app/.netlify/functions/weather`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
          });
          if (!wr.ok) {
            outputs.push({ tool_call_id: c.id, output: JSON.stringify({ error: "Weather API failed", details: await wr.text() }) });
          } else {
            outputs.push({ tool_call_id: c.id, output: JSON.stringify(await wr.json()) });
          }
        } else {
          outputs.push({ tool_call_id: c.id, output: JSON.stringify({ error: "unknown tool" }) });
        }
      }

      const stoRes = await fetch(
        `${openaiBase}/threads/${thread_id}/runs/${run.id}/submit_tool_outputs`,
        { method: "POST", headers: openaiHeaders(), body: JSON.stringify({ tool_outputs: outputs }) }
      );
      if (!stoRes.ok) {
        const details = await safeJson(stoRes);
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to submit tool outputs", details }) };
      }
      run = await stoRes.json();
    } else {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const pollRes = await fetch(`${openaiBase}/threads/${thread_id}/runs/${run.id}`, {
        headers: openaiHeaders(),
      });
      run = await pollRes.json();
    }

    if (Date.now() - started > MAX_POLL_MS) {
      // Tell the UI to ping again (keeps the widget responsive)
      return {
        statusCode: 200,
        body: JSON.stringify({
          threadId: thread_id,
          response: "Still working on that… try again in a moment.",
          runStatus: run.status,
        }),
      };
    }
  }

  // 5) Final assistant message
  const msgRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    headers: openaiHeaders(),
  });
  if (!msgRes.ok) {
    const details = await safeJson(msgRes);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch messages", details }) };
  }
  const messages = await msgRes.json();
  const latest = messages?.data?.[0]?.content?.[0]?.text?.value || "(no reply)";

  if (run.status === "failed") {
    return { statusCode: 500, body: JSON.stringify({ error: "Assistant run failed", details: run.last_error }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ threadId: thread_id, response: latest, runStatus: run.status }),
  };
};