// Semantic deduplication via Vectorize.
//
// Strategy:
// 1. Embed the post's title + one-liner.
// 2. Query Vectorize for the nearest neighbor across all prior posts.
// 3. If cosine similarity > THRESHOLD, treat as a duplicate and skip.
// 4. Otherwise, insert the new vector + return false (not duplicate).
//
// Why semantic dedup not URL/hash dedup: Cloudflare news often gets
// posted multiple times across different threads (e.g. a launch announce
// and a follow-up discussion). Hash-on-URL would let both through;
// embedding similarity catches them as semantically the same item.
//
// Threshold tuning: 0.92 chosen empirically as the bar where two posts
// feel "redundant" rather than "related". Easy to revisit.

import type { Env } from "../env";

const SIMILARITY_THRESHOLD = 0.92;

export interface DedupResult {
	isDuplicate: boolean;
	matchedId?: string;
	score?: number;
}

export async function dedupAndRegister(
	env: Env,
	id: string,
	embedding: number[],
	metadata: Record<string, string | number>,
): Promise<DedupResult> {
	// 1. Query for nearest existing vector
	const matches = await env.VECTORIZE.query(embedding, {
		topK: 1,
		returnMetadata: "none",
	});

	if (matches.matches.length > 0 && matches.matches[0]) {
		const top = matches.matches[0];
		if (top.score >= SIMILARITY_THRESHOLD) {
			return {
				isDuplicate: true,
				matchedId: top.id,
				score: top.score,
			};
		}
	}

	// 2. Not a duplicate: insert this vector
	await env.VECTORIZE.insert([
		{
			id,
			values: embedding,
			metadata,
		},
	]);

	return { isDuplicate: false };
}
