/**
 * The lexicon the agent is currently matching with, and how old it is.
 *
 * The platform owns the lexicon: a curator adds a term in the dashboard and every
 * agent should pick it up. "Should" is the whole problem. The Python agent had a
 * working sync, a freshness rule, and a CLI command — and nothing ever called them
 * from the running loop. It classified against whatever had last been pulled by hand,
 * or against nothing at all, and the freshness gate was only ever printed in a status
 * line. A term a curator added on Monday was simply not detected, with no error.
 *
 * That is the failure this module exists to prevent, and the reason it reports age
 * rather than merely caching: **a stale lexicon fails silently and in the flattering
 * direction.** Recall drops, nothing raises, and the output reads as less hate speech
 * rather than as a system that has stopped listening.
 */
import { LexiconMatcher, type PlatformTerm } from "../lexicon.js";
import type { PlatformClient, PlatformTrope } from "./client.js";

export interface LexiconSnapshot {
  matcher: LexiconMatcher;
  terms: PlatformTerm[];
  tropes: PlatformTrope[];
  fetchedAt: Date;
  /** Regex terms the platform sent that would not compile here. Never silent. */
  rejected: Array<{ id: number; term: string; reason: string }>;
}

export type Staleness =
  | { state: "fresh"; ageHours: number }
  | { state: "stale"; ageHours: number }
  | { state: "never-fetched" };

export interface LexiconStoreOptions {
  /**
   * How old the cache may be and still be used.
   *
   * `0` means refuse to scan without a fresh pull, matching the contract's per-run
   * caching exactly. Anything higher trades a little staleness for the ability to keep
   * working through a connectivity drop — which on a residential line in Iraq is not
   * an edge case.
   */
  maxStaleHours?: number;
  /** Languages to request. `ar` and `ku` for this deployment. */
  languages?: string[];
  /** Injectable for tests. */
  now?: () => Date;
}

export class LexiconUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LexiconUnavailable";
  }
}

export class LexiconStore {
  private snapshot: LexiconSnapshot | null = null;
  private inFlight: Promise<LexiconSnapshot> | null = null;

  private readonly maxStaleHours: number;
  private readonly languages: string[];
  private readonly now: () => Date;

  private readonly client: PlatformClient;

  constructor(client: PlatformClient, options: LexiconStoreOptions = {}) {
    this.client = client;
    this.maxStaleHours = options.maxStaleHours ?? 6;
    this.languages = options.languages ?? [];
    this.now = options.now ?? (() => new Date());
  }

  /** How old the cached lexicon is, without fetching anything. */
  staleness(): Staleness {
    if (!this.snapshot) return { state: "never-fetched" };
    const ageHours = (this.now().getTime() - this.snapshot.fetchedAt.getTime()) / 3_600_000;
    return {
      state: this.maxStaleHours > 0 && ageHours <= this.maxStaleHours ? "fresh" : "stale",
      ageHours,
    };
  }

  /** What is cached right now, or null. Does not fetch. */
  current(): LexiconSnapshot | null {
    return this.snapshot;
  }

  /**
   * The lexicon to scan with, refreshed if it has gone stale.
   *
   * When the platform is unreachable and a cached copy exists, the cached copy is
   * returned rather than throwing. Refusing to classify because the lexicon is a few
   * hours old would stop the agent working every time the connection drops, which is
   * worse than matching against a slightly older dictionary — but the caller is told
   * how old it is, and must carry that into the verdict. Someone reading a report
   * later needs to know the judgement was made against a week-old dictionary.
   *
   * With no cached copy at all there is nothing to fall back to, so it throws. An
   * agent that classifies with an empty lexicon is not a degraded agent, it is a
   * different one — every coded term silently absent.
   */
  async ensureFresh(): Promise<{ snapshot: LexiconSnapshot; staleness: Staleness }> {
    const before = this.staleness();
    if (before.state === "fresh" && this.snapshot) {
      return { snapshot: this.snapshot, staleness: before };
    }

    try {
      const snapshot = await this.fetch();
      return { snapshot, staleness: this.staleness() };
    } catch (err) {
      if (this.snapshot) {
        // Degraded, not broken. The caller decides what to do with the age.
        return { snapshot: this.snapshot, staleness: this.staleness() };
      }
      throw new LexiconUnavailable(
        `no lexicon: the platform is unreachable and nothing is cached — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Force a pull, ignoring the cache. */
  async refresh(): Promise<LexiconSnapshot> {
    return this.fetch();
  }

  private fetch(): Promise<LexiconSnapshot> {
    // Collapse concurrent callers onto one request. Several classifications starting
    // at once on a cold cache would otherwise each pull the whole lexicon.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const response = await this.client.getLexicon(this.languages);
      const { matcher, rejected } = LexiconMatcher.load(response.terms);

      this.snapshot = {
        matcher,
        terms: response.terms,
        tropes: response.tropes,
        fetchedAt: this.now(),
        rejected,
      };
      return this.snapshot;
    })();

    return this.inFlight.finally(() => {
      this.inFlight = null;
    });
  }
}
