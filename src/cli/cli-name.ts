// CLI-name helpers keep generated examples aligned with the binary the user invoked.
import path from "node:path";

// AnkEdo ships as `ankedo`. The entry file is still openclaw.mjs -- renaming it would
// churn the manifest, the `files` list and every upstream merge for no user-visible
// gain -- so argv[1] is usually "openclaw.mjs", which is not a known CLI name and
// therefore falls through to the default below.
const DEFAULT_CLI_NAME = "ankedo";

const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
// Matches the legacy name too, so the many hardcoded `openclaw ...` example strings
// scattered through the codebase get rewritten to the active name instead of telling
// the operator to run a command that no longer exists.
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(ankedo|openclaw)\b/;

/** Resolve the displayed CLI binary name from argv, falling back to `ankedo`. */
export function resolveCliName(argv: string[] = process.argv): string {
  const argv1 = argv[1];
  if (!argv1) {
    return DEFAULT_CLI_NAME;
  }
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) {
    return base;
  }
  return DEFAULT_CLI_NAME;
}

/** Replace a leading CLI command prefix with the active CLI name. */
export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}
