// netlify/functions/chat.js (patched)
// Supports OpenAI Assistants/Agents AND Workflows.
// If ASSISTANT_ID starts with 'wf_', we'll call it as a workflow_id.
// Otherwise we send assistant_id as before.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.ASSISTANT_ID;
const PROBE_API_BASE = process.env.PROBE_API_BASE; // e.g. https://api.acreinsights.com
const PROBE_API_KEY  = process.env.PROBE_API_KEY;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function openaiHeaders() {
  return {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2'
  };
}

async function safeJson(res) {
  const txt = await res.text().catch(() => '');
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function getProbeData(args) {
  const { loggerId, start, end } = args || {};
  if (!loggerId) throw new Error('Missing loggerId');

  const url = `${PROBE_API_BASE}/loggers/${encodeURIComponent(loggerId)}?` +
              `start=${encodeURIComponent(start || '')}&end=${encodeURIComponent(end || '')}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${PROBE_API_KEY}` }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Probe API ${r.status} ${body}`);
  }
  return await r.json();
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders(), body: '' };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing OPENAI_API_KEY or ASSISTANT_ID in env.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const userMessage = body.message;
    let threadId = body.threadId;

    if (!userMessage) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing message' }) };
    }

    // 1) Create thread if needed
    if (!threadId) {
      const tRes = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: openaiHeaders(),
        body: JSON.stringify({})
      });
      if (!tRes.ok) {
        const details = await safeJson(tRes);
        throw new Error(`Failed to create thread: ${tRes.status} ${JSON.stringify(details)}`);
      }
      const t = await tRes.json();
      threadId = t.id;
    }

    // 2) Add user message
    const mRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: 'POST',
      headers: openaiHeaders(),
      body: JSON.stringify({ role: 'user', content: userMessage })
    });
    if (!mRes.ok) {
      const details = await safeJson(mRes);
      throw new Error(`Failed to add message: ${mRes.status} ${JSON.stringify(details)}`);
    }

    // 3) Run the assistant OR workflow
    const runPayload = ASSISTANT_ID.startsWith('wf_')
      ? { workflow_id: ASSISTANT_ID }
      : { assistant_id: ASSISTANT_ID };

    let runRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: 'POST',
      headers: openaiHeaders(),
      body: JSON.stringify(runPayload)
    });
    if (!runRes.ok) {
      const details = await safeJson(runRes);
      throw new Error(`Failed to start run: ${runRes.status} ${JSON.stringify(details)}`);
    }
    let run = await runRes.json();

    // 4) Handle tool calls until complete
    while (run.status === 'requires_action') {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
      const outputs = [];

      for (const c of calls) {
        if (c.function?.name === 'get_probe_data') {
          const args = JSON.parse(c.function.arguments || '{}');
          const data = await getProbeData(args);
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });
        }
      }

      const stoRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
        method: 'POST',
        headers: openaiHeaders(),
        body: JSON.stringify({ tool_outputs: outputs })
      });
      if (!stoRes.ok) {
        const details = await safeJson(stoRes);
        throw new Error(`Failed to submit tool outputs: ${stoRes.status} ${JSON.stringify(details)}`);
      }
      run = await stoRes.json();
    }

    // 5) Poll until complete
    while (run.status === 'in_progress' || run.status === 'queued') {
      await new Promise(r => setTimeout(r, 700));
      const pr = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        headers: openaiHeaders()
      });
      run = await pr.json();
    }

    // 6) Read the latest assistant message
    const msgsRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=1`, {
      headers: openaiHeaders()
    });
    if (!msgsRes.ok) {
      const details = await safeJson(msgsRes);
      throw new Error(`Failed to read messages: ${msgsRes.status} ${JSON.stringify(details)}`);
    }
    const msgs = await msgsRes.json();
    const text = msgs?.data?.[0]?.content?.[0]?.text?.value || '(no reply)';

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, threadId })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};
