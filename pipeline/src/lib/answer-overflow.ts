// AnswerOverflow ingestion via their public MCP server.
//
// The Cloudflare Developers Discord guild (89,684 members, server id
// 595317990191398933) is indexed by AnswerOverflow, which exposes a
// public MCP server at https://www.answeroverflow.com/mcp.
//
// We can't scrape AO's web pages from a Worker — they're behind Vercel's
// security challenge. MCP is the legitimate, officially-endorsed path.
//
// MCP protocol notes:
// - JSON-RPC 2.0 over HTTP, response in SSE format (event: message\ndata: {...})
// - We do a one-shot initialize handshake per call (stateless server)
// - tools/call wraps the actual tool invocation
//
// Tool surface available:
// - search_answeroverflow(query, serverId, limit) — relevance-sorted thread search
// - search_servers(query, limit) — find indexed servers
// - get_thread_messages(threadId, limit) — full thread conversation
// - find_similar_threads(query, serverId, limit) — semantic similarity search
//
// Strategy:
// - Run a battery of platform-keyword queries scoped to Cloudflare's serverId
// - Each search is relevance-sorted (not time-sorted) so we filter post-hoc
//   by recency (7-day window — Discord is a weekly-pulse signal, not daily)
// - Dedup by threadId across queries
// - Pre-classification: derive `resolved` from MCP's `solution` field
//   (null → unresolved, non-null → resolved)
// - Title format: "[#channel] question_preview" so the channel context is
//   visible everywhere the title surfaces

import type { SourcePost } from "../env";

const MCP_ENDPOINT = "https://www.answeroverflow.com/mcp";
const CLOUDFLARE_SERVER_ID = "595317990191398933";
const USER_AGENT = "FlareCraft/1.0 (+https://flarecraft.dev)";

// Platform keyword battery — broad enough to surface a week's discussion
// across the major primitives, narrow enough to stay on-topic for a
// developer-platform briefing. ~10 queries × 25 results = 250 candidates,
// most filtered out by recency.
const QUERIES = [
	"workers",
	"durable objects",
	"d1",
	"workers ai",
	"vectorize",
	"workflows",
	"r2",
	"queues",
	"kv",
	"pages",
];

interface AOSearchResult {
	threadId: string;
	messageId: string;
	serverName: string;
	channelName: string;
	channelId: string;
	question: {
		content: string;
		author: string;
		timestamp: string; // ISO 8601
	};
	solution: { content?: string; author?: string } | null;
	url: string;
	serverId: string;
	serverMemberCount?: number;
}

/**
 * Parse SSE response body into JSON-RPC result objects.
 * Each MCP response arrives as: `event: message\ndata: {...}\n\n`
 */
function parseSseResponse(body: string): unknown {
	const lines = body.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			try {
				return JSON.parse(line.slice(6));
			} catch {
				// fall through, try next data line
			}
		}
	}
	throw new Error("MCP: no parseable data line in SSE response");
}

/**
 * Call an MCP tool. Returns the parsed result content.
 */
async function callTool(
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await fetch(MCP_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Date.now(),
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
	});

	if (!res.ok) {
		throw new Error(`MCP ${toolName} HTTP ${res.status} ${res.statusText}`);
	}

	const text = await res.text();
	const parsed = parseSseResponse(text) as {
		result?: { content?: Array<{ type: string; text: string }> };
		error?: { message: string };
	};

	if (parsed.error) {
		throw new Error(`MCP ${toolName} error: ${parsed.error.message}`);
	}

	// Tool responses come back as a content array with a single text item
	// holding stringified JSON. Parse that out.
	const textContent = parsed.result?.content?.[0]?.text;
	if (!textContent) {
		throw new Error(`MCP ${toolName}: no text content in response`);
	}
	return JSON.parse(textContent);
}

/**
 * Fetch recent threads from the Cloudflare Discord via AO's MCP server.
 * Returns SourcePost[] ready for classification.
 *
 * Note: AO uses 7-day window by default for Discord (weekly-pulse, not daily)
 * because search is relevance-sorted, not time-sorted — narrow time windows
 * starve the result set.
 */
export async function fetchAnswerOverflow(
	hoursBack: number = 168,
): Promise<SourcePost[]> {
	const cutoffMs = Date.now() - hoursBack * 60 * 60 * 1000;
	const seen = new Set<string>(); // dedup by threadId across queries
	const all: SourcePost[] = [];

	for (const query of QUERIES) {
		try {
			const response = (await callTool("search_answeroverflow", {
				query,
				serverId: CLOUDFLARE_SERVER_ID,
				limit: 25,
			})) as { results?: AOSearchResult[] };

			const results = response.results ?? [];

			for (const r of results) {
				if (seen.has(r.threadId)) continue;
				seen.add(r.threadId);

				const postedAt = new Date(r.question.timestamp).getTime();
				if (postedAt < cutoffMs) continue; // outside window
				if (Number.isNaN(postedAt)) continue; // bad timestamp

				const channel = r.channelName ?? "discord";
				// Question content can have embedded URLs, line breaks, code blocks.
				// For the title we want a single-line plain-text excerpt.
				const questionContent = r.question.content?.trim() ?? "";
				const cleanedForTitle = questionContent
					.replace(/```[\s\S]*?```/g, " ") // strip code blocks
					.replace(/https?:\/\/\S+/g, "") // strip URLs
					.replace(/\s+/g, " ") // collapse whitespace (incl. newlines) to single space
					.trim();
				const titleQuestion =
					cleanedForTitle.length > 120
						? `${cleanedForTitle.slice(0, 117)}...`
						: cleanedForTitle;
				const title = `[#${channel}] ${titleQuestion || "(thread)"}`;

				// Body for the classifier — give it the full question + solution
				// preview if any. AO's search response includes the question content
				// and a solution preview if marked.
				const bodyParts = [questionContent];
				if (r.solution?.content) {
					bodyParts.push(`\n\nSolution: ${r.solution.content}`);
				}
				const body = bodyParts.join("").slice(0, 2000);

				all.push({
					source: "answer-overflow",
					source_id: r.threadId,
					url: r.url,
					title,
					body,
					author: r.question.author,
					posted_at: postedAt,
					resolved: r.solution !== null ? 1 : 0,
					channel,
				});
			}
		} catch (err) {
			// Per-query errors don't fail the whole fetch
			console.warn(`AO query "${query}" failed:`, err);
		}
	}

	return all;
}
