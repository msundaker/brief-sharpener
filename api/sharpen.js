const JSZip = require("jszip");

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const RETRY_DELAYS_MS = [500, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAnthropicWithRetry(apiKey, payload) {
  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    const isOverloaded = response.status === 529 || data?.error?.type === "overloaded_error";
    if (!isOverloaded || attempt === maxAttempts - 1) {
      return { response, data };
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function sanitizeJsonNewlines(str) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r")) {
      out += ch === "\n" ? "\\n" : "\\r";
      continue;
    }
    out += ch;
  }
  return out;
}

async function extractPptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });

  const parts = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("string");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((m) => decodeXmlEntities(m[1]))
      .join(" ")
      .trim();
    if (texts) {
      const slideNum = name.match(/slide(\d+)\.xml/)[1];
      parts.push(`Slide ${slideNum}: ${texts}`);
    }
  }
  return parts.join("\n\n");
}

const SYSTEM_PROMPT = `You are a senior brand strategist reviewing a creative brief. Assess the brief strictly against these 6 criteria, in this priority order (1-3 are primary, weighted highest):

1. why — is there a real reason this matters NOW, or does it jump straight to tactics?
2. audience — is there a real tension/frustration/insight, or just a demographic bracket?
3. idea — is there one clear central idea that evolves and builds meaning as it moves across touchpoints, or is it a flat channel checklist with several competing messages?
4. business — clear line from the work to a specific business lever (trial, retention, price premium, category entry)?
5. success — specific, measurable definition of success?
6. execution — does the operational plan (channels, timing, budget) have real specificity and clearly support the idea and audience above, or is it a vague, generic tactical list untethered to the strategy?

For each criterion give a verdict of exactly "sharp", "needs work", or "missing", plus one short, pointed question (max 15 words, one sentence) a senior strategist would ask aloud in the room to sharpen it. The question must interrogate that specific criterion's own definition above — never a generic question that could equally apply to a different criterion, and never one that strays into another criterion's territory (e.g. the why question is about the reason/timing, not the audience or the idea). Ground the question only in what the brief actually says — never presuppose a specific fact, date, or comparison (e.g. "versus last year") the brief didn't give you; when in doubt, ask the more general, foundational version of that criterion's question instead of inventing a specific angle. Skip the question only if verdict is "sharp" (use empty string).

Then produce a sharpened rewrite of the brief as a structured document, not a single paragraph. Use exactly these section headers, each in ALL CAPS on its own line followed by a colon, with that section's content directly after: WHY:, AUDIENCE:, IDEA:, BUSINESS CASE:, SUCCESS:, EXECUTION:.

You are diagnosing and structuring, never solving. Keep WHY, AUDIENCE, IDEA, BUSINESS CASE and SUCCESS tight — tighten what's mechanically fixable (structure, clarity, making an implicit point explicit from context already in the brief), but never invent the actual answer where real judgment is required (who the audience really is, why now, the central idea, the business tie, the metric). Insert a short bracketed flag instead, like [AUDIENCE INSIGHT NEEDED], [WHY NOW NEEDED], [CENTRAL IDEA NEEDED], [BUSINESS LEVER NEEDED], or [METRIC NEEDED] — the strategist using this tool supplies that thinking themselves, or hires someone who does. EXECUTION works differently: preserve the real operational detail already present in the original brief (specific channels, budget figures, timing, deliverables, tactics) rather than compressing it away — never discard concrete information the brief already gave you, and never invent operational detail the brief didn't provide (flag with [EXECUTION PLAN NEEDED] if it's genuinely missing). Total length should reflect how much the original brief actually specified — roughly 150-350 words is typical, but don't pad for length and don't cut real detail to hit a target.

Be terse in the strategic sections; be complete in EXECUTION. The line breaks between sections in sharpenedBrief MUST be encoded as the two characters backslash-n (\n) inside the JSON string — never output a raw, literal line break inside a JSON string value, that produces invalid JSON. Respond with ONLY valid JSON, no markdown fences, no preamble, no explanation text before or after, in exactly this shape and nothing else:
{"verdicts":{"why":{"verdict":"...","question":"..."},"audience":{"verdict":"...","question":"..."},"idea":{"verdict":"...","question":"..."},"business":{"verdict":"...","question":"..."},"success":{"verdict":"...","question":"..."},"execution":{"verdict":"...","question":"..."}},"sharpenedBrief":"..."}`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: "ANTHROPIC_API_KEY is not configured on the server. Set it in the Vercel project's Environment Variables." },
    });
    return;
  }

  const { brief, file, answers } = req.body || {};

  let briefText = typeof brief === "string" ? brief.trim() : "";
  let pdfBase64 = null;

  if (file && typeof file.dataBase64 === "string") {
    const buffer = Buffer.from(file.dataBase64, "base64");
    if (buffer.length > MAX_FILE_BYTES) {
      res.status(400).json({ error: { message: "File is too large (max 3MB)." } });
      return;
    }

    const name = (file.name || "").toLowerCase();
    const type = (file.type || "").toLowerCase();
    const isPdf = type === "application/pdf" || name.endsWith(".pdf");
    const isPptx = name.endsWith(".pptx") || type.includes("presentation");

    if (isPdf) {
      pdfBase64 = file.dataBase64;
    } else if (isPptx) {
      try {
        briefText = await extractPptxText(buffer);
      } catch (e) {
        res.status(400).json({ error: { message: "Couldn't read that PowerPoint file. Try exporting it to PDF instead." } });
        return;
      }
      if (!briefText) {
        res.status(400).json({ error: { message: "No text found in that PowerPoint file." } });
        return;
      }
    } else {
      res.status(400).json({ error: { message: "Unsupported file type. Upload a PDF or .pptx, or paste the text directly." } });
      return;
    }
  }

  if (!pdfBase64 && !briefText) {
    res.status(400).json({ error: { message: "Missing brief text or file." } });
    return;
  }

  let answersBlock = "";
  if (Array.isArray(answers) && answers.length > 0) {
    const qaText = answers
      .filter((a) => a && typeof a.answer === "string" && a.answer.trim())
      .map((a) => `- ${a.label}: ${a.question}\n  Strategist's answer: ${a.answer.trim()}`)
      .join("\n\n");
    if (qaText) {
      answersBlock = `\n\nThe strategist has provided answers to close specific gaps flagged in an earlier read. Use these to replace the bracketed placeholders in the sharpened brief with real content — do not leave brackets for anything answered below, and re-assess the verdict for any criterion these answers resolve:\n${qaText}`;
    }
  }

  const userContent = pdfBase64
    ? [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
        },
        { type: "text", text: `The brief is the attached PDF above.${answersBlock}` },
      ]
    : [{ type: "text", text: `Brief:\n${briefText}${answersBlock}` }];

  try {
    const { response, data } = await callAnthropicWithRetry(apiKey, {
      model: "claude-sonnet-5",
      max_tokens: 2000,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    if (!response.ok || data?.error) {
      res.status(response.status || 500).json({
        error: { message: data?.error?.message || "Anthropic API error" },
      });
      return;
    }

    const textBlock = (data.content || []).find((c) => c.type === "text");
    if (!textBlock) {
      res.status(502).json({ error: { message: "No response text returned." } });
      return;
    }

    let cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      cleaned = cleaned.slice(start, end + 1);
    }
    cleaned = sanitizeJsonNewlines(cleaned);

    const parsed = JSON.parse(cleaned);
    if (!parsed.verdicts || !parsed.sharpenedBrief) {
      res.status(502).json({ error: { message: "Response was missing expected fields." } });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: { message: err.message || "Proxy request failed." } });
  }
};
