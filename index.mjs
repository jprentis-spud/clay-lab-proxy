import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "http";

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["*"];

// Simple rate limiter: max requests per IP per window
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

function getCorsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin || "*" : "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function sendJSON(res, status, body, origin) {
  const headers = { "Content-Type": "application/json", ...getCorsHeaders(origin) };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

const ENRICHMENT_PROMPT = (domain) => `You have access to Clay's GTM tools via MCP. Analyse "${domain}" as a potential Clay.com customer.

STEP 1: Use the find-and-enrich-company tool with:
- companyIdentifier: "${domain}"
- companyDataPoints: [{"type":"Recent News"},{"type":"Tech Stack"},{"type":"Open Jobs"},{"type":"Latest Funding"},{"type":"Company Competitors"}]

STEP 2: Use find-and-enrich-contacts-at-company with:
- companyIdentifier: "${domain}"
- contactFilters: {"job_title_keywords":["VP Sales","VP Marketing","VP Revenue Operations","Head of Growth","GTM Engineer","RevOps","CRO","Chief Revenue Officer"]}

STEP 3: Based on ALL data gathered, respond with ONLY a JSON object (no markdown fences, no preamble, no explanation — JUST the raw JSON) in this schema:

{"company":{"name":"<name>","domain":"${domain}","industry":"<industry>","employees":"<range>","hq":"<city, state/country>","funding":"<latest round & amount>","desc":"<one-line description>"},"icpScore":<0-100>,"icpBreakdown":[{"label":"Company Size","score":<0-100>,"reason":"<1 sentence>"},{"label":"GTM Maturity","score":<0-100>,"reason":"<1 sentence>"},{"label":"Tech Stack Fit","score":<0-100>,"reason":"<1 sentence>"},{"label":"Growth Trajectory","score":<0-100>,"reason":"<1 sentence>"},{"label":"Budget Alignment","score":<0-100>,"reason":"<1 sentence>"}],"signals":[{"type":"<Hiring|Product|Leadership|Market|Tech|Competitive>","icon":"<emoji>","title":"<title>","detail":"<2 sentences>","urgency":"<high|medium|low>"}],"contacts":[{"name":"<full name>","title":"<job title>","relevance":"<why they matter for a Clay deal>"}],"playSteps":[{"step":"01","title":"<title>","desc":"<specific Clay workflow>"},{"step":"02","title":"<title>","desc":"<details>"},{"step":"03","title":"<title>","desc":"<details>"},{"step":"04","title":"<title>","desc":"<details>"},{"step":"05","title":"<title>","desc":"<details>"}]}

Clay.com is a GTM data enrichment and workflow automation platform for RevOps, Growth, and Sales teams. High ICP = complex outbound, CRM usage, GTM investment. Include 3-5 signals (sorted by urgency), 3-5 contacts, 5 play steps.`;

async function handleEnrich(domain) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: ENRICHMENT_PROMPT(domain) }],
    mcp_servers: [
      { type: "url", url: "https://api.clay.com/v3/mcp", name: "clay-gtm" },
    ],
  });

  const blocks = response.content || [];

  // Collect all content types
  const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
  const toolResults = blocks
    .filter((b) => b.type === "mcp_tool_result")
    .map((b) => {
      try {
        return b.content?.[0]?.text || JSON.stringify(b.content);
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  // Try to parse JSON from text responses
  for (const t of texts) {
    try {
      const cleaned = t.replace(/```json\s*/g, "").replace(/```/g, "").trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.company || parsed.icpScore !== undefined) {
          return {
            ok: true,
            data: parsed,
            toolResults,
            rawTexts: texts,
          };
        }
      }
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    error: "Could not parse structured response",
    rawTexts: texts,
    toolResults,
  };
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || "*";

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, getCorsHeaders(origin));
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/") {
    return sendJSON(res, 200, {
      status: "ok",
      service: "clay-lab-proxy",
      endpoints: ["POST /enrich"],
    }, origin);
  }

  // Enrich endpoint
  if (req.method === "POST" && req.url === "/enrich") {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress;

    if (isRateLimited(ip)) {
      return sendJSON(res, 429, { ok: false, error: "Rate limited. Try again shortly." }, origin);
    }

    // Parse body
    let body = "";
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { ok: false, error: "Invalid JSON body" }, origin);
    }

    const domain = parsed.domain?.trim()?.toLowerCase()?.replace(/^https?:\/\//, "")?.replace(/\/$/, "");
    if (!domain || !domain.includes(".")) {
      return sendJSON(res, 400, { ok: false, error: "Invalid domain" }, origin);
    }

    try {
      console.log(`[enrich] Starting enrichment for: ${domain}`);
      const result = await handleEnrich(domain);
      console.log(`[enrich] Completed for ${domain}: ok=${result.ok}`);
      return sendJSON(res, 200, result, origin);
    } catch (err) {
      console.error(`[enrich] Error for ${domain}:`, err.message);
      return sendJSON(res, 500, { ok: false, error: err.message }, origin);
    }
  }

  // 404
  sendJSON(res, 404, { error: "Not found" }, origin);
});

server.listen(PORT, () => {
  console.log(`Clay Lab Proxy running on port ${PORT}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
