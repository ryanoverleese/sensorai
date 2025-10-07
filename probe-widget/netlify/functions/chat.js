// netlify/functions/chat.js
import fetch from "node-fetch";

// Helper: sleep
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Helper: safely parse JSON
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// Helper: shared headers for OpenAI API
function openaiHeaders() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// ============= MAIN HANDLER ==================
export async function handler(event) {
  console.log("--- chat function invoked ---");

  // --- ENVIRONMENT VARIABLES ---
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const ASSISTANT_ID = process.env.ASSISTANT_ID;
  const PROBE_API_BASE = process.env.PROBE_API_BASE;
  const PROBE_API_KEY = process.env.PROBE_API_KEY;

  console.log("env lengths:", {
    OPENAI_API_KEY: OPENAI_API_KEY?.length || 0,
    ASSISTANT_ID: ASSISTANT_ID?.length || 0,
    PROBE_API_BASE: PROBE_API_BASE?.length || 0,
    PROBE_API_KEY: PROBE_API_KEY?.length || 0,
  });

  if (!OPENAI_API_KEY || !ASSISTANT_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing required environment variables.",
      }),
    };
  }

  // Parse incoming message
  const body = JSON.parse(event.body || "{}");
  const userMessage = body.message || "";
  const existingThread = body.threadId || null;

  console.log("Incoming body:", body);

  try {
    // 1️⃣ Create thread if needed
    let threadId = existingThread;
    if (!threadId) {
      const tRes = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: openaiHeaders(),
      });
      const tData = await tRes.json();
      threadId = tData.id;
      console.log("[threads] created id:", threadId);
    }

    // 2️⃣ Add user message
    const mRes = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: openaiHeaders(),
        body: JSON.stringify({
          role: "user",
          content: userMessage,
        }),
      }
    );

    if (!mRes.ok) {
      const details = await safeJson(mRes);
      console.error("[messages] add FAILED:", mRes.status, details);
      throw new Error(
        `Failed to add message: ${mRes.status} ${JSON.stringify(details)}`
      );
    }

    // 3️⃣ Start the run (Assistant or Workflow)
    console.log("[runs] starting with payload:", { assistant_id:
