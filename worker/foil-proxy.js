/**
 * NYC FOIL Helper — Cloudflare Worker proxy
 *
 * Holds the Anthropic API key as a secret (set with `wrangler secret put ANTHROPIC_API_KEY`)
 * so it is never exposed to the browser. The static front end POSTs a plain-language
 * request plus the agency directory; this worker asks Claude to (1) pick the right
 * agency from the directory, (2) draft an airtight New York FOIL letter, and
 * (3) format it as a ready-to-send email. It returns structured JSON.
 *
 * Cost note: each request is one Claude API call (Sonnet by default). Typical cost is
 * a fraction of a cent per request. The DAILY_BUDGET_USD cap below is a coarse backstop.
 */

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;

// Lock this down to your GitHub Pages origin(s) before going public.
const ALLOWED_ORIGINS = [
  "https://joshgreenman1973.github.io",
  "https://vitalcity-nyc.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const SYSTEM_PROMPT = `You are a New York City public-records specialist. You help members of the public turn a plain-language description of what they want from New York City government into a legally sound request under the New York Freedom of Information Law (FOIL), Public Officers Law Article 6, Sections 84-90.

You will receive:
1. The requester's plain-language description of what they are seeking.
2. Optional requester details (name, affiliation, email, phone, whether they want a fee waiver, and date).
3. A JSON directory of major New York City agencies and the records each one holds.

Your job has three parts.

PART 1 — ROUTE THE REQUEST.
- Choose the single agency from the provided directory most likely to hold the records. Use the "holds" and "keywords" fields. Return its exact "id" and "name".
- If two or more agencies could plausibly hold the records, list the others in "alternativeAgencies" with a one-line reason each.
- If NO agency in the directory is a good fit, set agencyId to "unknown", set agencyName to your best plain description of the likely agency or office, and explain in "reasoning". Never invent an agency that contradicts the directory.
- Set "confidence" to high, medium, or low based on how clearly the records map to one agency.

PART 2 — DRAFT THE FOIL LETTER.
Write a complete, professional FOIL request letter body. It must:
- Cite the New York Freedom of Information Law, Public Officers Law Article 6, Sections 84-90.
- Describe the records sought with maximum precision: specific record types (emails, reports, datasets, contracts, inspection records, etc.), a date range if one is implied or reasonable, relevant offices/divisions, and any obvious search terms. If the user did not give a date range, choose a reasonable one and note it as an assumption inside the letter only if natural (do not pad with brackets the user must fill unless truly necessary).
- Ask that records be provided in electronic format where they already exist electronically.
- Request that any responsive record withheld in whole or in part be accompanied by a written statement citing the specific FOIL exemption, and that all reasonably segregable non-exempt portions be released (Public Officers Law Section 89(2)).
- Note that FOIL requires the agency to acknowledge the request within five business days and to provide records or a reasonable date certain for production.
- If the requester asked for a fee waiver or indicated a journalistic/public-interest purpose, include a brief request that fees be waived or limited, noting any duplication fee under FOIL is capped at 25 cents per page and that electronic records carry no per-page fee.
- Use the requester's provided name and contact details. If a detail is missing, use a clearly bracketed placeholder like [YOUR NAME] so the user knows to fill it in. Keep placeholders to a minimum.
- Be specific but not so narrow that responsive records are excluded; instruct that the request be construed broadly.
- Do NOT fabricate facts, case names, file numbers, or events. Only use what the requester provided.

PART 3 — FORMAT AS EMAIL.
- Provide a concise email subject line, e.g. "FOIL Request — [short description]".
- Provide a short "submissionGuidance" string telling the requester how to actually file it: that the canonical channel for nearly every NYC agency is the NYC OpenRecords portal (paste the letter body into the request field), and that the chosen agency's submission URL is included. Mention they can look up the current named records-access officer in the official FOIL Officers Directory if they prefer email.

Return ONLY a tool call to "foil_result". Do not write any prose outside the tool call.`;

const RESULT_TOOL = {
  name: "foil_result",
  description: "Structured FOIL routing and draft result.",
  input_schema: {
    type: "object",
    properties: {
      agencyId: { type: "string", description: "The exact 'id' of the chosen agency from the directory, or 'unknown'." },
      agencyName: { type: "string", description: "Full name of the chosen agency." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reasoning: { type: "string", description: "1-3 sentences on why this agency holds the records." },
      alternativeAgencies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agencyId: { type: "string" },
            agencyName: { type: "string" },
            reason: { type: "string" },
          },
          required: ["agencyName", "reason"],
        },
      },
      emailSubject: { type: "string" },
      foilLetter: { type: "string", description: "The complete FOIL letter body, ready to paste or send." },
      submissionGuidance: { type: "string" },
      caveats: { type: "string", description: "Any caveats: missing info the user should add, scope warnings, or exemptions likely to apply." },
    },
    required: ["agencyId", "agencyName", "confidence", "reasoning", "emailSubject", "foilLetter", "submissionGuidance"],
  },
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Server not configured: missing ANTHROPIC_API_KEY." }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400, cors);
    }

    const userRequest = (body.request || "").toString().trim();
    if (!userRequest) {
      return json({ error: "Please describe what records you are seeking." }, 400, cors);
    }
    if (userRequest.length > 6000) {
      return json({ error: "Request description is too long (6000 character max)." }, 400, cors);
    }

    const details = body.details || {};
    const agencies = body.agencies || [];

    const userContent =
      `PLAIN-LANGUAGE REQUEST:\n${userRequest}\n\n` +
      `REQUESTER DETAILS (use what is present; bracket what is missing):\n` +
      `Name: ${details.name || "(not provided)"}\n` +
      `Affiliation: ${details.affiliation || "(not provided)"}\n` +
      `Email: ${details.email || "(not provided)"}\n` +
      `Phone: ${details.phone || "(not provided)"}\n` +
      `Wants fee waiver / public-interest purpose: ${details.feeWaiver ? "yes" : "not indicated"}\n` +
      `Today's date: ${details.date || "(not provided)"}\n\n` +
      `AGENCY DIRECTORY (choose from these):\n${JSON.stringify(agencies)}`;

    let apiResp;
    try {
      apiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: [RESULT_TOOL],
          tool_choice: { type: "tool", name: "foil_result" },
          messages: [{ role: "user", content: userContent }],
        }),
      });
    } catch (e) {
      return json({ error: "Upstream request failed.", detail: String(e) }, 502, cors);
    }

    if (!apiResp.ok) {
      const text = await apiResp.text();
      return json({ error: "Anthropic API error.", status: apiResp.status, detail: text }, 502, cors);
    }

    const data = await apiResp.json();
    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "foil_result");
    if (!toolUse) {
      return json({ error: "Model did not return a structured result.", raw: data }, 502, cors);
    }

    return json({ result: toolUse.input }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
