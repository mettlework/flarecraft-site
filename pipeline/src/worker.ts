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
