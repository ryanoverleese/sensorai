// netlify/functions/chat.js
// Netlify Function (Node 18+) that bridges your site to OpenAI Assistants API
// and proxies tool calls to your Probe API. No client-side keys!

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

async function getProbeData(args) {
  const { loggerId, start, end } = args || {};
  if (!loggerId) throw new Error('Missing loggerId');

  const url = `${PROBE_API_BASE}/loggers/${encodeURIComponent(loggerId)}?` +
              `start=${encodeURIComponent(start || '')}&end=${encodeURIComponent(end || '')}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${PROBE_API_KEY}` }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Probe API ${r.status} ${txt}`);
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

    const { message, threadId } = JSON.parse(event.body || '{}');
    if (!message) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing message' }) };
    }

    // 1) Create thread if needed
    let thread_id = threadId;
    if (!thread_id) {
      const t = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: openaiHeaders(),
        body: JSON.stringify({})
      }).then(r => r.json());
      if (!t?.id) throw new Error('Failed to create thread');
      thread_id = t.id;
    }

    // 2) Add user message
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: 'POST',
      headers: openaiHeaders(),
      body: JSON.stringify({ role: 'user', content: message })
    });

    // 3) Run the assistant
    let run = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: 'POST',
      headers: openaiHeaders(),
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    }).then(r => r.json());

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

      run = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs/${run.id}/submit_tool_outputs`, {
        method: 'POST',
        headers: openaiHeaders(),
        body: JSON.stringify({ tool_outputs: outputs })
      }).then(r => r.json());
    }

    // 5) Poll until complete
    while (run.status === 'in_progress' || run.status === 'queued') {
      await new Promise(r => setTimeout(r, 700));
      run = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs/${run.id}`, {
        headers: openaiHeaders()
      }).then(r => r.json());
    }

    // 6) Read the latest assistant message
    const msgs = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages?order=desc&limit=1`, {
      headers: openaiHeaders()
    }).then(r => r.json());

    const text = msgs?.data?.[0]?.content?.[0]?.text?.value || '(no reply)';
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, threadId: thread_id })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};
