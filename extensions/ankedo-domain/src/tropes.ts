/**
 * Tropes — patterns whose meaning depends on what they are said about.
 *
 * This is the rule that separates a monitoring tool from a keyword filter, and it is
 * the one most easily got wrong in the permissive direction.
 *
 * A trope's surface form is usually benign on its own. `اعوذ بالله من الشيطان الرجيم`
 * is an ordinary pious phrase said many thousands of times a day. Under a post about a
 * Yazidi ceremony at Lalish it invokes the devil-worship libel. Same words, opposite
 * act.
 *
 * So a surface match alone is a **candidate**: it raises review priority and nothing
 * more. It becomes **fired** only when the activation condition is satisfied. Firing on
 * surface form alone would flag every devout comment on the platform — which for a
 * minority-protection tool is worse than missing hate, because the people it silences
 * are the community being protected.
 *
 * The tropes themselves come from the platform. Nothing here is hardcoded.
 */
import { Normalizer } from "./normalize.js";

/** Source: `apps/hate_speech/urls_hermes.py::_trope_payload`. */
export interface PlatformTrope {
  id: number;
  name: string;
  description: string;
  example: string | null;
  target_group: string | null;
  target_group_slug: string | null;
  /** A trope can name several communities — the devil-worship libel targets both. */
  target_groups: string[];
  /**
   * Topics in the parent post that activate this trope.
   *
   * Empty means "no deterministic gate yet", never "always active". Reading it the
   * permissive way fires the devil-worship trope on every pious comment on the
   * platform.
   */
  activation_topics: string[];
  surface_forms: string[];
  requires_target_group: boolean;
  negation_cancels: boolean;
  negative_examples: string[];
  counter_speech_examples: string[];
  severity_weight: number;
  is_visual: boolean;
}

export interface TropeHit {
  trope_id: number;
  name: string;
  /** The surface form that matched, as the curator wrote it. */
  surface_form: string;
  /** Which of the trope's groups the context actually satisfied, if any. */
  matched_group: string | null;
  covers_groups: string[];
  severity: number;
  implicature: string;
  /** Why it fired, or why it did not. Shown to a reviewer. */
  reason: string;
}

export interface TropeResult {
  /** May contribute to an automatic flag. */
  fired: TropeHit[];
  /** Raise review priority only. A surface match with no activation. */
  candidates: TropeHit[];
}

export interface TropeContext {
  text: string;
  parentPostText?: string;
  /** Group slugs the surrounding content concerns. */
  targetGroups?: string[];
}

/**
 * Refutation cues, in Arabic, Kurdish and English.
 *
 * Keyword proximity, not a parser. It catches the common "X are not Y" and "this is a
 * lie" shapes, which is most counter-speech. A dependency parse would be better and is
 * not worth it until the error ledger shows counter-speech getting through.
 */
const NEGATION_CUES = [
  "ليس",
  "ليسوا",
  "ليست",
  "لا ",
  "ما ",
  "مو ",
  "مب ",
  "غير صحيح",
  "افتراء",
  "كذب",
  "اتهام باطل",
  "نییە",
  "نین",
  "درۆ",
  "not",
  "isn't",
  "aren't",
  "false",
  "lie",
];

/** Characters either side of a match to look in for a refutation. */
const NEGATION_WINDOW = 60;

export class TropeEngine {
  private readonly normalizer = new Normalizer();

  private readonly tropes: readonly PlatformTrope[];

  constructor(tropes: readonly PlatformTrope[]) {
    this.tropes = tropes;
  }

  evaluate(context: TropeContext): TropeResult {
    const text = context.text ?? "";
    if (!text) return { fired: [], candidates: [] };

    const haystack = this.normalizer.normalize(text);
    const postText = this.normalizer.normalize(context.parentPostText ?? "");
    const groups = new Set(context.targetGroups ?? []);

    const fired: TropeHit[] = [];
    const candidates: TropeHit[] = [];

    for (const trope of this.tropes) {
      const match = this.firstMatch(trope, haystack);
      if (!match) continue;

      const covers = trope.target_groups?.length
        ? trope.target_groups
        : trope.target_group_slug
          ? [trope.target_group_slug]
          : [];

      const matchedGroup = covers.find((slug) => groups.has(slug)) ?? null;

      // An activation topic present in the *parent post*, not the comment. The comment
      // is what is being judged; the post is what gives it its meaning.
      const topicMatch = (trope.activation_topics ?? []).some((topic) => {
        const needle = this.normalizer.normalize(topic);
        return needle.length > 0 && postText.includes(needle);
      });

      const hit: TropeHit = {
        trope_id: trope.id,
        name: trope.name,
        surface_form: match.surface,
        matched_group: matchedGroup,
        covers_groups: covers,
        severity: trope.severity_weight,
        implicature: trope.description,
        reason: "",
      };

      // Absent means strict. The permissive default is the one that over-flags, and
      // the platform ships tropes whose activation data a curator has not filled in.
      const requiresGroup = trope.requires_target_group ?? true;
      if (requiresGroup && !matchedGroup && !topicMatch) {
        candidates.push({
          ...hit,
          reason: "surface form matched but nothing in the context names a target group",
        });
        continue;
      }

      if ((trope.negation_cancels ?? true) && this.negated(haystack, match.position)) {
        // The person quoting a libel is usually the person rejecting it. Flagging them
        // puts a defender in the evidence file next to the attacker.
        candidates.push({
          ...hit,
          reason: "surface form appears alongside a refutation — likely counter-speech",
        });
        continue;
      }

      fired.push({
        ...hit,
        reason: matchedGroup
          ? `activation satisfied: the content concerns ${matchedGroup}`
          : topicMatch
            ? "activation satisfied by the parent post's topic"
            : "activation satisfied",
      });
    }

    return { fired, candidates };
  }

  private firstMatch(
    trope: PlatformTrope,
    haystack: string,
  ): { surface: string; position: number } | null {
    for (const form of trope.surface_forms ?? []) {
      const needle = this.normalizer.normalize(String(form));
      if (!needle) continue;
      const position = haystack.indexOf(needle);
      if (position !== -1) return { surface: String(form), position };
    }
    return null;
  }

  private negated(haystack: string, position: number): boolean {
    const start = Math.max(0, position - NEGATION_WINDOW);
    const window = haystack.slice(start, position + NEGATION_WINDOW);
    return NEGATION_CUES.some((cue) => window.includes(cue));
  }
}
