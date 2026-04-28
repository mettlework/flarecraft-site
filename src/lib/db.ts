// Typed D1 readers for the SSR site.
// The pipeline Worker (separate deploy) writes; this Worker only reads.

export interface BriefingRow {
	id: string;
	run_started_at: number;
	run_finished_at: number | null;
	source_count: number;
	classified_count: number;
	deduped_count: number;
	kept_count: number;
	status: string;
	error: string | null;
}

export interface ItemRow {
	id: string;
	briefing_id: string;
	source: string;
	source_id: string;
	url: string;
	title: string;
	author: string | null;
	posted_at: number | null;
	is_about_cf: number;
	primitives: string;
	score: number;
	one_liner: string;
	angle: string;
	embedding_id: string | null;
	archived_key: string | null;
	created_at: number;
}

export interface Briefing {
	row: BriefingRow;
	items: ItemRow[];
}

export async function getLatestBriefing(
	db: D1Database,
): Promise<Briefing | null> {
	const briefing = await db
		.prepare(
			`SELECT * FROM briefings
			 WHERE status = 'completed' AND kept_count > 0
			 ORDER BY run_started_at DESC LIMIT 1`,
		)
		.first<BriefingRow>();

	if (!briefing) return null;

	const items = await db
		.prepare(
			`SELECT * FROM items
			 WHERE briefing_id = ? AND is_about_cf = 1
			 ORDER BY score DESC, posted_at DESC
			 LIMIT 30`,
		)
		.bind(briefing.id)
		.all<ItemRow>();

	return { row: briefing, items: items.results ?? [] };
}

export async function getRecentBriefings(
	db: D1Database,
	limit: number = 14,
): Promise<BriefingRow[]> {
	const result = await db
		.prepare(
			`SELECT * FROM briefings
			 WHERE status = 'completed'
			 ORDER BY run_started_at DESC LIMIT ?`,
		)
		.bind(limit)
		.all<BriefingRow>();
	return result.results ?? [];
}

export async function getBriefingById(
	db: D1Database,
	id: string,
): Promise<Briefing | null> {
	const briefing = await db
		.prepare(`SELECT * FROM briefings WHERE id = ?`)
		.bind(id)
		.first<BriefingRow>();

	if (!briefing) return null;

	const items = await db
		.prepare(
			`SELECT * FROM items
			 WHERE briefing_id = ? AND is_about_cf = 1
			 ORDER BY score DESC, posted_at DESC`,
		)
		.bind(id)
		.all<ItemRow>();

	return { row: briefing, items: items.results ?? [] };
}

export function parsePrimitives(raw: string): string[] {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}
