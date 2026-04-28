// FlareCraftPipeline — the durable execution heart of the system.
//
// Cloudflare Workflows give us:
//   1. Automatic retries per step on transient failures
//   2. State checkpointing so a Worker crash mid-run doesn't lose progress
//   3. Full observability — every run, step, retry, and error is visible
//      in the dashboard with replayable history
//
// The shape: one Workflow run per briefing. Steps proceed roughly:
//   fetch → create briefing record → classify+dedup+persist (per item)
//   → finalize briefing → send email digest
//
// Per-item work is intentionally NOT individual workflow steps — that would
// produce hundreds of checkpoints per run and obscure the high-level flow.
// Instead the per-item loop runs inside one step.do, which is the pattern
// CF docs recommend for batch processing.

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";

import type { ClassifiedItem, Env, SourcePost } from "./env";
import { fetchHN } from "./lib/hn";
import { classify } from "./lib/classify";
import { embed } from "./lib/embed";
import { dedupAndRegister } from "./lib/dedup";
import {
	alreadySeen,
	archivePost,
	createBriefing,
	finalizeBriefing,
	itemId,
	persistItem,
} from "./lib/persist";
import { sendDigest } from "./lib/digest";

interface PipelineParams {
	hoursBack?: number;
	skipEmail?: boolean;
}

export class FlareCraftPipeline extends WorkflowEntrypoint<
	Env,
	PipelineParams
> {
	async run(
		event: WorkflowEvent<PipelineParams>,
		step: WorkflowStep,
	): Promise<{ briefingId: string; kept: number }> {
		const briefingId = `brf-${new Date().toISOString().slice(0, 10)}-${shortId()}`;
		const hoursBack = event.payload.hoursBack ?? 24;
		const skipEmail = event.payload.skipEmail ?? false;

		// 1. Initialize the briefing record so even partial runs are visible.
		await step.do("create-briefing", async () => {
			await createBriefing(this.env, briefingId);
			return briefingId;
		});

		// 2. Pull source posts. Retried up to 3x on network blips.
		const posts: SourcePost[] = await step.do(
			"fetch-hn",
			{
				retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
				timeout: "30 seconds",
			},
			async () => fetchHN(hoursBack),
		);

		console.log(`[pipeline] starting classify-and-persist for ${posts.length} posts`);

		// 3. Process each post: classify, embed, dedup, persist.
		// Inside one step.do because per-item checkpointing would be excessive.
		// Step-level retries are conservative (1) because the inner per-item
		// try/catch already isolates failures — we don't want to re-do
		// already-persisted work on a flaky AI call.
		const result = await step.do(
			"classify-and-persist",
			{
				retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
				timeout: "10 minutes",
			},
			async () => {
				let classified = 0;
				let deduped = 0;
				let kept = 0;

				for (let i = 0; i < posts.length; i++) {
					const post = posts[i]!;
					console.log(`[${i + 1}/${posts.length}] ${post.url.slice(0, 80)}`);
					try {
						// Cheap exact-id check first to skip already-seen posts
						if (await alreadySeen(this.env, post)) {
							console.log(`  → already seen, skipping`);
							deduped++;
							continue;
						}

						console.log(`  → classifying...`);
						const cls = await classify(this.env, post);
						classified++;
						console.log(
							`  → is_about_cf=${cls.is_about_cf} score=${cls.score} angle=${cls.angle}`,
						);

						// If the model says it's not actually about CF, drop it.
						if (!cls.is_about_cf) {
							continue;
						}

						console.log(`  → embedding...`);
						const vector = await embed(
							this.env,
							`${post.title}. ${cls.one_liner}`,
						);

						console.log(`  → dedup query...`);
						const id = itemId(post);
						const dedupResult = await dedupAndRegister(this.env, id, vector, {
							source: post.source,
							source_id: post.source_id,
							briefing_id: briefingId,
						});

						if (dedupResult.isDuplicate) {
							console.log(
								`  → semantic duplicate (${dedupResult.score?.toFixed(3)} vs ${dedupResult.matchedId})`,
							);
							deduped++;
							continue;
						}

						// Archive raw post to R2 (best-effort; don't fail the whole run)
						let archivedKey: string | null = null;
						try {
							archivedKey = await archivePost(this.env, briefingId, post);
						} catch (err) {
							console.warn("R2 archive failed:", err);
						}

						console.log(`  → persisting to D1`);
						await persistItem(
							this.env,
							briefingId,
							post,
							cls,
							id,
							archivedKey,
						);
						kept++;
					} catch (err) {
						// Per-post errors don't fail the whole batch
						console.error(`  → FAILED:`, err instanceof Error ? err.message : err);
					}
				}

				console.log(
					`[pipeline] done: source=${posts.length} classified=${classified} deduped=${deduped} kept=${kept}`,
				);

				return {
					source: posts.length,
					classified,
					deduped,
					kept,
				};
			},
		);

		// 4. Mark briefing complete with counts.
		await step.do("finalize-briefing", async () => {
			await finalizeBriefing(this.env, briefingId, result, "completed");
		});

		// 5. Send the email digest with the top items.
		if (!skipEmail) {
			await step.do(
				"send-digest",
				{ retries: { limit: 3, delay: "30 seconds" } },
				async () => {
					const items = await this.env.DB.prepare(
						`SELECT * FROM items
						 WHERE briefing_id = ? AND is_about_cf = 1
						 ORDER BY score DESC, posted_at DESC
						 LIMIT 12`,
					)
						.bind(briefingId)
						.all<ClassifiedItem>();
					await sendDigest(this.env, {
						briefingId,
						items: items.results ?? [],
					});
				},
			);
		}

		return { briefingId, kept: result.kept };
	}
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 8);
}
