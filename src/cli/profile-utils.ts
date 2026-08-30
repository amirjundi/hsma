// Profile name validation and normalization helpers for root CLI profile routing.
import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidProfileName(value: string): boolean {
  if (!value) {
    return false;
  }
  // Keep it path-safe + shell-friendly.
  return PROFILE_NAME_RE.test(value);
}

export function normalizeProfileName(raw?: string | null): string | null {
  const profile = raw?.trim();
  if (!profile) {
    return null;
  }
  if (normalizeLowercaseStringOrEmpty(profile) === "default") {
    return null;
  }
  if (!isValidProfileName(profile)) {
    return null;
  }
  return profile;
}

/** Resolve the canonical home-scoped state root for a validated CLI profile. */
export function resolveProfileStateDir(
  profile: string,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  const trimmed = profile.trim();
  if (!isValidProfileName(trimmed)) {
    throw new Error(`Invalid profile name: ${JSON.stringify(profile)}`);
  }
  const suffix = normalizeLowercaseStringOrEmpty(trimmed) === "default" ? "" : `-${trimmed}`;
  // Must agree with resolveConfigDir in src/utils.ts, which resolves ~/.hsma and falls
  // back to an existing ~/.openclaw. Without the same rule here the default profile
  // could read config from one directory and profile state from another.
  const home = resolveRequiredHomeDir(env, homedir);
  const current = path.join(home, `.hsma${suffix}`);
  try {
    if (fs.existsSync(current)) {
      return current;
    }
    const inherited = path.join(home, `.openclaw${suffix}`);
    if (fs.existsSync(inherited)) {
      return inherited;
    }
  } catch {
    // best-effort
  }
  return current;
}
