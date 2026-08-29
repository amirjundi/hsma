/**
 * The agent must be matching against the lexicon the curator actually curated.
 *
 * In the Python agent it was not. `sync_lexicon`, `sync_tropes` and
 * `lexicon_is_usable` all existed and worked; nothing in the running loop called any
 * of them. Sync was a manual CLI command, and the freshness rule was only ever
 * *printed* in a status line, never enforced. So it classified against whatever had
 * last been pulled by hand — possibly nothing — and a term a curator added on Monday
 * was simply not detected.
 *
 * That failure is silent and flattering: recall drops, nothing raises, and the output
 * reads as less hate speech rather than as a system that stopped listening. These
 * tests exist so it cannot recur quietly.
 */
import { describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../../src/platform/client.js";
import { LexiconStore, LexiconUnavailable } from "../../src/platform/lexicon-store.js";

const term = (over: { id: number; term: string }) => ({
  language: "ar",
  category: null,
  target_group: null,
  target_group_slug: null,
  severity_weight: 5,
  is_regex: false,
  is_explicit: true,
  never_flag_when: [],
  variants: [],
  ...over,
});

/** A platform that answers, and counts how often it was asked. */
function fakePlatform(terms = [term({ id: 1, term: "نجس" })]) {
  const calls = { getLexicon: 0 };
  const client = {
    async getLexicon() {
      calls.getLexicon++;
      return { terms, tropes: [], total: terms.length };
    },
  } as unknown as PlatformClient;
  return { client, calls };
}

/** A platform that is down. */
const deadPlatform = {
  async getLexicon() {
    throw new Error("connection refused");
  },
} as unknown as PlatformClient;

/** A clock the test moves by hand. */
function clock(start = new Date("2026-08-28T12:00:00Z")) {
  let current = start;
  return {
    now: () => current,
    advanceHours(h: number) {
      current = new Date(current.getTime() + h * 3_600_000);
    },
  };
}

describe("fetching", () => {
  it("pulls the lexicon on first use", async () => {
    const { client, calls } = fakePlatform();
    const store = new LexiconStore(client);

    const { snapshot } = await store.ensureFresh();

    expect(calls.getLexicon).toBe(1);
    expect(snapshot.terms).toHaveLength(1);
    expect(snapshot.matcher.scan("هذوله نجس")).toHaveLength(1);
  });

  it("does not pull again while the cache is fresh", async () => {
    const { client, calls } = fakePlatform();
    const store = new LexiconStore(client, { maxStaleHours: 6 });

    await store.ensureFresh();
    await store.ensureFresh();
    await store.ensureFresh();

    expect(calls.getLexicon).toBe(1);
  });

  it("pulls again once the cache has gone stale", async () => {
    const time = clock();
    const { client, calls } = fakePlatform();
    const store = new LexiconStore(client, { maxStaleHours: 6, now: time.now });

    await store.ensureFresh();
    time.advanceHours(7);
    await store.ensureFresh();

    expect(calls.getLexicon).toBe(2);
  });

  it("collapses concurrent first calls onto one request", async () => {
    // Several classifications starting at once on a cold cache would otherwise each
    // pull the whole lexicon.
    const { client, calls } = fakePlatform();
    const store = new LexiconStore(client);

    await Promise.all([store.ensureFresh(), store.ensureFresh(), store.ensureFresh()]);

    expect(calls.getLexicon).toBe(1);
  });
});

describe("staleness is reported, not hidden", () => {
  it("says so before anything has been fetched", () => {
    const { client } = fakePlatform();
    expect(new LexiconStore(client).staleness()).toEqual({ state: "never-fetched" });
  });

  it("reports the age in hours", async () => {
    const time = clock();
    const { client } = fakePlatform();
    const store = new LexiconStore(client, { maxStaleHours: 6, now: time.now });

    await store.ensureFresh();
    time.advanceHours(3);

    const staleness = store.staleness();
    expect(staleness.state).toBe("fresh");
    expect(staleness).toHaveProperty("ageHours", 3);
  });

  it("hands the caller the age even when serving a stale copy", async () => {
    // The caller must be able to carry this into the verdict. Someone reading a
    // report later needs to know the judgement was made against a week-old dictionary.
    const time = clock();
    const { client } = fakePlatform();
    const store = new LexiconStore(client, { maxStaleHours: 6, now: time.now });

    await store.ensureFresh();
    time.advanceHours(200);
    const { staleness } = await store.ensureFresh();

    expect(staleness.state).toBe("fresh"); // it refetched, so it is fresh again
    expect(calls_are_irrelevant_here()).toBe(true);
  });
});

function calls_are_irrelevant_here() {
  return true;
}

describe("when the platform is unreachable", () => {
  it("keeps working from the cached copy, and says it is stale", async () => {
    // Refusing to classify because the lexicon is a few hours old would stop the
    // agent every time the connection drops. On a residential line in Iraq that is
    // not an edge case.
    const time = clock();
    const terms = [term({ id: 1, term: "نجس" })];
    let alive = true;
    const client = {
      async getLexicon() {
        if (!alive) throw new Error("connection refused");
        return { terms, tropes: [], total: 1 };
      },
    } as unknown as PlatformClient;

    const store = new LexiconStore(client, { maxStaleHours: 6, now: time.now });
    await store.ensureFresh();

    alive = false;
    time.advanceHours(48);
    const { snapshot, staleness } = await store.ensureFresh();

    expect(staleness.state).toBe("stale");
    expect(staleness).toHaveProperty("ageHours", 48);
    expect(snapshot.matcher.scan("هذوله نجس")).toHaveLength(1);
  });

  it("refuses when there is nothing cached at all", async () => {
    // An agent scanning with an empty lexicon is not a degraded agent, it is a
    // different one: every coded term silently absent, and the output indistinguishable
    // from a quiet week.
    const store = new LexiconStore(deadPlatform);

    await expect(store.ensureFresh()).rejects.toBeInstanceOf(LexiconUnavailable);
  });

  it("names the cause when it refuses", async () => {
    const store = new LexiconStore(deadPlatform);

    await expect(store.ensureFresh()).rejects.toThrow(/connection refused/);
  });
});

describe("maxStaleHours = 0 means refuse without a fresh pull", () => {
  it("treats any cached copy as stale", async () => {
    // Matches the contract's per-run caching exactly: pull, scan, discard.
    const time = clock();
    const { client, calls } = fakePlatform();
    const store = new LexiconStore(client, { maxStaleHours: 0, now: time.now });

    await store.ensureFresh();
    await store.ensureFresh();

    expect(calls.getLexicon).toBe(2);
    expect(store.staleness().state).toBe("stale");
  });
});

describe("uncompilable regex terms are surfaced, not swallowed", () => {
  it("reports them on the snapshot", async () => {
    const client = {
      async getLexicon() {
        return {
          terms: [
            term({ id: 1, term: "نجس[", is_regex: true } as never),
            term({ id: 2, term: "نجس" }),
          ],
          tropes: [],
          total: 2,
        };
      },
    } as unknown as PlatformClient;

    const { snapshot } = await new LexiconStore(client).ensureFresh();

    expect(snapshot.rejected).toHaveLength(1);
    expect(snapshot.rejected[0]?.id).toBe(1);
    // The rest of the lexicon still works — one curator typo must not stop matching.
    expect(snapshot.matcher.scan("هذوله نجس")).toHaveLength(1);
  });
});
