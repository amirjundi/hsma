/**
 * The learned schedule, and the guard against what it distorts.
 *
 * The agent concentrates crawling where it has found things. That is the capability
 * asked for — but it is also a feedback loop: you find hate where you look, so you
 * look there more, so the record over-represents those hours and under-represents
 * every hour you stopped watching.
 *
 * For an ordinary crawler that is efficiency. Here the output is a human-rights
 * record, and a distribution reflecting the crawler's habits rather than reality is a
 * false finding about when a community is attacked. Half these tests are about the
 * guard, not the optimisation.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_HOURS,
  BASELINE_SHARE,
  MIN_SAMPLE,
  activeHours,
  coverage,
  isBaselineCrawl,
  reviewPages,
  shouldCrawlNow,
} from "../src/schedule.js";

const at = (hour: number, times = 1) => Array.from({ length: times }, () => ({ hour }));

describe("cold start — it does not learn from nothing", () => {
  it("crawls every hour when it has seen nothing", () => {
    const window = activeHours([]);

    expect(window.hours).toHaveLength(24);
    expect(window.learned).toBe(false);
  });

  it("still crawls every hour just below the sample threshold", () => {
    // Narrowing on nineteen observations would lock the agent onto whichever hour
    // happened to come first. That is superstition, not learning.
    const window = activeHours(at(21, MIN_SAMPLE - 1));

    expect(window.hours).toHaveLength(24);
    expect(window.learned).toBe(false);
    expect(window.reason).toContain(`${MIN_SAMPLE} needed`);
  });

  it("says why it has not narrowed", () => {
    // The operator must be able to ask why it crawls at 4am and get a real answer.
    expect(activeHours(at(21, 3)).reason).toMatch(/only 3 flagged items/);
  });
});

describe("with enough evidence, it narrows", () => {
  const evening = [...at(19, 12), ...at(20, 15), ...at(21, 18), ...at(22, 9), ...at(3, 1)];

  it("picks the hours things were actually posted in", () => {
    const window = activeHours(evening);

    expect(window.learned).toBe(true);
    expect(window.hours).toEqual(expect.arrayContaining([19, 20, 21, 22]));
    expect(window.hours.length).toBeLessThanOrEqual(ACTIVE_HOURS);
  });

  it("explains itself in terms an operator can check", () => {
    expect(activeHours(evening).reason).toMatch(/% of \d+ flagged items were posted/);
  });

  it("refuses to narrow when everything is in one or two hours", () => {
    // A spike in a single hour is usually a handful of items reacting to one event,
    // not a rhythm — and a schedule built on it misses the case when the pattern moves.
    const window = activeHours(at(21, 40));

    expect(window.learned).toBe(false);
    expect(window.hours).toHaveLength(24);
    expect(window.reason).toMatch(/too concentrated/);
  });

  it("drops an hour carrying only a stray observation", () => {
    // Caught by this suite: an hour with one finding in fifty-five entered the window
    // purely because there was room in the top six. A single 3am post would have
    // become a scheduled crawl slot forever, and the schedule would have looked
    // learned while a sixth of it was noise.
    const window = activeHours([
      ...at(19, 12),
      ...at(20, 15),
      ...at(21, 18),
      ...at(22, 9),
      ...at(3, 1),
    ]);

    expect(window.learned).toBe(true);
    expect(window.hours).not.toContain(3);
    expect(window.hours).toEqual([19, 20, 21, 22]);
  });

  it("uses the hour content was posted, not when it was collected", () => {
    // Crawling at 3am and finding a post written at 9pm says nothing about when to
    // crawl. The type carries `hour` as the posting hour for exactly this reason.
    const window = activeHours([...at(21, 10), ...at(20, 10), ...at(19, 10)]);
    expect(window.hours).not.toContain(3);
  });
});

describe("baseline sampling — the guard", () => {
  it("keeps a share of crawls outside the learned window", () => {
    const total = 100;
    const baselines = Array.from({ length: total }, (_, i) => isBaselineCrawl(i)).filter(Boolean);

    expect(baselines.length).toBeGreaterThan(0);
    expect(baselines.length / total).toBeCloseTo(BASELINE_SHARE, 1);
  });

  it("is deterministic rather than random", () => {
    // Random sampling clusters, and a run of unlucky draws leaves a real gap in the
    // baseline — which is the one thing the baseline exists to prevent.
    expect(isBaselineCrawl(10)).toBe(isBaselineCrawl(10));
    expect(isBaselineCrawl(15)).toBe(isBaselineCrawl(15));
  });

  it("lets a baseline crawl run outside the window", () => {
    const window = activeHours([...at(19, 12), ...at(20, 15), ...at(21, 18), ...at(22, 9)]);

    expect(shouldCrawlNow(window, 4, false)).toBe(false);
    expect(shouldCrawlNow(window, 4, true)).toBe(true);
  });

  it("can be switched off, and then nothing is sampled", () => {
    // Optimising purely for yield is a legitimate choice — but it has to be a
    // decision, not an accident.
    expect(isBaselineCrawl(5, 0)).toBe(false);
  });
});

describe("coverage — the agent states its own gaps", () => {
  it("says how many hours it is not watching", () => {
    const window = activeHours([...at(19, 12), ...at(20, 15), ...at(21, 18), ...at(22, 9)]);
    const text = coverage(window, 20, 100);

    expect(text).toMatch(/hours are covered only by baseline sampling/);
    expect(text).toMatch(/under-counted/);
  });

  it("says plainly when it is watching everything", () => {
    expect(coverage(activeHours([]), 0, 0)).toMatch(/Crawling all hours/);
  });
});

describe("pages — where to look", () => {
  it("promotes a page that keeps producing findings", () => {
    const [decision] = reviewPages([{ pageId: "p1", crawls: 30, flagged: 9, lastCrawledAt: null }]);

    expect(decision?.stance).toBe("follow");
    expect(decision?.reason).toMatch(/worth expanding/);
  });

  it("proposes muting a page that has produced nothing over many crawls", () => {
    const [decision] = reviewPages([{ pageId: "p2", crawls: 40, flagged: 0, lastCrawledAt: null }]);

    expect(decision?.stance).toBe("muted");
  });

  it("does not mute a page it has barely crawled", () => {
    // Muting stops the page being crawled at all, so anything posted there afterwards
    // is never seen. A page that goes quiet for a month and then erupts is exactly
    // what this system exists for, so the bar is high.
    const [decision] = reviewPages([{ pageId: "p3", crawls: 5, flagged: 0, lastCrawledAt: null }]);

    expect(decision?.stance).toBe("watch");
  });

  it("keeps watching a page with occasional findings", () => {
    const [decision] = reviewPages([{ pageId: "p4", crawls: 50, flagged: 2, lastCrawledAt: null }]);

    expect(decision?.stance).toBe("watch");
  });

  it("reports counts so a human can check the decision", () => {
    const [decision] = reviewPages([{ pageId: "p5", crawls: 40, flagged: 0, lastCrawledAt: null }]);

    expect(decision?.reason).toMatch(/40 crawls/);
  });
});
