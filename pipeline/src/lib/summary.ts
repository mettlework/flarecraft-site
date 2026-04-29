// Generate the daily editorial summary — top 3 positives + top 3 negatives
// from a briefing's classified items, via Workers AI.
//
// We send the model the items pre-filtered: positives candidates are
// launches/wins/production stories; negatives candidates are critiques and
// outage/friction posts. Model picks the top 3 from each and writes a
// 1-sentence editorial line per item.

import type { BriefingSummary, ClassifiedItem, Env } from "../env";

function parsePrimitives(raw: string): string[] {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const POSITIVE_ANGLES = new Set([
	"launch",
	"production-story",
	"perf-win",
	"OSS",
	"tutorial",
]);
const NEGATIVE_ANGLES = new Set(["critique"]);
const QUESTION_ANGLES = new Set(["q-and-a"]);

const SYSTEM_PROMPT = `You are the editor of FlareCraft, a daily briefing of what developers are shipping on the Cloudflare developer platform.

Given numbered lists of classified items, you write the day's editorial summary in three sections:
- the top 3 most positive developments (launches, wins, impressive builds)
- the top 3 most concerning items (critiques, friction, outage stories)
- the top 3 most editorially-interesting questions developers are asking (from the Cloudflare Discord)

For each item you select, return its INDEX (the leading number in the input list — 1, 2, 3, ...) and ONE crisp editorial sentence (max 28 words) capturing why a developer adoption audience should care. Use plain prose, not marketing copy. Reference Cloudflare primitives by name when relevant. For questions, framing should be observational ("Several developers are wrestling with X") not transactional.

The index is what links the summary back to the source item — it MUST be the integer at the start of the candidate line. Do not invent items. If there are fewer than 3 items in any category, return what you have.`;

const SCHEMA = {
	type: "object",
	properties: {
		positives: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					index: { type: "integer", description: "1-based index from the POSITIVE CANDIDATES list" },
					line: { type: "string", description: "1-sentence editorial summary, max 28 words" },
				},
				required: ["index", "line"],
			},
		},
		negatives: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					index: { type: "integer", description: "1-based index from the NEGATIVE CANDIDATES list" },
					line: { type: "string" },
				},
				required: ["index", "line"],
			},
		},
		questions: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					index: { type: "integer", description: "1-based index from the QUESTION CANDIDATES list" },
					line: { type: "string", description: "1-sentence editorial framing, max 28 words" },
				},
				required: ["index", "line"],
			},
		},
	},
	required: ["positives", "negatives", "questions"],
} as const;

export async function generateSummary(
	env: Env,
	items: ClassifiedItem[],
): Promise<BriefingSummary> {
	const positiveCandidates = items.filter((i) => POSITIVE_ANGLES.has(i.angle));
	const negativeCandidates = items.filter((i) => NEGATIVE_ANGLES.has(i.angle));
	const questionCandidates = items.filter((i) => QUESTION_ANGLES.has(i.angle));

	// Empty briefing → empty summary, skip the AI call
	if (
		positiveCandidates.length === 0 &&
		negativeCandidates.length === 0 &&
		questionCandidates.length === 0
	) {
		return { positives: [], negatives: [], questions: [] };
	}

	const renderCandidates = (
		cands: ClassifiedItem[],
		extraTag?: (i: ClassifiedItem) => string,
	) =>
		cands.length > 0
			? cands
					.map((i, idx) => {
						const tags = [
							`score ${i.score}/5`,
							`primitives: ${parsePrimitives(i.primitives).join(", ") || "n/a"}`,
						];
						if (extraTag) tags.push(extraTag(i));
						return `${idx + 1}. [${tags.join(", ")}] ${i.title}\n   ${i.one_liner}`;
					})
					.join("\n\n")
			: "(none in this category)";

	const userMessage = `POSITIVE CANDIDATES (launches, wins, production stories, OSS, tutorials):
${renderCandidates(positiveCandidates)}

NEGATIVE CANDIDATES (critiques, outages, friction):
${renderCandidates(negativeCandidates)}

QUESTION CANDIDATES (Discord support patterns from the Cloudflare guild):
${renderCandidates(questionCandidates, (i) => `${i.resolved === 1 ? "resolved" : "open"}`)}

Pick the top 3 from each (or fewer if the list is shorter). For questions, prioritize threads that reveal interesting platform usage patterns or recurring confusion — not one-offs.`;

	const response = (await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: userMessage },
		],
		response_format: { type: "json_schema", json_schema: SCHEMA },
		max_tokens: 600,
	})) as unknown;

	// AI returns indices; server resolves to full ClassifiedItem (title + url
	// authoritative from D1, no editorial drift) and produces the persisted
	// SummaryEntry shape with `url` populated.
	interface IndexedEntry { index: number; line: string }
	interface IndexedAIResult {
		positives?: IndexedEntry[];
		negatives?: IndexedEntry[];
		questions?: IndexedEntry[];
	}

	let parsed: IndexedAIResult;
	if (response && typeof response === "object") {
		const r = response as Record<string, unknown>;
		if ("response" in r) {
			const inner = r.response;
			parsed =
				typeof inner === "string"
					? (JSON.parse(inner) as IndexedAIResult)
					: (inner as IndexedAIResult);
		} else {
			parsed = response as IndexedAIResult;
		}
	} else {
		throw new Error(`Unexpected AI summary response: ${String(response)}`);
	}

	const resolveSection = (
		entries: IndexedEntry[] | undefined,
		candidates: ClassifiedItem[],
	) => {
		if (!Array.isArray(entries)) return [];
		return entries
			.slice(0, 3)
			.map((e) => {
				// AI returns 1-based index; tolerate slight off-by-ones with bounds check
				const idx = Number.isInteger(e.index) ? e.index - 1 : -1;
				const item = idx >= 0 && idx < candidates.length ? candidates[idx] : null;
				if (!item) return null;
				return {
					title: item.title,
					line: e.line ?? "",
					url: item.url,
				};
			})
			.filter((x): x is { title: string; line: string; url: string } => x !== null);
	};

	return {
		positives: resolveSection(parsed.positives, positiveCandidates),
		negatives: resolveSection(parsed.negatives, negativeCandidates),
		questions: resolveSection(parsed.questions, questionCandidates),
	};
}
