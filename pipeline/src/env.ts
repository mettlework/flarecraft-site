// Bindings declared in pipeline/wrangler.jsonc are exposed to the Worker
// at runtime as properties on the `env` object. Declaring this type gives
// us full IntelliSense for env.DB, env.AI, etc., across the codebase.

import type { Workflow } from "cloudflare:workers";

export interface Env {
	// AI inference (classification + embeddings)
	AI: Ai;
	// Vectorize index for semantic dedup
	VECTORIZE: VectorizeIndex;
	// D1 SQLite (briefings + items)
	DB: D1Database;
	// R2 bucket for raw HTML archive (egress-free).
	// Optional during initial setup before R2 is enabled on the account;
	// the pipeline's archive step is try/catch'd to tolerate undefined.
	ARCHIVE?: R2Bucket;
	// Workflow binding for durable pipeline orchestration
	PIPELINE: Workflow;

	// Vars
	DIGEST_RECIPIENT: string;
	DIGEST_SENDER: string;
	SITE_URL: string;

	// Secrets (set via `wrangler secret put`)
	PIPELINE_AUTH_TOKEN: string;
	// Resend — daily digest delivery (Beehiiv handles audience capture
	// at flare-craft.beehiiv.com; sync subscribers → Resend audience is v2).
	RESEND_API_KEY: string;
}

export type SourceName = "hn" | "reddit" | "answer-overflow";

// Shape of items stored in D1 — matches schema.sql
export interface ClassifiedItem {
	id: string;
	briefing_id: string;
	source: SourceName;
	source_id: string;
	url: string;
	title: string;
	author: string | null;
	posted_at: number | null;
	is_about_cf: 0 | 1;
	primitives: string; // JSON
	score: number;
	one_liner: string;
	angle: string;
	resolved: 0 | 1 | null; // Q&A items only; NULL for non-Q&A sources
	embedding_id: string | null;
	archived_key: string | null;
	created_at: number;
}

// AI classification output (parsed from JSON response)
export interface Classification {
	is_about_cf: boolean;
	primitives: string[];
	score: number; // 1-5
	one_liner: string;
	angle:
		| "production-story"
		| "perf-win"
		| "OSS"
		| "launch"
		| "tutorial"
		| "critique"
		| "community"
		| "q-and-a"
		| "misc";
}

// Normalized post from any source
export interface SourcePost {
	source: SourceName;
	source_id: string;
	url: string;
	title: string;
	body: string; // raw text for classification context
	author: string | null;
	posted_at: number; // ms
	// AO threads carry pre-classified resolution state (solution !== null).
	// We pass it through here so persist.ts can write it without an AI call.
	resolved?: 0 | 1 | null;
	// AO threads include the channel they were posted in. Useful editorial meta.
	channel?: string;
}

// Briefing summary shape — v1.2: each entry carries the resolved url so
// renderers don't need to do their own title→url lookup (which was fragile
// because the AI editorializes titles when summarizing — strips prefixes
// like "[r/CloudFlare]" and "Comment on:" — breaking exact-title matches).
export interface SummaryEntry {
	title: string;
	line: string;
	url: string; // resolved server-side from candidate index; "" if not resolvable
}
export interface BriefingSummary {
	positives: SummaryEntry[];
	negatives: SummaryEntry[];
	questions: SummaryEntry[];
}

