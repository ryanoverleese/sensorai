// netlify/functions/chat.js
const fetch = require('node-fetch');

// Helper: safe JSON parsing
async function safeJson(res) {
  try {
    return await res.json();
  } catch (err) {
    return { error: 'Invalid JSON', details: err.message };
  }
}

// Helper: standard headers for OpenAI API
function openaiHeaders() {
  return {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2' // 👈 Required for the new Assistants API
  };
}

// ---- Tool Function ----
async function getProbeData(args) {
  const { loggerId, start, end } = args;
  const base = process.env.PROBE_API_BASE;
  const key = process.env.PROBE_API_KEY;

  if (!base || !key) {
    console.error('[tool:get_probe_data] Missing PROBE_API_BASE or PROBE_API_KEY');
    return { error: 'Missing API credentials' };
  }

  const url = `${base}/api/v1/loggers/${loggerId}?start=${start || ''}&end=${end || ''}`;
  console.log('[tool:get_probe_data] URL:', url);

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${key}` }
  });

  if (!res.ok) {
    const details = await safeJson(res);
    console.error('[tool:get_probe_data] FAILED:', res.status, details);
    return { error: `Failed to fetch probe data`, status: res.status, details };
  }

  const data = await res.json();
  console.log('[tool:get_probe_data] success');
  return data;
}

// ---- Main Handler ----
exports.handler = async (event) => {
  console.log('--- chat function invoked ---');

  const { message, threadId } = JSON.parse(event.body || '{}');
  console.log('Incoming body:', { message, threadId });

  const openaiBase = 'https://api.openai.com/v1';
  let thread_id = threadId;

  // 1) Create a new thread if needed
  if (!thread_id) {
    console.log('[threads] creating...');
    const tRes = await fetch(`${openaiBase}/threads`, {
      method: 'POST',
      headers: openaiHeaders()
    });
    const tJson = await tRes.json();
    thread_id = tJson.id;
    console.log('[threads] created id:', thread_id);
  }

  // 2) Add user message
  console.log('[messages] add user message');
  const mRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    method: 'POST',
    headers: openaiHeaders(),
    body: JSON.stringify({
      role: 'user',
      content: message
    })
  });

  if (!mRes.ok) {
    const details = await safeJson(mRes);
    console.error('[messages] add FAILED:', mRes.status, details);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to add message', details })
    };
  }

  // 3) Start a run
  console.log('[runs] starting with assistant_id:', process.env.ASSISTANT_ID);
  let runRes = await fetch(`${openaiBase}/threads/${thread_id}/runs`, {
    method: 'POST',
    headers: openaiHeaders(),
    body: JSON.stringify({
      assistant_id: process.env.ASSISTANT_ID
    })
  });

  let run = await runRes.json();
  console.log('[runs] started id:', run.id, 'status:', run.status);

  // ---- Handle tool calls ----
  while (run.status === 'requires_action') {
    const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
    console.log('[runs] requires_action with', calls.length, 'tool calls');

    const outputs = [];
    for (const c of calls) {
      console.log('[tool-call] name:', c.function?.name, 'id:', c.id);
      if (c.function?.name === 'get_probe_data') {
        const args = JSON.parse(c.function.arguments || '{}');
        console.log('[tool-call] args:', args);
        const data = await getProbeData(args);
        outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });
      } else {
        outputs.push({ tool_call_id: c.id, output: JSON.stringify({ error: 'unknown tool' }) });
      }
    }

    const stoRes = await fetch(`${openaiBase}/threads/${thread_id}/runs/${run.id}/submit_tool_outputs`, {
      method: 'POST',
      headers: openaiHeaders(),
      body: JSON.stringify({ tool_outputs: outputs })
    });

    if (!stoRes.ok) {
      const details = await safeJson(stoRes);
      console.error('[runs] submit_tool_outputs FAILED:', stoRes.status, details);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to submit tool outputs', details })
      };
    }

    run = await stoRes.json();
    console.log('[runs] after submit_tool_outputs status:', run.status);
  }

  // ---- Wait until the run completes ----
  while (run.status === 'in_progress' || run.status === 'queued') {
    await new Promise((res) => setTimeout(res, 1000));
    const pollRes = await fetch(`${openaiBase}/threads/${thread_id}/runs/${run.id}`, {
      headers: openaiHeaders()
    });
    run = await pollRes.json();
    console.log('[runs] polling after tool output, status:', run.status);
  }

  // ---- Get final message ----
  const msgRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    headers: openaiHeaders()
  });
  const messages = await msgRes.json();

  const latest = messages?.data?.[0]?.content?.[0]?.text?.value || '(no reply)';
  console.log('[messages] latest text:', latest.slice(0, 200));

  return {
    statusCode: 200,
    body: JSON.stringify({
      threadId: thread_id,
      response: latest
    })
  };
};
