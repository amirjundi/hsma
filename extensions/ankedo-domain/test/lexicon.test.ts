/**
 * Ported from the Python agent's `test_arabic_clitics.py`, which was written after a
 * real miss.
 *
 * Arabic attaches its function words to the next word. `نجس` matched; `ونجس` — the
 * same word with "and" — did not, because a word-boundary check sees the `و` as part
 * of the word. Measured before the fix: `ونجس`, `بنجس`, `والكفار`, `وعملاء` and
 * `للعملاء` all missed while every bare form hit.
 *
 * `و` is among the commonest characters in written Arabic, so this was not an edge
 * case. And it failed silently in the flattering direction — nothing errored, the
 * queue was just emptier than the content warranted.
 *
 * The second half of this file matters as much as the first. Loosening the left
 * boundary must not start matching inside unrelated words: a false hit here names a
 * real person in an evidence file.
 */
import { describe, expect, it } from "vitest";
import { LexiconMatcher, type PlatformTerm } from "../src/lexicon.js";

/**
 * Terms in the platform's wire shape. These are fixtures for the matcher, not a
 * lexicon — the real one is fetched from `GET /api/hermes/lexicon/` and nothing in
 * this agent hardcodes a term.
 */
const term = (over: Partial<PlatformTerm> & { term: string }): PlatformTerm => ({
  id: 0,
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

const load = (terms: PlatformTerm[]) => LexiconMatcher.load(terms).matcher;

const NAJIS = term({ id: 1, term: "نجس", category: "dehumanization", severity_weight: 8 });
const AMALA = term({ id: 2, term: "عملاء", category: "disloyalty", severity_weight: 6 });
const CODED = term({
  id: 3,
  term: "دخلاء",
  category: "foreignness",
  severity_weight: 6,
  is_explicit: false,
  target_group: "Iraqi Christians",
  target_group_slug: "christian-iraqi",
});

const matcher = load([NAJIS, AMALA, CODED]);

describe("clitics — a term matches through its prefixes", () => {
  it.each([
    ["نجس", "bare"],
    ["ونجس", "و — and"],
    ["فنجس", "ف — so"],
    ["بنجس", "ب — with"],
    ["كنجس", "ك — like"],
    ["لنجس", "ل — for"],
    ["النجس", "ال — the"],
    ["والنجس", "و + ال"],
    ["بالنجس", "ب + ال"],
    ["للنجس", "ل + ال, contracted"],
  ])("%s (%s)", (form) => {
    const hits = matcher.scan(`هذوله ${form} هنا`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matched).toBe("نجس");
  });

  it("reports the bare term, not the prefixed string", () => {
    // The index is keyed on the term. If the clitic came back in `matched`, the
    // lookup would miss and every prefixed hit would vanish.
    const [hit] = matcher.scan("هذوله والنجس هنا");
    expect(hit?.matched).toBe("نجس");
    expect(hit?.term.severity_weight).toBe(8);
    expect(hit?.term.category).toBe("dehumanization");
  });

  it("finds two terms in one sentence", () => {
    // The sentence that exposed the bug: عملاء matched and ونجس, three words later,
    // did not — so the sentence scored half as bad as it was.
    const found = matcher.scan("هذوله عملاء ونجس ما يصير تاكل من ايدهم").map((h) => h.matched);
    expect(new Set(found)).toEqual(new Set(["عملاء", "نجس"]));
  });
});

describe("ordinary sentences stay clean", () => {
  it.each([
    "زرت لالش قبل سنة، مكان هادئ وناسه طيبين",
    "الطقس اليوم حار جدا في الموصل",
    "اجتمع مجلس المحافظة لمناقشة الخدمات",
    "المدرسة الجديدة فتحت ابوابها للطلاب",
    "الفريق فاز بالمباراة بثلاثة اهداف",
    "تكلمنا وياهم عن العمل والمستقبل",
  ])("%s", (sentence) => {
    expect(matcher.scan(sentence)).toEqual([]);
  });

  it("does not match a term inside a longer word", () => {
    // The right boundary stays strict: a clitic may precede the term, but the term
    // must still end where the word ends.
    expect(matcher.scan("هذا نجسيات شي ثاني")).toEqual([]);
  });
});

describe("scope — a coded term needs its group present", () => {
  it("is out of scope when the group is absent", () => {
    const [hit] = matcher.scan("هذوله دخلاء");
    expect(hit?.matched).toBe("دخلاء");
    expect(hit?.in_scope).toBe(false);
  });

  it("is in scope when the group is present", () => {
    const [hit] = matcher.scan("هذوله دخلاء", ["christian-iraqi"]);
    expect(hit?.in_scope).toBe(true);
  });

  it("an explicit slur is in scope regardless of the post's topic", () => {
    // FR-CL-4. Explicit hate is flagged whatever the surrounding post is about.
    const [hit] = matcher.scan("هذوله نجس");
    expect(hit?.in_scope).toBe(true);
  });
});

describe("variants and normalisation", () => {
  it("matches a variant as readily as the term", () => {
    const m = load([{ ...NAJIS, variants: ["انجاس"] }]);
    expect(m.scan("هذوله انجاس")[0]?.matched).toBe("انجاس");
  });

  it("matches through vocalisation, because scanning normalises first", () => {
    const m = load([{ ...NAJIS, term: "عبدة الشيطان" }]);
    expect(m.scan("قال عَبَدَةُ الشَّيْطَانِ هنا")).toHaveLength(1);
  });

  it("prefers the longer term when two could match", () => {
    const m = load([
      { ...AMALA, term: "عملاء" },
      { ...AMALA, id: 9, term: "عملاء الغرب", severity_weight: 8 },
    ]);
    const [hit] = m.scan("هذوله عملاء الغرب");
    expect(hit?.matched).toBe("عملاء الغرب");
  });
});

describe("scanning is repeatable", () => {
  it("gives the same answer twice", () => {
    // A shared global regex carries lastIndex between calls, so the second scan skips
    // matches and results depend on call order.
    const first = matcher.scan("هذوله نجس");
    const second = matcher.scan("هذوله نجس");
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });

  it("returns nothing for an empty lexicon", () => {
    expect(load([]).scan("أي نص")).toEqual([]);
  });
});

describe("is_regex — honoured, not merely stored", () => {
  /**
   * The Python agent carried this field from the platform, compiled it at sync time to
   * validate it, and then escaped every surface when matching — so a regex term was
   * matched as a literal string and could never fire. The flag existed; the behaviour
   * did not. A curator writing a pattern got silence.
   */
  it("matches a pattern rather than the literal characters", () => {
    const m = load([term({ id: 10, term: "نجس(ين|ه)?", is_regex: true })]);

    expect(m.scan("هذوله نجسين")).toHaveLength(1);
    expect(m.scan("هذوله نجسه")).toHaveLength(1);
  });

  it("does not match a regex term as a literal string", () => {
    const m = load([term({ id: 11, term: "كافر|كفار", is_regex: true })]);

    // The literal alternation text must not itself be what matches.
    expect(m.scan("قال كافر|كفار حرفيا").map((h) => h.matched)).not.toContain("كافر|كفار");
    expect(m.scan("هذوله كفار")).toHaveLength(1);
  });

  it("reports what the pattern actually matched", () => {
    const m = load([term({ id: 12, term: "نجس\\p{L}*", is_regex: true })]);
    const [hit] = m.scan("هذوله نجسين");

    expect(hit?.matched).toBe("نجسين");
    expect(hit?.term.id).toBe(12);
  });

  it("documents that \w does not mean the same thing on both sides", () => {
    /**
     * A cross-language hazard the curator cannot see. The platform validates a regex
     * term by compiling it in Python, where `\w` is Unicode-aware and matches Arabic.
     * This agent runs the same pattern in JavaScript, where `\w` is ASCII-only even
     * under the `u` flag.
     *
     * So `نجس\w*` compiles on both sides, is accepted by the platform, and matches
     * Arabic suffixes on one side and nothing on the other. It fails silently and in
     * the flattering direction — the term simply stops firing.
     *
     * A curator writing regex terms should use `\p{L}`. This test exists so the
     * difference is recorded rather than rediscovered.
     */
    const ascii = load([term({ id: 20, term: "نجس\\w*", is_regex: true })]);
    const unicode = load([term({ id: 21, term: "نجس\\p{L}*", is_regex: true })]);

    expect(ascii.scan("هذوله نجسين")[0]?.matched).toBe("نجس");
    expect(unicode.scan("هذوله نجسين")[0]?.matched).toBe("نجسين");
  });

  it("rejects an uncompilable pattern without losing the rest of the lexicon", () => {
    // One curator typo must not stop all matching. The bad term is reported, not
    // swallowed — a silently dropped term is a silently missed category of hate.
    const { matcher: m, rejected } = LexiconMatcher.load([
      term({ id: 13, term: "نجس[", is_regex: true }),
      NAJIS,
    ]);

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.id).toBe(13);
    expect(rejected[0]?.reason).toBeTruthy();
    expect(m.scan("هذوله نجس")).toHaveLength(1);
  });

  it("leaves literal terms escaped", () => {
    // A literal term containing regex metacharacters must still match itself.
    const m = load([term({ id: 14, term: "شنو؟" })]);
    expect(m.scan("قال شنو؟ هنا")).toHaveLength(1);
  });
});
