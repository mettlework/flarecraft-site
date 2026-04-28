# FlareCraft

> **A daily AI-curated briefing of what developers are shipping on Cloudflare — built end-to-end on the Cloudflare developer platform.**

Live at [**flarecraft.dev**](https://flarecraft.dev). Daily email digest sent each morning.

---

## Why this exists

FlareCraft is my hands-on evaluation of the Cloudflare developer platform — built using the platform itself.

A daily briefing of what developers are shipping on a platform is exactly the kind of work a developer adoption function does. So FlareCraft does that work — composed end-to-end on eight Cloudflare primitives across two Workers. The act of building it is the evaluation; the artifact persists as a useful tool. **The system reporting on the platform is the platform.**

**What the build revealed:**

1. **Composition cost is genuinely low.** Eight primitives in service of one daily-running product, two Workers, ~600 lines of TypeScript. The same shape on AWS would require multiple services, IAM glue between them, and meaningfully more orchestration code.
2. **The defaults punch up.** TLS, anycast routing, CDN caching, observability — all default-on. The surface area a developer has to touch is small.
3. **Fast-moving primitives have rough edges.** Subrequest budgets, tier-gated APIs surfacing at runtime, scaffold tooling lagging the current Wrangler — full inventory in the [frictions section](#honest-tradeoffs-and-known-frictions). These aren't deal-breakers; they're the surface area of a platform shipping fast.
4. **The two-platform handshakes are the differentiator.** Resend's "add domain" flow auto-detected my Cloudflare zone and wrote SPF/DKIM/DMARC records via Cloudflare's API directly. Most cloud platforms can't pull that off because they don't share a credential model with the rest of the developer's stack.

---

## What it does

Every day at 07:00 CT a Cloudflare Cron Trigger fires. A Workflow runs that:

1. **Fetches** the last 24 hours of posts mentioning Cloudflare from two source classes:
   - **Hacker News** (stories + comments) via the Algolia HN API
   - **Reddit** — r/CloudFlare and r/cloudflaredev (whole-sub on-topic), plus search-within-sub for "cloudflare" mentions on r/aws, r/vercel, and r/selfhosted (where the comparison/migration stories live)
2. **Classifies** each post via Workers AI (Llama 3.3 70B with structured JSON output): is this actually about building on the platform, which primitives are involved, what's the angle, and how interesting is it on a 1–5 scale
3. **Embeds** each kept post via Workers AI (BGE base, 768 dims) and queries Vectorize for the nearest neighbor in the existing corpus — if cosine similarity ≥ 0.92, treats it as a semantic duplicate and skips
4. **Persists** survivors to D1, archives raw normalized JSON to R2 keyed by `date/source/id`
5. **Generates "The Cut"** — a daily editorial summary picking the top 3 positives and top 3 negatives via a second Workers AI call, with each line linking back to its source post. Runs above the items list on the site and atop the email digest.
6. **Finalizes** the briefing record with run counts
7. **Sleeps** briefly (a `step.sleep` checkpoint) so the digest step gets a fresh Worker invocation with a clean subrequest budget
8. **Emails** the top items as an HTML digest via Resend, while Beehiiv handles public subscriber capture at `flare-craft.beehiiv.com`

A separate SSR Worker reads from D1 in the request path and renders the live briefing at flarecraft.dev — no rebuild needed when the pipeline updates the data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        flarecraft.dev (Worker)                  │
│  Astro SSR (output: server, @astrojs/cloudflare adapter)        │
│  Reads from D1 in request path                                  │
└────────────────┬────────────────────────────────────────────────┘
                 │ D1 read
                 │
┌────────────────▼────────────────────────────────────────────────┐
│                         D1 (flarecraft)                         │
│  briefings: one row per pipeline run                            │
│  items:     classified posts with primitives/score/angle        │
└────────────────▲────────────────────────────────────────────────┘
                 │ D1 write
                 │
┌────────────────┴────────────────────────────────────────────────┐
│              flarecraft-pipeline (Worker)                       │
│                                                                 │
│  Cron Trigger (0 13 * * *)        POST /run (auth-gated)       │
│         │                                  │                    │
│         └──────────────┬───────────────────┘                    │
│                        ▼                                        │
│           ┌───────────────────────────┐                         │
│           │  FlareCraftPipeline       │  Workflow class         │
│           │  (WorkflowEntrypoint)     │  durable execution      │
│           │                           │  per-step retries       │
│           │  ┌──────────────────────┐ │                         │
│           │  │ create-briefing      │ │                         │
│           │  └──────────────────────┘ │                         │
│           │  ┌──────────────────────┐ │                         │
│           │  │ fetch-hn (Algolia)   │ │                         │
│           │  └──────────────────────┘ │                         │
│           │  ┌──────────────────────┐ │                         │
│           │  │ classify+persist     │ │                         │
│           │  │   ↓                  │ │                         │
│           │  │   AI classify        │ │  Workers AI             │
│           │  │   AI embed           │ │  Workers AI             │
│           │  │   Vectorize dedup    │ │  Vectorize              │
│           │  │   D1 insert          │ │  D1                     │
│           │  │   R2 archive         │ │  R2                     │
│           │  └──────────────────────┘ │                         │
│           │  ┌──────────────────────┐ │                         │
│           │  │ finalize-briefing    │ │                         │
│           │  └──────────────────────┘ │                         │
│           │  ┌──────────────────────┐ │                         │
│           │  │ send-digest (Resend) │ │  Resend (3rd party)     │
│           │  └──────────────────────┘ │                         │
│           └───────────────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
```

### Cloudflare primitives used

| Primitive | Role |
|---|---|
| **Workers** | Two: site (SSR) and pipeline. Same runtime, different roles. |
| **Workflows** | Durable orchestration of the daily pipeline. Each step is a checkpointed `step.do` with its own retry policy. A Worker crash mid-run resumes at the last completed step. |
| **Cron Triggers** | Daily 07:00 CT schedule (`0 12 * * *` UTC), registered as one line in `wrangler.jsonc`. |
| **Workers AI — Llama 3.3 70B** | Classification with structured JSON output (`response_format: json_schema`) — no parse brittleness. |
| **Workers AI — BGE Base (768d)** | Embeddings of `title + one_liner` for semantic dedup. |
| **Vectorize** | Stores the embedding corpus. New posts query top-1 nearest neighbor; cosine ≥ 0.92 → duplicate. |
| **D1** | Two tables: `briefings` (one row per run) and `items` (classified posts). Pipeline writes; site reads. |
| **R2** | Egress-free archive of raw post JSON, keyed by date/source/id. The corpus can be re-classified later when prompt or model improves, without re-fetching from HN. |
| **Pages / Static Assets** | Site is server-rendered on a Worker via `@astrojs/cloudflare`. Static assets served by the same Worker via the `ASSETS` binding. Static and dynamic in one project. |

External dependencies:
- **Beehiiv** — public subscribe page at `flare-craft.beehiiv.com`. Audience layer (the *who*: subscribers, growth, archive, list management).
- **Resend** — transactional email transport. Single POST per send, no SDK weight.

The dual-platform split is deliberate: Beehiiv's programmatic publish API is gated to enterprise tier, which surfaced as a 403 at runtime. Rather than pay $39/mo for an unjustified primitive, the architecture separates audience capture (Beehiiv) from delivery (Resend) — which is how many real newsletter products operate. Subscribers join via Beehiiv; the daily digest goes out via Resend. The bridge between them — sync Beehiiv subscribers → Resend audience and send to the list — is a single function in `pipeline/src/lib/`, queued for v2.

---

## Choices I deliberately didn't make

- **Cloudflare Agents SDK.** Considered and rejected. Agents SDK is shaped for stateful chat/tool-use agents on top of Durable Objects. FlareCraft is a stateless scheduled pipeline — Workflows is the correct abstraction. Picking a primitive because it's trendy is anti-signal.
- **Hash-on-URL deduplication.** Cheaper, but lets near-duplicates through. Vectorize embedding similarity catches the case where the same launch gets posted across multiple HN threads — semantic redundancy, which is the actual shape of the dedup problem.
- **Per-post Workflow steps.** Tempting (clean checkpoints!), but each step is a state-machine transition with metadata overhead. For batch processing the Cloudflare-recommended pattern is the inner loop inside one `step.do` and outer steps marking phases.
- **dev.to and Lobsters ingestion.** Scoped out for v1 to ship clean. The schema is already source-agnostic; adding a source is a single function in `pipeline/src/lib/` returning `SourcePost[]`. (Hacker News and five Reddit subs are live.)
- **Browser Rendering.** Most HN posts that matter are link posts; title plus an excerpt is enough signal. Browser Rendering would add latency and cost without clear recall gains at this scale.
- **One Worker doing everything.** Astro v6's `@astrojs/cloudflare` adapter doesn't natively host a Workflow class export, which forces a two-Worker split. The cleaner production pattern is honest separation anyway.

## Honest tradeoffs and known frictions

- The classification prompt is one-shot. A reflection / verifier pass would cut false positives but doubles inference cost — worth adding if score-3 items prove noisy after a week of data.
- The 0.92 dedup threshold is empirical, not validated against held-out data.
- **Real DX frictions hit during the build**, included for honesty:
  - Wrangler v3 (installed by the official `create-cloudflare` scaffold) is past EOL — first-day DX surfaces a deprecated tool.
  - Astro v6 silently broke `Astro.locals.runtime.env` in favor of `import { env } from "cloudflare:workers"` — only visible at runtime, no build-time warning.
  - Workers AI's `response_format: json_schema` returns one of three different shapes depending on model — `{response: string}`, `{response: object}`, or the bare object. Caller has to coerce.
  - Vectorize's `returnMetadata` parameter accepts `"none" | "indexed" | "all"`, not booleans — type errors only at runtime.
  - Wrangler 4's experimental auto-provisioning created the missing `SESSION` KV namespace on the fly during deploy — beautiful when it works; could surprise a less attentive deployer.
  - The `@astrojs/cloudflare` adapter tree-shakes `cloudflare:workers` env imports out of pages that don't reference env directly, even when a child layout component does — causing a runtime `ReferenceError: env is not defined` only on those pages. Fix: anchor with a real `env.X` read in each page's frontmatter. Subtle bug; only visible in production.
  - Workers Free's 50 subrequest/invocation limit pooled across the entire workflow run, not per `step.do` as I'd assumed. The `send-digest` step inherited an exhausted budget. Fix: a `step.sleep` checkpoint before digest forces a fresh invocation. Belt-and-suspenders: also upgraded to Workers Paid for the 1,000 subrequest ceiling.
  - Beehiiv's Posts API (programmatic publish) is enterprise-tier-only. The runtime 403 forced the Beehiiv-for-audience + Resend-for-send split — which turned out to be the more honest architecture.
  - Workflow `step.do` callbacks return `void`, but a long-running step that hits an internal Workflow runtime error retries with the same `step.do` name; on retry the step's prior `console.log` output is lost from the dashboard view (only the retry shows). Made debugging the first kept-count-zero run slower than necessary.
  - The `finalize-briefing` step succeeded according to the Workflow dashboard but its D1 UPDATE didn't actually land in this run — possibly a transactional artifact of the retry. Added `/regenerate-summary` and a manual SQL patch for recovery; in production I'd want a verifier step that reads back the row after `finalize-briefing` and retries on mismatch.
  - **A pleasant surprise to balance the friction list:** Resend's domain-add flow detected my Cloudflare zone and added the SPF/DKIM/DMARC records via Cloudflare's API directly — no manual DNS work. That's the kind of two-platform handshake that makes a real friction step disappear.

These aren't complaints; they're the surface area of a fast-moving platform mid-consolidation. Naming them is part of the job.

---

## Repo layout

```
flarecraft-site/
├── src/                       # Astro SSR site
│   ├── components/Layout.astro
│   ├── lib/db.ts              # D1 readers
│   └── pages/
│       ├── index.astro        # Today's briefing
│       ├── about.astro        # Architecture write-up
│       ├── archive/index.astro
│       └── briefing/[id].astro
├── pipeline/                  # Pipeline Worker
│   ├── wrangler.jsonc         # Bindings: D1, Vectorize, AI, R2, Workflows, Cron
│   └── src/
│       ├── worker.ts          # Entry: fetch + scheduled + Workflow export
│       ├── workflow.ts        # FlareCraftPipeline (WorkflowEntrypoint)
│       ├── env.ts
│       └── lib/
│           ├── hn.ts          # Algolia HN client
│           ├── reddit.ts      # Reddit public JSON API (5 subreddits)
│           ├── classify.ts    # Workers AI classification (Llama 3.3 70B)
│           ├── summary.ts     # Workers AI editorial summary (top 3 + / 3 −)
│           ├── embed.ts       # Workers AI embeddings (BGE base, 768d)
│           ├── dedup.ts       # Vectorize dedup
│           ├── persist.ts     # D1 + R2 writers
│           └── digest.ts      # Resend email
├── schema.sql                 # D1 schema
├── astro.config.mjs           # Cloudflare adapter, output: server
└── wrangler.jsonc             # Site Worker config
```

## Local dev / deploy

```bash
# Site Worker (SSR)
npm install
npm run build
npx wrangler deploy

# Pipeline Worker
cd pipeline
npx wrangler deploy --config ./wrangler.jsonc

# Apply D1 schema (one time)
npx wrangler d1 execute flarecraft --remote --file=./schema.sql

# Trigger a manual pipeline run
curl -X POST https://flarecraft-pipeline.<subdomain>.workers.dev/run \
  -H "Authorization: Bearer $PIPELINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hoursBack": 24, "skipEmail": false}'

# Republish the most recent briefing's email (e.g. after a delivery failure)
curl -X POST https://flarecraft-pipeline.<subdomain>.workers.dev/republish-latest \
  -H "Authorization: Bearer $PIPELINE_AUTH_TOKEN"

# Regenerate the summary for a specific briefing
curl -X POST "https://flarecraft-pipeline.<subdomain>.workers.dev/regenerate-summary?briefing=brf-..." \
  -H "Authorization: Bearer $PIPELINE_AUTH_TOKEN"
```

## Extending

To add a new source (dev.to, Lobsters, RSS, etc.):

1. Add `pipeline/src/lib/<source>.ts` exporting `() => Promise<SourcePost[]>`
2. Call it from `workflow.ts`'s `fetch-sources` step alongside `fetchHN()` and `fetchReddit()`, concatenate
3. The schema is already source-agnostic — classifications, embeddings, and the summary flow unchanged. Add the new value to the `SourceName` type union in `pipeline/src/env.ts`.

---

Built by **Andrew Moore** — Founder, Product Executive, and Builder. Learn more about current and prior work at [linkedin.com/in/richardandrewmoore](https://www.linkedin.com/in/richardandrewmoore/). The portfolio of attempts that led here is in the git log; the artifact you can use is here.
