// D1 + R2 writers.
//
// D1 holds the structured, queryable record of every classified item.
// R2 holds the raw normalized JSON of every source post we processed —
// effectively a replay log. Egress-free storage means we can re-classify
// the entire corpus later if we change our prompt or model, without
// re-fetching from HN.

import type { Classification, Env, SourcePost } from "../env";

export async function createBriefing(
	env: Env,
	briefingId: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO briefings (id, run_started_at, status) VALUES (?, ?, 'running')`,
	)
		.bind(briefingId, Date.now())
		.run();
}

export async function finalizeBriefing(
	env: Env,
	briefingId: string,
	counts: {
		source: number;
		classified: number;
		deduped: number;
		kept: number;
	},
	status: "completed" | "failed",
	error?: string,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE briefings
		 SET run_finished_at = ?, source_count = ?, classified_count = ?,
		     deduped_count = ?, kept_count = ?, status = ?, error = ?
		 WHERE id = ?`,
	)
		.bind(
			Date.now(),
			counts.source,
			counts.classified,
			counts.deduped,
			counts.kept,
			status,
			error ?? null,
			briefingId,
		)
		.run();
}

/**
 * Stable id for an item. Same source+source_id always produces the same id,
 * which lets the items table's PRIMARY KEY do exact-duplicate dedup as a
 * second line of defense after Vectorize semantic dedup.
 */
export function itemId(post: SourcePost): string {
	return `${post.source}-${post.source_id}`;
}

export async function persistItem(
	env: Env,
	briefingId: string,
	post: SourcePost,
	classification: Classification,
	embeddingId: string | null,
	archivedKey: string | null,
): Promise<void> {
	// `resolved` is structural for AO (derived from MCP's solution field).
	// For non-Q&A sources or non-Q&A angles, leave it NULL.
	let resolved: 0 | 1 | null = null;
	if (post.source === "answer-overflow" && classification.angle === "q-and-a") {
		resolved = post.resolved === 1 ? 1 : 0;
	}

	await env.DB.prepare(
		`INSERT OR IGNORE INTO items
		 (id, briefing_id, source, source_id, url, title, author, posted_at,
		  is_about_cf, primitives, score, one_liner, angle, resolved,
		  embedding_id, archived_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			itemId(post),
			briefingId,
			post.source,
			post.source_id,
			post.url,
			post.title,
			post.author,
			post.posted_at,
			classification.is_about_cf ? 1 : 0,
			JSON.stringify(classification.primitives),
			classification.score,
			classification.one_liner,
			classification.angle,
			resolved,
			embeddingId,
			archivedKey,
			Date.now(),
		)
		.run();
}

/**
 * Archive raw normalized post JSON to R2. Keyed by date + source + id
 * so we can scan a day's archive easily.
 */
export async function archivePost(
	env: Env,
	briefingId: string,
	post: SourcePost,
): Promise<string | null> {
	if (!env.ARCHIVE) return null; // R2 not bound yet — skip silently.

	const dateKey = new Date().toISOString().slice(0, 10);
	const key = `${dateKey}/${post.source}/${post.source_id}.json`;

	await env.ARCHIVE.put(
		key,
		JSON.stringify({ briefingId, post }, null, 2),
		{
			httpMetadata: { contentType: "application/json" },
		},
	);

	return key;
}

/**
 * Already-seen check using D1 primary key. Cheaper than an embedding+vector
 * query for posts we've literally already processed by stable id.
 */
export async function alreadySeen(
	env: Env,
	post: SourcePost,
): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT 1 FROM items WHERE id = ? LIMIT 1`,
	)
		.bind(itemId(post))
		.first();
	return row !== null;
}
