import type { LexiconHit } from "./lexicon.js";
/**
 * `never_flag_when` and `self_reference_terms`, enforced.
 *
 * Both are curator-set fields on the platform. In the Python agent both were carried
 * faithfully into the database and read by nothing — `never_flag_when` reached the
 * model as a line of prompt text it could ignore, and `self_reference_terms` was empty
 * for every group and consulted by no classifier. A curator filling either was doing
 * work that changed no outcome.
 *
 * They matter because the same words are a different act in a different mouth.
 * `نسطوري` in an academic paper. `عبدة الشيطان` quoted by someone rejecting it. A slur
 * used inside the community it is about. **The person most likely to reproduce a libel
 * verbatim is the person arguing against it**, and this system's output becomes a
 * human-rights record — so flagging them is not a small error, it is the specific harm
 * this project can cause.
 *
 * ## An exemption withdraws the flag; it does not clear the item
 *
 * The verdict becomes ambiguous and goes to a human. Two reasons. The model's own
 * category is one of the signals, and the text being judged is written by strangers —
 * silently clearing on that basis would put the exemption one prompt injection away
 * from being a bypass. And an exemption is precisely the interesting case: where the
 * dictionary and the context disagree, which is what a reviewer is for.
 */
import { Normalizer } from "./normalize.js";

export const COUNTER_SPEECH = "counter_speech";
export const NEWS_QUOTATION = "news_quotation";
export const ACADEMIC = "academic";
export const RECLAIMED = "reclaimed";

/**
 * Signals arising from the specialist contradicting itself: a verdict of hate
 * alongside a category the platform defines as not hate speech.
 *
 * That contradiction alone withholds an automatic flag even with no dictionary term
 * involved — and the case it covers is the common one. Counter-speech usually quotes a
 * libel no lexicon holds, so the trope fires and no term does. Requiring a lexicon hit
 * would leave the very scenario the rule exists for uncovered.
 *
 * `reclaimed` is deliberately absent. It is inferred from the text rather than declared
 * by the model, and on its own says only that a group's own name appears — far too
 * little to withdraw a flag from a trope-driven verdict.
 */
const CONTRADICTION_SIGNALS = new Set([COUNTER_SPEECH, NEWS_QUOTATION, ACADEMIC]);

/** Categories the specialist can return that mean "not hate speech" in themselves. */
const CATEGORY_SIGNALS: ReadonlyMap<string, string> = new Map([
  ["counter_speech", COUNTER_SPEECH],
  ["news_reporting", NEWS_QUOTATION],
  ["academic", ACADEMIC],
]);

export interface Exemption {
  signal: string;
  /** The terms excused, empty when no dictionary term was involved. */
  terms: string[];
  detail: string;
}

export interface TargetGroupRef {
  slug: string;
  /**
   * How the community names itself. Gates the `reclaimed` signal.
   *
   * An empty list fails closed — that is not neutral. In the Python agent it was empty
   * for all eight groups, so the reclaimed gate could never fire at all, silently.
   */
  self_reference_terms: string[];
}

export interface SignalContext {
  text: string;
  targetGroups: readonly string[];
  /** The specialist's own category, if it returned one. */
  category?: string | null;
}

export class ExemptionChecker {
  private readonly normalizer = new Normalizer();
  private readonly groups: ReadonlyMap<string, TargetGroupRef>;

  constructor(groups: readonly TargetGroupRef[]) {
    this.groups = new Map(groups.map((g) => [g.slug, g]));
  }

  /** Which never-flag contexts appear to apply here. */
  detectSignals(context: SignalContext): Set<string> {
    const signals = new Set<string>();

    const category = (context.category ?? "").trim().toLowerCase();
    const mapped = CATEGORY_SIGNALS.get(category);
    if (mapped) signals.add(mapped);

    const selfTerms = context.targetGroups.flatMap(
      (slug) => this.groups.get(slug)?.self_reference_terms ?? [],
    );
    if (selfTerms.length > 0 && this.containsAny(context.text, selfTerms)) {
      signals.add(RECLAIMED);
    }

    return signals;
  }

  private containsAny(text: string, terms: readonly string[]): boolean {
    if (!text || terms.length === 0) return false;
    const haystack = this.normalizer.normalize(text);
    return terms.some((term) => {
      const needle = this.normalizer.normalize(term);
      return needle.length > 0 && haystack.includes(needle);
    });
  }

  /**
   * Whether the evidence excuses itself in this context.
   *
   * Every in-scope hit must list the signal. One term that does not — an incitement
   * term no context excuses — keeps the flag, because the exemption is about the
   * *evidence*, not the mood of the sentence. A comment quoting a libel and also
   * saying `اقتلوهم` is not counter-speech.
   */
  static check(hits: readonly LexiconHit[], signals: ReadonlySet<string>): Exemption | null {
    if (signals.size === 0) return null;

    const inScope = hits.filter((h) => h.in_scope);

    if (inScope.length === 0) {
      // No dictionary term carried this verdict, so there is no never_flag_when rule
      // to consult. A self-contradiction still counts.
      const contradiction = [...signals].filter((s) => CONTRADICTION_SIGNALS.has(s)).sort();
      const first = contradiction[0];
      if (!first) return null;
      return {
        signal: first,
        terms: [],
        detail:
          `the verdict is hate but the category is '${first}', which is not hate ` +
          `speech — no dictionary term was involved`,
      };
    }

    for (const signal of [...signals].sort()) {
      const covered = inScope.filter((h) => h.term.never_flag_when.includes(signal));
      if (covered.length === inScope.length) {
        return {
          signal,
          terms: covered.map((h) => h.matched),
          detail:
            `every matched term lists '${signal}' in never_flag_when, and the ` +
            `context looks like ${signal}`,
        };
      }
    }

    return null;
  }
}
