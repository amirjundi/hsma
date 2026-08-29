/**
 * The local evidence store.
 *
 * The agent keeps its own findings. It does not exist only to feed the platform, and
 * three things make that concrete rather than theoretical: the platform is often
 * unreachable, it has nowhere to put a verdict (`HateSpeechReport` carries no verdict,
 * confidence or rationale fields), and no human can record a review decision there at
 * all — no report ever leaves `status='new'`.
 *
 * Local storage is also what makes the rest possible. You cannot learn *when* hate
 * speech appears if you never kept *when* you found it, and a case with no history is
 * just a name.
 *
 * `node:sqlite` rather than a dependency: it is built into Node, needs no compilation,
 * and cannot fail to install on a bad connection — which on this deployment is the
 * normal condition rather than the exception.
 */
import { DatabaseSync } from "node:sqlite";
import type { Exemption } from "./exemptions.js";
import type { LexiconHit } from "./lexicon.js";
import type { FlaggedObservation, PageOutcome, Stance } from "./schedule.js";
import { migrate } from "./schema.js";
import type { TropeHit } from "./tropes.js";

const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();

export interface CaseRecord {
  id: string;
  targetGroupSlug: string;
  narrative: string | null;
  watchKeywords: string[];
  severity: number;
  state: "Active" | "Cooling" | "Dormant";
  lastActivityAt: string | null;
}

export interface PageRecord {
  id: string;
  platform: string;
  handle: string;
  caseId: string | null;
  stance: Stance;
  lastCrawledAt: string | null;
}

export interface StoredPost {
  id: string;
  pageId: string | null;
  caseId: string | null;
  platform: string;
  platformPostId: string;
  url: string;
  contentText: string | null;
  authorName: string | null;
  /** When the author posted it. Drives the learned schedule. */
  postedAt: string | null;
}

export interface StoredVerdict {
  postId?: string | null;
  commentId?: string | null;
  verdict: string;
  hateSpeechFlag: boolean;
  confidence: number;
  category?: string | null;
  severity?: number | null;
  targetGroupSlug?: string | null;
  reliesOnContext?: boolean;
  committeeDisagreement?: boolean;
  rationale?: string | null;
  lexiconHits?: LexiconHit[];
  tropesFired?: TropeHit[];
  tropeCandidates?: TropeHit[];
  exemption?: Exemption | null;
  /** How stale the dictionary was when this was judged. */
  lexiconAgeHours?: number | null;
}

export class EvidenceStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    migrate(this.db as never);
  }

  close(): void {
    this.db.close();
  }

  // ── cases ────────────────────────────────────────────────────────────────

  openCase(input: {
    targetGroupSlug: string;
    narrative?: string;
    watchKeywords?: string[];
    severity?: number;
    dialectScope?: string;
  }): CaseRecord {
    const record: CaseRecord = {
      id: id(),
      targetGroupSlug: input.targetGroupSlug,
      narrative: input.narrative ?? null,
      watchKeywords: input.watchKeywords ?? [],
      severity: input.severity ?? 2,
      state: "Active",
      lastActivityAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO cases (id, target_group_slug, narrative, dialect_scope,
                            watch_keywords, severity, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)`,
      )
      .run(
        record.id,
        record.targetGroupSlug,
        record.narrative,
        input.dialectScope ?? null,
        JSON.stringify(record.watchKeywords),
        record.severity,
        now(),
      );

    return record;
  }

  listCases(): CaseRecord[] {
    const rows = this.db.prepare(`SELECT * FROM cases ORDER BY created_at DESC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      targetGroupSlug: String(r.target_group_slug),
      narrative: (r.narrative as string) ?? null,
      watchKeywords: JSON.parse(String(r.watch_keywords ?? "[]")),
      severity: Number(r.severity),
      state: r.state as CaseRecord["state"],
      lastActivityAt: (r.last_activity_at as string) ?? null,
    }));
  }

  /**
   * Move a case along its lifecycle from how long it has been quiet.
   *
   * Only ever downward — Active → Cooling → Dormant. Waking a dormant case is a
   * human's decision, never the agent's: a trend spike is exactly when an agent would
   * be most confident and most likely to be reacting to one loud day.
   */
  evaluateLifecycles({ coolingAfterHours = 48, dormantAfterDays = 14 } = {}): CaseRecord[] {
    const changed: CaseRecord[] = [];
    for (const c of this.listCases()) {
      if (c.state === "Dormant") continue;

      const since = c.lastActivityAt ? Date.parse(c.lastActivityAt) : null;
      if (since === null) continue;
      const hours = (Date.now() - since) / 3_600_000;

      let next: CaseRecord["state"] | null = null;
      if (c.state === "Active" && hours > coolingAfterHours) next = "Cooling";
      else if (c.state === "Cooling" && hours > dormantAfterDays * 24) next = "Dormant";
      if (!next) continue;

      this.db.prepare(`UPDATE cases SET state = ? WHERE id = ?`).run(next, c.id);
      changed.push({ ...c, state: next });
    }
    return changed;
  }

  // ── pages ────────────────────────────────────────────────────────────────

  addPage(input: {
    platform: string;
    handle: string;
    caseId?: string;
    reason?: string;
  }): PageRecord {
    const record: PageRecord = {
      id: id(),
      platform: input.platform,
      handle: input.handle,
      caseId: input.caseId ?? null,
      stance: "watch",
      lastCrawledAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO pages (id, platform, handle, case_id, stance, added_reason, created_at)
         VALUES (?, ?, ?, ?, 'watch', ?, ?)
         ON CONFLICT (platform, handle) DO NOTHING`,
      )
      .run(record.id, record.platform, record.handle, record.caseId, input.reason ?? null, now());

    return this.findPage(input.platform, input.handle) ?? record;
  }

  findPage(platform: string, handle: string): PageRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM pages WHERE platform = ? AND handle = ?`)
      .get(platform, handle) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      platform: String(r.platform),
      handle: String(r.handle),
      caseId: (r.case_id as string) ?? null,
      stance: r.stance as Stance,
      lastCrawledAt: (r.last_crawled_at as string) ?? null,
    };
  }

  setStance(pageId: string, stance: Stance): void {
    this.db.prepare(`UPDATE pages SET stance = ? WHERE id = ?`).run(stance, pageId);
  }

  /** Pages worth crawling: everything not muted, oldest first. */
  duePages(caseId?: string): PageRecord[] {
    const sql = caseId
      ? `SELECT * FROM pages WHERE stance != 'muted' AND case_id = ?
         ORDER BY COALESCE(last_crawled_at, '') ASC`
      : `SELECT * FROM pages WHERE stance != 'muted'
         ORDER BY COALESCE(last_crawled_at, '') ASC`;
    const rows = (caseId ? this.db.prepare(sql).all(caseId) : this.db.prepare(sql).all()) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      platform: String(r.platform),
      handle: String(r.handle),
      caseId: (r.case_id as string) ?? null,
      stance: r.stance as Stance,
      lastCrawledAt: (r.last_crawled_at as string) ?? null,
    }));
  }

  // ── content and verdicts ─────────────────────────────────────────────────

  recordPost(post: Omit<StoredPost, "id"> & { id?: string }): string {
    const postId = post.id ?? id();
    this.db
      .prepare(
        `INSERT INTO posts (id, page_id, case_id, platform, platform_post_id, url,
                            content_text, author_name, posted_at, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, platform_post_id) DO NOTHING`,
      )
      .run(
        postId,
        post.pageId,
        post.caseId,
        post.platform,
        post.platformPostId,
        post.url,
        post.contentText,
        post.authorName,
        post.postedAt,
        now(),
      );

    const existing = this.db
      .prepare(`SELECT id FROM posts WHERE platform = ? AND platform_post_id = ?`)
      .get(post.platform, post.platformPostId) as { id: string } | undefined;
    return existing?.id ?? postId;
  }

  recordComment(input: {
    postId: string;
    platformCommentId: string;
    text: string | null;
    authorName?: string | null;
    postedAt?: string | null;
  }): string {
    const commentId = id();
    this.db
      .prepare(
        `INSERT INTO comments (id, post_id, platform_comment_id, text, author_name,
                               posted_at, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (post_id, platform_comment_id) DO NOTHING`,
      )
      .run(
        commentId,
        input.postId,
        input.platformCommentId,
        input.text,
        input.authorName ?? null,
        input.postedAt ?? null,
        now(),
      );

    const existing = this.db
      .prepare(`SELECT id FROM comments WHERE post_id = ? AND platform_comment_id = ?`)
      .get(input.postId, input.platformCommentId) as { id: string } | undefined;
    return existing?.id ?? commentId;
  }

  /**
   * Store a verdict with the whole trace.
   *
   * The trace is not decoration. A verdict that cannot be reconstructed later cannot
   * be defended when someone disputes it — and someone will, because the output names
   * people. Which terms matched, which patterns fired, whether a flag was withheld
   * and why, all travel with it.
   */
  recordVerdict(v: StoredVerdict): string {
    const verdictId = id();
    this.db
      .prepare(
        `INSERT INTO verdicts (id, post_id, comment_id, verdict, hate_speech_flag,
                               confidence, category, severity, target_group_slug,
                               relies_on_context, committee_disagreement, rationale,
                               trace, lexicon_age_hours, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        verdictId,
        v.postId ?? null,
        v.commentId ?? null,
        v.verdict,
        v.hateSpeechFlag ? 1 : 0,
        v.confidence,
        v.category ?? null,
        v.severity ?? null,
        v.targetGroupSlug ?? null,
        v.reliesOnContext ? 1 : 0,
        v.committeeDisagreement ? 1 : 0,
        v.rationale ?? null,
        JSON.stringify({
          lexicon_hits: v.lexiconHits ?? [],
          tropes_fired: v.tropesFired ?? [],
          trope_candidates: v.tropeCandidates ?? [],
          exemption: v.exemption ?? null,
        }),
        v.lexiconAgeHours ?? null,
        now(),
      );

    if (v.hateSpeechFlag && v.postId) {
      // A finding is activity: it keeps the case out of Cooling.
      this.db
        .prepare(
          `UPDATE cases SET last_activity_at = ?
           WHERE id = (SELECT case_id FROM posts WHERE id = ?)`,
        )
        .run(now(), v.postId);
    }

    return verdictId;
  }

  /** Items waiting for a human: flagged, ambiguous, or a committee that disagreed. */
  reviewQueue(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT v.*, c.text AS comment_text, p.content_text AS post_text, p.url
         FROM verdicts v
         LEFT JOIN comments c ON c.id = v.comment_id
         LEFT JOIN posts p ON p.id = COALESCE(v.post_id, c.post_id)
         WHERE (v.hate_speech_flag = 1 OR v.verdict = 'ambiguous'
                OR v.committee_disagreement = 1)
           AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.verdict_id = v.id)
         ORDER BY v.decided_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  recordReview(input: {
    verdictId: string;
    reviewerId: string;
    confirmed: boolean;
    rationale?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reviews (id, verdict_id, reviewer_id, confirmed, rationale, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id(),
        input.verdictId,
        input.reviewerId,
        input.confirmed ? 1 : 0,
        input.rationale ?? null,
        now(),
      );
  }

  // ── crawls, and what the schedule learns from them ───────────────────────

  recordCrawl(input: {
    pageId: string;
    caseId?: string | null;
    postsSeen: number;
    commentsSeen: number;
    flagged: number;
    baseline: boolean;
    error?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO crawls (id, page_id, case_id, started_at, finished_at,
                             posts_seen, comments_seen, flagged, baseline, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id(),
        input.pageId,
        input.caseId ?? null,
        now(),
        now(),
        input.postsSeen,
        input.commentsSeen,
        input.flagged,
        input.baseline ? 1 : 0,
        input.error ?? null,
      );

    this.db.prepare(`UPDATE pages SET last_crawled_at = ? WHERE id = ?`).run(now(), input.pageId);
  }

  /**
   * The hours flagged content was *posted* in, for one case.
   *
   * Posting time, not collection time. Crawling at 3am and finding a post written at
   * 9pm says nothing about when to crawl, and a schedule built on collection times
   * learns only its own habits.
   */
  flaggedHours(caseId: string): FlaggedObservation[] {
    const rows = this.db
      .prepare(
        `SELECT p.posted_at AS posted_at
         FROM verdicts v
         JOIN posts p ON p.id = COALESCE(v.post_id, (SELECT post_id FROM comments WHERE id = v.comment_id))
         WHERE v.hate_speech_flag = 1 AND p.case_id = ? AND p.posted_at IS NOT NULL`,
      )
      .all(caseId) as Array<{ posted_at: string }>;

    return rows
      .map((r) => new Date(r.posted_at))
      .filter((d) => !Number.isNaN(d.getTime()))
      .map((d) => ({ hour: d.getUTCHours() }));
  }

  /** Findings per crawl per page — what decides watch, follow or mute. */
  pageOutcomes(caseId?: string): PageOutcome[] {
    const sql = `SELECT pg.id AS page_id,
                        COUNT(c.id) AS crawls,
                        COALESCE(SUM(c.flagged), 0) AS flagged,
                        MAX(c.started_at) AS last_crawled
                 FROM pages pg
                 LEFT JOIN crawls c ON c.page_id = pg.id
                 ${caseId ? "WHERE pg.case_id = ?" : ""}
                 GROUP BY pg.id`;
    const rows = (caseId ? this.db.prepare(sql).all(caseId) : this.db.prepare(sql).all()) as Array<
      Record<string, unknown>
    >;

    return rows.map((r) => ({
      pageId: String(r.page_id),
      crawls: Number(r.crawls),
      flagged: Number(r.flagged),
      lastCrawledAt: (r.last_crawled as string) ?? null,
    }));
  }

  /** How many crawls so far, and how many were baseline. Feeds the coverage note. */
  crawlCounts(): { total: number; baseline: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(baseline), 0) AS baseline FROM crawls`)
      .get() as { total: number; baseline: number };
    return { total: Number(r.total), baseline: Number(r.baseline) };
  }

  // ── outbox ───────────────────────────────────────────────────────────────

  queueForPlatform(kind: string, payload: unknown): string {
    const requestId = id();
    this.db
      .prepare(
        `INSERT INTO outbox (id, kind, payload, request_id, status, created_at)
         VALUES (?, ?, ?, ?, 'Pending', ?)`,
      )
      .run(id(), kind, JSON.stringify(payload), requestId, now());
    return requestId;
  }

  pendingOutbox(
    limit = 50,
  ): Array<{ id: string; kind: string; payload: unknown; requestId: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, kind, payload, request_id FROM outbox
         WHERE status = 'Pending' AND attempts < 8
         ORDER BY created_at LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      payload: JSON.parse(String(r.payload)),
      requestId: String(r.request_id),
    }));
  }

  markSent(outboxId: string): void {
    this.db
      .prepare(`UPDATE outbox SET status = 'Sent', sent_at = ? WHERE id = ?`)
      .run(now(), outboxId);
  }

  markFailed(outboxId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET attempts = attempts + 1, last_error = ?,
             status = CASE WHEN attempts + 1 >= 8 THEN 'Failed' ELSE 'Pending' END
         WHERE id = ?`,
      )
      .run(error.slice(0, 1000), outboxId);
  }
}
