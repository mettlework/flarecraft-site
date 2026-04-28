// Reddit ingestion via Reddit's public JSON API.
//
// Strategy:
// - For Cloudflare's own subs, fetch /new.json (the whole sub is on-topic).
// - For competitor / adjacent subs, search-within-sub for "cloudflare" mentions.
//   Those are the migration / comparison / critique posts — high editorial value.
//
// No auth needed for public listing/search endpoints. We send a User-Agent
// per Reddit's API guidelines; aggressive scraping will get rate-limited.
//
// Reddit returns max 25 hits per page; we cap each sub at 10 to keep the
// per-pipeline subrequest budget sane.

import type { SourcePost } from "../env";

interface SubredditConfig {
	name: string;
	mode: "all" | "search";
}

const SUBREDDITS: SubredditConfig[] = [
	{ name: "CloudFlare", mode: "all" }, // entire sub on-topic
	{ name: "cloudflaredev", mode: "all" }, // entire sub on-topic
	{ name: "aws", mode: "search" }, // CF mentions = comparison/migration
	{ name: "vercel", mode: "search" }, // CF is the immediate alternative
	{ name: "selfhosted", mode: "search" }, // CF Tunnels, R2 use cases
];

const PER_SUB_LIMIT = 10;
const USER_AGENT = "FlareCraft/1.0 (+https://flarecraft.dev)";

interface RedditChild {
	data: {
		id: string;
		permalink: string;
		title: string;
		selftext?: string;
		author: string;
		created_utc: number;
		subreddit: string;
		score?: number;
		num_comments?: number;
	};
}

interface RedditListing {
	data?: { children?: RedditChild[] };
}

export async function fetchReddit(hoursBack: number = 24): Promise<SourcePost[]> {
	const cutoffMs = Date.now() - hoursBack * 60 * 60 * 1000;
	const all: SourcePost[] = [];

	for (const sub of SUBREDDITS) {
		try {
			const url =
				sub.mode === "all"
					? `https://www.reddit.com/r/${sub.name}/new.json?limit=${PER_SUB_LIMIT}`
					: `https://www.reddit.com/r/${sub.name}/search.json?q=cloudflare&restrict_sr=1&sort=new&t=week&limit=${PER_SUB_LIMIT}`;

			const res = await fetch(url, {
				headers: { "User-Agent": USER_AGENT },
			});

			if (!res.ok) {
				console.warn(
					`Reddit fetch failed for r/${sub.name}: ${res.status} ${res.statusText}`,
				);
				continue;
			}

			const data = (await res.json()) as RedditListing;
			const children = data.data?.children ?? [];

			for (const child of children) {
				const p = child.data;
				const postedAt = p.created_utc * 1000;
				if (postedAt < cutoffMs) continue;

				// Body for classification: prefer selftext if present, fall back to title.
				// Cap at 2000 chars to stay well under model context budget.
				const body = (p.selftext || p.title).slice(0, 2000);

				all.push({
					source: "reddit",
					source_id: p.id,
					url: `https://www.reddit.com${p.permalink}`,
					title: `[r/${p.subreddit}] ${p.title}`,
					body,
					author: p.author,
					posted_at: postedAt,
				});
			}
		} catch (err) {
			// Per-sub errors don't fail the whole ingestion
			console.warn(`Reddit error for r/${sub.name}:`, err);
		}
	}

	return all;
}
