// Generate embeddings via Workers AI (BGE base, 768 dimensions).
//
// We embed the title + one-liner so the dedup similarity check is comparing
// "what this post is about" not raw HN body text (which can be noisy).
//
// 768 dims matches the Vectorize index we created with --dimensions=768.

import type { Env } from "../env";

const MODEL = "@cf/baai/bge-base-en-v1.5";

export async function embed(env: Env, text: string): Promise<number[]> {
	const result = (await env.AI.run(MODEL, {
		text: [text.slice(0, 512)], // BGE has a 512-token context limit
	})) as { data: number[][] };

	if (!result.data || !result.data[0]) {
		throw new Error("Embedding failed: empty response");
	}
	return result.data[0];
}
