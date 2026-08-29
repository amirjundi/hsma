/**
 * When to crawl, and where — learned from what the agent has actually found.
 *
 * A fixed interval wastes most of its crawls. Hate speech against a community is not
 * uniformly distributed across the day: it clusters around whatever provoked it — a
 * news item, a religious festival, an anniversary. Crawling a page at 4am because the
 * cron said so costs a request against a worker account's reputation and returns
 * nothing.
 *
 * So the agent learns two things:
 *
 *   1. **when** — the hours of day a case's flagged items were actually posted
 *   2. **where** — which pages produce findings and which never do
 *
 * Statistics, not a model. It counts what it saw and crawls accordingly, which is
 * inspectable: an operator can ask why it crawls at 21:00 and get a real answer.
 *
 * ## The distortion this creates, and the guard against it
 *
 * Concentrating on productive hours is a feedback loop. You find hate where you look,
 * so you look there more, so the record over-represents those windows — and
 * under-represents every hour you stopped watching. For an ordinary crawler that is
 * efficiency. Here the output is a human-rights record, and a distribution that
 * reflects the crawler's habits rather than reality is a false finding about when a
 * community is attacked.
 *
 * `BASELINE_SHARE` of crawls therefore go deliberately where the agent does not expect
 * to find anything. It costs yield. It is what lets the agent distinguish "no hate
 * speech here" from "never looked here", and what lets a report state its own coverage
 * honestly.
 */

/** Fraction of crawls spent outside the learned windows, on purpose. */
export const BASELINE_SHARE = 0.2;

/**
 * Observations needed before narrowing. Below this the histogram is noise, and
 * concentrating on it would lock the agent onto whichever hour happened to be first.
 */
export const MIN_SAMPLE = 20;

/** Hours kept when the evidence supports narrowing at all. */
export const ACTIVE_HOURS = 6;

/**
 * Least share of a case's findings an hour must carry to be worth watching.
 *
 * Without this, an hour holding one observation in fifty-five entered the window
 * simply because there was room in the top six — a stray 3am post becoming a
 * scheduled crawl slot forever.
 */
export const MIN_HOUR_SHARE = 0.05;

export interface FlaggedObservation {
  /** UTC hour the content was *posted*, 0-23. Not when it was collected. */
  hour: number;
}

export interface PageOutcome {
  pageId: string;
  crawls: number;
  flagged: number;
  /** ISO-8601, or null if never crawled. */
  lastCrawledAt: string | null;
}

export type Stance = "watch" | "follow" | "muted";

export interface Window {
  /** UTC hours to crawl in. */
  hours: number[];
  /** Why these hours — shown to the operator, so the schedule can be questioned. */
  reason: string;
  /** False while there is too little evidence to narrow. */
  learned: boolean;
}

/**
 * The hours a case is worth crawling.
 *
 * With too few observations this returns every hour: an agent that has seen five
 * flagged items knows nothing about their distribution, and narrowing on that would
 * be superstition rather than learning.
 */
export function activeHours(observations: readonly FlaggedObservation[]): Window {
  const allHours = Array.from({ length: 24 }, (_, h) => h);

  if (observations.length < MIN_SAMPLE) {
    return {
      hours: allHours,
      learned: false,
      reason:
        `only ${observations.length} flagged items observed; ` +
        `${MIN_SAMPLE} needed before narrowing, so crawling around the clock`,
    };
  }

  const counts = new Array<number>(24).fill(0);
  for (const o of observations) {
    if (Number.isInteger(o.hour) && o.hour >= 0 && o.hour < 24) counts[o.hour]! += 1;
  }

  const ranked = allHours
    .map((hour) => ({ hour, count: counts[hour]! }))
    .sort((a, b) => b.count - a.count || a.hour - b.hour);

  // An hour must carry a real share of the findings, not merely be non-zero. Taking
  // the top six by count alone let an hour with a single observation out of
  // fifty-five into the window: it dilutes the schedule, and it makes the result look
  // learned when part of it is one stray post at 3am.
  const floor = Math.max(2, observations.length * MIN_HOUR_SHARE);
  const chosen = ranked.slice(0, ACTIVE_HOURS).filter((h) => h.count >= floor);

  // Everything in one or two hours usually means a handful of items, not a real
  // pattern — and a schedule built on it misses the case entirely when the pattern
  // shifts. Requiring spread is cheaper than being confidently wrong.
  if (chosen.length < 3) {
    return {
      hours: allHours,
      learned: false,
      reason: "flagged items are too concentrated to be a pattern; crawling around the clock",
    };
  }

  const share = chosen.reduce((sum, h) => sum + h.count, 0) / observations.length;
  return {
    hours: chosen.map((h) => h.hour).sort((a, b) => a - b),
    learned: true,
    reason:
      `${Math.round(share * 100)}% of ${observations.length} flagged items were posted ` +
      `in these ${chosen.length} hours`,
  };
}

/**
 * Whether this crawl should ignore the learned window.
 *
 * Deterministic on the crawl counter rather than random, so coverage is even and an
 * operator can predict it. Random sampling clusters, and a run of unlucky draws leaves
 * a real gap in the baseline.
 */
export function isBaselineCrawl(crawlNumber: number, share: number = BASELINE_SHARE): boolean {
  if (share <= 0) return false;
  if (share >= 1) return true;
  const everyN = Math.round(1 / share);
  return crawlNumber % everyN === 0;
}

/** Is this hour one the case is scheduled for? Baseline crawls ignore the answer. */
export function shouldCrawlNow(window: Window, utcHour: number, baseline: boolean): boolean {
  return baseline || window.hours.includes(utcHour);
}

export interface StanceDecision {
  pageId: string;
  stance: Stance;
  reason: string;
}

/**
 * What to do with each page, from what it has produced.
 *
 * Muting is the consequential one: a muted page stops being crawled, so anything
 * posted there afterwards is never seen. The bar is therefore deliberately high —
 * many crawls, none of them finding anything — and muting is a proposal for a human
 * rather than something the agent does to itself. A page that goes quiet for a month
 * and then erupts is exactly the case this system exists for.
 */
export function reviewPages(
  outcomes: readonly PageOutcome[],
  { minCrawlsBeforeMuting = 25, promoteAtRate = 0.1 } = {},
): StanceDecision[] {
  return outcomes.map((page) => {
    const rate = page.crawls > 0 ? page.flagged / page.crawls : 0;

    if (page.crawls >= minCrawlsBeforeMuting && page.flagged === 0) {
      return {
        pageId: page.pageId,
        stance: "muted",
        reason: `${page.crawls} crawls, nothing flagged — propose muting`,
      };
    }

    if (rate >= promoteAtRate) {
      return {
        pageId: page.pageId,
        stance: "follow",
        reason:
          `${page.flagged} flagged across ${page.crawls} crawls ` +
          `(${Math.round(rate * 100)}%) — worth expanding into what it links to`,
      };
    }

    return {
      pageId: page.pageId,
      stance: "watch",
      reason: `${page.flagged} flagged across ${page.crawls} crawls`,
    };
  });
}

/**
 * What the agent can honestly say about its own coverage.
 *
 * A monitoring programme that cannot state its gaps invites the objection that absence
 * of evidence was treated as evidence of absence — and here that objection would be
 * correct, because a learned schedule creates real gaps on purpose.
 */
export function coverage(window: Window, baselineCrawls: number, totalCrawls: number): string {
  if (!window.learned) {
    return `Crawling all hours: ${window.reason}.`;
  }
  const unwatched = 24 - window.hours.length;
  const baselineShare = totalCrawls > 0 ? Math.round((baselineCrawls / totalCrawls) * 100) : 0;
  return (
    `Crawling ${window.hours.length} of 24 hours (${window.reason}). ` +
    `${unwatched} hours are covered only by baseline sampling, which was ` +
    `${baselineShare}% of crawls. Findings outside the watched hours are ` +
    `under-counted by roughly that factor.`
  );
}
