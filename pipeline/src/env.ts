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
	RESEND_API_KEY: string;
	PIPELINE_AUTH_TOKEN: string;
}

// Shape of items stored in D1 — matches schema.sql
export interface ClassifiedItem {
	id: string;
	briefing_id: string;
	source: "hn";
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
		| "misc";
}

// Normalized post from any source (HN today, more later)
export interface SourcePost {
	source: "hn";
	source_id: string;
	url: string;
	title: string;
	body: string; // raw text for classification context
	author: string | null;
	posted_at: number; // ms
}
