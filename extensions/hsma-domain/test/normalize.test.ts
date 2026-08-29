/**
 * Parity with the platform's canonical fold.
 *
 * The lexicon lives on the platform. Prefiltering here only works if both sides reduce
 * text to the same canonical form, and a divergence does not raise — matching silently
 * degrades and the output looks like an absence of hate speech.
 *
 * The Python agent guarded this by importing the platform's `normalize.py` directly.
 * A TypeScript port cannot, so the guard would have died in the move. The platform
 * session generates `normalize_fixtures.json` from the canonical fold instead, and
 * guards the fixtures on their side so the file cannot go stale without a test
 * failing there too.
 *
 * The `partial_folds` group is the one to read before changing anything here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalize } from "../src/normalize.js";

interface Fixture {
  input: string;
  expected: string;
  why?: string;
}

interface Fixtures {
  folds: Fixture[];
  preserves: Fixture[];
  partial_folds: Fixture[];
  terms: Fixture[];
}

// Read from the platform repository directly. Copying the file here would reintroduce
// exactly the staleness the fixtures exist to remove: their generator would move on
// and our copy would keep passing.
const FIXTURES_PATH =
  process.env.ANKEDO_NORMALIZE_FIXTURES ??
  "C:/xampp/htdocs/Ettok.net/news_platform/apps/hate_speech/data/normalize_fixtures.json";

const fixtures: Fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));

describe("normalize — parity with the platform", () => {
  it("has every fixture group populated", () => {
    // A regeneration that quietly dropped a group would otherwise leave this suite
    // green while testing nothing. The platform asserts the same thing on its side.
    expect(fixtures.folds.length).toBeGreaterThan(0);
    expect(fixtures.preserves.length).toBeGreaterThanOrEqual(7);
    expect(fixtures.partial_folds.length).toBeGreaterThan(0);
    expect(fixtures.terms.length).toBeGreaterThan(0);
  });

  describe("folds — decoration and orthographic variants collapse", () => {
    it.each(fixtures.folds)("$input → $expected  ($why)", ({ input, expected }) => {
      expect(normalize(input)).toBe(expected);
    });
  });

  describe("preserves — Kurdish letters survive", () => {
    // Standard Arabic search normalisation collapses hamza carriers into alef. Doing
    // that here would destroy Kurdish orthography, and the terms it destroys are the
    // ones naming the communities this system protects.
    it.each(fixtures.preserves)("$input stays $expected  ($why)", ({ input, expected }) => {
      expect(normalize(input)).toBe(expected);
    });
  });

  describe("partial_folds — the trap", () => {
    /**
     * `ئێزیدی` does NOT round-trip. It becomes `ئێزيدي`: the `ئ` and `ێ` survive, the
     * plain Farsi yeh `ی` folds to `ي` like any other yeh.
     *
     * This looks like a bug. The obvious repair — stop folding `ی` — would break
     * parity with every term already stored on the platform, silently. If one of these
     * fails, the fix is almost certainly not in this repository.
     */
    it.each(fixtures.partial_folds)("$input → $expected  ($why)", ({ input, expected }) => {
      expect(normalize(input)).toBe(expected);
    });

    it("does not leave the Kurdish word for Yazidi unchanged", () => {
      // Stated as its own assertion so the intent survives even if the fixture file
      // is unavailable: someone reading this must not "restore" the round-trip.
      expect(normalize("ئێزیدی")).not.toBe("ئێزیدی");
      expect(normalize("ئێزیدی")).toBe("ئێزيدي");
    });
  });

  describe("terms — whole attested terms, end to end", () => {
    // These catch an ordering error that character-level cases cannot: fold before
    // strip and the vocalised form stops reducing to the bare one, because the harakat
    // sit between the letters being folded.
    it.each(fixtures.terms)("$input → $expected", ({ input, expected }) => {
      expect(normalize(input)).toBe(expected);
    });
  });
});

describe("normalize — basics", () => {
  it("returns empty for empty input", () => {
    expect(normalize("")).toBe("");
  });

  it("collapses runs of whitespace", () => {
    expect(normalize("  عبدة   الشيطان \n")).toBe("عبده الشيطان");
  });
});
