// Stays "openclaw/plugin-sdk" even though this fork's package is named "hsma".
// The specifier is not resolved by npm: the plugin loader aliases it itself, and
// PLUGIN_SDK_PACKAGE_PREFIXES in src/plugins/plugin-sdk-native-resolver.ts hardcodes
// "openclaw/plugin-sdk". Renaming it here makes the plugin fail to load.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
/**
 * HSMA — hate-speech monitoring tools for Arabic and Kurdish social media.
 *
 * Registers the agent's capabilities as OpenClaw tools. The model never invokes any of
 * this directly: it names a tool, OpenClaw validates the arguments against the schema,
 * and this code runs. The content this agent reads is written by strangers, so the
 * tool surface is the injection surface — it is deliberately small, and anything that
 * changes state is separated from anything that merely reads.
 */
import { Type } from "typebox";
import { ExemptionChecker } from "./exemptions.js";
import { PlatformClient } from "./platform/client.js";
import { LexiconStore } from "./platform/lexicon-store.js";
import { activeHours, coverage, isBaselineCrawl, reviewPages } from "./schedule.js";
import { EvidenceStore } from "./store.js";
import { TropeEngine } from "./tropes.js";

export * from "./normalize.js";
export * from "./lexicon.js";
export * from "./tropes.js";
export * from "./exemptions.js";
export * from "./schedule.js";
export * from "./schema.js";
export * from "./store.js";
export * from "./platform/client.js";
export * from "./platform/lexicon-store.js";

interface AnkedoConfig {
  platformUrl?: string;
  agentKey?: string;
  agentId?: string;
  databasePath?: string;
  maxStaleHours?: number;
}

/** One store and one lexicon cache per process, built on first use. */
let store: EvidenceStore | null = null;
let lexicon: LexiconStore | null = null;

function evidence(config: AnkedoConfig): EvidenceStore {
  store ??= new EvidenceStore(config.databasePath ?? "./hsma.db");
  return store;
}

function platform(config: AnkedoConfig): LexiconStore {
  if (!lexicon) {
    if (!config.platformUrl || !config.agentKey) {
      throw new Error(
        "No platform configured. The lexicon belongs to the platform and is not " +
          "hardcoded here — set platformUrl and agentKey.",
      );
    }
    lexicon = new LexiconStore(
      new PlatformClient({
        baseUrl: config.platformUrl,
        agentKey: config.agentKey,
        // Always sent: the platform scopes idempotency on (agent_id, key), so an
        // agent omitting it shares the '' namespace with every other agent that does.
        agentId: config.agentId ?? "hsma-agent",
      }),
      { maxStaleHours: config.maxStaleHours ?? 6, languages: ["ar", "ku"] },
    );
  }
  return lexicon;
}

export default defineToolPlugin({
  id: "hsma",
  name: "HSMA",
  description:
    "Hate-speech monitoring for Arabic and Kurdish social media targeting Iraqi minorities.",
  configSchema: Type.Object({
    platformUrl: Type.Optional(
      Type.String({ description: "Ettok base URL, e.g. https://ettok.net/api/hermes/" }),
    ),
    agentKey: Type.Optional(
      Type.String({ description: "Agent key carrying the hate_speech_scan scope." }),
    ),
    agentId: Type.Optional(Type.String({ description: "Sent as X-Agent-Id on every request." })),
    databasePath: Type.Optional(Type.String({ description: "Local evidence store path." })),
    maxStaleHours: Type.Optional(
      Type.Number({
        description: "How old the cached lexicon may be. 0 refuses without a fresh pull.",
      }),
    ),
  }),
  tools: (tool) => [
    tool({
      name: "classify",
      label: "Classify text",
      description:
        "Judge Arabic or Kurdish text for hate speech against Iraqi minorities. " +
        "Always pass the post a comment replied to when you have it: the same words " +
        "are hate under one post and ordinary under another, and the verdict depends " +
        "on it.",
      parameters: Type.Object({
        text: Type.String({ description: "The comment or post to judge." }),
        parentPostText: Type.Optional(
          Type.String({ description: "The post this replies to. Strongly affects the verdict." }),
        ),
        targetGroups: Type.Optional(
          Type.Array(Type.String(), { description: "Group slugs, if already known." }),
        ),
      }),
      async execute({ text, parentPostText, targetGroups }, config: AnkedoConfig, context) {
        context.signal?.throwIfAborted();

        const { snapshot, staleness } = await platform(config).ensureFresh();
        const groups = targetGroups ?? [];

        const hits = snapshot.matcher.scan(text, groups);
        const tropes = new TropeEngine(snapshot.tropes).evaluate({
          text,
          parentPostText,
          targetGroups: groups,
        });

        const flagged =
          hits.some((h) => h.in_scope && h.term.is_explicit) || tropes.fired.length > 0;

        // The exemption layer runs last and can only withhold, never add. An
        // exemption routes the item to a human rather than clearing it silently.
        const checker = new ExemptionChecker([]);
        const signals = checker.detectSignals({ text, targetGroups: groups });
        const exemption = flagged ? ExemptionChecker.check(hits, signals) : null;

        return {
          verdict: exemption ? "ambiguous" : flagged ? "hate" : "benign",
          flagged: flagged && !exemption,
          judgedInContext: Boolean(parentPostText),
          lexiconHits: hits.map((h) => ({
            matched: h.matched,
            category: h.term.category,
            severity: h.term.severity_weight,
            inScope: h.in_scope,
          })),
          tropesFired: tropes.fired.map((t) => ({ name: t.name, reason: t.reason })),
          tropeCandidates: tropes.candidates.map((t) => ({ name: t.name, reason: t.reason })),
          exemption: exemption ? { signal: exemption.signal, detail: exemption.detail } : null,
          // Recall degrades silently against a stale dictionary, so its age travels
          // with the verdict rather than being discoverable only by asking.
          lexiconAgeHours: staleness.state === "never-fetched" ? null : staleness.ageHours,
          staleLexicon: staleness.state === "stale",
        };
      },
    }),

    tool({
      name: "lexicon_status",
      label: "Lexicon status",
      description:
        "How many terms and patterns the agent is matching with, and how old they are. " +
        "A stale lexicon misses terms a curator has added, with no error anywhere.",
      parameters: Type.Object({}),
      async execute(_params, config: AnkedoConfig) {
        const cache = platform(config);
        const current = cache.current();
        const staleness = cache.staleness();

        return {
          terms: current?.terms.length ?? 0,
          tropes: current?.tropes.length ?? 0,
          state: staleness.state,
          ageHours: staleness.state === "never-fetched" ? null : staleness.ageHours,
          // Regex terms the platform sent that would not compile here. Never silent:
          // a dropped term is a silently missed category of hate speech.
          rejectedRegexTerms: current?.rejected ?? [],
        };
      },
    }),

    tool({
      name: "case_open",
      label: "Open a case",
      description: "Start a monitoring campaign: a target group, a narrative, keywords to watch.",
      parameters: Type.Object({
        targetGroupSlug: Type.String({ description: "e.g. yazidi, christian-iraqi, shabak." }),
        narrative: Type.Optional(Type.String({ description: "What this case is about." })),
        watchKeywords: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(params, config: AnkedoConfig) {
        const record = evidence(config).openCase(params);
        return { id: record.id, state: record.state };
      },
    }),

    tool({
      name: "case_status",
      label: "Case status",
      description:
        "Every case with its state, what it has found, and the hours the agent has " +
        "learned to crawl — including the hours it is not watching.",
      parameters: Type.Object({}),
      async execute(_params, config: AnkedoConfig) {
        const db = evidence(config);
        const counts = db.crawlCounts();

        return {
          cases: db.listCases().map((c) => {
            const window = activeHours(db.flaggedHours(c.id));
            return {
              id: c.id,
              targetGroup: c.targetGroupSlug,
              narrative: c.narrative,
              state: c.state,
              lastActivityAt: c.lastActivityAt,
              schedule: { hours: window.hours, learned: window.learned, why: window.reason },
              // The agent states its own blind spots. A learned schedule creates real
              // gaps, and a report that cannot name them invites the objection that
              // absence of evidence was read as evidence of absence.
              coverage: coverage(window, counts.baseline, counts.total),
            };
          }),
        };
      },
    }),

    tool({
      name: "review_queue",
      label: "Review queue",
      description:
        "Items waiting for a human: flagged, ambiguous, or where the committee disagreed.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "How many, default 20." })),
      }),
      async execute({ limit }, config: AnkedoConfig) {
        const rows = evidence(config).reviewQueue(limit ?? 20);
        return {
          count: rows.length,
          items: rows.map((r) => ({
            id: r.id,
            verdict: r.verdict,
            confidence: r.confidence,
            text: r.comment_text ?? r.post_text,
            url: r.url,
            lexiconAgeHours: r.lexicon_age_hours,
          })),
        };
      },
    }),

    tool({
      name: "next_crawl",
      label: "What to crawl next",
      description:
        "Which pages are due now, given the hour and what the agent has learned. " +
        "Answers 'should I be running right now, and where'.",
      parameters: Type.Object({
        caseId: Type.Optional(Type.String()),
      }),
      async execute({ caseId }, config: AnkedoConfig) {
        const db = evidence(config);
        const counts = db.crawlCounts();
        const hour = new Date().getUTCHours();

        // A share of crawls deliberately ignore the learned window. Without them the
        // agent only ever looks where it already found something, and nobody can tell
        // "no hate speech here" from "never looked here".
        const baseline = isBaselineCrawl(counts.total);
        const window = caseId ? activeHours(db.flaggedHours(caseId)) : null;
        const inWindow = window ? window.hours.includes(hour) : true;

        return {
          shouldCrawl: baseline || inWindow,
          baselineCrawl: baseline,
          utcHour: hour,
          reason: baseline
            ? "baseline sample — deliberately crawling outside the learned window"
            : window
              ? `${inWindow ? "within" : "outside"} the learned window (${window.reason})`
              : "no case given, so no learned window applies",
          pages: db.duePages(caseId).map((p) => ({
            id: p.id,
            platform: p.platform,
            handle: p.handle,
            stance: p.stance,
            lastCrawledAt: p.lastCrawledAt,
          })),
          // Proposals, never applied automatically. Muting stops a page being crawled
          // at all, and a page that goes quiet then erupts is what this exists for.
          stanceProposals: reviewPages(db.pageOutcomes(caseId)).filter((d) => d.stance !== "watch"),
        };
      },
    }),
  ],
});
