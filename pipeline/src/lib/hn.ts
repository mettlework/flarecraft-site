// Hacker News ingestion via Algolia's HN search API.
//
// We query the last 24h for stories AND comments mentioning "cloudflare".
// Algolia's API is free, unauthenticated, and well-cached at the edge —
// perfect for a Worker fetch. No SDK needed.
//
// Docs: https://hn.algolia.com/api

import type { SourcePost } from "../env";

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1/search";

interface AlgoliaHit {
	objectID: string;
	title: string | null;
	url: string | null;
	story_url: string | null;
	story_id: number | null;
	story_title: string | null;
	comment_text: string | null;
	author: string;
	created_at_i: number; // unix epoch seconds
	_tags: string[];
}

interface AlgoliaResponse {
	hits: AlgoliaHit[];
	nbHits: number;
}

/**
 * Fetch recent HN posts and comments mentioning Cloudflare.
 * Window: configurable hours back (default 24h).
 * Returns normalized SourcePost objects ready for classification.
 */
export async function fetchHN(hoursBack: number = 24): Promise<SourcePost[]> {
	const sinceSec = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

	const params = new URLSearchParams({
		query: "cloudflare",
		tags: "(story,comment)",
		numericFilters: `created_at_i>${sinceSec}`,
		hitsPerPage: "50",
	});

	const url = `${ALGOLIA_BASE}?${params.toString()}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "FlareCraft/1.0 (+https://flarecraft.dev)" },
	});

	if (!res.ok) {
		throw new Error(`HN/Algolia fetch failed: ${res.status} ${res.statusText}`);
	}

	const data = (await res.json()) as AlgoliaResponse;

	return data.hits
		.map((hit) => normalizeHit(hit))
		.filter((p): p is SourcePost => p !== null);
}

function normalizeHit(hit: AlgoliaHit): SourcePost | null {
	const isStory = hit._tags.includes("story");
	const isComment = hit._tags.includes("comment");

	if (isStory) {
		// Skip stories with no title (rare but possible)
		if (!hit.title) return null;
		return {
			source: "hn",
			source_id: hit.objectID,
			url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
			title: hit.title,
			body: hit.title, // stories have no body in Algolia results; title is signal
			author: hit.author,
			posted_at: hit.created_at_i * 1000,
		};
	}

	if (isComment) {
		if (!hit.comment_text) return null;
		// Use story title for context if available
		const title = hit.story_title
			? `Comment on: ${hit.story_title}`
			: "HN comment";
		// Strip HTML tags from comment text for cleaner classification input
		const body = hit.comment_text.replace(/<[^>]+>/g, " ").slice(0, 2000);
		return {
			source: "hn",
			source_id: hit.objectID,
			url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
			title,
			body,
			author: hit.author,
			posted_at: hit.created_at_i * 1000,
		};
	}

	return null;
}
