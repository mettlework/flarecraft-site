-- FlareCraft D1 schema
-- Three tables: briefings (one per pipeline run), items (classified posts),
-- and source_posts (raw normalized posts before classification, for replay).

CREATE TABLE IF NOT EXISTS briefings (
	id TEXT PRIMARY KEY,
	run_started_at INTEGER NOT NULL, -- unix epoch ms
	run_finished_at INTEGER,
	source_count INTEGER NOT NULL DEFAULT 0,
	classified_count INTEGER NOT NULL DEFAULT 0,
	deduped_count INTEGER NOT NULL DEFAULT 0,
	kept_count INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
	error TEXT,
	summary_json TEXT -- JSON: {positives:[{title,line}], negatives:[{title,line}]}
);

CREATE TABLE IF NOT EXISTS items (
	id TEXT PRIMARY KEY, -- stable hash of source+source_id
	briefing_id TEXT NOT NULL,
	source TEXT NOT NULL, -- 'hn' (more later)
	source_id TEXT NOT NULL, -- HN object id
	url TEXT NOT NULL,
	title TEXT NOT NULL,
	author TEXT,
	posted_at INTEGER, -- unix epoch ms (when posted on source)
	-- Classification output
	is_about_cf INTEGER NOT NULL DEFAULT 0, -- 0/1
	primitives TEXT, -- JSON array of primitive names ('Workers','D1',...)
	score INTEGER, -- 1-5 interestingness score from the model
	one_liner TEXT, -- 1-2 sentence synthesis from the model
	angle TEXT, -- short tag of the angle ('production-story','perf-win','OSS','launch','tutorial','critique','community')
	-- Bookkeeping
	embedding_id TEXT, -- Vectorize vector id
	archived_key TEXT, -- R2 key for raw HTML (if archived)
	created_at INTEGER NOT NULL,
	FOREIGN KEY (briefing_id) REFERENCES briefings(id)
);

CREATE INDEX IF NOT EXISTS idx_items_briefing ON items(briefing_id);
CREATE INDEX IF NOT EXISTS idx_items_score ON items(score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_about_cf ON items(is_about_cf, created_at DESC);
