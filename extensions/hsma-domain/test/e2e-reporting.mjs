import fs from "node:fs";
// Proves the reporting path end to end: queue findings in the local outbox, flush them
// to a platform over real HTTP, and confirm the platform received them exactly once.
//
// This is the piece that was missing. The outbox existed and nothing drained it, so
// findings queued locally and never left.
import { DatabaseSync } from "node:sqlite";

const D = "C:/xampp/htdocs/hsma/extensions/hsma-domain/dist";
const BASE = "http://127.0.0.1:8803/";

const { EvidenceStore } = await import(`file:///${D}/store.js`);
const { PlatformClient } = await import(`file:///${D}/platform/client.js`);
const { flushOutbox } = await import(`file:///${D}/platform/reporter.js`);

const dbPath = "./prove-reporting.db";
try {
  fs.unlinkSync(dbPath);
} catch {}

const store = new EvidenceStore(dbPath);
const client = new PlatformClient({
  baseUrl: BASE,
  agentKey: "local-dev-key",
  agentId: "hsma-devbox",
});

// Fresh platform state, so the proof is repeatable rather than cumulative.
await fetch(`${BASE}__reset`);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. Queue work the agent would actually produce.
const gapId = store.queueForPlatform("lexicon-gap", {
  gaps: [{ term: "\u0646\u062c\u0633", language: "ar", evidence: "seen 4x under yazidi posts" }],
});
store.queueForPlatform("scan-log", { pages: 3, comments: 42, flagged: 2 });
// A kind the platform has no endpoint for. It must survive, not be discarded.
store.queueForPlatform("verdict", { verdict: "hate", confidence: 0.9 });

check(
  "three items queued",
  store.pendingOutbox().length === 3,
  `pending=${store.pendingOutbox().length}`,
);

// 2. Flush.
const result = await flushOutbox(store, client);
check("two supported kinds sent", result.sent === 2, JSON.stringify(result));
check("no failures", result.failed === 0, result.errors.map((e) => e.error).join("; "));
check(
  "unsupported kind reported, not dropped",
  result.unsupported.includes("verdict"),
  `unsupported=${JSON.stringify(result.unsupported)}`,
);

// 3. The unsupported item is still pending, not lost and not burned through retries.
const stillPending = store.pendingOutbox();
check(
  "unsupported item stays pending",
  stillPending.length === 1 && stillPending[0].kind === "verdict",
  `pending=${JSON.stringify(stillPending.map((r) => r.kind))}`,
);

// 4. The platform actually received them.
const all = await (await fetch(`${BASE}__received`)).json();
// Filter to this agent: the stub is shared and may hold probes from other callers.
const mine = all.received.filter((r) => r.agent === "hsma-devbox");
const received = { count: mine.length, received: mine };
check("platform received 2 posts", received.count === 2, `count=${received.count}`);
check(
  "agent id travelled on every request",
  received.received.every((r) => r.agent === "hsma-devbox"),
  JSON.stringify(received.received.map((r) => r.agent)),
);
check(
  "idempotency key sent and stable",
  received.received.every((r) => typeof r.key === "string" && r.key.length > 0),
  JSON.stringify(received.received.map((r) => r.key)),
);

// 5. A second flush must not resend what already went.
const second = await flushOutbox(store, client);
check("second flush sends nothing new", second.sent === 0, JSON.stringify(second));
const afterAll = await (await fetch(`${BASE}__received`)).json();
const afterMine = afterAll.received.filter((r) => r.agent === "hsma-devbox");
check("platform still has exactly 2", afterMine.length === 2, `count=${afterMine.length}`);

// 6. Idempotency actually replays rather than duplicating, using the row's own key.
const replay = await client.postLexiconGaps([{ term: "x", language: "ar" }], gapId);
check(
  "replaying a used key returns the stored response",
  replay?.replayed === true,
  JSON.stringify(replay),
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
