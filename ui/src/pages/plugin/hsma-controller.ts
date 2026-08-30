// Data for the HSMA dashboard tab.
//
// Fetches from the four hsma.* gateway methods the plugin registers. State is kept per
// host object rather than module-global, so two open tabs do not overwrite each other's
// results, and polling stops when the tab goes away.
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type HsmaCase = {
  id: string;
  targetGroup: string | null;
  narrative: string | null;
  state: string;
  lastActivityAt: string | null;
  hours: number[];
  learned: boolean;
  why: string;
  coverage?: unknown;
};

export type HsmaReviewItem = {
  id: string;
  verdict: string;
  confidence: number | null;
  text: string | null;
  url: string | null;
  lexiconAgeHours: number | null;
  trace?: unknown;
};

export type HsmaLexicon = {
  terms: number;
  tropes: number;
  state: string;
  ageHours: number | null;
  rejected: unknown[];
};

export type HsmaPlatform = {
  configured: boolean;
  reason?: string;
  url?: string;
  agentId?: string | null;
  reachable?: boolean;
  detail?: string;
  pending?: number;
};

export type HsmaState = {
  loading: boolean;
  /** Per-section errors: the platform being unreachable must not blank the cases. */
  errors: Record<string, string>;
  cases: HsmaCase[];
  crawls?: { total: number; baseline: number };
  review: HsmaReviewItem[];
  reviewCount: number;
  lexicon?: HsmaLexicon;
  platform?: HsmaPlatform;
  loadedAt?: number;
};

const EMPTY: HsmaState = { loading: false, errors: {}, cases: [], review: [], reviewCount: 0 };

const states = new WeakMap<object, HsmaState>();
const inflight = new WeakSet<object>();
const timers = new WeakMap<object, ReturnType<typeof setInterval>>();

export function getHsmaState(host: object): HsmaState {
  return states.get(host) ?? EMPTY;
}

async function callSection(
  client: GatewayBrowserClient,
  method: string,
  params: unknown,
  next: HsmaState,
  apply: (body: unknown, next: HsmaState) => void,
): Promise<void> {
  try {
    const body = await client.request(method, params);
    apply(body, next);
  } catch (err) {
    // Recorded against the section, not thrown. One dead endpoint should degrade one
    // card rather than empty the whole page.
    next.errors[method] = err instanceof Error ? err.message : String(err);
  }
}

export async function loadHsma(
  host: object,
  client: GatewayBrowserClient | null,
  onRequestUpdate: () => void,
): Promise<void> {
  if (!client || inflight.has(host)) {
    return;
  }
  inflight.add(host);
  const previous = getHsmaState(host);
  states.set(host, { ...previous, loading: true, errors: {} });
  onRequestUpdate();

  const next: HsmaState = {
    loading: false,
    errors: {},
    cases: [],
    review: [],
    reviewCount: 0,
  };

  await Promise.all([
    callSection(client, "hsma.cases", {}, next, (body, s) => {
      const b = body as { cases?: HsmaCase[]; crawls?: { total: number; baseline: number } };
      s.cases = b.cases ?? [];
      s.crawls = b.crawls;
    }),
    callSection(client, "hsma.reviewQueue", { limit: 50 }, next, (body, s) => {
      const b = body as { items?: HsmaReviewItem[]; count?: number };
      s.review = b.items ?? [];
      s.reviewCount = b.count ?? 0;
    }),
    callSection(client, "hsma.lexicon", {}, next, (body, s) => {
      s.lexicon = body as HsmaLexicon;
    }),
    callSection(client, "hsma.platform", {}, next, (body, s) => {
      s.platform = body as HsmaPlatform;
    }),
  ]);

  next.loadedAt = Date.now();
  states.set(host, next);
  inflight.delete(host);
  onRequestUpdate();
}

export function configureHsmaPolling(
  host: object,
  client: GatewayBrowserClient | null,
  onRequestUpdate: () => void,
  intervalMs = 30_000,
): void {
  stopHsmaPolling(host);
  if (!client) {
    return;
  }
  void loadHsma(host, client, onRequestUpdate);
  timers.set(
    host,
    setInterval(() => {
      void loadHsma(host, client, onRequestUpdate);
    }, intervalMs),
  );
}

export function stopHsmaPolling(host: object): void {
  const timer = timers.get(host);
  if (timer) {
    clearInterval(timer);
    timers.delete(host);
  }
}
