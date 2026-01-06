// api/summarize.js

// 1. Helper: Extract Video ID
function getVideoId(url) {
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// 2. Helper: Rate Limiting (Memory-based)
const rateLimits = new Map();
const MAX_REQUESTS = 30;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const userRecord = rateLimits.get(ip) || {
    count: 0,
    resetTime: now + WINDOW_MS,
  };

  if (now > userRecord.resetTime) {
    userRecord.count = 0;
    userRecord.resetTime = now + WINDOW_MS;
  }

  if (userRecord.count >= MAX_REQUESTS) {
    return false;
  }

  userRecord.count++;
  rateLimits.set(ip, userRecord);
  return true;
}

// 3. Helper: Fetch Transcript (Scraping)
async function getTranscript(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    if (!response.ok) throw new Error("Failed to reach YouTube");

    const html = await response.text();
    // Regex to find the caption tracks JSON block
    const regex = /"captionTracks":(\[.*?\])/;
    const match = html.match(regex);

    if (!match || !match[1]) {
      throw new Error(
        "No captions found for this video (Private or No Captions).",
      );
    }

    const captionTracks = JSON.parse(match[1]);
    const track =
      captionTracks.find((t) => t.languageCode.includes("en")) ||
      captionTracks[0];

    if (!track) throw new Error("No suitable caption track found.");

    const trackResponse = await fetch(track.baseUrl);
    const trackText = await trackResponse.text();

    // Parse text from XML
    const textRegex = /<text[^>]*>(.*?)<\/text>/gs;
    let transcript = "";
    let matchText;
    while ((matchText = textRegex.exec(trackText)) !== null) {
      // Decode basic entities
      let clean = matchText[1]
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#10;/g, " ")
        .replace(/<[^>]*>/g, ""); // strip nested tags if any
      transcript += clean + " ";
    }

    if (!transcript || transcript.length < 50)
      throw new Error("Transcript is empty.");
    return transcript.trim();
  } catch (err) {
    console.error("Transcript Error:", err);
    throw new Error("Could not fetch transcript: " + err.message);
  }
}

// 4. Helper: Call Google Gemini
async function generateSummary(transcript) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error("Server misconfiguration: Missing GEMINI_API_KEY");

  const prompt = `
        You are a helpful assistant. Analyze the following YouTube transcript.
        Provide the output in strict JSON format with these keys:
        - "summary": A 3-5 sentence concise summary.
        - "terms": An array of 5-10 key terms.
        - "points": An array of 5-8 bullet points.
        Do not include markdown formatting (like \`\`\`json). Just the raw JSON object.

        Transcript:
        "${transcript.substring(0, 15000)}"
    `;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(`AI API Error: ${data.error.message}`);
  }

  const rawText = data.candidates[0].content.parts[0].text;

  // Clean AI text to ensure we get JSON
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI returned non-JSON text.");

  return JSON.parse(jsonMatch[0]);
}

// 5. Main Handler
export default async function handler(req, res) {
  // CORS handling
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT",
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  // Check Rate Limit
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Rate limit exceeded (30/day)." });
  }

  try {
    const videoId = getVideoId(url);
    if (!videoId) throw new Error("Invalid YouTube URL");

    const transcript = await getTranscript(videoId);
    const aiResult = await generateSummary(transcript);

    res.status(200).json(aiResult);
  } catch (error) {
    console.error("Backend Error:", error);
    // Always return JSON error to prevent frontend crashes
    res.status(500).json({ error: error.message });
  }
}
