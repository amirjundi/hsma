/**
 * The agent keeps its own findings.
 *
 * Not only reports them onward. The platform is often unreachable, has nowhere to put
 * a verdict, and offers no way for a human to record a review decision — so an agent
 * that only submitted would be doing work that evaporates.
 *
 * Local storage is also what makes the rest possible: the learned schedule needs a
 * history of *when* things were posted, and a case with no history is just a name.
 */
import { describe, expect, it } from "vitest";
import { activeHours, reviewPages } from "../src/schedule.js";
import { EvidenceStore } from "../src/store.js";

const store = () => new EvidenceStore(":memory:");

const post = (over: Partial<Parameters<EvidenceStore["recordPost"]>[0]> = {}) => ({
  pageId: null,
  caseId: null,
  platform: "facebook",
  platformPostId: `p-${Math.random()}`,
  url: "https://x/1",
  contentText: "مراسم دينية إيزيدية في معبد لالش",
  authorName: "someone",
  postedAt: "2026-08-28T21:00:00Z",
  ...over,
});

describe("cases", () => {
  it("opens a case in the Active state", () => {
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi", narrative: "devil-worship libel" });

    expect(c.state).toBe("Active");
    expect(s.listCases()).toHaveLength(1);
  });

  it("moves a quiet case to Cooling", () => {
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi" });
    const p = s.recordPost(post({ caseId: c.id }));
    s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });

    // Nothing since, and more than the cooling threshold has passed.
    const changed = s.evaluateLifecycles({ coolingAfterHours: -1 });

    expect(changed[0]?.state).toBe("Cooling");
  });

  it("never wakes a dormant case on its own", () => {
    // A trend spike is exactly when the agent would be most confident and most likely
    // to be reacting to one loud day. Waking a case is a human's decision.
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi" });
    s.evaluateLifecycles({ coolingAfterHours: -1, dormantAfterDays: -1 });

    const states = s.listCases().map((x) => x.state);
    expect(states).not.toContain("Reactivated");
    expect(c.id).toBeTruthy();
  });

  it("a finding counts as activity", () => {
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi" });
    const p = s.recordPost(post({ caseId: c.id }));
    s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });

    expect(s.listCases()[0]?.lastActivityAt).toBeTruthy();
  });
});

describe("pages", () => {
  it("adds a page once, however often it is discovered", () => {
    const s = store();
    s.addPage({ platform: "facebook", handle: "page1" });
    s.addPage({ platform: "facebook", handle: "page1" });

    expect(s.duePages()).toHaveLength(1);
  });

  it("crawls the least recently crawled first", () => {
    const s = store();
    const a = s.addPage({ platform: "facebook", handle: "a" });
    s.addPage({ platform: "facebook", handle: "b" });
    s.recordCrawl({ pageId: a.id, postsSeen: 1, commentsSeen: 0, flagged: 0, baseline: false });

    expect(s.duePages()[0]?.handle).toBe("b");
  });

  it("stops offering a muted page", () => {
    const s = store();
    const p = s.addPage({ platform: "facebook", handle: "quiet" });
    s.setStance(p.id, "muted");

    expect(s.duePages()).toHaveLength(0);
  });
});

describe("verdicts", () => {
  it("keeps the whole trace", () => {
    // A verdict that cannot be reconstructed cannot be defended when someone disputes
    // it — and someone will, because the output names people.
    const s = store();
    const p = s.recordPost(post());
    s.recordVerdict({
      postId: p,
      verdict: "hate",
      hateSpeechFlag: true,
      confidence: 0.95,
      category: "dehumanization",
      rationale: "aimed at the group named in the parent post",
      tropesFired: [
        {
          trope_id: 1,
          name: "Devil-worship libel",
          surface_form: "x",
          matched_group: "yazidi",
          covers_groups: ["yazidi"],
          severity: 8,
          implicature: "…",
          reason: "activation satisfied",
        },
      ],
      lexiconAgeHours: 3.5,
    });

    const [row] = s.reviewQueue();
    const trace = JSON.parse(String(row?.trace));
    expect(trace.tropes_fired[0].name).toBe("Devil-worship libel");
    expect(row?.lexicon_age_hours).toBe(3.5);
  });

  it("records how stale the lexicon was", () => {
    // A reviewer reading this months later needs to know the judgement was made
    // against a week-old dictionary.
    const s = store();
    const p = s.recordPost(post());
    s.recordVerdict({
      postId: p,
      verdict: "hate",
      hateSpeechFlag: true,
      confidence: 0.9,
      lexiconAgeHours: 168,
    });

    expect(s.reviewQueue()[0]?.lexicon_age_hours).toBe(168);
  });
});

describe("review queue", () => {
  it("holds flagged, ambiguous and disagreed items", () => {
    const s = store();
    const p = s.recordPost(post());
    s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });
    s.recordVerdict({ postId: p, verdict: "ambiguous", hateSpeechFlag: false, confidence: 0.5 });
    s.recordVerdict({
      postId: p,
      verdict: "benign",
      hateSpeechFlag: false,
      confidence: 0.9,
      committeeDisagreement: true,
    });

    expect(s.reviewQueue()).toHaveLength(3);
  });

  it("leaves cleared items out of it", () => {
    const s = store();
    const p = s.recordPost(post());
    s.recordVerdict({ postId: p, verdict: "benign", hateSpeechFlag: false, confidence: 0.9 });

    expect(s.reviewQueue()).toHaveLength(0);
  });

  it("drops an item once a human has decided", () => {
    const s = store();
    const p = s.recordPost(post());
    s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });

    const [row] = s.reviewQueue();
    s.recordReview({ verdictId: String(row?.id), reviewerId: "reviewer_1", confirmed: true });

    expect(s.reviewQueue()).toHaveLength(0);
  });
});

describe("what the schedule learns from", () => {
  it("reports the hour content was posted, not collected", () => {
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi" });
    for (let i = 0; i < 3; i++) {
      const p = s.recordPost(
        post({ caseId: c.id, platformPostId: `p${i}`, postedAt: "2026-08-28T21:30:00Z" }),
      );
      s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });
    }

    expect(s.flaggedHours(c.id)).toEqual([{ hour: 21 }, { hour: 21 }, { hour: 21 }]);
  });

  it("ignores flagged items with no posting time", () => {
    // A post whose timestamp we could not read tells us nothing about timing, and
    // guessing would put a fabricated hour into the schedule.
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi" });
    const p = s.recordPost(post({ caseId: c.id, postedAt: null }));
    s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });

    expect(s.flaggedHours(c.id)).toEqual([]);
  });

  it("feeds the window calculation end to end", () => {
    const s = store();
    const c = s.openCase({ targetGroupSlug: "yazidi" });
    for (let i = 0; i < 25; i++) {
      const hour = [19, 20, 21, 22][i % 4];
      const p = s.recordPost(
        post({
          caseId: c.id,
          platformPostId: `p${i}`,
          postedAt: `2026-08-28T${String(hour).padStart(2, "0")}:00:00Z`,
        }),
      );
      s.recordVerdict({ postId: p, verdict: "hate", hateSpeechFlag: true, confidence: 0.9 });
    }

    const window = activeHours(s.flaggedHours(c.id));
    expect(window.learned).toBe(true);
    expect(window.hours).toEqual([19, 20, 21, 22]);
  });

  it("feeds the page stance decision end to end", () => {
    const s = store();
    const quiet = s.addPage({ platform: "facebook", handle: "quiet" });
    for (let i = 0; i < 30; i++) {
      s.recordCrawl({
        pageId: quiet.id,
        postsSeen: 5,
        commentsSeen: 20,
        flagged: 0,
        baseline: false,
      });
    }

    const [decision] = reviewPages(s.pageOutcomes());
    expect(decision?.stance).toBe("muted");
  });

  it("counts baseline crawls so coverage can be stated", () => {
    const s = store();
    const p = s.addPage({ platform: "facebook", handle: "a" });
    s.recordCrawl({ pageId: p.id, postsSeen: 1, commentsSeen: 0, flagged: 0, baseline: true });
    s.recordCrawl({ pageId: p.id, postsSeen: 1, commentsSeen: 0, flagged: 0, baseline: false });

    expect(s.crawlCounts()).toEqual({ total: 2, baseline: 1 });
  });
});

describe("outbox", () => {
  it("queues work for the platform with a stable idempotency key", () => {
    const s = store();
    const requestId = s.queueForPlatform("verdict", { items: [] });

    const [row] = s.pendingOutbox();
    expect(row?.requestId).toBe(requestId);
  });

  it("keeps a failed item pending until its attempts run out", () => {
    const s = store();
    s.queueForPlatform("verdict", {});
    const [row] = s.pendingOutbox();

    for (let i = 0; i < 7; i++) s.markFailed(String(row?.id), "connection refused");
    expect(s.pendingOutbox()).toHaveLength(1);

    s.markFailed(String(row?.id), "connection refused");
    expect(s.pendingOutbox()).toHaveLength(0);
  });

  it("stops offering an item once sent", () => {
    const s = store();
    s.queueForPlatform("verdict", {});
    const [row] = s.pendingOutbox();
    s.markSent(String(row?.id));

    expect(s.pendingOutbox()).toHaveLength(0);
  });
});
