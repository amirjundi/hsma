// Lobster palette tokens for CLI/UI theming. Use this palette for all CLI color output.
// Keep in sync with docs/cli/index.md (CLI palette section).
// Phosphor green, matching the `phosphor` Control UI theme. HSMA is an operations
// console read in long sessions by people documenting attacks on their communities;
// the upstream lobster orange is a consumer-product accent and reads wrong here.
//
// warn stays amber and error stays red on purpose: a monochrome scheme that renders
// a warning in the same green as ordinary output hides the thing you needed to see.
export const LOBSTER_PALETTE = {
  accent: "#2FE07A",
  accentBright: "#7CFFAF",
  accentDim: "#1E9E56",
  info: "#5AD6A0",
  success: "#2FBF71",
  warn: "#FFB020",
  error: "#E23D2D",
  muted: "#6F8279",
} as const;
