// netlify/functions/chat.js
const fetch = require("node-fetch");

/* ===========================
   OpenAI helpers
=========================== */
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

/* ===========================
   Date helpers (IrriMAX)
=========================== */
function toIrrimax14(d) {
  const pad = n => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Accept 14-digit, 8-digit, or free-form → always return 14-digit
function normalizeIrrimax(s, isEnd = false) {
  if (typeof s !== "string" || !s.trim()) return null;
  const clean = s.replace(/\D/g, "");
  if (/^\d{14}$/.test(clean)) return clean;
  if (/^\d{8}$/.test(clean)) return isEnd ? `${clean}235959` : `${clean}000000`;
  const d = new Date(s);
  if (!isNaN(d)) {
    if (isEnd) d.setHours(23, 59, 59, 0);
    else d.setHours(0, 0, 0, 0);
    return toIrrimax14(d);
  }
  return null;
}

function monthRanges(startDate, endDate) {
  const result = [];
  const d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (d <= end) {
    const mStart = new Date(d);
    const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    result.push([mStart, mEnd]);
    d.setMonth(d.getMonth() + 1);
  }
  return result;
}

function ymd(date) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/* ===========================
   Aliases
=========================== */
function loadAliases() {
  try {
    const raw = process.env.LOGGER_ALIASES || "{}";
    const obj = JSON.parse(raw);
    const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const map = {};
    Object.keys(obj).forEach(k => { map[norm(k)] = obj[k]; });
    return { map, norm };
  } catch {
    const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return { map: {}, norm };
  }
}
const { map: LOGGER_MAP, norm: normKey } = loadAliases();

function resolveLoggerId({ alias, loggerId, text }) {
  if (loggerId && String(loggerId).trim()) return String(loggerId).trim();
  if (alias && LOGGER_MAP[normKey(alias)]) return LOGGER_MAP[normKey(alias)];
  if (text) {
    const t = text.toLowerCase();
    const best = Object.keys(LOGGER_MAP).sort((a,b) => b.length - a.length).find(k => t.includes(k));
    if (best) return LOGGER_MAP[best];
  }
  return null;
}

/* ===========================
   CSV → Daily rollup with extrema
=========================== */
function dailyRollupWithExtrema(csv) {
  const lines = (csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) return { header: null, daily: {} };

  const hdr = lines[0].split(",");
  const daily = {}; // date -> { count, cols: { idx: { sum, min, minTs, max, maxTs } } }

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    const ts = row[0]; if (!ts) continue;
    const date = ts.split(" ")[0];
    if (!daily[date]) daily[date] = { count: 0, cols: {} };
    daily[date].count++;

    for (let c = 1; c < hdr.length; c++) {
      const v = parseFloat(row[c]);
      if (Number.isNaN(v)) continue;
      const col = (daily[date].cols[c] ||= { sum: 0, min: +Infinity, minTs: null, max: -Infinity, maxTs: null });
      col.sum += v;
      if (v < col.min) { col.min = v; col.minTs = ts; }
      if (v > col.max) { col.max = v; col.maxTs = ts; }
    }
  }

  const out = {};
  for (const d of Object.keys(daily)) {
    out[d] = {};
    const cnt = daily[d].count;
    for (const c of Object.keys(daily[d].cols)) {
      const idx = Number(c);
      const name = hdr[idx];
      const col = daily[d].cols[c];
      out[d][name] = {
        avg: +(col.sum / cnt).toFixed(3),
        min: col.min === +Infinity ? null : +col.min.toFixed(3),
        minTs: col.minTs,
        max: col.max === -Infinity ? null : +col.max.toFixed(3),
        maxTs: col.maxTs
      };
    }
  }
  return { header: hdr, daily: out };
}

/* ===========================
   IrriMAX fetch
=========================== */
async function fetchCSV(loggerId, start14, end14, key) {
  const url =
    `https://www.irrimaxlive.com/api/?cmd=getreadings` +
    `&key=${encodeURIComponent(key)}` +
    `&name=${encodeURIComponent(loggerId)}` +
    `&from=${start14}&to=${end14}&type=csv`;
  console.log("[IrriMAX URL]:", url.replace(key, "***"));
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return await res.text();
}

/* ===========================
   Tool: single-logger (quick window)
=========================== */
async function getProbeData(args = {}, userText = "") {
  const key = process.env.PROBE_API_KEY;
  if (!key) return { error: "Missing PROBE_API_KEY" };

  const loggerId = resolveLoggerId({ alias: args.alias, loggerId: args.loggerId, text: userText }) || "25x4gcityw";

  // Default: last 48h unless explicit dates provided
  const now = new Date();
  let start14 = normalizeIrrimax(args.start, false);
  let end14   = normalizeIrrimax(args.end,   true);
  if (!start14 || !end14) {
    const back = new Date(now.getTime() - 48*3600*1000);
    start14 = toIrrimax14(back);
    end14   = toIrrimax14(now);
  }

  const csv = await fetchCSV(loggerId, start14, end14, key);
  const lines = (csv || "").trim().split(/\r?\n/);
  console.log("[CSV parsed]", Math.max(0, lines.length - 1), "rows");
  if (lines.length < 2) {
    return { loggerId, window: { start: start14, end: end14 }, error: "No data in window" };
  }

  const header = lines[0].split(",");
  const last = lines[lines.length - 1].split(",");
  const idx = names => names.map(n => header.indexOf(n)).find(i => i !== -1) ?? -1;
  const timeIdx = idx(["DateTime","Timestamp","Date"]);
  const t6Idx   = idx(["T-6in_F","T6_F","T_6in_F","Temp6_F","T6(in)_F","Temp_6in_F"]);
  const battIdx = idx(["Battery_V","Batt_V","Voltage","BatteryV"]);
  const num = i => (i >= 0 && last[i] != null ? Number(last[i]) : null);
  const str = i => (i >= 0 && last[i] != null ? String(last[i]) : null);

  return {
    loggerId,
    window: { start: start14, end: end14 },
    latest: {
      timestamp: str(timeIdx),
      temp6F: num(t6Idx),
      voltage: num(battIdx)
    }
  };
}

/* ===========================
   Tool: multi-logger season summary (no caching)
   - monthly chunking
   - daily avg/min/max with timestamps
=========================== */
async function getMultiProbeSummary(args = {}, userText = "") {
  const key = process.env.PROBE_API_KEY;
  if (!key) return { error: "Missing PROBE_API_KEY" };

  // Collect logger IDs
  const ids = new Set();
  (args.loggerIds || []).forEach(id => { if (id && String(id).trim()) ids.add(String(id).trim()); });
  (args.aliases || []).forEach(a => {
    const id = LOGGER_MAP[normKey(a)];
    if (id) ids.add(id);
  });
  if (!ids.size) {
    // Try detect from user text if none provided
    const t = (userText || "").toLowerCase();
    Object.keys(LOGGER_MAP).forEach(k => { if (t.includes(k)) ids.add(LOGGER_MAP[k]); });
  }
  if (!ids.size) return { error: "No logger specified" };

  // Window: default = last 6 months unless start/end provided
  const now = new Date();
  let start14 = normalizeIrrimax(args.start, false);
  let end14   = normalizeIrrimax(args.end,   true);
  if (!start14 || !end14) {
    const six = new Date(now); six.setMonth(now.getMonth() - 6);
    start14 = toIrrimax14(six);
    end14   = toIrrimax14(now);
  }

  const S = new Date(
    +start14.slice(0,4), +start14.slice(4,6)-1, +start14.slice(6,8),
    +start14.slice(8,10), +start14.slice(10,12), +start14.slice(12,14)
  );
  const E = new Date(
    +end14.slice(0,4), +end14.slice(4,6)-1, +end14.slice(6,8),
    +end14.slice(8,10), +end14.slice(10,12), +end14.slice(12,14)
  );

  const months = monthRanges(S, E);

  const perLoggerDaily = {}; // loggerId -> { header, daily }
  for (const lid of ids) {
    let merged = { header: null, daily: {} };

    for (const [mStart, mEnd] of months) {
      const mS = toIrrimax14(new Date(mStart));
      const mE = toIrrimax14(new Date(mEnd));
      const csv = await fetchCSV(lid, mS, mE, key);
      const rolled = dailyRollupWithExtrema(csv);
      if (!merged.header && rolled.header) merged.header = rolled.header;
      Object.assign(merged.daily, rolled.daily);
    }

    // Clip to requested window (day-granularity)
    const clipped = {};
    const startDay = ymd(S);
    const endDay = ymd(E);
    Object.keys(merged.daily).forEach(d => {
      if (d >= startDay && d <= endDay) clipped[d] = merged.daily[d];
    });
    perLoggerDaily[lid] = { header: merged.header, daily: clipped };
  }

  // Highlights example: max daily 6" temp (with timestamp)
  const CAND_T6 = ["T-6in_F","T6_F","T_6in_F","Temp6_F","T6(in)_F","Temp_6in_F"];
  const highlights = [];
  for (const lid of ids) {
    const entry = perLoggerDaily[lid];
    if (!entry || !entry.header) continue;
    const t6name = CAND_T6.find(n => entry.header.includes(n));
    if (!t6name) continue;
    let best = { value: -Infinity, date: null, ts: null };
    for (const d of Object.keys(entry.daily)) {
      const cell = entry.daily[d][t6name];
      if (cell && typeof cell.max === "number" && cell.max > best.value) {
        best = { value: cell.max, date: d, ts: cell.maxTs };
      }
    }
    if (best.date) highlights.push({ loggerId: lid, metric: "max_T6F", value: best.value, date: best.date, when: best.ts });
  }

  return {
    window: { start: start14, end: end14 },
    loggers: Array.from(ids),
    highlights,
    perLoggerDaily
  };
}

/* ===========================
   MAIN HANDLER
=========================== */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
    }
  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
  }
  if (!process.env.ASSISTANT_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing ASSISTANT_ID" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const message = typeof body.message === "string" ? body.message.trim() : "";
  let thread_id = body.threadId || null;

  if (!message) return { statusCode: 400, body: JSON.stringify({ error: "Empty message" }) };
  console.log("[User message]:", message);

  const openaiBase = "https://api.openai.com/v1";

  // 1) thread
  if (!thread_id) {
    const tRes = await fetch(`${openaiBase}/threads`, { method: "POST", headers: openaiHeaders() });
    const tJson = await tRes.json();
    thread_id = tJson.id;
  }

  // 2) add message
  const mRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({ role: "user", content: message }),
  });
  if (!mRes.ok) {
    const details = await safeJson(mRes);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to add message", details }) };
  }

  // 3) start run
  let runRes = await fetch(`${openaiBase}/threads/${thread_id}/runs`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
  });
  if (!runRes.ok) {
    const details = await safeJson(runRes);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to start run", details }) };
  }
  let run = await runRes.json();

  // ---- bounded polling ----
  const MAX_POLL_MS = 12000;
  const POLL_EVERY_MS = 600;
  const t0 = Date.now();

  while (!["completed", "failed", "cancelled", "expired"].includes(run.status)) {
    if (run.status === "requires_action") {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
      const outputs = [];

      for (const c of calls) {
        const fname = c.function?.name;
        const args = JSON.parse(c.function?.arguments || "{}");
        console.log("[tool-call]", fname, "args:", args);

        if (fname === "get_probe_data") {
          const data = await getProbeData(args, message);
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });

        } else if (fname === "get_multi_probe_summary") {
          const data = await getMultiProbeSummary(args, message);
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });

        } else if (fname === "get_weather_data") {
          // call your deployed weather function
          const weatherRes = await fetch(`https://soildataai.netlify.app/.netlify/functions/weather`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args)
          });
          if (!weatherRes.ok) {
            outputs.push({
              tool_call_id: c.id,
              output: JSON.stringify({ error: "Weather API failed", details: await weatherRes.text() })
            });
          } else {
            outputs.push({
              tool_call_id: c.id,
              output: JSON.stringify(await weatherRes.json())
            });
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
      await new Promise(r => setTimeout(r, POLL_EVERY_MS));
      const pollRes = await fetch(`${openaiBase}/threads/${thread_id}/runs/${run.id}`, {
        headers: openaiHeaders(),
      });
      run = await pollRes.json();
    }

    if (Date.now() - t0 > MAX_POLL_MS) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          threadId: thread_id,
          response: "Still working on that… try again in a moment.",
          runStatus: run.status
        })
      };
    }
  }

  // 4) final message
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