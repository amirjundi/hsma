/**
 * The local evidence store.
 *
 * The agent keeps its own findings. It does not exist only to feed the platform, for
 * three reasons that have each already happened:
 *
 * - the platform can be unreachable, and a residential line in Iraq drops constantly
 * - the platform has nowhere to put a verdict — `HateSpeechReport` carries no verdict,
 *   confidence or rationale fields, so richer judgement is discarded at the boundary
 * - the platform has no way for a human to record a review decision at all: no report
 *   ever leaves `status='new'`
 *
 * So an agent that only reported onward would be doing work that evaporates. Holding
 * it locally is also what makes cases, trends and learned scheduling possible — you
 * cannot learn *when* hate speech appears if you never kept *when* you found it.
 *
 * SQLite because it is one file, needs no server, and survives the machine being
 * unplugged mid-crawl, which is the operating environment.
 */

/**
 * Schema, in dependency order. Applied by `migrate()` inside one transaction.
 *
 * Times are ISO-8601 strings in UTC. SQLite has no date type, and storing local time
 * would make the hour-of-day histograms that drive scheduling wrong the moment the
 * machine crosses a DST boundary or moves.
 */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cases (
     id                  TEXT PRIMARY KEY,
     target_group_slug   TEXT NOT NULL,
     narrative           TEXT,
     dialect_scope       TEXT,
     watch_keywords      TEXT NOT NULL DEFAULT '[]',
     severity            INTEGER NOT NULL DEFAULT 2,
     -- Active | Cooling | Dormant. A dormant case is not crawled at all: a dead
     -- campaign burning worker-account reputation on pages nobody posts to is how
     -- accounts get banned for nothing.
     state               TEXT NOT NULL DEFAULT 'Active',
     last_activity_at    TEXT,
     cooling_started_at  TEXT,
     dormant_started_at  TEXT,
     created_at          TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS pages (
     id            TEXT PRIMARY KEY,
     platform      TEXT NOT NULL,
     handle        TEXT NOT NULL,
     case_id       TEXT REFERENCES cases(id) ON DELETE SET NULL,
     -- watch: crawl it. follow: crawl it and expand into what it links to.
     -- muted: found nothing worth having; kept so it is not rediscovered forever.
     stance        TEXT NOT NULL DEFAULT 'watch',
     added_reason  TEXT,
     last_crawled_at TEXT,
     created_at    TEXT NOT NULL,
     UNIQUE (platform, handle)
   )`,

  `CREATE TABLE IF NOT EXISTS posts (
     id            TEXT PRIMARY KEY,
     page_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
     case_id       TEXT REFERENCES cases(id) ON DELETE SET NULL,
     platform      TEXT NOT NULL,
     platform_post_id TEXT NOT NULL,
     url           TEXT NOT NULL,
     content_text  TEXT,
     author_name   TEXT,
     -- When the author posted it, not when we collected it. The learned schedule is
     -- built from this: crawling at 3am and finding a post written at 9pm says
     -- nothing about when to crawl.
     posted_at     TEXT,
     collected_at  TEXT NOT NULL,
     UNIQUE (platform, platform_post_id)
   )`,

  `CREATE TABLE IF NOT EXISTS comments (
     id            TEXT PRIMARY KEY,
     post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
     platform_comment_id TEXT NOT NULL,
     text          TEXT,
     author_name   TEXT,
     posted_at     TEXT,
     collected_at  TEXT NOT NULL,
     UNIQUE (post_id, platform_comment_id)
   )`,

  `CREATE TABLE IF NOT EXISTS verdicts (
     id              TEXT PRIMARY KEY,
     post_id         TEXT REFERENCES posts(id) ON DELETE CASCADE,
     comment_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,
     verdict         TEXT NOT NULL,
     hate_speech_flag INTEGER NOT NULL,
     confidence      REAL NOT NULL,
     category        TEXT,
     severity        INTEGER,
     target_group_slug TEXT,
     relies_on_context INTEGER NOT NULL DEFAULT 0,
     committee_disagreement INTEGER NOT NULL DEFAULT 0,
     rationale       TEXT,
     -- The whole trace, as JSON: which terms matched, which patterns fired, whether a
     -- flag was withheld and why. A verdict that cannot be reconstructed later cannot
     -- be defended when someone disputes it, and someone will.
     trace           TEXT,
     -- How old the lexicon was when this was judged. A stale dictionary degrades
     -- recall silently, and a reviewer reading this months later needs to know the
     -- judgement was made against a week-old copy.
     lexicon_age_hours REAL,
     decided_at      TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS reviews (
     id          TEXT PRIMARY KEY,
     verdict_id  TEXT NOT NULL REFERENCES verdicts(id) ON DELETE CASCADE,
     reviewer_id TEXT NOT NULL,
     -- Did the human agree with the agent? The label is derived from this and the
     -- agent's own flag, never from the agent's verdict alone — a gold set built from
     -- the classifier's past answers grades it against itself.
     confirmed   INTEGER NOT NULL,
     rationale   TEXT,
     reviewed_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS crawls (
     id           TEXT PRIMARY KEY,
     page_id      TEXT REFERENCES pages(id) ON DELETE CASCADE,
     case_id      TEXT REFERENCES cases(id) ON DELETE SET NULL,
     started_at   TEXT NOT NULL,
     finished_at  TEXT,
     posts_seen   INTEGER NOT NULL DEFAULT 0,
     comments_seen INTEGER NOT NULL DEFAULT 0,
     flagged      INTEGER NOT NULL DEFAULT 0,
     -- True when this crawl was scheduled outside the learned windows, on purpose.
     -- Without it the agent only ever looks where it already found things, the record
     -- over-represents those hours, and nobody can tell the difference between "no
     -- hate speech here" and "never looked here".
     baseline     INTEGER NOT NULL DEFAULT 0,
     error        TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS outbox (
     id           TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     payload      TEXT NOT NULL,
     -- Stable across retries, sent as Idempotency-Key. The retry loop cannot tell
     -- "the platform never saw it" from "it processed it and the reply was lost".
     request_id   TEXT NOT NULL UNIQUE,
     status       TEXT NOT NULL DEFAULT 'Pending',
     attempts     INTEGER NOT NULL DEFAULT 0,
     last_error   TEXT,
     created_at   TEXT NOT NULL,
     sent_at      TEXT
   )`,

  // Indexes for the queries that actually run: the review queue, the learned
  // schedule's histograms, and the outbox drain.
  `CREATE INDEX IF NOT EXISTS idx_verdicts_flagged ON verdicts(hate_speech_flag, decided_at)`,
  `CREATE INDEX IF NOT EXISTS idx_verdicts_post ON verdicts(post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_case_posted ON posts(case_id, posted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_page ON posts(page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_crawls_page ON crawls(page_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pages_stance ON pages(stance, last_crawled_at)`,
];

/** Minimal surface this package needs from a SQLite driver. */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

/**
 * Create the schema. Idempotent — every statement is `IF NOT EXISTS`, so running it
 * on an existing database is a no-op rather than an error.
 */
export function migrate(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  // Survives the machine losing power mid-crawl, which is the operating environment.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("BEGIN");
  try {
    for (const statement of SCHEMA) db.exec(statement);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
