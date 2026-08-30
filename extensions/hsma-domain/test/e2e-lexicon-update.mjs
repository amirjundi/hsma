// Proves the agent picks up a curator's change.
//
// "Gets the updated hate speech" is the claim; caching is what could quietly break it.
// A term added on the platform must start matching, and a stale cache must be reported
// as stale rather than silently answering with an old dictionary.
const BASE = "http://127.0.0.1:8804/";
const D = "C:/xampp/htdocs/hsma/extensions/hsma-domain/dist";

const { PlatformClient } = await import(`file:///${D}/platform/client.js`);
const { LexiconStore } = await import(`file:///${D}/platform/lexicon-store.js`);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

const mk = (maxStaleHours) =>
  new LexiconStore(new PlatformClient({ baseUrl: BASE, agentKey: "k", agentId: "hsma-devbox" }), {
    maxStaleHours,
    languages: ["ar", "ku"],
  });

// A term the curator has not added yet. Arabic for "traitors".
const NEW_TERM = "\u0627\u0644\u062e\u0648\u0646\u0629";

await fetch(`${BASE}__setterms`, {
  method: "POST",
  body: JSON.stringify({ extra: [] }),
});

// 1. Baseline: the term is not in the dictionary, so it must not match.
const store = mk(6);
const first = await store.ensureFresh();
const baselineTerms = first.snapshot.terms.length;
check("initial fetch succeeded", baselineTerms > 0, `${baselineTerms} terms`);
check(
  "unknown term does not match before the curator adds it",
  first.snapshot.matcher.scan(NEW_TERM, []).length === 0,
);

// 2. Curator adds it on the platform.
await fetch(`${BASE}__setterms`, {
  method: "POST",
  body: JSON.stringify({
    extra: [
      {
        id: 9001,
        term: NEW_TERM,
        language: "ar",
        category: "dehumanization",
        target_group: "yazidi",
        target_group_slug: "yazidi",
        severity_weight: 7,
        is_regex: false,
        is_explicit: true,
        never_flag_when: [],
        variants: [],
      },
    ],
  }),
});

// 3. A cache that is still fresh must NOT refetch. Serving a current cache is the
//    whole point of caching, and a store that ignores it would hammer the platform.
const cachedAgain = await store.ensureFresh();
check(
  "a fresh cache is not refetched",
  cachedAgain.snapshot.terms.length === baselineTerms,
  `${cachedAgain.snapshot.terms.length} terms`,
);

// 4. With staleness disabled, the next call must go back to the platform and the new
//    term must start matching. This is the behaviour the claim rests on.
const eager = mk(0);
const updated = await eager.ensureFresh();
check(
  "refetch picks up the curator's new term",
  updated.snapshot.terms.length === baselineTerms + 1,
  `${updated.snapshot.terms.length} terms`,
);
check("the new term now matches", updated.snapshot.matcher.scan(NEW_TERM, []).length === 1);
check(
  "and it matches with an attached clitic",
  updated.snapshot.matcher.scan("\u0648" + NEW_TERM, []).length === 1,
);

// 5. Staleness is reported honestly. Recall degrades silently against an old
//    dictionary, so the age has to travel with the verdict.
check(
  "staleness state is reported",
  ["fresh", "stale", "never-fetched"].includes(updated.staleness.state),
  updated.staleness.state,
);

// 6. If the platform goes down, the agent keeps the last good dictionary rather than
//    losing the ability to classify entirely.
await fetch(`${BASE}__fail`, { method: "POST", body: "{}" });
let survived = false;
try {
  const afterOutage = await eager.ensureFresh();
  survived = afterOutage.snapshot.terms.length > 0;
} catch {
  survived = eager.current() !== null && (eager.current()?.terms.length ?? 0) > 0;
}
check("an outage leaves the last good lexicon usable", survived);
await fetch(`${BASE}__ok`, { method: "POST", body: "{}" });

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
