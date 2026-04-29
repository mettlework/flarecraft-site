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
import { fetchReddit } from "./lib/reddit";
import { fetchAnswerOverflow } from "./lib/answer-overflow";
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
import { generateSummary } from "./lib/summary";
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

		// 2. Pull source posts from all configured sources.
		// Sources run in parallel within the step; failures of one don't fail
		// the others (each fetcher catches its own).
		// AO uses a 7-day window (relevance-sorted, not time-sorted — Discord
		// is a weekly-pulse signal). HN and Reddit use the request's hoursBack.
		const posts: SourcePost[] = await step.do(
			"fetch-sources",
			{
				retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
				timeout: "120 seconds",
			},
			async () => {
				const [hnPosts, redditPosts, aoPosts] = await Promise.all([
					fetchHN(hoursBack).catch((e) => {
						console.warn("HN fetch failed:", e);
						return [] as SourcePost[];
					}),
					fetchReddit(hoursBack).catch((e) => {
						console.warn("Reddit fetch failed:", e);
						return [] as SourcePost[];
					}),
					fetchAnswerOverflow(168).catch((e) => {
						console.warn("AnswerOverflow fetch failed:", e);
						return [] as SourcePost[];
					}),
				]);
				console.log(
					`Sources: HN=${hnPosts.length} Reddit=${redditPosts.length} AO=${aoPosts.length}`,
				);
				return [...hnPosts, ...redditPosts, ...aoPosts];
			},
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

		// 4. Generate the editorial summary (top 3 positives / top 3 negatives).
		// Best-effort: if the summary call fails, the rest of the run still
		// completes — the homepage just won't have the editorial header today.
		await step.do(
			"generate-summary",
			{ retries: { limit: 2, delay: "10 seconds" } },
			async () => {
				const items = await this.env.DB.prepare(
					`SELECT * FROM items WHERE briefing_id = ? AND is_about_cf = 1`,
				)
					.bind(briefingId)
					.all<ClassifiedItem>();
				const summary = await generateSummary(
					this.env,
					items.results ?? [],
				);
				await this.env.DB.prepare(
					`UPDATE briefings SET summary_json = ? WHERE id = ?`,
				)
					.bind(JSON.stringify(summary), briefingId)
					.run();
				console.log(
					`Summary: ${summary.positives.length} positives, ${summary.negatives.length} negatives`,
				);
			},
		);

		// 5. Mark briefing complete with counts.
		await step.do("finalize-briefing", async () => {
			await finalizeBriefing(this.env, briefingId, result, "completed");
		});

		// 6. Send the email digest with the top items.
		if (!skipEmail) {
			// Hibernate briefly so the digest step gets a fresh Worker invocation
			// with a clean subrequest budget — the classify step above can use
			// 100+ subrequests on a busy day, which on Workers Free (50/invocation)
			// would otherwise leave nothing for the digest call. step.sleep is
			// the Workflows-native way to force an invocation boundary.
			await step.sleep("checkpoint-before-digest", "5 seconds");

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

					// Pull the summary that the previous step persisted.
					const summaryRow = await this.env.DB.prepare(
						`SELECT summary_json FROM briefings WHERE id = ?`,
					)
						.bind(briefingId)
						.first<{ summary_json: string | null }>();
					let summary = null;
					if (summaryRow?.summary_json) {
						try {
							summary = JSON.parse(summaryRow.summary_json);
						} catch {
							summary = null;
						}
					}

					await sendDigest(this.env, {
						briefingId,
						items: items.results ?? [],
						summary,
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
