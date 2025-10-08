// netlify/functions/chat.js
const fetch = require("node-fetch");

/* -------------------- Helpers -------------------- */

// Safe JSON parse for fetch responses
async function safeJson(res) {
  try {
    return await res.json();
  } catch (err) {
    return { error: "Invalid JSON", details: err.message };
  }
}

// OpenAI headers (Assistants v2)
function openaiHeaders() {
  return {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
  };
}

// Format JS Date (or ISO) -> IrriMAX YYYYMMDDHHmmss
function toIrrimax(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Small natural-language window → {start,end}
function windowFromArgs(args) {
  const now = new Date();
  // default: last 24h (keeps CSV tiny + fast)
  let start = new Date(now.getTime() - 24 * 3600 * 1000);
  let end = now;

  const when =
    (args && (args.when || args.intent || args.freeText || args.range)) || "";

  const p = String(when).toLowerCase();

  if (/current|now|latest/.test(p)) {
    end = now;
    start = new Date(now.getTime() - 6 * 3600 * 1000); // last 6h
  } else if (/yesterday/.test(p)) {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
    end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59);
  } else {
    // day-of-week (most recent)
    const dow = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    for (let i = 0; i < 7; i++) {
      if (p.includes(dow[i])) {
        let d = new Date(now);
        while (d.getDay() !== i) d.setDate(d.getDate() - 1);
        start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
        end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
        break;
      }
    }
  }

  // explicit overrides (if assistant passed start/end already in IrriMAX format, leave them)
  if (args?.start && /^\d{14}$/.test(args.start)) start = args.start;
  if (args?.end && /^\d{14}$/.test(args.end)) end = args.end;

  return {
    start: typeof start === "string" ? start : toIrrimax(start),
    end: typeof end === "string" ? end : toIrrimax(end),
  };
}

/* -------------------- Tools -------------------- */

// Sentek / IrriMAX probe fetch → small summary
async function getProbeData(args) {
  const key = process.env.PROBE_API_KEY;
  if (!key) {
    console.error("[tool:get_probe_data] Missing PROBE_API_KEY");
    return { error: "Missing API credentials" };
  }

  // Claude is already routing the right logger; keep a fallback just in case
  const loggerId = (args?.loggerId || "25x4gcityw").trim();

  // Build a small time window (fast & under size limits)
  const { start, end } = windowFromArgs(args || {});
  const url =
    `https://www.irrimaxlive.com/api/?cmd=getreadings` +
    `&key=${encodeURIComponent(key)}` +
    `&name=${encodeURIComponent(loggerId)}` +
    `&from=${start}&to=${end}&type=csv`;

  console.log("[tool:get_probe_data] URL:", url.replace(key, "***"));

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    console.error("[tool:get_probe_data] FAILED:", res.status, text);
    return { error: "Failed to fetch probe data", status: res.status, details: text };
  }

  const csv = await res.text();
  const lines = (csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) {
    return {
      loggerId,
      window: { start, end },
      error: "No data in time window",
    };
  }

  const header = lines[0].split(",");
  const last = lines[lines.length - 1].split(",");

  // Map a few common columns (keep payload tiny)
  const idx = (names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const timeIdx =
    idx(["DateTime", "Timestamp", "Date"]) !== -1
      ? idx(["DateTime", "Timestamp", "Date"])
      : 0;

  const temp6Idx = idx([
    "T-6in_F",
    "T6_F",
    "T_6in_F",
    "Temp6_F",
    "T6(in)_F",
    "Temp_6in_F",
  ]);
  const battIdx = idx(["Battery_V", "Batt_V", "Voltage", "BatteryV"]);

  const valNum = (i) => (i >= 0 && last[i] !== undefined ? Number(last[i]) : null);
  const valStr = (i) => (i >= 0 && last[i] !== undefined ? String(last[i]) : null);

  const summary = {
    loggerId,
    window: { start, end },
    latest: {
      timestamp: valStr(timeIdx),
      temp6F: valNum(temp6Idx),
      voltage: valNum(battIdx),
    },
  };

  // Keep it compact; let the assistant compute trends from this small payload
  return summary;
}

/* -------------------- Main handler -------------------- */

exports.handler = async (event) => {
  console.log("--- chat function invoked ---");

  // 1) Only allow POST (bots often GET the URL)
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // 2) Parse body and guard empty inputs (stops “Missing content” spam)
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {}
  const message = typeof body.message === "string" ? body.message.trim() : "";
  let thread_id = body.threadId || null;

  if (!message) {
    // return 204 (No Content) so crawlers don’t generate errors in logs
    return { statusCode: 204, body: "" };
  }

  const openaiBase = "https://api.openai.com/v1";

  // 3) Create thread if needed
  if (!thread_id) {
    console.log("[threads] creating...");
    const tRes = await fetch(`${openaiBase}/threads`, {
      method: "POST",
      headers: openaiHeaders(),
    });
    const tJson = await tRes.json();
    thread_id = tJson.id;
    console.log("[threads] created id:", thread_id);
  }

  // 4) Add user message
  console.log("[messages] add user message");
  const mRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({ role: "user", content: message }),
  });
  if (!mRes.ok) {
    const details = await safeJson(mRes);
    console.error("[messages] add FAILED:", mRes.status, details);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to add message", details }) };
  }

  // 5) Start run
  console.log("[runs] starting with assistant_id:", process.env.ASSISTANT_ID);
  let runRes = await fetch(`${openaiBase}/threads/${thread_id}/runs`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
  });
  let run = await runRes.json();
  console.log("[runs] started id:", run.id, "status:", run.status);

  // 6) Poll (cap to avoid Netlify timeout) and handle tool calls
  const MAX_POLL_MS = 8000;
  const POLL_EVERY_MS = 600;
  const t0 = Date.now();

  while (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "cancelled" &&
    run.status !== "expired"
  ) {
    if (run.status === "requires_action") {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
      console.log("[runs] requires_action with", calls.length, "tool calls");

      const outputs = [];
      for (const c of calls) {
        const fname = c.function?.name;
        console.log("[tool-call] name:", fname, "id:", c.id);

        if (fname === "get_probe_data") {
          const args = JSON.parse(c.function.arguments || "{}");
          const data = await getProbeData(args);
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });
        } else if (fname === "get_weather_data") {
          // Call your Netlify weather function with GET + query params
          const args = JSON.parse(c.function.arguments || "{}");
          const qs = new URLSearchParams();
          if (args.q) qs.set("q", args.q);
          if (args.zip) qs.set("zip", args.zip);
          if (args.lat) qs.set("lat", String(args.lat));
          if (args.lon) qs.set("lon", String(args.lon));
          if (args.tz) qs.set("tz", String(args.tz));

          const url = `https://soildataai.netlify.app/.netlify/functions/weather${qs.toString() ? "?" + qs.toString() : ""}`;
          console.log("[tool-call] weather URL:", url);
          const wRes = await fetch(url);
          if (!wRes.ok) {
            const txt = await wRes.text();
            console.error("[tool-call] weather failed:", wRes.status, txt);
            outputs.push({ tool_call_id: c.id, output: JSON.stringify({ error: "Weather API failed", details: txt }) });
          } else {
            const wJson = await wRes.json();
            outputs.push({ tool_call_id: c.id, output: JSON.stringify(wJson) });
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
        console.error("[runs] submit_tool_outputs FAILED:", stoRes.status, details);
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to submit tool outputs", details }) };
      }
      run = await stoRes.json();
      continue;
    }

    // queued or in_progress → poll
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    const pollRes = await fetch(`${openaiBase}/threads/${thread_id}/runs/${run.id}`, {
      headers: openaiHeaders(),
    });
    run = await pollRes.json();

    if (Date.now() - t0 > MAX_POLL_MS) {
      // Return a soft response before Netlify times out
      return {
        statusCode: 200,
        body: JSON.stringify({
          threadId: thread_id,
          response: "Still working on that… try asking again in a moment.",
          runStatus: run.status,
        }),
      };
    }
  }

  // 7) Fetch final assistant message
  const msgRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    headers: openaiHeaders(),
  });
  if (!msgRes.ok) {
    const details = await safeJson(msgRes);
    console.error("[messages] fetch FAILED:", msgRes.status, details);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch messages", details }) };
    }
  const messages = await msgRes.json();
  const latest = messages?.data?.[0]?.content?.[0]?.text?.value || "(no reply)";
  console.log("[messages] latest text:", latest.slice(0, 200));

  if (run.status === "failed") {
    console.error("[runs] failed with error:", run.last_error);
    return { statusCode: 500, body: JSON.stringify({ error: "Assistant run failed", details: run.last_error }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ threadId: thread_id, response: latest, runStatus: run.status }),
  };
};
