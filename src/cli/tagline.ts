// CLI tagline selection. Deterministic under an injected random source and an
// explicit index override, so the banner stays testable.
import { expectDefined } from "@openclaw/normalization-core";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";

const DEFAULT_TAGLINE = "Hate Speech Monitoring Agent.";
export type TaglineMode = "random" | "default" | "off";

// Sober by design. Upstream shipped roughly ninety jokey personal-assistant taglines
// -- Alexa quips, lobster puns, "your second brain" -- plus a set of per-holiday
// greetings. HSMA reports to people documenting attacks on their own communities, and
// its output names real people in an evidence file. Banter is wrong in that context,
// so these state what the tool does and nothing more.
//
// The holiday machinery went with them: it existed only to gate those greetings by
// date, and an empty holiday table would have left ~130 lines of dead rules behind.
const TAGLINES: string[] = [
  "Hate Speech Monitoring Agent.",
  "Arabic and Kurdish social media. Iraqi minorities.",
  "Collects, judges, and puts findings in front of a human.",
  "A comment is judged against what it replies to.",
  "Findings are evidence. A human decides what happens next.",
];

export interface TaglineOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  /** Retained so callers that pinned a date keep compiling; no longer consulted. */
  now?: () => Date;
  mode?: TaglineMode;
}

export function pickTagline(options: TaglineOptions = {}): string {
  if (options.mode === "off") {
    return "";
  }
  if (options.mode === "default") {
    return DEFAULT_TAGLINE;
  }
  const pool = TAGLINES.length > 0 ? TAGLINES : [DEFAULT_TAGLINE];

  // Kept as OPENCLAW_TAGLINE_INDEX rather than renamed: environment variables are
  // internal identifiers, and renaming them conflicts with every upstream merge while
  // changing nothing an operator sees.
  const env = options.env ?? process.env;
  const override = env?.OPENCLAW_TAGLINE_INDEX;
  if (override !== undefined) {
    const parsed = parseStrictNonNegativeInteger(override);
    if (parsed !== undefined) {
      return expectDefined(pool[parsed % pool.length], "pool entry at parsed % pool.length");
    }
  }

  const rand = options.random ?? Math.random;
  const index = Math.floor(rand() * pool.length) % pool.length;
  return expectDefined(pool[index], "pool entry at index");
}
