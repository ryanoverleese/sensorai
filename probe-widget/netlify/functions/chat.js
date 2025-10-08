// netlify/functions/chat.js
const fetch = require("node-fetch");

// ---------- helpers ----------
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

// format Date -> YYYYMMDDHHMMSS for IrriMAX
function toIrrimax(d) {
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

// ---------- FAST probe tool (latest-only) ----------
async function getProbeData(args = {}) {
  const key = process.env.PROBE_API_KEY;
  if (!key) return { error: "Missing PROBE_API_KEY" };

  const loggerId = (args.loggerId || "25x4gcityw").trim();

  // small default window (last 6h) to keep files tiny
  const now = new Date();
  const start = args.start && /^\d{14}$/.test(args.start)
    ? args.start
    : toIrrimax(new Date(now.getTime() - 6 * 3600 * 1000));
  const end = args.end && /^\d{14}$/.test(args.end)
    ? args.end
    : toIrrimax(now);

  const url =
    `https://www.irrimaxlive.com/api/?cmd=getreadings` +
    `&key=${encodeURIComponent(key)}` +
    `&name=${encodeURIComponent(loggerId)}` +
    `&from=${start}&to=${end}&type=csv`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    return { error: "Failed to fetch probe data", status: res.status, details: txt };
  }

  const csv = await res.text();
  const lines = (csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { loggerId, window: { start, end }, error: "No data in time window" };
  }

  const header = lines[0].split(",");
  const last = lines[lines.length - 1].split(",");

  const idx = names => names.map(n => header.indexOf(n)).find(i => i !== -1) ?? -1;
  const timeIdx = idx(["DateTime", "Timestamp", "Date"]);
  const temp6Idx = idx(["T-6in_F","T6_F","T_6in_F","Temp6_F","T6(in)_F","Temp_6in_F"]);
  const battIdx = idx(["Battery_V","Batt_V","Voltage","BatteryV"]);

  const num = i => (i >= 0 && last[i] != null ? Number(last[i]) : null);
  const str = i => (i >= 0 && last[i] != null ? String(last[i]) : null);

  return {
    loggerId,
    window: { start, end },
    latest: {
      timestamp: str(timeIdx),
      temp6F: num(temp6Idx),
      voltage: num(battIdx)
    }
  };
}

// ---------- main handler ----------
exports.handler = async (event) => {
  // only POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const message = typeof body.message === "string" ? body.message.trim() : "";
  let thread_id = body.threadId || null;

  // ignore bot/empty pings
  if (!message) return { statusCode: 204, body: "" };

  const openaiBase = "https://api.openai.com/v1";

  // 1) thread
  if (!thread_id) {
    const tRes = await fetch(`${openaiBase}/threads`, {
      method: "POST",
      headers: openaiHeaders(),
    });
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
  let run = await runRes.json();

  // ---- bounded polling loop (avoid 60s Netlify kill) ----
  const MAX_POLL_MS = 9000;
  const POLL_EVERY_MS = 600;
  const t0 = Date.now();

  while (!["completed", "failed", "cancelled", "expired"].includes(run.status)) {
    if (run.status === "requires_action") {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
      const outputs = [];

      for (const c of calls) {
        const fname = c.function?.name;
        const args = JSON.parse(c.function?.arguments || "{}");

        if (fname === "get_probe_data") {
          const data = await getProbeData(args);
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });
        } else if (fname === "get_weather_data") {
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
      // queued / in_progress
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