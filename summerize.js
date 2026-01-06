// api/summarize.js

// Helper: Extract Video ID from various YouTube URL formats
function getVideoId(url) {
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Helper: Fetch transcript directly from YouTube (Scraping)
// We fetch the HTML, find the caption track JSON, and extract text.
async function getTranscript(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const html = await response.text();

    // YouTube stores caption tracks in a specific variable inside the HTML
    // This regex looks for "captionTracks" inside the script data.
    const regex = /"captionTracks":(\[.*?\])/;
    const match = html.match(regex);

    if (!match || !match[1]) {
      throw new Error("No captions found for this video.");
    }

    const captionTracks = JSON.parse(match[1]);
    // Prefer English, but fallback to the first available
    const track =
      captionTracks.find((t) => t.languageCode.includes("en")) ||
      captionTracks[0];

    if (!track) throw new Error("No suitable caption track found.");

    // Fetch the actual transcript content (XML format usually, or JSON)
    const trackResponse = await fetch(track.baseUrl);
    const trackText = await trackResponse.text();

    // Parse XML to extract text content
    // Simple parser: look for <text> tags
    const textRegex = /<text[^>]*>(.*?)<\/text>/gs;
    let transcript = "";
    let matchText;
    while ((matchText = textRegex.exec(trackText)) !== null) {
      // Decode HTML entities (basic) and clean up
      transcript +=
        matchText[1]
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&#10;/g, "\n") + " ";
    }

    return transcript.trim();
  } catch (err) {
    console.error("Transcript Error:", err);
    throw new Error(
      "Could not fetch transcript. Video might be private or have no captions.",
    );
  }
}

// Helper: Call Google Gemini API
async function generateSummary(transcript) {
  const apiKey = process.env.GEMINI_API_KEY; // Set this in Vercel Environment Variables
  if (!apiKey) throw new Error("Server misconfiguration: Missing API Key");

  const prompt = `
        You are a helpful assistant. Analyze the following transcript from a YouTube video.
        Provide the output in strict JSON format with these keys:
        - "summary": A 3-5 sentence concise summary.
        - "terms": An array of 5-10 key technical terms or concepts.
        - "points": An array of 5-8 bullet points explaining the main takeaways.

        Transcript:
        "${transcript.substring(0, 15000)}"
        (Limit transcript to first 15k chars to save tokens)
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
    throw new Error(`AI Error: ${data.error.message}`);
  }

  const rawText = data.candidates[0].content.parts[0].text;

  // Extract JSON from the AI response (sometimes AI adds markdown backticks)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI failed to return valid JSON.");

  return JSON.parse(jsonMatch[0]);
}

// Rate Limiting (Simple Memory-based for Serverless)
// In a real distributed system, use Redis or KV. Here we use a Map for demo simplicity.
const rateLimits = new Map();
const MAX_REQUESTS = 30;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

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

// Main Handler (Vercel/Node.js syntax)
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  // 1. Check Rate Limit
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res
      .status(429)
      .json({
        error: "Rate limit exceeded (30 uses/day). Try again tomorrow.",
      });
  }

  try {
    // 2. Extract ID
    const videoId = getVideoId(url);
    if (!videoId) throw new Error("Invalid YouTube URL");

    // 3. Get Transcript
    const transcript = await getTranscript(videoId);
    if (!transcript || transcript.length < 50)
      throw new Error("Transcript too short or empty");

    // 4. AI Processing
    const aiResult = await generateSummary(transcript);

    // 5. Send Response
    res.status(200).json(aiResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
