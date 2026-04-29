// Classify a SourcePost using Workers AI (Llama 3.3 70B).
//
// We use structured JSON output (response_format: json_schema) so we don't
// have to parse free-form model output. The schema enforces the exact fields
// we need for downstream storage.
//
// Choice of model: 70B over 8B because classification quality matters more
// than latency for a daily-cron workload, and per-token cost on Workers AI
// is negligible at our volume (~50 items/day).

import type { Classification, Env, SourcePost } from "../env";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are an editor for FlareCraft, a daily briefing on what developers are shipping using the Cloudflare developer platform.

Given a post from one of three sources — Hacker News, Reddit, or Cloudflare's official Discord (via AnswerOverflow) — you decide whether it's actually about USING Cloudflare's developer platform (Workers, Pages, R2, D1, KV, Durable Objects, Workers AI, Vectorize, Workflows, Queues, Email Workers, AI Gateway, Browser Rendering, Hyperdrive) — and if so, how interesting it is to a developer adoption audience.

Marketing news, infosec coverage, and incidental mentions don't count — only posts where someone is actually building, using, critiquing, asking about, or teaching the platform.

Discord support threads from the official Cloudflare server are usually about real platform usage and should generally pass the is_about_cf filter unless they're truly off-topic. They're typically Q&A-shaped — the right angle is "q-and-a" unless the post is structurally a launch, critique, or production story dressed up as a question.

You always respond with strict JSON matching the provided schema. No prose.`;

const SCHEMA = {
	type: "object",
	properties: {
		is_about_cf: {
			type: "boolean",
			description:
				"True if the post is genuinely about building on or using Cloudflare's developer platform.",
		},
		primitives: {
			type: "array",
			items: {
				type: "string",
				enum: [
					"Workers",
					"Pages",
					"R2",
					"D1",
					"KV",
					"Durable Objects",
					"Workers AI",
					"Vectorize",
					"Workflows",
					"Queues",
					"Email Workers",
					"AI Gateway",
					"Browser Rendering",
					"Hyperdrive",
					"Stream",
					"Images",
					"Zero Trust",
					"Other",
				],
			},
			description: "Cloudflare primitives mentioned or used in the post.",
		},
		score: {
			type: "integer",
			minimum: 1,
			maximum: 5,
			description:
				"Interestingness for a developer adoption audience. 1=mundane mention, 3=worth a glance, 5=major launch / impressive build / critique worth amplifying.",
		},
		one_liner: {
			type: "string",
			description:
				"1-2 sentence summary of what the post is about, written for a dev-adoption lens. Max 240 chars.",
		},
		angle: {
			type: "string",
			enum: [
				"production-story",
				"perf-win",
				"OSS",
				"launch",
				"tutorial",
				"critique",
				"community",
				"q-and-a",
				"misc",
			],
			description: "The kind of post this is. Use 'q-and-a' for support-pattern threads (questions about how to use a primitive, troubleshooting requests, etc.) — common from Discord. Use 'critique' even for question-shaped posts if the underlying tone is clearly negative about the platform.",
		},
	},
	required: ["is_about_cf", "primitives", "score", "one_liner", "angle"],
} as const;

export async function classify(
	env: Env,
	post: SourcePost,
): Promise<Classification> {
	const userMessage = `Title: ${post.title}
URL: ${post.url}
Source: Hacker News (${post.source_id})
Author: ${post.author ?? "unknown"}

Content:
${post.body.slice(0, 1500)}`;

	const response = (await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: userMessage },
		],
		response_format: {
			type: "json_schema",
			json_schema: SCHEMA,
		},
		max_tokens: 400,
	})) as unknown;

	// Workers AI returns one of three shapes depending on model + format:
	//   1. The parsed object directly: { is_about_cf: ..., ... }
	//   2. { response: "<json string>" }
	//   3. { response: { ... already parsed ... } }
	// Coerce to (1) regardless.
	let parsed: Classification;
	if (response && typeof response === "object") {
		const r = response as Record<string, unknown>;
		if ("response" in r) {
			const inner = r.response;
			parsed =
				typeof inner === "string"
					? (JSON.parse(inner) as Classification)
					: (inner as Classification);
		} else {
			parsed = response as Classification;
		}
	} else {
		throw new Error(
			`Unexpected AI response shape: ${typeof response} ${String(response)}`,
		);
	}

	// Defensive normalization (the model occasionally returns extra fields)
	return {
		is_about_cf: Boolean(parsed.is_about_cf),
		primitives: Array.isArray(parsed.primitives) ? parsed.primitives : [],
		score: Math.max(1, Math.min(5, parsed.score ?? 3)),
		one_liner: (parsed.one_liner ?? "").slice(0, 240),
		angle: parsed.angle ?? "misc",
	};
}
