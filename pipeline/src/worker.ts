// flarecraft-pipeline Worker entry point.
//
// Three event surfaces, all on the same Worker class:
//   1. fetch  — manual trigger / health check (auth-gated)
//   2. scheduled — daily cron at 13:00 UTC (08:00 CDT) per wrangler.jsonc
//   3. FlareCraftPipeline — Workflow class export (Workflows runtime
//      instantiates it on demand for each pipeline run)
//
// The Workflow class lives in ./workflow.ts; we re-export it here because
// CF Workflows requires the class to be a top-level export of the Worker
// declared as the workflow's `class_name` in wrangler.jsonc.

import type { Env } from "./env";

export { FlareCraftPipeline } from "./workflow";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health check — public, no auth
		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				service: "flarecraft-pipeline",
				time: new Date().toISOString(),
			});
		}

		// Manual pipeline trigger — auth-gated, used for the demo and ad-hoc runs.
		// In production, the cron handler is the primary trigger.
		if (url.pathname === "/run" && request.method === "POST") {
			const auth = request.headers.get("authorization");
			const expected = `Bearer ${env.PIPELINE_AUTH_TOKEN}`;
			if (auth !== expected) {
				return new Response("Unauthorized", { status: 401 });
			}

			const body = await safeJson(request);
			const params = {
				hoursBack:
					typeof body?.hoursBack === "number" ? body.hoursBack : 24,
				skipEmail: Boolean(body?.skipEmail),
			};

			const instance = await env.PIPELINE.create({ params });
			return Response.json({
				instanceId: instance.id,
				status: "started",
				params,
			});
		}

		// Status check for a running instance
		if (url.pathname.startsWith("/run/")) {
			const id = url.pathname.split("/")[2];
			if (!id) return new Response("Missing id", { status: 400 });
			const instance = await env.PIPELINE.get(id);
			const status = await instance.status();
			return Response.json(status);
		}

		// Re-publish the latest completed briefing to Beehiiv. Useful when
		// the digest step short-circuits on a deduped run, or for admin
		// re-sends after a delivery failure.
		if (url.pathname === "/republish-latest" && request.method === "POST") {
			const auth = request.headers.get("authorization");
			if (auth !== `Bearer ${env.PIPELINE_AUTH_TOKEN}`) {
				return new Response("Unauthorized", { status: 401 });
			}

			const { sendDigest } = await import("./lib/digest");

			const briefing = await env.DB.prepare(
				`SELECT id, summary_json FROM briefings
				 WHERE status = 'completed' AND kept_count > 0
				 ORDER BY run_started_at DESC LIMIT 1`,
			).first<{ id: string; summary_json: string | null }>();

			if (!briefing) {
				return Response.json(
					{ error: "no completed briefing with items to republish" },
					{ status: 404 },
				);
			}

			const items = await env.DB.prepare(
				`SELECT * FROM items
				 WHERE briefing_id = ? AND is_about_cf = 1
				 ORDER BY score DESC, posted_at DESC
				 LIMIT 12`,
			)
				.bind(briefing.id)
				.all();

			let summary = null;
			if (briefing.summary_json) {
				try {
					summary = JSON.parse(briefing.summary_json);
				} catch {
					summary = null;
				}
			}

			await sendDigest(env, {
				briefingId: briefing.id,
				items: (items.results ?? []) as never,
				summary,
			});

			return Response.json({
				republished: briefing.id,
				items: items.results?.length ?? 0,
				hasSummary: !!summary,
			});
		}

		// Re-generate the summary for an existing briefing. Useful when the
		// summary step ran during a failed attempt or got out-of-sync with
		// the items that survived. POST /regenerate-summary?briefing=brf-...
		if (
			url.pathname === "/regenerate-summary" &&
			request.method === "POST"
		) {
			const auth = request.headers.get("authorization");
			if (auth !== `Bearer ${env.PIPELINE_AUTH_TOKEN}`) {
				return new Response("Unauthorized", { status: 401 });
			}

			const briefingId = url.searchParams.get("briefing");
			if (!briefingId) {
				return Response.json(
					{ error: "missing ?briefing=" },
					{ status: 400 },
				);
			}

			const { generateSummary } = await import("./lib/summary");
			const items = await env.DB.prepare(
				`SELECT * FROM items WHERE briefing_id = ? AND is_about_cf = 1`,
			)
				.bind(briefingId)
				.all();

			if ((items.results ?? []).length === 0) {
				return Response.json(
					{ error: "no items for briefing", briefingId },
					{ status: 404 },
				);
			}

			const summary = await generateSummary(env, (items.results ?? []) as never);
			await env.DB.prepare(
				`UPDATE briefings SET summary_json = ?, kept_count = ? WHERE id = ?`,
			)
				.bind(JSON.stringify(summary), items.results?.length ?? 0, briefingId)
				.run();

			return Response.json({
				briefingId,
				items: items.results?.length ?? 0,
				positives: summary.positives.length,
				negatives: summary.negatives.length,
				summary,
			});
		}

		return new Response("flarecraft-pipeline", { status: 200 });
	},

	async scheduled(
		event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		console.log(`Cron fired at ${new Date(event.scheduledTime).toISOString()}`);
		const instance = await env.PIPELINE.create({
			params: { hoursBack: 24, skipEmail: false },
		});
		console.log(`Started workflow instance: ${instance.id}`);
		// We don't waitUntil — the Workflow runs durably in its own context.
	},
} satisfies ExportedHandler<Env>;

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}
