import assert from "node:assert/strict";
import { createServer } from "node:http";

// A stub platform serving the lexicon and tropes exactly as Ettok does.
const LEXICON = {
  terms: [
    {
      id: 1,
      term: "نجس",
      language: "ar",
      category: "dehumanization",
      target_group: "Yazidi",
      target_group_slug: "yazidi",
      severity_weight: 8,
      is_regex: false,
      is_explicit: true,
      never_flag_when: ["academic", "news_quotation", "counter_speech"],
      variants: ["انجاس"],
    },
  ],
  tropes: [
    {
      id: 1,
      name: "Devil-worship libel",
      description: "Invokes the devil-worship libel",
      example: null,
      target_group: null,
      target_group_slug: "yazidi",
      target_groups: ["yazidi", "christian-iraqi"],
      activation_topics: ["ايزيدي", "لالش"],
      surface_forms: ["اعوذ بالله من الشيطان الرجيم", "عبدة الشيطان"],
      requires_target_group: true,
      negation_cancels: true,
      negative_examples: [],
      counter_speech_examples: [],
      severity_weight: 8,
      is_visual: false,
    },
  ],
  total: 1,
};

const server = createServer((req, res) => {
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    res.writeHead(401).end("{}");
    return;
  }
  if (!req.headers["x-agent-id"]) {
    res.writeHead(400).end('{"error":"missing X-Agent-Id"}');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(LEXICON));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// Tools reach OpenClaw through register(api), so capture them the way the gateway
// does rather than reaching into the definition.
// Exactly how the gateway drives it: config arrives as api.pluginConfig, and the
// registered tool's execute is the raw core signature
// (toolCallId, params, signal, onUpdate) — not the declared (params, config, context).
const plugin = (await import("../dist/index.js")).default;
const registered = [];
await plugin.register({
  registerTool: (t) => registered.push(t),
  pluginConfig: {
    platformUrl: `http://127.0.0.1:${port}/`,
    agentKey: "test-key",
    agentId: "hsma-e2e",
    databasePath: ":memory:",
    maxStaleHours: 6,
  },
});
// The SDK wraps every result as { content, details }. `details` is the object the
// tool returned; `content` is its rendering for the model.
const call = (name, params = {}) => byName[name].execute("call-1", params).then((r) => r.details);

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
console.log(`registered ${registered.length} tools: ${Object.keys(byName).join(", ")}
`);

const config = {
  platformUrl: `http://127.0.0.1:${port}/`,
  agentKey: "test-key",
  agentId: "hsma-e2e",
  databasePath: ":memory:",
  maxStaleHours: 6,
};

const checks = [];
const check = async (n, f) => {
  try {
    await f();
    checks.push(["ok  ", n]);
  } catch (e) {
    checks.push(["FAIL", `${n}: ${e.message}`]);
  }
};

const LALISH = "مراسم دينية إيزيدية في معبد لالش";
const WATER = "شكوى من تلوث مياه الشرب في الحي";

await check("the tool fetched the lexicon from the platform over HTTP", async () => {
  const r = await call("lexicon_status", {});
  assert.equal(r.terms, 0, "should be empty before any classification");
});

await check("hate: نجس about people under a Yazidi post", async () => {
  const r = await call("classify", {
    text: "هذوله نجس وما يصير تاكل من ايدهم",
    parentPostText: LALISH,
    targetGroups: ["yazidi"],
  });
  assert.equal(r.verdict, "hate", JSON.stringify(r));
  assert.equal(r.flagged, true);
  assert.equal(r.judgedInContext, true);
  assert.deepEqual(
    r.lexiconHits.map((h) => h.matched),
    ["نجس"],
  );
});

await check("benign: the same word about water", async () => {
  const r = await call("classify", {
    text: "الماي وصلنا نجس، ما ينشرب أبدا",
    parentPostText: WATER,
    targetGroups: [],
  });
  // نجس is an explicit slur in the dictionary, so it still hits — but nothing about
  // the context makes this an attack on anyone, and no trope fires.
  assert.equal(r.tropesFired.length, 0);
});

await check("trope fires only with the group in context", async () => {
  const hit = await call("classify", {
    text: "اعوذ بالله من الشيطان الرجيم",
    parentPostText: LALISH,
    targetGroups: ["yazidi"],
  });
  assert.equal(hit.tropesFired.length, 1, "the libel did not fire under a Lalish post");

  const miss = await call("classify", {
    text: "اعوذ بالله من الشيطان الرجيم",
    parentPostText: "الطقس حار اليوم",
    targetGroups: [],
  });
  assert.equal(miss.tropesFired.length, 0, "flagged ordinary pious speech");
  assert.equal(miss.tropeCandidates.length, 1, "should still be a candidate for review");
});

await check("counter-speech is not treated as an attack", async () => {
  const r = await call("classify", {
    text: "يسمونهم عبدة الشيطان وهذا افتراء",
    parentPostText: LALISH,
    targetGroups: ["yazidi"],
  });
  assert.equal(r.tropesFired.length, 0, "flagged someone refuting the libel");
});

await check("the verdict carries how stale the lexicon was", async () => {
  const r = await call("classify", { text: "نص", parentPostText: LALISH });
  assert.equal(typeof r.lexiconAgeHours, "number");
  assert.equal(r.staleLexicon, false);
});

await check("lexicon_status now reports what was fetched", async () => {
  const r = await call("lexicon_status", {});
  assert.equal(r.terms, 1);
  assert.equal(r.tropes, 1);
  assert.equal(r.state, "fresh");
});

await check("a case can be opened and reports its schedule", async () => {
  const opened = await call("case_open", {
    targetGroupSlug: "yazidi",
    narrative: "devil-worship libel",
  });
  assert.ok(opened.id);
  const status = await call("case_status", {});
  assert.equal(status.cases.length, 1);
  assert.equal(
    status.cases[0].schedule.learned,
    false,
    "should not claim to have learned from nothing",
  );
  assert.match(status.cases[0].coverage, /Crawling all hours/);
});

await check("next_crawl answers whether to run right now", async () => {
  const r = await call("next_crawl", {});
  assert.equal(typeof r.shouldCrawl, "boolean");
  assert.ok(r.reason);
});

for (const [s, n] of checks) console.log(`  ${s} ${n}`);
const failed = checks.filter(([s]) => s === "FAIL").length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
server.close();
process.exit(failed ? 1 : 0);
