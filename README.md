# FlareCraft

> **A daily AI-curated briefing of what developers are shipping on Cloudflare — built end-to-end on the Cloudflare developer platform.**

Live at [**flarecraft.dev**](https://flarecraft.dev). Daily email digest sent each morning.

---

## Why this exists

I built FlareCraft as a working artifact for a VP of Developer Adoption interview process at Cloudflare.

A daily briefing of what developers are shipping on a platform is exactly the kind of work a developer adoption function does. So FlareCraft does that work — using the platform itself. The act of building it is the demonstration; the artifact persists as a useful tool. **The system reporting on the platform is the platform.**

The artifact is intended to signal four things at once:

1. **Platform fluency** — composing eight Cloudflare primitives in service of one product, not just deploying hello-worlds
2. **Taste** — knowing what to build, what to skip, what to defend
3. **Shipping discipline** — production-grade end-to-end in under a day
4. **Strategic empathy** — building something the audience would actually find useful

---

## What it does

Every day at 08:00 CDT a Cloudflare Cron Trigger fires. A Workflow runs that:

1. **Fetches** the last 24 hours of Hacker News posts and comments mentioning Cloudflare via the Algolia HN API
2. **Classifies** each post via Workers AI (Llama 3.3 70B with structured JSON output): is this actually about building on the platform, which primitives are involved, what's the angle, and how interesting is it on a 1–5 scale
3. **Embeds** each kept post via Workers AI (BGE base, 768 dims) and queries Vectorize for the nearest neighbor in the existing corpus — if cosine similarity ≥ 0.92, treats it as a semantic duplicate and skips
4. **Persists** survivors to D1, archives raw normalized JSON to R2 keyed by `date/source/id`
5. **Finalizes** the briefing record with run counts
6. **Emails** the top items as an HTML digest via Resend

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
| **Cron Triggers** | Daily 08:00 CDT schedule, registered as one line in `wrangler.jsonc`. |
| **Workers AI — Llama 3.3 70B** | Classification with structured JSON output (`response_format: json_schema`) — no parse brittleness. |
| **Workers AI — BGE Base (768d)** | Embeddings of `title + one_liner` for semantic dedup. |
| **Vectorize** | Stores the embedding corpus. New posts query top-1 nearest neighbor; cosine ≥ 0.92 → duplicate. |
| **D1** | Two tables: `briefings` (one row per run) and `items` (classified posts). Pipeline writes; site reads. |
| **R2** | Egress-free archive of raw post JSON, keyed by date/source/id. The corpus can be re-classified later when prompt or model improves, without re-fetching from HN. |
| **Pages / Static Assets** | Site is server-rendered on a Worker via `@astrojs/cloudflare`. Static assets served by the same Worker via the `ASSETS` binding. Static and dynamic in one project. |

External dependency: **Resend** for transactional email. Cloudflare's MailChannels arrangement for free outbound email ended in 2024; Resend's API is a single POST so the bundle weight is zero.

---

## Choices I deliberately didn't make

- **Cloudflare Agents SDK.** Considered and rejected. Agents SDK is shaped for stateful chat/tool-use agents on top of Durable Objects. FlareCraft is a stateless scheduled pipeline — Workflows is the correct abstraction. Picking a primitive because it's trendy is anti-signal.
- **Hash-on-URL deduplication.** Cheaper, but lets near-duplicates through. Vectorize embedding similarity catches the case where the same launch gets posted across multiple HN threads — semantic redundancy, which is the actual shape of the dedup problem.
- **Per-post Workflow steps.** Tempting (clean checkpoints!), but each step is a state-machine transition with metadata overhead. For batch processing the Cloudflare-recommended pattern is the inner loop inside one `step.do` and outer steps marking phases.
- **Reddit and dev.to ingestion.** Scoped out of v1 to ship clean. Adding sources is a single function in `pipeline/src/lib/`, returning `SourcePost[]`. The schema is source-agnostic.
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
│           ├── classify.ts    # Workers AI classification
│           ├── embed.ts       # Workers AI embeddings
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
```

## Extending

To add a new source (Reddit, dev.to, RSS):

1. Add `pipeline/src/lib/<source>.ts` exporting `() => Promise<SourcePost[]>`
2. Call it from `workflow.ts`'s fetch step alongside `fetchHN()`, concatenate
3. The schema is already source-agnostic; classifications and embeddings flow unchanged

---

Built by [Andrew Holmes](https://github.com/mettlework). The portfolio of attempts that led here is in the git log; the artifact you can use is here.
