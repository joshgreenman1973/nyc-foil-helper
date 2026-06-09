# NYC Records Request Helper

Turn a plain-language description of what you want from New York City government into a
legally sound **Freedom of Information Law (FOIL)** request: the tool picks the right agency,
drafts an airtight request letter, and gives you a ready-to-file draft.

- **Front end:** one static `index.html` (deploys to GitHub Pages).
- **Brains:** a Cloudflare Worker that proxies to the Anthropic API so the API key is never
  exposed in the browser.
- **Routing:** `agencies.json`, a curated directory of NYC agencies and the records they hold.
  Every NYC agency receives FOIL requests through the central
  [OpenRecords portal](https://a860-openrecords.nyc.gov/), which is the verified channel the
  tool routes to.

## How it works

1. User describes what they want in plain English (plus optional name/contact and a fee-waiver toggle).
2. The browser POSTs the request + the agency directory to the Worker.
3. The Worker asks Claude (Sonnet) to (a) choose the agency from the directory, (b) draft a
   NY FOIL letter citing Public Officers Law Art. 6 §§84–90, and (c) format it as an email.
   It returns structured JSON via a tool call.
4. The page shows the chosen agency + confidence, an editable letter, and one-click
   **Copy / Open OpenRecords / Draft as email** actions.

## Setup

### 1. Deploy the Worker (one time)

```bash
npm install -g wrangler          # if you don't have it
cd worker
wrangler login                   # opens a browser to authorize Cloudflare
wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic API key
wrangler deploy
```

Wrangler prints a URL like `https://nyc-foil-helper.<subdomain>.workers.dev`.

### 2. Lock down origins

In `worker/foil-proxy.js`, edit `ALLOWED_ORIGINS` to the GitHub Pages origin you'll publish
to (e.g. `https://joshgreenman1973.github.io`). Re-run `wrangler deploy`.

### 3. Point the front end at the Worker

In `index.html`, set:

```js
const WORKER_URL = "https://nyc-foil-helper.<subdomain>.workers.dev";
```

### 4. Publish the front end

Push to GitHub and enable **Pages** on the repo (Settings → Pages → deploy from branch).

## Cost

- **Cloudflare Workers:** free tier covers 100,000 requests/day — effectively free here.
- **Anthropic API:** one Claude Sonnet call per request, typically a fraction of a cent.
  The Worker has no spend cap of its own; set usage limits in the Anthropic console if you
  expose this publicly.

## Local development

```bash
cd nyc-foil-helper
python3 -m http.server 8190
# open http://localhost:8190
```

`localhost` is already in the Worker's allowed origins. The UI loads and validates without a
Worker; the draft step needs `WORKER_URL` set.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole front end (HTML/CSS/JS, no build step). |
| `agencies.json` | Curated NYC agency → records directory used for routing. |
| `worker/foil-proxy.js` | Cloudflare Worker: holds the API key, calls Claude, returns JSON. |
| `worker/wrangler.toml` | Worker deploy config. |
| `METHODOLOGY.md` | Data sources, FOIL rules encoded, assumptions, and limitations. |

## Not legal advice

This produces an AI-generated draft to save time. Users should review it, fill any
`[bracketed]` placeholders, and confirm the agency. See `METHODOLOGY.md` for limitations.
