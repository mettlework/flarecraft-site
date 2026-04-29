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
	summary_json: string | null;
}

export interface SummaryEntry {
	title: string;
	line: string;
	url?: string; // v1.2+: resolved server-side from candidate index
}
export interface BriefingSummary {
	positives: SummaryEntry[];
	negatives: SummaryEntry[];
	questions: SummaryEntry[];
}

export function parseSummary(raw: string | null): BriefingSummary | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		if (
			v &&
			typeof v === "object" &&
			Array.isArray(v.positives) &&
			Array.isArray(v.negatives)
		) {
			// Backward-compatible: old summaries (pre v1.1) don't have `questions`.
			return {
				positives: v.positives,
				negatives: v.negatives,
				questions: Array.isArray(v.questions) ? v.questions : [],
			};
		}
	} catch {
		// fall through
	}
	return null;
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
	resolved: number | null;
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

export interface CorpusStats {
	briefingCount: number;
	itemsKept: number;
	sourcesScanned: number;
	lastRunAt: number | null;
}

export async function getCorpusStats(db: D1Database): Promise<CorpusStats> {
	const stats = await db
		.prepare(
			`SELECT
				COUNT(*) as briefing_count,
				COALESCE(SUM(kept_count), 0) as items_kept,
				COALESCE(SUM(source_count), 0) as sources_scanned,
				MAX(run_started_at) as last_run_at
			 FROM briefings WHERE status = 'completed'`,
		)
		.first<{
			briefing_count: number;
			items_kept: number;
			sources_scanned: number;
			last_run_at: number | null;
		}>();
	return {
		briefingCount: stats?.briefing_count ?? 0,
		itemsKept: stats?.items_kept ?? 0,
		sourcesScanned: stats?.sources_scanned ?? 0,
		lastRunAt: stats?.last_run_at ?? null,
	};
}

export async function getTopPrimitives(
	db: D1Database,
	limit: number = 6,
): Promise<{ name: string; count: number }[]> {
	// SQLite doesn't have native JSON aggregation; cheaper to fetch primitives
	// from items and aggregate in JS than to design a separate primitive table.
	const result = await db
		.prepare(
			`SELECT primitives FROM items WHERE is_about_cf = 1 AND primitives IS NOT NULL`,
		)
		.all<{ primitives: string }>();

	const counts = new Map<string, number>();
	for (const row of result.results ?? []) {
		for (const p of parsePrimitives(row.primitives)) {
			counts.set(p, (counts.get(p) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, limit);
}
