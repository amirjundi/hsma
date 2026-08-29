/**
 * Lexicon matching against normalised text.
 *
 * **The lexicon is not defined here.** The platform owns it — `GET /api/hermes/lexicon/`
 * returns the curated terms, and a curator's edit in the dashboard reaches every agent
 * on the next sync. This module matches whatever it is handed and knows nothing about
 * where the terms came from: a platform sync, an offline pack, or a test fixture.
 *
 * `PlatformTerm` is the platform's wire shape, field-for-field, deliberately in its
 * snake_case form rather than translated. A camelCase mirror would be tidier to read
 * and would drift: the day the platform adds a field, a translation layer silently
 * drops it, while this shape fails to compile.
 */
import { Normalizer } from "./normalize.js";

/**
 * One term exactly as `GET /api/hermes/lexicon/` returns it.
 * Source: `apps/hate_speech/urls_hermes.py::hermes_get_lexicon`.
 */
export interface PlatformTerm {
  id: number;
  term: string;
  /** `ar` | `ku` | `en` | `syr` — the language the term is written in. */
  language: string;
  /** One of `HateSpeechCategory.lexicon_slugs()`. Free text on the model. */
  category: string | null;
  /** Legacy free-text group. Prefer `target_group_slug`. */
  target_group: string | null;
  /** Resolved slug, or null when the platform could not resolve the free text. */
  target_group_slug: string | null;
  severity_weight: number;
  /** When true, `term` is a regular expression rather than a literal. */
  is_regex: boolean;
  /**
   * An explicit slur flags regardless of what the surrounding post is about
   * (FR-CL-4). A coded term only counts when its group is present in context.
   */
  is_explicit: boolean;
  /** `counter_speech` | `news_quotation` | `academic` | `reclaimed`. */
  never_flag_when: string[];
  variants: string[];
}

export interface LexiconHit {
  term: PlatformTerm;
  /** The surface that matched, normalised. The bare term, never a clitic prefix. */
  matched: string;
  /**
   * What a flag should gate on. Explicit slurs and terms with no group are always in
   * scope; a group-specific term is in scope only when its group is present.
   */
  in_scope: boolean;
}

/**
 * Arabic writes its conjunctions, prepositions and article as prefixes on the
 * following word, with no space. So `نجس` is a hit and `ونجس` — the same word with
 * "and" — was not, because a word-boundary check sees the `و` as part of the word.
 *
 * Measured before this existed: `ونجس`, `بنجس`, `والكفار`, `وعملاء` and `للعملاء` all
 * missed while every bare form matched. `و` is among the commonest characters in
 * written Arabic, so this was not an edge case — and it failed in the quiet direction.
 * Nothing raised; the queue was simply emptier than the content warranted.
 *
 * Deliberately not a general prefix-stripper. Arbitrary leading letters would make
 * `عملاء` match inside unrelated words, and a false hit here puts a named person into
 * a human-rights record. This is the closed set of clitics Arabic actually attaches.
 */
const CLITICS = "(?:[وف]?(?:لل|بال|كال|وال|ال|[بكل])?)";

/**
 * A word character, Unicode-aware.
 *
 * Not `\w`. Python's `\w` is Unicode-aware; JavaScript's is ASCII-only even under the
 * `u` flag, so `(?!\w)` is satisfied by any Arabic letter and the boundary check
 * silently does nothing. Ported literally from the Python, `نجس` matched inside
 * `نجسيات`.
 */
const BOUNDARY = "[\\p{L}\\p{N}_]";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

interface CompiledRegexTerm {
  term: PlatformTerm;
  pattern: RegExp;
}

export interface LexiconLoadResult {
  matcher: LexiconMatcher;
  /** Terms whose regex would not compile, with the reason. Never silently dropped. */
  rejected: Array<{ id: number; term: string; reason: string }>;
}

export class LexiconMatcher {
  private readonly normalizer = new Normalizer();
  private readonly literalPattern: RegExp | null;
  private readonly bySurface = new Map<string, PlatformTerm>();
  private readonly regexTerms: CompiledRegexTerm[] = [];

  private constructor(terms: readonly PlatformTerm[], rejected: LexiconLoadResult["rejected"]) {
    const literals: string[] = [];

    for (const entry of terms) {
      if (entry.is_regex) {
        // Honoured, not merely stored. The Python agent carried this field from the
        // platform, validated it at sync time, and then escaped every surface — so a
        // regex term was matched as a literal string and could never fire. The flag
        // existed, the behaviour did not.
        try {
          this.regexTerms.push({
            term: entry,
            // No clitic prefix and no boundary wrapping: the curator wrote a pattern
            // and adding to it would change what they wrote.
            pattern: new RegExp(entry.term, "gu"),
          });
        } catch (err) {
          // A bad pattern must not take the whole lexicon down — one curator typo
          // would stop all matching. Reported rather than swallowed.
          rejected.push({
            id: entry.id,
            term: entry.term,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      for (const surface of [entry.term, ...(entry.variants ?? [])]) {
        const key = this.normalizer.normalize(String(surface));
        if (!key) continue;
        this.bySurface.set(key, entry);
        literals.push(key);
      }
    }

    if (literals.length === 0) {
      this.literalPattern = null;
      return;
    }

    // Longest first, so "abc def" wins over "abc".
    const alternation = [...new Set(literals)]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|");

    // The term is captured, so the lookup sees the bare surface rather than the
    // clitic-prefixed string.
    this.literalPattern = new RegExp(
      `(?<!${BOUNDARY})${CLITICS}(${alternation})(?!${BOUNDARY})`,
      "gu",
    );
  }

  /** Build a matcher from what the platform returned. */
  static load(terms: readonly PlatformTerm[]): LexiconLoadResult {
    const rejected: LexiconLoadResult["rejected"] = [];
    return { matcher: new LexiconMatcher(terms, rejected), rejected };
  }

  /**
   * Hits in `text`, each carrying whether it applies here.
   *
   * `contextGroups` are the group slugs the surrounding post concerns. A hit out of
   * scope is still returned — a coded term appearing where its group is absent is
   * worth knowing — but `in_scope` is what a flag gates on.
   */
  scan(text: string, contextGroups: Iterable<string> = []): LexiconHit[] {
    if (!text) return [];

    const groups = new Set(contextGroups);
    const normalised = this.normalizer.normalize(text);
    const hits: LexiconHit[] = [];
    const seen = new Set<string>();

    const record = (term: PlatformTerm, matched: string) => {
      const key = `${term.id}:${matched}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({
        term,
        matched,
        in_scope:
          term.is_explicit || term.target_group_slug === null || groups.has(term.target_group_slug),
      });
    };

    if (this.literalPattern) {
      // A fresh regex per scan: `g` carries lastIndex, so a shared instance skips
      // matches on the second call and results depend on call order.
      const pattern = new RegExp(this.literalPattern.source, this.literalPattern.flags);
      for (const match of normalised.matchAll(pattern)) {
        const surface = match[1];
        if (!surface) continue;
        const term = this.bySurface.get(surface);
        if (term) record(term, surface);
      }
    }

    for (const { term, pattern } of this.regexTerms) {
      const fresh = new RegExp(pattern.source, pattern.flags);
      for (const match of normalised.matchAll(fresh)) {
        if (match[0]) record(term, match[0]);
      }
    }

    return hits;
  }
}
