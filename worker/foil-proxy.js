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
4. A list of REAL datasets already published on the NYC Open Data portal that matched a keyword search of the request. Each has a title, description, and URL.

Your job has FOUR parts.

PART 0 — IS IT ALREADY PUBLIC?
Before anyone files a FOIL request, check whether the answer is already published. Review the provided NYC Open Data results.
- Set "openDataVerdict" to one of: "likely_answerable" (a published dataset clearly contains what they want), "partially" (open data covers part of it, but a FOIL would still add value), "not_answerable" (nothing published is a real match; a FOIL is the right path), or "unsure".
- In "relevantDatasets", list ONLY datasets from the provided results that genuinely relate to the request. For each, copy its exact title and url from the input and add a one-line "why" explaining what it would or would not answer. If none of the provided results genuinely match, return an empty array. NEVER invent a dataset, title, or URL that was not in the provided list.
- In "openDataSummary", write 1-3 plain-language sentences telling the requester what they can likely get from open data right now versus what still needs a FOIL. If the list is empty or irrelevant, say so plainly and that a FOIL is the way to go.
- In "trackerQuery", give 2-5 short keywords (space-separated, no punctuation) capturing the core subject, to search a separate log of FOIL requests other people have already filed. Use plain nouns (e.g. "restaurant inspection astoria").
- Always continue to the FOIL parts below regardless of the verdict, because open data is often aggregated, de-identified, or incomplete and the requester may still want the underlying records.

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
      openDataVerdict: { type: "string", enum: ["likely_answerable", "partially", "not_answerable", "unsure"] },
      openDataSummary: { type: "string", description: "1-3 sentences on what open data can answer now vs. what needs a FOIL." },
      relevantDatasets: {
        type: "array",
        description: "Datasets chosen ONLY from the provided NYC Open Data results. Empty if none truly match.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            why: { type: "string" },
          },
          required: ["title", "url", "why"],
        },
      },
      trackerQuery: { type: "string", description: "2-5 space-separated keywords to search prior FOIL requests." },
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
    required: ["openDataVerdict", "openDataSummary", "relevantDatasets", "trackerQuery", "agencyId", "agencyName", "confidence", "reasoning", "emailSubject", "foilLetter", "submissionGuidance"],
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

    // --- Step 0: search the real NYC Open Data catalog for already-published datasets ---
    const openData = await searchOpenData(userRequest);

    const userContent =
      `PLAIN-LANGUAGE REQUEST:\n${userRequest}\n\n` +
      `REQUESTER DETAILS (use what is present; bracket what is missing):\n` +
      `Name: ${details.name || "(not provided)"}\n` +
      `Affiliation: ${details.affiliation || "(not provided)"}\n` +
      `Email: ${details.email || "(not provided)"}\n` +
      `Phone: ${details.phone || "(not provided)"}\n` +
      `Wants fee waiver / public-interest purpose: ${details.feeWaiver ? "yes" : "not indicated"}\n` +
      `Today's date: ${details.date || "(not provided)"}\n\n` +
      `NYC OPEN DATA SEARCH RESULTS (real datasets matching a keyword search of the request; pick relevant ones only from this list, never invent):\n${JSON.stringify(openData)}\n\n` +
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

// Words to drop so the catalog search keys on meaningful terms.
const STOPWORDS = new Set("a an and the of for to from in on at by with about into over under all any my our your their his her its this that these those i we you they it want need would like get obtain request records record data dataset datasets information info copy copies please give me show find every each between during regarding concerning related relating since over past last few several many much how what which who whom where when why is are was were be been being do does did has have had will can could should may might".split(/\s+/));

async function searchOpenData(text) {
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  // de-dupe, keep order, cap to keep the query tight
  const seen = new Set();
  const keywords = [];
  for (const w of terms) { if (!seen.has(w)) { seen.add(w); keywords.push(w); } if (keywords.length >= 8) break; }
  const q = keywords.join(" ") || text.slice(0, 80);

  const url =
    "https://api.us.socrata.com/api/catalog/v1?" +
    "domains=data.cityofnewyork.us&search_context=data.cityofnewyork.us" +
    "&only=dataset&limit=12&q=" + encodeURIComponent(q);

  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { query: q, results: [], note: "catalog search unavailable" };
    const data = await r.json();
    const results = (data.results || []).map((it) => {
      const res = it.resource || {};
      const desc = (res.description || "").replace(/\s+/g, " ").trim().slice(0, 280);
      return {
        title: res.name || "(untitled)",
        url: it.permalink || it.link || (res.id ? `https://data.cityofnewyork.us/d/${res.id}` : ""),
        description: desc,
        updated: (res.updatedAt || "").slice(0, 10),
      };
    });
    return { query: q, results };
  } catch (e) {
    return { query: q, results: [], note: "catalog search failed" };
  }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
