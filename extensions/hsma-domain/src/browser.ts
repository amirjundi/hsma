/**
 * Collection through Camoufox.
 *
 * OpenClaw ships a browser plugin driving Chromium over the Chrome DevTools Protocol.
 * For an assistant browsing on your behalf that is correct engineering. For crawling
 * platforms that actively ban crawlers it is the wrong tool: CDP is precisely what
 * those platforms fingerprint, and a fingerprinted worker account is a banned one.
 *
 * So the bundled plugin is disabled in config and this registers its own tool:
 *
 *     { plugins: { entries: { browser: { enabled: false } } } }
 *
 * Camoufox is a hardened Firefox fork with a Playwright-compatible Node API. It
 * humanises cursor movement, spoofs fingerprints at the engine level, and — the part
 * that matters — injects no automation traces into the page, so `navigator.webdriver`
 * and the usual Playwright tells are simply absent.
 *
 * The tool name is `camoufox`, not `browser`. Taking the `browser` name would collide
 * with the bundled plugin whenever someone re-enables it, and the failure would be a
 * silent substitution rather than an error.
 */

export interface CollectedPost {
  platformPostId: string;
  url: string;
  text: string | null;
  authorName: string | null;
  /** ISO-8601. When the author posted it — the learned schedule depends on this. */
  postedAt: string | null;
  comments: CollectedComment[];
}

export interface CollectedComment {
  platformCommentId: string;
  text: string | null;
  authorName: string | null;
  postedAt: string | null;
}

export interface BrowserSession {
  goto(url: string): Promise<void>;
  /** Read the page. Returns whatever the extractor found. */
  extract<T>(extractor: () => T): Promise<T>;
  close(): Promise<void>;
}

export class BrowserUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailable";
  }
}

export interface LaunchOptions {
  /** Headed matters operationally: a human taking over a CAPTCHA needs a window. */
  headless?: boolean;
  /** Persisted per worker identity, so a session is not rebuilt on every crawl. */
  userDataDir?: string;
  proxy?: string;
  /**
   * Milliseconds between actions. Crawling faster than a platform tolerates loses
   * accounts, and a lost account costs far more than a slow crawl.
   */
  pacingMs?: number;
}

/**
 * Start Camoufox.
 *
 * Imported lazily so the rest of the agent — classification, cases, the platform
 * client — works on a machine where no browser is installed. That is not a corner
 * case: the browser is the hardest thing to get running, and an agent that cannot
 * start because it cannot launch Firefox is far less useful than one that classifies
 * and says the browser is broken.
 */
export async function launch(options: LaunchOptions = {}): Promise<BrowserSession> {
  let camoufox: { launch: (opts: unknown) => Promise<unknown> };
  try {
    // The specifier is a variable so TypeScript does not try to resolve it at compile
    // time. Camoufox is genuinely optional: classification, cases and the platform
    // client all work without it, and the agent must build and run on a machine where
    // no browser has ever been installed. A static import would make the whole plugin
    // fail to compile there.
    const specifier = "camoufox";
    camoufox = (await import(specifier)) as never;
  } catch (err) {
    throw new BrowserUnavailable(
      "Camoufox is not installed. Collection cannot run until it is: " +
        `npm install camoufox && npx camoufox fetch — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let browser: {
    newPage: () => Promise<Record<string, (...args: never[]) => Promise<unknown>>>;
    close: () => Promise<void>;
  };
  try {
    browser = (await camoufox.launch({
      headless: options.headless ?? true,
      ...(options.userDataDir ? { user_data_dir: options.userDataDir } : {}),
      ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
    })) as never;
  } catch (err) {
    // The commonest cause by far is the browser build not being downloaded. Say the
    // command rather than the stack trace: an operator reading this wants the fix.
    throw new BrowserUnavailable(
      `Camoufox will not start: ${err instanceof Error ? err.message : String(err)}. ` +
        "Try `npx camoufox fetch`, then `hsma doctor` for the underlying cause.",
    );
  }

  const page = await browser.newPage();
  const pacing = options.pacingMs ?? 1500;
  const breathe = () => new Promise((r) => setTimeout(r, pacing));

  return {
    async goto(url: string) {
      await breathe();
      await page.goto?.(url as never);
    },
    async extract<T>(extractor: () => T): Promise<T> {
      await breathe();
      return (await page.evaluate?.(extractor as never)) as T;
    },
    async close() {
      await browser.close();
    },
  };
}

/**
 * Whether the browser can actually start.
 *
 * Deliberately separate from a health check that only reports a stored status.
 * Launching a browser is the only thing that answers whether collection can run, and
 * the Python agent's doctor reported a browser as present while collection had
 * nothing to start.
 */
export async function probe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const session = await launch({ headless: true });
    try {
      return { ok: true, detail: "Camoufox started and closed cleanly. Collection can run." };
    } finally {
      await session.close().catch(() => {});
    }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof BrowserUnavailable ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Operator sessions
 *
 * The agent does not create accounts. It reuses a session a person established,
 * which is both the honest arrangement and the durable one: accounts produced by
 * automated signup get detected and mass-banned, and when they go they take the
 * collection history with them. A human logging in once, on a profile the agent
 * then keeps warm, survives.
 *
 * This is also what makes the agent flexible rather than blocked. Given a session it
 * can read anything that account can read; without one it says so and asks, instead
 * of failing silently or pretending a page was empty.
 * ------------------------------------------------------------------------- */

import fs from "node:fs";
import path from "node:path";

/** Where a platform's persistent browser profile lives. */
export function sessionDir(platform: string, root: string): string {
  const safe = platform.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  return path.join(root, "sessions", safe);
}

export interface SessionInfo {
  platform: string;
  dir: string;
  present: boolean;
  /** When the profile was last written, which is the best proxy for last use. */
  lastUsedAt: string | null;
}

/** Which platforms already have a usable session. */
export function listSessions(root: string, platforms: readonly string[]): SessionInfo[] {
  return platforms.map((platform) => {
    const dir = sessionDir(platform, root);
    let present = false;
    let lastUsedAt: string | null = null;
    try {
      const stat = fs.statSync(dir);
      // An empty directory is not a session: Camoufox creates the profile path before
      // anything is stored in it, so existence alone would report a login that never
      // happened.
      present = stat.isDirectory() && fs.readdirSync(dir).length > 0;
      lastUsedAt = present ? stat.mtime.toISOString() : null;
    } catch {
      present = false;
    }
    return { platform, dir, present, lastUsedAt };
  });
}

/**
 * Open a headed window on a persistent profile so a person can sign in.
 *
 * Headed and long-lived on purpose. Logins involve CAPTCHAs, one-time codes and
 * consent screens that only a human can clear, and the whole point is that a human
 * clears them. The agent waits, then confirms whether anything was actually stored.
 */
export async function openForLogin(params: {
  platform: string;
  url: string;
  root: string;
  /** How long the operator has before the window is closed. */
  timeoutMs?: number;
  proxy?: string;
}): Promise<{ ok: boolean; detail: string; dir: string }> {
  const dir = sessionDir(params.platform, params.root);
  fs.mkdirSync(dir, { recursive: true });

  let session: BrowserSession;
  try {
    session = await launch({
      headless: false,
      userDataDir: dir,
      ...(params.proxy ? { proxy: params.proxy } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      dir,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await session.goto(params.url);
    const deadline = Date.now() + (params.timeoutMs ?? 10 * 60_000);
    // Poll rather than wait on a navigation event: the operator may take several
    // steps, and any one of them could be the one that sets the cookie.
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
        break;
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  const stored = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  return {
    ok: stored,
    dir,
    detail: stored
      ? `Session stored for ${params.platform}. Collection can now use it.`
      : `Nothing was stored for ${params.platform}. The sign-in did not complete, so there is no session to reuse.`,
  };
}

/**
 * Read a page using a stored session.
 *
 * Refuses rather than falling back to an anonymous view. A logged-out read of a
 * restricted page returns a login wall, and treating that as "no hate speech here"
 * would put a false negative into the record.
 */
export async function withSession<T>(
  params: { platform: string; root: string; headless?: boolean; proxy?: string },
  run: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const dir = sessionDir(params.platform, params.root);
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    throw new BrowserUnavailable(
      `No stored session for ${params.platform}. A person has to sign in once first — ` +
        `run the browser_login tool — and the agent will reuse it from then on. ` +
        `It does not create accounts.`,
    );
  }
  const session = await launch({
    headless: params.headless ?? true,
    userDataDir: dir,
    ...(params.proxy ? { proxy: params.proxy } : {}),
  });
  try {
    return await run(session);
  } finally {
    await session.close().catch(() => {});
  }
}
