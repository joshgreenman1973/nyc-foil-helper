# Methodology & limitations

This document explains exactly what the NYC Records Request Helper does, what data it relies
on, the legal rules it encodes, and where it can be wrong. Nothing here is a black box.

## What the tool produces

For each plain-language request it returns:

1. **A routed agency** — chosen from a curated directory, with a confidence rating and
   one-to-three-sentence reasoning, plus alternative agencies when the records could
   plausibly sit elsewhere.
2. **A FOIL request letter** — drafted by Claude (Anthropic), citing New York's Freedom of
   Information Law and structured to be specific, broadly construed, and exemption-aware.
3. **Filing guidance** — how to actually submit it through NYC OpenRecords or to a named
   records-access officer.

## Data sources

| Source | Used for | Notes |
|--------|----------|-------|
| `agencies.json` (curated) | Agency routing | Hand-built list of ~28 major NYC agencies and the records each holds, based on agencies' published jurisdictions. Last reviewed 2026-06-09. |
| [NYC OpenRecords portal](https://a860-openrecords.nyc.gov/) | Submission channel | The City's central FOIL intake; nearly every NYC agency receives requests here. This is the verified link the tool routes to. |
| [NYC FOIL Officers Directory](https://a860-openrecords.nyc.gov/foil-officers-directory) | Named-officer lookup | Official, City-maintained list of current records-access officers. The tool links users here rather than hardcoding officer emails, which change frequently. |
| Claude (Anthropic API, model `claude-sonnet-4-6`) | Routing + letter drafting | Generates the agency choice and letter text from the user's words and the directory. |

### Why no hardcoded officer emails

Records-access officer names and emails change often, and the City already publishes a
maintained directory. Baking individual addresses into a static file would guarantee stale,
wrong contacts over time. The tool therefore routes to the **verified, always-current**
OpenRecords channel and points users to the official directory for a named officer. This is a
deliberate accuracy choice, not a gap.

## Legal rules encoded in the draft

The letter-drafting prompt instructs the model to:

- Cite **New York FOIL — Public Officers Law, Article 6, §§84–90**.
- Describe records precisely (record types, date range, offices, search terms) while asking
  the agency to **construe the request broadly**.
- Request **electronic format** where records already exist electronically.
- Require that any withholding **cite a specific exemption** (§87(2)) and that all reasonably
  **segregable non-exempt portions** be released (§89(2)).
- Note FOIL's **five-business-day acknowledgment** requirement and the agency's duty to
  provide records or a date certain.
- On request, include a **fee-waiver / fee-limitation** ask, noting the 25¢-per-page copying
  cap and that electronic records carry no per-page fee.
- Use the requester's provided details and mark anything missing with `[BRACKETED]`
  placeholders rather than inventing it.

These mirror the standard structure of an effective public-records request (see the
Reporters Committee for Freedom of the Press and NYCLU FOIL guidance).

## Assumptions

- **Date ranges:** if the user doesn't specify one, the model picks a reasonable window and,
  where natural, names it in the letter as an assumption to adjust.
- **Agency-of-record:** the tool assumes the records sit with a NYC agency in the directory.
  State bodies (e.g. the MTA, NYPD's state-law counterparts, courts) and federal records are
  out of scope and may be mis-routed — see limitations.
- **OpenRecords as default channel:** a few entities (NYCHA, the Board of Elections, EDC) run
  their own records processes; the directory points those to their own pages.

## Limitations — where it can be wrong

- **It is not legal advice.** It is a drafting aid. Users must review every draft.
- **Routing can miss.** If the records belong to a state agency (e.g. MTA, state courts, DMV),
  a public authority, or the federal government, the tool may force-fit a NYC agency. The
  confidence rating and alternative-agency list exist to flag this; "low" confidence means
  check carefully.
- **The model can be over-specific or over-broad.** An over-narrow request can exclude
  responsive records; an over-broad one invites a fee estimate or a "reasonably describe"
  objection. Users should tune the editable letter.
- **No fact verification.** The model only uses what the user typed. It will not (and is
  instructed not to) invent case numbers, events, names, or dates. If the user supplies wrong
  facts, the letter will repeat them.
- **Exemptions still apply.** Drafting a clean request does not entitle anyone to exempt
  records (personal privacy, ongoing law enforcement, inter-agency deliberative material,
  etc.). The draft asks for segregable portions but agencies decide.
- **Directory drift.** Agency holdings and the OpenRecords URL structure can change. The
  directory carries a `lastReviewed` date; re-check periodically.

## Reproducibility

Every routing decision is driven by the contents of `agencies.json` plus the user's text,
and every letter by the prompt in `worker/foil-proxy.js`. Both are plain, readable files in
this repository. The model and parameters (`claude-sonnet-4-6`, `max_tokens` 4000,
`tool_choice` forced to a structured schema) are set in the Worker.
