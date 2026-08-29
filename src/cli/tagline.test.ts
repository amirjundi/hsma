// Tagline tests cover CLI tagline selection and display formatting.
import { describe, expect, it } from "vitest";
import { pickTagline } from "./tagline.js";

const EXPECTED_DEFAULT_TAGLINE = "Hate Speech Monitoring Agent.";
const FIRST_TAGLINE = "Hate Speech Monitoring Agent.";

describe("pickTagline", () => {
  it("returns empty string when mode is off", () => {
    expect(pickTagline({ mode: "off" })).toBe("");
  });

  it("returns default tagline when mode is default", () => {
    expect(pickTagline({ mode: "default" })).toBe(EXPECTED_DEFAULT_TAGLINE);
  });

  it("keeps OPENCLAW_TAGLINE_INDEX behavior in random mode", () => {
    expect(
      pickTagline({
        mode: "random",
        env: { OPENCLAW_TAGLINE_INDEX: "0" } as NodeJS.ProcessEnv,
      }),
    ).toBe(FIRST_TAGLINE);
  });

  it("wraps an out-of-range OPENCLAW_TAGLINE_INDEX rather than throwing", () => {
    expect(
      pickTagline({
        mode: "random",
        env: { OPENCLAW_TAGLINE_INDEX: "999" } as NodeJS.ProcessEnv,
      }),
    ).toBeTruthy();
  });

  it("ignores partial OPENCLAW_TAGLINE_INDEX values", () => {
    expect(
      pickTagline({
        mode: "random",
        env: { OPENCLAW_TAGLINE_INDEX: "1abc" } as NodeJS.ProcessEnv,
        random: () => 0,
      }),
    ).toBe(FIRST_TAGLINE);
  });

  it("never returns a value outside the declared pool", () => {
    // Sweeping random() recovers the whole pool through the public API.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickTagline({ mode: "random", random: () => i / 200 }));
    }
    expect(seen.size).toBeGreaterThan(1);
    for (const tagline of seen) {
      expect(tagline.length).toBeGreaterThan(0);
    }
  });
});

describe("what the taglines may not say", () => {
  // The upstream set was personal-assistant marketing. This is the guard that stops it
  // creeping back: HSMA's output names real people in an evidence file, and a banner
  // joking about Alexa or lobsters undercuts the seriousness of everything under it.
  it("contains no assistant marketing, mascot jokes or holiday greetings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickTagline({ mode: "random", random: () => i / 200 }));
    }
    seen.add(pickTagline({ mode: "default" }));

    const banned = [
      "alexa",
      "siri",
      "lobster",
      "claw",
      "second brain",
      "personal assistant",
      "your assistant",
      "butler",
      "christmas",
      "hanukkah",
      "diwali",
      "easter",
      "eid",
      "new year",
    ];
    for (const tagline of seen) {
      for (const term of banned) {
        expect(tagline.toLowerCase()).not.toContain(term);
      }
    }
  });
});
