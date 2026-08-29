/**
 * The Ettok platform client.
 *
 * The platform owns the lexicon and the trope dictionary — a curator edits them in the
 * dashboard and every agent picks the change up on its next sync. Nothing in this
 * agent hardcodes a term.
 *
 * Written against the contract as the platform's code implements it, not as its
 * documentation describes it. Where those differ, the differences are noted at the
 * method concerned, because several of them fail quietly.
 */

// The wire shapes live with the code that matches against them, so there is one
// declaration per field rather than two that drift.
import type { PlatformTerm } from "../lexicon.js";
import type { PlatformTrope } from "../tropes.js";

export type { PlatformTerm, PlatformTrope };

export interface LexiconResponse {
  terms: PlatformTerm[];
  tropes: PlatformTrope[];
  total: number;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    /** 0 when no response arrived at all. */
    readonly status: number,
    /** True when retrying may work — the platform was unavailable, not wrong. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

/** The key was rejected. Retrying cannot fix it; a human must. */
export class AgentKeyRejected extends PlatformError {
  constructor(message: string, status: number) {
    super(message, status, false);
    this.name = "AgentKeyRejected";
  }
}

export interface PlatformClientOptions {
  /** e.g. https://ettok.net/api/hermes/ */
  baseUrl: string;
  /** The plaintext agent key. Only its SHA-256 is stored server-side. */
  agentKey: string;
  /**
   * Sent as `X-Agent-Id`. Not optional in practice: the platform scopes idempotency
   * on `(agent_id, key)`, so an agent that omits it shares the `''` namespace with
   * every other agent that does — two machines can then collide on a UUID and one
   * silently replays the other's response.
   */
  agentId: string;
  timeoutMs?: number;
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly agentKey: string;
  private readonly agentId: string;
  private readonly timeoutMs: number;

  constructor(options: PlatformClientOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, "") + "/";

    // Plaintext carries verdicts naming people who are already targets of violence.
    // Loopback is exempt so a developer can run the platform locally.
    if (!base.startsWith("https://") && !PlatformClient.isLoopback(base)) {
      throw new PlatformError(
        `refusing to connect over plaintext: ${base}. Use https, or run the platform on localhost.`,
        0,
        false,
      );
    }

    this.baseUrl = base;
    this.agentKey = options.agentKey;
    this.agentId = options.agentId;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private static isLoopback(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
      return false;
    }
  }

  /**
   * The curated lexicon and trope dictionary.
   *
   * `languages` filters server-side. The platform accepts repeated `?language=`; the
   * values are `ar` and `ku` for this deployment — the language a term is *written*
   * in, not a platform locale.
   */
  async getLexicon(languages: readonly string[] = []): Promise<LexiconResponse> {
    const query = languages.map((l) => `language=${encodeURIComponent(l)}`).join("&");
    return this.request<LexiconResponse>("GET", `lexicon/${query ? `?${query}` : ""}`);
  }

  /** Tropes alone, optionally filtered by target group slug. */
  async getTropes(
    targetGroups: readonly string[] = [],
  ): Promise<{ tropes: PlatformTrope[]; total: number }> {
    const query = targetGroups.map((g) => `target_group=${encodeURIComponent(g)}`).join("&");
    return this.request("GET", `tropes/${query ? `?${query}` : ""}`);
  }

  /**
   * Propose terms seen but absent from the dictionary.
   *
   * The only platform endpoint that validates its payload: it returns
   * `{accepted, gap_ids, duplicates, rejected}` with a per-item reason, and `201` when
   * anything was accepted. Treat `rejected` as a failure to act on, not noise.
   */
  async postLexiconGaps(
    gaps: readonly Record<string, unknown>[],
    idempotencyKey: string,
  ): Promise<{
    accepted: number;
    gap_ids: number[];
    duplicates: string[];
    rejected: Array<{ term: string; reason: string }>;
  }> {
    return this.request("POST", "lexicon-gaps/", { gaps }, idempotencyKey);
  }

  /** Run statistics. Carries the denominator, which exists nowhere else. */
  async postScanLog(
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ id: number }> {
    return this.request("POST", "scan-log/", payload, idempotencyKey);
  }

  /** Liveness. Not idempotent server-side, and does not need to be. */
  async heartbeat(status = "online"): Promise<Record<string, unknown>> {
    return this.request("POST", "heartbeat/", { agent_id: this.agentId, status });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.agentKey}`,
          "X-Agent-Id": this.agentId,
          ...(body ? { "Content-Type": "application/json" } : {}),
          // Stable across retries. The retry loop cannot tell "the platform never saw
          // it" from "it processed it and the response was lost", and on a residential
          // connection the second genuinely happens.
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      throw new PlatformError(
        aborted
          ? `no answer within ${this.timeoutMs}ms`
          : `cannot reach the platform at ${this.baseUrl}: ${(err as Error).message}`,
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return (await response.json()) as T;

    const detail = await response.text().then(
      (text) => {
        try {
          return (JSON.parse(text) as { error?: string; detail?: string }).error ?? text;
        } catch {
          return text;
        }
      },
      () => "",
    );

    // 401 missing/unknown/revoked key, 403 valid key without the hate_speech_scan
    // scope. Neither is fixed by trying again, and burning a retry budget against
    // them wastes attempts a later outage will need.
    if (response.status === 401 || response.status === 403) {
      throw new AgentKeyRejected(
        detail || `agent key rejected (${response.status})`,
        response.status,
      );
    }

    // 409 means a request with this idempotency key is still in flight. The platform
    // chose that over a permanent 4xx deliberately: the first attempt may yet succeed,
    // so this is a "come back", not a "give up".
    const retryable = response.status === 409 || response.status === 429 || response.status >= 500;
    throw new PlatformError(
      detail || `request failed (${response.status})`,
      response.status,
      retryable,
    );
  }
}
