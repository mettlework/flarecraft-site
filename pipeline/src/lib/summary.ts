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

Given a list of classified items from the last 24 hours (plus the past week of Discord activity), you write the day's editorial summary in three sections:
- the top 3 most positive developments (launches, wins, impressive builds)
- the top 3 most concerning items (critiques, friction, outage stories)
- the top 3 most editorially-interesting questions developers are asking (from the Cloudflare Discord)

For each item you select, write ONE crisp editorial sentence (max 28 words) capturing why a developer adoption audience should care. Use plain prose, not marketing copy. Reference Cloudflare primitives by name when relevant. For questions, framing should be observational ("Several developers are wrestling with X") not transactional.

Always respond with strict JSON matching the schema. Never include items not present in the input.

If there are fewer than 3 items in any category, return what you have (do not invent).`;

const SCHEMA = {
	type: "object",
	properties: {
		positives: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					title: { type: "string", description: "Exact title of the source item" },
					line: { type: "string", description: "1-sentence editorial summary, max 28 words" },
				},
				required: ["title", "line"],
			},
		},
		negatives: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					line: { type: "string" },
				},
				required: ["title", "line"],
			},
		},
		questions: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					title: { type: "string", description: "Exact title of a Q&A thread" },
					line: { type: "string", description: "1-sentence editorial framing of what the community is asking, max 28 words" },
				},
				required: ["title", "line"],
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

	let parsed: BriefingSummary;
	if (response && typeof response === "object") {
		const r = response as Record<string, unknown>;
		if ("response" in r) {
			const inner = r.response;
			parsed =
				typeof inner === "string"
					? (JSON.parse(inner) as BriefingSummary)
					: (inner as BriefingSummary);
		} else {
			parsed = response as BriefingSummary;
		}
	} else {
		throw new Error(`Unexpected AI summary response: ${String(response)}`);
	}

	return {
		positives: Array.isArray(parsed.positives) ? parsed.positives.slice(0, 3) : [],
		negatives: Array.isArray(parsed.negatives) ? parsed.negatives.slice(0, 3) : [],
		questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [],
	};
}
