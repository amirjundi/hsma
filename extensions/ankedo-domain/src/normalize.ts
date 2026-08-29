/**
 * Text normalisation for Arabic and Kurdish.
 *
 * This must stay equivalent to the platform's `apps/hate_speech/normalize.py`. The
 * lexicon lives on the platform, so prefiltering here only works if both sides reduce
 * text to the same canonical form. A divergence does not raise — matching silently
 * degrades, and the failure looks like an absence of hate speech rather than a bug.
 *
 * The Python side previously folded yeh onto alef maksura while the platform folded
 * onto yeh; that was found on 2026-08-25 and would have broken matching for every term
 * containing either letter. The fixtures in `test/` exist so that class of drift is
 * caught by a failing test rather than by a quiet drop in recall.
 *
 * **Kurdish orthography is deliberately preserved — but only partly, and the exception
 * matters.** Standard Arabic search normalisation collapses hamza carriers into alef,
 * which would destroy Kurdish: `ئ ؤ ە ێ ۆ ڕ ڵ` all survive here. But the plain Farsi
 * yeh `ی` does fold to Arabic yeh `ي`, because that is the character Kurdish keyboards
 * produce and it appears in Arabic-script text too.
 *
 * The consequence is that `ئێزیدی` does NOT round-trip. It normalises to `ئێزيدي` —
 * the `ئ` and `ێ` survive, the trailing `ی` folds. That looks like a bug, and the
 * obvious repair is to stop folding `ی`, which would break parity with every term
 * already stored on the platform. It is correct as written. See the `partial_folds`
 * fixture group, which exists specifically to stop someone "fixing" this.
 */

// Harakat, superscript alef and tatweel are decoration, never lexical.
const STRIP = /[ً-ْٰـ]/gu;

const FOLD: ReadonlyMap<string, string> = new Map([
  // Alef variants. "عبدة الشيطان" and "الشيطآن" are the same word with a different
  // alef, and the Duhok transcript contains both.
  ["أ", "ا"], // أ
  ["إ", "ا"], // إ
  ["آ", "ا"], // آ
  ["ٱ", "ا"], // ٱ

  // Alef maksura, and the Farsi/Kurdish yeh. Both fold onto Arabic yeh — note the
  // direction: onto ي, not onto ى.
  ["ى", "ي"], // ى
  ["ی", "ي"], // ی

  // Ta marbuta is written as ha throughout Iraqi dialect.
  ["ة", "ه"], // ة

  // Farsi/Kurdish kaf.
  ["ک", "ك"], // ک

  // Arabic-Indic digits. The transcript writes the genocide year as ٢٠١٤.
  ["٠", "0"],
  ["١", "1"],
  ["٢", "2"],
  ["٣", "3"],
  ["٤", "4"],
  ["٥", "5"],
  ["٦", "6"],
  ["٧", "7"],
  ["٨", "8"],
  ["٩", "9"],
]);

/** Strip decoration. Runs before folding — the order is load-bearing. */
export function stripDiacritics(text: string): string {
  return text.replace(STRIP, "");
}

/** Fold orthographic variants onto one form. */
export function foldOrthography(text: string): string {
  let out = "";
  // Iterating the string yields code points, so this is safe for anything outside the
  // BMP even though every mapping here is a single code unit.
  for (const ch of text) out += FOLD.get(ch) ?? ch;
  return out;
}

/**
 * The canonical form used for lexicon matching.
 *
 * Strip, then fold, then lowercase, then collapse whitespace. Folding before
 * stripping would leave a vocalised term unmatched: the harakat sit between the
 * letters being folded, so `عَبَدَةُ الشَّيْطَانِ` would not reduce to
 * `عبده الشيطان`. The `terms` fixtures catch that specific ordering error.
 */
export function normalize(text: string): string {
  if (!text) return "";
  return foldOrthography(stripDiacritics(text))
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
}

/** Object wrapper, mirroring the Python class the callers were written against. */
export class Normalizer {
  normalize(text: string): string {
    return normalize(text);
  }

  stripDiacritics(text: string): string {
    return stripDiacritics(text);
  }

  foldOrthography(text: string): string {
    return foldOrthography(text);
  }
}
