// netlify/functions/chat.js
const fetch = require("node-fetch");

// Helper: safe JSON parsing
async function safeJson(res) {
  try {
    return await res.json();
  } catch (err) {
    return { error: "Invalid JSON", details: err.message };
  }
}

// Helper: standard headers for OpenAI API
function openaiHeaders() {
  return {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2"
  };
}

// ---- Tool Function ----
async function getProbeData(args) {
  // Hardcode the logger ID if not provided
  const loggerId = args.loggerId || "25x4gcityw";
  let { start, end } = args;
  const key = process.env.PROBE_API_KEY;

  if (!key) {
    console.error("[tool:get_probe_data] Missing PROBE_API_KEY");
    return { error: "Missing API credentials" };
  }

  // If no date range specified, get last 7 days to avoid huge datasets
  if (!start && !end) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Format as YYYYMMDDHHMMSS
    start = sevenDaysAgo.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    end = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    console.log("[tool:get_probe_data] Auto date range:", start, "to", end);
  }

  // Build URL with query parameters per Sentek API docs
  let url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${key}&name=${loggerId}`;
  
  // Add date range if provided (format: YYYYMMDDHHMMSS)
  if (start) {
    url += `&from=${start}`;
  }
  if (end) {
    url += `&to=${end}`;
  }
  
  console.log("[tool:get_probe_data] URL:", url.replace(key, "***")); // Hide key in logs

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    console.error("[tool:get_probe_data] FAILED:", res.status, text);
    return { error: "Failed to fetch probe data", status: res.status, details: text };
  }

  // The API returns CSV, not JSON
  const csvData = await res.text();
  console.log("[tool:get_probe_data] success, received", csvData.length, "characters");
  
  // Parse CSV and extract meaningful summary
  const lines = csvData.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) {
    console.log("[tool:get_probe_data] no data found for date range");
    return {
      loggerId: loggerId,
      error: "No data found for the specified date range",
      dateRange: { start, end }
    };
  }
  
  const headers = lines[0];
  const dataLines = lines.slice(1);
  
  console.log("[tool:get_probe_data] parsed", dataLines.length, "data rows");
  
  // Get latest reading (last line)
  const latestLine = dataLines[dataLines.length - 1];
  const latestValues = latestLine ? latestLine.split(',') : [];
  
  // Get first reading for comparison
  const firstLine = dataLines[0];
  const firstValues = firstLine ? firstLine.split(',') : [];
  
  // Build a summary with DAILY averages for analysis
  const headerArray = headers.split(',');
  const summary = {
    loggerId: loggerId,
    dateRange: {
      start: firstValues[0],
      end: latestValues[0]
    },
    totalReadings: dataLines.length,
    latestReading: {},
    dailySummary: []
  };
  
  // Extract temperature (T) and moisture readings from latest
  headerArray.forEach((header, index) => {
    if (header.includes('T') || header.includes('A') || header.includes('S')) {
      summary.latestReading[header] = latestValues[index];
    }
  });
  
  // Group by date and calculate daily averages
  const dailyData = {};
  dataLines.forEach(line => {
    const values = line.split(',');
    const dateTime = values[0];
    const date = dateTime ? dateTime.split(' ')[0] : null; // Get just the date part
    
    if (!date) return;
    
    if (!dailyData[date]) {
      dailyData[date] = { count: 0, moistureSum: {}, tempSum: {} };
    }
    
    // Sum up moisture and temperature values for averaging
    headerArray.forEach((header, i) => {
      const val = parseFloat(values[i]);
      if (!isNaN(val)) {
        if (header.includes('A')) { // Moisture sensors
          if (!dailyData[date].moistureSum[header]) {
            dailyData[date].moistureSum[header] = 0;
          }
          dailyData[date].moistureSum[header] += val;
        }
        if (header.includes('T')) { // Temperature sensors
          if (!dailyData[date].tempSum[header]) {
            dailyData[date].tempSum[header] = 0;
          }
          dailyData[date].tempSum[header] += val;
        }
      }
    });
    dailyData[date].count++;
  });
  
  // Calculate averages and sort by date
  const dates = Object.keys(dailyData).sort();
  dates.forEach(date => {
    const dayData = { 
      date, 
      avgMoisture: {}, 
      avgTemp: {},
      readingCount: dailyData[date].count
    };
    
    // Calculate moisture averages
    Object.keys(dailyData[date].moistureSum).forEach(sensor => {
      dayData.avgMoisture[sensor] = (dailyData[date].moistureSum[sensor] / dailyData[date].count).toFixed(2);
    });
    
    // Calculate temp averages
    Object.keys(dailyData[date].tempSum).forEach(sensor => {
      dayData.avgTemp[sensor] = (dailyData[date].tempSum[sensor] / dailyData[date].count).toFixed(2);
    });
    
    summary.dailySummary.push(dayData);
  });
  
  console.log("[tool:get_probe_data] created", summary.dailySummary.length, "daily summaries");
  console.log("[tool:get_probe_data] summary size:", JSON.stringify(summary).length);
  
  return summary;
}

// ---- Main Handler ----
exports.handler = async (event) => {
  console.log("--- chat function invoked ---");

  const { message, threadId } = JSON.parse(event.body || "{}");
  console.log("Incoming body:", { message, threadId });

  const openaiBase = "https://api.openai.com/v1";
  let thread_id = threadId;

  // 1) Create a new thread if needed
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

  // 2) Add user message
  console.log("[messages] add user message");
  const mRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({
      role: "user",
      content: message,
    }),
  });

  if (!mRes.ok) {
    const details = await safeJson(mRes);
    console.error("[messages] add FAILED:", mRes.status, details);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to add message", details }),
    };
  }

  // 3) Start a run
  console.log("[runs] starting with assistant_id:", process.env.ASSISTANT_ID);
  let runRes = await fetch(`${openaiBase}/threads/${thread_id}/runs`, {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify({
      assistant_id: process.env.ASSISTANT_ID,
    }),
  });

  let run = await runRes.json();
  console.log("[runs] started id:", run.id, "status:", run.status);

  // ---- Poll and handle tool calls in a unified loop ----
  let maxIterations = 30; // Prevent infinite loops
  let iterations = 0;
  
  while (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "expired") {
    iterations++;
    if (iterations > maxIterations) {
      console.error("[runs] exceeded max iterations");
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Run took too long" }),
      };
    }

    console.log(`[runs] iteration ${iterations}, status: ${run.status}`);

    if (run.status === "requires_action") {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls || [];
      console.log("[runs] requires_action with", calls.length, "tool calls");
      console.log("[runs] full required_action:", JSON.stringify(run.required_action, null, 2));

      const outputs = [];
      for (const c of calls) {
        console.log("[tool-call] name:", c.function?.name, "id:", c.id);
        
        if (c.function?.name === "get_probe_data") {
          const args = JSON.parse(c.function.arguments || "{}");
          console.log("[tool-call] args:", args);
          const data = await getProbeData(args);
          console.log("[tool-call] output:", JSON.stringify(data).slice(0, 500));
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(data) });
        } 
        else if (c.function?.name === "get_weather_data") {
          const args = JSON.parse(c.function.arguments || "{}");
          console.log("[tool-call] weather args:", args);
          
          // Call the weather function
          const weatherRes = await fetch(`${process.env.URL}/.netlify/functions/weather`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args)
          });
          
          const weatherData = await weatherRes.json();
          console.log("[tool-call] weather output:", JSON.stringify(weatherData).slice(0, 500));
          outputs.push({ tool_call_id: c.id, output: JSON.stringify(weatherData) });
        }
        else {
          console.log("[tool-call] unknown tool, returning error");
          outputs.push({
            tool_call_id: c.id,
            output: JSON.stringify({ error: "unknown tool" }),
          });
        }
      }

      console.log("[runs] submitting", outputs.length, "tool outputs");
      const stoRes = await fetch(
        `${openaiBase}/threads/${thread_id}/runs/${run.id}/submit_tool_outputs`,
        {
          method: "POST",
          headers: openaiHeaders(),
          body: JSON.stringify({ tool_outputs: outputs }),
        }
      );

      if (!stoRes.ok) {
        const details = await safeJson(stoRes);
        console.error("[runs] submit_tool_outputs FAILED:", stoRes.status, details);
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Failed to submit tool outputs",
            details,
          }),
        };
      }

      run = await stoRes.json();
      console.log("[runs] after submit_tool_outputs status:", run.status);
    } else if (run.status === "in_progress" || run.status === "queued") {
      // Wait and poll
      await new Promise((res) => setTimeout(res, 1500));
      const pollRes = await fetch(`${openaiBase}/threads/${thread_id}/runs/${run.id}`, {
        headers: openaiHeaders(),
      });
      run = await pollRes.json();
    } else {
      console.log("[runs] unexpected status, breaking:", run.status);
      break;
    }
  }

  // ---- Get final message ----
  const msgRes = await fetch(`${openaiBase}/threads/${thread_id}/messages`, {
    headers: openaiHeaders(),
  });
  
  if (!msgRes.ok) {
    const details = await safeJson(msgRes);
    console.error("[messages] fetch FAILED:", msgRes.status, details);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch messages", details }),
    };
  }
  
  const messages = await msgRes.json();
  console.log("[messages] full response:", JSON.stringify(messages, null, 2));

  const latest = messages?.data?.[0]?.content?.[0]?.text?.value || "(no reply)";
  console.log("[messages] latest text:", latest.slice(0, 200));
  
  // Check the final run status
  console.log("[runs] final status:", run.status);
  if (run.status === "failed") {
    console.error("[runs] failed with error:", run.last_error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Assistant run failed", 
        details: run.last_error 
      }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      threadId: thread_id,
      response: latest,
      runStatus: run.status,
    }),
  };
};
